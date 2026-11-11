// kioku setup：把平台交给 Kioku 接管。平台有自己的一套步骤时（codex）交给它，否则按下面通用的做法：
// 停用平台自带的长期记忆，只改平台的用户设置里的那几项，
// 改之前显示要改什么、留一份备份；--undo 只把这几项改回去，不动设置里的其他内容（文件会按 JSON 重新排版）

import { readSettings, writeSettings } from './files.mjs'
import { plain } from './text.mjs'
import { platformNames, PLATFORMS } from './platforms.mjs'
import { readSecret } from './secret.mjs'
import { UsageError } from './usage.mjs'

export { readSettings, writeSettings }

export const SETUP_USAGE = `用法：kioku setup <平台> [--dry-run] [--undo] [--server-url <地址>] [--no-check]

把平台交给 Kioku 接管：停用平台自带的长期记忆；没有自己的密钥存储的平台（codex）再写下服务地址与访问密钥。

  <平台>               ${platformNames()}
  --dry-run            只显示要改什么，不写文件
  --undo               改回去：重新启用平台自带的长期记忆，删掉写下的地址与访问密钥
  --server-url <地址>  Kioku 的服务地址，例如 https://kioku.example.com（codex 用；也可以用 KIOKU_SERVER_URL）
  --no-check           不先连一次 Kioku 核对地址与访问密钥（codex 用）

访问密钥不写在命令行上：从 KIOKU_API_KEY 读，或者从标准输入读（echo 之外，在终端里运行时会提示输入、不回显）。
只改平台设置里和 Kioku 有关的几项，第一次改之前把原来的文件备份成同目录下的 <文件名>.kioku-backup（已有备份时不覆盖）。
改完新开会话生效。本地已有的记忆文件不会被删掉。
`

export function parseSetupArgs(argv) {
  const options = { dryRun: false, undo: false, check: true, serverUrl: undefined }
  const names = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--undo') options.undo = true
    else if (arg === '--no-check') options.check = false
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

function shown(value) {
  return value === undefined ? '（未设置）' : JSON.stringify(value)
}

export async function setup(
  argv,
  { env = process.env, out = process.stdout, cwd = process.cwd(), readKey = readSecret } = {},
) {
  const options = parseSetupArgs(argv)
  const { platform: id, dryRun, undo } = options
  const platform = PLATFORMS[id]
  // 有自己的一套步骤的平台
  if (platform.setup) return platform.setup(options, { env, out, cwd, readKey, plain })
  const { memory } = platform
  const file = platform.settingsFile(env)
  const { settings, text } = await readSettings(file)
  const next = undo ? memory.restore(settings) : memory.disable(settings)
  const changes = memory.changed.filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(next[key]),
  )
  const goal = undo ? '已启用' : '已停用'
  if (!changes.length) {
    out.write(`${platform.name} 的${memory.name}${goal}，${file} 不用改\n`)
  } else {
    out.write(`${file}\n`)
    for (const key of changes) {
      out.write(`  ${key}：${shown(settings[key])} → ${shown(next[key])}\n`)
    }
    if (dryRun) {
      out.write('没有写入（--dry-run）\n')
      return 0
    }
    const backedUp = await writeSettings(file, next, text)
    if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
    else if (text !== null) out.write(`${file}.kioku-backup 已有更早的备份，没有覆盖\n`)
    out.write(`${platform.name} 的${memory.name}${goal}，新开会话生效\n`)
  }
  // 别处也停用着时，改回设置并不能重新启用它；别处又启用了时，停用也不生效
  const by = undo ? memory.disabledBy(next, env) : null
  if (by) out.write(`注意：${by}仍然停用着它\n`)
  const again = undo ? null : await memory.enabledBy(env, cwd)
  if (again) out.write(`注意：${again}又启用了它，要在那里一起改\n`)
  return 0
}
