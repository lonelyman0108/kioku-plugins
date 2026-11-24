// 检测本机遗留的旧版 Kioku 插件、旧插件市场来源与旧版 MCP 工具清单缓存，并提供清理动作。
// 只在迁移与诊断时调用：不主动修改与 Kioku 无关的插件或配置

import { readFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { agyHome } from './agy.ts'
import { claudeHome } from './claudeCode.ts'
import { codexHome } from './codex.ts'
import { capture, hasCommand, plain, removeToolCache, toolCacheFile } from './core.ts'
import { dshHome } from './dsh.ts'
import { readSettings, writeSettings } from './files.ts'
import { geminiHome } from './gemini.ts'
import { hermesHome } from './hermes.ts'
import { resolvePlatformCommand } from './panel.ts'
import { OPENCODE_PLUGIN, opencodeHome } from './opencode.ts'
import { piHome } from './pi.ts'
import type { Env } from './types.ts'

const CLI_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const LEGACY_TOOL_NAMES = new Set(['kioku_list', 'kioku_move', 'kioku_read', 'kioku_write'])

export interface LegacyPluginFindings {
  legacySource: string | null
  outdatedPlugin: string | null
  staleToolCache: boolean
  manualInstallDir?: string
  legacyMarketplaces?: string[]
  legacyPiPackages?: string[]
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function readJsonOrNull(file: string): Promise<unknown> {
  const text = await readTextOrNull(file)
  if (!text) return null
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch {
    return null
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function pointsToOldKiokuRepo(value: unknown): boolean {
  if (!value) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.includes('lonelyman0108/kioku') && !text.includes('kioku-plugins')
}

function collectLegacyMarketplaces(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const out: string[] = []
  for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
    if (pointsToOldKiokuRepo(entry)) out.push(name)
  }
  return out
}

function collectInstallPaths(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const record = data as Record<string, unknown>
  const container =
    record.plugins && typeof record.plugins === 'object' && !Array.isArray(record.plugins)
      ? (record.plugins as Record<string, unknown>)
      : record
  const paths: string[] = []
  for (const [id, value] of Object.entries(container)) {
    if (!id.toLowerCase().startsWith('kioku@')) continue
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      if (item && typeof item === 'object') {
        const p = (item as { installPath?: unknown }).installPath
        if (typeof p === 'string' && p) paths.push(p)
      }
    }
  }
  return paths
}

function isLegacyOpencodeEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  if (pointsToOldKiokuRepo(entry)) return true
  return /^@kioku-memory\/plugin-opencode@0\.[0-5](?:\.|$|-)/.test(entry.trim())
}

async function hasLegacyLifecycle(dir: string): Promise<boolean> {
  const lifecycle = await readTextOrNull(join(dir, 'lib', 'lifecycle.mjs'))
  return lifecycle !== null && !lifecycle.includes('deviceKeyOf')
}

async function detectOpencodeLegacy(
  env: Env,
  cwd: string,
): Promise<{ legacySource: string | null; outdatedPlugin: string | null }> {
  let legacySource: string | null = null
  let hasUnpinned = false
  for (const file of [join(opencodeHome(env), 'opencode.json'), join(cwd, 'opencode.json')]) {
    const { settings } = await readSettings(file).catch(() => ({ settings: undefined }))
    const list = Array.isArray(settings?.plugin) ? settings.plugin : []
    const found = list.find(isLegacyOpencodeEntry)
    if (found && !legacySource) legacySource = `旧插件来源 ${plain(found)}`
    if (list.some((entry) => typeof entry === 'string' && entry.trim() === OPENCODE_PLUGIN)) {
      hasUnpinned = true
    }
  }
  let outdatedPlugin: string | null = null
  if (hasUnpinned) {
    const cacheRoot = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'opencode')
    for (const root of [opencodeHome(env), cwd, cacheRoot]) {
      const pkgDir = join(root, 'node_modules', '@kioku-memory', 'plugin-opencode')
      const pkgJson = (await readJsonOrNull(join(pkgDir, 'package.json'))) as {
        version?: unknown
      } | null
      if (
        (typeof pkgJson?.version === 'string' && compareSemver(pkgJson.version, '0.6.0') < 0) ||
        (await hasLegacyLifecycle(pkgDir))
      ) {
        outdatedPlugin = '旧版本 OpenCode 插件'
        break
      }
    }
  }
  return { legacySource, outdatedPlugin }
}

