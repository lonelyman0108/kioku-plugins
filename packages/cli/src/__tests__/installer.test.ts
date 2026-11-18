import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { fakeCommand } from '../../../core/lib/__tests__/fakeCommand.mjs'
import { readToolCacheSync } from '../core.ts'
import { manualDownload } from '../local.ts'
import {
  CLI_VERSION,
  formatHandshakeLines,
  installPlugin,
  removeManagedAgyPlugin,
  verifyConnectionHandshake,
} from '../installer.ts'

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/whoami') {
        if (req.headers.authorization !== 'Bearer kioku_ok') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            spaceId: '11111111-2222-3333-4444-555555555555',
            spaceName: '个人空间',
            app: { id: 'a', slug: 'oc', name: 'OpenClaw 应用', runtimeFamily: 'openclaw' },
            scopes: {
              readLayers: ['core', 'persona', 'app', 'user'],
              writeLayers: ['app', 'user'],
              maxSensitivity: 'private',
              credentials: 'use',
            },
          }),
        )
        return
      }
      if (req.url === '/v1/mcp') {
        const msg = JSON.parse(body || '{}') as { id?: number; method?: string }
        if (msg.method === 'tools/list') {
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
                  {
                    name: 'memory_save',
                    description: '保存记忆',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            }),
          )
          return
        }
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
let bin: string
let env: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-installer-'))
  bin = join(dir, 'bin')
  mkdirSync(bin)
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const pathParts = [bin, dirname(process.execPath)]
  if (process.platform === 'win32') {
    pathParts.push(join(process.env.SystemRoot || 'C:\\Windows', 'System32'))
  }
  env = {
    ...process.env,
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
    [pathKey]: pathParts.join(delimiter),
  }
  if (pathKey !== 'PATH') delete env.PATH
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('installer', () => {
  it('Antigravity：复制内置插件目录并写入托管版本标记；不误删用户手动目录', async () => {
    const first = await installPlugin('agy', { env, cwd: dir })
    expect(first.status).toBe('installed')
    const pluginDir = join(dir, 'agy', 'plugins', 'kioku')
    expect(existsSync(join(pluginDir, 'plugin.json'))).toBe(true)
    const marker = JSON.parse(readFileSync(join(pluginDir, '.kioku-managed.json'), 'utf8')) as {
      version: string
      managedBy: string
    }
    expect(marker).toMatchObject({ managedBy: '@kioku-memory/cli', version: CLI_VERSION })

    const second = await installPlugin('agy', { env, cwd: dir })
    expect(second.status).toBe('already')

    const upgraded = await installPlugin('agy', { env, cwd: dir, upgrade: true })
    expect(upgraded.status).toBe('upgraded')

    expect(await removeManagedAgyPlugin({ env })).toBe(true)
    expect(existsSync(pluginDir)).toBe(false)

    // 没有托管标记的目录（用户自己建的）既不覆盖也不删除
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), '{"name":"kioku"}')
    const manualRes = await installPlugin('agy', { env, cwd: dir, upgrade: true })
    expect(manualRes.status).toBe('already')
    expect(await removeManagedAgyPlugin({ env })).toBe(false)
    expect(existsSync(pluginDir)).toBe(true)
  })

  it('缺少宿主 CLI 时降级为可复制手动命令；存在时自动执行安装步骤', async () => {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const noClaude = await installPlugin('claude-code', {
      env: { ...env, [pathKey]: bin },
      cwd: dir,
    })
    expect(noClaude.status).toBe('manual')
    expect(noClaude.commands?.[0]).toContain('/plugin install kioku')

    const logFile = join(dir, 'claude-calls.log')
    fakeCommand(
      bin,
      'claude',
      `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\n')`,
    )
    const installed = await installPlugin('claude-code', { env, cwd: dir })
    expect(installed.status).toBe('installed')
    expect(readFileSync(logFile, 'utf8')).toContain('plugin install kioku@kioku')
  })

  it('Gemini CLI：自动调用 extensions link 指向内置目录', async () => {
    const logFile = join(dir, 'gemini-calls.log')
    fakeCommand(
      bin,
      'gemini',
      `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\n')`,
    )
    const res = await installPlugin('gemini', { env, cwd: dir })
    expect(res.status).toBe('installed')
    expect(readFileSync(logFile, 'utf8')).toMatch(/extensions link .*gemini/)

    const ocLog = `${logFile}.oc`
    const ocPathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const ocSep = process.platform === 'win32' ? ';' : ':'
    fakeCommand(
      bin,
      'openclaw',
      [
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        "fs.appendFileSync(process.env.KIOKU_OC_LOG, JSON.stringify(args) + '\\n');",
        "if (args[0] === 'gateway' && args[1] === 'restart') process.exit(1);",
      ].join('\n'),
    )
    const ocRes = await installPlugin('openclaw', {
      env: {
        ...env,
        [ocPathKey]: `${bin}${ocSep}${env[ocPathKey] ?? ''}`,
        KIOKU_OC_LOG: ocLog,
      },
      cwd: dir,
    })
    expect(ocRes.status).toBe('installed')
    expect(ocRes.message).toContain('gateway restart')
    expect(readFileSync(ocLog, 'utf8')).toContain('npm:@kioku-memory/openclaw')

    const psDownload = manualDownload('C:\\Users\\LM\\.kioku', 'main', 'win32')
    expect(psDownload).toContain('New-Item -ItemType Directory')
    expect(psDownload).toContain('curl.exe')
  })

  it('verifyConnectionHandshake：验证 whoami 与 MCP tools/list 并写入 OpenClaw 本地缓存', async () => {
    const ok = await verifyConnectionHandshake('openclaw', { url: base, key: 'kioku_ok' }, { env })
    expect(ok.ok).toBe(true)
    expect(ok.toolCount).toBe(2)
    expect(readToolCacheSync('openclaw', env)).toMatchObject({ url: base })

    const lines = formatHandshakeLines(ok).join('\n')
    expect(lines).toContain('OpenClaw 应用')
    expect(lines).toContain('个人空间')
    expect(lines).toContain('MCP 工具 2 个')
    expect(lines).toContain('通用、人格、应用、本人')
    expect(lines).toContain('[╱] 私密')

    const bad = await verifyConnectionHandshake(
      'openclaw',
      { url: base, key: 'kioku_bad' },
      { env },
    )
    expect(bad.ok).toBe(false)
    expect(formatHandshakeLines(bad)[0]).toContain('✗ 连通测试失败')
  })
})
