// ZCode 钩子：把 SessionStart、UserPromptSubmit、Stop 转发给 Kioku 的生命周期端点，
// 服务端返回的上下文以 hookSpecificOutput.additionalContext 交还 ZCode。
// 插件里不放提示词和格式逻辑，都由服务端决定。
// 任何失败都以退出码 0 结束、不写标准输出：记忆服务出问题不能挡住用户的输入。
// 服务地址与访问密钥来自 kioku login zcode / kioku setup zcode 写下的本机配置文件（~/.config/kioku/zcode.json）。
// 失败原因写到标准错误且不带访问密钥：不跟着跳转走，fetch 报错只取类别。

import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { failureText, KiokuFailure } from '../lib/http.mjs'
import {
  clip,
  contextOf,
  deviceKeyOf,
  MAX_PROMPT,
  MAX_REPLY,
  MAX_SESSION_ID,
  Misconfigured,
  postEvent,
  projectOf,
  TIMEOUTS,
} from '../lib/lifecycle.mjs'
import { profileDir, readProfile } from '../lib/profile.mjs'

const HOOK_EVENTS = { 'session.start': 'SessionStart', 'prompt.submit': 'UserPromptSubmit' }
const NATIVE_TO_EVENT = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt.submit',
  Stop: 'turn.end',
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PENDING_PREFIX = 'turn.'
const PENDING_MAX_AGE = 24 * 60 * 60 * 1000
const TRANSCRIPT_TAIL = 2 * 1024 * 1024
const SETUP_HINT =
  '运行 kioku login zcode 配置（没有 kioku 命令时用 npx @kioku-memory/cli login zcode）'

function pickString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// 只把上下文文本交给 ZCode，钩子输出的其他控制字段一律不透传
function writeContext(event, text) {
  if (typeof text !== 'string' || !text) return
  const hookEventName = HOOK_EVENTS[event]
  if (!hookEventName) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: text },
    }),
  )
}

function pendingDir(env) {
  return join(
    env.ZCODE_PLUGIN_DATA || env.PLUGIN_DATA || join(profileDir(env), 'zcode-state'),
    'turns',
  )
}

function pendingTurnFile(env, sessionId, turnId) {
  if (!ID.test(sessionId ?? '') || !ID.test(turnId ?? '')) return null
  return join(pendingDir(env), `${PENDING_PREFIX}${sessionId}.id.${turnId}.json`)
}

function pendingLatestFile(env, sessionId) {
  if (!ID.test(sessionId ?? '')) return null
  return join(pendingDir(env), `${PENDING_PREFIX}${sessionId}.latest.json`)
}

async function atomicWriteJson(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600)
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

async function savePending(env, sessionId, turnId, prompt, project) {
  const exact = pendingTurnFile(env, sessionId, turnId)
  const latest = pendingLatestFile(env, sessionId)
  if (!exact && !latest) return
  await mkdir(pendingDir(env), { recursive: true, mode: 0o700 })
  const data = {
    prompt,
    ...(turnId ? { turnId } : {}),
    ...(Object.keys(project ?? {}).length ? { project } : {}),
  }
  if (exact) await atomicWriteJson(exact, data)
  if (latest) await atomicWriteJson(latest, data)
}

async function readPendingFile(file) {
  if (!file) return null
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed?.prompt !== 'string' || !parsed.prompt) return null
    return {
      user: parsed.prompt,
      turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
      project:
        parsed.project && typeof parsed.project === 'object' && !Array.isArray(parsed.project)
          ? parsed.project
          : undefined,
    }
  } catch {
    return null
  }
}

async function takePending(env, sessionId, turnId) {
  const exact = pendingTurnFile(env, sessionId, turnId)
  const latest = pendingLatestFile(env, sessionId)
  if (exact) {
    const hit = await readPendingFile(exact)
    await rm(exact, { force: true }).catch(() => {})
    if (hit) {
      const latestData = await readPendingFile(latest)
      if (latest && latestData?.turnId === turnId) {
        await rm(latest, { force: true }).catch(() => {})
      }
      return hit
    }
  }
  if (latest) {
    const hit = await readPendingFile(latest)
    if (turnId && hit?.turnId && hit.turnId !== turnId) return null
    await rm(latest, { force: true }).catch(() => {})
    if (hit?.turnId) {
      const hitExact = pendingTurnFile(env, sessionId, hit.turnId)
      if (hitExact) await rm(hitExact, { force: true }).catch(() => {})
    }
    return hit
  }
  return null
}

async function sweepPending(env) {
  const dir = pendingDir(env)
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    if (!name.startsWith(PENDING_PREFIX)) continue
    const file = join(dir, name)
    const age = Date.now() - ((await stat(file).catch(() => null))?.mtimeMs ?? Date.now())
    if (age > PENDING_MAX_AGE) await rm(file, { force: true }).catch(() => {})
  }
}

function textsOf(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
}

function userText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) {
    return null
  }
  const content = entry.message?.content ?? entry.content
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return null
  const text = textsOf(content).join('\n').trim()
  return text || null
}