async function detectDshLegacy(
  env: Env,
): Promise<{ legacySource: string | null; outdatedPlugin: string | null }> {
  let legacySource: string | null = null
  let outdatedPlugin: string | null = null
  const profilesRoot = join(dshHome(env), 'profiles')
  const names = await readdir(profilesRoot).catch(() => [] as string[])
  for (const name of names.sort()) {
    const profileDir = join(profilesRoot, name)
    const pkg = (await readJsonOrNull(join(profileDir, 'package.json'))) as {
      dependencies?: Record<string, unknown>
    } | null
    const deps = pkg?.dependencies ?? {}
    for (const [depName, depSpec] of Object.entries(deps)) {
      if (
        (depName.includes('kioku') || pointsToOldKiokuRepo(depSpec)) &&
        pointsToOldKiokuRepo(depSpec)
      ) {
        legacySource = `旧 DeepSeek Harness 插件来源 ${plain(depSpec)}`
        break
      }
    }
    const pluginDir = join(profileDir, 'node_modules', 'kioku-plugins', 'plugins', 'dsh')
    if (await hasLegacyLifecycle(pluginDir)) {
      outdatedPlugin = '重构前的 DeepSeek Harness 插件'
    }
  }
  return { legacySource, outdatedPlugin }
}

async function detectPiLegacy(
  env: Env,
  cwd: string,
): Promise<{ source: string | null; packages: string[] }> {
  const packages: string[] = []
  for (const file of [join(piHome(env), 'settings.json'), join(cwd, '.pi', 'settings.json')]) {
    const { settings } = await readSettings(file).catch(() => ({ settings: undefined }))
    const list = Array.isArray(settings?.packages) ? settings.packages : []
    for (const entry of list) {
      const src = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source
      if (typeof src === 'string' && pointsToOldKiokuRepo(src)) packages.push(src)
    }
  }
  return {
    source: packages.length ? `旧扩展来源 ${plain(packages[0]!)}` : null,
    packages,
  }
}

async function hasLegacyToolsInCache(
  id: string,
  env: Env,
): Promise<{ exists: boolean; legacy: boolean }> {
  const file = toolCacheFile(id, env)
  const st = await lstat(file).catch(() => null)
  if (!st?.isFile()) return { exists: false, legacy: false }
  const data = (await readJsonOrNull(file)) as { tools?: Array<{ name?: unknown }> } | null
  const legacy =
    Array.isArray(data?.tools) &&
    data.tools.some((t) => typeof t?.name === 'string' && LEGACY_TOOL_NAMES.has(t.name))
  return { exists: true, legacy }
}

