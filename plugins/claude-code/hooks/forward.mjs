// Claude Code 钩子：把 SessionStart、UserPromptSubmit、Stop 转发给 Kioku 的生命周期端点，
// 服务端返回的输出原样写到标准输出。插件里不放提示词和格式逻辑，都由服务端决定。
// 任何失败都以退出码 0 结束、不写标准输出：记忆服务出问题不能挡住用户的输入。
// 服务地址与 Key 来自插件配置（启用插件时填写），Claude Code 以 CLAUDE_PLUGIN_OPTION_* 环境变量传进来

import { execFileSync } from 'node:child_process'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'

// 各事件等待服务端的上限（毫秒），要比 hooks.json 里的 timeout 短
const TIMEOUTS = { 'session.start': 8000, 'prompt.submit': 5000, 'turn.end': 5000 }
// 与服务端 contracts 的上限一致
const MAX_PROMPT = 20_000
const MAX_REPLY = 20_000
const MAX_SESSION_ID = 200
const MAX_NAME = 128
// 会话记录只读末尾这么多字节：最后一轮就在末尾，整份可能很大
const TRANSCRIPT_TAIL = 2 * 1024 * 1024

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// 当前项目的目录名与 git 仓库名，服务端用它们召回与项目相关的记忆；取不到的就不带
function projectOf(cwd) {
  const project = {}
  const dirName = basename(cwd)
  if (dirName) project.dirName = dirName.slice(0, MAX_NAME)
  try {
    const remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const repoName = /([^/:]+?)(?:\.git)?$/.exec(remote)?.[1]
    if (repoName) project.repoName = repoName.slice(0, MAX_NAME)
  } catch {
    // 不是 git 仓库或没有 origin
  }
  return project
}

// 只把上下文文本交给 Claude Code，钩子输出的其他字段（例如 decision、continue）一律不透传：
// 记忆服务能决定注入什么内容，但不能挡住用户的输入或改变会话
// 两个事件都输出结构化的 JSON：纯文本如果恰好是一个 JSON 对象，Claude Code 会把它当成钩子的控制输出
function writeContext(event, text) {
  if (typeof text !== 'string' || !text) return
  const hookEventName = event === 'session.start' ? 'SessionStart' : 'UserPromptSubmit'
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }),
  )
}

// 会话记录（JSONL，一行一条）里最后一轮：最后一条用户自己输入的消息，和它之后助手回复里的文字。
// 工具调用与结果、系统注入的消息、子 Agent 的对话都不算；读不到或没有用户输入时为 null
async function lastTurn(path) {
  const handle = await open(path, 'r')
  let text
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TRANSCRIPT_TAIL)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    text = buffer.toString('utf8')
    // 从中间读起时第一行是半截
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  } finally {
    await handle.close()
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 正在写的最后一行可能不完整
    }
  }
  let at = entries.length - 1
  while (at >= 0 && userText(entries[at]) === null) at--
  if (at < 0) return null
  const reply = entries
    .slice(at + 1)
    .filter((e) => e?.type === 'assistant' && !e.isSidechain)
    .flatMap((e) => textsOf(e.message?.content))
    .join('\n')
    .trim()
  return { user: userText(entries[at]), reply }
}

// 按长度截断时不切开代理对（表情这类字符）：落单的半个到了服务端会变成替换字符
function clip(text, max) {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

function textsOf(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
}

// 用户自己输入的文字；工具结果也记成用户消息，不算
function userText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) {
    return null
  }
  const content = entry.message?.content
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return null
  const text = textsOf(content).join('\n').trim()
  return text || null
}

function contextOf(hostOutput) {
  if (hostOutput?.mode === 'stdout_json')
    return hostOutput.value?.hookSpecificOutput?.additionalContext
  if (hostOutput?.mode === 'stdout_text') return hostOutput.value
  return undefined
}

async function main(event) {
  const timeout = TIMEOUTS[event]
  if (!timeout) throw new Error(`未知事件 ${event}`)
  const base = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const key = (process.env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  let input = {}
  try {
    input = JSON.parse((await readStdin()) || '{}')
  } catch {
    // 输入不是 JSON 时按空输入处理：会话开始照常注入，提交的提示语为空则不召回
  }

  if (!base || !key) {
    // 只在会话开始时提示一次，让模型告诉用户插件还没配置好
    if (event === 'session.start') {
      writeContext(
        event,
        'Kioku 插件还没有配置服务地址和访问密钥，长期记忆不可用：在 /plugin 里为 kioku 填写配置。',
      )
    }
    return
  }

  const body = { event }
  if (typeof input.session_id === 'string' && input.session_id) {
    body.sessionId = input.session_id.slice(0, MAX_SESSION_ID)
  }
  if (event === 'turn.end') {
    // 一轮结束：把这一轮交给服务端写会话摘要，不带会话上下文；什么都不写到标准输出（Stop 钩子的输出能挡住结束）。
    // 别的钩子让 Claude 接着说时（stop_hook_active）这一轮还没完，等真正结束的那一次
    if (input.stop_hook_active === true) return
    if (!body.sessionId || typeof input.transcript_path !== 'string') return
    const turn = await lastTurn(input.transcript_path)
    if (!turn) return
    body.user = clip(turn.user, MAX_PROMPT)
    body.reply = clip(turn.reply, MAX_REPLY)
    const res = await fetch(`${base}/v1/lifecycle/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
    body.prompt = prompt.slice(0, MAX_PROMPT)
  }

  const res = await fetch(`${base}/v1/lifecycle/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { hostOutput } = await res.json()
  writeContext(event, contextOf(hostOutput))
}

const event = process.argv[2]
main(event).catch((err) => {
  // 标准错误只出现在 Claude Code 的调试输出里，不进上下文
  process.stderr.write(`Kioku ${event ?? ''} 未生效：${err instanceof Error ? err.message : err}\n`)
})
