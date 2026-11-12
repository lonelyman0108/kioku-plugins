import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createKioku } from '../index.js'

const KEY = 'kioku_test_key'

// 一个假的 Kioku：记下收到的请求，按 reply 返回
let server
let base
let requests = []
let reply
const contexts = (event) => ({
  status: 200,
  body: {
    hostOutput:
      event === 'turn.end'
        ? { mode: 'none', value: null }
        : { mode: 'return_value', value: { context: `<${event}>` } },
  },
})
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', async () => {
      const body = JSON.parse(raw)
      requests.push({ url: req.url, headers: req.headers, body })
      const { status, body: out, headers = {}, wait } = reply(body.event)
      if (wait) await wait
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(out ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
let logs
beforeEach(() => {
  requests = []
  reply = contexts
  logs = []
  clock = 1_000_000
  dir = mkdtempSync(join(tmpdir(), 'kioku-pi-'))
  mkdirSync(join(dir, 'kioku'))
  env = { KIOKU_CONFIG_DIR: join(dir, 'kioku') }
  profile({ serverUrl: `${base}/`, apiKey: KEY })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function profile(value) {
  writeFileSync(
    join(dir, 'kioku', 'pi.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}

// 假的 pi：记下注册的处理函数与 MCP 服务，emit 像 pi 那样调它们
let clock
async function start({ hasUI = true, sessionId = 's1', signal } = {}) {
  const handlers = {}
  const pi = {
    servers: {},
    on: (name, handler) => (handlers[name] = handler),
    registerMcpServer: (name, config) => (pi.servers[name] = config),
  }
  const notices = []
  const ctx = {
    hasUI,
    cwd: dir,
    ui: { notify: (text, level) => notices.push([level, text]) },
    signal,
    sessionManager: { getSessionId: () => sessionId },
  }
  await createKioku(pi, { env, stderr: (text) => logs.push(text), now: () => clock }).load()
  const emit = (name, event = {}) => handlers[name]?.(event, ctx)
  return { pi, emit, notices }
}
const user = (prompt) => ({ messageType: 'user', prompt })
const assistant = (...texts) => ({
  role: 'assistant',
  stopReason: 'stop',
  content: [
    { type: 'thinking', thinking: '想' },
    ...texts.map((text) => ({ type: 'text', text })),
    { type: 'toolCall', name: 'bash' },
  ],
})
const events = () => requests.map((r) => r.body.event).sort()
const bodyOf = (event) => requests.find((r) => r.body.event === event)?.body

describe('pi 扩展', () => {
  it('加载时注册 Kioku 的 MCP 服务，带访问密钥', async () => {
    const { pi } = await start()
    expect(pi.servers.kioku).toMatchObject({
      url: `${base}/v1/mcp`,
      headers: { Authorization: `Bearer ${KEY}` },
    })
  })

  it('会话开始后的第一次输入：启动加载与召回一起注入，只交上下文文本；之后的输入只召回', async () => {
    const { emit } = await start()
    await emit('session_start', { reason: 'startup' })
    expect(requests).toHaveLength(0)
    const first = await emit('before_agent_start', user('  第一问  '))
    expect(first).toEqual({
      message: {
        customType: 'kioku',
        content: '<session.start>\n\n<prompt.submit>',
        display: false,
      },
    })
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(bodyOf('session.start')).toEqual({
      event: 'session.start',
      sessionId: 's1',
      project: { dirName: basename(dir) },
    })
    expect(bodyOf('prompt.submit')).toEqual({
      event: 'prompt.submit',
      sessionId: 's1',
      prompt: '第一问',
    })

    requests = []
    const second = await emit('before_agent_start', user('第二问'))
    expect(second.message.content).toBe('<prompt.submit>')
    expect(events()).toEqual(['prompt.submit'])
  })

  it('压缩之后的下一次输入再注入一次启动加载', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('问'))
    await emit('session_compact', { reason: 'threshold' })
    requests = []
    await emit('before_agent_start', user('问'))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
  })

  it('一轮结束：几段运行的回复文字攒起来，pi 不再接着跑时上报一次', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('问'))
    requests = []
    await emit('agent_end', { messages: [{ role: 'user', content: '问' }, assistant('第一段')] })
    expect(requests).toHaveLength(0)
    await emit('agent_end', { messages: [assistant('第二段', '第三段')] })
    await emit('agent_settled', { aborted: false })
    await emit('session_shutdown', { reason: 'quit' })
    expect(requests.map((r) => r.body)).toEqual([
      { event: 'turn.end', sessionId: 's1', user: '问', reply: '第一段\n第二段\n第三段' },
    ])
    // 没有新的输入时再结束一次不重复上报
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(requests).toHaveLength(1)
  })

  it('会话关闭时等还没发完的上报', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('问'))
    let release
    const gate = new Promise((resolve) => (release = resolve))
    reply = (event) => ({ ...contexts(event), wait: gate })
    await emit('agent_end', { messages: [assistant('答')] })
    // 上报不拖住 pi：agent_settled 立刻返回
    await emit('agent_settled', {})
    let closed = false
    const closing = emit('session_shutdown', {}).then(() => (closed = true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(false)
    release()
    await closing
    expect(closed).toBe(true)
  })

  it('扩展自己发消息开始的运行、空的输入不召回也不上报', async () => {
    const { emit } = await start()
    await emit('session_start')
    expect(await emit('before_agent_start', { messageType: 'custom', message: {} })).toBeUndefined()
    expect(requests).toHaveLength(0)
    // 空输入：启动加载照常注入，不召回，这一轮不上报
    const blank = await emit('before_agent_start', user('   '))
    expect(blank.message.content).toBe('<session.start>')
    await emit('agent_end', { messages: [assistant('答')] })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(events()).toEqual(['session.start'])
  })

  it('请求失败：有界面时只提示一次、不写标准错误，一分钟内的输入不再等；之后再试，启动加载补上', async () => {
    const { emit, notices } = await start()
    await emit('session_start')
    reply = (event) => (event === 'turn.end' ? contexts(event) : { status: 500 })
    expect(await emit('before_agent_start', user('问'))).toBeUndefined()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toEqual(['info', expect.stringContaining('HTTP 500')])
    expect(logs).toEqual([])
    // 召回失败不影响这一轮结束时上报
    await emit('agent_end', { messages: [assistant('答')] })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(bodyOf('turn.end')).toMatchObject({ user: '问', reply: '答' })

    // 一分钟内：不发请求，直接放行
    reply = contexts
    requests = []
    clock += 59_000
    expect(await emit('before_agent_start', user('再问'))).toBeUndefined()
    expect(requests).toHaveLength(0)
    // 这一轮照样上报
    await emit('agent_end', { messages: [assistant('再答')] })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(events()).toEqual(['turn.end'])

    // 过了一分钟：再试，启动加载补上
    requests = []
    clock += 2_000
    const retried = await emit('before_agent_start', user('三问'))
    expect(retried.message.content).toBe('<session.start>\n\n<prompt.submit>')
    // 同一个原因不提示第二遍
    reply = () => ({ status: 500 })
    await emit('before_agent_start', user('四问'))
    expect(notices).toHaveLength(1)
  })

  it('没有界面时失败原因写到标准错误', async () => {
    const { emit } = await start({ hasUI: false })
    await emit('session_start')
    reply = () => ({ status: 500 })
    await emit('before_agent_start', user('问'))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('HTTP 500')
  })

  it('用户取消这次输入时请求跟着取消，不算失败、不提示、不进入等待期', async () => {
    const controller = new AbortController()
    const { emit, notices } = await start({ signal: controller.signal })
    await emit('session_start')
    // 启动加载与召回两个请求都到了服务端、还在等回答时取消
    let arrived
    const received = new Promise((resolve) => (arrived = resolve))
    let release
    const held = new Promise((resolve) => (release = resolve))
    reply = (event) => {
      if (requests.length === 2) arrived()
      return { ...contexts(event), wait: held }
    }
    const waiting = emit('before_agent_start', user('问'))
    await received
    controller.abort()
    expect(await waiting).toBeUndefined()
    release()
    expect(notices).toEqual([])
    // 下一次输入照常发请求
    reply = contexts
    requests = []
    const fresh = await start()
    await fresh.emit('session_start')
    expect((await fresh.emit('before_agent_start', user('问'))).message.content).toContain(
      '<prompt.submit>',
    )
  })

  it('运行中排进来的输入一起上报：用户消息从各段运行里取', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('第一问'))
    await emit('agent_end', {
      messages: [{ role: 'user', content: '第一问' }, assistant('答一')],
    })
    await emit('agent_end', {
      messages: [{ role: 'user', content: [{ type: 'text', text: '第二问' }] }, assistant('答二')],
    })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(bodyOf('turn.end')).toMatchObject({ user: '第一问\n第二问', reply: '答一\n答二' })
  })

  it('被中止的、没有回复的一轮不上报；出错、被中止的那段文字不算回复', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('问'))
    await emit('agent_end', { messages: [assistant('半截')] })
    await emit('agent_settled', { aborted: true })
    await emit('before_agent_start', user('问'))
    await emit('agent_settled', {})
    await emit('before_agent_start', user('问'))
    await emit('agent_end', { messages: [{ ...assistant('出错前的半句'), stopReason: 'error' }] })
    await emit('agent_end', {
      messages: [{ ...assistant('被打断'), stopReason: 'aborted' }, assistant('完整的回答')],
    })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(requests.filter((r) => r.body.event === 'turn.end').map((r) => r.body.reply)).toEqual([
      '完整的回答',
    ])
  })

  it('上一轮没等到结束时，扩展发起的运行不接到它头上', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('旧的输入'))
    // 没有 agent_settled，接着是别的扩展发起的运行
    await emit('before_agent_start', { messageType: 'custom', message: {} })
    await emit('agent_end', { messages: [assistant('给扩展的回答')] })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(bodyOf('turn.end')).toBeUndefined()
  })

  it('服务端没有要注入的内容时不加消息', async () => {
    const { emit } = await start()
    await emit('session_start')
    reply = () => ({ status: 200, body: { hostOutput: { mode: 'none', value: null } } })
    expect(await emit('before_agent_start', user('问'))).toBeUndefined()
    // 空的启动加载也算取到了，不再重取
    requests = []
    await emit('before_agent_start', user('问'))
    expect(events()).toEqual(['prompt.submit'])
  })

  it('没有配置：不注册 MCP、不发请求，会话开始提示一次怎么配', async () => {
    rmSync(join(dir, 'kioku', 'pi.json'))
    const { pi, emit, notices } = await start()
    expect(pi.servers).toEqual({})
    await emit('session_start')
    expect(notices).toHaveLength(1)
    expect(notices[0][0]).toBe('warning')
    expect(notices[0][1]).toContain('kioku setup pi')
    expect(await emit('before_agent_start', user('问'))).toBeUndefined()
    await emit('agent_settled', {})
    expect(requests).toHaveLength(0)
  })

  it('配置写错（文件读不懂、访问密钥格式不对）：提示里不带访问密钥；没有界面时写到标准错误', async () => {
    profile({ serverUrl: base, apiKey: 'bad key' })
    const ui = await start()
    await ui.emit('session_start')
    expect(ui.notices[0][1]).toContain('格式不对')
    expect(ui.notices[0][1]).not.toContain('bad key')
    expect(ui.pi.servers).toEqual({})
    expect(logs).toEqual([])

    profile('{ 坏的')
    const headless = await start({ hasUI: false })
    await headless.emit('session_start')
    expect(headless.notices).toEqual([])
    expect(logs.join('\n')).toContain('kioku setup pi')
    expect(requests).toHaveLength(0)
  })

  it('服务地址返回跳转：不跟着走，当场提示改地址，不带访问密钥', async () => {
    const { emit, notices } = await start()
    await emit('session_start')
    expect(notices).toEqual([])
    reply = () => ({ status: 302, headers: { location: 'https://kioku.example.com/v1/x' } })
    expect(await emit('before_agent_start', user('问'))).toBeUndefined()
    expect(notices).toHaveLength(1)
    expect(notices[0][0]).toBe('warning')
    expect(notices[0][1]).toContain('https://kioku.example.com')
    expect(notices[0][1]).toContain('kioku setup pi')
    expect(notices[0][1] + logs.join('\n')).not.toContain(KEY)
  })

  it('MCP 服务注册不上时照常召回与上报，会话开始时提示', async () => {
    const handlers = {}
    const pi = {
      on: (name, handler) => (handlers[name] = handler),
      registerMcpServer: () => {
        throw new Error(`名字被占用 ${KEY}`)
      },
    }
    const notices = []
    const ctx = {
      hasUI: true,
      cwd: dir,
      ui: { notify: (text) => notices.push(text) },
      sessionManager: { getSessionId: () => 's1' },
    }
    await createKioku(pi, { env, now: () => clock }).load()
    await handlers.session_start({}, ctx)
    expect(notices.join('')).toContain('MCP 服务没有注册上')
    expect(notices.join('')).not.toContain(KEY)
    const first = await handlers.before_agent_start(user('问'), ctx)
    expect(first.message.content).toContain('<prompt.submit>')
  })

  it('过长的输入与回复按上限截断；没有会话标识时不上报', async () => {
    const { emit } = await start()
    await emit('session_start')
    await emit('before_agent_start', user('问'.repeat(20_001)))
    await emit('agent_end', { messages: [assistant('答'.repeat(20_001))] })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(bodyOf('prompt.submit').prompt).toHaveLength(20_000)
    expect(bodyOf('turn.end').user).toHaveLength(20_000)
    expect(bodyOf('turn.end').reply).toHaveLength(20_000)

    requests = []
    const anonymous = await start({ sessionId: null })
    await anonymous.emit('session_start')
    await anonymous.emit('before_agent_start', user('问'))
    await anonymous.emit('agent_end', { messages: [assistant('答')] })
    await anonymous.emit('agent_settled', {})
    await anonymous.emit('session_shutdown', {})
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    expect(bodyOf('prompt.submit')).toEqual({ event: 'prompt.submit', prompt: '问' })
  })
})
