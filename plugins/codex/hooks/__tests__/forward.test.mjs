import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../forward.mjs', import.meta.url))
const KEY = 'kioku_test_key'

// 一个假的 Kioku：记下收到的请求，按 reply 返回
let server
let base
let requests = []
const contextReply = (text) => () => ({
  status: 200,
  body: {
    hostOutput: {
      mode: 'stdout_json',
      value: { hookSpecificOutput: { hookEventName: 'x', additionalContext: text } },
    },
  },
})
const defaultReply = () => ({ status: 200, body: { hostOutput: { mode: 'none', value: null } } })
let reply = defaultReply

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    // 按 UTF-8 解码：分块到达时一个字可能被切在两块里
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      const { status, body, headers = {} } = reply()
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let config
let data
beforeEach(() => {
  requests = []
  reply = defaultReply
  dir = mkdtempSync(join(tmpdir(), 'kioku-codex-'))
  config = join(dir, 'config')
  data = join(dir, 'data')
  mkdirSync(config)
  profile({ serverUrl: `${base}/`, apiKey: KEY })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function profile(value) {
  writeFileSync(
    join(config, 'codex.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}

function run(event, input, { pluginData = true } = {}) {
  const env = { ...process.env, KIOKU_CONFIG_DIR: config }
  delete env.PLUGIN_DATA
  if (pluginData) env.PLUGIN_DATA = data
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, event], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}
const turns = () => (existsSync(join(data, 'turns')) ? readdirSync(join(data, 'turns')) : [])
const contextIn = (stdout) => JSON.parse(stdout).hookSpecificOutput

describe('Codex 钩子转发', () => {
  it('会话开始：带访问密钥转发，把上下文按 SessionStart 写出，只带上下文文本', async () => {
    reply = () => ({
      status: 200,
      body: {
        hostOutput: {
          mode: 'stdout_json',
          value: {
            continue: false,
            decision: 'block',
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '启动' },
          },
        },
      },
    })
    const result = await run('session.start', { session_id: 's1', source: 'startup', cwd: dir })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '启动' },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/lifecycle/event')
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(requests[0].body).toEqual({
      event: 'session.start',
      sessionId: 's1',
      project: { dirName: dir.split('/').pop() },
    })
  })

  it('每轮输入：转发提示语，召回块按 UserPromptSubmit 写出，并记下这一轮的输入', async () => {
    reply = contextReply('<recall>\n</recall>')
    const result = await run('prompt.submit', {
      session_id: 's1',
      turn_id: 't1',
      prompt: '  办公室的网络怎么配的  ',
    })
    expect(contextIn(result.stdout)).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: '<recall>\n</recall>',
    })
    expect(requests[0].body).toEqual({
      event: 'prompt.submit',
      sessionId: 's1',
      prompt: '办公室的网络怎么配的',
    })
    expect(turns()).toEqual(['turn.s1.t1.json'])
    expect(statSync(join(data, 'turns', 'turn.s1.t1.json')).mode & 0o777).toBe(0o600)
  })

  it('一轮结束：用提交时记下的输入与最后的回复转发 turn.end，不写标准输出，记下的输入删掉', async () => {
    await run('prompt.submit', { session_id: 's1', turn_id: 't1', prompt: '第一问' })
    await run('prompt.submit', { session_id: 's1', turn_id: 't2', prompt: '第二问' })
    requests = []
    const result = await run('turn.end', {
      session_id: 's1',
      turn_id: 't1',
      stop_hook_active: false,
      last_assistant_message: ' 第一答 ',
    })
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(requests.map((r) => r.body)).toEqual([
      { event: 'turn.end', sessionId: 's1', user: '第一问', reply: '第一答' },
    ])
    // 别的轮次记下的还在
    expect(turns()).toEqual(['turn.s1.t2.json'])
    // 同一轮再来一次：输入已经取走，不重复上报
    requests = []
    await run('turn.end', { session_id: 's1', turn_id: 't1', last_assistant_message: '第一答' })
    expect(requests).toHaveLength(0)
  })

  it('别的钩子让它接着说时不上报，记下的输入留到真正结束', async () => {
    await run('prompt.submit', { session_id: 's1', turn_id: 't1', prompt: '问' })
    requests = []
    await run('turn.end', {
      session_id: 's1',
      turn_id: 't1',
      stop_hook_active: true,
      last_assistant_message: '半截',
    })
    expect(requests).toHaveLength(0)
    expect(turns()).toEqual(['turn.s1.t1.json'])
    await run('turn.end', { session_id: 's1', turn_id: 't1', last_assistant_message: '答完' })
    expect(requests.map((r) => r.body.reply)).toEqual(['答完'])
  })

  it('没有记下输入的轮次、标识不对的轮次不上报，标识不拼进路径', async () => {
    await run('turn.end', { session_id: 's1', turn_id: 't9', last_assistant_message: '答' })
    await run('prompt.submit', { session_id: '../x', turn_id: '../../y', prompt: '问' })
    expect(turns()).toEqual([])
    await run('turn.end', { session_id: '../x', turn_id: '../../y', last_assistant_message: '答' })
    expect(requests.map((r) => r.body.event)).toEqual(['prompt.submit'])
    expect(readdirSync(dir).sort()).toEqual(
      ['config', 'data'].filter((n) => existsSync(join(dir, n))),
    )
  })

  it('召回失败时这一轮的输入照样记下，结束时照常上报', async () => {
    reply = () => ({ status: 500, body: {} })
    const failed = await run('prompt.submit', { session_id: 's1', turn_id: 't1', prompt: '问' })
    expect(failed).toMatchObject({ code: 0, stdout: '' })
    expect(failed.stderr).toContain('HTTP 500')
    reply = defaultReply
    requests = []
    await run('turn.end', { session_id: 's1', turn_id: 't1', last_assistant_message: '答' })
    expect(requests.map((r) => r.body.user)).toEqual(['问'])
  })

  it('没有插件数据目录时记在 Kioku 的配置目录下', async () => {
    await run(
      'prompt.submit',
      { session_id: 's1', turn_id: 't1', prompt: '问' },
      { pluginData: false },
    )
    expect(readdirSync(join(config, 'codex-state', 'turns'))).toEqual(['turn.s1.t1.json'])
  })

  it('会话开始与下一次输入时删掉放了一天以上的输入', async () => {
    await run('prompt.submit', { session_id: 's1', turn_id: 'old', prompt: '问' })
    await run('prompt.submit', { session_id: 's1', turn_id: 'new', prompt: '问' })
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(join(data, 'turns', 'turn.s1.old.json'), old, old)
    await run('session.start', { session_id: 's2' })
    expect(turns()).toEqual(['turn.s1.new.json'])
    // 下一次输入时也清
    utimesSync(join(data, 'turns', 'turn.s1.new.json'), old, old)
    await run('prompt.submit', { session_id: 's2', turn_id: 't1', prompt: '问' })
    expect(turns()).toEqual(['turn.s2.t1.json'])
  })

  it('没有配置时只在会话开始提示一次，不发请求', async () => {
    rmSync(join(config, 'codex.json'))
    const start = await run('session.start', { session_id: 's1' })
    expect(contextIn(start.stdout).additionalContext).toContain('kioku setup codex')
    const prompt = await run('prompt.submit', { session_id: 's1', turn_id: 't1', prompt: '问' })
    expect(prompt).toMatchObject({ code: 0, stdout: '' })
    expect(requests).toHaveLength(0)
    expect(turns()).toEqual([])
  })

  it('配置写错（文件读不懂、访问密钥格式不对、地址返回跳转）时会话开始提示怎么改，不带访问密钥', async () => {
    for (const value of ['{ 坏的', { serverUrl: base, apiKey: 'bad key' }]) {
      profile(value)
      const start = await run('session.start', { session_id: 's1' })
      expect(start.code).toBe(0)
      expect(contextIn(start.stdout).additionalContext).toContain('kioku setup codex')
      expect(start.stdout + start.stderr).not.toContain('bad key')
    }
    expect(requests).toHaveLength(0)

    profile({ serverUrl: base, apiKey: KEY })
    reply = () => ({
      status: 302,
      headers: { location: 'https://kioku.example.com/v1/lifecycle/event' },
    })
    const redirected = await run('session.start', { session_id: 's1' })
    expect(contextIn(redirected.stdout).additionalContext).toContain('https://kioku.example.com')
    expect(redirected.stdout + redirected.stderr).not.toContain(KEY)
    // 别的事件不提示
    const prompt = await run('prompt.submit', { session_id: 's1', turn_id: 't1', prompt: '问' })
    expect(prompt.stdout).toBe('')
  })

  it('服务端出错、连不上、输入不是 JSON 都不挡输入', async () => {
    reply = () => ({ status: 401, body: { error: 'x' } })
    expect(await run('session.start', {})).toMatchObject({ code: 0, stdout: '' })
    profile({ serverUrl: 'http://127.0.0.1:1', apiKey: KEY })
    const refused = await run('session.start', {})
    expect(refused).toMatchObject({ code: 0, stdout: '' })
    expect(refused.stderr).toMatch(/无法连接 Kioku/)
    profile({ serverUrl: base, apiKey: KEY })
    reply = contextReply('启动')
    const garbled = await run('session.start', '不是 JSON')
    expect(contextIn(garbled.stdout).additionalContext).toBe('启动')
    expect((await run('prompt.submit', '不是 JSON')).stdout).toBe('')
  })

  it('过长的输入与回复按上限截断', async () => {
    await run('prompt.submit', { session_id: 's1', turn_id: 't1', prompt: '问'.repeat(20_001) })
    expect(requests[0].body.prompt).toHaveLength(20_000)
    await run('turn.end', {
      session_id: 's1',
      turn_id: 't1',
      last_assistant_message: '答'.repeat(20_001),
    })
    expect(requests[1].body.user).toHaveLength(20_000)
    expect(requests[1].body.reply).toHaveLength(20_000)
    expect(readFileSync(join(config, 'codex.json'), 'utf8')).toContain(KEY)
  })
})
