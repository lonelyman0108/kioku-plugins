// 各平台的钩子共用的生命周期转发：把 session.start、prompt.submit、turn.end 交给 Kioku 的生命周期端点。
// 这里不放提示词和格式逻辑，都由服务端决定；怎么从平台取输入、怎么把结果交还平台，由各插件自己写。
// 报错和 kioku 命令一样不带访问密钥：格式不对的访问密钥不发出去，fetch 的报错只取类别，
// 也不跟着跳转走，访问密钥只发给配置的地址

import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

import { fetchFailure, isRedirect, keyFormatError, KiokuFailure, redirectError } from './http.mjs'

// 各事件等待服务端的上限（毫秒），要比平台给钩子的时限短
export const TIMEOUTS = { 'session.start': 8000, 'prompt.submit': 5000, 'turn.end': 5000 }
// 与服务端 contracts 的上限一致
export const MAX_PROMPT = 20_000
export const MAX_REPLY = 20_000
export const MAX_SESSION_ID = 200
const MAX_NAME = 128

// 配置写错了：访问密钥格式不对（kind 为 key），或者服务地址返回跳转（kind 为 url）。
// 和没有配置一样，平台可以在会话开始时提示一次；文字不带访问密钥
export class Misconfigured extends KiokuFailure {
  constructor(message, kind) {
    super(message)
    this.kind = kind
  }
}

// 服务地址去掉首尾空白与结尾的斜杠
export function normalizeBase(url) {
  return (url ?? '').trim().replace(/\/+$/, '')
}

// 访问密钥的格式不对时抛 Misconfigured
export function assertKeyFormat(key) {
  const problem = keyFormatError(key)
  if (problem) throw new Misconfigured(problem, 'key')
}

// 按长度截断时不切开代理对（表情这类字符）：落单的半个到了服务端会变成替换字符
export function clip(text, max) {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

// 当前项目的目录名与 git 仓库名，服务端用它们召回与项目相关的记忆；取不到的就不带
export function projectOf(cwd) {
  const project = {}
  const dirName = basename(cwd)
  if (dirName) project.dirName = dirName.slice(0, MAX_NAME)
  try {
    const remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const repoName = /([^/:]+?)(?:\.git)?$/.exec(remote)?.[1]
    if (repoName) project.repoName = repoName.slice(0, MAX_NAME)
  } catch {
    // 不是 git 仓库或没有 origin
  }
  return project
}

// 服务端要注入的上下文文本；没有时为 undefined。只取文本，输出里的其他字段一律不用：
// 记忆服务能决定注入什么内容，但不能挡住用户的输入或改变会话
export function contextOf(hostOutput) {
  if (hostOutput?.mode === 'stdout_json')
    return hostOutput.value?.hookSpecificOutput?.additionalContext
  if (hostOutput?.mode === 'stdout_text') return hostOutput.value
  // 没有专门输出格式的运行时：服务端直接给文本
  if (hostOutput?.mode === 'return_value') return hostOutput.value?.context
  return undefined
}

// 把一个生命周期事件交给服务端；连不上、超时、跳转与非 2xx 都以 KiokuFailure 抛出
export async function postEvent(base, key, body, timeout) {
  let res
  try {
    res = await fetch(`${base}/v1/lifecycle/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, timeout))
  }
  if (isRedirect(res.status)) {
    throw new Misconfigured(redirectError(res.status, res.headers.get('location'), base), 'url')
  }
  if (!res.ok) throw new KiokuFailure(`HTTP ${res.status}`)
  return res
}
