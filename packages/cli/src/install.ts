// kioku install：给脚本用的接入。几个平台一起配好，访问密钥按平台从环境变量取（KIOKU_API_KEY_CODEX 这类），
// 没给的平台跳过并列出来。插件不替用户装，最后列出要运行的命令

import {
  conflictToolsText,
  formatConflicts,
  removeConflicts,
  scanConflicts,
  type ConflictItem,
} from './conflicts.ts'
import { configure, pluginSteps, resultsText, type ConnectResult } from './connect.ts'
import { UsageError, failureText, keyFormatError, shownUrl } from './core.ts'
import { confirm } from './import.ts'
import { platformNames, PLATFORMS } from './platforms.ts'
import { resolveServerUrl } from './target.ts'
import type { Env, Reader, Writer } from './types.ts'

// 平台的访问密钥放在哪个环境变量里：平台 id 大写、连字符换成下划线
export function keyVariable(id: string): string {
  return `KIOKU_API_KEY_${id.toUpperCase().replaceAll('-', '_')}`
}

export const INSTALL_USAGE = `用法：kioku install --platforms <平台,…> [--server-url <地址>] [-y] [--dry-run]

把几个平台一起接到 Kioku（给脚本用；在终端里直接运行 kioku 是交互式的向导）。
每个平台的访问密钥从它的环境变量读，没给的平台跳过：

${Object.keys(PLATFORMS)
  .map((id) => `  ${keyVariable(id).padEnd(28)}${PLATFORMS[id].name}`)
  .join('\n')}

  --platforms <平台,…>  逗号分隔：${platformNames().replaceAll('、', ',')}
  --server-url <地址>   Kioku 的服务地址（也可以用 KIOKU_SERVER_URL）
  -y, --yes             不问，直接写（在终端里运行时默认先列计划再确认）
  --dry-run             只列计划，不写
  --remove-conflicts    接入前先卸载各平台上已有的冲突记忆工具（Lore 及常见记忆 MCP）

各平台照 kioku setup 写下地址与访问密钥、停用自带的长期记忆。
插件需另行安装：最后列出要运行的命令，装好之后运行 kioku doctor <平台> 检查。
`

export function parseInstallArgs(argv: string[]): {
  platforms: string[]
  serverUrl: string | undefined
  yes: boolean
  dryRun: boolean
  removeConflicts: boolean
} {
  const options: {
    platforms: string[]
    serverUrl: string | undefined
    yes: boolean
    dryRun: boolean
    removeConflicts: boolean
  } = {
    platforms: [],
    serverUrl: undefined,
    yes: false,
    dryRun: false,
    removeConflicts: false,
  }
  let given = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-y' || arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--remove-conflicts') options.removeConflicts = true
    else if (arg === '--server-url' || arg === '--platforms') {
      const value = argv[++i]
      if (!value) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--server-url') options.serverUrl = value
      else {
        given = true
        for (const name of value.split(',').map((item) => item.trim())) {
          if (!name) continue
          if (!Object.hasOwn(PLATFORMS, name)) {
            throw new UsageError(`不认识的平台 ${name}，可以用的：${platformNames()}`)
          }
          if (!options.platforms.includes(name)) options.platforms.push(name)
        }
      }
    } else throw new UsageError(`不认识的参数 ${arg}`)
  }
  if (!given || !options.platforms.length) throw new UsageError('要写平台：--platforms codex,pi')
  return options
}

export type InstallPlanItem = { id: string; key: string } | { id: string; skip: string }

// 每个平台要做什么：{ id, key } 或 { id, skip: 原因 }
export function installPlan(platforms: string[], env: Env): InstallPlanItem[] {
  return platforms.map((id) => {
    const name = keyVariable(id)
    const key = (env[name] ?? '').trim()
    if (!key) return { id, skip: `没有 ${name}` }
    const problem = keyFormatError(key)
    if (problem) return { id, skip: `${name}：${problem}` }
    return { id, key }
  })
}

