import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { fakeCommand } from '../../../core/lib/__tests__/fakeCommand.mjs'
import { removeConflicts, scanConflicts } from '../conflicts.ts'
import { doctor } from '../doctor.ts'
import { installPlugin } from '../installer.ts'
import { detectLegacyPlugin } from '../legacy.ts'
import { PLATFORMS } from '../platforms.ts'
import { setup } from '../setup.ts'

const KEY = 'kioku_zcode_cli_test_key'

let server: Server
let base: string
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        accountName: 'owner',
        key: {
          id: 'key-zcode',
          name: 'zcode',
          prefix: 'kioku_zcode',
          runtimeFamily: 'zcode',
          envs: [],
          allowedRealms: null,
          canWrite: true,
          canResolveCredentials: false,
        },
        client: {
          slug: 'zcode',
          name: 'ZCode',
          runtimeFamily: 'zcode',
        },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

let dir: string
let bin: string
let env: Record<string, string | undefined>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-zcode-cli-'))
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
    ZCODE_HOME: join(dir, 'zcode'),
    [pathKey]: pathParts.join(delimiter),
  }
  if (pathKey !== 'PATH') delete env.PATH
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(command: typeof setup | typeof doctor, args: string[]) {
  let text = ''
  const io = {
    env,
    cwd: dir,
    out: { write: (chunk: string) => ((text += chunk), true) },
    readKey: async () => KEY,
    login: null,
  }
  return { code: await command(args, io), text }
}

