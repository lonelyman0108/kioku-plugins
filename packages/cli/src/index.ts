// @kioku-memory/cli 的统一入口：交互式向导与各个子命令分发

import { clean, CLEAN_USAGE } from './clean.ts'
import { KiokuFailure, run, UsageError } from './core.ts'
import { doctor, DOCTOR_USAGE } from './doctor.ts'
import { IMPORT_USAGE, importMemories } from './import.ts'
import { install, INSTALL_USAGE } from './install.ts'
import { login, LOGIN_USAGE } from './login.ts'
import { loadPrompts } from './prompts.ts'
import { setup, SETUP_USAGE } from './setup.ts'
import { barOut, wizard } from './wizard.ts'

export { RUN_USAGE as USAGE, UsageError, parseRunArgs, run } from './core.ts'

const OVERVIEW = `用法：kioku <子命令> [参数…]

  run      向 Kioku 取凭据的值，放进环境变量交给命令
  login    用浏览器授权签发访问密钥并配好这个平台
  setup    停用平台自带的长期记忆，由 Kioku 接管
  install  几个平台一起接入，访问密钥从环境变量读（给脚本用）
  doctor   检查地址、访问密钥与平台的配置
  clean    检测并卸载冲突的记忆工具（Lore 及常见记忆 MCP）
  import   把平台自带的本地长期记忆迁进 Kioku

在终端里不带参数运行 kioku 是交互式的向导：看各平台接到哪一步，按缺的一步步接上。
各子命令的说明：kioku <子命令> --help
`

const NO_WIZARD = '交互式的向导需要 Node.js 20.12 以上版本。\n'

async function startWizard(): Promise<number> {
  const ui = await loadPrompts()
  if (!ui) {
    process.stderr.write(`${OVERVIEW}\n${NO_WIZARD}`)
    return 2
  }
  return wizard({ ui, env: process.env, cwd: process.cwd(), out: barOut(process.stdout) })
}

// 说明类的子命令：参数写错时打印原因与说明，以 2 退出；别的失败原因写到标准错误
async function guarded(
  name: string,
  usage: string,
  fn: (argv: string[]) => Promise<number>,
  argv: string[],
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(usage)
    return 0
  }
  try {
    return await fn(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`kioku ${name}：${err.message}\n\n${usage}`)
      return 2
    }
    if (err instanceof KiokuFailure) {
      process.stderr.write(`kioku ${name}：${err.message}\n`)
      return 2
    }
    throw err
  }
}

export async function main(
  argv: string[],
  {
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    wizard: runWizard = startWizard,
  }: { interactive?: boolean; wizard?: () => Promise<number> } = {},
): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined && interactive) return runWizard()
  if (sub === '-h' || sub === '--help') {
    process.stdout.write(OVERVIEW)
    return 0
  }
  if (sub === 'run') return run(rest)
  if (sub === 'login') return guarded('login', LOGIN_USAGE, (a) => login(a), rest)
  if (sub === 'setup') return guarded('setup', SETUP_USAGE, (a) => setup(a), rest)
  if (sub === 'install') return guarded('install', INSTALL_USAGE, (a) => install(a), rest)
  if (sub === 'doctor') return guarded('doctor', DOCTOR_USAGE, (a) => doctor(a), rest)
  if (sub === 'clean') return guarded('clean', CLEAN_USAGE, (a) => clean(a), rest)
  if (sub === 'import') return guarded('import', IMPORT_USAGE, (a) => importMemories(a), rest)
  process.stderr.write(sub === undefined ? OVERVIEW : `kioku：不认识的子命令 ${sub}\n\n${OVERVIEW}`)
  return 2
}
