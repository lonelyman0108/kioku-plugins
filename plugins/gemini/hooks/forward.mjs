// Gemini CLI 扩展钩子：把 SessionStart、BeforeAgent、AfterAgent 转发给 Kioku 的生命周期端点。
// 任何失败都以退出码 0 结束、不阻断会话，原因写到标准错误（不带访问密钥）。

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { failureText, KiokuFailure, LegacyDatabase } from '../lib/http.mjs'
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

const HOOK_EVENTS = { 'session.start': 'SessionStart', 'prompt.submit': 'BeforeAgent' }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PENDING_PREFIX = 'turn.'
const PENDING_MAX_AGE = 24 * 60 * 60 * 1000
const SETUP_HINT =
  '运行 kioku setup gemini 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup gemini）'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function writeContext(event, text) {
  if (typeof text !== 'string' || !text) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENTS[event], additionalContext: text },
    }),
  )
}

function pendingDir(env) {
  return join(env.KIOKU_GEMINI_STATE || join(profileDir(env), 'gemini-state'), 'turns')
}

function pendingFile(env, sessionId) {
  if (!ID.test(sessionId ?? '')) return null
  return join(pendingDir(env), `${PENDING_PREFIX}${sessionId}.json`)
}

async function savePending(env, sessionId, prompt, project) {
  const file = pendingFile(env, sessionId)
  if (!file) return
  await mkdir(pendingDir(env), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const data = Object.keys(project ?? {}).length ? { prompt, project } : { prompt }
    await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

async function takePending(env, sessionId) {
  const file = pendingFile(env, sessionId)
  if (!file) return null
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed?.prompt !== 'string' || !parsed.prompt) return null
    return {
      user: parsed.prompt,
      project:
        parsed.project && typeof parsed.project === 'object' && !Array.isArray(parsed.project)
          ? parsed.project
          : undefined,
    }
  } catch {
    return null
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
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

export async function forwardGeminiEvent(event, rawStdin, env = process.env) {
  const timeout = TIMEOUTS[event]
  if (!timeout) throw new KiokuFailure(`未知事件 ${event}`)
  let input = {}
  try {
    input = JSON.parse(rawStdin || '{}')
  } catch {
    // 非 JSON 时按空输入处理，避免阻断用户回合
  }
  if (event !== 'turn.end') await sweepPending(env)

  let profile
  try {
    profile = await readProfile('gemini', env)
  } catch (err) {
    throw err instanceof KiokuFailure ? new Misconfigured(err.message, 'profile') : err
  }
  if (!profile) {
    if (event === 'session.start') {
      return `Kioku 插件尚未配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}。`
    }
    return null
  }

  const { url: base, key } = profile
  const sessionId =
    typeof input.session_id === 'string' && input.session_id
      ? clip(input.session_id, MAX_SESSION_ID)
      : undefined
  const explicitCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : ''
  const detectedProject = projectOf(explicitCwd || process.cwd())
  const deviceKey = deviceKeyOf(env)
  const body = {
    event,
    ...(sessionId ? { sessionId } : {}),
    ...(deviceKey ? { deviceKey } : {}),
  }

  if (event === 'turn.end') {
    if (input.stop_hook_active === true) return null
    const direct = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    // 总是消费并清理本轮暂存，避免已传入直传 prompt 时暂存文件残留并保留项目上下文
    const pending = await takePending(env, sessionId)
    const user = direct || pending?.user
    const reply =
      typeof input.prompt_response === 'string'
        ? input.prompt_response
        : typeof input.last_assistant_message === 'string'
          ? input.last_assistant_message
          : ''
    if (!sessionId || !user) return null
    const project = explicitCwd ? detectedProject : (pending?.project ?? detectedProject)
    if (Object.keys(project).length) body.project = project
    body.user = clip(user, MAX_PROMPT)
    body.reply = clip(reply.trim(), MAX_REPLY)
    await postEvent(base, key, body, timeout)
    return null
  }

  if (Object.keys(detectedProject).length) body.project = detectedProject

  if (event === 'prompt.submit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) return null
    body.prompt = clip(prompt, MAX_PROMPT)
    await savePending(env, sessionId, body.prompt, detectedProject).catch(() => {})
  }

  const res = await postEvent(base, key, body, timeout)
  const { hostOutput } = await res.json()
  return contextOf(hostOutput) ?? null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.argv[2]
  readStdin()
    .then((raw) => forwardGeminiEvent(event, raw, process.env))
    .then((text) => {
      if (text && HOOK_EVENTS[event]) writeContext(event, text)
    })
    .catch((err) => {
      if (
        event === 'session.start' &&
        (err instanceof Misconfigured || err instanceof LegacyDatabase)
      ) {
        const text =
          err instanceof LegacyDatabase || err.kind === 'legacy'
            ? `Kioku 长期记忆不可用：${err.message}。`
            : `Kioku 插件的配置无法使用，长期记忆不可用：${err.message}。${SETUP_HINT}。`
        writeContext(event, text)
      }
      process.stderr.write(`Kioku ${event ?? ''} 未生效：${failureText(err)}\n`)
    })
}
