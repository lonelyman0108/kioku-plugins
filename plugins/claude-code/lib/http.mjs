// 钩子与 kioku 命令共用的访问密钥检查与报错。报错只给插件自己写的文字或错误类别：
// fetch 的报错会带上整个 Authorization 请求头，响应解析失败的文字会带上响应的开头

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

// 要打印的失败原因：插件自己写的原样给出，别的只给类别
export function failureText(err) {
  return err instanceof KiokuFailure ? err.message : errorKind(err)
}
