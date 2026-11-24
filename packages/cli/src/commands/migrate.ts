// kioku migrate：识别服务端换代后的旧版客户端接入，卸载旧插件来源、清理工具清单缓存、
// 更新插件并批量重新授权，最后调用 doctor 完成连通与配置校验

import { generationProblem, probeServer, UNAVAILABLE_TEXT, type ServerProbe } from '../api.ts'
import { connectPlatforms } from '../connect.ts'
import {
  KiokuFailure,
  UsageError,
  failureText,
  listTools,
  plain,
  serverUrlProblem,
  shownUrl,
  writeToolCache,
} from '../core.ts'
import { doctor } from '../doctor.ts'
import { rememberServerUrl } from '../identity.ts'
import { confirm } from '../import.ts'
import { installPlugin } from '../installer.ts'
import {
  clearLegacyToolCache,
  detectLegacyPlugin,
  removeLegacySource,
  toolCacheExists,
  type LegacyPluginFindings,
} from '../legacy.ts'
import { openBrowser, type DeviceAuthPrompt } from '../login.ts'
import { defaultServerUrl, scanPlatform, type PlatformRow } from '../panel.ts'
import { platformNames, PLATFORMS } from '../platforms.ts'
import type { Env, Reader, Writer } from '../types.ts'
import { createTheme, renderBox } from '../ui/theme.ts'

export const MIGRATE_USAGE = `用法：kioku migrate [平台…] [--server-url <地址>] [-y|--yes] [--no-browser] [--dry-run]

将旧版客户端插件、旧缓存与失效访问密钥迁移到新版 Kioku：
  1. 核对服务端代际与连接状态（旧代服务端会直接给出下一步指引）
  2. 扫描本机已失效的访问密钥、旧插件市场来源、过旧插件与旧工具清单缓存
  3. 卸载旧来源、清理缓存、升级/重装插件，并在浏览器内一次批量重新签发访问密钥
  4. 刷新 MCP 工具清单缓存并运行 doctor 验证

  [平台…]             ${platformNames()}；不写时扫描全部已配置或装有旧插件的平台
  --server-url <地址>  Kioku 的服务地址（也可以用 KIOKU_SERVER_URL；配过的沿用上次的）
  -y, --yes            跳过交互确认直接执行
  --no-browser         不自动打开浏览器，只显示确认码与地址
  --dry-run            只扫描并打印迁移计划，不修改本机配置与插件
`

export interface MigrateOptions {
  platforms: string[]
  serverUrl?: string
  yes: boolean
  browser: boolean
  dryRun: boolean
}

export function parseMigrateArgs(argv: string[]): MigrateOptions {
  const options: MigrateOptions = {
    platforms: [],
    yes: false,
    browser: true,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-y' || arg === '--yes') options.yes = true
    else if (arg === '--no-browser') options.browser = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--server-url') {
      const value = argv[++i]
      if (!value) throw new UsageError('--server-url 后面要写地址')
      options.serverUrl = value
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else {
      if (!Object.hasOwn(PLATFORMS, arg)) {
        throw new UsageError(`不认识的平台 ${arg}，可以用的：${platformNames()}`)
      }
      if (!options.platforms.includes(arg)) options.platforms.push(arg)
    }
  }
  return options
}

export interface MigrationPlanItem {
  id: string
  name: string
  reasons: string[]
  removeLegacySource: boolean
  clearCache: boolean
  pluginAction: 'reinstall' | 'upgrade' | null
  reauth: boolean
  findings: LegacyPluginFindings
}

export interface MigrationPlan {
  url: string
  probe: ServerProbe
  items: MigrationPlanItem[]
}

