// Codex 钩子：把 SessionStart、UserPromptSubmit、Stop 转发给 Kioku 的生命周期端点，服务端给的上下文交还 Codex。
// 插件里不放提示词和格式逻辑，都由服务端决定。
// 任何失败都以退出码 0 结束、不写标准输出：记忆服务出问题不能挡住用户的输入。
// 服务地址与访问密钥来自 kioku setup codex 写下的文件（Codex 的插件没有自己的配置项）。
// 失败的原因写到标准错误，不带访问密钥：格式不对的访问密钥不发出去，fetch 的报错只取类别，也不跟着跳转走

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { failureText, KiokuFailure } from '../lib/http.mjs'
import {
  clip,
  contextOf,
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
// 会话与轮次的标识要拼进文件名，只收这些字符
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PENDING_PREFIX = 'turn.'
// 没等到这一轮结束的输入（这一轮被中断、会话被强行结束）留这么久，之后在会话开始或下一次输入时删掉
const PENDING_MAX_AGE = 24 * 60 * 60 * 1000
const SETUP_HINT =
  '运行 kioku setup codex 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup codex）'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// 只把上下文文本交给 Codex，钩子输出的其他字段（continue、decision 这类）一律不写：
// 记忆服务能决定注入什么内容，但不能挡住用户的输入或改变会话。
// 一律输出结构化的 JSON：纯文本如果恰好是一个 JSON 对象，会被当成钩子的控制输出
function writeContext(event, text) {
  if (typeof text !== 'string' || !text) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENTS[event], additionalContext: text },
    }),
  )
}

// Stop 钩子只给助手最后的回复，不给用户的输入：输入在提交时先记下，等这一轮结束时取。
// 放在插件的数据目录里（没有时放在 Kioku 的配置目录下），只给本人读写，取走就删
function pendingDir(env) {
  return join(env.PLUGIN_DATA || join(profileDir(env), 'codex-state'), 'turns')
}

function pendingFile(env, sessionId, turnId) {
  if (!ID.test(sessionId ?? '') || !ID.test(turnId ?? '')) return null
  return join(pendingDir(env), `${PENDING_PREFIX}${sessionId}.${turnId}.json`)
}

async function savePending(env, input, prompt) {
  const file = pendingFile(env, input.session_id, input.turn_id)
  if (!file) return
  await mkdir(pendingDir(env), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify({ prompt }), { mode: 0o600 })
}

// 取走这一轮记下的输入；没有记下（提交时钩子没跑、或者已经取过）时为 null
async function takePending(env, input) {
  const file = pendingFile(env, input.session_id, input.turn_id)
  if (!file) return null
  try {
    const { prompt } = JSON.parse(await readFile(file, 'utf8'))
    return typeof prompt === 'string' && prompt ? prompt : null
  } catch {
    return null
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

// 删掉放了很久的输入：这一轮没有等到结束
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

// 配置写错时，会话开始给模型一段提示，让它告诉用户去改；不带访问密钥
function noticeOf(err) {
  return `Kioku 插件的配置无法使用，长期记忆不可用：${err.message}。${SETUP_HINT}。`
}

async function main(event) {
  const timeout = TIMEOUTS[event]
  if (!timeout) throw new KiokuFailure(`未知事件 ${event}`)
  const env = process.env
  let input = {}
  try {
    input = JSON.parse((await readStdin()) || '{}')
  } catch {
    // 输入不是 JSON 时按空输入处理：会话开始照常注入，提交的提示语为空则不召回
  }
  // 每轮结束之外的两个事件都顺手清一次：只在会话开始清的话，一直开着的会话里中断的轮次会留很久
  if (event !== 'turn.end') await sweepPending(env)

  let profile
  try {
    profile = await readProfile('codex', env)
  } catch (err) {
    // 文件在、内容不对：和服务地址返回跳转一样算配置写错
    throw err instanceof KiokuFailure ? new Misconfigured(err.message, 'profile') : err
  }
  if (!profile) {
    // 只在会话开始时提示一次，让模型告诉用户插件还没配置好
    if (event === 'session.start') {
      writeContext(event, `Kioku 插件还没有配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}。`)
    }
    return
  }
  const { url: base, key } = profile

  const body = { event }
  if (typeof input.session_id === 'string' && input.session_id) {
    body.sessionId = input.session_id.slice(0, MAX_SESSION_ID)
  }
  if (event === 'turn.end') {
    // 一轮结束：把这一轮交给服务端写会话摘要，不带会话上下文；什么都不写到标准输出（Stop 钩子的输出能让它接着说）。
    // 别的钩子让它接着说时（stop_hook_active）这一轮还没完，等真正结束的那一次，记下的输入留着
    if (input.stop_hook_active === true) return
    const user = await takePending(env, input)
    const reply =
      typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
    if (!body.sessionId || !user) return
    body.user = clip(user, MAX_PROMPT)
    body.reply = clip(reply.trim(), MAX_REPLY)
    await postEvent(base, key, body, timeout)
    return
  }
  if (event === 'session.start') {
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
    const project = projectOf(cwd)
    if (Object.keys(project).length) body.project = project
  }
  if (event === 'prompt.submit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) return
    body.prompt = clip(prompt, MAX_PROMPT)
    // 先记下输入再召回：召回失败也不影响这一轮结束时写会话摘要
    await savePending(env, input, body.prompt).catch(() => {})
  }

  const res = await postEvent(base, key, body, timeout)
  const { hostOutput } = await res.json()
  writeContext(event, contextOf(hostOutput))
}

const event = process.argv[2]
main(event).catch((err) => {
  if (event === 'session.start' && err instanceof Misconfigured) writeContext(event, noticeOf(err))
  // 标准错误不进上下文；插件自己写的原因原样给出，别的只给类别
  process.stderr.write(`Kioku ${event ?? ''} 未生效：${failureText(err)}\n`)
})
