// 找一个命令、算出该怎么起它。Windows 上 npm 装的命令是 .cmd 文件，不经 cmd.exe 起不来
// （直接起会报找不到，或者被 Node 拒绝），而经 cmd.exe 时参数要按它的规则转义，否则参数里的 & | % 这类字符
// 会被当成命令。别的系统上原样交给系统。
// 转义的规则照 cross-spawn 的做法写（MIT，来源登记在 NOTICE）

import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

const isFile = (file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// 命令的完整路径；找不到为 null。名字里带目录时只看这个位置，否则在 PATH 里逐个目录找。
// Windows 上名字没写扩展名时按 PATHEXT 逐个补上试，环境变量的名字不分大小写
export function findCommand(name, env, { platform = process.platform, exists = isFile } = {}) {
  if (typeof name !== 'string' || !name) return null
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const read = (key) => {
    if (!windows) return env[key]
    const found = Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
    return found === undefined ? undefined : env[found]
  }
  const suffixes = windows
    ? ['', ...(read('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']
  // 已经写了扩展名的（kioku.cmd）补不补都试，原样的排在前面
  const candidates = (base) => suffixes.map((suffix) => base + suffix)
  const direct = /[\\/]/.test(name) && (windows || name.includes('/'))
  const dirs = direct ? [''] : (read('PATH') ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const file of candidates(dir ? path.join(dir, name) : name)) {
      if (exists(file)) return file
    }
  }
  return null
}

// cmd.exe 认作有特殊含义的字符
const META = /([()\][%!^"`<>&|;, *?])/g

// 一个参数在 cmd.exe 的命令行里的写法：先按 Windows 程序解析参数的规则加引号、处理反斜杠与引号，
// 再给 cmd.exe 自己的特殊字符加 ^。经 node_modules/.bin 里的 .cmd 转一道的要转义两遍（它里面又解析一次）
function escapeArgument(value, twice) {
  let arg = String(value)
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1')
  arg = `"${arg}"`.replace(META, '^$1')
  return twice ? arg.replace(META, '^$1') : arg
}

// 起这个命令要交给 spawn、execFile 的 { file, args, options }。file 是 findCommand 找到的完整路径
export function invocation(file, args, env, { platform = process.platform } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args, options: {} }
  const comspec =
    env[Object.keys(env).find((key) => key.toLowerCase() === 'comspec') ?? ''] || 'cmd.exe'
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const line = [file.replace(META, '^$1'), ...args.map((arg) => escapeArgument(arg, twice))]
  return {
    file: comspec,
    // /d 不跑注册表里的自动命令，/s 加外层引号让整行原样交给 /c
    args: ['/d', '/s', '/c', `"${line.join(' ')}"`],
    // 这一行已经按 cmd.exe 的规则写好了，不让 Node 再加一层引号
    options: { windowsVerbatimArguments: true },
  }
}
