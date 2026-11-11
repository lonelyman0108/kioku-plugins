// DeepSeek Harness 的插件：把会话开始、每轮输入、每轮结束转发给 Kioku 的生命周期端点。
// 插件里不放提示词和格式逻辑，都由服务端决定。Kioku 的工具由同一个补丁里的 MCP 客户端提供，不在这里。
// 任何失败都不挡输入、不往对话里写错误：记忆服务出问题不能打断会话，原因只在日志里说一次。
// 钩子里抛出去的错会让这一轮整个失败，所以每个入口都自己接住。
// 服务地址与访问密钥来自 kioku setup dsh 写下的文件

import { randomUUID } from 'node:crypto'

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

const PLATFORM = 'dsh'
const SETUP_HINT =
  '运行 kioku setup dsh 配置（没有 kioku 命令时用 npx @kioku-memory/cli setup dsh）'
// 注入的消息的来源：会话里靠它认出哪些是这个插件放进去的。不能叫 plugin，会话格式不收
export const SOURCE = 'kioku'
// 请求失败之后这么久之内，输入前不再发请求：服务端挂住时不让每次输入都等满时限
const BACKOFF = 60_000
// 隔这么久重读一次配置文件：程序一直开着，中途配好了、换了访问密钥不用重启也认得到
const PROFILE_RETRY = 60_000
// 记着的会话个数上限
const MAX_TRACKED = 200

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')

const fromUser = (message) => message?.role === 'user' && message.source?.kind === 'user'

// 会话的 id；子 agent 的会话（有上一级会话的）不管：它的输入是模型写的，回复也不是给用户的
function sessionOf(agent) {
  const header = agent?.session?.header
  if (!header || header.parentSession) return undefined
  return typeof header.id === 'string' && header.id ? header.id.slice(0, MAX_SESSION_ID) : undefined
}

// 这一轮说了什么：{ user, reply }。从这一轮开始的那条记录到下一轮开始之前，用户说的与助手说的文字各连成一段
export function turnOf(events, turn) {
  const list = Array.isArray(events) ? events : []
  const start = list.findLastIndex(
    (event) => event?.type === 'turn/start' && event.data?.turn === turn,
  )
  const users = []
  const replies = []
  for (const event of start === -1 ? [] : list.slice(start + 1)) {
    // 到下一轮开始为止
    if (event?.type === 'turn/start') break
    if (event?.type === 'user/message' && fromUser(event.data)) {
      users.push(textOf(event.data.content))
    } else if (event?.type === 'assistant/message') {
      replies.push(textOf(event.data?.message?.content))
    }
  }
  const join = (parts) => parts.filter(Boolean).join('\n').trim()
  return { user: join(users), reply: join(replies) }
}

// 会话里有没有这个插件放进去的启动加载
function hasBoot(events) {
  return (Array.isArray(events) ? events : []).some(
    (event) =>
      event?.type === 'user/message' &&
      event.data?.source?.kind === SOURCE &&
      event.data.source.part === 'boot',
  )
}

