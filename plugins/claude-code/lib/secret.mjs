// 读访问密钥，不经过命令行参数（会进 shell 的历史与进程列表）：先看 KIOKU_API_KEY，
// 标准输入不是终端时读它的全部内容，是终端时提示输入、不回显

import { KiokuFailure } from './http.mjs'

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// 在终端里读一行，不回显；Ctrl-C、Ctrl-D 算取消
function readHidden(stdin, out, label) {
  return new Promise((resolve, reject) => {
    let value = ''
    const done = (fn, arg) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      out.write('\n')
      fn(arg)
    }
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return done(resolve, value)
        if (char === '\u0003' || char === '\u0004') return done(reject, new KiokuFailure('已取消'))
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    out.write(label)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
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
