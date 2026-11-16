// 向导里的「本机起一个 Kioku」：在一个目录里放好 compose.yaml 与 .env，用 Docker 起服务，等它就绪，
// 再等用户在管理界面建好第一个管理员。已有的文件不覆盖；端口被占时只说明，不动别的进程

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { capture } from './command.mjs'
import { errorKind, KiokuFailure } from './http.mjs'

const REPO = 'lonelyman0108/kioku'
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`

// 仓库里某个版本（tag 或分支）的文件
export function rawUrl(ref, file) {
  return `https://raw.githubusercontent.com/${REPO}/${ref}/${file}`
}

// 用哪个版本：最新的正式版，compose.yaml、.env.example 从它的 tag 取，镜像固定在这个版本号；
// 取不到时退回 main 上的文件与 edge 镜像（main 上最新的提交），problem 写明原因。
// 返回 { ref, imageTag, release, problem? }
export async function latestRelease({ fetchImpl = fetch } = {}) {
  let problem
  try {
    const res = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'kioku-cli' },
      signal: AbortSignal.timeout(10_000),
    })
    const data = res.ok ? await res.json().catch(() => null) : null
    const tag = typeof data?.tag_name === 'string' ? data.tag_name : ''
    const match = /^v?(\d+\.\d+\.\d+)$/.exec(tag)
    if (match) return { ref: tag, imageTag: match[1], release: true }
    problem = res.ok ? '版本号认不出' : `HTTP ${res.status}`
  } catch (err) {
    problem = networkReason(err)
  }
  return { ref: 'main', imageTag: 'edge', release: false, problem }
}

// fetch 失败的原因：超时、错误码，或者笼统的网络错误
function networkReason(err) {
  const code = err?.cause?.code
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return '超时'
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : '网络错误'
}
export const LOCAL_PORT = 18920
export const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}`

export function defaultLocalDir(env) {
  return join(env.HOME || homedir(), 'kioku')
}

// 目录：~ 开头的换成主目录
export function expandDir(dir, env) {
  const home = env.HOME || homedir()
  return resolve(dir === '~' ? home : dir.replace(/^~(?=[/\\])/, home))
}

// .env 里要生成的几项：两个数据库密码是 24 字节的十六进制（openssl rand -hex 24，只用十六进制字符，
// 拼进连接串不出问题），主密钥是 32 字节的 base64，初始化码是 16 字节的十六进制
export function generateSecrets(random = randomBytes) {
  return {
    POSTGRES_PASSWORD: random(24).toString('hex'),
    KIOKU_DB_PASSWORD: random(24).toString('hex'),
    KIOKU_MASTER_KEY: random(32).toString('base64'),
    KIOKU_SETUP_CODE: random(16).toString('hex'),
  }
}

// 只在本机用的设置：管理界面走 http://127.0.0.1，登录 Cookie 不能要求 HTTPS；端口只发布在本机
export const LOCAL_SETTINGS = { KIOKU_COOKIE_SECURE: 'false', KIOKU_BIND: '127.0.0.1' }

// 照着 .env.example 填：示例里有这一项就在原处填上；只有注释掉的（「# 名字=」）才填在注释那一行，
// 免得说明里举的例子被填上、真正的那一行还空着（后出现的那行生效）。示例里没有的加在最后
export function fillEnv(template, values) {
  const lines = template.split(/\r?\n/)
  const nameOf = (line, commented) =>
    (commented ? /^\s*#\s*([A-Z][A-Z0-9_]*)=/ : /^\s*([A-Z][A-Z0-9_]*)=/).exec(line)?.[1]
  const done = new Set()
  const next = [...lines]
  for (const commented of [false, true]) {
    next.forEach((line, index) => {
      const name = nameOf(line, commented)
      if (!name || !Object.hasOwn(values, name) || done.has(name)) return
      done.add(name)
      next[index] = `${name}=${values[name]}`
    })
  }
  while (next.length && next.at(-1) === '') next.pop()
  for (const [name, value] of Object.entries(values)) {
    if (!done.has(name)) next.push(`${name}=${value}`)
  }
  return `${next.join('\n')}\n`
}

// .env 里写的一项的值；没有为 null
export function envValue(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (match?.[1] === name) return match[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return null
}

// .env 里 KIOKU_TAG 上面的说明
function tagNote(imageTag) {
  return imageTag === 'edge'
    ? '# 没取到最新的正式版，用的是 main 上最新的提交（edge），不保证稳定；改成版本号（如 0.1.0）固定下来'
    : `# 固定在 ${imageTag}（生成时的最新正式版）。升级时改这里，再 docker compose pull && docker compose up -d`
}

