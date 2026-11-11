import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure } from '../http.mjs'
import {
  callTool,
  listTools,
  mcpCall,
  readToolCacheSync,
  removeToolCache,
  toolCacheFile,
  toolsOf,
  writeToolCache,
} from '../mcp.mjs'

const KEY = 'kioku_test_key'
let server
let base
let requests = []
let reply
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      const { status = 200, headers = { 'content-type': 'application/json' }, text } = reply()
      res.writeHead(status, headers)
      res.end(text)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  requests = []
})

const result = (value) => ({ text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }) })
const target = () => ({ url: base, key: KEY })

describe('mcpCall', () => {
  it('发一次 JSON-RPC 调用，带访问密钥，返回 result', async () => {
    reply = () => result({ ok: true })
    expect(await mcpCall(target(), 'tools/list', {}, 1000)).toEqual({ ok: true })
    expect(requests[0].url).toBe('/v1/mcp')
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(requests[0].headers.accept).toBe('application/json, text/event-stream')
    expect(requests[0].body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })

  it('回答是事件流时取最后一条 data', async () => {
    reply = () => ({
      headers: { 'content-type': 'text/event-stream' },
      text: `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { n: 2 } })}\n\n`,
    })
    expect(await mcpCall(target(), 'tools/call', {}, 1000)).toEqual({ n: 2 })
  })

  it('访问密钥无效、别的状态码、读不懂的响应、服务端报错都给原因，不带访问密钥与响应正文', async () => {
    const failure = async () => {
      const err = await mcpCall(target(), 'tools/list', {}, 1000).catch((e) => e)
      expect(err).toBeInstanceOf(KiokuFailure)
      expect(err.message).not.toContain(KEY)
      return err.message
    }
    reply = () => ({ status: 401, text: '{}' })
    expect(await failure()).toBe('访问密钥无效或已吊销')
    reply = () => ({ status: 503, text: `echo ${KEY}` })
    expect(await failure()).toBe('Kioku 返回 HTTP 503')
    reply = () => ({ text: `<html>${KEY}</html>` })
    expect(await failure()).toBe('Kioku 的响应格式不对')
    reply = () => ({ text: '"text"' })
    expect(await failure()).toBe('Kioku 的响应格式不对')
    reply = () => ({
      text: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32602, message: '参数\n不对' },
      }),
    })
    expect(await failure()).toBe('Kioku 没有接受这次调用：参数 不对')
    reply = () => ({ status: 302, headers: { location: 'https://other.example.com/v1/mcp?t=1' } })
    expect(await failure()).toContain('https://other.example.com）')
  })

  it('连不上、取消时也是 KiokuFailure', async () => {
    const down = await mcpCall(
      { url: 'http://127.0.0.1:9', key: KEY },
      'tools/list',
      {},
      1000,
    ).catch((e) => e)
    expect(down).toBeInstanceOf(KiokuFailure)
    expect(down.message).toContain('无法连接 Kioku')
    const aborted = await mcpCall(target(), 'tools/list', {}, 1000, AbortSignal.abort()).catch(
      (e) => e,
    )
    expect(aborted.message).toBe('已取消')
  })
})

describe('工具清单与调用', () => {
  it('清单里只留名字、说明、参数都在的工具，别的字段不带', async () => {
    reply = () =>
      result({
        tools: [
          { name: 'a', description: '甲', inputSchema: { type: 'object' }, annotations: { x: 1 } },
          { name: 'b', description: '乙' },
          { name: '', description: '丙', inputSchema: {} },
          { name: 'd', description: '丁', inputSchema: [] },
          null,
        ],
      })
    expect(await listTools(target())).toEqual([
      { name: 'a', description: '甲', inputSchema: { type: 'object' } },
    ])
    expect(toolsOf(null)).toEqual([])
  })

  it('调用结果里的文字块连成一段，带上是否出错', async () => {
    reply = () =>
      result({
        content: [
          { type: 'text', text: '第一段' },
          { type: 'image', data: 'x' },
          { type: 'text', text: '第二段' },
        ],
        isError: true,
      })
    expect(await callTool(target(), 'kioku_get', { uri: 'core://a' })).toEqual({
      text: '第一段\n第二段',
      isError: true,
    })
    expect(requests[0].body.params).toEqual({ name: 'kioku_get', arguments: { uri: 'core://a' } })
    reply = () => result({})
    expect(await callTool(target(), 'kioku_get')).toEqual({ text: '', isError: false })
    expect(requests[1].body.params.arguments).toEqual({})
  })
})

describe('本机留的工具清单', () => {
  let dir
  let env
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kioku-mcp-'))
    env = { KIOKU_CONFIG_DIR: join(dir, 'kioku') }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('写下、读回、删掉；文件只给本人', async () => {
    const tools = [{ name: 'a', description: '甲', inputSchema: { type: 'object' } }]
    expect(readToolCacheSync('openclaw', env)).toBeNull()
    expect(await writeToolCache('openclaw', { url: base, tools, at: 123 }, env)).toBe(true)
    const file = toolCacheFile('openclaw', env)
    expect(file).toBe(join(dir, 'kioku', 'openclaw-tools.json'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readToolCacheSync('openclaw', env)).toEqual({ url: base, at: 123, tools })
    await removeToolCache('openclaw', env)
    expect(readToolCacheSync('openclaw', env)).toBeNull()
    await removeToolCache('openclaw', env)
  })

  it('读不懂的、缺地址的当作没有；里面不成样子的工具不要', async () => {
    await writeToolCache('openclaw', { url: base, tools: [] }, env)
    const file = toolCacheFile('openclaw', env)
    writeFileSync(file, '{')
    expect(readToolCacheSync('openclaw', env)).toBeNull()
    writeFileSync(file, JSON.stringify({ tools: [] }))
    expect(readToolCacheSync('openclaw', env)).toBeNull()
    writeFileSync(file, JSON.stringify({ url: base, tools: [{ name: 'x' }] }))
    expect(readToolCacheSync('openclaw', env)).toEqual({ url: base, at: 0, tools: [] })
    expect(readFileSync(file, 'utf8')).toContain('"x"')
  })

  it('写不进去时返回假，不抛错', async () => {
    writeFileSync(join(dir, 'kioku'), '占着目录的位置')
    expect(await writeToolCache('openclaw', { url: base, tools: [] }, env)).toBe(false)
  })
})