// 扫描单个平台上是否存在重构之前的插件、旧市场来源或旧工具清单缓存
export async function detectLegacyPlugin(
  id: string,
  { env, cwd = process.cwd() }: { env: Env; cwd?: string },
): Promise<LegacyPluginFindings> {
  let legacySource: string | null = null
  let outdatedPlugin: string | null = null
  let manualInstallDir: string | undefined
  let legacyMarketplaces: string[] | undefined
  let legacyPiPackages: string[] | undefined

  if (id === 'claude-code') {
    const markets = await readJsonOrNull(
      join(claudeHome(env), 'plugins', 'known_marketplaces.json'),
    )
    const found = collectLegacyMarketplaces(markets)
    if (found.length) {
      legacyMarketplaces = found
      legacySource = '旧插件市场来源 lonelyman0108/kioku'
    }
    const installed = await readJsonOrNull(
      join(claudeHome(env), 'plugins', 'installed_plugins.json'),
    )
    for (const installPath of collectInstallPaths(installed)) {
      const lifecycle = await readTextOrNull(join(installPath, 'lib', 'lifecycle.mjs'))
      if (lifecycle !== null && !lifecycle.includes('deviceKeyOf')) {
        outdatedPlugin = '重构前的 Claude Code 插件'
        break
      }
    }
  } else if (id === 'codex') {
    const markets = await readJsonOrNull(join(codexHome(env), 'plugins', 'known_marketplaces.json'))
    const found = collectLegacyMarketplaces(markets)
    if (found.length) {
      legacyMarketplaces = found
      legacySource = '旧插件市场来源 lonelyman0108/kioku'
    }
    const installed = await readJsonOrNull(
      join(codexHome(env), 'plugins', 'installed_plugins.json'),
    )
    for (const installPath of collectInstallPaths(installed)) {
      if (await hasLegacyLifecycle(installPath)) {
        outdatedPlugin = '重构前的 Codex 插件'
        break
      }
    }
  } else if (id === 'opencode') {
    const opencodeFound = await detectOpencodeLegacy(env, cwd)
    legacySource = opencodeFound.legacySource
    outdatedPlugin = opencodeFound.outdatedPlugin
  } else if (id === 'pi') {
    const piFound = await detectPiLegacy(env, cwd)
    legacySource = piFound.source
    if (piFound.packages.length) legacyPiPackages = piFound.packages
    if (await hasLegacyLifecycle(join(piHome(env), 'extensions', 'kioku'))) {
      outdatedPlugin = '重构前的 pi 插件'
    }
  } else if (id === 'dsh') {
    const dshFound = await detectDshLegacy(env)
    legacySource = dshFound.legacySource
    outdatedPlugin = dshFound.outdatedPlugin
  } else if (id === 'agy') {
    const targetDir = join(agyHome(env), 'plugins', 'kioku')
    const st = await lstat(targetDir).catch(() => null)
    if (st?.isDirectory()) {
      const marker = (await readJsonOrNull(join(targetDir, '.kioku-managed.json'))) as {
        managedBy?: unknown
        version?: unknown
      } | null
      const managed = marker?.managedBy === '@kioku-memory/cli'
      if (!managed) manualInstallDir = targetDir
      const lifecycle = await readTextOrNull(join(targetDir, 'lib', 'lifecycle.mjs'))
      if (lifecycle !== null && !lifecycle.includes('deviceKeyOf')) {
        outdatedPlugin = '重构前的 Antigravity 插件'
      } else if (
        managed &&
        typeof marker?.version === 'string' &&
        compareSemver(marker.version, CLI_VERSION) < 0
      ) {
        outdatedPlugin = `旧版本 Antigravity 插件（${plain(marker.version)}）`
      }
    }
  } else if (id === 'gemini') {
    const lifecycle = await readTextOrNull(
      join(geminiHome(env), 'extensions', 'kioku', 'lib', 'lifecycle.mjs'),
    )
    if (lifecycle !== null && !lifecycle.includes('deviceKeyOf')) {
      outdatedPlugin = '重构前的 Gemini CLI 扩展'
    }
  } else if (id === 'hermes') {
    const bridge = await readTextOrNull(
      join(hermesHome(env), 'plugins', 'kioku', 'kioku_bridge.py'),
    )
    if (bridge !== null && !bridge.includes('deviceKey')) {
      outdatedPlugin = '重构前的 Hermes 记忆插件'
    }
  } else if (id === 'openclaw') {
    const clawExt = join(env.OPENCLAW_HOME || homedir(), '.openclaw', 'extensions', 'kioku')
    const pkgJson = (await readJsonOrNull(join(clawExt, 'package.json'))) as {
      version?: unknown
    } | null
    if (
      (await hasLegacyLifecycle(clawExt)) ||
      (typeof pkgJson?.version === 'string' && compareSemver(pkgJson.version, '0.6.0') < 0)
    ) {
      outdatedPlugin = '旧版本 OpenClaw 插件'
    }
  }

  const cache = await hasLegacyToolsInCache(id, env)
  if (id === 'openclaw' && cache.legacy) {
    outdatedPlugin = '包含旧版工具清单的 OpenClaw 插件缓存'
  }

  return {
    legacySource,
    outdatedPlugin,
    staleToolCache: cache.legacy,
    ...(manualInstallDir ? { manualInstallDir } : {}),
    ...(legacyMarketplaces ? { legacyMarketplaces } : {}),
    ...(legacyPiPackages ? { legacyPiPackages } : {}),
  }
}

export async function toolCacheExists(id: string, env: Env): Promise<boolean> {
  return Boolean((await lstat(toolCacheFile(id, env)).catch(() => null))?.isFile())
}

export interface LegacyRemovalResult {
  removed: boolean
  notes: string[]
  manualCommands: string[]
}

