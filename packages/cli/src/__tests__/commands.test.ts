import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connectCommand,
  disconnectCommand,
  localCommand,
  openCommand,
  upgradeCommand,
} from '../commands/manage.ts'
import { statusCommand } from '../commands/status.ts'
import { readProfile, readToolCacheSync, writeProfile } from '../core.ts'
import { doctor } from '../doctor.ts'
import { main } from '../index.ts'
import { installPlugin } from '../installer.ts'

const KEY = 'kioku_cmd_test_key'

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', version: '0.4.0', api: 2 }))
        return
      }
      if (req.url === '/v1/setup/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ needsSetup: false }))
        return
      }
      if (req.url === '/v1/device/authorize') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            deviceCode: 'dev-1',
            userCode: 'ABCD-1234',
            verificationPath: '/device',
            expiresIn: 600,
            interval: 1,
          }),
        )
        return
      }
      if (req.url === '/v1/device/token') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'approved',
            keys: [
              {
                runtimeFamily: 'agy',
                status: 'issued',
                key: KEY,
                client: { id: 'a', slug: 'agy', name: 'Antigravity', runtimeFamily: 'agy' },
              },
            ],
          }),
        )
        return
      }
      if (req.url === '/v1/whoami') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            primaryCircle: {
              id: '11111111-2222-3333-4444-555555555555',
              slug: 'personal',
              name: '默认记忆圈',
              kind: 'personal',
            },
            linkedCircles: [],
            client: {
              id: 'a',
              circleId: '11111111-2222-3333-4444-555555555555',
              slug: 'agy',
              name: 'Antigravity',
              runtimeFamily: 'agy',
            },
            persona: null,
            scopes: {
              readKinds: ['entry', 'fact', 'episode'],
              writeKinds: ['entry'],
              maxSensitivity: 'private',
              credentials: 'use',
            },
          }),
        )
        return
      }
      if (req.url === '/v1/mcp') {
        const msg = JSON.parse(body || '{}') as { id?: number }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id ?? 1,
            result: {
              tools: [
                {
                  name: 'memory_recall',
                  description: '召回记忆',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

let dir: string
let env: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-cmds-'))
  env = {
    HOME: join(dir, 'home'),
    KIOKU_CONFIG_DIR: join(dir, 'kioku'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    AGY_HOME: join(dir, 'agy'),
    GEMINI_CLI_HOME: join(dir, 'gemini-home'),
    CODEX_HOME: join(dir, 'codex'),
    OPENCLAW_HOME: join(dir, 'openclaw-home'),
    HERMES_HOME: join(dir, 'hermes'),
    PI_CODING_AGENT_DIR: join(dir, 'pi'),
    DSH_HOME: join(dir, 'dsh'),
    OPENCODE_CONFIG_DIR: join(dir, 'opencode'),
    PATH: '',
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('新管理子命令集', () => {
  it('status [--json]：渲染 Strata 方框卡片、折叠未检测客户端，--json 不含密钥', async () => {
    await writeProfile('agy', { url: base, key: KEY }, env)
    mkdirSync(join(dir, 'agy'), { recursive: true })

    let text = ''
    const code = await statusCommand([], { env, cwd: dir, out: { write: (c) => (text += c) } })
    expect(code).toBe(0)
    expect(text).toContain('Kioku 状态')
    expect(text).toContain('Antigravity')
    expect(text).toContain('未检测到客户端')
    expect(text).not.toContain(KEY)

    let jsonText = ''
    const jsonCode = await statusCommand(['--json'], {
      env,
      cwd: dir,
      out: { write: (c) => (jsonText += c) },
    })
    expect(jsonCode).toBe(0)
    const parsed = JSON.parse(jsonText) as {
      server: { url: string }
      platforms: Array<{ id: string }>
    }
    expect(parsed.server.url).toBe(base)
    expect(parsed.platforms.some((p) => p.id === 'agy')).toBe(true)
    expect(jsonText).not.toContain(KEY)
  })

  it('connect / upgrade / disconnect：完成 agy 全流程连接、插件同步握手、更新与干净断开', async () => {
    let connectOut = ''
    const connectCode = await connectCommand(['agy', '--server-url', base, '--no-browser'], {
      env,
      cwd: dir,
      sleep: async () => {},
      now: () => 0,
      open: () => {},
      out: { write: (c) => (connectOut += c) },
    })
    expect(connectCode).toBe(0)
    expect(connectOut).toContain('已接入：Antigravity')
    expect(connectOut).toContain('已安装 Antigravity 插件')
    expect(connectOut).toContain('MCP 工具 1 个')
    expect(await readProfile('agy', env)).toMatchObject({ url: base, key: KEY })
    expect(existsSync(join(dir, 'agy', 'plugins', 'kioku', '.kioku-managed.json'))).toBe(true)

    let upgradeOut = ''
    const upgradeCode = await upgradeCommand(['agy'], {
      env,
      cwd: dir,
      installFn: installPlugin,
      out: { write: (c) => (upgradeOut += c) },
    })
    expect(upgradeCode).toBe(0)
    expect(upgradeOut).toContain('已更新 Antigravity 插件')
    expect(upgradeOut).toContain('MCP 握手正常（1 个工具）')

    await writeProfile('openclaw', { url: base, key: KEY }, env)
    let clawOut = ''
    const clawUpgrade = await upgradeCommand(['openclaw'], {
      env,
      cwd: dir,
      installFn: async () => ({
        id: 'openclaw',
        status: 'upgraded',
        message: '已更新 OpenClaw 插件',
      }),
      out: { write: (c) => (clawOut += c) },
    })
    expect(clawUpgrade).toBe(0)
    expect(clawOut).toContain('已刷新 MCP 工具清单（1 个工具）')
    expect(readToolCacheSync('openclaw', env)?.tools).toHaveLength(1)

    await expect(
      disconnectCommand(['agy'], {
        env,
        cwd: dir,
        stdin: { isTTY: false } as never,
        out: { write: () => true },
      }),
    ).rejects.toThrow('--yes')

    let discOut = ''
    const discCode = await disconnectCommand(['agy', '--yes'], {
      env,
      cwd: dir,
      out: { write: (c) => (discOut += c) },
    })
    expect(discCode).toBe(0)
    expect(discOut).toContain('已移除托管安装的 Antigravity 插件目录')
    expect(await readProfile('agy', env)).toBeNull()
    expect(existsSync(join(dir, 'agy', 'plugins', 'kioku'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'agy', 'mcp_config.json'), 'utf8'))).toEqual({})
  })

  it('doctor --all --json：批量巡检全部平台并输出 JSON', async () => {
    await writeProfile('agy', { url: base, key: KEY }, env)
    let jsonOut = ''
    const code = await doctor(['--all', '--json'], {
      env,
      cwd: dir,
      out: { write: (c) => (jsonOut += c) },
    })
    expect(code).toBe(1) // 未配置的其余平台会报告未配过
    const report = JSON.parse(jsonOut) as { ok: boolean; targets: Array<{ id: string }> }
    expect(report.ok).toBe(false)
    expect(report.targets).toHaveLength(9)
    expect(jsonOut).not.toContain(KEY)
  })

  it('open 与 local status：正常解析服务地址与展示本机 Docker 状态', async () => {
    const opened: string[] = []
    let openOut = ''
    const openCode = await openCommand(['--server-url', `${base}/`], {
      env,
      out: { write: (c) => (openOut += c) },
      open: (u) => opened.push(u),
    })
    expect(openCode).toBe(0)
    expect(opened).toEqual([base])
    expect(openOut).toContain(base)

    let localOut = ''
    const localCode = await localCommand(['status', '--dir', join(dir, 'local-kioku')], {
      env,
      out: { write: (c) => (localOut += c) },
    })
    expect(localCode).toBe(0)
    expect(localOut).toContain('本机 Kioku 服务')
    expect(localOut).toContain('未创建')
  })

  it('main --help 列出所有新增子命令', async () => {
    let help = ''
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      help += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      expect(await main(['--help'])).toBe(0)
    } finally {
      process.stdout.write = orig
    }
    for (const cmd of [
      'status',
      'connect',
      'disconnect',
      'upgrade',
      'doctor',
      'local',
      'open',
      'run',
    ]) {
      expect(help).toContain(cmd)
    }
  })
})
