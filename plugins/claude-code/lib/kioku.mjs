// kioku 命令。kioku run 向 Kioku 取凭据的值，放进环境变量交给要跑的命令，命令的输出打过码再写出：
// 命令行、对话记录与发给模型的内容里只有变量名。
// 报错的文字都不带值和访问密钥：spawn 的参数错误会带出环境变量的值，fetch 的错误会带出请求头，
// 所以这两处只取错误类别

import { spawn } from 'node:child_process'
import { readFile, utimes } from 'node:fs/promises'
import { constants } from 'node:os'
import { isatty } from 'node:tty'

import {
  errorKind,
  fetchFailure,
  isRedirect,
  keyFormatError,
  KiokuFailure,
  redirectError,
} from './http.mjs'
import { createRedactor, MIN_REDACT_CHARS, redactable } from './redact.mjs'

// 等 Kioku 取值的上限（毫秒）
const TIMEOUT = 15_000
// 与服务端的上限一致
const MAX_REFS = 32
const MAX_PURPOSE = 200
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const CONTROL = /\p{Cc}/u
// 不给命令留这两个变量，免得它把访问密钥或文件的位置顺手打印出来。这不是隔离：
// 访问密钥文件和命令属于同一个用户，命令照样读得到
const KEY_VARIABLES = ['KIOKU_API_KEY', 'KIOKU_API_KEY_FILE']
// 收到这些信号时转给命令。有终端时 SIGINT 除外：终端的 Ctrl-C 发给整个前台进程组，命令和 kioku 在同一个组里，
// 已经收到了，再转一次就成了两次（有的工具连按两次会跳过清理）；SIGINT 照样接住，kioku 才能等命令处理完。
// 没有终端时（例如 Claude Code 的 Bash 工具）SIGINT 是单独发给 kioku 的，照样转发。
// 发给整个进程组的 SIGTERM、SIGHUP（没有终端时还有 SIGINT），命令会收到两次，这是已知的限制
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
// 标准输入、输出或错误有一个是终端，就当作在终端里运行。用 isatty 查文件描述符，不碰 process.stdin：
// 那会建出读标准输入的流
const FROM_TERMINAL = isatty(0) || isatty(1) || isatty(2)
// 不发给自己的信号，退回 128 + 信号编号：SIGUSR1 会打开 Node 的调试端口，SIGPIPE 被 Node 忽略；
// 其余的会让 Node 自己转储，崩溃报告也算到 kioku 头上
const NOT_RERAISED = new Set([
  'SIGUSR1',
  'SIGPIPE',
  'SIGSEGV',
  'SIGABRT',
  'SIGBUS',
  'SIGILL',
  'SIGFPE',
  'SIGQUIT',
  'SIGTRAP',
  'SIGSYS',
  'SIGXCPU',
  'SIGXFSZ',
])

export const USAGE = `用法：kioku run -e 变量=<标识>#<字段> [-e …] [--purpose <用途>] -- <命令> [参数…]

向 Kioku 取凭据的值，放进环境变量交给命令；命令行和对话记录里只有变量名。
命令输出里原样出现的值换成 ***（少于 ${MIN_REDACT_CHARS} 个字符的值除外）。
打码只防值顺手出现在输出里，不是安全边界。

  -e 变量=<标识>#<字段>  凭据 <标识> 的 <字段> 放进这个环境变量，可以写多个
  --purpose <用途>       这次取用的用途，记进访问记录，最多 ${MAX_PURPOSE} 个字；用途里有空格时要加引号
  -h, --help             显示本说明

命令不经过 shell 直接执行。参数里写的 $变量 会被外层的 shell 提前展开成空值；
要在参数里用变量，或者要用管道、重定向时，写成 sh -c '…'，整段用单引号，变量放在双引号里：

  kioku run -e PGPASSWORD=pg-main#password -- psql -h db.example.com -U app
  kioku run -e TOKEN=github#token --purpose '查看 issue' -- sh -c 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/issues'

退出码与命令相同，命令被信号结束时 kioku 也以同一个信号结束；参数不对、取值失败时为 2。
地址与访问密钥：Claude Code 插件在会话开始时配好；在别处用时设置 KIOKU_SERVER_URL 与 KIOKU_API_KEY。
`

