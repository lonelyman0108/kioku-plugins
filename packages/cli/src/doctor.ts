// kioku doctor：检查地址与访问密钥能不能用、访问密钥的权限，以及平台这一边配好没有。
// 每项一行：✓ 正常，! 要留意，✗ 有问题；有 ✗ 时退出码为 1

import { whoami } from './api.ts'
import { scanConflicts } from './conflicts.ts'
import {
  KiokuFailure,
  NotConfigured,
  UsageError,
  failureText,
  keyFormatError,
  loadConfig,
  plain,
  serverUrlProblem,
  shownUrl,
} from './core.ts'
import { detectPlatform, platformNames, PLATFORMS } from './platforms.ts'
import type { Env, SavedProfile, TargetConfig, WhoamiResponse, Writer } from './types.ts'

export const DOCTOR_USAGE = `用法：kioku doctor [平台]

检查 Kioku 的地址与访问密钥、访问密钥的权限，以及平台的配置（插件是否启用、自带的长期记忆是否已停用）。

  [平台]  ${platformNames()}；不写时按当前所在的会话认，认不出就只查地址与访问密钥

有问题的项以 ✗ 开头，这时退出码为 1。
`

// 与管理界面的用词一致
const LAYERS: Record<string, string> = {
  core: '通用',
  persona: '人格',
  app: '应用',
  user: '本人',
  subject: '联系人',
  episode: '会话',
}
const SENSITIVITIES: Record<string, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}
const CAPABILITIES: Record<string, string> = { none: '不可用', use: '取用', manage: '管理' }

function named(names: Record<string, string>, value: string | undefined): string {
  const key = value ?? ''
  return Object.hasOwn(names, key) ? names[key] : plain(key)
}

function layersText(layers: string[] | undefined): string {
  if (!Array.isArray(layers) || !layers.length) return '无'
  return layers.map((layer) => named(LAYERS, layer)).join('、')
}

export function parseDoctorArgs(argv: string[]): { platform: string | null } {
  const names: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    names.push(arg)
  }
  if (names.length > 1) throw new UsageError('最多写一个平台')
  if (names.length && !Object.hasOwn(PLATFORMS, names[0])) {
    throw new UsageError(`不认识的平台 ${names[0]}，可以用的：${platformNames()}`)
  }
  return { platform: names[0] ?? null }
}

function claudeOptionConfig(env: Env): TargetConfig | null {
  const url = (env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const key = (env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  if (!url || !key) return null
  const problem = serverUrlProblem(url) ?? keyFormatError(key)
  if (problem) throw new KiokuFailure(problem)
  return { url, key }
}

export async function doctor(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
  }: { env?: Env; out?: Writer; cwd?: string } = {},
): Promise<number> {
  const id = parseDoctorArgs(argv).platform ?? detectPlatform(env)
  const platform = id ? PLATFORMS[id] : null
  let failed = false
  const ok = (text: string) => out.write(`✓ ${text}\n`)
  const warn = (text: string) => out.write(`! ${text}\n`)
  const bad = (text: string) => {
    failed = true
    out.write(`✗ ${text}\n`)
  }

  let who: WhoamiResponse | null = null
  try {
    // 平台把地址与访问密钥放在自己的文件里时先读它，没有再看环境变量
    const profile: SavedProfile | null = platform?.readConfig
      ? await platform.readConfig(env)
      : null
    let config: TargetConfig | null = profile
    if (!config) {
      try {
        config = await loadConfig(env)
      } catch (err) {
        if (id === 'claude-code' && err instanceof NotConfigured) {
          config = claudeOptionConfig(env)
          if (!config) {
            throw new KiokuFailure(
              '还没有给 Claude Code 配过：运行 kioku login claude-code 或 kioku setup claude-code，或在 /plugin 里填写',
            )
          }
        } else if (platform?.readConfig && err instanceof NotConfigured) {
          throw new KiokuFailure(`还没有给 ${platform.name} 配过：运行 kioku setup ${id}`)
        } else {
          throw err
        }
      }
    }
    ok(`地址 ${shownUrl(config.url)}${profile ? `（${profile.file}）` : ''}`)
    who = await whoami(config)
  } catch (err) {
    bad(failureText(err))
  }
  if (who) {
    const { app, scopes } = who
    ok(
      `访问密钥可用：应用 ${plain(app.name)}（${plain(app.slug)}），运行时 ${plain(app.runtimeFamily)}`,
    )
    out.write(`  读：${layersText(scopes.readLayers)}\n`)
    out.write(`  写：${layersText(scopes.writeLayers)}\n`)
    out.write(`  最高敏感级：${named(SENSITIVITIES, scopes.maxSensitivity)}\n`)
    out.write(`  凭据：${named(CAPABILITIES, scopes.credentials ?? 'none')}\n`)
    if (platform && app.runtimeFamily !== platform.runtimeFamily) {
      warn(
        `这个应用的运行时不是 ${platform.runtimeFamily}，注入的内容不按 ${platform.name} 的格式：在管理界面为 ${platform.name} 另建一个应用`,
      )
    }
  }

  if (!platform || !id) {
    out.write(`没有认出平台，只查了地址与访问密钥；要查平台的配置，写上平台：${platformNames()}\n`)
    return failed ? 1 : 0
  }
  const note = (text: string) => out.write(`  ${text}\n`)
  const checkConflicts = async () => {
    const conflicts = await scanConflicts(id, { env, cwd }).catch(() => [])
    if (!conflicts.length) return
    for (const item of conflicts) {
      const hint = item.hint ? `（${item.hint}）` : ''
      warn(`发现冲突的记忆工具（${item.toolName}）：${item.summary}${hint}`)
    }
    if (conflicts.some((item) => item.removable)) {
      note(`清理冲突：运行 kioku clean ${id}`)
    }
  }

  if (platform.inspect) {
    try {
      await platform.inspect({ env, cwd }, { ok, warn, bad, note })
      await checkConflicts()
    } catch (err) {
      bad(failureText(err))
    }
    return failed ? 1 : 0
  }
  await checkConflicts()
  return failed ? 1 : 0
}
