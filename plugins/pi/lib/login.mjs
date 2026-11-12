// kioku login：浏览器授权。命令行向 Kioku 申请，显示一个确认码；用户在管理界面的确认页输入它、
// 选好空间与权限后确认，命令行取走访问密钥，交给这个平台的 kioku setup 写下。
// 访问密钥不显示、不写进输出；确认码不放进打开的地址里，要用户照着终端输入：别人发来的链接带不了它。
// 服务端的回答不全信：确认页的路径只收一种写法，时限与间隔收在一个范围里

import { spawn } from 'node:child_process'
import { hostname } from 'node:os'

import { configure, orphanHint } from './connect.mjs'
import { fetchFailure, isRedirect, KiokuFailure, redirectError } from './http.mjs'
import { platformNames, PLATFORMS } from './platforms.mjs'
import { resolveServerUrl } from './target.mjs'
import { plain } from './text.mjs'
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
// 连着这么多次没得到回答（连不上、服务端 5xx）才放弃：等确认的这几分钟里抖一下不算失败
const MAX_FAILURES = 5
// 确认页的路径只收这种写法：接在服务地址后面打开，不带查询参数与别的符号
const VERIFICATION_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/
// 服务端给的时限与间隔收在这个范围里（秒）：给得再离谱也不会一直等、不会忙等
const MAX_EXPIRES = 1800
const MIN_INTERVAL = 1
const MAX_INTERVAL = 60

// 地址返回了跳转：配置的问题，重试没有用
class Redirected extends KiokuFailure {}

// 取走访问密钥这一步之后出的问题：访问密钥可能已经签发、却没有落到这台机器上
const ORPHAN_HINT =
  '如果确认页上已经点了确认，可能已经签发了一个没被取走的访问密钥：到管理界面的应用页吊销它，再重新运行'

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
    throw new Redirected(redirectError(res.status, res.headers.get('location'), url))
  }
  return { status: res.status, data }
}

// 服务端给的秒数收进范围；不是有限的正数时用默认值
function seconds(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  return Math.min(max, Math.max(min, number))
}

// 服务端不认一次申请几个平台的写法：退回逐个平台申请
export class LegacyServer extends KiokuFailure {}

// 旧的服务端只认单个平台的写法，收到 platforms 时按校验失败回 400，第一条问题是缺 runtimeFamily
// （「runtimeFamily：…」）。别的 400 是申请本身有问题，照原样报
function legacyRejection(data) {
  return typeof data?.error === 'string' && /^runtimeFamily[：:]/.test(data.error)
}

// 一次申请最多几个平台，与服务端的上限一致
export const MAX_PLATFORMS = 8

// 申请：返回设备码、确认码、确认页的地址与时限。body 是单平台的 { runtimeFamily, clientName }，
// 或几个平台的 { platforms: [{ runtimeFamily }], clientName }
export async function requestGrant(url, body) {
  const { clientName, ...rest } = body
  const { status, data } = await post(url, '/v1/device/authorize', {
    ...rest,
    ...(clientName ? { clientName } : {}),
  })
  if (status === 400 && Array.isArray(body.platforms) && legacyRejection(data)) {
    throw new LegacyServer('服务端版本较旧，需要逐个确认')
  }
  if (status === 400) {
    const reason = typeof data?.error === 'string' ? plain(data.error) : ''
    throw new KiokuFailure(`Kioku 拒绝了这次申请${reason ? `：${reason}` : ''}`)
  }
  if (status === 404) {
    throw new KiokuFailure(
      '这个 Kioku 还不支持浏览器授权：升级服务端，或者用 kioku setup 手动填访问密钥',
    )
  }
  if (status === 429) throw new KiokuFailure('待确认的申请太多，稍后再试')
  if (status !== 201) throw new KiokuFailure(`Kioku 返回 HTTP ${status}`)
  if (
    typeof data?.deviceCode !== 'string' ||
    !data.deviceCode ||
    typeof data.userCode !== 'string' ||
    typeof data.verificationPath !== 'string' ||
    !VERIFICATION_PATH.test(data.verificationPath)
  ) {
    throw new KiokuFailure('Kioku 的响应格式不对')
  }
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUrl: `${url}${data.verificationPath}`,
    expiresIn: seconds(data.expiresIn, 600, 1, MAX_EXPIRES),
    interval: seconds(data.interval, 3, MIN_INTERVAL, MAX_INTERVAL),
  }
}

