import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url))

let server
let base
let requests = []
let reply = () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } })

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ url: req.url, headers: req.headers, body })
      const next = reply(body, req)
      res.writeHead(next.status ?? 200, {
        'content-type': next.contentType ?? 'application/json',
        ...(next.headers ?? {}),
      })
      res.end(next.text ?? JSON.stringify(next.body ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
beforeEach(() => {
  requests = []
  reply = (body) => ({
    status: 200,
    body: { jsonrpc: '2.0', id: body?.id ?? 1, result: { ok: true } },
  })
  dir = mkdtempSync(join(tmpdir(), 'kioku-mcp-stdio-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function runBridgeProc(lines, envPatch = {}) {
  const env = { ...process.env, KIOKU_CONFIG_DIR: dir }
  delete env.CLAUDE_PLUGIN_OPTION_SERVER_URL
  delete env.CLAUDE_PLUGIN_OPTION_API_KEY
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    for (const item of lines) {
      child.stdin.write(typeof item === 'string' ? `${item}\n` : `${JSON.stringify(item)}\n`)
    }
    child.stdin.end()
  })
}

describe('Claude Code MCP stdio 桥接', () => {
  it('优先使用 /plugin 环境变量，未填写时回退本机配置；通知不写出，支持 SSE 响应', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'claude-code.json'),
      JSON.stringify({ serverUrl: `${base}/`, apiKey: 'kioku_profile_mcp_key' }),
    )
    reply = (body) => {
      if (body.method === 'notifications/initialized') return { status: 202, text: '' }
      if (body.method === 'tools/list') {
        return {
          status: 200,
          contentType: 'text/event-stream',
          text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'kioku_search' }] } })}\n\n`,
        }
      }
      return {
        status: 200,
        body: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } },
      }
    }

    const res = await runBridgeProc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ])
    expect(res.code).toBe(0)
    const outLines = res.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(outLines).toHaveLength(2)
    expect(outLines[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26' },
    })
    expect(outLines[1]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'kioku_search' }] },
    })
    expect(requests).toHaveLength(3)
    expect(requests[0].headers.authorization).toBe('Bearer kioku_profile_mcp_key')

    // /plugin 环境变量覆盖本机 profile
    requests = []
    await runBridgeProc([{ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }], {
      CLAUDE_PLUGIN_OPTION_SERVER_URL: base,
      CLAUDE_PLUGIN_OPTION_API_KEY: 'kioku_option_mcp_key',
    })
    expect(requests[0].headers.authorization).toBe('Bearer kioku_option_mcp_key')
  })

  it('未配置、401 或跳转时返回脱敏 JSON-RPC 错误且绝不泄露访问密钥', async () => {
    const missing = await runBridgeProc([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    expect(missing.code).toBe(0)
    const missingErr = JSON.parse(missing.stdout.trim())
    expect(missingErr.id).toBe(1)
    expect(missingErr.error.message).toContain('kioku login claude-code')

    const secretKey = 'kioku_secret_do_not_leak'
    reply = () => ({ status: 401, body: { error: `bad ${secretKey}` } })
    const unauth = await runBridgeProc([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], {
      CLAUDE_PLUGIN_OPTION_SERVER_URL: base,
      CLAUDE_PLUGIN_OPTION_API_KEY: secretKey,
    })
    expect(unauth.stdout + unauth.stderr).not.toContain(secretKey)
    expect(JSON.parse(unauth.stdout.trim()).error.message).toContain('访问密钥无效或已吊销')

    reply = () => ({
      status: 302,
      headers: { location: 'https://kioku.example.com/v1/mcp?token=secret' },
    })
    const redir = await runBridgeProc([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }], {
      CLAUDE_PLUGIN_OPTION_SERVER_URL: base,
      CLAUDE_PLUGIN_OPTION_API_KEY: secretKey,
    })
    expect(redir.stdout + redir.stderr).not.toContain(secretKey)
    expect(redir.stdout + redir.stderr).not.toContain('token=secret')
    expect(JSON.parse(redir.stdout.trim()).error.message).toContain('返回了跳转')
  })
})
