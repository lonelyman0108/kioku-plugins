// kioku setup：把平台交给 Kioku 接管：停用自带长期记忆，并按平台写入服务地址与访问密钥。

import { ensureNoConflicts } from './conflicts.ts'
import { KiokuFailure, UsageError, plain } from './core.ts'
import { deviceLogin } from './login.ts'
import { platformNames, PLATFORMS } from './platforms.ts'
import { readSecret } from './secret.ts'
import type { Env, Reader, SetupOptions, Writer } from './types.ts'

export { readSettings, writeSettings } from './files.ts'

const setupPlatformNames = () =>
  Object.keys(PLATFORMS)
    .filter((id) => PLATFORMS[id].setup)
    .join('、')

export const SETUP_USAGE = `用法：kioku setup <平台> [--dry-run] [--undo] [--server-url <地址>] [--no-check] [--remove-conflicts]

把平台交给 Kioku 接管：停用平台自带的长期记忆，并写下服务地址与访问密钥（${setupPlatformNames()}）。

  <平台>               ${platformNames()}
  --dry-run            只显示要改什么，不写文件
  --undo               改回去：重新启用平台自带的长期记忆，删掉写下的地址与访问密钥
  --server-url <地址>  Kioku 的服务地址，例如 https://kioku.example.com（也可以用 KIOKU_SERVER_URL）
  --no-check           不先连一次 Kioku 核对地址与访问密钥
  --remove-conflicts   先卸载平台上已有的冲突记忆工具（Lore 及常见记忆 MCP）再继续

访问密钥不写在命令行上：从 KIOKU_API_KEY 读，或者从标准输入读；在终端里运行时会提示输入（不回显），
直接回车就改用浏览器授权（同 kioku login）。
Claude Code 不带 --server-url 运行时仅停用自动记忆。
只改平台设置里和 Kioku 有关的几项，第一次改之前把原来的文件备份成同目录下的 <文件名>.kioku-backup（已有备份时不覆盖）。
改完新开会话生效。本地已有的记忆文件不会被删掉。
`

// 给各平台的 setup 用的浏览器授权：按平台的运行时申请
function browserLogin(out: Writer) {
  return ({ url, id }: { url: string; id: string }) =>
    deviceLogin({ url, runtimeFamily: PLATFORMS[id].runtimeFamily }, { out })
}

export function parseSetupArgs(argv: string[]): SetupOptions & { platform: string } {
  const options: SetupOptions = {
    dryRun: false,
    undo: false,
    check: true,
    serverUrl: undefined,
    removeConflicts: false,
  }
  const names: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--undo') options.undo = true
    else if (arg === '--no-check') options.check = false
    else if (arg === '--remove-conflicts') options.removeConflicts = true
    else if (arg === '--server-url') {
      options.serverUrl = argv[++i]
      if (!options.serverUrl) throw new UsageError('--server-url 后面要写地址')
    } else if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    else names.push(arg)
  }
  if (names.length !== 1) throw new UsageError('要写一个平台')
  if (!Object.hasOwn(PLATFORMS, names[0])) {
    throw new UsageError(`不认识的平台 ${names[0]}，可以用的：${platformNames()}`)
  }
  const platform = PLATFORMS[names[0]]
  if (!platform.setup && (options.serverUrl !== undefined || !options.check)) {
    throw new UsageError(
      `${platform.name} 的地址与访问密钥在它自己的插件配置里填，不用 --server-url、--no-check`,
    )
  }
  return { ...options, platform: names[0] }
}

export async function setup(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    stdin = process.stdin,
    readKey = readSecret,
    skipConflicts = false,
    // 在终端里运行、没给访问密钥时可以改用浏览器授权；不在终端里（管道、agent 的命令）时没有；传 null 是明说不要
    login = process.stdin.isTTY ? browserLogin(out) : null,
  }: {
    env?: Env
    out?: Writer
    cwd?: string
    stdin?: Reader
    readKey?: (opts: { env: Env; canLogin?: boolean; hasSaved?: boolean }) => Promise<string>
    skipConflicts?: boolean
    login?: ((opts: { url: string; id: string }) => Promise<string>) | null
  } = {},
): Promise<number> {
  const options = parseSetupArgs(argv)
  const { platform: id, dryRun, undo, removeConflicts } = options
  const platform = PLATFORMS[id]
  if (!undo && !skipConflicts) {
    const status = await ensureNoConflicts(id, platform.name, {
      env,
      cwd,
      out,
      stdin,
      remove: removeConflicts,
      dryRun,
    })
    if (status === 'cancelled') return 0
  }
  if (!platform.setup) {
    throw new KiokuFailure(`平台 ${id} 不支持自动配置`)
  }
  return platform.setup(options, { env, out, cwd, readKey, plain, login })
}