// 等确认：按服务端给的间隔轮询，确认了返回服务端的整个回答；被拒绝、过期时抛 KiokuFailure。
// sleep 与 now 可以换掉，给用例用；now 要是只往前走的钟，系统时间被改不影响什么时候停
async function waitForApproval(
  url,
  grant,
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => performance.now(),
  } = {},
) {
  const deadline = now() + grant.expiresIn * 1000
  let interval = grant.interval * 1000
  let failures = 0
  // 有过没得到回答的轮询：那一次服务端可能已经把访问密钥签出来了
  let missed = false
  while (now() < deadline) {
    await sleep(interval)
    let answer
    try {
      answer = await post(url, '/v1/device/token', { deviceCode: grant.deviceCode })
    } catch (err) {
      if (err instanceof Redirected) throw err
      missed = true
      if (++failures >= MAX_FAILURES) throw new KiokuFailure(`${err.message}。${ORPHAN_HINT}`)
      continue
    }
    const { status, data } = answer
    // 服务端嫌太勤：隔久一点
    if (status === 429) {
      interval = Math.min(interval + 1000, MAX_INTERVAL * 1000)
      continue
    }
    // 服务端一时出错（重启、网关）和连不上一样，过会儿再问
    if (status >= 500) {
      missed = true
      if (++failures >= MAX_FAILURES) {
        throw new KiokuFailure(`Kioku 返回 HTTP ${status}。${ORPHAN_HINT}`)
      }
      continue
    }
    if (status !== 200) throw new KiokuFailure(`Kioku 返回 HTTP ${status}`)
    failures = 0
    if (data?.status === 'pending') continue
    if (data?.status === 'denied') {
      throw new KiokuFailure('申请被拒绝了，或者确认之后确认人的权限变了：没有签发访问密钥')
    }
    if (data?.status === 'approved') return data
    if (data?.status === 'expired') break
    throw new KiokuFailure('Kioku 的响应格式不对')
  }
  throw new KiokuFailure(
    missed
      ? `申请已经不在了，没有取到访问密钥。${ORPHAN_HINT}`
      : '申请过期了，没有等到确认：重新运行 kioku login',
  )
}

// 等一个平台的申请被确认，返回访问密钥与应用
export async function waitForKey(url, grant, options) {
  const data = await waitForApproval(url, grant, options)
  if (typeof data.key !== 'string' || !data.key) throw new KiokuFailure('Kioku 的响应格式不对')
  return { key: data.key, app: data.app ?? {} }
}

// 几个平台一起的申请被确认之后，每个平台的结果：按申请的顺序，
// { runtimeFamily, status: 'issued', key, app } | { runtimeFamily, status: 'skipped' } | { runtimeFamily, status: 'denied', reason }。
// 服务端没提到的平台算跳过，不认识的平台、重复的项不收；签发了却不像访问密钥的算响应不对
export async function waitForKeys(url, grant, families, options) {
  const data = await waitForApproval(url, grant, options)
  // 已经确认了：响应读不懂时，服务端可能已经签发了几个没人拿着的访问密钥
  const malformed = () => new KiokuFailure(`Kioku 的响应格式不对。${ORPHAN_HINT}`)
  if (!Array.isArray(data.keys)) throw malformed()
  const byFamily = new Map()
  for (const item of data.keys) {
    const family = item?.runtimeFamily
    if (!families.includes(family) || byFamily.has(family)) continue
    if (item.status === 'issued') {
      if (typeof item.key !== 'string' || !item.key) throw malformed()
      byFamily.set(family, {
        runtimeFamily: family,
        status: 'issued',
        key: item.key,
        app: item.app ?? {},
      })
    } else if (item.status === 'denied') {
      const reason = typeof item.reason === 'string' ? plain(item.reason) : ''
      byFamily.set(family, { runtimeFamily: family, status: 'denied', reason })
    } else byFamily.set(family, { runtimeFamily: family, status: 'skipped' })
  }
  return families.map(
    (family) => byFamily.get(family) ?? { runtimeFamily: family, status: 'skipped' },
  )
}

