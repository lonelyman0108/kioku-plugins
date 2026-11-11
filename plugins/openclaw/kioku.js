// OpenClaw 的记忆插件：占记忆槽位（OpenClaw 自带的记忆工具随之停用），把每轮输入、每轮结束转发给 Kioku 的
// 生命周期端点，并把 Kioku 的工具登记成 OpenClaw 的工具。提示词和格式逻辑都由服务端决定。
// 只在本机入口来的运行里生效：外部渠道（Telegram 这类）来的消息里不注入、不上报、不给工具，认不出来的一律不生效。
// 任何失败都不挡这一轮、不往对话里写错误，只在日志里说一次。
// 服务地址与访问密钥来自 kioku setup openclaw 写下的文件，不放进 OpenClaw 的配置

import { failureText, KiokuFailure } from './lib/http.mjs'
import {
  clip,
  contextOf,
  MAX_PROMPT,
  MAX_REPLY,
  MAX_SESSION_ID,
  Misconfigured,
  postEvent,
  TIMEOUTS,
} from './lib/lifecycle.mjs'
import { callTool, listTools, readToolCacheSync, writeToolCache } from './lib/mcp.mjs'
import { readProfile } from './lib/profile.mjs'

const PLATFORM = 'openclaw'
const SETUP_HINT =
  '运行 kioku setup openclaw 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup openclaw）'

// 登记的工具名，要和 openclaw.plugin.json 的 contracts.tools 一致：OpenClaw 只认清单里声明过的
export const TOOL_NAMES = [
  'kioku_boot',
  'kioku_search',
  'kioku_get',
  'kioku_list',
  'kioku_create',
  'kioku_update',
  'kioku_delete',
  'kioku_move',
  'kioku_credential',
  'kioku_credential_save',
  'kioku_credential_delete',
]

// OpenClaw 自己的入口（命令行、终端界面、控制界面、网关的 HTTP 接口）用的内部通道名，过了网关鉴权的才到得了
const INTERNAL_CHANNEL = 'webchat'
// 子 agent、定时任务这类不是用户在对话的会话
const RESERVED_SESSION = /(^|:)(subagent|cron|acp|hook)(:|$)/
// 请求失败之后这么久之内，输入前不再发请求：服务端挂住时不让每一轮都等满时限
const BACKOFF = 60_000
// 启动加载按会话记着，每一轮都放进系统提示（系统提示每轮重建）；隔这么久重新取一次
const BOOT_TTL = 60 * 60_000
// 工具清单隔这么久重新取一次
const TOOLS_TTL = 60 * 60_000
// 没有配置时隔这么久再读一次文件：网关一直开着，中途配好了不用重启也能认到
const PROFILE_RETRY = 60_000
// 记着的会话与运行的个数上限
const MAX_TRACKED = 200
// 没有正常说完的助手消息：出错、被中止的那一段不算回复
const UNFINISHED = new Set(['error', 'aborted'])

const internal = (value) => value === undefined || value === null || value === INTERNAL_CHANNEL
const userSession = (key) => typeof key === 'string' && key && !RESERVED_SESSION.test(key)

// 这次运行是不是用户从本机入口发起的。按白名单认：通道的几个字段要么没有、要么是内部通道，没有发送者，
// 是用户触发的（心跳、定时任务不算）
export function localRun(ctx) {
  if (ctx?.trigger !== 'user') return false
  if (![ctx.messageProvider, ctx.channel, ctx.channelId, ctx.chatId].every(internal)) return false
  if (ctx.senderId !== undefined && ctx.senderId !== null && ctx.senderId !== '') return false
  return userSession(ctx.sessionKey)
}

// 给不给这次运行工具：和上面同一个规则，用工具上下文里的字段
export function localTools(ctx) {
  if (!ctx || !internal(ctx.messageChannel) || !internal(ctx.deliveryContext?.channel)) return false
  if (ctx.requesterSenderId !== undefined && ctx.requesterSenderId !== null) return false
  return userSession(ctx.sessionKey)
}

function textsIn(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
}

// 这一轮的回复：最后一条用户消息之后，助手正常说完的文字
export function replyOf(messages) {
  if (!Array.isArray(messages)) return ''
  const last = messages.findLastIndex((message) => message?.role === 'user')
  return messages
    .slice(last + 1)
    .filter((message) => message?.role === 'assistant' && !UNFINISHED.has(message.stopReason))
    .flatMap((message) => textsIn(message.content))
    .join('\n')
    .trim()
}