describe('ZCode 平台接入、安装、诊断与冲突清理', () => {
  it('setup / doctor / status / undo 全链路正常', async () => {
    const dry = await run(setup, ['zcode', '--server-url', base, '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.text).toContain('没有写入（--dry-run）')
    expect(existsSync(join(dir, 'kioku', 'zcode.json'))).toBe(false)

    const applied = await run(setup, ['zcode', '--server-url', base])
    expect(applied.code).toBe(0)
    expect(existsSync(join(dir, 'kioku', 'zcode.json'))).toBe(true)
    expect(applied.text).toContain('kioku connect zcode')
    expect(await PLATFORMS.zcode.status({ env, cwd: dir })).toEqual({
      plugin: false,
      memory: 'none',
    })

    // config.json 已存在空 enabledPlugins 时，即便 installed_plugins.json 含 kioku@kioku 也不误判已启用
    mkdirSync(join(dir, 'zcode', 'cli', 'plugins'), { recursive: true })
    writeFileSync(
      join(dir, 'zcode', 'cli', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'kioku@kioku': [{ installPath: '/tmp/kioku' }] } }),
    )
    writeFileSync(
      join(dir, 'zcode', 'cli', 'config.json'),
      JSON.stringify({ plugins: { enabledPlugins: {} } }),
    )
    expect(await PLATFORMS.zcode.status({ env, cwd: dir })).toEqual({
      plugin: false,
      memory: 'none',
    })

    // 启用后 status 与 doctor 均识别为已启用
    writeFileSync(
      join(dir, 'zcode', 'cli', 'config.json'),
      JSON.stringify({ plugins: { enabledPlugins: { 'kioku@kioku': true } } }),
    )
    expect(await PLATFORMS.zcode.status({ env, cwd: dir })).toEqual({
      plugin: true,
      memory: 'none',
    })
    const doc = await run(doctor, ['zcode'])
    expect(doc.code).toBe(0)
    expect(doc.text).toContain('✓ ZCode 的 kioku 插件已启用')

    // 撤销清理配置与状态目录并提示卸载插件命令
    mkdirSync(join(dir, 'kioku', 'zcode-state', 'turns'), { recursive: true })
    writeFileSync(join(dir, 'kioku', 'zcode-state', 'turns', 'turn.a.latest.json'), '{}')
    const undone = await run(setup, ['zcode', '--undo'])
    expect(undone.code).toBe(0)
    expect(existsSync(join(dir, 'kioku', 'zcode.json'))).toBe(false)
    expect(existsSync(join(dir, 'kioku', 'zcode-state'))).toBe(false)
    expect(undone.text).toContain('zcode plugins uninstall kioku@kioku')
  })

  it('installPlugin(zcode)：缺命令降级手动提示；有命令自动注册市场、安装、启用并支持升级', async () => {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const noBin = await installPlugin('zcode', { env: { ...env, [pathKey]: bin }, cwd: dir })
    expect(noBin.status).toBe('manual')
    expect(noBin.commands?.join('\n')).toContain('zcode plugins marketplace add')
    const persistentDir = join(dir, 'kioku', 'plugins', 'zcode')
    expect(existsSync(join(persistentDir, 'marketplace.json'))).toBe(true)
    expect(existsSync(join(persistentDir, '.zcode-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(persistentDir, '.kioku-managed.json'))).toBe(true)

    const logFile = join(dir, 'zcode-calls.log')
    const listFile = join(dir, 'zcode-listed')
    fakeCommand(
      bin,
      'zcode',
      [
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        `fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');`,
        `if (args[0] === 'plugins' && args[1] === 'list' && fs.existsSync(${JSON.stringify(listFile)})) process.stdout.write('\\u001b[32mkioku@kioku\\u001b[0m\\n');`,
      ].join('\n'),
    )

    const fresh = await installPlugin('zcode', { env, cwd: dir })
    expect(fresh.status).toBe('installed')
    const freshLog = readFileSync(logFile, 'utf8')
    expect(freshLog).toContain(`plugins marketplace add ${persistentDir}`)
    expect(freshLog).toContain('plugins install kioku@kioku')
    expect(freshLog).toContain('plugins enable kioku@kioku')

    // ANSI 彩色输出的 list 仍能识别已安装，升级调用 update
    writeFileSync(listFile, '1')
    writeFileSync(logFile, '')
    const upgraded = await installPlugin('zcode', { env, cwd: dir, upgrade: true })
    expect(upgraded.status).toBe('upgraded')
    const upgradeLog = readFileSync(logFile, 'utf8')
    expect(upgradeLog).toContain('plugins update kioku@kioku')
    expect(upgradeLog).toContain('plugins enable kioku@kioku')
    expect(upgradeLog).not.toContain('plugins install kioku@kioku')

    // 检测旧版托管标记：未启用时不产生幽灵告警，启用后才提示过旧
    writeFileSync(
      join(persistentDir, '.kioku-managed.json'),
      JSON.stringify({ name: 'kioku', managedBy: '@kioku-memory/cli', version: '0.1.0' }),
    )
    expect((await detectLegacyPlugin('zcode', { env, cwd: dir })).outdatedPlugin).toBeNull()
    mkdirSync(join(dir, 'zcode', 'cli'), { recursive: true })
    writeFileSync(
      join(dir, 'zcode', 'cli', 'config.json'),
      JSON.stringify({ plugins: { enabledPlugins: { 'kioku@kioku': true } } }),
    )
    const legacy = await detectLegacyPlugin('zcode', { env, cwd: dir })
    expect(legacy.outdatedPlugin).toContain('旧版本 ZCode 插件')
  })

  it('scanConflicts(zcode)：发现并清理 ZCode 中的 Lore 插件与 MCP 冲突，不误删非 lore 市场', async () => {
    const cfgFile = join(dir, 'zcode', 'cli', 'config.json')
    mkdirSync(dirname(cfgFile), { recursive: true })
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mcpServers: {
          lore: { type: 'stdio', command: 'node', args: ['lore-mcp.mjs'] },
          other: { type: 'stdio', command: 'echo' },
        },
        plugins: {
          enabledPlugins: {
            'lore@team-market': true,
            'other@market': true,
          },
        },
        enabledPlugins: {
          'lore@team-market': true,
        },
      }),
    )

    const logFile = join(dir, 'zcode-clean.log')
    fakeCommand(
      bin,
      'zcode',
      `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\n')`,
    )

    const found = await scanConflicts('zcode', { env, cwd: dir })
    expect(found).toHaveLength(2)
    expect(found.every((i) => i.tool === 'lore' && i.removable)).toBe(true)

    const results = await removeConflicts(found, { env, cwd: dir })
    expect(results.every((r) => r.ok)).toBe(true)
    const after = JSON.parse(readFileSync(cfgFile, 'utf8')) as {
      mcpServers?: Record<string, unknown>
      plugins?: { enabledPlugins?: Record<string, unknown> }
      enabledPlugins?: Record<string, unknown>
    }
    expect(Object.keys(after.mcpServers ?? {})).toEqual(['other'])
    expect(after.plugins?.enabledPlugins).toEqual({ 'other@market': true })
    expect(after.enabledPlugins).toBeUndefined()
    const log = readFileSync(logFile, 'utf8')
    expect(log).toContain('plugins uninstall lore@team-market')
    expect(log).not.toContain('plugins marketplace remove lore')
  })
})
