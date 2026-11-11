// kioku login：浏览器授权。命令行向 Kioku 申请，显示一个确认码；用户在管理界面的确认页输入它、
// 选好空间与权限后确认，命令行取走访问密钥，交给这个平台的 kioku setup 写下。
// 访问密钥不显示、不写进输出；确认码不放进打开的地址里，要用户照着终端输入：别人发来的链接带不了它

import { spawn } from 'node:child_process'
import { hostname } from 'node:os'

import { fetchFailure, isRedirect, KiokuFailure, redirectError } from './http.mjs'
import { platformNames, PLATFORMS } from './platforms.mjs'
import { readProfile, serverUrlProblem } from './profile.mjs'
import { plain, shownUrl } from './text.mjs'
import { UsageError } from './usage.mjs'

export const LOGIN_USAGE = `用法：kioku login <平台> [--server-url <地址>] [--no-browser]

用浏览器授权给这个平台签发一个访问密钥并配好，不用手动复制：终端显示一个确认码，
在 Kioku 管理界面的确认页输入它，选好空间与权限后确认。

  <平台>               ${platformNames()}（Claude Code 的访问密钥在它的 /plugin 里填，不走这里）
  --server-url <地址>  Kioku 的服务地址，例如 https://kioku.example.com（也可以用 KIOKU_SERVER_URL；配过的沿用上次的）
  --no-browser         不自动打开浏览器，只显示地址

只在自己刚运行了这条命令时确认：确认之后，这台机器会拿到一个能按所选权限读写记忆的访问密钥。
`

const TIMEOUT = 8000
// 连着这么多次连不上才放弃：等确认的这几分钟里网络抖一下不算失败
const MAX_NETWORK_FAILURES = 5

async function post(url, path, body) {
  let res
  let data
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // 不跟着跳转走：设备码只发给配置的地址
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    data = await res.json().catch(() => null)
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  return { status: res.status, data }
}

// 申请：返回设备码、确认码、确认页的地址与时限
export async function requestGrant(url, { runtimeFamily, clientName }) {
  const { status, data } = await post(url, '/v1/device/authorize', {
    runtimeFamily,
    ...(clientName ? { clientName } : {}),
  })
  if (status === 404) {
    throw new KiokuFailure(
      '这个 Kioku 还不支持浏览器授权：升级服务端，或者用 kioku setup 手动填访问密钥',
    )
  }
  if (status === 429) throw new KiokuFailure('待确认的申请太多，稍后再试')
  if (
    status !== 201 ||
    typeof data?.deviceCode !== 'string' ||
    typeof data.userCode !== 'string' ||
    typeof data.verificationPath !== 'string' ||
    !data.verificationPath.startsWith('/')
  ) {
    throw new KiokuFailure(status === 201 ? 'Kioku 的响应格式不对' : `Kioku 返回 HTTP ${status}`)
  }
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUrl: `${url}${data.verificationPath}`,
    expiresIn: Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 600,
    interval: Number(data.interval) > 0 ? Number(data.interval) : 3,
  }
}

// 等确认：按服务端给的间隔轮询，返回访问密钥与应用；被拒绝、过期时抛 KiokuFailure。
// sleep 与 now 可以换掉，给用例用
export async function waitForKey(
  url,
  grant,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {},
) {
  const deadline = now() + grant.expiresIn * 1000
  let interval = grant.interval * 1000
  let failures = 0
  while (now() < deadline) {
    await sleep(interval)
    let answer
    try {
      answer = await post(url, '/v1/device/token', { deviceCode: grant.deviceCode })
      failures = 0
    } catch (err) {
      if (++failures >= MAX_NETWORK_FAILURES) throw err
      continue
    }
    const { status, data } = answer
    // 服务端嫌太勤：隔久一点
    if (status === 429) {
      interval += 1000
      continue
    }
    if (status !== 200) throw new KiokuFailure(`Kioku 返回 HTTP ${status}`)
    if (data?.status === 'pending') continue
    if (data?.status === 'denied') {
      throw new KiokuFailure('申请被拒绝了，或者确认之后确认人的权限变了：没有签发访问密钥')
    }
    if (data?.status === 'approved' && typeof data.key === 'string' && data.key) {
      return { key: data.key, app: data.app ?? {} }
    }
    if (data?.status === 'expired') break
    throw new KiokuFailure('Kioku 的响应格式不对')
  }
  throw new KiokuFailure('申请过期了，没有等到确认：重新运行 kioku login')
}

// 用系统默认的浏览器打开地址；打不开就算了，地址已经显示在终端里
function openBrowser(address) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [address]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', address]]
        : ['xdg-open', [address]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 没有图形界面
  }
}

// 走一遍浏览器授权，返回访问密钥。提示写到 out，访问密钥不写
export async function deviceLogin(
  { url, runtimeFamily },
  { out, open = openBrowser, browser = true, clientName = hostname(), sleep, now } = {},
) {
  // 机器名是自报的：去掉控制字符，太长就截断，服务端只把它显示在确认页上
  const name = Array.from(plain(clientName)).slice(0, 64).join('')
  const grant = await requestGrant(url, { runtimeFamily, clientName: name })
  out.write(`确认码：${plain(grant.userCode)}\n`)
  out.write(`在浏览器里打开 ${shownUrl(grant.verificationUrl)}，登录后输入这个确认码\n`)
  out.write(`等待确认（${Math.round(grant.expiresIn / 60)} 分钟内有效）…\n`)
  if (browser) open(grant.verificationUrl)
  const { key, app } = await waitForKey(url, grant, { sleep, now })
  out.write(`✓ 已确认：应用 ${plain(app.name ?? '')}（${plain(app.slug ?? '')}）\n`)
  return key
}

export function parseLoginArgs(argv) {
  const options = { serverUrl: undefined, browser: true }
  const names = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-browser') options.browser = false
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
  if (!PLATFORMS[names[0]].setup) {
    throw new UsageError(
      `${PLATFORMS[names[0]].name} 的访问密钥在它自己的插件配置里填，不走 kioku login`,
    )
  }
  return { ...options, platform: names[0] }
}

export async function login(
  argv,
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    open,
    sleep,
    now,
    clientName,
  } = {},
) {
  const options = parseLoginArgs(argv)
  const platform = PLATFORMS[options.platform]
  const saved = await readProfile(options.platform, env).catch(() => null)
  const url = (options.serverUrl ?? env.KIOKU_SERVER_URL ?? saved?.url ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) throw new UsageError('要给服务地址：--server-url https://kioku.example.com')
  const problem = serverUrlProblem(url)
  if (problem) throw new KiokuFailure(problem)
  const key = await deviceLogin(
    { url, runtimeFamily: platform.runtimeFamily },
    { out, open, browser: options.browser, sleep, now, ...(clientName ? { clientName } : {}) },
  )
  // 拿到的访问密钥交给这个平台的 setup：核对、写文件都照它的规矩
  return platform.setup(
    { serverUrl: url, dryRun: false, undo: false, check: true },
    { env, out, cwd, readKey: async () => key, plain },
  )
}
