import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { apply, name } from '../index.js'
import { createKioku, SOURCE, turnOf } from '../kioku.js'

const KEY = 'kioku_test_key'

// 一个假的 Kioku：记下收到的请求，按 reply 返回
let server
let base
let requests = []
let reply
const contexts = (event) => ({
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
      const { status = 200, body: out, headers = {}, wait } = reply(body.event)
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
let clock
let warnings
beforeEach(() => {
  requests = []
  reply = contexts
  warnings = []
  clock = 1_000_000
  dir = mkdtempSync(join(tmpdir(), 'kioku-dsh-'))
  mkdirSync(join(dir, 'kioku'))
  env = { KIOKU_CONFIG_DIR: join(dir, 'kioku') }
  profile({ serverUrl: `${base}/`, apiKey: KEY })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function profile(value) {
  writeFileSync(join(dir, 'kioku', 'dsh.json'), JSON.stringify(value))
}
let ids
function start() {
  ids = 0
  return createKioku({
    env,
    now: () => clock,
    warn: (text) => warnings.push(text),
    uuid: () => `id-${++ids}`,
  })
}
// 照实测到的样子写：会话头、消息与会话记录
const userMessage = (text, kind = 'user') => ({
  role: 'user',
  id: 'm',
  content: [{ type: 'text', text }],
  source: { kind },
})
function agentOf({ id = 'session-1', events = [], header = {}, cwd = undefined } = {}) {
  return {
    session: {
      header: { version: 4, id, cwd, ...header },
      snapshotEvents: () => events,
    },
  }
}
const enter = (messages) => async () => ({ kind: 'enter', messages })
const step = (agent, messages, extra = {}) => ({ agent, messages, turn: 1, step: 1, ...extra })
const events = () => requests.map((r) => r.body.event).sort()
const bodyOf = (event) => requests.find((r) => r.body.event === event)?.body
const record = (type, data) => ({ type, data })
const assistant = (turn, ...content) =>
  record('assistant/message', { turn, step: 1, message: { role: 'assistant', content } })
const text = (value) => ({ type: 'text', text: value })

describe('DeepSeek Harness 插件：输入前', () => {
  it('新会话的第一次输入：启动加载与召回接在这一步的消息后面，来源是 kioku；之后的输入只召回', async () => {
    const kioku = start()
    const agent = agentOf()
    kioku.created({ agent, source: 'startup' })
    const input = [userMessage(' 你好 '), userMessage('运行时的说明', 'runtime-context')]
    const first = await kioku.preStep(step(agent, input), enter(input))
    expect(first.kind).toBe('enter')
    expect(first.messages.slice(0, 2)).toEqual(input)
    expect(first.messages.slice(2)).toEqual([
      {
        role: 'user',
        id: 'id-1',
        content: [text('<session.start>')],
        source: { kind: SOURCE, part: 'boot' },
      },
      {
        role: 'user',
        id: 'id-2',
        content: [text('<prompt.submit>')],
        source: { kind: SOURCE, part: 'recall' },
      },
    ])
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    // 只把用户说的当输入，别的插件加的消息不算
    expect(bodyOf('prompt.submit')).toMatchObject({ sessionId: 'session-1', prompt: '你好' })
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    requests = []
    const second = await kioku.preStep(step(agent, [userMessage('再来')]), enter([]))
    expect(second.messages.map((m) => m.source.part)).toEqual(['recall'])
    expect(events()).toEqual(['prompt.submit'])
  })

  it('后面的插件带回来的别的字段原样留着；它拒绝这一步时不加东西', async () => {
    const kioku = start()
    const agent = agentOf()
    const input = [userMessage('甲')]
    const kept = await kioku.preStep(step(agent, input), async () => ({
      kind: 'enter',
      messages: input,
      startsRequestSeries: true,
    }))
    expect(kept.startsRequestSeries).toBe(true)
    expect(await kioku.preStep(step(agent, input), async () => ({ kind: 'reject' }))).toEqual({
      kind: 'reject',
    })
  })

  it('这一步没有用户的输入（工具结果之后接着跑）时不发请求', async () => {
    const kioku = start()
    const agent = agentOf()
    kioku.created({ agent, source: 'startup' })
    const decision = await kioku.preStep(step(agent, []), enter([]))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    const steer = [userMessage('别的插件的话', 'other-plugin')]
    expect((await kioku.preStep(step(agent, steer), enter(steer))).messages).toEqual(steer)
    expect(requests).toEqual([])
  })

  it('接着之前的会话：会话里已经有启动加载就不再注入，没有才注入；压缩之后再注入一次', async () => {
    const kioku = start()
    const had = agentOf({
      id: 'session-old',
      events: [
        record('user/message', {
          ...userMessage('旧的启动加载', SOURCE),
          source: { kind: SOURCE, part: 'boot' },
        }),
      ],
    })
    kioku.created({ agent: had, source: 'resume' })
    await kioku.preStep(step(had, [userMessage('甲')]), enter([]))
    expect(events()).toEqual(['prompt.submit'])
    requests = []
    const never = agentOf({
      id: 'session-new',
      events: [record('user/message', userMessage('旧输入'))],
    })
    kioku.created({ agent: never, source: 'resume' })
    await kioku.preStep(step(never, [userMessage('乙')]), enter([]))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    requests = []
    kioku.created({ agent: had, source: 'compact' })
    await kioku.preStep(step(had, [userMessage('丙')]), enter([]))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
  })

  it('子 agent 的会话不管；用户自己分出来的会话（只带着上一级会话的 id）照常', async () => {
    const kioku = start()
    for (const header of [
      { origin: 'subagent', parentSession: 'session-1' },
      { delegationDepth: 1 },
    ]) {
      const sub = agentOf({ id: 'session-sub', header })
      kioku.created({ agent: sub, source: 'startup' })
      const input = [userMessage('子任务')]
      expect((await kioku.preStep(step(sub, input), enter(input))).messages).toEqual(input)
      await kioku.turnStopping({ agent: sub, turn: 1 })
    }
    expect(requests).toEqual([])
    const fork = agentOf({ id: 'session-fork', header: { parentSession: 'session-1' } })
    kioku.created({ agent: fork, source: 'startup' })
    await kioku.preStep(step(fork, [userMessage('甲')]), enter([]))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
  })

  it('取到了启动加载、这一步却没进去（被拒绝、结果认不出来）：不算注入过，下一次输入再给', async () => {
    const kioku = start()
    const agent = agentOf()
    kioku.created({ agent, source: 'startup' })
    const input = [userMessage('甲')]
    expect(await kioku.preStep(step(agent, input), async () => ({ kind: 'reject' }))).toEqual({
      kind: 'reject',
    })
    // 后面的插件给了一个没有消息列表的结果：原样交回去，不抛错
    expect(await kioku.preStep(step(agent, input), async () => ({ kind: 'enter' }))).toEqual({
      kind: 'enter',
    })
    const entered = await kioku.preStep(step(agent, input), enter(input))
    expect(entered.messages.map((m) => m.source.part ?? m.source.kind)).toEqual([
      'user',
      'boot',
      'recall',
    ])
    expect(events().filter((e) => e === 'session.start')).toHaveLength(3)
  })

  it('接着之前的会话：压缩之前注入的启动加载不算，要再注入', async () => {
    const kioku = start()
    const boot = record('user/message', {
      ...userMessage('旧的'),
      source: { kind: SOURCE, part: 'boot' },
    })
    const compacted = agentOf({ events: [boot, record('compaction/end', {})] })
    kioku.created({ agent: compacted, source: 'resume' })
    await kioku.preStep(step(compacted, [userMessage('甲')]), enter([]))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    requests = []
    const after = agentOf({ id: 'session-2', events: [record('compaction/end', {}), boot] })
    kioku.created({ agent: after, source: 'resume' })
    await kioku.preStep(step(after, [userMessage('乙')]), enter([]))
    expect(events()).toEqual(['prompt.submit'])
  })

  it('等着启动加载的会话太多时丢掉最早的，刚开的还在', async () => {
    const kioku = start()
    for (let n = 0; n <= 200; n++) {
      kioku.created({ agent: agentOf({ id: `session-${n}` }), source: 'startup' })
    }
    await kioku.preStep(step(agentOf({ id: 'session-200' }), [userMessage('甲')]), enter([]))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
    requests = []
    await kioku.preStep(step(agentOf({ id: 'session-0' }), [userMessage('乙')]), enter([]))
    expect(events()).toEqual(['prompt.submit'])
    // 只丢最早的那一个，别的都还等着
    requests = []
    await kioku.preStep(step(agentOf({ id: 'session-1' }), [userMessage('丙')]), enter([]))
    expect(events()).toEqual(['prompt.submit', 'session.start'])
  })

  it('启动加载带上项目的目录名', async () => {
    const kioku = start()
    const agent = agentOf({ cwd: dir })
    kioku.created({ agent, source: 'startup' })
    await kioku.preStep(step(agent, [userMessage('甲')]), enter([]))
    expect(bodyOf('session.start').project).toMatchObject({ dirName: basename(dir) })
  })

  it('服务端出错：输入照常过去，日志里说一次，一分钟之内不再发请求；启动加载留到之后再取', async () => {
    const kioku = start()
    const agent = agentOf()
    kioku.created({ agent, source: 'startup' })
    reply = () => ({ status: 500 })
    const input = [userMessage('甲')]
    expect(await kioku.preStep(step(agent, input), enter(input))).toEqual({
      kind: 'enter',
      messages: input,
    })
    requests = []
    await kioku.preStep(step(agent, input), enter(input))
    expect(requests).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('HTTP 500')
    expect(warnings[0]).not.toContain(KEY)
    reply = contexts
    clock += 61_000
    const later = await kioku.preStep(step(agent, input), enter(input))
    expect(later.messages.map((m) => m.source.part ?? m.source.kind)).toEqual([
      'user',
      'boot',
      'recall',
    ])
  })

  it('用户取消了这次输入：不算失败，之后照常', async () => {
    const kioku = start()
    const agent = agentOf()
    const controller = new AbortController()
    let release
    reply = () => ({ ...contexts('prompt.submit'), wait: new Promise((r) => (release = r)) })
    const input = [userMessage('甲')]
    const pending = kioku.preStep(step(agent, input, { signal: controller.signal }), enter(input))
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    expect((await pending).messages).toEqual(input)
    release()
    expect(warnings).toEqual([])
    reply = contexts
    expect((await kioku.preStep(step(agent, input), enter(input))).messages).toHaveLength(2)
  })

  it('没有配置：不发请求，说一次怎么配；中途配好了，过一分钟就认到。换了访问密钥也一样', async () => {
    rmSync(join(dir, 'kioku', 'dsh.json'))
    const kioku = start()
    const agent = agentOf()
    const input = [userMessage('甲')]
    expect((await kioku.preStep(step(agent, input), enter(input))).messages).toEqual(input)
    await kioku.preStep(step(agent, input), enter(input))
    expect(requests).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('kioku setup dsh')
    profile({ serverUrl: base, apiKey: KEY })
    clock += 61_000
    expect((await kioku.preStep(step(agent, input), enter(input))).messages).toHaveLength(2)
    profile({ serverUrl: base, apiKey: 'kioku_new_key' })
    clock += 61_000
    requests = []
    await kioku.preStep(step(agent, input), enter(input))
    expect(requests[0].headers.authorization).toBe('Bearer kioku_new_key')
  })

  it('自己这边出了意料之外的错：后面的插件的结果照样交回去，不往外抛', async () => {
    const kioku = start()
    const broken = {
      get session() {
        throw new TypeError('boom')
      },
    }
    const input = [userMessage('甲')]
    await expect(kioku.preStep(step(broken, input), enter(input))).resolves.toEqual({
      kind: 'enter',
      messages: input,
    })
    expect(warnings).toEqual(['Kioku 的插件出错了（TypeError），这一轮没有生效'])
    expect(() => kioku.created({ agent: broken, source: 'startup' })).not.toThrow()
    await expect(kioku.turnStopping({ agent: broken, turn: 1 })).resolves.toBeUndefined()
  })
})

describe('DeepSeek Harness 插件：一轮结束', () => {
  const history = [
    record('turn/start', { turn: 1 }),
    record('user/message', userMessage('上一轮')),
    assistant(1, text('上一轮的回复')),
    record('turn/start', { turn: 2 }),
    record('system/message', { turn: 2, message: { role: 'system', content: [text('系统提示')] } }),
    record('user/message', userMessage('今天做什么')),
    record('user/message', userMessage('运行时的说明', 'runtime-context')),
    record('user/message', { ...userMessage('召回'), source: { kind: SOURCE, part: 'recall' } }),
    assistant(2, { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }),
    record('tool/result', { content: [text('工具结果')] }),
    assistant(2, text('先看了一下')),
    record('user/message', userMessage('顺便做乙')),
    assistant(2, text('做甲和乙')),
  ]

  it('上报这一轮里用户说的（含运行中排进来的）与助手说的文字，别的不带', async () => {
    const kioku = start()
    await kioku.turnStopping({ agent: agentOf({ events: history }), turn: 2 })
    expect(bodyOf('turn.end')).toEqual({
      event: 'turn.end',
      sessionId: 'session-1',
      user: '今天做什么\n顺便做乙',
      reply: '先看了一下\n做甲和乙',
    })
  })

  it('用户中途打断的一轮也上报：不听这一轮的取消信号', async () => {
    const kioku = start()
    await kioku.turnStopping({
      agent: agentOf({ events: history }),
      turn: 2,
      signal: AbortSignal.abort(),
    })
    expect(bodyOf('turn.end')).toMatchObject({ reply: '先看了一下\n做甲和乙' })
  })

  it('上报失败之后一分钟内不再上报，日志里说的是没有上报', async () => {
    const kioku = start()
    const agent = agentOf({ events: history })
    reply = () => ({ status: 500 })
    await kioku.turnStopping({ agent, turn: 2 })
    await kioku.turnStopping({ agent, turn: 2 })
    expect(requests).toHaveLength(1)
    expect(warnings).toEqual(['Kioku 这一轮没有上报（HTTP 500），稍后再试'])
    reply = contexts
    clock += 61_000
    await kioku.turnStopping({ agent, turn: 2 })
    expect(requests).toHaveLength(2)
  })

  it('没有回复的、找不到这一轮的不上报；上报失败不拦之后的召回', async () => {
    const kioku = start()
    const agent = agentOf({ events: history.slice(0, 6) })
    await kioku.turnStopping({ agent, turn: 2 })
    await kioku.turnStopping({ agent, turn: 9 })
    expect(requests).toEqual([])
    reply = (event) => (event === 'turn.end' ? { status: 500 } : contexts(event))
    await kioku.turnStopping({ agent: agentOf({ events: history }), turn: 2 })
    requests = []
    const input = [userMessage('甲')]
    expect((await kioku.preStep(step(agentOf(), input), enter(input))).messages).toHaveLength(2)
  })

  it('turnOf：只取这一轮的', () => {
    expect(turnOf(history, 1)).toEqual({ user: '上一轮', reply: '上一轮的回复' })
    expect(turnOf(history, 3)).toEqual({ user: '', reply: '' })
    expect(turnOf(null, 1)).toEqual({ user: '', reply: '' })
  })
})

describe('入口', () => {
  it('把三个扩展点接上', () => {
    const handlers = {}
    apply({ on: (event, handler) => (handlers[event] = handler), logger: { warn: () => {} } })
    expect(name).toBe('kioku')
    expect(Object.keys(handlers).sort()).toEqual([
      'agent/created',
      'agent/pre-step',
      'agent/turn-stopping',
    ])
  })
})
