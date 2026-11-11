import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
async function start({ hasUI = true, sessionId = 's1' } = {}) {
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
    sessionManager: { getSessionId: () => sessionId },
  }
  await createKioku(pi, { env, log: (text) => logs.push(text) }).load()
  const emit = (name, event = {}) => handlers[name]?.(event, ctx)
  return { pi, emit, notices }
}
const user = (prompt) => ({ messageType: 'user', prompt })
const assistant = (...texts) => ({
  role: 'assistant',
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
      project: { dirName: dir.split('/').pop() },
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

  it('启动加载没取到时下一次输入再试；召回失败不影响这一轮结束时上报', async () => {
    const { emit } = await start()
    await emit('session_start')
    reply = (event) => (event === 'turn.end' ? contexts(event) : { status: 500 })
    expect(await emit('before_agent_start', user('问'))).toBeUndefined()
    expect(logs.join('\n')).toContain('HTTP 500')
    await emit('agent_end', { messages: [assistant('答')] })
    await emit('agent_settled', {})
    await emit('session_shutdown', {})
    expect(bodyOf('turn.end')).toMatchObject({ user: '问', reply: '答' })
    reply = contexts
    requests = []
    const retried = await emit('before_agent_start', user('再问'))
    expect(retried.message.content).toBe('<session.start>\n\n<prompt.submit>')
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

  it('配置写错（文件读不懂、访问密钥格式不对）：提示里不带访问密钥；没有界面时写到日志', async () => {
    profile({ serverUrl: base, apiKey: 'bad key' })
    const ui = await start()
    await ui.emit('session_start')
    expect(ui.notices[0][1]).toContain('格式不对')
    expect(ui.notices[0][1]).not.toContain('bad key')
    expect(ui.pi.servers).toEqual({})

    profile('{ 坏的')
    const headless = await start({ hasUI: false })
    await headless.emit('session_start')
    expect(headless.notices).toEqual([])
    expect(logs.join('\n')).toContain('kioku setup pi')
    expect(requests).toHaveLength(0)
  })

  it('服务地址返回跳转：不跟着走，下一次会话开始时提示改地址，不带访问密钥', async () => {
    const { emit, notices } = await start()
    await emit('session_start')
    expect(notices).toEqual([])
    reply = () => ({ status: 302, headers: { location: 'https://kioku.example.com/v1/x' } })
    expect(await emit('before_agent_start', user('问'))).toBeUndefined()
    await emit('session_start', { reason: 'new' })
    expect(notices[0][1]).toContain('https://kioku.example.com')
    expect(notices[0][1] + logs.join('\n')).not.toContain(KEY)
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