// 超出上限时丢掉最早记下的
function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value)
}

// env 与 now 可以换掉，给用例用
export function createKioku({ env = process.env, now = Date.now } = {}) {
  // 地址与访问密钥；problem 是配置用不了的原因
  let profile = null
  let problem = null
  let loading = null
  let retryAt = 0
  // 工具清单：先用本机留的那一份，取到新的再换
  const cached = readToolCacheSync(PLATFORM, env)
  let tools = cached?.tools ?? []
  let toolsUrl = cached?.url ?? null
  // 清单是什么时候取的。本机那份还新的话不重新取：openclaw 的每个命令都会装载一次插件
  let toolsAt = cached && cached.at <= now() ? cached.at : 0
  let refreshing = null
  let logger = null
  // 已经说过的问题，同一个不说第二遍
  const told = new Set()
  // 这个时刻之前，输入前不发请求
  let quietUntil = 0
  // 会话的启动加载：会话 id → { text, at }
  const boots = new Map()
  // 进行中的运行：运行 id → { sessionId, prompt }
  const runs = new Map()

  function tell(text) {
    if (told.has(text)) return
    told.add(text)
    try {
      logger?.warn?.(text)
    } catch {
      // 日志写不出来也不影响这一轮
    }
  }

  function configNotice() {
    return problem
      ? `Kioku 的配置无法使用，长期记忆不可用：${problem}。${SETUP_HINT}`
      : `Kioku 还没有配置服务地址和访问密钥，长期记忆不可用：${SETUP_HINT}`
  }

  async function load() {
    // 读完之前不再起第二次
    retryAt = Infinity
    try {
      profile = await readProfile(PLATFORM, env)
      problem = null
    } catch (err) {
      profile = null
      problem = err instanceof KiokuFailure ? err.message : failureText(err)
    }
    // 本机留的清单是别的地址的、或者现在没有配置：不用它
    if (!profile || toolsUrl !== profile.url) {
      tools = []
      toolsAt = 0
    }
    if (profile) refreshTools()
    retryAt = now() + PROFILE_RETRY
  }

  // 等配置读完；没有配置、配置读不懂时隔一阵再读一次
  function ready() {
    if (!loading || (!profile && now() >= retryAt)) loading = load()
    return loading
  }

  // 取一次工具清单，不等它：取到了换掉内存里的并写回本机。取不到时沿用手上的
  function refreshTools() {
    if (refreshing || !profile || (toolsAt && now() - toolsAt < TOOLS_TTL)) return
    const target = profile
    refreshing = listTools(target)
      .then(async (list) => {
        tools = list
        toolsUrl = target.url
        toolsAt = now()
        await writeToolCache(PLATFORM, { url: target.url, tools: list, at: toolsAt }, env)
      })
      .catch((err) => {
        // 隔一阵再试，不每一轮都试
        toolsAt = now() - TOOLS_TTL + BACKOFF
        tell(`Kioku 的工具清单没有取到（${failureText(err)}），稍后再试`)
      })
      .finally(() => {
        refreshing = null
      })
  }

  // 把一个事件交给服务端，返回要注入的文本（没有时为空字符串）；失败时说一次原因，返回 undefined
  async function forward(event, body) {
    try {
      const res = await postEvent(profile.url, profile.key, { event, ...body }, TIMEOUTS[event])
      if (event === 'turn.end') {
        // 响应不用看，但要读掉，连接才还得回去
        await res.body?.cancel().catch(() => {})
        return ''
      }
      return contextOf((await res.json()).hostOutput) ?? ''
    } catch (err) {
      if (err instanceof Misconfigured) {
        // 服务地址返回跳转：之后的请求也一样，当成配置写错
        problem = err.message
        tell(configNotice())
      } else {
        quietUntil = now() + BACKOFF
        tell(`Kioku 这次没有生效（${failureText(err)}），稍后的输入会再试`)
      }
      return undefined
    }
  }

  async function beforePrompt(event, ctx) {
    if (!localRun(ctx)) return undefined
    await ready()
    if (!profile || problem) {
      tell(configNotice())
      return undefined
    }
    refreshTools()
    const prompt = typeof event?.prompt === 'string' ? event.prompt.trim() : ''
    const sessionId =
      typeof ctx.sessionId === 'string' && ctx.sessionId
        ? ctx.sessionId.slice(0, MAX_SESSION_ID)
        : undefined
    if (sessionId && typeof ctx.runId === 'string' && ctx.runId) {
      remember(runs, ctx.runId, { sessionId, prompt: clip(prompt, MAX_PROMPT) })
    }
    const known = sessionId ? boots.get(sessionId) : undefined
    // 刚失败过：这次不等，手上有启动加载就照旧给
    if (now() < quietUntil) return known?.text ? { prependSystemContext: known.text } : undefined

    const wantBoot = !known || now() - known.at >= BOOT_TTL
    const session = sessionId ? { sessionId } : {}
    // 两个请求一起发：都在这一轮开始之前等着
    const [boot, recall] = await Promise.all([
      wantBoot ? forward('session.start', session) : undefined,
      prompt
        ? forward('prompt.submit', { ...session, prompt: clip(prompt, MAX_PROMPT) })
        : undefined,
    ])
    // 取到了（哪怕是空的）就记下；没取到时沿用上一次的，下一轮再取
    if (sessionId && typeof boot === 'string') remember(boots, sessionId, { text: boot, at: now() })
    const bootText = typeof boot === 'string' ? boot : known?.text
    // 只交上下文文本：启动加载放系统提示的前面，召回放这一轮输入的前面
    const result = {}
    if (bootText) result.prependSystemContext = bootText
    if (recall) result.prependContext = recall
    return Object.keys(result).length ? result : undefined
  }

  // 一轮结束：把这一轮交给服务端写会话摘要。等它发完（各有时限）：一次性的运行里进程接着就退出了。
  // 没成功的、没有回复的一轮不报：没有可以写进摘要的内容
  async function agentEnd(event, ctx) {
    const run = typeof ctx?.runId === 'string' ? runs.get(ctx.runId) : undefined
    if (!run) return
    runs.delete(ctx.runId)
    if (!profile || problem || event?.success === false) return
    const reply = replyOf(event?.messages)
    if (!reply || !run.prompt) return
    await forward('turn.end', {
      sessionId: run.sessionId,
      user: run.prompt,
      reply: clip(reply, MAX_REPLY),
    })
  }

  function toTool({ name, description, inputSchema }) {
    return {
      name,
      label: name,
      description,
      parameters: inputSchema,
      async execute(_callId, params, signal) {
        const say = (text) => ({ content: [{ type: 'text', text }] })
        await ready()
        if (!profile || problem) return say(configNotice())
        try {
          const { text, isError } = await callTool(profile, name, params, signal)
          return say(text || (isError ? 'Kioku 的这次调用没有成功' : '（没有内容）'))
        } catch (err) {
          return say(`Kioku 的这次调用没有成功：${failureText(err)}`)
        }
      },
    }
  }

  // 工具工厂是同步的：只能给手上已经有的清单
  function toolsFor(ctx) {
    if (!localTools(ctx)) return null
    const list = tools.filter((tool) => TOOL_NAMES.includes(tool.name))
    return list.length ? list.map(toTool) : null
  }

  // OpenClaw 每装载一次插件注册表就调一次，同一个进程里会调很多次：状态都在外面，这里只挂钩子
  function register(api) {
    logger = api.logger ?? logger
    ready()
    try {
      // 占住记忆槽位，自带的记忆插件随之停用；提示段不在这里给，由钩子按会话决定
      api.registerMemoryCapability({})
    } catch {
      // 没被选进记忆槽位时不让登记：钩子与工具照常
    }
    const guarded = (handler) => async (event, ctx) => {
      try {
        return await handler(event, ctx)
      } catch (err) {
        tell(`Kioku 的插件出错了（${failureText(err)}），这一轮没有生效`)
        return undefined
      }
    }
    api.on('before_prompt_build', guarded(beforePrompt))
    api.on('agent_end', guarded(agentEnd))
    api.registerTool(
      (ctx) => {
        try {
          return toolsFor(ctx)
        } catch {
          return null
        }
      },
      { names: TOOL_NAMES },
    )
  }

  return { register, beforePrompt, agentEnd, toolsFor, ready }
}
