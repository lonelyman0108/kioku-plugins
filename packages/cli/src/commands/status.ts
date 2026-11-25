// kioku status [--json]：只读展示服务端与本机各客户端的接入现状。
// 交互模式使用细线卡片排版并折叠未安装的客户端，--json 输出结构化结果（绝不含访问密钥）。

import { UsageError, plain, shownUrl } from '../core.ts'
import {
  defaultServerUrl,
  effectivePresence,
  platformDetails,
  scan,
  type PanelState,
  type PlatformRow,
} from '../panel.ts'
import type { Env, Writer } from '../types.ts'
import { osc8Link } from '../ui/clipboard.ts'
import { createTheme, renderBox } from '../ui/theme.ts'

export const STATUS_USAGE = `用法：kioku status [--server-url <地址>] [--json]

查看 Kioku 服务端连接状态与本机各客户端的接入、插件、自带记忆停用现状。

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

function serverLines(state: PanelState, out: Writer & { isTTY?: boolean }, env: Env): string[] {
  const theme = createTheme({ stream: out, env })
  const { server } = state
  if (!server) {
    return [`${theme.warn('!')} 尚未配置服务器地址（运行 kioku connect 或传入 --server-url）`]
  }
  const urlShown = osc8Link(shownUrl(server.url), shownUrl(server.url), { stream: out, env })
  if (!server.reachable) {
    return [`${urlShown}  ${theme.error(`✗ 无法连接（${server.problem ?? '未知错误'}）`)}`]
  }
  const parts: string[] = [
    server.problem ? theme.warn(`! ${server.problem}`) : theme.ok('✓ 可连接'),
  ]
  if (server.version) parts.push(`版本 ${plain(server.version)}`)
  if (server.needsSetup) parts.push(theme.warn('尚未初始化（在管理界面建立第一个管理员）'))
  return [`${urlShown}  ${parts.join(' · ')}`]
}

function platformSummaryLines(
  state: PanelState,
  out: Writer & { isTTY?: boolean },
  env: Env,
): string[] {
  const theme = createTheme({ stream: out, env })
  const active: PlatformRow[] = []
  const uninstalled: PlatformRow[] = []

  for (const row of state.platforms) {
    const presence = effectivePresence(row)
    if (presence !== 'installed' && row.connection === 'none' && !row.conflicts?.length) {
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
      const presence = effectivePresence(row)
      const headBadge =
        row.connection === 'ok' && !row.otherServer
          ? presence === 'installed'
            ? theme.ok('✓ 已接入')
            : theme.warn(presence === 'config-only' ? '! 未找到程序' : '! 客户端不在')
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
        const { key } = row.who
        const parts: string[] = [
          key.canWrite ? '可写' : '只读',
          key.canResolveCredentials ? '允许凭据注入' : '禁止凭据注入',
        ]
        if (key.envs.length) {
          parts.push(`环境 ${key.envs.map((e) => plain(e)).join('、')}`)
        }
        const realmText =
          key.allowedRealms === null
            ? '全部场域'
            : key.allowedRealms.length
              ? `场域 ${key.allowedRealms.map((r) => plain(r)).join('、')}`
              : '仅通用记忆'
        parts.push(realmText)
        lines.push(`  ${theme.muted(parts.join(' · '))}`)
      }
    }
  }

  if (uninstalled.length) {
    lines.push('')
    lines.push(
      theme.muted(
        `未检测到客户端（${uninstalled.length} 个）：${uninstalled
          .map((r) => (effectivePresence(r) === 'config-only' ? `${r.name}（仅配置）` : r.name))
          .join('、')}`,
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

  const theme = createTheme({ stream: out, env })
  const box = renderBox({
    title: 'Kioku 状态',
    width: Math.min(92, (out.columns ?? 88) - 2),
    theme,
    sections: [
      { title: '服务端', lines: serverLines(state, out, env) },
      { title: '本机客户端', lines: platformSummaryLines(state, out, env) },
    ],
  })
  out.write(`${box}\n`)
  return 0
}