// 写 .env：只给本人读写，已有的不覆盖。imageTag 给了时 KIOKU_TAG 写成它，上面加一行说明。
// 返回 { written, file, setupCode }：已有的文件不动，初始化码取它里面写的（没写为 null，要看日志）
export async function writeEnvFile(dir, template, { random, imageTag } = {}) {
  const file = join(dir, '.env')
  const existing = await readFile(file, 'utf8').catch((err) => {
    if (err?.code === 'ENOENT') return null
    throw new KiokuFailure(`无法读取 ${file}（${errorKind(err)}）`)
  })
  if (existing !== null) {
    return { written: false, file, setupCode: envValue(existing, 'KIOKU_SETUP_CODE') || null }
  }
  const secrets = generateSecrets(random)
  let body = fillEnv(template, {
    ...secrets,
    ...LOCAL_SETTINGS,
    ...(imageTag ? { KIOKU_TAG: imageTag } : {}),
  })
  if (imageTag) body = body.replace(/^KIOKU_TAG=/m, `${tagNote(imageTag)}\nKIOKU_TAG=`)
  try {
    // wx：写的这一刻别人刚建了也不覆盖
    await writeFile(file, body, { mode: 0o600, flag: 'wx' })
    await chmod(file, 0o600)
  } catch (err) {
    if (err?.code === 'EEXIST') return writeEnvFile(dir, template, { random, imageTag })
    await rm(file, { force: true }).catch(() => {})
    throw new KiokuFailure(`无法写入 ${file}（${errorKind(err)}）`)
  }
  return { written: true, file, setupCode: secrets.KIOKU_SETUP_CODE }
}

// 下载一个文件放进目录；已有的不覆盖，返回 'kept'，下载了返回 'downloaded'。失败时抛 KiokuFailure
export async function download(url, file, { fetchImpl = fetch } = {}) {
  if (
    await readFile(file).then(
      () => true,
      () => false,
    )
  )
    return 'kept'
  let text
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new KiokuFailure(`下载 ${url} 失败（HTTP ${res.status}）`)
    text = await res.text()
  } catch (err) {
    if (err instanceof KiokuFailure) throw err
    throw new KiokuFailure(`下载 ${url} 失败（${networkReason(err)}）`)
  }
  try {
    await writeFile(file, text, { flag: 'wx' })
  } catch (err) {
    if (err?.code === 'EEXIST') return 'kept'
    throw new KiokuFailure(`无法写入 ${file}（${errorKind(err)}）`)
  }
  return 'downloaded'
}

// 下载失败时让用户自己运行的命令
export function manualDownload(dir, ref = 'main') {
  return [
    `mkdir -p ${dir} && cd ${dir}`,
    `curl -fsSLO ${rawUrl(ref, 'compose.yaml')}`,
    `curl -fsSL -o .env.example ${rawUrl(ref, '.env.example')}`,
  ].join('\n')
}

