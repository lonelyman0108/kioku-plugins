// ZCode 这个平台的 kioku setup 与 kioku doctor。
// 插件通过 ZCode 插件市场安装并自带 stdio MCP 桥接与生命周期钩子，地址与访问密钥统一读本机配置文件
// （~/.config/kioku/zcode.json），不把访问密钥写进插件清单或命令行参数。

import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { plain, profileDir, profileFile, readProfile, removeProfile, writeProfile } from './core.ts'
import { type JsonSettings, readSettings } from './files.ts'
import { resolveTarget } from './target.ts'
import type { Env, InspectCallbacks, PlatformStatus, SetupIo, SetupOptions } from './types.ts'

export function zcodeHome(env: Env): string {
  if (env.ZCODE_HOME) return env.ZCODE_HOME
  if (env.ZCODE_DATA_BASE_DIR) return env.ZCODE_DATA_BASE_DIR
  return join(env.HOME || env.USERPROFILE || homedir(), '.zcode')
}

export function zcodeConfigFile(env: Env): string {
  return join(zcodeHome(env), 'cli', 'config.json')
}

export function bundledZcodeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const packaged = resolve(here, '..', 'assets', 'plugins', 'zcode')
  if (existsSync(packaged)) return packaged
  return resolve(here, '..', '..', '..', 'plugins', 'zcode')
}

function enabledMapsOf(settings: JsonSettings | undefined): Record<string, unknown>[] {
  const maps: Record<string, unknown>[] = []
  const nested = (settings?.plugins as { enabledPlugins?: unknown } | undefined)?.enabledPlugins
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    maps.push(nested as Record<string, unknown>)
  }
  const top = settings?.enabledPlugins
  if (top && typeof top === 'object' && !Array.isArray(top)) {
    maps.push(top as Record<string, unknown>)
  }
  return maps
}

function hasEnabledInstalledEntry(installed: JsonSettings | undefined): boolean {
  if (!installed || typeof installed !== 'object') return false
  const container =
    installed.plugins && typeof installed.plugins === 'object' && !Array.isArray(installed.plugins)
      ? (installed.plugins as Record<string, unknown>)
      : installed
  return Object.entries(container).some(([id, value]) => {
    if (!id.toLowerCase().startsWith('kioku@')) return false
    const items = Array.isArray(value) ? value : [value]
    return items.some((item) => {
      if (!item || typeof item !== 'object') return true
      return (item as { enabled?: unknown }).enabled !== false
    })
  })
}

export async function zcodePluginActive(env: Env): Promise<boolean> {
  const { settings } = await readSettings(zcodeConfigFile(env)).catch(() => ({
    settings: undefined,
  }))
  const maps = enabledMapsOf(settings)
  if (maps.length) {
    const entries = maps.flatMap((map) =>
      Object.entries(map).filter(([id]) => id.toLowerCase().startsWith('kioku@')),
    )
    if (entries.length) return entries.some(([, on]) => on === true)
    // config.json 已显式维护 enabledPlugins 映射但未包含 kioku@* 时，不能仅凭安装记录判定已启用
    return false
  }
  const installedFile = join(zcodeHome(env), 'cli', 'plugins', 'installed_plugins.json')
  const { settings: installed } = await readSettings(installedFile).catch(() => ({
    settings: undefined,
  }))
  return hasEnabledInstalledEntry(installed)
}

async function removeManagedZcodeBundleIfUnused(env: Env): Promise<boolean> {
  if (await zcodePluginActive(env)) return false
  const targetDir = join(profileDir(env), 'plugins', 'zcode')
  try {
    const raw = await readFile(join(targetDir, '.kioku-managed.json'), 'utf8')
    const parsed = JSON.parse(raw) as { managedBy?: unknown } | null
    if (parsed?.managedBy !== '@kioku-memory/cli') return false
  } catch {
    return false
  }
  await rm(targetDir, { recursive: true, force: true })
  return true
}

function zcodeInstallHint(env: Env): string {
  const persistent = join(profileDir(env), 'plugins', 'zcode')
  if (existsSync(join(persistent, 'marketplace.json'))) {
    const quoted = /\s/.test(persistent) ? `"${persistent}"` : persistent
    return `运行 kioku connect zcode 自动启用，或手动运行：\n  zcode plugins marketplace add ${plain(quoted)}\n  zcode plugins install kioku@kioku\n  zcode plugins enable kioku@kioku`
  }
  return '运行 kioku connect zcode 自动安装并启用插件（或克隆 lonelyman0108/kioku-plugins 后对 plugins/zcode 执行 zcode plugins marketplace add / install / enable）'
}

export async function setupZcode(options: SetupOptions, io: SetupIo): Promise<number> {
  const { env, out } = io
  const profile = profileFile('zcode', env)

  if (options.undo) {
    if (options.dryRun) {
      out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
      return 0
    }
    if (await removeProfile('zcode', env)) out.write(`已删掉 ${profile}\n`)
    else out.write(`${profile} 本来就没有\n`)
    await rm(join(profileDir(env), 'zcode-state'), { recursive: true, force: true }).catch(() => {})
    if (await zcodePluginActive(env)) {
      out.write(
        '插件要另外卸载：zcode plugins uninstall kioku@kioku && zcode plugins marketplace remove kioku\n',
      )
    } else if (await removeManagedZcodeBundleIfUnused(env)) {
      out.write(`已清理托管的 ZCode 插件缓存目录 ${join(profileDir(env), 'plugins', 'zcode')}\n`)
    }
    return 0
  }

  const { url, key, saved } = await resolveTarget({ id: 'zcode', name: 'ZCode' }, options, io)
  const same = Boolean(saved && saved.url === url && saved.key === key)
  if (same) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!same) await writeProfile('zcode', { url, key }, env)
  out.write('ZCode 已配好，重启 ZCode 或新开会话生效。\n')
  if (!(await zcodePluginActive(env)) && io.hints !== false) {
    out.write(`接下来安装并启用插件：${zcodeInstallHint(env)}\n`)
  }
  return 0
}

export async function inspectZcode(
  { env }: { env: Env },
  { ok, warn, note }: InspectCallbacks,
): Promise<void> {
  const profile = await readProfile('zcode', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup zcode 写下的地址与访问密钥，插件不会生效：运行 kioku setup zcode')
  }
  if (await zcodePluginActive(env)) {
    ok('ZCode 的 kioku 插件已启用')
  } else {
    warn(`ZCode 的 kioku 插件未启用：${zcodeInstallHint(env)}`)
  }
  note('如在 ZCode 设置里开启了自带工作区记忆，建议关闭以避免与 Kioku 重复记录')
}

export async function statusZcode({ env }: { env: Env }): Promise<PlatformStatus> {
  return { plugin: await zcodePluginActive(env), memory: 'none' }
}
