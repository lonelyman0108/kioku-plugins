// Claude Code 这个平台的统一授权、停用自动记忆（autoMemoryEnabled）与诊断。
// 既支持 kioku login / kioku setup claude-code --server-url 把地址与访问密钥写入 ~/.config/kioku/claude-code.json，
// 也兼容只在 Claude Code /plugin 配置里填 CLAUDE_PLUGIN_OPTION_* 的写法；不带地址运行 kioku setup claude-code 时仍只停用自动记忆。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { profileFile, readProfile, removeProfile, writeProfile } from './core.ts'
import { type JsonSettings, readSettings, writeSettings } from './files.ts'
import { resolveTarget } from './target.ts'
import type { Env, InspectCallbacks, PlatformStatus, SetupIo, SetupOptions } from './types.ts'

const TRUTHY = /^(1|true|yes|on)$/i
const PROJECT_SETTINGS = ['.claude/settings.local.json', '.claude/settings.json']
const MARKETPLACE = 'lonelyman0108/kioku-plugins'

export function claudeHome(env: Env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function claudeSettingsFile(env: Env): string {
  return join(claudeHome(env), 'settings.json')
}

async function settingOf(file: string, key: string): Promise<unknown> {
  try {
    const raw = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
    return (JSON.parse(raw) as JsonSettings)?.[key]
  } catch {
    return undefined
  }
}

export function claudePluginActive(settings: JsonSettings | undefined, env: Env): boolean {
  if (env.KIOKU_API_KEY_FILE || (env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()) return true
  const enabled = settings?.enabledPlugins
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return false
  return Object.entries(enabled as Record<string, unknown>).some(
    ([id, on]) => id.startsWith('kioku@') && on === true,
  )
}

export const claudeMemory = {
  name: '自动记忆（auto memory）',
  disable: (settings: JsonSettings): JsonSettings => ({ ...settings, autoMemoryEnabled: false }),
  restore: (settings: JsonSettings): JsonSettings => {
    const rest = { ...settings }
    delete rest.autoMemoryEnabled
    return rest
  },
  changed: ['autoMemoryEnabled'] as const,
  disabledBy: (settings: JsonSettings | undefined, env: Env): string | null => {
    if (TRUTHY.test((env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim())) {
      return '环境变量 CLAUDE_CODE_DISABLE_AUTO_MEMORY'
    }
    return settings?.autoMemoryEnabled === false ? '用户设置' : null
  },
  enabledIn: async (env: Env, cwd: string): Promise<string | null> => {
    if (TRUTHY.test((env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim())) return null
    for (const name of PROJECT_SETTINGS) {
      if ((await settingOf(join(cwd, name), 'autoMemoryEnabled')) === true) return name
    }
    return null
  },
  enabledBy: async (env: Env, cwd: string): Promise<string | null> => {
    const name = await claudeMemory.enabledIn(env, cwd)
    return name ? `项目的 ${name} ` : null
  },
}

function shownSetting(value: unknown): string {
  return value === undefined ? '（未设置）' : JSON.stringify(value)
}

export async function preflightClaudeCode({ env }: { env: Env }): Promise<void> {
  await readSettings(claudeSettingsFile(env))
}

export async function setupClaudeCode(options: SetupOptions, io: SetupIo): Promise<number> {
  const { env, out, cwd } = io
  const file = claudeSettingsFile(env)
  const profile = profileFile('claude-code', env)

  if (options.undo) {
    const { settings, text } = await readSettings(file)
    const next = claudeMemory.restore(settings)
    const changes = claudeMemory.changed.filter(
      (key) => JSON.stringify(settings[key]) !== JSON.stringify(next[key]),
    )
    if (!changes.length) {
      out.write(`Claude Code 的${claudeMemory.name}已启用，${file} 不用改\n`)
    } else {
      out.write(`${file}\n`)
      for (const key of changes) {
        out.write(`  ${key}：${shownSetting(settings[key])} → ${shownSetting(next[key])}\n`)
      }
      if (!options.dryRun) {
        const backedUp = await writeSettings(file, next, text)
        if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
        else if (text !== null) out.write(`${file}.kioku-backup 已有更早的备份，没有覆盖\n`)
        out.write(`Claude Code 的${claudeMemory.name}已启用，新开会话生效\n`)
      }
    }
    const existingProfile = await readProfile('claude-code', env).catch(() => null)
    if (options.dryRun) {
      if (existingProfile) out.write(`${profile}：删掉\n`)
      out.write('没有写入（--dry-run）\n')
      return 0
    }
    if (existingProfile && (await removeProfile('claude-code', env))) {
      out.write(`已删掉 ${profile}\n`)
    }
    const by = claudeMemory.disabledBy(next, env)
    if (by) out.write(`注意：${by}仍然停用着它\n`)
    return 0
  }

  const wantsTarget = Boolean(
    options.requireTarget ||
    options.serverUrl !== undefined ||
    (env.KIOKU_SERVER_URL ?? '').trim() ||
    (env.KIOKU_API_KEY ?? '').trim(),
  )

  let target: { url: string; key: string; saved: { url: string; key: string } | null } | null = null
  if (wantsTarget) {
    await preflightClaudeCode({ env })
    target = await resolveTarget(
      { id: 'claude-code', name: 'Claude Code', runtimeFamily: 'claudecode' },
      options,
      {
        ...io,
        beforeLogin: () => preflightClaudeCode({ env }),
      },
    )
  }

  const { settings, text } = await readSettings(file)
  const next = claudeMemory.disable(settings)
  const changes = claudeMemory.changed.filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(next[key]),
  )
  const sameProfile = target
    ? Boolean(target.saved && target.saved.url === target.url && target.saved.key === target.key)
    : true

  if (!changes.length) {
    out.write(`Claude Code 的${claudeMemory.name}已停用，${file} 不用改\n`)
  } else {
    out.write(`${file}\n`)
    for (const key of changes) {
      out.write(`  ${key}：${shownSetting(settings[key])} → ${shownSetting(next[key])}\n`)
    }
  }
  if (target) {
    if (sameProfile) out.write(`${profile} 不用改\n`)
    else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)
  }

  if (options.dryRun) {
    if (changes.length || target) out.write('没有写入（--dry-run）\n')
    const again = await claudeMemory.enabledBy(env, cwd)
    if (again) out.write(`注意：${again}又启用了它，要在那里一起改\n`)
    return 0
  }

  if (changes.length) {
    const backedUp = await writeSettings(file, next, text)
    if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
    else if (text !== null) out.write(`${file}.kioku-backup 已有更早的备份，没有覆盖\n`)
    out.write(`Claude Code 的${claudeMemory.name}已停用，新开会话生效\n`)
  }
  if (target && !sameProfile) {
    await writeProfile('claude-code', { url: target.url, key: target.key }, env)
  }

  const again = await claudeMemory.enabledBy(env, cwd)
  if (again) out.write(`注意：${again}又启用了它，要在那里一起改\n`)

  if (target) {
    out.write('Claude Code 已配好，新开会话生效。\n')
    if (!claudePluginActive(next, env) && io.hints !== false) {
      out.write(
        `接下来在 Claude Code 里装插件：/plugin install kioku --marketplace ${MARKETPLACE}\n`,
      )
    }
  }
  return 0
}

export async function inspectClaudeCode(
  { env, cwd }: { env: Env; cwd: string },
  { ok, warn }: InspectCallbacks,
): Promise<void> {
  const { settings } = await readSettings(claudeSettingsFile(env))
  if (claudePluginActive(settings, env)) ok('Claude Code 的 kioku 插件已启用')
  else
    warn(
      '用户设置里没有启用 Claude Code 的 kioku 插件：在 Claude Code 里用 /plugin 安装并启用 kioku',
    )

  const by = claudeMemory.disabledBy(settings, env)
  const again = by ? await claudeMemory.enabledBy(env, cwd) : null
  if (again) {
    warn(`Claude Code 的${claudeMemory.name}在${by}里停用了，${again}又启用了它：要在那里一起改`)
  } else if (by) ok(`Claude Code 的${claudeMemory.name}已停用（${by}）`)
  else {
    warn(
      `Claude Code 的${claudeMemory.name}还开着，会和 Kioku 各记一份：运行 kioku setup claude-code 停用它`,
    )
  }
}

export async function statusClaudeCode({
  env,
  cwd,
}: {
  env: Env
  cwd: string
}): Promise<PlatformStatus> {
  let settings: JsonSettings
  try {
    ;({ settings } = await readSettings(claudeSettingsFile(env)))
  } catch {
    return { plugin: null, memory: null }
  }
  const plugin = claudePluginActive(settings, env)
  const reenabledIn = await claudeMemory.enabledIn(env, cwd)
  if (reenabledIn) return { plugin, memory: 'on', reenabledIn }
  return { plugin, memory: claudeMemory.disabledBy(settings, env) ? 'off' : 'on' }
}
