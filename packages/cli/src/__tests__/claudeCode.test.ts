import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readProfile } from '../core.ts'
import { doctor } from '../doctor.ts'
import { scanPlatform } from '../panel.ts'
import { setup } from '../setup.ts'

const execFileAsync = promisify(execFile)
const cliBin = fileURLToPath(new URL('../../bin/kioku', import.meta.url))
const KEY = 'kioku_cc_test_key'

const WHO = {
  accountName: 'owner',
  key: {
    id: 'key-cc',
    name: 'Claude Code',
    prefix: 'kioku_cc',
    runtimeFamily: 'claudecode',
    envs: [],
    allowedRealms: null,
    canWrite: true,
    canResolveCredentials: false,
  },
  client: {
    slug: 'cc',
    name: 'Claude Code',
    runtimeFamily: 'claudecode',
  },
}

let server: Server
let base: string
let requests: Array<{ url?: string; auth?: string }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(WHO))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

let dir: string
let env: Record<string, string | undefined>

beforeEach(() => {
  requests = []
  dir = mkdtempSync(join(tmpdir(), 'kioku-cc-unified-'))
  env = {
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    KIOKU_CONFIG_DIR: join(dir, 'kioku'),
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Claude Code 统一授权', () => {
  it('kioku setup claude-code --server-url：写入 claude-code.json 并停用自动记忆；--undo 一起清理', async () => {
    let outText = ''
    const code = await setup(['claude-code', '--server-url', base], {
      env,
      cwd: dir,
      readKey: async () => KEY,
      login: null,
      out: { write: (chunk) => (outText += String(chunk)) },
    })
    expect(code).toBe(0)
    expect(outText).toContain('claude-code.json')
    expect(await readProfile('claude-code', env)).toMatchObject({ url: base, key: KEY })
    const settings = JSON.parse(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8'))
    expect(settings.autoMemoryEnabled).toBe(false)

    // undo 同时恢复 settings.json 并删掉 claude-code.json
    const undoCode = await setup(['claude-code', '--undo'], {
      env,
      cwd: dir,
      out: { write: () => {} },
    })
    expect(undoCode).toBe(0)
    expect(await readProfile('claude-code', env)).toBeNull()
    const afterSettings = JSON.parse(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8'))
    expect(afterSettings.autoMemoryEnabled).toBeUndefined()
  })

  it('kioku doctor claude-code：优先读 claude-code.json，缺失时回退 CLAUDE_PLUGIN_OPTION_* 与环境变量', async () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    writeFileSync(
      join(dir, 'claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'kioku@kioku': true }, autoMemoryEnabled: false }),
    )

    // /plugin 配置变量回退
    let pluginText = ''
    const pluginCode = await doctor(['claude-code'], {
      env: {
        ...env,
        CLAUDE_PLUGIN_OPTION_SERVER_URL: base,
        CLAUDE_PLUGIN_OPTION_API_KEY: KEY,
      },
      cwd: dir,
      out: { write: (chunk) => (pluginText += String(chunk)) },
    })
    expect(pluginCode).toBe(0)
    expect(pluginText).toContain(`✓ 地址 ${base}`)
    expect(pluginText).toContain('✓ Claude Code 的 kioku 插件已启用')

    // 写入 profile 后优先读 profile
    await setup(['claude-code', '--server-url', base], {
      env,
      cwd: dir,
      readKey: async () => KEY,
      login: null,
      out: { write: () => {} },
    })
    let profileText = ''
    const profileCode = await doctor(['claude-code'], {
      env,
      cwd: dir,
      out: { write: (chunk) => (profileText += String(chunk)) },
    })
    expect(profileCode).toBe(0)
    expect(profileText).toContain(`✓ 地址 ${base}（${join(dir, 'kioku', 'claude-code.json')}）`)
  })

  it('scanPlatform：无 profile 且无插件为 none；仅启用插件为 manual；有 profile 为 ok', async () => {
    mkdirSync(join(dir, 'claude'), { recursive: true })
    const rowNone = await scanPlatform('claude-code', { env, cwd: dir, url: base })
    expect(rowNone.connection).toBe('none')

    writeFileSync(
      join(dir, 'claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'kioku@kioku': true } }),
    )
    const rowManual = await scanPlatform('claude-code', { env, cwd: dir, url: base })
    expect(rowManual.connection).toBe('manual')

    await setup(['claude-code', '--server-url', base], {
      env,
      cwd: dir,
      readKey: async () => KEY,
      login: null,
      out: { write: () => {} },
    })
    const rowOk = await scanPlatform('claude-code', { env, cwd: dir, url: base })
    expect(rowOk.connection).toBe('ok')
  })

  it('bin/kioku 可直接执行并输出用法', async () => {
    expect(existsSync(cliBin)).toBe(true)
    const { stdout } = await execFileAsync(process.execPath, [cliBin, '--help'], { env })
    expect(stdout).toContain('用法：kioku <子命令>')
  })
})
