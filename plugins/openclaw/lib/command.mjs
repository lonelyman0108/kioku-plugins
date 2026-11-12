// 起 npm 装的那类外部命令（openclaw、hermes，以及 kioku run 要跑的命令）。
// Windows 上这类命令是 .cmd 文件，不经 cmd.exe 起不来（直接起会报找不到，或者被 Node 拒绝），
// 而经 cmd.exe 时参数要按它的规则转义，否则参数里的 & | % 这类字符会被当成命令。
// 别的系统上什么都不做，原样交给系统：找命令、判断能不能执行都是系统的事。
// 转义的规则照 cross-spawn 的做法写（MIT，来源登记在 NOTICE）

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { join, win32 } from 'node:path'

import { KiokuFailure } from './http.mjs'

const isFile = (file) => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// Windows 的环境变量名不分大小写。同一个名字写了几种大小写时（Path 与 PATH），
// 取排序后的第一个：Node 把环境交给子进程时也是这样取的，两边看到的要是同一个
export function envValue(env, name) {
  const key = Object.keys(env)
    .filter((item) => item.toLowerCase() === name.toLowerCase())
    .sort()[0]
  return key === undefined ? undefined : env[key]
}

// Windows 上一个命令的完整路径；找不到为 null。名字里带目录时只看这个位置，否则在 PATH 里逐个目录找。
// 名字没写扩展名时只按 PATHEXT 补上扩展名找，不找原样的名字：npm 在 .cmd 旁边还放着一个同名、
// 没有扩展名的脚本（给 sh 用的），Windows 起不了它
export function findCommand(name, env, { exists = isFile } = {}) {
  if (typeof name !== 'string' || !name) return null
  const extensions = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const suffixes = win32.extname(name) ? ['', ...extensions] : extensions
  const dirs = /[\\/]/.test(name)
    ? ['']
    : (envValue(env, 'PATH') ?? '')
        .split(win32.delimiter)
        // 带空格的目录有人会加上引号
        .map((dir) => dir.replace(/^"(.*)"$/, '$1'))
        .filter(Boolean)
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const file = (dir ? win32.join(dir, name) : name) + suffix
      if (exists(file)) return file
    }
  }
  return null
}

// PATH 里有没有这个命令（向导的面板用来看平台装没装）。Windows 上照 findCommand 的规则找；
// 别的系统上找能执行的普通文件
export function hasCommand(name, env, { platform = process.platform } = {}) {
  if (platform === 'win32') return findCommand(name, env) !== null
  if (typeof name !== 'string' || !name) return false
  const dirs = /\//.test(name) ? [''] : (envValue(env, 'PATH') ?? '').split(':').filter(Boolean)
  return dirs.some((dir) => {
    const file = dir ? join(dir, name) : name
    try {
      accessSync(file, constants.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  })
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

// 怎么起这个命令：{ file, args, options, shell }，交给 spawn、execFile；Windows 上找不到这个命令时为 null。
// shell 为真表示中间隔着一层 cmd.exe，结束它要用 killTree。别的系统上原样返回，找不到由系统报 ENOENT
export function launch(name, args, env, { platform = process.platform, exists } = {}) {
  if (platform !== 'win32') return { file: name, args, options: {}, shell: false }
  const file = findCommand(name, env, { exists })
  if (!file) return null
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, options: {}, shell: false }
  // cmd.exe 把换行当成一行命令的结尾，后面的参数会悄悄丢掉：不起
  if ([file, ...args].some((item) => /[\r\n]/.test(String(item)))) {
    throw new KiokuFailure('参数里有换行，经 cmd.exe 起的命令收不到完整的参数')
  }
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const line = [file.replace(META, '^$1'), ...args.map((arg) => escapeArgument(arg, twice))]
  return {
    file: envValue(env, 'ComSpec') || 'cmd.exe',
    // /d 不跑注册表里的自动命令，/s 加外层引号让整行原样交给 /c
    args: ['/d', '/s', '/c', `"${line.join(' ')}"`],
    // 这一行已经按 cmd.exe 的规则写好了，不让 Node 再加一层引号
    options: { windowsVerbatimArguments: true },
    shell: true,
  }
}

// 结束一个起好的命令。隔着 cmd.exe 时只结束它的话，真正的命令还活着、还占着输出的管道，
// 所以连它下面的进程一起结束（Windows 上没有信号可转，只能强行结束）
export function killTree(child, signal, { shell, platform = process.platform } = {}) {
  if (platform !== 'win32' || !shell || child.pid === undefined) return child.kill(signal)
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
      'error',
      () => child.kill(),
    )
    return true
  } catch {
    return child.kill()
  }
}

// 跑一个命令到结束，收下它的输出：{ found: false }（没有这个命令），
// 或者 { found: true, ok, stdout, output }（output 是两路输出合在一起，只用来认是哪种失败）。
// 超过时限就结束它（连同它下面的进程），算失败。不抛错
export function capture(name, args, env, { timeout, maxBuffer = 8 * 1024 * 1024 } = {}) {
  let run
  try {
    run = launch(name, args, env)
  } catch {
    return Promise.resolve({ found: true, ok: false, stdout: '', output: '' })
  }
  if (!run) return Promise.resolve({ found: false })
  return new Promise((resolve) => {
    let timer
    const child = execFile(
      run.file,
      run.args,
      { env, maxBuffer, ...run.options },
      (err, stdout, stderr) => {
        clearTimeout(timer)
        if (err?.code === 'ENOENT') resolve({ found: false })
        else {
          const out = String(stdout ?? '')
          resolve({ found: true, ok: !err, stdout: out, output: `${out}\n${stderr ?? ''}` })
        }
      },
    )
    if (timeout) {
      timer = setTimeout(() => killTree(child, 'SIGTERM', { shell: run.shell }), timeout)
      timer.unref?.()
    }
  })
}