// 用系统默认的浏览器打开地址；打不开就算了，地址已经显示在终端里。都不经过 shell：
// Windows 上用 rundll32，不用 cmd 的 start（它会把地址里的 & 这类符号当成命令）
export function openBrowser(address) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [address]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', address]]
        : ['xdg-open', [address]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 没有图形界面
  }
}

// 本地网络给主机名加的后缀，不算机器的名字
const HOST_SUFFIX = /\.(?:local|localdomain|lan|home|internal)$/i

// 机器名是自报的：去掉控制字符与 .local 这类后缀，太长就截断；什么都不剩时用 kioku-cli。
// 服务端把它显示在确认页上，新建的应用默认叫「平台名 · 机器名」
export function machineName(clientName) {
  const name = Array.from(plain(clientName).replace(HOST_SUFFIX, '').trim())
    .slice(0, 64)
    .join('')
    .trim()
  return name || 'kioku-cli'
}

// 显示确认码与确认页，打开浏览器
function showGrant(grant, { out, open, browser }) {
  out.write(`确认码：${plain(grant.userCode)}\n`)
  // 显示的和打开的是同一个地址
  out.write(`在浏览器里打开 ${plain(grant.verificationUrl)}，登录后输入这个确认码\n`)
  out.write(`等待确认（${Math.ceil(grant.expiresIn / 60)} 分钟内有效）…\n`)
  if (browser) open(grant.verificationUrl)
}

// 走一遍浏览器授权，返回访问密钥。提示写到 out，访问密钥不写
export async function deviceLogin(
  { url, runtimeFamily },
  { out, open = openBrowser, browser = true, clientName = hostname(), sleep, now } = {},
) {
  const grant = await requestGrant(url, { runtimeFamily, clientName: machineName(clientName) })
  showGrant(grant, { out, open, browser })
  const { key, app } = await waitForKey(url, grant, { sleep, now })
  out.write(`✓ 已确认：应用 ${plain(app.name ?? '')}（${plain(app.slug ?? '')}）\n`)
  return key
}

// 几个平台一起申请，只确认一次。返回 waitForKeys 的结果（按去重后的顺序）；服务端不认这种写法时抛 LegacyServer。
// 一次最多 MAX_PLATFORMS 个，多了由调用方分批（connect.mjs），这里不发超出上限的申请
export async function deviceLoginMany(
  { url, runtimeFamilies },
  { out, open = openBrowser, browser = true, clientName = hostname(), sleep, now } = {},
) {
  const families = [...new Set(runtimeFamilies)]
  if (!families.length || families.length > MAX_PLATFORMS) {
    throw new KiokuFailure(`一次申请 1 到 ${MAX_PLATFORMS} 个平台`)
  }
  const grant = await requestGrant(url, {
    platforms: families.map((runtimeFamily) => ({ runtimeFamily })),
    clientName: machineName(clientName),
  })
  showGrant(grant, { out, open, browser })
  const results = await waitForKeys(url, grant, families, { sleep, now })
  // 确认了也可能一个都没签发：取走时照签发规则再核对，全都没过（例如确认人已停用）
  const issued = results.filter((item) => item.status === 'issued').length
  out.write(issued ? `✓ 已确认，签发了 ${issued} 个访问密钥\n` : '✗ 已确认，但没有签发访问密钥\n')
  return results
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
  const saved = await Promise.resolve(platform.readConfig?.(env)).catch(() => null)
  const url = resolveServerUrl(options, env, saved)
  // 申请之前先看这个平台的配置写不写得进去：访问密钥只在签发时给一次
  await platform.preflight?.({ env, cwd })
  const key = await deviceLogin(
    { url, runtimeFamily: platform.runtimeFamily },
    { out, open, browser: options.browser, sleep, now, ...(clientName ? { clientName } : {}) },
  )
  // 拿到的访问密钥交给这个平台的 setup：核对、写文件都照它的规矩
  try {
    return await configure(options.platform, { url, key }, { env, out, cwd }, { hints: true })
  } catch (err) {
    if (!(err instanceof KiokuFailure)) throw err
    // 访问密钥已经签发、却没有写下来：说清楚，别让它悄悄留着
    throw new KiokuFailure(`${err.message}。${orphanHint()}`)
  }
}
