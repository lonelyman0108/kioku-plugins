// 插件目录里放着的精简 kioku 入口：只实现 kioku run（插件启用期间放在 PATH 里给 Bash 工具用）。
// 向导、接入、检查、日常记忆读写等完整命令行在 npm 包 @kioku-memory/cli

import { parseRunArgs, run, USAGE, UsageError } from './run.mjs'

export { parseRunArgs, run, USAGE, UsageError }

const OVERVIEW = `用法：kioku run -e 变量=<标识>#<字段> [-e …] [--purpose <用途>] -- <命令> [参数…]

插件目录内置的命令行入口仅包含 kioku run（向 Kioku 取凭据，放进环境变量并打码输出）。
向导、接入管理与记忆读写等完整功能见 @kioku-memory/cli：

  npx @kioku-memory/cli
  npm install -g @kioku-memory/cli

运行子命令用法：kioku run --help
`

const FULL_CLI_COMMANDS = new Set([
  'connect',
  'disconnect',
  'upgrade',
  'status',
  'login',
  'setup',
  'install',
  'doctor',
  'clean',
  'import',
  'local',
  'open',
  'search',
  'get',
  'ls',
  'add',
])

export async function main(argv) {
  const [sub, ...rest] = argv
  if (sub === '-h' || sub === '--help') {
    process.stdout.write(OVERVIEW)
    return 0
  }
  if (sub === 'run') return run(rest)
  if (sub && FULL_CLI_COMMANDS.has(sub)) {
    process.stderr.write(
      `kioku：插件内置入口仅含 run 子命令；运行 npx @kioku-memory/cli ${sub}（或全局安装 @kioku-memory/cli）\n`,
    )
    return 2
  }
  process.stderr.write(sub === undefined ? OVERVIEW : `kioku：不认识的子命令 ${sub}\n\n${OVERVIEW}`)
  return 2
}
