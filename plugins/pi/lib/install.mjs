// kioku install：给脚本用的接入。几个平台一起配好，访问密钥按平台从环境变量取（KIOKU_API_KEY_CODEX 这类），
// 没给的平台跳过并列出来。插件不替用户装，最后列出要运行的命令

import { whoami } from './api.mjs'
import { configure, pluginSteps, resultsText } from './connect.mjs'
import { failureText, keyFormatError, KiokuFailure } from './http.mjs'
import { confirm } from './import.mjs'
import { platformNames, PLATFORMS } from './platforms.mjs'
import { setup } from './setup.mjs'
import { resolveServerUrl } from './target.mjs'
import { plain, shownUrl } from './text.mjs'
import { UsageError } from './usage.mjs'

// 平台的访问密钥放在哪个环境变量里：平台 id 大写、连字符换成下划线
export function keyVariable(id) {
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

各平台照 kioku setup 写下地址与访问密钥、停用自带的长期记忆。
Claude Code 的访问密钥在它的 /plugin 里填：这里只核对访问密钥、停用自动记忆。
插件不替你装：最后列出要运行的命令，装好之后运行 kioku doctor <平台> 检查。
`

export function parseInstallArgs(argv) {
  const options = { platforms: [], serverUrl: undefined, yes: false, dryRun: false }
  let given = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-y' || arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
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

// 每个平台要做什么：{ id, key } 或 { id, skip: 原因 }
export function installPlan(platforms, env) {
  return platforms.map((id) => {
    const name = keyVariable(id)
    const key = (env[name] ?? '').trim()
    if (!key) return { id, skip: `没有 ${name}` }
    const problem = keyFormatError(key)
    if (problem) return { id, skip: `${name}：${problem}` }
    return { id, key }
  })
}

// Claude Code：核对访问密钥是不是给它的，停用自动记忆；地址与访问密钥要用户在 /plugin 里填
async function installClaudeCode(url, key, { env, out, cwd }) {
  const who = await whoami({ url, key })
  out.write(`✓ 访问密钥可用：应用 ${plain(who.app.name)}，运行时 ${plain(who.app.runtimeFamily)}\n`)
  if (who.app.runtimeFamily !== PLATFORMS['claude-code'].runtimeFamily) {
    out.write('! 这个应用的运行时不是 claudecode：在管理界面为 Claude Code 另建一个应用\n')
  }
  const code = await setup(['claude-code'], { env, out, cwd, login: null })
  if (code !== 0) throw new KiokuFailure('停用自动记忆没有成功')
  out.write('地址与访问密钥要在 Claude Code 的 /plugin 里填（启用插件时会问）\n')
}

export async function install(
  argv,
  { env = process.env, out = process.stdout, cwd = process.cwd(), stdin = process.stdin } = {},
) {
  const options = parseInstallArgs(argv)
  const url = resolveServerUrl(options, env, null)
  const plan = installPlan(options.platforms, env)
  out.write(`Kioku：${shownUrl(url)}\n`)
  for (const item of plan) {
    const name = PLATFORMS[item.id].name
    if (item.skip) out.write(`  跳过  ${name}（${item.skip}）\n`)
    else if (item.id === 'claude-code') out.write(`  核对  ${name}：核对访问密钥，停用自动记忆\n`)
    else out.write(`  接入  ${name}：写下地址与访问密钥，停用自带的长期记忆\n`)
  }
  const todo = plan.filter((item) => item.key)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!todo.length) {
    out.write('没有要接入的平台：按上面的变量名给出访问密钥\n')
    return 1
  }
  if (!options.yes && stdin.isTTY) {
    if (!(await confirm(`接入这 ${todo.length} 个平台？[y/N] `, { stdin, out }))) {
      out.write('没有写入\n')
      return 0
    }
  }

  const results = plan
    .filter((item) => item.skip)
    .map((item) => ({ ...item, status: 'skipped', reason: item.skip }))
  for (const { id, key } of todo) {
    out.write(`\n${PLATFORMS[id].name}\n`)
    try {
      if (id === 'claude-code') {
        await installClaudeCode(url, key, { env, out, cwd })
        results.push({ id, status: 'manual', reason: '地址与访问密钥在 /plugin 里填' })
      } else {
        await configure(id, { url, key }, { env, out, cwd })
        results.push({ id, status: 'connected' })
      }
    } catch (err) {
      results.push({ id, status: 'failed', reason: failureText(err) })
    }
  }
  const ordered = options.platforms.map((id) => results.find((item) => item.id === id))
  out.write(`\n${resultsText(ordered)}\n`)
  const steps = await pluginSteps(
    ordered
      .filter((item) => item.status === 'connected' || item.status === 'manual')
      .map((item) => item.id),
    { env, cwd },
  )
  if (steps) out.write(`\n${steps}\n`)
  return ordered.some((item) => item.status === 'failed') ? 1 : 0
}