const NOT_CONFIGURED =
  '缺少 Kioku 的地址或访问密钥：在 Claude Code 里启用 kioku 插件、填好配置后新开会话，或者设置 KIOKU_SERVER_URL 与 KIOKU_API_KEY'

// 参数写错：打印说明后以 2 退出
export class UsageError extends Error {}

// 解析 kioku run 的参数。要看说明时返回 { help: true }；否则返回 refs（要取的标识与字段，同一对只取一次）、
// variables（[变量名, 值在 refs 里的下标]）、purpose、command 与 args
export function parseRunArgs(argv) {
  const refs = []
  const refIndex = new Map()
  const variables = new Map()
  let purpose
  let purposeGiven = false
  let i = 0
  for (; i < argv.length && argv[i] !== '--'; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return { help: true }
    if (arg === '-e') {
      if (++i >= argv.length) throw new UsageError('-e 后面要写 变量=<标识>#<字段>')
      const { name, identifier, field } = parseVariable(argv[i])
      if (variables.has(name)) throw new UsageError(`变量 ${name} 写了两次`)
      const ref = `${identifier}#${field}`
      if (!refIndex.has(ref)) {
        refIndex.set(ref, refs.length)
        refs.push({ identifier, field })
      }
      variables.set(name, refIndex.get(ref))
    } else if (arg === '--purpose' || arg.startsWith('--purpose=')) {
      if (purposeGiven) throw new UsageError('--purpose 只能写一次')
      purposeGiven = true
      if (arg === '--purpose' && ++i >= argv.length) throw new UsageError('--purpose 后面要写用途')
      purpose = parsePurpose(arg === '--purpose' ? argv[i] : arg.slice('--purpose='.length))
    } else {
      throw new UsageError(arg.startsWith('-') ? `不认识的参数 ${arg}` : '命令前面要写 --')
    }
  }
  if (i >= argv.length) throw new UsageError('命令前面要写 --')
  const command = argv[i + 1]
  if (!command) throw new UsageError('-- 后面要写命令')
  if (variables.size === 0) throw new UsageError('至少要写一个 -e')
  if (refs.length > MAX_REFS) throw new UsageError(`一次最多取 ${MAX_REFS} 个字段`)
  return { refs, variables: [...variables], purpose, command, args: argv.slice(i + 2) }
}

// 等号后面写错时只说格式，不复述写的内容：那里可能误填了值本身
function parseVariable(spec) {
  const eq = spec.indexOf('=')
  if (eq <= 0) throw new UsageError('-e 要写成 变量=<标识>#<字段>')
  const name = spec.slice(0, eq)
  if (!VARIABLE.test(name)) {
    throw new UsageError(`变量名 ${name} 只能用字母、数字和下划线，不能以数字开头`)
  }
  const [identifier, field, ...rest] = spec.slice(eq + 1).split('#')
  if (rest.length > 0 || !NAME.test(identifier) || !NAME.test(field ?? '')) {
    throw new UsageError(
      `${name} 要写成 ${name}=<标识>#<字段>；标识与字段名只用小写字母、数字、_ 和 -，以字母或数字开头，最长 64 个字符`,
    )
  }
  return { name, identifier, field }
}

// 与服务端的规则一致：去掉首尾空白后不超过上限，不含控制字符，只有空白的当作没写
function parsePurpose(value) {
  const text = value.trim()
  if (text.length > MAX_PURPOSE) throw new UsageError(`--purpose 最多 ${MAX_PURPOSE} 个字`)
  if (CONTROL.test(text)) throw new UsageError('--purpose 不能有换行等控制字符')
  return text || undefined
}