// env、now、warn 与 uuid 可以换掉，给用例用
export function createKioku({
  env = process.env,
  now = Date.now,
  warn = () => {},
  uuid = randomUUID,
} = {}) {
  // 地址与访问密钥；problem 是配置用不了的原因
  let profile = null
  let problem = null
  let loading = null
  let retryAt = 0
  // 已经说过的问题，同一个不说第二遍
  const told = new Set()
  // 这个时刻之前，输入前不发请求
  let quietUntil = 0
  // 启动加载还没注入的会话：新开、清空、压缩之后各注入一次，放在下一次输入的后面
  const bootPending = new Set()
  // 项目的目录名与仓库名，按目录记着
  const projects = new Map()

  function tell(text) {
    if (told.has(text)) return
    told.add(text)
    try {
      warn(text)
    } catch {
      // 日志写不出来也不影响会话
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
    const before = profile
    try {
      profile = await readProfile(PLATFORM, env)
      problem = null
    } catch (err) {
      profile = null
      problem = err instanceof KiokuFailure ? err.message : failureText(err)
    }
    // 换了地址或访问密钥：之前的失败不算数了
    if (before && (before.url !== profile?.url || before.key !== profile?.key)) {
      quietUntil = 0
      told.clear()
    }
    retryAt = now() + PROFILE_RETRY
  }

  function ready() {
    if (!loading || now() >= retryAt) loading = load()
    return loading
  }

  function projectFor(cwd) {
    if (!projects.has(cwd)) {
      if (projects.size >= MAX_TRACKED) projects.clear()
      projects.set(cwd, projectOfAsync(cwd))
    }
    return projects.get(cwd)
  }

  // 把一个事件交给服务端，返回要注入的文本（没有时为空字符串）；失败时说一次原因，返回 undefined
  async function forward(event, body, signal) {
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
      // 上报失败不拦之后的召回：它不在输入前等着
      if (event !== 'turn.end') quietUntil = now() + BACKOFF
      if (err instanceof Misconfigured) tell(`Kioku 这次没有生效：${err.message}。${SETUP_HINT}`)
      else tell(`Kioku 这次没有生效（${failureText(err)}），稍后的输入会再试`)
      return undefined
    }
  }

  const message = (text, part) => ({
    role: 'user',
    id: uuid(),
    content: [{ type: 'text', text }],
    source: { kind: SOURCE, part },
  })

  // 一个会话开始了：新开的、清空的、压缩之后的都要注入启动加载；接着之前的会话时，
  // 会话里已经有过就不再注入（每次恢复都注入的话会越攒越多）
  function created({ agent, source } = {}) {
    try {
      const id = sessionOf(agent)
      if (!id) return
      if (source === 'resume' && hasBoot(agent.session.snapshotEvents?.())) return
      if (bootPending.size >= MAX_TRACKED) bootPending.clear()
      bootPending.add(id)
    } catch {
      // 认不出来就当没有这个会话
    }
  }

  // 这一步要用的上下文消息：启动加载（还没注入时）与召回。取不到时为空
  async function contextFor({ agent, messages, signal }) {
    const id = sessionOf(agent)
    const prompt = textOf(messages.filter(fromUser).flatMap((item) => item.content)).trim()
    if (!id || !prompt) return []
    await ready()
    if (!profile || problem) {
      tell(configNotice())
      return []
    }
    // 刚失败过：这次不等，直接让输入过去
    if (now() < quietUntil) return []
    const wantBoot = bootPending.has(id)
    const cwd = agent.session.header.cwd
    const session = { sessionId: id }
    // 两个请求一起发：都在这一步开始之前等着
    const [boot, recall] = await Promise.all([
      wantBoot
        ? (typeof cwd === 'string' && cwd ? projectFor(cwd) : Promise.resolve({})).then((project) =>
            forward(
              'session.start',
              { ...session, ...(Object.keys(project).length ? { project } : {}) },
              signal,
            ),
          )
        : undefined,
      forward('prompt.submit', { ...session, prompt: clip(prompt, MAX_PROMPT) }, signal),
    ])
    // 启动加载没取到时之后的输入再试；取到了（哪怕是空的）就不再取
    if (wantBoot && boot !== undefined) bootPending.delete(id)
    const out = []
    if (boot) out.push(message(boot, 'boot'))
    if (recall) out.push(message(recall, 'recall'))
    return out
  }

  // 一步开始之前：有用户的输入时，把启动加载与召回接在这一步的消息后面。只加消息，不改、不拦用户的输入
  async function preStep(payload, next) {
    // 自己的请求和后面的插件一起跑；自己这边出什么错都不影响它们的结果
    const ours = Promise.resolve()
      .then(() => contextFor(payload))
      .catch((err) => {
        tell(`Kioku 的插件出错了（${failureText(err)}），这一轮没有生效`)
        return []
      })
    const decision = await next()
    const extra = await ours
    if (!extra.length || decision?.kind !== 'enter') return decision
    return { ...decision, messages: [...decision.messages, ...extra] }
  }

  // 一轮要结束了：把这一轮交给服务端写会话摘要。等它发完（有时限）：一次性的运行里进程接着就退出了。
  // 没有回复的一轮不报：没有可以写进摘要的内容
  async function turnStopping({ agent, turn, signal } = {}) {
    try {
      const id = sessionOf(agent)
      if (!id) return
      await ready()
      if (!profile || problem) return
      const { user, reply } = turnOf(agent.session.snapshotEvents(), turn)
      if (!user || !reply) return
      await forward(
        'turn.end',
        { sessionId: id, user: clip(user, MAX_PROMPT), reply: clip(reply, MAX_REPLY) },
        signal,
      )
    } catch (err) {
      tell(`Kioku 的插件出错了（${failureText(err)}），这一轮没有上报`)
    }
  }

  return { created, preStep, turnStopping }
}
