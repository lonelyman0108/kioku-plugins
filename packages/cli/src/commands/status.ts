// kioku status [--json]：只读展示服务端与本机各平台的接入现状。
// 交互模式使用 Strata 细线卡片排版并折叠未安装的客户端，--json 输出结构化结果（绝不含访问密钥）。

import { UsageError, plain, shownUrl } from '../core.ts'
import {
  defaultServerUrl,
  platformDetails,
  scan,
  type PanelState,
  type PlatformRow,
} from '../panel.ts'
import type { Env, Writer } from '../types.ts'
import { osc8Link } from '../ui/clipboard.ts'
import {
  capabilityLabel,
  createTheme,
  layerLabel,
  renderBox,
  sensitivityBadge,
} from '../ui/theme.ts'

export const STATUS_USAGE = `用法：kioku status [--server-url <地址>] [--json]

查看 Kioku 服务端连接状态与本机各平台的接入、插件、自带记忆停用现状。

  --server-url <地址>  指定要核对的 Kioku 地址
  --json               以 JSON 格式输出（不含访问密钥）
`

export function parseStatusArgs(argv: string[]): { serverUrl?: string; json: boolean } {
  const options: { serverUrl?: string; json: boolean } = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--server-url') {
      const val = argv[++i]
      if (!val) throw new UsageError('--server-url 后面要写地址')
      options.serverUrl = val
    } else throw new UsageError(`不认识的选项 ${arg}`)
  }
  return options
}

function serverLines(state: PanelState, out: Writer & { isTTY?: boolean }): string[] {
  const theme = createTheme({ stream: out })
  const { server } = state
  if (!server) {
    return [`${theme.warn('!')} 尚未配置服务器地址（运行 kioku connect 或传入 --server-url）`]
  }
  const urlShown = osc8Link(shownUrl(server.url), shownUrl(server.url), { stream: out })
  if (!server.reachable) {
    return [`${urlShown}  ${theme.error(`✗ 无法连接（${server.problem ?? '未知错误'}）`)}`]
  }
  const parts: string[] = [
    server.problem ? theme.warn(`! ${server.problem}`) : theme.ok('✓ 可连接'),
  ]
  if (server.version) parts.push(`版本 ${plain(server.version)}`)
  if (server.needsSetup) parts.push(theme.warn('未初始化（请先打开管理界面创建管理员）'))
  return [`${urlShown}  ${parts.join(' · ')}`]
}

function platformSummaryLines(state: PanelState, out: Writer & { isTTY?: boolean }): string[] {
  const theme = createTheme({ stream: out })
  const active: PlatformRow[] = []
  const uninstalled: PlatformRow[] = []

  for (const row of state.platforms) {
    if (!row.present && row.connection === 'none' && !row.conflicts?.length) {
      uninstalled.push(row)
    } else {
      active.push(row)
    }
  }

  const lines: string[] = []
  if (!active.length) {
    lines.push(theme.muted('暂未检测到已安装或已配置的受支持客户端'))
  } else {
    for (const row of active) {
      const details = platformDetails(row)
      const headBadge =
        row.connection === 'ok' && !row.otherServer
          ? theme.ok('✓ 已接入')
          : row.connection === 'invalid' || row.connection === 'broken'
            ? theme.error(`✗ ${details.head}`)
            : theme.muted(details.head)
      lines.push(
        `${theme.bold(row.name)}  ${headBadge}${details.facts.length ? ` · ${details.facts.join(' · ')}` : ''}`,
      )
      if (details.details.length) {
        lines.push(`  ${theme.muted(details.details.join(' · '))}`)
      }
      if (row.connection === 'ok' && row.who) {
        const readStr = (row.who.scopes.readLayers ?? []).map(layerLabel).join('、') || '无'
        const writeStr = (row.who.scopes.writeLayers ?? []).map(layerLabel).join('、') || '无'
        const sens = sensitivityBadge(row.who.scopes.maxSensitivity ?? 'internal', theme)
        const cred = capabilityLabel(row.who.scopes.credentials)
        lines.push(
          `  ${theme.muted(`读 ${readStr} · 写 ${writeStr} · 上限 ${sens} · 凭据 ${cred}`)}`,
        )
      }
    }
  }

  if (uninstalled.length) {
    lines.push('')
    lines.push(
      theme.muted(
        `未检测到客户端（${uninstalled.length} 个）：${uninstalled.map((r) => r.name).join('、')}`,
      ),
    )
  }

  return lines
}

export async function statusCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; cwd?: string } = {},
): Promise<number> {
  const options = parseStatusArgs(argv)
  const url = options.serverUrl?.trim().replace(/\/+$/, '') ?? (await defaultServerUrl(env))
  const state = await scan({ env, cwd, url })

  if (options.json) {
    out.write(`${JSON.stringify(state, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out })
  const box = renderBox({
    title: 'Kioku 状态',
    width: Math.min(92, (out.columns ?? 88) - 2),
    theme,
    sections: [
      { title: '服务端', lines: serverLines(state, out) },
      { title: '本机客户端', lines: platformSummaryLines(state, out) },
    ],
  })
  out.write(`${box}\n`)
  return 0
}
