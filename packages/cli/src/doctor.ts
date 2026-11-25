// kioku doctor：检查地址与访问密钥能不能用、访问密钥的权限，以及平台这一边配好没有。
// 单平台默认输出与既有脚本、E2E 合约完全一致（✓ / ! / ✗ 行）；
// 未指定平台且未从会话认出时可自动巡检全部已接入/已安装平台（或使用 --all），并支持 --json 输出。

import { ServerMismatch, whoami } from './api.ts'
import { scanConflicts } from './conflicts.ts'
import {
  DatabaseUnavailable,
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
import { detectLegacyPlugin } from './legacy.ts'
import { detectPlatformPresence } from './panel.ts'
import { detectPlatform, platformNames, PLATFORMS } from './platforms.ts'
import type { Env, SavedProfile, TargetConfig, WhoamiResponse, Writer } from './types.ts'

export const DOCTOR_USAGE = `用法：kioku doctor [平台] [--all] [--json]

检查 Kioku 的地址与访问密钥、访问密钥的权限，以及客户端的配置（插件是否启用、自带的长期记忆是否已停用）。

  [平台]  ${platformNames()}；不写时按当前所在的会话认，否则检查全部已安装或已配过的客户端
  --all   检查全部受支持的客户端
  --json  以 JSON 格式输出结果（不含访问密钥）

有问题的项以 ✗ 开头，这时退出码为 1。
`

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

type DoctorIssueCategory =
  'server_generation' | 'database_unavailable' | 'legacy_source' | 'outdated_plugin'

interface DoctorTargetReport {
  id: string | null
  name: string | null
  url?: string
  profileFile?: string
  accountName?: string
  key?: WhoamiResponse['key']
  client?: WhoamiResponse['client']
  checks: Array<{
    level: 'ok' | 'warn' | 'bad' | 'note'
    message: string
    category?: DoctorIssueCategory
  }>
  failed: boolean
}

async function inspectOne(
  id: string | null,
  {
    env,
    cwd,
    out,
    allowEnvFallback = true,
  }: { env: Env; cwd: string; out?: Writer; allowEnvFallback?: boolean },
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
  const warn = (text: string, category?: DoctorIssueCategory) => {
    report.checks.push({ level: 'warn', message: text, ...(category ? { category } : {}) })
    out?.write(`! ${text}\n`)
  }
  const bad = (text: string, category?: DoctorIssueCategory) => {
    report.failed = true
    report.checks.push({ level: 'bad', message: text, ...(category ? { category } : {}) })
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
      if (!allowEnvFallback) {
        if (id === 'claude-code') {
          config = claudeOptionConfig(env)
          if (!config) {
            throw new KiokuFailure(
              '尚未配置 Claude Code：运行 kioku login claude-code 或 kioku setup claude-code，或在 /plugin 里填写',
            )
          }
        } else if (platform?.readConfig) {
          throw new KiokuFailure(`尚未配置 ${platform.name}：运行 kioku setup ${id}`)
        } else {
          config = await loadConfig(env)
        }
      } else {
        try {
          config = await loadConfig(env)
        } catch (err) {
          if (id === 'claude-code' && err instanceof NotConfigured) {
            config = claudeOptionConfig(env)
            if (!config) {
              throw new KiokuFailure(
                '尚未配置 Claude Code：运行 kioku login claude-code 或 kioku setup claude-code，或在 /plugin 里填写',
              )
            }
          } else if (platform?.readConfig && err instanceof NotConfigured) {
            throw new KiokuFailure(`尚未配置 ${platform.name}：运行 kioku setup ${id}`)
          } else {
            throw err
          }
        }
      }
    }
    report.url = shownUrl(config.url)
    if (profile?.file) report.profileFile = profile.file
    ok(`地址 ${report.url}${profile ? `（${plain(profile.file)}）` : ''}`)
    try {
      who = await whoami(config)
    } catch (err) {
      const category: DoctorIssueCategory | undefined =
        err instanceof DatabaseUnavailable
          ? 'database_unavailable'
          : err instanceof ServerMismatch
            ? err.probe.state === 'unavailable'
              ? 'database_unavailable'
              : 'server_generation'
            : undefined
      bad(failureText(err), category)
    }
  } catch (err) {
    bad(failureText(err))
  }

  if (who) {
    const { accountName, key, client } = who
    report.accountName = accountName
    report.key = key
    report.client = client
    ok(
      `访问密钥可用：${plain(key.name)}（${plain(key.prefix)}），运行时 ${plain(key.runtimeFamily)}`,
    )
    note(`账号：${plain(accountName)}`)
    note(`写入权限：${key.canWrite ? '可写' : '只读'}`)
    note(`凭据注入：${key.canResolveCredentials ? '允许' : '禁止'}`)
    if (key.envs.length) {
      note(`默认环境：${key.envs.map((item) => plain(item)).join('、')}`)
    }
    const realmText =
      key.allowedRealms === null
        ? '不限'
        : key.allowedRealms.length
          ? key.allowedRealms.map((r) => plain(r)).join('、')
          : '无（仅通用）'
    note(`场域范围：${realmText}`)
    if (platform && key.runtimeFamily !== platform.runtimeFamily) {
      warn(
        `这个访问密钥的运行时不是 ${platform.runtimeFamily}，注入的内容不按 ${platform.name} 的格式：在管理界面「设置 → 连接与终端」为 ${platform.name} 另建一个访问密钥`,
      )
    }
  }

  if (!platform || !id) {
    out?.write(`没有认出客户端，只查了地址与访问密钥；要查具体配置，写上平台：${platformNames()}\n`)
    return report
  }

  const checkConflictsAndLegacy = async () => {
    const legacy = await detectLegacyPlugin(id, { env, cwd }).catch(() => null)
    if (legacy?.legacySource) {
      bad(`旧插件来源：${legacy.legacySource}（运行 kioku migrate 迁移）`, 'legacy_source')
    }
    if (legacy?.outdatedPlugin) {
      warn(
        `插件过旧：${legacy.outdatedPlugin}（运行 kioku migrate 或 kioku upgrade ${id} 更新）`,
        'outdated_plugin',
      )
    }
    const conflicts = await scanConflicts(id, { env, cwd }).catch(() => [])
    if (!conflicts.length) return
    for (const item of conflicts) {
      const hint = item.hint ? `（${plain(item.hint)}）` : ''
      warn(`发现冲突的记忆工具（${plain(item.toolName)}）：${plain(item.summary)}${hint}`)
    }
    if (conflicts.some((item) => item.removable)) {
      note(`清理冲突：运行 kioku clean ${id}`)
    }
  }

  if (platform.inspect) {
    try {
      await platform.inspect({ env, cwd }, { ok, warn, bad, note })
    } catch (err) {
      bad(failureText(err))
    }
  }
  await checkConflictsAndLegacy()
  return report
}

async function discoverActivePlatforms(env: Env): Promise<string[]> {
  const active: string[] = []
  for (const id of Object.keys(PLATFORMS)) {
    const platform = PLATFORMS[id]
    const hasCfg = Boolean(await Promise.resolve(platform.readConfig?.(env)).catch(() => null))
    const { presence } = await detectPlatformPresence(id, env)
    if (hasCfg || presence === 'installed') active.push(id)
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
    reports.push(
      await inspectOne(targetId, {
        env,
        cwd,
        out: opts.json ? undefined : out,
        allowEnvFallback: !opts.all,
      }),
    )
  }

  const failed = reports.some((r) => r.failed)
  if (opts.json) {
    out.write(`${JSON.stringify({ ok: !failed, targets: reports }, null, 2)}\n`)
  }
  return failed ? 1 : 0
}
