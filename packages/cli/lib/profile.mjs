// 没有自己的密钥存储的平台（Codex、pi 这类），地址与访问密钥放在本机的一个文件里：
// <配置目录>/kioku/<平台>.json，只给本人读写。kioku setup 写它，各平台的钩子与 kioku doctor 读它。
// 一个平台一个文件：每个平台在 Kioku 里是各自的应用，访问密钥不共用

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { errorKind, keyFormatError, KiokuFailure } from './http.mjs'

// 平台名要拼进文件名，只收这些字符
const PLATFORM = /^[a-z][a-z0-9-]{0,31}$/

// 放这些文件的目录：KIOKU_CONFIG_DIR，否则 XDG 的配置目录下的 kioku
export function profileDir(env) {
  if (env.KIOKU_CONFIG_DIR) return env.KIOKU_CONFIG_DIR
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kioku')
}

export function profileFile(platform, env) {
  if (!PLATFORM.test(platform)) throw new KiokuFailure('平台名不对')
  return join(profileDir(env), `${platform}.json`)
}

// 服务地址：去掉首尾空白与结尾的斜杠；不是 http(s) 地址、或者带着账号密码、查询参数时返回原因
export function serverUrlProblem(url) {
  // URL 解析会悄悄去掉中间的换行与制表符：原样写进配置文件的是带着它们的那一份
  if (/[\s\p{Cc}]/u.test(url)) return '服务地址里不能有空白或控制字符'
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return '服务地址不是有效的地址'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '服务地址要以 http:// 或 https:// 开头'
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return '服务地址里不要带账号密码、查询参数'
  }
  return null
}

// 读这个平台的地址与访问密钥。没有这个文件时为 null；文件读不懂、内容不对时抛 KiokuFailure，
// 文字只写文件的位置与问题，不带内容
export async function readProfile(platform, env) {
  const file = profileFile(platform, env)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw new KiokuFailure(`无法读取 ${file}（${errorKind(err)}）`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  const url = typeof data?.serverUrl === 'string' ? data.serverUrl.trim().replace(/\/+$/, '') : ''
  const key = typeof data?.apiKey === 'string' ? data.apiKey.trim() : ''
  if (!url || !key) throw new KiokuFailure(`${file} 里没有服务地址或访问密钥`)
  const problem = serverUrlProblem(url) ?? keyFormatError(key)
  if (problem) throw new KiokuFailure(`${file}：${problem}`)
  return { url, key, file }
}

// 写这个平台的地址与访问密钥：目录与文件都只给本人，先写临时文件再改名
export async function writeProfile(platform, { url, key }, env) {
  const file = profileFile(platform, env)
  const clean = url.trim().replace(/\/+$/, '')
  const problem = serverUrlProblem(clean) ?? keyFormatError(key)
  if (problem) throw new KiokuFailure(problem)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(profileDir(env), { recursive: true, mode: 0o700 })
    const body = `${JSON.stringify({ serverUrl: clean, apiKey: key }, null, 2)}\n`
    await writeFile(temp, body, { mode: 0o600, flag: 'wx' })
    // 已有的文件权限可能更宽，改名之后以新文件的为准；再收一次，不受 umask 影响
    await chmod(temp, 0o600)
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw new KiokuFailure(`无法写入 ${file}（${errorKind(err)}）`)
  }
  return file
}

export async function removeProfile(platform, env) {
  const file = profileFile(platform, env)
  try {
    await rm(file)
    return file
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw new KiokuFailure(`无法删除 ${file}（${errorKind(err)}）`)
  }
}