export async function planMigration(
  url: string,
  {
    platforms = [],
    env = process.env,
    cwd = process.cwd(),
    probe: givenProbe,
  }: { platforms?: string[]; env?: Env; cwd?: string; probe?: ServerProbe } = {},
): Promise<MigrationPlan> {
  const probe = givenProbe ?? (await probeServer(url))
  const explicit = platforms.length > 0
  const ids = explicit ? platforms : Object.keys(PLATFORMS)
  const items: MigrationPlanItem[] = []

  for (const id of ids) {
    const findings = await detectLegacyPlugin(id, { env, cwd })
    const row: PlatformRow = await scanPlatform(id, { env, cwd, url })
    if (!explicit && row.otherServer) continue

    const cachePresent = await toolCacheExists(id, env)
    const hasLegacyArtifacts = Boolean(
      findings.legacySource || findings.outdatedPlugin || findings.staleToolCache,
    )
    const relevant =
      explicit || row.connection !== 'none' || row.plugin === true || hasLegacyArtifacts
    if (!relevant) continue

    const reauth = Boolean(
      (row.connection === 'invalid' && (explicit || hasLegacyArtifacts)) ||
      (explicit && row.connection === 'broken'),
    )
    const removeSource = Boolean(findings.legacySource)
    const pluginAction: MigrationPlanItem['pluginAction'] = removeSource
      ? 'reinstall'
      : findings.outdatedPlugin || (reauth && row.plugin === true)
        ? 'upgrade'
        : null
    const clearCache = Boolean(
      findings.staleToolCache ||
      (cachePresent && (reauth || removeSource || Boolean(pluginAction))),
    )

    if (!removeSource && !clearCache && !pluginAction && !reauth) continue

    const reasons: string[] = []
    if (reauth && row.connection === 'invalid') reasons.push('访问密钥已失效')
    else if (reauth && row.connection === 'broken') reasons.push('本机配置格式有误')
    if (findings.legacySource) reasons.push(findings.legacySource)
    if (findings.outdatedPlugin) reasons.push(findings.outdatedPlugin)
    if (findings.staleToolCache && !findings.outdatedPlugin?.includes('工具清单')) {
      reasons.push('包含旧版 MCP 工具清单缓存')
    }

    items.push({
      id,
      name: row.name,
      reasons,
      removeLegacySource: removeSource,
      clearCache,
      pluginAction,
      reauth,
      findings,
    })
  }

  return { url, probe, items }
}

function actionLabels(item: MigrationPlanItem): string[] {
  const steps: string[] = []
  if (item.removeLegacySource) steps.push('卸载旧插件来源')
  if (item.clearCache) steps.push('清理工具清单缓存')
  if (item.pluginAction === 'reinstall') steps.push('重新安装新版插件')
  else if (item.pluginAction === 'upgrade') steps.push('更新新版插件')
  if (item.reauth) steps.push('浏览器批量重新授权')
  if (item.findings.manualInstallDir) {
    steps.push(`手动替换目录 ${plain(item.findings.manualInstallDir)}`)
  }
  return steps
}

export function renderMigrationPlan(
  plan: MigrationPlan,
  out: { isTTY?: boolean; columns?: number } = {},
  env: Env = process.env,
): string {
  const theme = createTheme({ stream: out, env })
  const sections = [
    {
      lines: [
        `待处理 ${plan.items.length} 个客户端：${plan.items.map((item) => item.name).join('、')}`,
      ],
    },
    ...plan.items.map((item) => ({
      title: item.name,
      lines: [`原因：${item.reasons.join(' · ')}`, `步骤：${actionLabels(item).join(' → ')}`],
    })),
  ]
  return renderBox({
    title: `旧版客户端迁移计划（${shownUrl(plan.url)}）`,
    width: Math.min(92, (out.columns ?? 88) - 2),
    theme,
    sections,
  })
}

