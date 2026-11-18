// kioku doctor：检查地址与访问密钥能不能用、访问密钥的权限，以及平台这一边配好没有。
// 单平台默认输出与既有脚本、E2E 合约完全一致（✓ / ! / ✗ 行）；
// 未指定平台且未从会话认出时可自动巡检全部已接入/已安装平台（或使用 --all），并支持 --json 输出。

import { stat } from 'node:fs/promises'

import { whoami } from './api.ts'
import { scanConflicts } from './conflicts.ts'
import {
  KiokuFailure,
  NotConfigured,
  UsageError,
  failureText,
  hasCommand,
  keyFormatError,
  loadConfig,
  plain,
  serverUrlProblem,
  shownUrl,
} from './core.ts'
import { detectPlatform, platformNames, PLATFORMS } from './platforms.ts'
import type { Env, SavedProfile, TargetConfig, WhoamiResponse, Writer } from './types.ts'
import { capabilityLabel, layerLabel } from './ui/theme.ts'

export const DOCTOR_USAGE = `用法：kioku doctor [平台] [--all] [--json]

检查 Kioku 的地址与访问密钥、访问密钥的权限，以及平台的配置（插件是否启用、自带的长期记忆是否已停用）。

  [平台]  ${platformNames()}；不写时按当前所在的会话认，否则检查全部已安装或已配过的平台
  --all   检查全部受支持的平台
  --json  以 JSON 格式输出结果（不含访问密钥）

有问题的项以 ✗ 开头，这时退出码为 1。
`

const SENSITIVITIES: Record<string, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}

function named(names: Record<string, string>, value: string | undefined): string {
  const key = value ?? ''
  return Object.hasOwn(names, key) ? names[key] : plain(key)
}

function layersText(layers: string[] | undefined): string {
  if (!Array.isArray(layers) || !layers.length) return '无'
  return layers.map((layer) => layerLabel(layer)).join('、')
}

export function parseDoctorArgs(argv: string[]): {
  platform: string | null
  all: boolean
  json: boolean
} {
  const names: string[] = []
  let all = false
  let json = false
  for (const arg of argv) {
    if (arg === '--all') all = true
    else if (arg === '--json') json = true
    else if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    else names.push(arg)
  }
  if (names.length > 1) throw new UsageError('最多写一个平台')
  if (names.length && !Object.hasOwn(PLATFORMS, names[0])) {
    throw new UsageError(`不认识的平台 ${names[0]}，可以用的：${platformNames()}`)
  }
  if (all && names.length) throw new UsageError('--all 不能和具体平台名一起写')
  return { platform: names[0] ?? null, all, json }
}

function claudeOptionConfig(env: Env): TargetConfig | null {
  const url = (env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const key = (env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  if (!url || !key) return null
  const problem = serverUrlProblem(url) ?? keyFormatError(key)
  if (problem) throw new KiokuFailure(problem)
  return { url, key }
}

interface DoctorTargetReport {
  id: string | null
  name: string | null
  url?: string
  profileFile?: string
  app?: WhoamiResponse['app']
  scopes?: WhoamiResponse['scopes']
  checks: Array<{ level: 'ok' | 'warn' | 'bad' | 'note'; message: string }>
  failed: boolean
}

async function inspectOne(
  id: string | null,
  { env, cwd, out }: { env: Env; cwd: string; out?: Writer },
): Promise<DoctorTargetReport> {
  const platform = id ? PLATFORMS[id] : null
  const report: DoctorTargetReport = {
    id,
    name: platform?.name ?? null,
    checks: [],
    failed: false,
  }
  const ok = (text: string) => {
    report.checks.push({ level: 'ok', message: text })
    out?.write(`✓ ${text}\n`)
  }
  const warn = (text: string) => {
    report.checks.push({ level: 'warn', message: text })
    out?.write(`! ${text}\n`)
  }
  const bad = (text: string) => {
    report.failed = true
    report.checks.push({ level: 'bad', message: text })
    out?.write(`✗ ${text}\n`)
  }
  const note = (text: string) => {
    report.checks.push({ level: 'note', message: text })
    out?.write(`  ${text}\n`)
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
    report.url = shownUrl(config.url)
    if (profile?.file) report.profileFile = profile.file
    ok(`地址 ${report.url}${profile ? `（${profile.file}）` : ''}`)
    who = await whoami(config)
  } catch (err) {
    bad(failureText(err))
  }

  if (who) {
    const { app, scopes } = who
    report.app = app
    report.scopes = scopes
    ok(
      `访问密钥可用：应用 ${plain(app.name)}（${plain(app.slug)}），运行时 ${plain(app.runtimeFamily)}`,
    )
    out?.write(`  读：${layersText(scopes.readLayers)}\n`)
    out?.write(`  写：${layersText(scopes.writeLayers)}\n`)
    out?.write(`  最高敏感级：${named(SENSITIVITIES, scopes.maxSensitivity)}\n`)
    out?.write(`  凭据：${capabilityLabel(scopes.credentials)}\n`)
    if (platform && app.runtimeFamily !== platform.runtimeFamily) {
      warn(
        `这个应用的运行时不是 ${platform.runtimeFamily}，注入的内容不按 ${platform.name} 的格式：在管理界面为 ${platform.name} 另建一个应用`,
      )
    }
  }

  if (!platform || !id) {
    out?.write(`没有认出平台，只查了地址与访问密钥；要查平台的配置，写上平台：${platformNames()}\n`)
    return report
  }

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
    return report
  }
  await checkConflicts()
  return report
}

async function discoverActivePlatforms(env: Env): Promise<string[]> {
  const active: string[] = []
  for (const id of Object.keys(PLATFORMS)) {
    const platform = PLATFORMS[id]
    const hasCfg = Boolean(await Promise.resolve(platform.readConfig?.(env)).catch(() => null))
    const hasCmd = hasCommand(platform.command(env), env)
    const hasHome = Boolean((await stat(platform.home(env)).catch(() => null))?.isDirectory())
    if (hasCfg || hasCmd || hasHome) active.push(id)
  }
  return active
}

export async function doctor(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
  }: { env?: Env; out?: Writer; cwd?: string } = {},
): Promise<number> {
  const opts = parseDoctorArgs(argv)
  const detected = opts.platform ?? detectPlatform(env)

  let targets: Array<string | null>
  if (opts.all) {
    targets = Object.keys(PLATFORMS)
  } else if (detected) {
    targets = [detected]
  } else {
    // 兼容无参数时仅携带环境变量（KIOKU_SERVER_URL / KIOKU_API_KEY）的单体诊断路径
    const hasEnvUrl = Boolean((env.KIOKU_SERVER_URL ?? '').trim())
    const active = await discoverActivePlatforms(env)
    targets = hasEnvUrl || !active.length ? [null] : active
  }

  const singleMode = targets.length === 1
  const reports: DoctorTargetReport[] = []
  for (const [index, targetId] of targets.entries()) {
    if (!opts.json && !singleMode && targetId) {
      if (index > 0) out.write('\n')
      out.write(`── ${PLATFORMS[targetId].name} ──\n`)
    }
    reports.push(await inspectOne(targetId, { env, cwd, out: opts.json ? undefined : out }))
  }

  const failed = reports.some((r) => r.failed)
  if (opts.json) {
    out.write(`${JSON.stringify({ ok: !failed, targets: reports }, null, 2)}\n`)
  }
  return failed ? 1 : 0
}
