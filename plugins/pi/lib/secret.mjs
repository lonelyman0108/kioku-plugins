// 读访问密钥，不经过命令行参数（会进 shell 的历史与进程列表）：先看 KIOKU_API_KEY，
// 标准输入不是终端时读它的全部内容，是终端时提示输入、不回显

import { StringDecoder } from 'node:string_decoder'

import { KiokuFailure } from './http.mjs'

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// 终端发来的转义序列（方向键、粘贴的起止标记这类）：不是输入的内容
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g

// 把终端发来的一段字符并进已经输入的内容，返回 { value, done }：done 为 'enter' 是输完了，'cancel' 是取消。
// 回车结束，Ctrl-C、Ctrl-D 取消，退格删掉一个字，Ctrl-U 清空；别的控制字符与转义序列不算输入
export function applyKeys(value, text) {
  let chars = Array.from(value)
  for (const char of text.replace(ESCAPES, '')) {
    if (char === '\r' || char === '\n') return { value: chars.join(''), done: 'enter' }
    if (char === '\u0003' || char === '\u0004') return { value: '', done: 'cancel' }
    if (char === '\u007f' || char === '\b') chars.pop()
    else if (char === '\u0015') chars = []
    else if (!/\p{Cc}/u.test(char)) chars.push(char)
  }
  return { value: chars.join(''), done: null }
}

// 在终端里读一行，不回显。不管怎么结束都把终端改回原来的模式
function readHidden(stdin, out, label) {
  return new Promise((resolve, reject) => {
    let value = ''
    // 一个字可能被切在两块里：按 UTF-8 接着解码
    const decoder = new StringDecoder('utf8')
    const finish = (fn, arg) => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      try {
        stdin.setRawMode(false)
      } catch {
        // 终端已经没了
      }
      stdin.pause()
      out.write('\n')
      fn(arg)
    }
    const onData = (chunk) => {
      const result = applyKeys(value, decoder.write(chunk))
      value = result.value
      if (result.done === 'enter') finish(resolve, value)
      else if (result.done === 'cancel') finish(reject, new KiokuFailure('已取消'))
    }
    // 终端挂断：按取消算，不拿半截的输入当访问密钥
    const onEnd = () => finish(reject, new KiokuFailure('输入中断了，没有读到访问密钥'))
    const onError = () => finish(reject, new KiokuFailure('无法从终端读取访问密钥'))
    out.write(label)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.on('error', onError)
  })
}

// 没有给访问密钥时返回空字符串
export async function readSecret({
  env = process.env,
  stdin = process.stdin,
  out = process.stderr,
} = {}) {
  const fromEnv = (env.KIOKU_API_KEY ?? '').trim()
  if (fromEnv) return fromEnv
  if (!stdin.isTTY) return (await readAll(stdin)).trim()
  return (await readHidden(stdin, out, '访问密钥（不回显）：')).trim()
}
