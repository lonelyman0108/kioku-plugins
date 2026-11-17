import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { matchMcpTool, removeConflicts, scanConflicts } from '../conflicts.mjs'
import { KiokuFailure } from '../http.mjs'
import { fakeCommand } from './fakeCommand.mjs'

let dir
let env
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-conflicts-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  env = {
    HOME: home,
    PATH: '',
    AGY_HOME: join(home, '.gemini', 'config'),
    GEMINI_CLI_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    OPENCLAW_HOME: home,
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    DSH_HOME: join(home, '.dsh'),
    HERMES_HOME: join(home, '.hermes'),
    LORE_HOME: join(home, '.lore'),
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('matchMcpTool', () => {
  it('精确识别 Lore 与常见记忆 MCP，对泛用 memory 只告警不自动删，不误伤 kioku', () => {
    expect(matchMcpTool('lore', { url: 'http://127.0.0.1:18901/api/mcp' })).toMatchObject({
      tool: 'lore',
      removable: true,
    })
    expect(
      matchMcpTool('custom', { url: 'https://example.com/api/mcp?client_type=mcp' }),
    ).toMatchObject({ tool: 'lore', removable: true })
    expect(matchMcpTool('my-srv', { args: ['-y', '@mem0/mcp'] })).toMatchObject({
      tool: 'mem0',
      removable: true,
    })
    expect(matchMcpTool('supermemory', { url: 'https://mcp.supermemory.ai' })).toMatchObject({
      tool: 'supermemory',
      removable: true,
    })
    expect(
      matchMcpTool('memory', { command: 'npx', args: ['@modelcontextprotocol/server-memory'] }),
    ).toMatchObject({ tool: 'mcp-memory', removable: true })
    expect(matchMcpTool('cipher', { command: 'npx', args: ['@byterover/cipher'] })).toMatchObject({
      tool: 'cipher',
      removable: true,
    })
    expect(matchMcpTool('memory', { command: 'node', args: ['my-custom.js'] })).toMatchObject({
      tool: 'unknown-memory',
      removable: false,
    })
    expect(matchMcpTool('kioku', { url: 'https://kioku.example.com/v1/mcp' })).toBeNull()
  })
})

describe('跨平台冲突检测与清理', () => {
  it('agy：清理 mcpServers.lore 与 mem0、插件目录/软链，保留 kioku 与其他 MCP，含密钥时不留备份', async () => {
    mkdirSync(env.AGY_HOME, { recursive: true })
    const mcpFile = join(env.AGY_HOME, 'mcp_config.json')
    writeFileSync(
      mcpFile,
      JSON.stringify(
        {
          mcpServers: {
            lore: {
              url: 'http://127.0.0.1:18901/api/mcp?client_type=mcp',
              headers: { Authorization: 'Bearer lm_secret' },
            },
            mem0: { command: 'npx', args: ['mem0-mcp'] },
            kioku: { url: 'https://kioku.example.com/v1/mcp' },
            filesystem: { command: 'npx', args: ['fs'] },
          },
        },
        null,
        2,
      ),
    )

    // 托管的 lore 插件目录 + 非托管目录（应只提示不删）
    const lorePlugin = join(env.AGY_HOME, 'plugins', 'lore')
    mkdirSync(lorePlugin, { recursive: true })
    writeFileSync(join(lorePlugin, 'plugin.json'), JSON.stringify({ name: 'lore' }))
    const unknownMem0 = join(env.AGY_HOME, 'plugins', 'mem0')
    mkdirSync(unknownMem0, { recursive: true })
    writeFileSync(join(unknownMem0, 'readme.txt'), 'custom')

    // 同时在 claude-code 放一个 Lore，验证清理 agy 不会误删 claude-code
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md'), '# lore')

    const items = await scanConflicts('agy', { env, cwd: dir })
    expect(items.filter((i) => i.removable)).toHaveLength(3)
    expect(items.filter((i) => !i.removable)).toHaveLength(1)

    await removeConflicts(
      items.filter((i) => i.removable),
      { env, cwd: dir },
    )

    const saved = JSON.parse(readFileSync(mcpFile, 'utf8'))
    expect(Object.keys(saved.mcpServers)).toEqual(['kioku', 'filesystem'])
    expect(existsSync(`${mcpFile}.kioku-backup`)).toBe(false)
    expect(existsSync(lorePlugin)).toBe(false)
    expect(existsSync(unknownMem0)).toBe(true)
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md'))).toBe(true)
  })

  it('agy：原文件不含密钥时留备份，mcpServers 清空后删掉该键', async () => {
    mkdirSync(env.AGY_HOME, { recursive: true })
    const mcpFile = join(env.AGY_HOME, 'mcp_config.json')
    writeFileSync(
      mcpFile,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { supermemory: { command: 'npx', args: ['@supermemory/mcp'] } },
      }),
    )
    const items = await scanConflicts('agy', { env, cwd: dir })
    await removeConflicts(items, { env, cwd: dir })
    expect(JSON.parse(readFileSync(mcpFile, 'utf8'))).toEqual({ theme: 'dark' })
    expect(existsSync(`${mcpFile}.kioku-backup`)).toBe(true)
  })

  it('gemini：清理 settings.json 里的 mcpServers.lore 与扩展软链', async () => {
    const gDir = join(env.GEMINI_CLI_HOME, '.gemini')
    mkdirSync(join(gDir, 'extensions'), { recursive: true })
    const settingsFile = join(gDir, 'settings.json')
    writeFileSync(
      settingsFile,
      JSON.stringify({
        excludeTools: ['save_memory'],
        mcpServers: { lore: { httpUrl: 'http://127.0.0.1:18901/api/mcp' } },
      }),
    )
    const targetDir = join(dir, 'lore-ext-src')
    mkdirSync(targetDir)
    const extLink = join(gDir, 'extensions', 'lore')
    symlinkSync(targetDir, extLink)

    const items = await scanConflicts('gemini', { env, cwd: dir })
    expect(items).toHaveLength(2)
    await removeConflicts(items, { env, cwd: dir })
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      excludeTools: ['save_memory'],
    })
    expect(existsSync(extLink)).toBe(false)
    expect(existsSync(targetDir)).toBe(true)
  })

  it('claude-code：调 claude 卸载插件与 MCP、清 env、删 lore-guidance.md 与 CLAUDE.md 导入行', async () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const callsFile = join(dir, 'claude-calls.log')
    fakeCommand(
      binDir,
      'claude',
      `const fs = require('node:fs')\nfs.appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(' ') + '\\n')`,
    )
    env.PATH = `${binDir}${delimiter}${process.env.PATH}`

    mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'lore'), { recursive: true })
    const settingsFile = join(env.CLAUDE_CONFIG_DIR, 'settings.json')
    writeFileSync(
      settingsFile,
      JSON.stringify({
        enabledPlugins: { 'lore@lore': true, 'other@org': true },
        env: { LORE_BASE_URL: 'https://lore.example.com', LORE_API_TOKEN: 'lm_x', KEEP_ME: '1' },
      }),
    )
    writeFileSync(
      join(env.CLAUDE_CONFIG_DIR, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          lore: { url: 'http://127.0.0.1:18901/api/mcp' },
          mem: { command: 'npx', args: ['@modelcontextprotocol/server-memory'] },
        },
      }),
    )
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md'), '# guidance')
    const claudeMd = join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md')
    writeFileSync(claudeMd, '@~/.claude/lore-guidance.md\n\n# My rules\nKeep this.\n')

    const items = await scanConflicts('claude-code', { env, cwd: dir })
    expect(items.filter((i) => i.removable).length).toBeGreaterThanOrEqual(6)
    await removeConflicts(items, { env, cwd: dir })

    const calls = readFileSync(callsFile, 'utf8')
    expect(calls).toContain('plugins uninstall lore@lore')
    expect(calls).toContain('mcp remove lore')
    expect(calls).toContain('mcp remove mem')
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      enabledPlugins: { 'other@org': true },
      env: { KEEP_ME: '1' },
    })
    expect(existsSync(`${settingsFile}.kioku-backup`)).toBe(false)
    expect(readFileSync(claudeMd, 'utf8')).toBe('# My rules\nKeep this.\n')
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md'))).toBe(false)
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'lore'))).toBe(false)
  })

  it('codex：按行移除 Lore 插件段与 MCP 段、清理 hooks.json 与缓存目录，保留 kioku 段', async () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const callsFile = join(dir, 'codex-calls.log')
    fakeCommand(
      binDir,
      'codex',
      `const fs = require('node:fs')\nfs.appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(' ') + '\\n')`,
    )
    env.PATH = `${binDir}${delimiter}${process.env.PATH}`

    mkdirSync(join(env.CODEX_HOME, 'plugins', 'lore-local-marketplace'), { recursive: true })
    mkdirSync(join(env.CODEX_HOME, 'hooks', 'lore'), { recursive: true })
    const cfg = join(env.CODEX_HOME, 'config.toml')
    writeFileSync(
      cfg,
      [
        '[features]',
        'memories = false',
        '',
        '[plugins."lore@lore"]',
        'enabled = true',
        '',
        '[mcp_servers.lore]',
        'url = "http://127.0.0.1:18901/api/mcp"',
        '',
        '[mcp_servers.lore.http_headers]',
        'Authorization = "Bearer lm_secret"',
        '',
        '[mcp_servers.kioku]',
        'url = "https://kioku.example.com/v1/mcp"',
        '',
      ].join('\n'),
    )
    const hooksFile = join(env.CODEX_HOME, 'hooks.json')
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ command: 'node /Users/x/.codex/hooks/lore/hooks/recall-inject.mjs' }] },
            { hooks: [{ command: 'node /Users/x/my-hook.mjs' }] },
          ],
        },
      }),
    )

    const items = await scanConflicts('codex', { env, cwd: dir })
    expect(items.filter((i) => i.removable)).toHaveLength(5)
    await removeConflicts(items, { env, cwd: dir })

    const nextToml = readFileSync(cfg, 'utf8')
    expect(nextToml).not.toContain('lore')
    expect(nextToml).toContain('[mcp_servers.kioku]')
    expect(nextToml).toContain('[features]')
    expect(existsSync(`${cfg}.kioku-backup`)).toBe(false)
    expect(JSON.parse(readFileSync(hooksFile, 'utf8'))).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node /Users/x/my-hook.mjs' }] }] },
    })
    expect(existsSync(join(env.CODEX_HOME, 'hooks', 'lore'))).toBe(false)
    expect(readFileSync(callsFile, 'utf8')).toContain('plugin marketplace remove lore')
  })

  it('opencode：校验托管标记才删 lore-memory.js，清理 opencode.json 的 mcp 与 plugin', async () => {
    const pluginsDir = join(env.OPENCODE_CONFIG_DIR, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginFile = join(pluginsDir, 'lore-memory.js')
    writeFileSync(pluginFile, '// user custom plugin without marker')

    const cfgFile = join(env.OPENCODE_CONFIG_DIR, 'opencode.json')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        plugin: ['@loremem/opencode', '@kioku-memory/plugin-opencode'],
        mcp: {
          lore: { type: 'remote', url: 'http://127.0.0.1:18901/api/mcp' },
          keep: { type: 'local' },
        },
      }),
    )

    let items = await scanConflicts('opencode', { env, cwd: dir })
    expect(items.filter((i) => !i.removable)).toHaveLength(1)
    expect(items.filter((i) => i.removable)).toHaveLength(2)
    await removeConflicts(items, { env, cwd: dir })
    expect(existsSync(pluginFile)).toBe(true)
    expect(JSON.parse(readFileSync(cfgFile, 'utf8'))).toEqual({
      plugin: ['@kioku-memory/plugin-opencode'],
      mcp: { keep: { type: 'local' } },
    })

    // 加上托管标记后应能删除
    writeFileSync(pluginFile, '// @lore-managed-opencode-plugin\nexport default {}')
    items = await scanConflicts('opencode', { env, cwd: dir })
    expect(items.every((i) => i.removable)).toBe(true)
    await removeConflicts(items, { env, cwd: dir })
    expect(existsSync(pluginFile)).toBe(false)
  })

  it('opencode：存在 opencode-compat.json 且有 python3 时调用辅助脚本恢复', async () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const pyCalls = join(dir, 'py-calls.log')
    mkdirSync(env.LORE_HOME, { recursive: true })
    const compatState = join(env.LORE_HOME, 'opencode-compat.json')
    const compatHelper = join(env.LORE_HOME, 'opencode-compat.py')
    writeFileSync(compatState, '{}')
    writeFileSync(compatHelper, '# helper')
    fakeCommand(
      binDir,
      'python3',
      `const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(pyCalls)}, process.argv.slice(2).join(' ') + '\\n')
fs.rmSync(${JSON.stringify(compatState)}, { force: true })`,
    )
    env.PATH = `${binDir}${delimiter}${process.env.PATH}`

    const items = await scanConflicts('opencode', { env, cwd: dir })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('compat')
    await removeConflicts(items, { env, cwd: dir })
    expect(readFileSync(pyCalls, 'utf8')).toContain('uninstall --home')
    expect(existsSync(compatState)).toBe(false)
    expect(existsSync(compatHelper)).toBe(false)
  })

  it('openclaw：卸载 lore 插件、重置记忆槽位并清理扩展目录（含调用 openclaw 命令）', async () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const ocCalls = join(dir, 'oc-calls.log')
    const bin = fakeCommand(
      binDir,
      'openclaw',
      `const fs = require('node:fs')\nfs.appendFileSync(${JSON.stringify(ocCalls)}, process.argv.slice(2).join(' ') + '\\n')`,
    )
    env.KIOKU_OPENCLAW_BIN = bin
    env.PATH = `${binDir}${delimiter}${process.env.PATH}`

    const ocDir = join(env.OPENCLAW_HOME, '.openclaw')
    mkdirSync(join(ocDir, 'extensions', 'lore'), { recursive: true })
    const cfgFile = join(ocDir, 'openclaw.json')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        plugins: {
          slots: { memory: 'lore' },
          entries: {
            lore: { enabled: true, config: { apiToken: 'lm_secret' } },
            other: { enabled: true },
          },
        },
      }),
    )
    const items = await scanConflicts('openclaw', { env, cwd: dir })
    expect(items).toHaveLength(2)
    await removeConflicts(items, { env, cwd: dir })
    expect(readFileSync(ocCalls, 'utf8')).toContain('plugins disable lore')
    expect(readFileSync(ocCalls, 'utf8')).toContain('plugins uninstall lore')
    expect(JSON.parse(readFileSync(cfgFile, 'utf8'))).toEqual({
      plugins: {
        slots: { memory: 'memory-core' },
        entries: { other: { enabled: true } },
      },
    })
    expect(existsSync(`${cfgFile}.kioku-backup`)).toBe(false)
    expect(existsSync(join(ocDir, 'extensions', 'lore'))).toBe(false)
  })

  it('pi：仅删除符号链接（保留普通目录并警告），清理 mcp.json 与 packages', async () => {
    mkdirSync(join(env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true })
    const src = join(dir, 'lore-pi-src')
    mkdirSync(src)
    const extLink = join(env.PI_CODING_AGENT_DIR, 'extensions', 'lore')
    symlinkSync(src, extLink)
    writeFileSync(
      join(env.PI_CODING_AGENT_DIR, 'mcp.json'),
      JSON.stringify({ mcpServers: { cipher: { command: 'npx', args: ['@byterover/cipher'] } } }),
    )
    writeFileSync(
      join(env.PI_CODING_AGENT_DIR, 'settings.json'),
      JSON.stringify({
        packages: ['git:github.com/FFatTiger/lore', 'git:github.com/lonelyman0108/kioku-plugins'],
      }),
    )

    const items = await scanConflicts('pi', { env, cwd: dir })
    expect(items.filter((i) => i.removable)).toHaveLength(3)
    await removeConflicts(items, { env, cwd: dir })
    expect(lstatSync(extLink, { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(src)).toBe(true)
    expect(
      JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8')),
    ).toEqual({
      packages: ['git:github.com/lonelyman0108/kioku-plugins'],
    })

    // 若不是软链而是普通目录，只告警不删
    mkdirSync(extLink, { recursive: true })
    const warnItems = await scanConflicts('pi', { env, cwd: dir })
    expect(warnItems).toHaveLength(1)
    expect(warnItems[0].removable).toBe(false)
    await removeConflicts(warnItems, { env, cwd: dir })
    expect(existsSync(extLink)).toBe(true)
  })

  it('dsh：剥离 cordis.patch.yml 里的 Lore 托管块并保留其他行', async () => {
    mkdirSync(env.DSH_HOME, { recursive: true })
    const patchFile = join(env.DSH_HOME, 'cordis.patch.yml')
    writeFileSync(
      patchFile,
      [
        '# >>> lore (managed) >>>',
        '- insert:',
        '    - id: lore-lifecycle',
        '# <<< lore (managed) <<<',
        '',
        '- insert:',
        '    - id: user-plugin',
        '',
      ].join('\n'),
    )
    const items = await scanConflicts('dsh', { env, cwd: dir })
    expect(items).toHaveLength(1)
    await removeConflicts(items, { env, cwd: dir })
    expect(readFileSync(patchFile, 'utf8')).toBe('- insert:\n    - id: user-plugin\n')
  })

  it('hermes：清理 lore_memory 软链、.env 里的 LORE_* 与 provider 配置', async () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const stateFile = join(dir, 'hermes-provider.txt')
    writeFileSync(stateFile, 'lore_memory')
    fakeCommand(
      binDir,
      'hermes',
      `const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'config' && args[1] === 'get') console.log(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
else if (args[0] === 'config' && args[1] === 'set') fs.writeFileSync(${JSON.stringify(stateFile)}, args[3])`,
    )
    env.PATH = `${binDir}${delimiter}${process.env.PATH}`

    mkdirSync(join(env.HERMES_HOME, 'skills'), { recursive: true })
    const skillTarget = join(dir, 'lore-hermes')
    mkdirSync(skillTarget)
    symlinkSync(skillTarget, join(env.HERMES_HOME, 'skills', 'lore_memory'))
    writeFileSync(
      join(env.HERMES_HOME, '.env'),
      'OPENAI_API_KEY=sk-1\nLORE_BASE_URL=http://127.0.0.1:18901\nLORE_API_TOKEN=lm_x\n',
    )

    const items = await scanConflicts('hermes', { env, cwd: dir })
    expect(items.filter((i) => i.removable)).toHaveLength(3)
    await removeConflicts(items, { env, cwd: dir })
    expect(readFileSync(join(env.HERMES_HOME, '.env'), 'utf8')).toBe('OPENAI_API_KEY=sk-1\n')
    expect(readFileSync(stateFile, 'utf8')).toBe('')
  })

  it('removeConflicts：扫描期间被外部改成坏 JSON 时拒绝覆盖并报失败', async () => {
    mkdirSync(env.AGY_HOME, { recursive: true })
    const mcpFile = join(env.AGY_HOME, 'mcp_config.json')
    writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { lore: { url: 'http://127.0.0.1/api/mcp' } } }),
    )
    const items = await scanConflicts('agy', { env, cwd: dir })
    writeFileSync(mcpFile, '{ broken json')
    const results = await removeConflicts(items, { env, cwd: dir })
    expect(results[0].ok).toBe(false)
    expect(readFileSync(mcpFile, 'utf8')).toBe('{ broken json')
    await expect(items[0].remove()).rejects.toThrow(KiokuFailure)
  })
})