// 地址与访问密钥。访问密钥先读插件在会话开始时配好的 KIOKU_API_KEY_FILE，读不到再用 KIOKU_API_KEY；
// 两样都没有才报错，报错只写文件的位置与错误类别
async function loadConfig(env) {
  const url = (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const file = env.KIOKU_API_KEY_FILE
  let key = ''
  let fileProblem
  if (file) {
    try {
      key = (await readFile(file, 'utf8')).trim()
      if (!key) fileProblem = '文件是空的'
    } catch (err) {
      fileProblem = errorKind(err)
    }
    // 用的时候更新修改时间：会话开始时会删掉很久没用过的访问密钥文件
    if (key) await utimes(file, new Date(), new Date()).catch(() => {})
  }
  if (!key) key = (env.KIOKU_API_KEY ?? '').trim()
  if (!url) throw new KiokuFailure(NOT_CONFIGURED)
  if (!key) {
    throw new KiokuFailure(
      fileProblem
        ? `无法读取访问密钥文件 ${file}（${fileProblem}）：新开会话，或者设置 KIOKU_API_KEY`
        : NOT_CONFIGURED,
    )
  }
  let protocol
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new KiokuFailure('KIOKU_SERVER_URL 不是有效的地址')
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new KiokuFailure('KIOKU_SERVER_URL 要以 http:// 或 https:// 开头')
  }
  const problem = keyFormatError(key)
  if (problem) throw new KiokuFailure(problem)
  return { url, key }
}

// 服务端的错误文字原样给出，只去掉控制字符；万一带着访问密钥也盖掉
function serverError(data, status, key) {
  const text = typeof data?.error === 'string' ? data.error : ''
  const clean = text
    .split(key)
    .join('***')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
  return clean || `Kioku 返回 HTTP ${status}`
}

// 按 refs 的顺序取出响应里的值；对不上时为 null
function valuesOf(data, refs) {
  if (!Array.isArray(data?.values) || data.values.length !== refs.length) return null
  const byRef = new Map()
  for (const item of data.values) {
    if (typeof item?.identifier !== 'string' || typeof item.field !== 'string') return null
    if (typeof item.value !== 'string') return null
    byRef.set(`${item.identifier}#${item.field}`, item.value)
  }
  const values = refs.map((r) => byRef.get(`${r.identifier}#${r.field}`))
  return values.every((v) => v !== undefined) ? values : null
}

