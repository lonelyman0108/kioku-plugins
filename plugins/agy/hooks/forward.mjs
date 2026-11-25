// Antigravity (agy) 插件钩子：转发 SessionStart、PreInvocation、Stop 给 Kioku。
// PreInvocation 在同一轮工具调用里会多次触发，按 transcript 最新 USER_INPUT 位置去重，每轮只召回一次。
// 任何失败都保持退出码 0、输出合法 JSON {}，不阻断会话，错误写 stderr（不带访问密钥）。

import { createHash, randomUUID } from 'node:crypto'
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
import { pathToFileURL } from 'node:url'

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

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STATE_PREFIX = 'turn.'
const STATE_MAX_AGE = 24 * 60 * 60 * 1000
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
const SETUP_HINT =
  '运行 kioku setup agy 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup agy）'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function stateDir(env) {
  return join(env.PLUGIN_DATA || join(profileDir(env), 'agy-state'), 'turns')
}

function stateFile(env, sessionId) {
  if (!ID.test(sessionId ?? '')) return null
  return join(stateDir(env), `${STATE_PREFIX}${sessionId}.json`)
}

async function readState(env, sessionId) {
  const file = stateFile(env, sessionId)
  if (!file) return null
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeState(env, sessionId, data) {
  const file = stateFile(env, sessionId)
  if (!file) return
  await mkdir(stateDir(env), { recursive: true, mode: 0o700 })
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

async function sweepState(env) {
  const dir = stateDir(env)
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    if (!name.startsWith(STATE_PREFIX)) continue
    const file = join(dir, name)
    const age = Date.now() - ((await stat(file).catch(() => null))?.mtimeMs ?? Date.now())
    if (age > STATE_MAX_AGE) await rm(file, { force: true }).catch(() => {})
  }
}

// 只读 transcript 末尾一段 JSONL，提取最新用户步骤序号与本轮最新的助手回复文本
async function readTranscriptTail(path) {
  if (typeof path !== 'string' || !path) return { userStep: null, reply: '' }
  let handle
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    const size = info.size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const len = size - start
    if (len <= 0) return { userStep: null, reply: '' }
    const buf = Buffer.alloc(len)
    const { bytesRead } = await handle.read(buf, 0, len, start)
    if (bytesRead <= 0) return { userStep: null, reply: '' }
    let text = buf.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    let userStep = null
    let reply = ''
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry?.type === 'USER_INPUT' && entry.step_index !== undefined) {
          userStep = String(entry.step_index)
          reply = ''
        } else if (
          entry?.type === 'PLANNER_RESPONSE' &&
          typeof entry.content === 'string' &&
          entry.content.trim()
        ) {
          reply = entry.content
        }
      } catch {
        // 忽略截断或不完整行
      }
    }
    return { userStep, reply }
  } catch {
    return { userStep: null, reply: '' }
  } finally {
    await handle?.close().catch(() => {})
  }
}

function turnSignature(prompt, userStep) {
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 16)
  return `${userStep ?? 'none'}:${hash}`
}

function buildInjectResult(text) {
  if (typeof text !== 'string' || !text) return {}
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] }
}

export async function forwardAgyEvent(event, rawStdin, env = process.env) {
  const timeout = TIMEOUTS[event]
  if (!timeout) throw new KiokuFailure(`未知事件 ${event}`)
  let input = {}
  try {
    input = JSON.parse(rawStdin || '{}')
  } catch {
    // 非 JSON 时按空输入处理，避免阻断模型执行
  }
  if (event !== 'turn.end') await sweepState(env)

  let profile
  try {
    profile = await readProfile('agy', env)
  } catch (err) {
    throw err instanceof KiokuFailure ? new Misconfigured(err.message, 'profile') : err
  }
  if (!profile) {
    if (event === 'session.start') {
      return buildInjectResult(
        `Kioku 插件尚未配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}。`,
      )
    }
    return {}
  }

  const { url: base, key } = profile
  const sessionId =
    typeof input.conversationId === 'string' && input.conversationId
      ? clip(input.conversationId, MAX_SESSION_ID)
      : undefined
  const explicitCwd =
    (typeof input.cwd === 'string' && input.cwd) ||
    (Array.isArray(input.workspacePaths) &&
      typeof input.workspacePaths[0] === 'string' &&
      input.workspacePaths[0]) ||
    ''
  const detectedProject = projectOf(explicitCwd || process.cwd())
  const deviceKey = deviceKeyOf(env)
  const body = {
    event,
    ...(sessionId ? { sessionId } : {}),
    ...(deviceKey ? { deviceKey } : {}),
  }

  if (event === 'session.start') {
    if (Object.keys(detectedProject).length) body.project = detectedProject
    const res = await postEvent(base, key, body, timeout)
    const { hostOutput } = await res.json()
    return buildInjectResult(contextOf(hostOutput))
  }

  if (event === 'prompt.submit') {
    const prompt = typeof input.lastUserInput === 'string' ? input.lastUserInput.trim() : ''
    if (!prompt) return {}
    const { userStep } = await readTranscriptTail(input.transcriptPath)
    const sig = turnSignature(prompt, userStep)
    if (sessionId) {
      const prev = await readState(env, sessionId)
      if (prev?.sig === sig) return {}
      await writeState(env, sessionId, {
        sig,
        prompt: clip(prompt, MAX_PROMPT),
        ...(Object.keys(detectedProject).length ? { project: detectedProject } : {}),
      }).catch(() => {})
    }
    if (Object.keys(detectedProject).length) body.project = detectedProject
    body.prompt = clip(prompt, MAX_PROMPT)
    const res = await postEvent(base, key, body, timeout)
    const { hostOutput } = await res.json()
    return buildInjectResult(contextOf(hostOutput))
  }

  if (event === 'turn.end') {
    if (input.continuationActive === true) return {}
    const file = sessionId ? stateFile(env, sessionId) : null
    const prev = sessionId ? await readState(env, sessionId) : null
    if (file) await rm(file, { force: true }).catch(() => {})
    const user =
      (typeof input.lastUserInput === 'string' && input.lastUserInput.trim()) || prev?.prompt || ''
    if (!sessionId || !user) return {}
    const { reply } = await readTranscriptTail(input.transcriptPath)
    if (!reply.trim()) return {}
    const project = explicitCwd ? detectedProject : (prev?.project ?? detectedProject)
    if (Object.keys(project).length) body.project = project
    body.user = clip(user, MAX_PROMPT)
    body.reply = clip(reply.trim(), MAX_REPLY)
    await postEvent(base, key, body, timeout)
    return {}
  }

  return {}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.argv[2]
  readStdin()
    .then((raw) => forwardAgyEvent(event, raw, process.env))
    .then((output) => {
      process.stdout.write(JSON.stringify(output ?? {}))
    })
    .catch((err) => {
      if (event === 'session.start' && err instanceof Misconfigured) {
        const text = `Kioku 插件的配置无法使用，长期记忆不可用：${err.message}。${SETUP_HINT}。`
        process.stdout.write(JSON.stringify(buildInjectResult(text)))
      } else {
        process.stdout.write('{}')
      }
      process.stderr.write(`Kioku ${event ?? ''} 未生效：${failureText(err)}\n`)
    })
}