export async function install(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    stdin = process.stdin,
  }: { env?: Env; out?: Writer; cwd?: string; stdin?: Reader } = {},
): Promise<number> {
  const options = parseInstallArgs(argv)
  const url = resolveServerUrl(options, env, null)
  const plan = installPlan(options.platforms, env)
  const todo = plan.filter((item): item is { id: string; key: string } => 'key' in item)
  const conflictsByPlatform = new Map<
    string,
    { removable: ConflictItem[]; warnings: ConflictItem[] }
  >()
  for (const { id } of todo) {
    const found = await scanConflicts(id, { env, cwd })
    conflictsByPlatform.set(id, {
      removable: found.filter((c) => c.removable),
      warnings: found.filter((c) => !c.removable),
    })
  }
  const canPromptRemove = !options.yes && Boolean(stdin.isTTY)
  const willRemove = options.removeConflicts || canPromptRemove

  out.write(`Kioku：${shownUrl(url)}\n`)
  for (const item of plan) {
    const name = PLATFORMS[item.id].name
    if ('skip' in item) out.write(`  跳过  ${name}（${item.skip}）\n`)
    else out.write(`  接入  ${name}：写下地址与访问密钥，停用自带的长期记忆\n`)
    const entry = conflictsByPlatform.get(item.id)
    if (entry?.removable.length) {
      const action = willRemove
        ? '先卸载再接入'
        : `需先清理：运行 kioku clean ${item.id} 或加 --remove-conflicts`
      out.write(`  冲突  ${name}：发现 ${conflictToolsText(entry.removable)}（${action}）\n`)
      out.write(`${formatConflicts(entry.removable, PLATFORMS).join('\n')}\n`)
    }
    for (const w of entry?.warnings ?? []) {
      out.write(`  提示  ${name}：${w.toolName} ${w.summary}\n`)
    }
  }
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!todo.length) {
    out.write('没有要接入的平台：按上面的变量名给出访问密钥\n')
    return 1
  }
  let removeApproved = options.removeConflicts
  if (canPromptRemove) {
    const hasConflicts = todo.some(({ id }) => conflictsByPlatform.get(id)?.removable.length)
    const prompt = hasConflicts
      ? `先卸载发现的冲突并接入这 ${todo.length} 个平台？[y/N] `
      : `接入这 ${todo.length} 个平台？[y/N] `
    if (!(await confirm(prompt, { stdin, out }))) {
      out.write('没有写入\n')
      return 0
    }
    if (hasConflicts) removeApproved = true
  }

  const results: ConnectResult[] = plan
    .filter((item): item is { id: string; skip: string } => 'skip' in item)
    .map((item) => ({ id: item.id, status: 'skipped', reason: item.skip }))
  for (const { id, key } of todo) {
    out.write(`\n${PLATFORMS[id].name}\n`)
    const entry = conflictsByPlatform.get(id)
    if (entry?.removable.length) {
      if (!removeApproved) {
        const reason = `存在冲突（${conflictToolsText(entry.removable)}）：运行 kioku clean ${id}，或加 --remove-conflicts`
        results.push({ id, status: 'failed', reason })
        continue
      }
      const cleanResults = await removeConflicts(entry.removable, { env, cwd, out })
      if (cleanResults.some((r) => !r.ok)) {
        results.push({ id, status: 'failed', reason: '清理冲突没有全部成功' })
        continue
      }
    }
    try {
      await configure(id, { url, key }, { env, out, cwd })
      results.push({ id, status: 'connected' })
    } catch (err) {
      results.push({ id, status: 'failed', reason: failureText(err) })
    }
  }
  const ordered = options.platforms
    .map((id) => results.find((item) => item.id === id))
    .filter((item): item is ConnectResult => Boolean(item))
  out.write(`\n${resultsText(ordered)}\n`)
  const steps = await pluginSteps(
    ordered
      .filter((item) => item.status === 'connected' || item.status === 'manual')
      .map((item) => item.id),
    { env, cwd, url },
  )
  if (steps) out.write(`\n${steps}\n`)
  return ordered.some((item) => item.status === 'failed') ? 1 : 0
}