// 卸载旧版插件市场来源或旧插件条目
export async function removeLegacySource(
  id: string,
  findings: LegacyPluginFindings,
  { env, cwd = process.cwd() }: { env: Env; cwd?: string },
): Promise<LegacyRemovalResult> {
  const notes: string[] = []
  const manualCommands: string[] = []
  let removed = false

  if (id === 'claude-code' && findings.legacySource) {
    const bin = resolvePlatformCommand('claude-code', env) ?? 'claude'
    const marketplaces = findings.legacyMarketplaces?.length
      ? findings.legacyMarketplaces
      : ['kioku']
    if (hasCommand(bin, env)) {
      await capture(bin, ['plugin', 'uninstall', 'kioku@kioku'], env, { timeout: 30_000 })
      let allOk = true
      for (const m of marketplaces) {
        const res = await capture(bin, ['plugin', 'marketplace', 'remove', m], env, {
          timeout: 30_000,
        })
        if (!res.ok) allOk = false
      }
      if (allOk) {
        removed = true
        notes.push(
          `已移除 Claude Code 旧插件市场来源（${marketplaces.map((m) => plain(m)).join('、')}）`,
        )
      } else {
        manualCommands.push(...marketplaces.map((m) => `/plugin marketplace remove ${plain(m)}`))
        notes.push('未能自动移除 Claude Code 旧插件市场来源，请在会话内手动移除')
      }
    } else {
      manualCommands.push('/plugin uninstall kioku@kioku', '/plugin marketplace remove kioku')
      notes.push('未找到 claude 命令，请在 Claude Code 会话内先移除旧插件市场来源')
    }
  } else if (id === 'codex' && findings.legacySource) {
    const bin = resolvePlatformCommand('codex', env) ?? 'codex'
    const marketplaces = findings.legacyMarketplaces?.length
      ? findings.legacyMarketplaces
      : ['kioku']
    if (hasCommand(bin, env)) {
      let allOk = true
      for (const m of marketplaces) {
        const res = await capture(bin, ['plugin', 'marketplace', 'remove', m], env, {
          timeout: 30_000,
        })
        if (!res.ok) allOk = false
      }
      if (allOk) {
        removed = true
        notes.push(`已移除 Codex 旧插件市场来源（${marketplaces.map((m) => plain(m)).join('、')}）`)
      } else {
        manualCommands.push(
          ...marketplaces.map((m) => `codex plugin marketplace remove ${plain(m)}`),
        )
        notes.push('未能自动移除 Codex 旧插件市场来源，请手动执行移除命令')
      }
    } else {
      manualCommands.push('codex plugin marketplace remove kioku')
      notes.push('未找到 codex 命令，请手动移除旧插件市场来源')
    }
  } else if (id === 'opencode' && findings.legacySource) {
    for (const file of [join(opencodeHome(env), 'opencode.json'), join(cwd, 'opencode.json')]) {
      const loaded = await readSettings(file).catch(() => null)
      if (!loaded || loaded.text === null || !Array.isArray(loaded.settings.plugin)) continue
      if (!loaded.settings.plugin.some(isLegacyOpencodeEntry)) continue
      const replaced = loaded.settings.plugin.map((entry) =>
        isLegacyOpencodeEntry(entry) ? OPENCODE_PLUGIN : entry,
      )
      const deduped = [...new Set(replaced)]
      await writeSettings(file, { ...loaded.settings, plugin: deduped }, loaded.text)
      removed = true
      notes.push(`已将 ${plain(file)} 中的旧插件来源替换为 ${OPENCODE_PLUGIN}`)
    }
  } else if (id === 'pi' && findings.legacyPiPackages?.length) {
    const bin = resolvePlatformCommand('pi', env) ?? 'pi'
    if (hasCommand(bin, env)) {
      let allOk = true
      for (const pkg of findings.legacyPiPackages) {
        const res = await capture(bin, ['remove', pkg], env, { timeout: 30_000 })
        if (!res.ok) allOk = false
      }
      if (allOk) {
        removed = true
        notes.push('已移除 pi 旧版扩展来源')
      } else {
        manualCommands.push(...findings.legacyPiPackages.map((pkg) => `pi remove ${plain(pkg)}`))
        notes.push('未能自动移除 pi 旧版扩展，请手动执行')
      }
    } else {
      manualCommands.push(...findings.legacyPiPackages.map((pkg) => `pi remove ${plain(pkg)}`))
      notes.push('未找到 pi 命令，请手动移除旧版扩展')
    }
  }

  return { removed, notes, manualCommands }
}

export async function clearLegacyToolCache(id: string, env: Env): Promise<boolean> {
  if (!(await toolCacheExists(id, env))) return false
  await removeToolCache(id, env)
  return true
}
