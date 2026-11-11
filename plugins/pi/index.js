// pi 的扩展：把会话开始、每轮输入、每轮结束转发给 Kioku 的生命周期端点，并注册 Kioku 的 MCP 服务。
// 扩展里不放提示词和格式逻辑，都由服务端决定。
// 任何失败都不挡输入、不往对话里写错误：记忆服务出问题不能打断会话。出了问题只告诉用户一次：
// 有界面时用 pi 的提示（标准错误和界面是同一个终端，直接写会打乱画面），没有界面时写到标准错误。
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
  projectOfAsync,
  TIMEOUTS,
} from './lib/lifecycle.mjs'
import { readProfile } from './lib/profile.mjs'

const SETUP_HINT = '运行 kioku setup pi 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup pi）'
// 注入的上下文在会话里的类型名
const MESSAGE_TYPE = 'kioku'
// 请求失败之后这么久之内，输入前不再去取启动加载与召回：服务端挂住时不让每次回车都等满时限
const BACKOFF = 60_000
// 没有正常说完的助手消息：出错、被中止的那一段不算回复（重试之后还会有完整的一段）
const UNFINISHED = new Set(['error', 'aborted'])

function textsIn(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
}

// env、stderr 与 now 可以换掉，给用例用
export function createKioku(pi, { env = process.env, stderr = () => {}, now = Date.now } = {}) {
  // 地址与访问密钥，扩展加载时读一次；problem 是配置用不了的原因
  let profile = null
  let problem = null
  // 已经告诉过用户的问题，同一个不说第二遍
  const told = new Set()
  // 启动加载还没注入：会话开始、压缩之后各注入一次，放在下一次输入的前面
  let bootPending = false
  // 这个时刻之前，输入前不发请求
  let quietUntil = 0
  // 这一轮：开头的输入，以及运行过程中攒下的用户消息与回复，等 pi 不再接着跑时上报
  let turn = null
  // 还没发完的上报
  const pending = new Set()
  // 项目的目录名与仓库名，按目录记着
  const projects = new Map()

  // 告诉用户一次：有界面时用 pi 的提示，没有时写标准错误。都不进对话
  function tell(ctx, text, level = 'warning') {
    if (told.has(text)) return
    told.add(text)
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, level)
      else stderr(text)
    } catch {
      // 提示不出来也不影响会话
    }
  }

  function configNotice() {
    return problem
      ? `Kioku 的配置无法使用，长期记忆不可用：${problem}。${SETUP_HINT}`
      : `Kioku 还没有配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}`
  }

  const sessionIdOf = (ctx) => {
    const id = ctx.sessionManager?.getSessionId?.()
    return typeof id === 'string' && id ? id.slice(0, MAX_SESSION_ID) : undefined
  }

  function projectFor(cwd) {
    if (!projects.has(cwd)) projects.set(cwd, projectOfAsync(cwd))
    return projects.get(cwd)
  }

  // 把一个事件交给服务端，返回要注入的文本（没有时为空字符串）；失败时告诉用户一次原因，返回 undefined
  async function forward(ctx, event, body, signal) {
    try {
      const res = await postEvent(
        profile.url,
        profile.key,
        { event, ...body },
        TIMEOUTS[event],
        signal,
      )
      if (event === 'turn.end') {
        // 响应不用看，但要读掉，连接才还得回去
        await res.body?.cancel().catch(() => {})
        return ''
      }
      return contextOf((await res.json()).hostOutput) ?? ''
    } catch (err) {
      // 用户自己取消的不算失败
      if (signal?.aborted) return undefined
      if (err instanceof Misconfigured) {
        // 服务地址返回跳转：之后的请求也一样，当成配置写错，当场告诉用户
        problem = err.message
        tell(ctx, configNotice())
      } else {
        quietUntil = now() + BACKOFF
        tell(ctx, `Kioku 这次没有生效（${failureText(err)}），稍后的输入会再试`, 'info')
      }
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
    } catch {
      // 另一个扩展占了这个名字这类：召回与上报照常，工具用不了，等会话开始时告诉用户
      problem = 'Kioku 的 MCP 服务没有注册上（名字被占用，或者这个版本的 pi 不支持）'
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    bootPending = true
    turn = null
    if (!profile || problem) tell(ctx, configNotice())
  })

  // 压缩之后启动加载不在上下文里了，下一次输入时再注入一次
  pi.on('session_compact', async () => {
    bootPending = true
  })

  pi.on('before_agent_start', async (event, ctx) => {
    // 只管用户的输入开始的那一次。扩展自己发消息开始的不算，上一轮没等到结束时留下的也不接到它头上
    if (event.messageType !== 'user') {
      turn = null
      return undefined
    }
    if (!profile) return undefined
    const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
    const sessionId = sessionIdOf(ctx)
    turn = sessionId ? { sessionId, user: clip(prompt, MAX_PROMPT), users: [], replies: [] } : null
    // 刚失败过：这次不等，直接让输入过去
    if (now() < quietUntil) return undefined

    const wantBoot = bootPending
    const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd()
    const signal = ctx.signal
    const session = sessionId ? { sessionId } : {}
    // 两个请求一起发：都在用户按下回车之后等着
    const [boot, recall] = await Promise.all([
      wantBoot
        ? projectFor(cwd).then((project) =>
            forward(
              ctx,
              'session.start',
              { ...session, ...(Object.keys(project).length ? { project } : {}) },
              signal,
            ),
          )
        : undefined,
      prompt
        ? forward(ctx, 'prompt.submit', { ...session, prompt: clip(prompt, MAX_PROMPT) }, signal)
        : undefined,
    ])
    // 启动加载没取到时之后的输入再试；取到了（哪怕是空的）就不再取
    if (wantBoot && boot !== undefined) bootPending = false
    const parts = [boot, recall].filter((text) => typeof text === 'string' && text)
    if (!parts.length) return undefined
    // 只交上下文文本，不改系统提示：记忆服务能决定注入什么内容，但不能改变会话
    return {
      message: { customType: MESSAGE_TYPE, content: parts.join('\n\n'), display: false },
    }
  })

  // 一次输入可能跑好几段（重试、压缩后重试、排队的消息），每段结束时把用户说的、助手正常说完的文字攒起来。
  // 运行中排进来的输入不会再触发 before_agent_start，只在这里看得到
  pi.on('agent_end', async (event) => {
    if (!turn || !Array.isArray(event.messages)) return
    for (const message of event.messages) {
      if (message?.role === 'user') turn.users.push(...textsIn(message.content))
      else if (message?.role === 'assistant' && !UNFINISHED.has(message.stopReason)) {
        turn.replies.push(...textsIn(message.content))
      }
    }
  })

  // pi 不再接着跑了：把这一轮交给服务端写会话摘要。不等它完成，不拖住下一次输入。
  // 被中止的、没有回复的一轮不报：没有可以写进摘要的内容
  pi.on('agent_settled', async (event, ctx) => {
    const done = turn
    turn = null
    if (!done || !profile || event?.aborted) return
    const reply = done.replies.join('\n').trim()
    // 攒到了用户消息就用它们（含运行中排进来的），没有就用开头的那条输入
    const user = done.users.join('\n').trim() || done.user
    if (!reply || !user) return
    const sent = forward(ctx, 'turn.end', {
      sessionId: done.sessionId,
      user: clip(user, MAX_PROMPT),
      reply: clip(reply, MAX_REPLY),
    }).finally(() => pending.delete(sent))
    pending.add(sent)
  })

  // 会话要关了（退出、换会话、--print 跑完）：等还没发完的上报，否则进程先退出就丢了。每个上报自己有时限
  pi.on('session_shutdown', async () => {
    await Promise.all(pending)
  })

  return { load }
}

export default async function kioku(pi) {
  // 扩展的标准输出属于 pi（--print、JSON 模式都用它），没有界面时原因只写到标准错误
  const stderr = (text) => process.stderr.write(`${text}\n`)
  await createKioku(pi, { stderr }).load()
}
