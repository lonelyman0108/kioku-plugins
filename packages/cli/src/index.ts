// @kioku-memory/cli 的统一入口：交互式控制台面板与各个子命令分发

import { clean, CLEAN_USAGE } from './clean.ts'
import {
  CONNECT_USAGE,
  connectCommand,
  DISCONNECT_USAGE,
  disconnectCommand,
  LOCAL_USAGE,
  localCommand,
  OPEN_USAGE,
  openCommand,
  UPGRADE_USAGE,
  upgradeCommand,
} from './commands/manage.ts'
import {
  ADD_USAGE,
  addCommand,
  GET_USAGE,
  getCommand,
  LS_USAGE,
  lsCommand,
  SEARCH_USAGE,
  searchCommand,
} from './commands/memory.ts'
import { STATUS_USAGE, statusCommand } from './commands/status.ts'
import { KiokuFailure, run, UsageError } from './core.ts'
import { doctor, DOCTOR_USAGE } from './doctor.ts'
import { IMPORT_USAGE, importMemories } from './import.ts'
import { install, INSTALL_USAGE } from './install.ts'
import { login, LOGIN_USAGE } from './login.ts'
import { loadPrompts, nodeSupported } from './prompts.ts'
import { setup, SETUP_USAGE } from './setup.ts'
import { runTui } from './ui/tui.ts'
import { barOut, wizard } from './wizard.ts'

export { RUN_USAGE as USAGE, UsageError, parseRunArgs, run } from './core.ts'

const OVERVIEW = `用法：kioku <子命令> [参数…]

日常记忆读写：
  search      召回相关记忆，支持交互展开详情与 --json
  get         按坐标读取单条记忆的完整内容与属性
  ls          按归属或前缀路径浏览记忆目录结构
  add         写入新记忆（支持标准输入管道、编辑器与明文拦阻确认）

客户端与连接管理：
  status      查看服务端连接状态与本机各平台接入概况（支持 --json）
  connect     一站式接入：浏览器授权、配置写入、安装插件与 MCP 握手测试
  disconnect  断开某个平台的接入，恢复自带记忆并清理托管插件
  upgrade     升级已安装插件并刷新 MCP 工具清单缓存
  doctor      诊断地址、访问密钥权限与各平台配置（支持 --all / --json）
  clean       检测并卸载冲突的记忆工具（Lore 及常见记忆 MCP）

自动化、本机服务与凭据：
  login       用浏览器授权签发访问密钥并配好单个平台
  setup       停用平台自带的长期记忆，由 Kioku 接管
  install     批量接入多个平台，访问密钥从环境变量读（给脚本用）
  import      把平台自带的本地长期记忆迁进 Kioku
  local       使用 Docker Compose 管理本机 Kioku 服务（up / down / status / logs）
  open        在默认浏览器中打开 Kioku 管理界面
  run         向 Kioku 取凭据的值，放进环境变量交给命令

在终端里不带参数运行 kioku 是交互式控制台：浏览各平台现状并按需完成接入、诊断与迁移。
各子命令的说明：kioku <子命令> --help
`

const NO_WIZARD = '交互式的向导需要 Node.js 20.12 以上版本。\n'

async function startWizard(): Promise<number> {
  if (!nodeSupported()) {
    process.stderr.write(`${OVERVIEW}\n${NO_WIZARD}`)
    return 2
  }
  if (process.env.TERM === 'dumb') {
    const ui = await loadPrompts()
    if (!ui) {
      process.stderr.write(`${OVERVIEW}\n${NO_WIZARD}`)
      return 2
    }
    return wizard({ ui, env: process.env, cwd: process.cwd(), out: barOut(process.stdout) })
  }
  return runTui({ env: process.env, cwd: process.cwd(), stdin: process.stdin, out: process.stdout })
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
  if (sub === 'search') return guarded('search', SEARCH_USAGE, (a) => searchCommand(a), rest)
  if (sub === 'get') return guarded('get', GET_USAGE, (a) => getCommand(a), rest)
  if (sub === 'ls') return guarded('ls', LS_USAGE, (a) => lsCommand(a), rest)
  if (sub === 'add') return guarded('add', ADD_USAGE, (a) => addCommand(a), rest)
  if (sub === 'status') return guarded('status', STATUS_USAGE, (a) => statusCommand(a), rest)
  if (sub === 'connect') return guarded('connect', CONNECT_USAGE, (a) => connectCommand(a), rest)
  if (sub === 'disconnect') {
    return guarded('disconnect', DISCONNECT_USAGE, (a) => disconnectCommand(a), rest)
  }
  if (sub === 'upgrade') return guarded('upgrade', UPGRADE_USAGE, (a) => upgradeCommand(a), rest)
  if (sub === 'local') return guarded('local', LOCAL_USAGE, (a) => localCommand(a), rest)
  if (sub === 'open') return guarded('open', OPEN_USAGE, (a) => openCommand(a), rest)
  if (sub === 'login') return guarded('login', LOGIN_USAGE, (a) => login(a), rest)
  if (sub === 'setup') return guarded('setup', SETUP_USAGE, (a) => setup(a), rest)
  if (sub === 'install') return guarded('install', INSTALL_USAGE, (a) => install(a), rest)
  if (sub === 'doctor') return guarded('doctor', DOCTOR_USAGE, (a) => doctor(a), rest)
  if (sub === 'clean') return guarded('clean', CLEAN_USAGE, (a) => clean(a), rest)
  if (sub === 'import') return guarded('import', IMPORT_USAGE, (a) => importMemories(a), rest)
  process.stderr.write(sub === undefined ? OVERVIEW : `kioku：不认识的子命令 ${sub}\n\n${OVERVIEW}`)
  return 2
}
