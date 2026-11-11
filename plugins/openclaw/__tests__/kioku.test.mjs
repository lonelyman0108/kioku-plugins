import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createKioku, localRun, localTools, replyOf, TOOL_NAMES } from '../kioku.js'

const KEY = 'kioku_test_key'
const here = dirname(fileURLToPath(import.meta.url))
const TOOLS = [
  { name: 'kioku_search', description: '搜索记忆', inputSchema: { type: 'object' } },
  { name: 'kioku_get', description: '读一条记忆', inputSchema: { type: 'object' } },
  { name: 'kioku_future', description: '清单里没声明的', inputSchema: { type: 'object' } },
]

// 一个假的 Kioku：生命周期端点与 MCP 端点，记下收到的请求
let server
let base
let requests = []
let lifecycle
let mcp
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', async () => {
      const body = JSON.parse(raw)
      requests.push({ url: req.url, headers: req.headers, body })
      const {
        status = 200,
        body: out,
        wait,
      } = req.url === '/v1/mcp' ? mcp(body) : lifecycle(body.event)
      if (wait) await wait
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
let clock
beforeEach(() => {
  requests = []
  clock = 1_000_000
  lifecycle = (event) => ({
    body: {
      hostOutput:
        event === 'turn.end'
          ? { mode: 'none', value: null }
          : { mode: 'return_value', value: { context: `<${event}>` } },
    },
  })
  mcp = (body) =>
    body.method === 'tools/list'
      ? { body: { jsonrpc: '2.0', id: 1, result: { tools: TOOLS } } }
      : {
          body: {
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: `结果 ${body.params.name}` }] },
          },
        }
  dir = mkdtempSync(join(tmpdir(), 'kioku-openclaw-'))
  mkdirSync(join(dir, 'kioku'))
  env = { KIOKU_CONFIG_DIR: join(dir, 'kioku') }
  profile({ serverUrl: `${base}/`, apiKey: KEY })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function profile(value) {
  writeFileSync(join(dir, 'kioku', 'openclaw.json'), JSON.stringify(value))
}
const cacheFile = () => join(dir, 'kioku', 'openclaw-tools.json')

// 假的 OpenClaw：记下登记的钩子、工具工厂与日志
function start() {
  const handlers = {}
  const warnings = []
  const api = {
    logger: { warn: (text) => warnings.push(text) },
    registered: { memory: 0, factory: null, options: null },
    on: (name, handler) => (handlers[name] = handler),
    registerMemoryCapability: () => (api.registered.memory += 1),
    registerTool: (factory, options) => {
      api.registered.factory = factory
      api.registered.options = options
    },
  }
  const kioku = createKioku({ env, now: () => clock })
  kioku.register(api)
  return { api, kioku, warnings, emit: (name, event, ctx) => handlers[name](event, ctx) }
}
// 取工具清单不挡着别的：用例里等它落定
async function settled(kioku) {
  await kioku.ready()
  await new Promise((resolve) => setTimeout(resolve, 50))
}
// 本机一次性运行、经网关的命令行、外部渠道的上下文，都照实测到的样子写
const cli = (extra = {}) => ({
  runId: 'r1',
  sessionId: 's1',
  sessionKey: 'agent:main:main',
  trigger: 'user',
  ...extra,
})
const gateway = (extra = {}) =>
  cli({
    messageProvider: 'webchat',
    channel: 'webchat',
    channelId: 'webchat',
    chatId: 'webchat',
    senderId: undefined,
    ...extra,
  })
const telegram = (extra = {}) =>
  gateway({
    messageProvider: 'telegram',
    channel: 'telegram',
    channelId: '42',
    chatId: '42',
    senderId: '7',
    ...extra,
  })
const assistant = (text, stopReason = 'stop') => ({
  role: 'assistant',
  stopReason,
  content: [
    { type: 'thinking', thinking: '想' },
    { type: 'text', text },
  ],
})
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const events = () =>
  requests
    .filter((r) => r.url === '/v1/lifecycle/event')
    .map((r) => r.body.event)
    .sort()
const bodyOf = (event) => requests.find((r) => r.body.event === event)?.body

