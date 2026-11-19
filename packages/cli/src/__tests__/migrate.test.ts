import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { postEvent } from '../../../core/lib/lifecycle.mjs'
import { mcpCall } from '../../../core/lib/mcp.mjs'
import { assertServerSupported, probeServer, ServerMismatch, whoami } from '../api.ts'
import { searchCommand } from '../commands/memory.ts'
import { migrateCommand } from '../commands/migrate.ts'
import {
  KeyRejected,
  LEGACY_KEY_TEXT,
  LegacyDatabase,
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

let mode: 'current' | 'older' | 'legacy' | 'unavailable' = 'current'
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
        if (mode === 'legacy') {
          return json(503, {
            status: 'unavailable',
            version: '0.6.0',
            api: 2,
            database: 'legacy',
            code: 'legacy_database',
          })
        }
        if (mode === 'unavailable') {
          return json(503, {
            status: 'unavailable',
            version: '0.6.0',
            api: 2,
            database: 'unavailable',
          })
        }
        return json(200, { status: 'ok', version: '0.6.0', api: 2 })
      }

      if (mode === 'legacy') {
        return json(503, { error: '数据库等待管理员迁移', code: 'legacy_database' })
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
        if (mode === 'older' && req.url === '/v1/whoami') {
          // 旧版服务端返回的旧格式，不带 primaryCircle / client
          return json(200, { app: { slug: 'agy' }, space: { name: '家' } })
        }
        return json(401, { error: LEGACY_KEY_TEXT, code: 'legacy_key' })
      }
      if (auth !== `Bearer ${NEW_KEY}`) {
        return json(401, { error: '未登录或凭据无效' })
      }

      if (req.url === '/v1/whoami') {
        return json(200, {
          primaryCircle: { id: 'c1', slug: 'me-alice', name: 'Alice 的个人圈', kind: 'personal' },
          linkedCircles: [],
          client: {
            id: 'cl-1',
            slug: 'agy',
            name: 'Antigravity',
            runtimeFamily: 'agy',
          },
          scopes: {
            readKinds: ['entry'],
            writeKinds: ['entry'],
            maxSensitivity: 'private',
            credentials: 'none',
          },
        })
      }

      if (req.url === '/v1/mcp') {
        const rpc = body ? (JSON.parse(body) as { id?: number; method?: string }) : {}
        if (rpc.method === 'tools/list') {
          return json(200, {
            jsonrpc: '2.0',
            id: rpc.id ?? 1,
            result: { tools: [{ name: 'kioku_recall' }, { name: 'kioku_browse' }] },
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

describe('服务端代际探测与 legacy_key / legacy_database 识别', () => {
  it('probeServer 区分二代正常、一代无 api 字段、待迁移 legacy 与数据库不可用', async () => {
    mode = 'current'
    expect(await probeServer(base)).toEqual({ generation: 2, state: 'ok', version: '0.6.0' })

    mode = 'older'
    expect(await probeServer(base)).toEqual({ generation: 1, state: 'ok', version: '0.5.0' })
    await expect(assertServerSupported(base)).rejects.toThrow(/记忆圈重构之前的版本（0\.5\.0）/)

    mode = 'legacy'
    expect(await probeServer(base)).toEqual({ generation: 2, state: 'legacy', version: '0.6.0' })
    await expect(assertServerSupported(base)).rejects.toThrow(`${base}/legacy-upgrade`)

    mode = 'unavailable'
    expect(await probeServer(base)).toEqual({
      generation: 2,
      state: 'unavailable',
      version: '0.6.0',
    })
    await expect(assertServerSupported(base)).rejects.toThrow(/数据库暂时无法连接/)

    const unreachable = await probeServer('http://127.0.0.1:1')
    expect(unreachable.state).toBe('unreachable')
    expect(unreachable.generation).toBeNull()
  })

  it('whoami / mcpCall / postEvent / searchCommand 准确识别 legacy_key、普通 401、legacy_database 与一代响应', async () => {
    mode = 'current'
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toMatchObject({
      legacy: true,
      message: LEGACY_KEY_TEXT,
    })
    await expect(whoami({ url: base, key: 'kioku_other_bad' })).rejects.toBeInstanceOf(KeyRejected)
    await expect(whoami({ url: base, key: 'kioku_other_bad' })).rejects.toMatchObject({
      legacy: false,
    })
    await expect(mcpCall({ url: base, key: OLD_KEY }, 'tools/list', {}, 3000)).rejects.toThrow(
      LEGACY_KEY_TEXT,
    )
    await expect(postEvent(base, OLD_KEY, { event: 'session.start' }, 3000)).rejects.toMatchObject({
      kind: 'legacy',
    })

    await expect(
      searchCommand(['测试'], {
        env: { ...env, KIOKU_SERVER_URL: base, KIOKU_API_KEY: OLD_KEY },
        out: { write: () => true },
      }),
    ).rejects.toThrow(LEGACY_KEY_TEXT)

    mode = 'legacy'
    await expect(whoami({ url: base, key: NEW_KEY })).rejects.toBeInstanceOf(LegacyDatabase)
    await expect(mcpCall({ url: base, key: NEW_KEY }, 'tools/list', {}, 3000)).rejects.toThrow(
      `${base}/legacy-upgrade`,
    )

    mode = 'older'
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toBeInstanceOf(ServerMismatch)
    await expect(whoami({ url: base, key: OLD_KEY })).rejects.toThrow(/记忆圈重构之前的版本/)
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
      { url: base, tools: [{ name: 'kioku_read' }, { name: 'kioku_write' }] },
      env,
    )
    const clawFound = await detectLegacyPlugin('openclaw', { env, cwd: dir })
    expect(clawFound.outdatedPlugin).toContain('旧版工具清单')
    expect(clawFound.staleToolCache).toBe(true)
  })

  it('migrateCommand 对一代与待迁移服务端直接给出指引，全最新时输出无需迁移', async () => {
    mode = 'older'
    let out1 = ''
    expect(
      await migrateCommand(['--server-url', base], {
        env,
        cwd: dir,
        out: { write: (s) => ((out1 += s), true) },
      }),
    ).toBe(1)
    expect(out1).toContain('npx @kioku-memory/cli@0.5')

    mode = 'legacy'
    let out2 = ''
    expect(
      await migrateCommand(['--server-url', base], {
        env,
        cwd: dir,
        out: { write: (s) => ((out2 += s), true) },
      }),
    ).toBe(1)
    expect(out2).toContain(`${base}/legacy-upgrade`)

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
    await writeToolCache('agy', { url: base, tools: [{ name: 'kioku_read' }] }, env)

    mkdirSync(join(dir, 'opencode'), { recursive: true })
    writeFileSync(
      join(dir, 'opencode', 'opencode.json'),
      JSON.stringify({ plugin: ['@kioku-memory/plugin-opencode@0.5.0'] }, null, 2),
    )

    // 面板能识别待迁移项与旧密钥状态
    const state = await scan({ env, cwd: dir, url: base })
    expect(state.platforms.find((p) => p.id === 'agy')?.legacyKey).toBe(true)
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

  it('doctor --json 分开报告服务端代际不匹配、待迁移、旧访问密钥、旧插件来源与过旧插件', async () => {
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

    // 1. 一代服务端
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

    // 2. 待迁移数据库
    mode = 'legacy'
    let legJson = ''
    await doctor(['claude-code', '--json'], {
      env,
      cwd: dir,
      out: { write: (s) => ((legJson += s), true) },
    })
    const legReport = JSON.parse(legJson) as {
      targets: Array<{ checks: Array<{ category?: string }> }>
    }
    expect(legReport.targets[0]!.checks.some((c) => c.category === 'legacy_database')).toBe(true)

    // 3. 二代正常服务端：旧访问密钥 + 过旧插件
    mode = 'current'
    let keyJson = ''
    await doctor(['claude-code', '--json'], {
      env,
      cwd: dir,
      out: { write: (s) => ((keyJson += s), true) },
    })
    const keyReport = JSON.parse(keyJson) as {
      targets: Array<{ checks: Array<{ category?: string }> }>
    }
    expect(keyReport.targets[0]!.checks.some((c) => c.category === 'legacy_key')).toBe(true)

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
})