// 一次请求取全部值：任何一项取不到时整次失败，响应里不带值
async function resolveValues({ url, key }, refs, purpose) {
  let res
  let text
  try {
    res = await fetch(`${url}/v1/credentials/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(purpose === undefined ? { refs } : { refs, purpose }),
      // 不跟着跳转走：访问密钥只发给配置的地址
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    text = await res.text()
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    // 不是 JSON 时按没有错误文字处理
  }
  if (!res.ok) throw new KiokuFailure(serverError(data, res.status, key))
  const values = valuesOf(data, refs)
  if (!values) throw new KiokuFailure('Kioku 的响应格式不对')
  return values
}

// 子进程的一路输出打过码写到本进程对应的输出，全部写出之后 resolve
function relay(source, target, values) {
  const redactor = createRedactor(values)
  source.pipe(redactor)
  redactor.pipe(target, { end: false })
  // 子进程这一路出错或没有正常结束就关了，也把留着的尾巴冲刷出去
  const finish = () => {
    if (!redactor.writableEnded) redactor.end()
  }
  source.once('error', finish)
  source.once('close', finish)
  target.on('error', () => {
    // 下游已经关了（例如后面接着 head）：不再读这一路，子进程再写就收到 SIGPIPE，和直接接在管道上一样
    redactor.unpipe(target)
    redactor.resume()
    source.destroy()
  })
  return new Promise((resolve) => redactor.once('end', resolve))
}

// 本进程的标准输出与标准错误都写完：之前写进去的都交给系统之后才回调。自己以信号结束之前要等这一步，
// 否则还排着队的输出就丢了
function flushed() {
  const flush = (stream) => new Promise((resolve) => stream.write('', () => resolve()))
  return Promise.all([flush(process.stdout), flush(process.stderr)])
}

// 以这个信号结束本进程：外层的 shell 据此决定要不要停下。例如循环里按了 Ctrl-C，
// kioku 按 128 + n 正常退出的话，shell 当作命令自己处理了 SIGINT，循环会接着跑。
// 发不出、或者发了进程还在的，退回 128 + 信号编号作为退出码
function exitBySignal(signal) {
  if (!NOT_RERAISED.has(signal)) {
    try {
      process.kill(process.pid, signal)
    } catch {
      // 认不出的信号名
    }
  }
  return 128 + (constants.signals[signal] ?? 0)
}

// 启动命令，等它结束、输出写完，返回退出码；命令被信号结束时本进程以同一个信号结束
function runCommand(command, args, env, values) {
  return new Promise((resolve) => {
    let child
    try {
      // 不用 detached：命令留在 kioku 的进程组里，整组被结束时它不会变成带着值的孤儿进程
      child = spawn(command, args, { env, stdio: ['inherit', 'pipe', 'pipe'] })
    } catch (err) {
      process.stderr.write(`kioku：无法启动 ${command}（${errorKind(err)}）\n`)
      resolve(126)
      return
    }
    let failure
    child.once('error', (err) => {
      failure = err
    })
    // 命令结束之后、输出写完之前收到的信号：等输出写完，kioku 以它结束
    let late
    const stopListening = () => {
      for (const signal of SIGNALS) process.off(signal, onSignal)
    }
    const onSignal = (signal) => {
      if (child.exitCode === null && child.signalCode === null) {
        if (signal !== 'SIGINT' || !FROM_TERMINAL) child.kill(signal)
        return
      }
      if (late === undefined) {
        // 命令已经结束、输出还没写完：交给下面 close 的处理，写完再结束
        late = signal
        return
      }
      // 又收到一次：不再等（例如命令留下的后台进程一直占着输出），立刻以这个信号结束
      stopListening()
      process.kill(process.pid, signal)
    }
    for (const signal of SIGNALS) process.on(signal, onSignal)
    const outputs = [
      relay(child.stdout, process.stdout, values),
      relay(child.stderr, process.stderr, values),
    ]
    child.once('close', async (code, signal) => {
      await Promise.all(outputs)
      if (child.pid === undefined) {
        stopListening()
        // 没能启动：和 shell 一样，找不到命令为 127，别的为 126
        const notFound = failure?.code === 'ENOENT'
        process.stderr.write(
          notFound
            ? `kioku：找不到命令 ${command}\n`
            : `kioku：无法启动 ${command}（${errorKind(failure)}）\n`,
        )
        resolve(notFound ? 127 : 126)
        return
      }
      // 正常退出也先等输出写完、再去掉信号的处理：这期间收到的信号同样等写完再结束，
      // 否则 Node 还在往外写的时候被信号结束，排着队的输出就丢了
      await flushed()
      const ending = signal ?? late
      stopListening()
      resolve(ending ? exitBySignal(ending) : (code ?? 1))
    })
  })
}

async function run(argv) {
  let options
  try {
    options = parseRunArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`kioku：${err.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const { refs, variables, purpose, command, args } = options
  let values
  try {
    values = await resolveValues(await loadConfig(process.env), refs, purpose)
  } catch (err) {
    if (!(err instanceof KiokuFailure)) throw err
    process.stderr.write(`kioku：${err.message}\n`)
    return 2
  }
  const withNul = refs.findIndex((_, i) => values[i].includes('\0'))
  if (withNul !== -1) {
    const { identifier, field } = refs[withNul]
    process.stderr.write(`kioku：${identifier}#${field} 的值含有空字符，放不进环境变量\n`)
    return 2
  }
  const env = { ...process.env }
  for (const name of KEY_VARIABLES) delete env[name]
  for (const [name, index] of variables) env[name] = values[index]
  const short = variables.filter(([, index]) => !redactable(values[index])).map(([name]) => name)
  if (short.length > 0) process.stderr.write(`kioku：${short.join('、')} 的值太短，输出里不打码\n`)
  return runCommand(command, args, env, values)
}

// 入口：返回退出码
export async function main(argv) {
  const [sub, ...rest] = argv
  if (sub === '-h' || sub === '--help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (sub === 'run') return run(rest)
  process.stderr.write(sub === undefined ? USAGE : `kioku：不认识的子命令 ${sub}\n\n${USAGE}`)
  return 2
}