describe('只认本机入口', () => {
  it('本机运行与经网关的内部通道算；外部渠道、带发送者的、不是用户触发的、子 agent 与定时任务都不算', () => {
    expect(localRun(cli())).toBe(true)
    expect(localRun(gateway())).toBe(true)
    expect(localRun(gateway({ sessionKey: 'agent:main:openai-user:u1' }))).toBe(true)
    expect(localRun(telegram())).toBe(false)
    // 网关的 HTTP 接口可以自报通道，只有一项不是内部通道也不算
    for (const field of ['messageProvider', 'channel', 'channelId', 'chatId']) {
      expect(localRun(gateway({ [field]: 'telegram' }))).toBe(false)
    }
    expect(localRun(gateway({ senderId: '7' }))).toBe(false)
    expect(localRun(cli({ trigger: 'heartbeat' }))).toBe(false)
    expect(localRun(cli({ trigger: undefined }))).toBe(false)
    expect(localRun(cli({ sessionKey: 'agent:main:subagent:x' }))).toBe(false)
    expect(localRun(cli({ sessionKey: 'agent:main:cron:nightly' }))).toBe(false)
    expect(localRun(cli({ sessionKey: undefined }))).toBe(false)
    expect(localRun(undefined)).toBe(false)
  })

  it('工具按同一个规则给', () => {
    const ctx = { sessionKey: 'agent:main:main' }
    expect(localTools(ctx)).toBe(true)
    expect(
      localTools({ ...ctx, messageChannel: 'webchat', deliveryContext: { channel: 'webchat' } }),
    ).toBe(true)
    expect(localTools({ ...ctx, messageChannel: 'telegram' })).toBe(false)
    expect(localTools({ ...ctx, deliveryContext: { channel: 'telegram', to: '42' } })).toBe(false)
    expect(localTools({ ...ctx, requesterSenderId: '7' })).toBe(false)
    expect(localTools({ sessionKey: 'agent:main:subagent:x' })).toBe(false)
    expect(localTools({})).toBe(false)
    expect(localTools(undefined)).toBe(false)
  })
})