// 准备目录：建目录、从 release.ref 下载 compose.yaml 与 .env.example、生成 .env（镜像固定在 release.imageTag）。
// 返回 { files, env }
export async function prepareDir(dir, release, { fetchImpl, random } = {}) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    throw new KiokuFailure(`无法创建目录 ${dir}（${errorKind(err)}）`)
  }
  const fetchFile = (name, file) => download(rawUrl(release.ref, name), file, { fetchImpl })
  const compose = await fetchFile('compose.yaml', join(dir, 'compose.yaml'))
  const example = await fetchFile('.env.example', join(dir, '.env.example'))
  const template = await readFile(join(dir, '.env.example'), 'utf8')
  const env = await writeEnvFile(dir, template, { random, imageTag: release.imageTag })
  return { files: { compose, example }, env }
}

// 这个目录里的 .env 写的初始化码；没有为 null
export async function setupCodeIn(dir) {
  const text = await readFile(join(dir, '.env'), 'utf8').catch(() => null)
  return (text && envValue(text, 'KIOKU_SETUP_CODE')) || null
}

// 这个目录的 compose 项目里有没有 kioku 服务：'none'（没有 compose.yaml，或者没建过容器）、
// 'stopped'（建过、没在运行）、'running'。查不了的按 'none' 算
export async function composeState(dir, env) {
  if (!(await stat(join(dir, 'compose.yaml')).catch(() => null))) return 'none'
  const base = ['compose', '-f', join(dir, 'compose.yaml'), '--project-directory', dir, 'ps']
  const services = async (args) => {
    const result = await capture('docker', [...base, ...args], env, { timeout: 30_000 })
    return result.found && result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()) : []
  }
  if (!(await services(['-a', '--services'])).includes('kioku')) return 'none'
  return (await services(['--services', '--status', 'running'])).includes('kioku')
    ? 'running'
    : 'stopped'
}

// docker compose 能不能用
export async function hasCompose(env) {
  const result = await capture('docker', ['compose', 'version'], env, { timeout: 20_000 })
  return Boolean(result.found && result.ok)
}

// 端口有没有被别的程序占着：连得上，或者绑不上。只试绑 127.0.0.1 不够：别的程序听着 [::] 或 0.0.0.0 时
// 有的系统照样让绑更具体的地址
export async function portBusy(port, host = '127.0.0.1') {
  const answers = await new Promise((done) => {
    const socket = connect({ port, host })
    socket.setTimeout(1000)
    const finish = (value) => {
      socket.destroy()
      done(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
  if (answers) return true
  return new Promise((done) => {
    const server = createServer()
    server.once('error', (err) => done(err?.code === 'EADDRINUSE'))
    server.once('listening', () => server.close(() => done(false)))
    server.listen(port, host)
  })
}

// docker compose up -d：用这个目录的 compose.yaml 与 .env。失败时抛 KiokuFailure，输出只取最后几行
export async function composeUp(dir, env) {
  const result = await capture(
    'docker',
    ['compose', '-f', join(dir, 'compose.yaml'), '--project-directory', dir, 'up', '-d'],
    env,
    { timeout: 30 * 60_000 },
  )
  if (!result.found) throw new KiokuFailure('没有找到 docker 命令')
  if (!result.ok) {
    const tail = result.output.trim().split(/\r?\n/).slice(-5).join('\n')
    throw new KiokuFailure(`docker compose up 没有成功：\n${tail}`)
  }
}

// 轮询直到 check 返回真，或者到时限；返回有没有等到
export async function waitUntil(
  check,
  { timeoutMs, intervalMs = 2000, sleep, now = () => Date.now() },
) {
  const pause = sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (await check().catch(() => false)) return true
    await pause(intervalMs)
  }
  return false
}

// /v1/health 回 200
export async function healthy(url) {
  try {
    const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(3000) })
    return res.status === 200
  } catch {
    return false
  }
}

// 第一个管理员建好了没有（/v1/setup/status 的 needsSetup 变成 false）
export async function setupDone(url) {
  try {
    const res = await fetch(`${url}/v1/setup/status`, { signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    return res.status === 200 && data?.needsSetup === false
  } catch {
    return false
  }
}
