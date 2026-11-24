// OpenCode 这个平台的 kioku setup 与 kioku doctor。
// OpenCode 没有自带的长期记忆要停用，插件会在 config 钩子里按需注册 Kioku 的远程 MCP 服务，
// 所以 setup 做两件事：把服务地址与访问密钥写进本机的文件（只给本人读写），并在 opencode.json 的 plugin 列表里登记插件

import { homedir } from 'node:os'
import { join } from 'node:path'

import { KiokuFailure, profileFile, readProfile, removeProfile, writeProfile } from './core.ts'
import { hasInlineSecret, type JsonSettings, readSettings, safeWrite, serialize } from './files.ts'
import { resolveTarget } from './target.ts'
import type { Env, InspectCallbacks, PlatformStatus, SetupIo, SetupOptions } from './types.ts'

export const OPENCODE_PLUGIN = '@kioku-memory/plugin-opencode'

export function opencodeHome(env: Env): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'opencode')
}

function opencodeConfigFile(env: Env): string {
  return join(opencodeHome(env), 'opencode.json')
}

function isKiokuPlugin(entry: unknown): boolean {
  if (typeof entry !== 'string') return false
  return entry.includes('plugin-opencode') || entry.includes('kioku-plugins')
}

function pluginInstalled(settings: JsonSettings | undefined): boolean {
  return Array.isArray(settings?.plugin) && settings.plugin.some(isKiokuPlugin)
}

function checkPluginShape(settings: JsonSettings, file: string): void {
  if (settings.plugin !== undefined && !Array.isArray(settings.plugin)) {
    throw new KiokuFailure(`${file} 里的 plugin 不是数组，没有改动它`)
  }
}

function ensurePlugin(settings: JsonSettings, add: boolean): JsonSettings {
  const list = Array.isArray(settings?.plugin) ? [...settings.plugin] : []
  if (add) {
    if (list.some(isKiokuPlugin)) return settings
    return { ...settings, plugin: [...list, OPENCODE_PLUGIN] }
  }
  if (!list.some(isKiokuPlugin)) return settings
  const filtered = list.filter((entry) => !isKiokuPlugin(entry))
  const next = { ...settings }
  if (filtered.length) next.plugin = filtered
  else delete next.plugin
  return next
}

export async function preflightOpenCode({ env }: { env: Env }): Promise<void> {
  const file = opencodeConfigFile(env)
  const { settings } = await readSettings(file)
  checkPluginShape(settings, file)
}

export async function setupOpenCode(options: SetupOptions, io: SetupIo): Promise<number> {
  const { env, out } = io
  const profile = profileFile('opencode', env)
  const file = opencodeConfigFile(env)

  if (options.undo) {
    const { settings, text } = await readSettings(file)
    checkPluginShape(settings, file)
    if (pluginInstalled(settings)) {
      const next = ensurePlugin(settings, false)
      out.write(`${file}：从 plugin 中移除 ${OPENCODE_PLUGIN}\n`)
      if (!options.dryRun) {
        await safeWrite(file, serialize(next, text), text, { backup: !hasInlineSecret(text) })
      }
    } else if (text !== null) {
      out.write(`${file} 里没有登记 Kioku 插件，不用改\n`)
    }

    if (options.dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
    else if (await removeProfile('opencode', env)) out.write(`已删掉 ${profile}\n`)
    else out.write(`${profile} 本来就没有\n`)
    return 0
  }

  await preflightOpenCode({ env })
  const { url, key, saved } = await resolveTarget({ id: 'opencode', name: 'OpenCode' }, options, {
    ...io,
    beforeLogin: () => preflightOpenCode({ env }),
  })
  const sameProfile = Boolean(saved && saved.url === url && saved.key === key)
  if (sameProfile) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)

  const { settings, text } = await readSettings(file)
  checkPluginShape(settings, file)
  const needPlugin = !pluginInstalled(settings)
  if (needPlugin) out.write(`${file}：在 plugin 中加入 ${OPENCODE_PLUGIN}\n`)
  else out.write(`${file} 不用改\n`)

  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }

  if (!sameProfile) await writeProfile('opencode', { url, key }, env)
  if (needPlugin) {
    const backedUp = await safeWrite(file, serialize(ensurePlugin(settings, true), text), text, {
      backup: !hasInlineSecret(text),
    })
    if (backedUp) out.write(`原配置已备份到 ${file}.kioku-backup\n`)
  }
  out.write('OpenCode 已配好，重启 OpenCode 后生效。\n')
  return 0
}

export async function inspectOpenCode(
  { env, cwd }: { env: Env; cwd: string },
  { ok, warn }: InspectCallbacks,
): Promise<void> {
  const profile = await readProfile('opencode', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup opencode 写下的地址与访问密钥，插件不会生效：运行 kioku setup opencode')
  }

  const user = await readSettings(opencodeConfigFile(env))
  const local = await readSettings(join(cwd, 'opencode.json')).catch(() => ({
    settings: undefined,
  }))
  if (pluginInstalled(user.settings) || pluginInstalled(local.settings)) {
    ok('OpenCode 里登记了 kioku 插件')
  } else {
    warn(
      `OpenCode 里没有登记 kioku 插件：运行 kioku setup opencode，或在 opencode.json 中加入 ${OPENCODE_PLUGIN}`,
    )
  }

  for (const [name, cfg] of [
    [opencodeConfigFile(env), user.settings],
    [join(cwd, 'opencode.json'), local.settings],
  ] as [string, JsonSettings | undefined][]) {
    if (cfg?.mcp && typeof cfg.mcp === 'object' && Object.hasOwn(cfg.mcp, 'kioku')) {
      warn(`${name} 里自己写了 mcp.kioku，它会覆盖插件注册的地址与访问密钥：建议去掉它`)
    }
  }
  ok('OpenCode 没有自带的长期记忆要停用')
}

export async function statusOpenCode({
  env,
  cwd,
}: {
  env: Env
  cwd: string
}): Promise<PlatformStatus> {
  const user = await readSettings(opencodeConfigFile(env)).catch(() => ({ settings: undefined }))
  const local = await readSettings(join(cwd, 'opencode.json')).catch(() => ({
    settings: undefined,
  }))
  return {
    plugin: pluginInstalled(user.settings) || pluginInstalled(local.settings),
    memory: 'none',
  }
}