describe('OpenClaw 插件：注入与上报', () => {
  it('登记记忆能力、两个钩子与工具工厂；工具名和清单文件里声明的一致', () => {
    const { api } = start()
    expect(api.registered.memory).toBe(1)
    expect(api.registered.options).toEqual({ names: TOOL_NAMES })
    const manifest = JSON.parse(readFileSync(join(here, '..', 'openclaw.plugin.json'), 'utf8'))
    expect(manifest.contracts.tools).toEqual(TOOL_NAMES)
    expect(manifest.kind).toBe('memory')
  })

  it('第一轮：启动加载放系统提示前面，召回放输入前面；之后每一轮都带着记下的启动加载，只重新召回', async () => {
    const { emit } = start()
    const first = await emit('before_prompt_build', { prompt: ' 你好 ' }, cli())
    expect(first).toEqual({
      prependSystemContext: '<session.start>',
      prependContext: '<prompt.submit>',
    })
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    expect(bodyOf('prompt.submit')).toMatchObject({ sessionId: 's1', prompt: '你好' })
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    requests = []
    const second = await emit('before_prompt_build', { prompt: '再来' }, cli({ runId: 'r2' }))
    expect(second).toEqual({
      prependSystemContext: '<session.start>',
      prependContext: '<prompt.submit>',
    })
    expect(events()).toEqual(['prompt.submit'])
  })

  it('另一个会话各取各的启动加载；过了时限重新取', async () => {
    const { emit } = start()
    await emit('before_prompt_build', { prompt: '甲' }, cli())
    await emit('before_prompt_build', { prompt: '乙' }, cli({ sessionId: 's2', runId: 'r2' }))
    expect(events().filter((e) => e === 'session.start')).toHaveLength(2)
    requests = []
    clock += 61 * 60_000
    await emit('before_prompt_build', { prompt: '丙' }, cli({ runId: 'r3' }))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
  })

  it('外部渠道来的运行：不发请求、不注入、结束时不上报', async () => {
    const { emit, kioku } = start()
    await settled(kioku)
    requests = []
    expect(await emit('before_prompt_build', { prompt: '你好' }, telegram())).toBeUndefined()
    await emit(
      'agent_end',
      { success: true, messages: [user('你好'), assistant('好')] },
      telegram(),
    )
    expect(requests).toEqual([])
  })

  it('一轮结束：上报这一轮的输入与最后一条用户消息之后的回复', async () => {
    const { emit } = start()
    await emit('before_prompt_build', { prompt: '今天做什么' }, gateway())
    const messages = [
      user('上一轮'),
      assistant('上一轮的回复'),
      user('今天做什么'),
      assistant('先查一下'),
      { role: 'toolResult', content: [{ type: 'text', text: '工具结果' }] },
      assistant('写到一半', 'error'),
      assistant('做甲'),
    ]
    await emit('agent_end', { success: true, messages }, gateway())
    expect(bodyOf('turn.end')).toEqual({
      event: 'turn.end',
      sessionId: 's1',
      user: '今天做什么',
      reply: '先查一下\n做甲',
    })
    // 同一次运行不报第二遍
    requests = []
    await emit('agent_end', { success: true, messages }, gateway())
    expect(requests).toEqual([])
  })

  it('没成功的、没有回复的、没经过输入钩子的运行不上报', async () => {
    const { emit } = start()
    await emit('before_prompt_build', { prompt: '甲' }, cli())
    await emit('agent_end', { success: false, messages: [user('甲'), assistant('半句')] }, cli())
    await emit('before_prompt_build', { prompt: '乙' }, cli({ runId: 'r2' }))
    await emit('agent_end', { success: true, messages: [user('乙')] }, cli({ runId: 'r2' }))
    await emit(
      'agent_end',
      { success: true, messages: [user('丙'), assistant('好')] },
      cli({ runId: 'r9' }),
    )
    expect(events()).not.toContain('turn.end')
  })

  it('服务端出错：不挡这一轮，日志里说一次，一分钟之内不再发请求、照旧给记下的启动加载', async () => {
    const { emit, warnings } = start()
    await emit('before_prompt_build', { prompt: '甲' }, cli())
    lifecycle = () => ({ status: 500 })
    requests = []
    expect(await emit('before_prompt_build', { prompt: '乙' }, cli({ runId: 'r2' }))).toEqual({
      prependSystemContext: '<session.start>',
    })
    expect(events()).toEqual(['prompt.submit'])
    requests = []
    expect(await emit('before_prompt_build', { prompt: '丙' }, cli({ runId: 'r3' }))).toEqual({
      prependSystemContext: '<session.start>',
    })
    expect(events()).toEqual([])
    expect(warnings.filter((text) => text.includes('没有生效'))).toHaveLength(1)
    expect(warnings.join('\n')).not.toContain(KEY)
    clock += 61_000
    await emit('before_prompt_build', { prompt: '丁' }, cli({ runId: 'r4' }))
    expect(events()).toEqual(['prompt.submit'])
  })

  it('没有配置：不发请求，日志里说一次怎么配；中途配好了，过一分钟就认到', async () => {
    rmSync(join(dir, 'kioku', 'openclaw.json'))
    const { emit, warnings } = start()
    expect(await emit('before_prompt_build', { prompt: '甲' }, cli())).toBeUndefined()
    expect(await emit('before_prompt_build', { prompt: '乙' }, cli())).toBeUndefined()
    expect(requests).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('kioku setup openclaw')
    profile({ serverUrl: base, apiKey: KEY })
    clock += 61_000
    expect(await emit('before_prompt_build', { prompt: '丙' }, cli())).toMatchObject({
      prependContext: '<prompt.submit>',
    })
  })

  it('钩子里出了意料之外的错也不抛给 OpenClaw，日志里说一次', async () => {
    const { emit, warnings } = start()
    const broken = {
      get trigger() {
        throw new TypeError('boom')
      },
    }
    await expect(emit('before_prompt_build', { prompt: '甲' }, broken)).resolves.toBeUndefined()
    await expect(emit('before_prompt_build', { prompt: '乙' }, broken)).resolves.toBeUndefined()
    expect(warnings).toEqual(['Kioku 的插件出错了（TypeError），这一轮没有生效'])
  })
})

