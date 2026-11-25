import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { postEvent } from '../../../core/lib/lifecycle.mjs'
import { mcpCall } from '../../../core/lib/mcp.mjs'
import { assertServerSupported, probeServer, ServerMismatch, whoami } from '../api.ts'
import { searchCommand } from '../commands/memory.ts'
import { migrateCommand, planMigration } from '../commands/migrate.ts'
import {
  DatabaseUnavailable,
  INVALID_KEY_TEXT,
  KeyRejected,
  readProfile,
  readToolCacheSync,
  toolCacheFile,
  writeProfile,
  writeToolCache,
} from '../core.ts'
import { doctor } from '../doctor.ts'
import { installPlugin } from '../installer.ts'
import { detectLegacyPlugin } from '../legacy.ts'
import { actionsFor, scan } from '../panel.ts'
import type { Env } from '../types.ts'

const OLD_KEY = 'kioku_old_1'
const NEW_KEY = 'kioku_new_1'

let mode: 'current' | 'older' | 'older_v2' | 'unavailable' = 'current'
let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }

      if (req.url === '/v1/health') {
        if (mode === 'older') return json(200, { status: 'ok', version: '0.5.0' })
        if (mode === 'older_v2') return json(200, { status: 'ok', version: '0.6.0', api: 2 })
        if (mode === 'unavailable') {
          return json(503, {
            status: 'unavailable',
            version: '0.7.0',
            api: 3,
            database: 'unavailable',
          })
        }
        return json(200, { status: 'ok', version: '0.7.0', api: 3 })
      }

      if (mode === 'unavailable') {
        return json(503, { error: '数据库暂时无法连接', code: 'database_unavailable' })
      }

      if (req.url === '/v1/device/authorize') {
        const parsed = body
          ? (JSON.parse(body) as { platforms?: Array<{ runtimeFamily: string }> })
          : {}
        expect(Array.isArray(parsed.platforms)).toBe(true)
        return json(201, {
          deviceCode: 'dev-mig-1',
          userCode: 'MIGR-1234',
          verificationPath: '/authorize',
          expiresIn: 600,
          interval: 1,
        })
      }

      if (req.url === '/v1/device/token') {
        const parsed = body ? (JSON.parse(body) as { deviceCode?: string }) : {}
        expect(parsed.deviceCode).toBe('dev-mig-1')
        return json(200, {
          status: 'approved',
          keys: [
            {
              runtimeFamily: 'agy',
              status: 'issued',
              key: NEW_KEY,
              client: { name: 'Antigravity', slug: 'agy' },
            },
            {
              runtimeFamily: 'opencode',
              status: 'issued',
              key: NEW_KEY,
              client: { name: 'OpenCode', slug: 'opencode' },
            },
          ],
        })
      }

      const auth = req.headers.authorization ?? ''
      if (auth === `Bearer ${OLD_KEY}`) {
        if ((mode === 'older' || mode === 'older_v2') && req.url === '/v1/whoami') {
          return json(200, { app: { slug: 'agy' }, space: { name: '家' } })
        }
        return json(401, { error: '未登录或凭据无效' })
      }
      if (auth !== `Bearer ${NEW_KEY}`) {
        return json(401, { error: '未登录或凭据无效' })
      }

      if (req.url === '/v1/whoami') {
        return json(200, {
          accountName: 'alice',
          key: {
            id: 'key-1',
            name: 'Antigravity',
            prefix: 'kioku_agy',
            runtimeFamily: 'agy',
            envs: [],
            allowedRealms: null,
            canWrite: true,
            canResolveCredentials: false,
          },
          client: {
            slug: 'agy',
            name: 'Antigravity',
            runtimeFamily: 'agy',
          },
        })
      }

      if (req.url === '/v1/mcp') {
        const rpc = body ? (JSON.parse(body) as { id?: number; method?: string }) : {}
        if (rpc.method === 'tools/list') {
          return json(200, {
            jsonrpc: '2.0',
            id: rpc.id ?? 1,
            result: {
              tools: [
                {
                  name: 'kioku_search',
                  description: '搜索',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'kioku_browse',
                  description: '浏览',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          })
        }
        return json(200, { jsonrpc: '2.0', id: rpc.id ?? 1, result: { ok: true } })
      }

      if (req.url === '/v1/recall') {
        return json(200, { candidates: [] })
      }

      json(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

let dir: string
let env: Env

beforeEach(() => {
  mode = 'current'
  dir = mkdtempSync(join(tmpdir(), 'kioku-migrate-'))
  env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    CODEX_HOME: join(dir, 'codex'),
    GEMINI_CLI_HOME: join(dir, 'gemini-cli'),
    OPENCODE_CONFIG_DIR: join(dir, 'opencode'),
    PI_CODING_AGENT_DIR: join(dir, 'pi'),
    HERMES_HOME: join(dir, 'hermes'),
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('服务端代际探测与 database_unavailable 识别', () => {
  it('probeServer 区分三代正常、旧代服务端与数据库不可用', async () => {
    mode = 'current'
    expect(await probeServer(base)).toEqual({ generation: 3, state: 'ok', version: '0.7.0' })

    mode = 'older'
    expect(await probeServer(base)).toEqual({ generation: 1, state: 'ok', version: '0.5.0' })
    await expect(assertServerSupported(base)).rejects.toThrow(/服务端版本过旧（0\.5\.0）/)

    mode = 'older_v2'
    expect(await probeServer(base)).toEqual({ generation: 2, state: 'ok', version: '0.6.0' })
    await expect(assertServerSupported(base)).rejects.toThrow(/服务端版本过旧（0\.6\.0）/)

    mode = 'unavailable'
    expect(await probeServer(base)).toEqual({
      generation: 3,
      state: 'unavailable',
      version: '0.7.0',
    })
    await expect(assertServerSupported(base)).rejects.toThrow(/数据库暂时无法连接/)

    const unreachable = await probeServer('http://127.0.0.1:1')
    expect(unreachable.state).toBe('unreachable')
    expect(unreachable.generation).toBeNull()
  })

  it('whoami / mcpCall / postEvent / searchCommand 准确识别 401、503 database_unavailable 与旧代响应', async () => {
    mode = 'current'
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toBeInstanceOf(KeyRejected)
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toThrow(INVALID_KEY_TEXT)
    await expect(mcpCall({ url: base, key: OLD_KEY }, 'tools/list', {}, 3000)).rejects.toThrow(
      INVALID_KEY_TEXT,
    )
    await expect(postEvent(base, OLD_KEY, { event: 'session.start' }, 3000)).rejects.toBeInstanceOf(
      KeyRejected,
    )

    await expect(
      searchCommand(['测试'], {
        env: { ...env, KIOKU_SERVER_URL: base, KIOKU_API_KEY: OLD_KEY },
        out: { write: () => true },
      }),
    ).rejects.toThrow(INVALID_KEY_TEXT)

    mode = 'unavailable'
    await expect(whoami({ url: base, key: NEW_KEY })).rejects.toBeInstanceOf(ServerMismatch)
    await expect(
      mcpCall({ url: base, key: NEW_KEY }, 'tools/list', {}, 3000),
    ).rejects.toBeInstanceOf(DatabaseUnavailable)

    mode = 'older'
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toBeInstanceOf(ServerMismatch)
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toThrow(/服务端版本过旧/)
  })
})

describe('旧版插件、市场来源与缓存识别及 kioku migrate 流程', () => {
  it('detectLegacyPlugin 识别 Claude Code 旧市场/旧插件、旧 agy 插件与旧 OpenClaw 工具缓存', async () => {
    mkdirSync(join(dir, 'claude', 'plugins', 'old-kioku', 'lib'), { recursive: true })
    writeFileSync(
      join(dir, 'claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ kioku: { source: { source: 'github', repo: 'lonelyman0108/kioku' } } }),
    )
    writeFileSync(
      join(dir, 'claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'kioku@kioku': [{ installPath: join(dir, 'claude', 'plugins', 'old-kioku') }],
        },
      }),
    )
    writeFileSync(
      join(dir, 'claude', 'plugins', 'old-kioku', 'lib', 'lifecycle.mjs'),
      'export function postEvent() {}\n',
    )
    const claudeFound = await detectLegacyPlugin('claude-code', { env, cwd: dir })
    expect(claudeFound.legacySource).toContain('lonelyman0108/kioku')
    expect(claudeFound.outdatedPlugin).toBe('重构前的 Claude Code 插件')

    mkdirSync(join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib'), { recursive: true })
    writeFileSync(
      join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib', 'lifecycle.mjs'),
      'export const TIMEOUTS = {}\n',
    )
    const agyFound = await detectLegacyPlugin('agy', { env, cwd: dir })
    expect(agyFound.outdatedPlugin).toBe('重构前的 Antigravity 插件')
    expect(agyFound.manualInstallDir).toBe(join(dir, '.gemini', 'config', 'plugins', 'kioku'))

    await writeToolCache(
      'openclaw',
      {
        url: base,
        tools: [
          { name: 'kioku_recall', description: '旧召回', inputSchema: { type: 'object' } },
          { name: 'kioku_transfer', description: '旧迁移', inputSchema: { type: 'object' } },
        ],
      },
      env,
    )
    const clawFound = await detectLegacyPlugin('openclaw', { env, cwd: dir })
    expect(clawFound.outdatedPlugin).toContain('旧版工具清单')
    expect(clawFound.staleToolCache).toBe(true)
  })

  it('migrateCommand 对旧代服务端与数据库不可用给出指引，全最新时输出无需迁移', async () => {
    mode = 'older'
    let out1 = ''
    expect(
      await migrateCommand(['--server-url', base], {
        env,
        cwd: dir,
        out: { write: (s) => ((out1 += s), true) },
      }),
    ).toBe(1)
    expect(out1).toContain('服务端版本过旧')

    mode = 'unavailable'
    let out2 = ''
    expect(
      await migrateCommand(['--server-url', base], {
        env,
        cwd: dir,
        out: { write: (s) => ((out2 += s), true) },
      }),
    ).toBe(1)
    expect(out2).toContain('数据库暂时无法连接')

    mode = 'current'
    let out3 = ''
    expect(
      await migrateCommand(['--server-url', base], {
        env,
        cwd: dir,
        out: { write: (s) => ((out3 += s), true) },
      }),
    ).toBe(0)
    expect(out3).toContain('无需迁移')
  })

  it('migrateCommand 支持 --dry-run / 非交互只打印计划，-y 执行旧源清理、缓存清理、插件更新与批量重授权', async () => {
    await writeProfile('agy', { url: base, key: OLD_KEY }, env)
    await writeProfile('opencode', { url: base, key: OLD_KEY }, env)
    mkdirSync(join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib'), { recursive: true })
    writeFileSync(
      join(dir, '.gemini', 'config', 'plugins', 'kioku', '.kioku-managed.json'),
      JSON.stringify({ managedBy: '@kioku-memory/cli', version: '0.5.0' }),
    )
    writeFileSync(
      join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib', 'lifecycle.mjs'),
      'export const TIMEOUTS = {}\n',
    )
    await writeToolCache(
      'agy',
      {
        url: base,
        tools: [{ name: 'kioku_read', description: '旧读取', inputSchema: { type: 'object' } }],
      },
      env,
    )

    mkdirSync(join(dir, 'opencode'), { recursive: true })
    writeFileSync(
      join(dir, 'opencode', 'opencode.json'),
      JSON.stringify({ plugin: ['@kioku-memory/plugin-opencode@0.5.0'] }, null, 2),
    )

    // 面板能识别待迁移项与失效密钥状态
    const state = await scan({ env, cwd: dir, url: base })
    expect(state.platforms.find((p) => p.id === 'agy')?.connection).toBe('invalid')
    expect(actionsFor(state).map((a) => a.value)).toContain('migrate')

    let dryOut = ''
    const dryCode = await migrateCommand(['--server-url', base, '--dry-run'], {
      env,
      cwd: dir,
      out: { write: (s) => ((dryOut += s), true) },
    })
    expect(dryCode).toBe(0)
    expect(dryOut).toContain('旧版客户端迁移计划')
    expect(dryOut).toContain('Antigravity')
    expect(dryOut).toContain('OpenCode')
    expect(dryOut).toContain('没有写入（--dry-run）')
    expect((await readProfile('agy', env))?.key).toBe(OLD_KEY)

    // 非交互终端不带 -y 时也不写
    let nonTtyOut = ''
    const nonTtyCode = await migrateCommand(['--server-url', base], {
      env,
      cwd: dir,
      stdin: { isTTY: false } as never,
      out: { write: (s) => ((nonTtyOut += s), true) },
    })
    expect(nonTtyCode).toBe(0)
    expect(nonTtyOut).toContain('非交互终端未指定 -y')

    let execOut = ''
    const execCode = await migrateCommand(['--server-url', base, '-y', '--no-browser'], {
      env,
      cwd: dir,
      out: { write: (s) => ((execOut += s), true) },
      open: () => {},
      sleep: async () => {},
      now: () => 0,
      installFn: installPlugin,
    })
    expect(execCode).toBe(0)
    expect(execOut).toContain('已清理旧工具清单缓存')
    expect(execOut).toContain('已更新 Antigravity 插件')
    expect(execOut).toContain('✓ 已签发新访问密钥')
    expect((await readProfile('agy', env))?.key).toBe(NEW_KEY)
    expect((await readProfile('opencode', env))?.key).toBe(NEW_KEY)
    expect(existsSync(toolCacheFile('agy', env))).toBe(false)
    const agyLifecycle = readFileSync(
      join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib', 'lifecycle.mjs'),
      'utf8',
    )
    expect(agyLifecycle).toContain('deviceKeyOf')
    const opencodeCfg = JSON.parse(
      readFileSync(join(dir, 'opencode', 'opencode.json'), 'utf8'),
    ) as {
      plugin: string[]
    }
    expect(opencodeCfg.plugin).toEqual(['@kioku-memory/plugin-opencode'])
    expect(readToolCacheSync('openclaw', env)).toBeNull()
  })

  it('doctor --json 分开报告服务端代际不匹配、数据库不可用、旧插件来源与过旧插件', async () => {
    await writeProfile('claude-code', { url: base, key: OLD_KEY }, env)
    mkdirSync(join(dir, 'claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(dir, 'claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ kioku: { source: { repo: 'lonelyman0108/kioku' } } }),
    )
    mkdirSync(join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib'), { recursive: true })
    writeFileSync(
      join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib', 'lifecycle.mjs'),
      'export const TIMEOUTS = {}\n',
    )
    await writeProfile('agy', { url: base, key: NEW_KEY }, env)

    // 1. 旧代服务端
    mode = 'older'
    let v1Json = ''
    expect(
      await doctor(['claude-code', '--json'], {
        env,
        cwd: dir,
        out: { write: (s) => ((v1Json += s), true) },
      }),
    ).toBe(1)
    const v1Report = JSON.parse(v1Json) as {
      targets: Array<{ checks: Array<{ category?: string; message: string }> }>
    }
    expect(v1Report.targets[0]!.checks.some((c) => c.category === 'server_generation')).toBe(true)
    expect(v1Report.targets[0]!.checks.some((c) => c.category === 'legacy_source')).toBe(true)

    // 2. 数据库不可用
    mode = 'unavailable'
    let unavailJson = ''
    await doctor(['claude-code', '--json'], {
      env,
      cwd: dir,
      out: { write: (s) => ((unavailJson += s), true) },
    })
    const unavailReport = JSON.parse(unavailJson) as {
      targets: Array<{ checks: Array<{ category?: string }> }>
    }
    expect(
      unavailReport.targets[0]!.checks.some((c) => c.category === 'database_unavailable'),
    ).toBe(true)

    // 3. 过旧插件
    mode = 'current'
    let agyJson = ''
    await doctor(['agy', '--json'], {
      env,
      cwd: dir,
      out: { write: (s) => ((agyJson += s), true) },
    })
    const agyReport = JSON.parse(agyJson) as {
      targets: Array<{ checks: Array<{ category?: string }> }>
    }
    expect(agyReport.targets[0]!.checks.some((c) => c.category === 'outdated_plugin')).toBe(true)
  })

  it('migrateCommand 对手动维护目录返回失败退出码 1，且移除旧插件来源失败时跳过重装', async () => {
    await writeProfile('agy', { url: base, key: OLD_KEY }, env)
    mkdirSync(join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib'), { recursive: true })
    writeFileSync(
      join(dir, '.gemini', 'config', 'plugins', 'kioku', 'lib', 'lifecycle.mjs'),
      'export const TIMEOUTS = {}\n',
    )

    await writeProfile('claude-code', { url: base, key: OLD_KEY }, env)
    mkdirSync(join(dir, 'claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(dir, 'claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ kioku: { source: { repo: 'lonelyman0108/kioku' } } }),
    )

    let outText = ''
    let reinstalledClaude = false
    const code = await migrateCommand(
      ['agy', 'claude-code', '--server-url', base, '-y', '--no-browser'],
      {
        env: { ...env, PATH: '' },
        cwd: dir,
        out: { write: (s) => ((outText += s), true) },
        open: () => {},
        sleep: async () => {},
        now: () => 0,
        installFn: async (id) => {
          if (id === 'claude-code') reinstalledClaude = true
          return { id, status: 'upgraded', message: 'ok' }
        },
      },
    )
    expect(code).toBe(1)
    expect(outText).toContain('需手动替换')
    expect(reinstalledClaude).toBe(false)
    expect(outText).toContain('跳过插件重装')
  })

  it('detectLegacyPlugin 对 OpenClaw 与 OpenCode 优先按代码特征识别旧版，不误判 0.5.0 本地包与 0.5.1-edge 预览版', async () => {
    const clawEnv: Env = { ...env, OPENCLAW_HOME: dir }
    const clawDir = join(dir, '.openclaw', 'extensions', 'kioku')
    mkdirSync(join(clawDir, 'lib'), { recursive: true })
    writeFileSync(join(clawDir, 'package.json'), JSON.stringify({ version: '0.5.0' }))
    writeFileSync(join(clawDir, 'lib', 'lifecycle.mjs'), 'export const deviceKeyOf = () => {}\n')

    expect(
      (await detectLegacyPlugin('openclaw', { env: clawEnv, cwd: dir })).outdatedPlugin,
    ).toBeNull()

    writeFileSync(
      join(clawDir, 'package.json'),
      JSON.stringify({ version: '0.5.1-edge.20261124080000.g1a2b3c4' }),
    )
    expect(
      (await detectLegacyPlugin('openclaw', { env: clawEnv, cwd: dir })).outdatedPlugin,
    ).toBeNull()

    writeFileSync(join(clawDir, 'package.json'), JSON.stringify({ version: '0.5.0' }))
    writeFileSync(join(clawDir, 'lib', 'lifecycle.mjs'), 'export const TIMEOUTS = {}\n')
    expect((await detectLegacyPlugin('openclaw', { env: clawEnv, cwd: dir })).outdatedPlugin).toBe(
      '旧版本 OpenClaw 插件',
    )

    mkdirSync(join(dir, 'opencode'), { recursive: true })
    writeFileSync(
      join(dir, 'opencode', 'opencode.json'),
      JSON.stringify({
        plugin: ['@kioku-memory/plugin-opencode@0.5.1-edge.20261124080000.g1a2b3c4'],
      }),
    )
    expect((await detectLegacyPlugin('opencode', { env, cwd: dir })).legacySource).toBeNull()
  })

  it('无参 migrate 对已切到新版插件但访问密钥返回 401 的平台仍安排重新授权，并跳过其他服务器', async () => {
    // OpenCode 已使用无版本钉死的新插件源（无旧残留），但访问密钥在服务端升级后已失效（401）
    await writeProfile('opencode', { url: base, key: OLD_KEY }, env)
    mkdirSync(join(dir, 'opencode'), { recursive: true })
    writeFileSync(
      join(dir, 'opencode', 'opencode.json'),
      JSON.stringify({ plugin: ['@kioku-memory/plugin-opencode'] }),
    )
    // 另一个平台指向不同服务器，无参 migrate 不应动它
    await writeProfile('agy', { url: 'http://127.0.0.1:1', key: OLD_KEY }, env)

    const findings = await detectLegacyPlugin('opencode', { env, cwd: dir })
    expect(findings.legacySource).toBeNull()
    expect(findings.outdatedPlugin).toBeNull()
    expect(findings.staleToolCache).toBe(false)

    const plan = await planMigration(base, { env, cwd: dir })
    expect(plan.items.map((item) => item.id)).toEqual(['opencode'])
    expect(plan.items[0]?.reauth).toBe(true)
    expect(plan.items[0]?.reasons).toContain('访问密钥已失效')

    let execOut = ''
    const code = await migrateCommand(['--server-url', base, '-y', '--no-browser'], {
      env,
      cwd: dir,
      out: { write: (s) => ((execOut += s), true) },
      open: () => {},
      sleep: async () => {},
      now: () => 0,
      installFn: async (id) => ({ id, status: 'upgraded', message: 'ok' }),
    })
    expect(code).toBe(0)
    expect(execOut).toContain('✓ 已签发新访问密钥')
    expect((await readProfile('opencode', env))?.key).toBe(NEW_KEY)
    expect((await readProfile('agy', env))?.key).toBe(OLD_KEY)
  })
})
