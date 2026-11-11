// pi 的扩展：把会话开始、每轮输入、每轮结束转发给 Kioku 的生命周期端点，并注册 Kioku 的 MCP 服务。
// 扩展里不放提示词和格式逻辑，都由服务端决定。
// 任何失败都不挡输入、不往对话里写错误：记忆服务出问题不能打断会话。只有还没配置、或者配置写错时，
// 在会话开始提示用户一次怎么改。
// 服务地址与访问密钥来自 kioku setup pi 写下的文件（pi 的扩展没有自己的密钥存储）

import { failureText, KiokuFailure } from './lib/http.mjs'
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
} from './lib/lifecycle.mjs'
import { readProfile } from './lib/profile.mjs'

const SETUP_HINT = '运行 kioku setup pi 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup pi）'
// 注入的上下文在会话里的类型名
const MESSAGE_TYPE = 'kioku'

// 助手消息里的文字；思考与工具调用不算
function textOf(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
}

// env 与 log 可以换掉，给用例用
export function createKioku(pi, { env = process.env, log = () => {} } = {}) {
  // 地址与访问密钥，扩展加载时读一次；problem 是读不出来的原因
  let profile = null
  let problem = null
  // 启动加载还没注入：会话开始、压缩之后各注入一次，放在下一次输入的前面
  let bootPending = false
  // 这一轮的输入与到目前为止的回复，等 pi 不再接着跑时上报
  let turn = null
  // 还没发完的上报
  const pending = new Set()

  const sessionIdOf = (ctx) => {
    const id = ctx.sessionManager?.getSessionId?.()
    return typeof id === 'string' && id ? id.slice(0, MAX_SESSION_ID) : undefined
  }

  // 把一个事件交给服务端，返回要注入的文本（没有时为空字符串）；失败时只记一句原因，返回 undefined
  async function forward(event, body) {
    try {
      const res = await postEvent(profile.url, profile.key, { event, ...body }, TIMEOUTS[event])
      if (event === 'turn.end') return undefined
      // 没有要注入的内容时是空字符串，和失败（undefined）分开
      return contextOf((await res.json()).hostOutput) ?? ''
    } catch (err) {
      // 服务地址返回跳转：这次会话里别的请求也一样，记下来提示用户
      if (err instanceof Misconfigured) problem = err.message
      log(`Kioku ${event} 未生效：${failureText(err)}`)
      return undefined
    }
  }

  async function load() {
    try {
      profile = await readProfile('pi', env)
    } catch (err) {
      problem = err instanceof KiokuFailure ? err.message : failureText(err)
      return
    }
    if (!profile) return
    try {
      // mcp.json 里同名的服务优先；每次加载都要重新注册
      pi.registerMcpServer('kioku', {
        url: `${profile.url}/v1/mcp`,
        headers: { Authorization: `Bearer ${profile.key}` },
        description: 'Kioku 长期记忆',
      })
    } catch (err) {
      log(`Kioku 的 MCP 服务没有注册上：${failureText(err)}`)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    bootPending = true
    turn = null
    if (!profile || problem) {
      const text = problem
        ? `Kioku 的配置无法使用，长期记忆不可用：${problem}。${SETUP_HINT}`
        : `Kioku 还没有配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}`
      // 没有界面时（--print 这类）写到标准错误，不进对话
      if (ctx.hasUI) ctx.ui.notify(text, 'warning')
      else log(text)
    }
  })

  // 压缩之后启动加载不在上下文里了，下一次输入时再注入一次
  pi.on('session_compact', async () => {
    bootPending = true
  })

  pi.on('before_agent_start', async (event, ctx) => {
    // 只管用户的输入开始的那一次；扩展自己发消息开始的不算
    if (event.messageType !== 'user' || !profile) return undefined
    const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
    const sessionId = sessionIdOf(ctx)
    const wantBoot = bootPending
    const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd()
    const project = wantBoot ? projectOf(cwd) : {}
    // 两个请求一起发：都在用户按下回车之后等着
    const [boot, recall] = await Promise.all([
      wantBoot
        ? forward('session.start', {
            ...(sessionId ? { sessionId } : {}),
            ...(Object.keys(project).length ? { project } : {}),
          })
        : undefined,
      prompt
        ? forward('prompt.submit', {
            ...(sessionId ? { sessionId } : {}),
            prompt: clip(prompt, MAX_PROMPT),
          })
        : undefined,
    ])
    // 启动加载没取到时下一次输入再试；取到了（哪怕是空的）就不再取
    if (wantBoot && boot !== undefined) bootPending = false
    turn = prompt && sessionId ? { sessionId, user: clip(prompt, MAX_PROMPT), replies: [] } : null
    const parts = [boot, recall].filter((text) => typeof text === 'string' && text)
    if (!parts.length) return undefined
    // 只交上下文文本，不改系统提示：记忆服务能决定注入什么内容，但不能改变会话
    return {
      message: { customType: MESSAGE_TYPE, content: parts.join('\n\n'), display: false },
    }
  })

  // 一次输入可能跑好几段（重试、压缩后重试、排队的消息），每段结束时把回复里的文字攒起来
  pi.on('agent_end', async (event) => {
    if (!turn || !Array.isArray(event.messages)) return
    turn.replies.push(...event.messages.flatMap(textOf))
  })

  // pi 不再接着跑了：把这一轮交给服务端写会话摘要。不等它完成，不拖住下一次输入
  pi.on('agent_settled', async () => {
    const done = turn
    turn = null
    if (!done || !profile) return
    const reply = done.replies.join('\n').trim()
    const sent = forward('turn.end', {
      sessionId: done.sessionId,
      user: done.user,
      reply: clip(reply, MAX_REPLY),
    }).finally(() => pending.delete(sent))
    pending.add(sent)
  })

  // 会话要关了（退出、换会话、--print 跑完）：等还没发完的上报，否则进程先退出就丢了。forward 自己有时限
  pi.on('session_shutdown', async () => {
    await Promise.all(pending)
  })

  return { load }
}

export default async function kioku(pi) {
  // 扩展的标准输出属于 pi（--print、JSON 模式都用它），原因只写到标准错误
  const log = (text) => process.stderr.write(`${text}\n`)
  await createKioku(pi, { log }).load()
}
