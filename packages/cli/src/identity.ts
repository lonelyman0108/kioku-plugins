// 零配置命令身份解析（kioku search / get / ls / add 等日常命令共用）：
// --platform 指定客户端 → 环境变量 KIOKU_SERVER_URL/KIOKU_API_KEY → ~/.config/kioku/cli.json 默认身份
// → 本机仅有一个已配置客户端时自动选用 → 多个客户端时在终端交互选择（非终端提示用 --platform）。

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { KiokuFailure, UsageError, loadConfig, profileDir, serverUrlProblem } from './core.ts'
import { readText, safeWrite } from './files.ts'
import { platformNames, PLATFORMS } from './platforms.ts'
import { isCancel, loadPrompts } from './prompts.ts'
import type { Env, Reader, SavedProfile, TargetConfig, Writer } from './types.ts'

export interface CliPreferences {
  defaultPlatform?: string
  serverUrl?: string
}

export interface ResolvedIdentity {
  config: TargetConfig
  source: string
  platform?: string
}

export function isInteractiveTty(stdin?: Reader, out?: Writer & { isTTY?: boolean }): boolean {
  return Boolean(stdin?.isTTY && out?.isTTY && typeof stdin?.setRawMode === 'function')
}

export function cliPreferencesFile(env: Env = process.env): string {
  return join(profileDir(env), 'cli.json')
}

export async function readCliPreferences(env: Env = process.env): Promise<CliPreferences> {
  const file = cliPreferencesFile(env)
  const raw = await readText(file).catch(() => null)
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const obj = parsed as Record<string, unknown>
    const prefs: CliPreferences = {}
    if (typeof obj.defaultPlatform === 'string' && obj.defaultPlatform) {
      prefs.defaultPlatform = obj.defaultPlatform
    }
    if (typeof obj.serverUrl === 'string') {
      const clean = obj.serverUrl.trim().replace(/\/+$/, '')
      if (clean && !serverUrlProblem(clean)) prefs.serverUrl = clean
    }
    return prefs
  } catch {
    return {}
  }
}

export async function writeCliPreferences(
  prefs: CliPreferences,
  env: Env = process.env,
): Promise<void> {
  const file = cliPreferencesFile(env)
  const existing = await readText(file).catch(() => null)
  const body = `${JSON.stringify(prefs, null, 2)}\n`
  await mkdir(profileDir(env), { recursive: true, mode: 0o700 })
  await safeWrite(file, body, existing, { backup: false })
}

export async function rememberServerUrl(url: string, env: Env = process.env): Promise<void> {
  const clean = url.trim().replace(/\/+$/, '')
  if (!clean || serverUrlProblem(clean)) return
  const current = await readCliPreferences(env)
  if (current.serverUrl === clean) return
  await writeCliPreferences({ ...current, serverUrl: clean }, env)
}

function supportedPlatformList(): string {
  return Object.entries(PLATFORMS)
    .filter(([, p]) => Boolean(p.readConfig))
    .map(([id]) => id)
    .join('、')
}

export async function resolveIdentity({
  platform,
  env = process.env,
  stdin = process.stdin,
  out = process.stdout,
}: {
  platform?: string
  env?: Env
  stdin?: Reader
  out?: Writer & { isTTY?: boolean; columns?: number }
} = {}): Promise<ResolvedIdentity> {
  if (platform !== undefined) {
    if (!Object.hasOwn(PLATFORMS, platform) || !PLATFORMS[platform].readConfig) {
      throw new UsageError(
        `--platform 只收本机保存了配置的客户端，可以用的：${supportedPlatformList()}（全部平台：${platformNames()}）`,
      )
    }
    const cfg = await PLATFORMS[platform].readConfig(env)
    if (!cfg) {
      throw new KiokuFailure(`尚未配置 ${platform}：先运行 kioku connect ${platform}`)
    }
    return {
      config: { url: cfg.url, key: cfg.key },
      source: `platform:${platform}`,
      platform,
    }
  }

  if (
    (env.KIOKU_SERVER_URL ?? '').trim() &&
    ((env.KIOKU_API_KEY ?? '').trim() || (env.KIOKU_API_KEY_FILE ?? '').trim())
  ) {
    const cfg = await loadConfig(env)
    return { config: cfg, source: 'env' }
  }

  const prefs = await readCliPreferences(env)
  if (prefs.defaultPlatform && PLATFORMS[prefs.defaultPlatform]?.readConfig) {
    const cfg = await PLATFORMS[prefs.defaultPlatform].readConfig!(env).catch(() => null)
    if (cfg) {
      return {
        config: { url: cfg.url, key: cfg.key },
        source: `default:${prefs.defaultPlatform}`,
        platform: prefs.defaultPlatform,
      }
    }
  }

  const configured: Array<{ id: string; name: string; config: SavedProfile }> = []
  for (const [id, desc] of Object.entries(PLATFORMS)) {
    if (!desc.readConfig) continue
    const cfg = await desc.readConfig(env).catch(() => null)
    if (cfg) configured.push({ id, name: desc.name, config: cfg })
  }

  if (!configured.length) {
    throw new KiokuFailure(
      '尚未配置客户端或环境变量：先运行 kioku connect，或设置 KIOKU_SERVER_URL 与 KIOKU_API_KEY',
    )
  }

  if (configured.length === 1) {
    const only = configured[0]
    return {
      config: { url: only.config.url, key: only.config.key },
      source: `auto:${only.id}`,
      platform: only.id,
    }
  }

  if (!isInteractiveTty(stdin, out)) {
    throw new KiokuFailure(
      `检测到多个已配置客户端（${configured.map((c) => c.id).join('、')}），请用 --platform <平台> 指定`,
    )
  }

  const ui = await loadPrompts({ input: stdin, output: out, env })
  if (!ui) {
    throw new KiokuFailure(
      `检测到多个已配置客户端（${configured.map((c) => c.id).join('、')}），请用 --platform <平台> 指定`,
    )
  }

  const chosen = await ui.select({
    message: '选择要使用的客户端身份',
    options: configured.map((item) => ({
      value: item.id,
      label: item.name,
      hint: item.id,
    })),
  })
  if (isCancel(chosen) || typeof chosen !== 'string') {
    throw new KiokuFailure('操作已取消')
  }

  const matched = configured.find((c) => c.id === chosen)
  if (!matched) throw new KiokuFailure(`未找到 ${chosen} 的配置`)

  // 记住本次选定的默认身份，后续无需重复选择
  await writeCliPreferences({ ...prefs, defaultPlatform: chosen }, env).catch(() => {})
  return {
    config: { url: matched.config.url, key: matched.config.key },
    source: `selected:${chosen}`,
    platform: chosen,
  }
}
