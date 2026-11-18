// kioku clean：检测并卸载与 Kioku 冲突的记忆工具（Lore 及常见记忆 MCP）。
// 默认先列计划并询问确认（非终端运行需传 -y/--yes）；只清理平台侧配置，不删服务端数据目录。

import { CONFLICT_TOOLS, formatConflicts, removeConflicts, scanAllConflicts } from './conflicts.ts'
import { KiokuFailure, UsageError } from './core.ts'
import { confirm } from './import.ts'
import { platformNames, PLATFORMS } from './platforms.ts'
import type { Env, Reader, Writer } from './types.ts'

const CLEANABLE_TOOLS = Object.keys(CONFLICT_TOOLS).filter((id) => id !== 'unknown-memory')

export const CLEAN_USAGE = `用法：kioku clean [平台] [--tool <工具>] [--dry-run] [-y|--yes]

检测并卸载与 Kioku 冲突的记忆工具（Lore 及常见记忆 MCP）。
只清理目标平台上的接入配置或插件挂载，不删服务端数据目录。

  [平台]         ${platformNames()}；不写时扫描全部平台
  --tool <工具>  只清理指定工具：${CLEANABLE_TOOLS.join('、')}
  --dry-run      只列出发现的冲突，不修改文件
  -y, --yes      不问，直接清理（不在终端里运行时要带上）
`

export function parseCleanArgs(argv: string[]): {
  platform: string | null
  tool: string | null
  dryRun: boolean
  yes: boolean
} {
  const options: { platform: string | null; tool: string | null; dryRun: boolean; yes: boolean } = {
    platform: null,
    tool: null,
    dryRun: false,
    yes: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '-y' || arg === '--yes') options.yes = true
    else if (arg === '--tool') {
      const value = argv[++i]
      if (!value) throw new UsageError('--tool 后面要写工具名')
      if (!CLEANABLE_TOOLS.includes(value)) {
        throw new UsageError(`不认识的工具 ${value}，可以用的：${CLEANABLE_TOOLS.join('、')}`)
      }
      options.tool = value
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (options.platform !== null) {
      throw new UsageError('最多写一个平台')
    } else {
      if (!Object.hasOwn(PLATFORMS, arg)) {
        throw new UsageError(`不认识的平台 ${arg}，可以用的：${platformNames()}`)
      }
      options.platform = arg
    }
  }
  return options
}

export async function clean(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    stdin = process.stdin,
  }: { env?: Env; out?: Writer; cwd?: string; stdin?: Reader } = {},
): Promise<number> {
  const options = parseCleanArgs(argv)
  const targetIds = options.platform ? [options.platform] : Object.keys(PLATFORMS)
  const all = await scanAllConflicts(targetIds, { env, cwd })
  const items = options.tool ? all.filter((item) => item.tool === options.tool) : all

  if (!items.length) {
    out.write(
      options.platform
        ? `${PLATFORMS[options.platform].name}：没有发现冲突的记忆工具\n`
        : '没有发现冲突的记忆工具\n',
    )
    return 0
  }

  out.write('发现以下冲突或疑似项：\n')
  out.write(`${formatConflicts(items, PLATFORMS).join('\n')}\n`)

  const removable = items.filter((item) => item.removable)
  if (options.dryRun) {
    out.write('没有改动（--dry-run）\n')
    return 0
  }
  if (!removable.length) {
    out.write('没有可自动卸载的项，请按上面的提示手动处理。\n')
    return 0
  }

  if (!options.yes) {
    if (!stdin.isTTY) {
      throw new KiokuFailure('不在终端里运行时要带 --yes 才清理；先用 --dry-run 看计划')
    }
    if (!(await confirm(`清理以上 ${removable.length} 项冲突？[y/N] `, { stdin, out }))) {
      out.write('没有改动\n')
      return 0
    }
  }

  out.write('\n')
  const results = await removeConflicts(removable, { env, cwd, out })
  const failed = results.some((r) => !r.ok)
  if (!failed) out.write('清理完成，重启对应平台后生效。\n')
  return failed ? 1 : 0
}