export async function migrateCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    stdin = process.stdin,
    open = openBrowser,
    sleep,
    now,
    clientName,
    authPrompt,
    installFn = installPlugin,
    connectFn = connectPlatforms,
    doctorFn = doctor,
  }: {
    env?: Env
    out?: Writer & { isTTY?: boolean; columns?: number }
    cwd?: string
    stdin?: Reader & { isTTY?: boolean }
    open?: (address: string) => void
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    clientName?: string
    authPrompt?: DeviceAuthPrompt
    installFn?: typeof installPlugin
    connectFn?: typeof connectPlatforms
    doctorFn?: typeof doctor
  } = {},
): Promise<number> {
  const options = parseMigrateArgs(argv)
  const rawUrl =
    options.serverUrl?.trim().replace(/\/+$/, '') ||
    (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '') ||
    (await defaultServerUrl(env))

  if (!rawUrl) {
    throw new UsageError('要给服务地址：--server-url https://kioku.example.com')
  }
  const urlProblem = serverUrlProblem(rawUrl)
  if (urlProblem) throw new KiokuFailure(urlProblem)

  const probe = await probeServer(rawUrl)
  const mismatch = generationProblem(probe)
  if (mismatch) {
    out.write(`✗ ${mismatch}\n`)
    return 1
  }
  if (probe.state === 'unavailable') {
    out.write(`✗ ${UNAVAILABLE_TEXT}\n`)
    return 1
  }
  if (probe.state === 'unreachable') {
    out.write(`✗ 无法连接 Kioku（${probe.problem ?? '未知错误'}）\n`)
    return 1
  }

  await rememberServerUrl(rawUrl, env).catch(() => {})
  const plan = await planMigration(rawUrl, { platforms: options.platforms, env, cwd, probe })
  if (!plan.items.length) {
    out.write('本机已接入客户端均已是最新，无需迁移\n')
    return 0
  }

  out.write(`${renderMigrationPlan(plan, out, env)}\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }

  const interactive = Boolean(stdin?.isTTY && out?.isTTY)
  if (!options.yes) {
    if (!interactive) {
      out.write('非交互终端未指定 -y，只打印迁移计划；确认无误后加 -y 执行\n')
      return 0
    }
    const confirmed = await confirm('确认执行以上迁移计划？[y/N] ', { stdin, out })
    if (!confirmed) {
      out.write('已取消迁移\n')
      return 0
    }
  }

  let failed = false

  out.write('\n清理旧来源与更新插件：\n')
  for (const item of plan.items) {
    let sourceFailed = false
    if (item.removeLegacySource) {
      const removed = await removeLegacySource(item.id, item.findings, { env, cwd })
      for (const note of removed.notes) out.write(`  [${item.name}] ${note}\n`)
      for (const cmd of removed.manualCommands) out.write(`    ${cmd}\n`)
      if (!removed.removed) {
        failed = true
        sourceFailed = true
      }
    }

    if (item.clearCache) {
      if (await clearLegacyToolCache(item.id, env)) {
        out.write(`  [${item.name}] 已清理旧工具清单缓存\n`)
      }
    }

    if (item.pluginAction) {
      if (sourceFailed) {
        out.write(`  [${item.name}] 旧插件来源尚未移除，跳过插件重装以免冲突\n`)
      } else if (item.id === 'agy' && item.findings.manualInstallDir) {
        failed = true
        out.write(
          `  [${item.name}] 插件目录为手动维护（${plain(item.findings.manualInstallDir)}），需手动替换为新版 kioku-plugins/plugins/agy\n`,
        )
      } else {
        const res = await installFn(item.id, {
          env,
          cwd,
          upgrade: item.pluginAction === 'upgrade',
        })
        out.write(`  [${item.name}] ${res.message}\n`)
        if (res.status === 'failed') failed = true
        if (res.status === 'manual' && res.commands?.length) {
          for (const cmd of res.commands) out.write(`    ${cmd}\n`)
          if (res.after) out.write(`    ${res.after}\n`)
        }
      }
    }
  }

  const reauthIds = plan.items.filter((item) => item.reauth).map((item) => item.id)
  if (reauthIds.length) {
    out.write('\n批量重新授权：\n')
    const results = await connectFn(
      { url: rawUrl, ids: reauthIds },
      {
        env,
        out,
        cwd,
        open,
        browser: options.browser,
        clientName,
        sleep,
        now,
        authPrompt,
      },
    )
    for (const r of results) {
      if (r.status === 'failed' || r.status === 'denied') failed = true
      const statusText =
        r.status === 'connected'
          ? '✓ 已签发新访问密钥'
          : r.status === 'skipped'
            ? '! 确认页未勾选'
            : `✗ ${r.reason ?? '授权失败'}`
      out.write(`  [${PLATFORMS[r.id].name}] ${statusText}\n`)
    }
  }

  out.write('\n刷新缓存并验证：\n')
  for (const item of plan.items) {
    const cfg = await PLATFORMS[item.id].readConfig?.(env).catch(() => null)
    if (cfg) {
      try {
        const tools = await listTools(cfg)
        if (Array.isArray(tools) && tools.length) {
          if (item.id === 'openclaw') {
            await writeToolCache('openclaw', { url: cfg.url, tools }, env).catch(() => {})
            out.write(`  [${item.name}] ✓ 已刷新 MCP 工具清单（${tools.length} 个工具）\n`)
          } else {
            out.write(`  [${item.name}] ✓ MCP 握手正常（${tools.length} 个工具）\n`)
          }
        }
      } catch (err) {
        out.write(`  [${item.name}] ! 无法获取 MCP 工具清单（${failureText(err)}）\n`)
      }
    }
    out.write(`── ${item.name} ──\n`)
    const docCode = await doctorFn([item.id], { env, cwd, out })
    if (docCode !== 0) failed = true
  }

  return failed ? 1 : 0
}
