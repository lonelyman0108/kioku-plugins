// 钩子与 kioku 命令共用的访问密钥检查与报错。报错只给插件自己写的文字或错误类别：
// fetch 的报错会带上整个 Authorization 请求头，响应解析失败的文字会带上响应的开头

import { shownUrl } from './text.mjs'

// 访问密钥只能是可见的 ASCII 字符：别的字符放不进请求头，fetch 报错时会把整个请求头写进错误文字
const KEY = /^[\x21-\x7e]+$/
// 错误码（ECONNREFUSED、UND_ERR_SOCKET 这类）与错误类名（TypeError 这类）的样子
const CODE = /^[A-Z][A-Z0-9_]*$/
const NAME = /^[A-Z][A-Za-z]*$/

// 文字由插件自己写、不含值和访问密钥的失败，可以原样打印
export class KiokuFailure extends Error {}

// 访问密钥的格式不对时返回原因，否则为 null
export function keyFormatError(key) {
  return KEY.test(key) ? null : '访问密钥的格式不对：只能是可见的 ASCII 字符，不能有空白'
}

// 错误的类别：只取 code 或 name，不取文字
export function errorKind(err) {
  if (typeof err?.code === 'string' && CODE.test(err.code)) return err.code
  if (typeof err?.name === 'string' && NAME.test(err.name)) return err.name
  return '未知错误'
}

// fetch 失败的原因：超时，或者连不上（附 cause 的错误码）
export function fetchFailure(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `连接 Kioku 超时（${timeoutMs / 1000} 秒）`
  }
  const code = err?.cause?.code
  return typeof code === 'string' && CODE.test(code)
    ? `无法连接 Kioku（${code}）`
    : '无法连接 Kioku'
}

// 收到跳转（3xx）时的报错：说明要把地址改成跳转之后的地址。请求都不跟着跳转走，访问密钥只发给配置的地址；
// 跳转目标只给协议与主机，路径与查询参数里可能带着令牌；跳到同一个主机、或者没给目标时不举例
export function redirectError(status, location, url) {
  let origin
  try {
    const target = new URL(location ?? '', `${url}/`)
    const web = target.protocol === 'https:' || target.protocol === 'http:'
    if (web && target.origin !== new URL(url).origin) origin = target.origin
  } catch {
    // 跳转目标解析不了时不举例
  }
  return `Kioku 返回了跳转（${status}），把地址改成跳转之后的地址${origin ? `（例如 ${origin}）` : ''}`
}

export function isRedirect(status) {
  return status >= 300 && status < 400
}

// 要打印的失败原因：插件自己写的原样给出，别的只给类别
export function failureText(err) {
  return err instanceof KiokuFailure ? err.message : errorKind(err)
}

// 服务端在响应体里给的错误码（与服务端 contracts 的常量一致）：
// legacy_key 是升级前签发的访问密钥（401），legacy_database 是库还没从旧结构迁移过来（503）
export const LEGACY_KEY_CODE = 'legacy_key'
export const LEGACY_DATABASE_CODE = 'legacy_database'

export const INVALID_KEY_TEXT = '访问密钥无效或已吊销'
export const LEGACY_KEY_TEXT =
  '访问密钥是升级前签发的，已失效：运行 npx @kioku-memory/cli migrate 重新接入'

// 服务端明说访问密钥不能用（401）：和连不上、响应不对分开。legacy 为真时是升级前签发的访问密钥
export class KeyRejected extends KiokuFailure {
  constructor(legacy = false) {
    super(legacy ? LEGACY_KEY_TEXT : INVALID_KEY_TEXT)
    this.legacy = legacy
  }
}

// 服务端已升级、库还是旧结构，等管理员在管理界面迁移
export class LegacyDatabase extends KiokuFailure {}

// 响应体里的错误码；没有、或者不像错误码时为 null（服务端写的文字不原样拿来用）
export function errorCodeOf(data) {
  const code = data?.code
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null
}

// 管理界面升级页的地址只给协议、主机与路径：写在地址里的账号密码不打印
export function legacyDatabaseText(url) {
  let base = ''
  try {
    base = shownUrl(url)
  } catch {
    // 地址解析不了时不举例
  }
  const where = base ? `打开 ${base}/legacy-upgrade` : '打开管理界面的升级页'
  return `服务端已升级、尚未迁移旧数据：${where} 按引导迁移，完成后运行 kioku migrate 重新接入`
}

// 401 与带 legacy_database 的 503 的统一解读：返回要抛的失败，别的状态返回 null
export function rejectionOf(status, data, url) {
  if (status === 401) return new KeyRejected(errorCodeOf(data) === LEGACY_KEY_CODE)
  if (status === 503 && errorCodeOf(data) === LEGACY_DATABASE_CODE) {
    return new LegacyDatabase(legacyDatabaseText(url))
  }
  return null
}

// 响应文字按 JSON 读，读不懂时为 null
export function jsonOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