describe('OpenClaw 插件：工具', () => {
  it('取到清单后只给清单文件里声明过的工具，并留一份在本机；外部渠道的运行不给', async () => {
    const { api, kioku } = start()
    await settled(kioku)
    const tools = api.registered.factory({ sessionKey: 'agent:main:main' })
    expect(tools.map((tool) => tool.name)).toEqual(['kioku_search', 'kioku_get'])
    expect(tools[0]).toMatchObject({ description: '搜索记忆', parameters: { type: 'object' } })
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual({
      url: base,
      at: clock,
      tools: TOOLS,
    })
    expect(
      api.registered.factory({ sessionKey: 'agent:main:main', messageChannel: 'telegram' }),
    ).toBeNull()
  })

  it('本机留的清单在登记时当场可用，不等请求；取不到新的就沿用，别的地址留下的不用', async () => {
    mcp = () => ({ status: 500 })
    writeFileSync(cacheFile(), JSON.stringify({ url: base, tools: TOOLS.slice(0, 1) }))
    const first = start()
    expect(first.api.registered.factory({ sessionKey: 'agent:main:main' })).toHaveLength(1)
    await settled(first.kioku)
    expect(requests.map((r) => r.body.method)).toEqual(['tools/list'])
    expect(first.api.registered.factory({ sessionKey: 'agent:main:main' })).toHaveLength(1)

    writeFileSync(cacheFile(), JSON.stringify({ url: 'https://other.example.com', tools: TOOLS }))
    const second = start()
    await settled(second.kioku)
    expect(second.api.registered.factory({ sessionKey: 'agent:main:main' })).toBeNull()
  })

  it('本机那份清单还新时不重新取，过了时限到下一轮输入时才取', async () => {
    writeFileSync(
      cacheFile(),
      JSON.stringify({ url: base, at: clock - 60_000, tools: TOOLS.slice(0, 1) }),
    )
    const { api, kioku, emit } = start()
    await settled(kioku)
    expect(requests).toEqual([])
    expect(api.registered.factory({ sessionKey: 'agent:main:main' })).toHaveLength(1)
    clock += 61 * 60_000
    await emit('before_prompt_build', { prompt: '甲' }, cli())
    await settled(kioku)
    expect(requests.map((r) => r.body.method ?? r.body.event)).toContain('tools/list')
    expect(api.registered.factory({ sessionKey: 'agent:main:main' })).toHaveLength(2)
  })

  it('调用转给 Kioku 的 MCP 端点，结果的文字原样给模型；失败时给原因，不带访问密钥', async () => {
    const { api, kioku } = start()
    await settled(kioku)
    const [search] = api.registered.factory({ sessionKey: 'agent:main:main' })
    requests = []
    expect(await search.execute('call-1', { query: '部署' })).toEqual({
      content: [{ type: 'text', text: '结果 kioku_search' }],
    })
    expect(requests[0].body).toMatchObject({
      method: 'tools/call',
      params: { name: 'kioku_search', arguments: { query: '部署' } },
    })
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    mcp = () => ({ status: 401 })
    const failed = await search.execute('call-2', {})
    expect(failed.content[0].text).toContain('访问密钥无效或已吊销')
    expect(failed.content[0].text).not.toContain(KEY)
    mcp = () => ({
      body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: '参数\n不对' } },
    })
    expect((await search.execute('call-3', {})).content[0].text).toContain('参数 不对')
  })

  it('没有配置时没有工具，哪怕本机留着一份清单', async () => {
    rmSync(join(dir, 'kioku', 'openclaw.json'))
    writeFileSync(cacheFile(), JSON.stringify({ url: base, tools: TOOLS }))
    const { api, kioku } = start()
    await settled(kioku)
    expect(api.registered.factory({ sessionKey: 'agent:main:main' })).toBeNull()
    expect(requests).toEqual([])
  })
})

describe('replyOf', () => {
  it('没有用户消息时取全部助手文字；不是数组时为空', () => {
    expect(replyOf([assistant('甲'), assistant('乙')])).toBe('甲\n乙')
    expect(replyOf([user('问'), { role: 'assistant', content: '直接是字符串' }])).toBe(
      '直接是字符串',
    )
    expect(replyOf(null)).toBe('')
  })
})