// 兜底从会话记录 JSONL 末尾读取最后一轮用户输入与助手回复
async function lastTurnFromTranscript(filePath) {
  if (!filePath) return null
  let handle
  let text
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - TRANSCRIPT_TAIL)
    const len = size - start
    if (len <= 0) return null
    const buffer = Buffer.alloc(len)
    const { bytesRead } = await handle.read(buffer, 0, len, start)
    if (bytesRead <= 0) return null
    text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 忽略正在写入的不完整行
    }
  }
  let at = entries.length - 1
  while (at >= 0 && userText(entries[at]) === null) at--
  if (at < 0) return null
  const reply = entries
    .slice(at + 1)
    .filter((e) => e?.type === 'assistant' && !e.isSidechain)
    .flatMap((e) => textsOf(e.message?.content ?? e.content))
    .join('\n')
    .trim()
  return { user: userText(entries[at]), reply }
}

function resolveSessionId(input) {
  return (
    pickString(input.session_id) ||
    pickString(input.conversation_id) ||
    pickString(input.sessionId) ||
    pickString(input.conversationId)
  )
}

function resolveTurnId(input) {
  return pickString(input.turn_id) || pickString(input.turnId)
}

function resolveEvent(argEvent, input) {
  if (argEvent) return argEvent
  const nativeName = pickString(input.hook_event_name) || pickString(input.hookEventName)
  return NATIVE_TO_EVENT[nativeName] ?? ''
}

function noticeOf(err) {
  return `Kioku 插件的配置无法使用，长期记忆不可用：${err.message}。${SETUP_HINT}。`
}

let resolvedEvent = process.argv[2] ?? ''

async function main(argEvent) {
  const env = process.env
  let input = {}
  try {
    const raw = await readStdin()
    const parsed = raw.trim() ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
  } catch {
    // 输入不是合法 JSON 时按空对象处理，不阻塞会话
  }

  const event = resolveEvent(argEvent, input)
  resolvedEvent = event
  const timeout = TIMEOUTS[event]
  if (!timeout) throw new KiokuFailure(`未知事件 ${event}`)

  if (event !== 'turn.end') await sweepPending(env)

  let profile
  try {
    profile = await readProfile('zcode', env)
  } catch (err) {
    throw err instanceof KiokuFailure ? new Misconfigured(err.message, 'profile') : err
  }
  if (!profile) {
    if (event === 'session.start') {
      writeContext(event, `Kioku 插件尚未配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}。`)
    }
    return
  }

  const { url: base, key } = profile
  const explicitCwd = pickString(input.cwd)
  const detectedProject = projectOf(explicitCwd || process.cwd())
  const deviceKey = deviceKeyOf(env)
  const rawSessionId = resolveSessionId(input)
  const turnId = resolveTurnId(input)

  const body = { event, ...(deviceKey ? { deviceKey } : {}) }
  if (rawSessionId) body.sessionId = clip(rawSessionId, MAX_SESSION_ID)

  if (event === 'turn.end') {
    if (input.stop_hook_active === true || input.stopHookActive === true) return
    const pending = await takePending(env, rawSessionId, turnId)
    const directReply =
      typeof input.last_assistant_message === 'string'
        ? input.last_assistant_message
        : typeof input.lastAssistantMessage === 'string'
          ? input.lastAssistantMessage
          : ''
    const transcriptPath = pickString(input.transcript_path) || pickString(input.transcriptPath)
    const transcriptTurn =
      !pending?.user || !directReply.trim() ? await lastTurnFromTranscript(transcriptPath) : null
    const user = pending?.user || transcriptTurn?.user || ''
    const reply = directReply.trim() ? directReply.trim() : (transcriptTurn?.reply ?? '')
    if (!body.sessionId || !user) return
    const project = explicitCwd ? detectedProject : (pending?.project ?? detectedProject)
    if (Object.keys(project).length) body.project = project
    body.user = clip(user, MAX_PROMPT)
    body.reply = clip(reply, MAX_REPLY)
    await postEvent(base, key, body, timeout)
    return
  }

  if (Object.keys(detectedProject).length) body.project = detectedProject
  if (event === 'prompt.submit') {
    const prompt = pickString(input.prompt)
    if (!prompt) return
    body.prompt = clip(prompt, MAX_PROMPT)
    await savePending(env, rawSessionId, turnId, body.prompt, detectedProject).catch(() => {})
  }

  const res = await postEvent(base, key, body, timeout)
  const { hostOutput } = await res.json()
  writeContext(event, contextOf(hostOutput))
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (!err || err.code !== 'EPIPE') throw err
  })
}

const argEvent = process.argv[2]
main(argEvent).catch((err) => {
  const activeEvent = resolvedEvent || argEvent || ''
  if (activeEvent === 'session.start' && err instanceof Misconfigured) {
    writeContext(activeEvent, noticeOf(err))
  }
  process.stderr.write(`Kioku ${activeEvent} 未生效：${failureText(err)}\n`)
})
