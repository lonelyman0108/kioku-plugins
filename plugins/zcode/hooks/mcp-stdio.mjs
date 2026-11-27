// ZCode 的 MCP stdio 桥接：从标准输入按行读取 JSON-RPC 2.0 消息，
// 转发到 Kioku 的 Streamable HTTP 端点（POST /v1/mcp），并将响应单行写回标准输出。
// 地址与访问密钥从 ~/.config/kioku/zcode.json 读取，绝不写入插件清单或命令行参数。
// 所有错误信息与标准错误日志均经过脱敏处理，绝不带出访问密钥。

import { realpathSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

import {
  failureText,
  fetchFailure,
  isRedirect,
  jsonOrNull,
  KeyRejected,
  keyFormatError,
  KiokuFailure,
  redirectError,
  rejectionOf,
} from '../lib/http.mjs'
import { readProfile, serverUrlProblem } from '../lib/profile.mjs'
import { plain } from '../lib/text.mjs'

const DEFAULT_TIMEOUT_MS = 30_000
const LOGIN_HINT = '运行 kioku login zcode（没有 kioku 命令时用 npx @kioku-memory/cli login zcode）'

async function resolveMcpConfig(env) {
  const profile = await readProfile('zcode', env)
  if (!profile) {
    throw new KiokuFailure(`Kioku 尚未配置服务地址和访问密钥：${LOGIN_HINT}`)
  }
  const problem = serverUrlProblem(profile.url) ?? keyFormatError(profile.key)
  if (problem) throw new KiokuFailure(problem)
  return { url: profile.url, key: profile.key }
}

function extractPayloads(text, contentType) {
  if (!text.trim()) return []
  if (!contentType.toLowerCase().includes('text/event-stream')) return [text]
  const events = []
  let current = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') {
      if (current.length) {
        events.push(current.join('\n'))
        current = []
      }
      continue
    }
    if (rawLine.startsWith('data:')) current.push(rawLine.slice(5).trimStart())
  }
  if (current.length) events.push(current.join('\n'))
  return events.filter((chunk) => chunk.trim() && chunk.trim() !== '[DONE]')
}

function redactKey(text, key) {
  const raw = key ? String(text).split(key).join('***') : String(text)
  return plain(raw)
}

function writeJsonRpc(out, payload) {
  out.write(`${JSON.stringify(payload)}\n`)
}

function errorPayload(id, message, key) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: redactKey(message, key) || 'Kioku MCP 请求失败' },
  }
}

async function forwardMessage(msg, { env, fetchImpl, out, errOut, timeoutMs }) {
  const hasId = Boolean(
    msg && typeof msg === 'object' && Object.hasOwn(msg, 'id') && msg.id !== undefined,
  )
  let config
  try {
    config = await resolveMcpConfig(env)
  } catch (err) {
    const reason = failureText(err)
    errOut.write(`Kioku MCP 未生效：${reason}\n`)
    if (hasId) writeJsonRpc(out, errorPayload(msg.id, reason, ''))
    return
  }

  let res
  let text
  try {
    res = await fetchImpl(`${config.url}/v1/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(msg),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await res.text()
  } catch (err) {
    const reason = fetchFailure(err, timeoutMs)
    errOut.write(`Kioku MCP 请求失败：${reason}\n`)
    if (hasId) writeJsonRpc(out, errorPayload(msg.id, reason, config.key))
    return
  }

  if (isRedirect(res.status)) {
    const reason = redirectError(res.status, res.headers.get('location'), config.url)
    errOut.write(`Kioku MCP 请求失败：${reason}\n`)
    if (hasId) writeJsonRpc(out, errorPayload(msg.id, reason, config.key))
    return
  }

  const rejected = res.ok ? null : rejectionOf(res.status, jsonOrNull(text))
  if (rejected) {
    const reason =
      rejected instanceof KeyRejected
        ? `${rejected.message}：${LOGIN_HINT}重新授权`
        : rejected.message
    errOut.write(`Kioku MCP 未生效：${reason}\n`)
    if (hasId) writeJsonRpc(out, errorPayload(msg.id, reason, config.key))
    return
  }

  if (!res.ok) {
    const reason = `Kioku 返回 HTTP ${res.status}`
    errOut.write(`Kioku MCP 请求失败：${reason}\n`)
    if (hasId) writeJsonRpc(out, errorPayload(msg.id, reason, config.key))
    return
  }

  if (!hasId) return

  const payloads = extractPayloads(text, res.headers.get('content-type') ?? '')
  let wrote = false
  for (const chunk of payloads) {
    let parsed
    try {
      parsed = JSON.parse(chunk)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object') {
      writeJsonRpc(out, parsed)
      wrote = true
    }
  }
  if (!wrote) {
    const reason = 'Kioku 返回的 MCP 响应格式不对'
    errOut.write(`Kioku MCP 请求失败：${reason}\n`)
    writeJsonRpc(out, errorPayload(msg.id, reason, config.key))
  }
}

export async function runBridge({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let queue = Promise.resolve()

  const handleLine = (rawLine) => {
    const line = rawLine.trim()
    if (!line) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      queue = queue.then(() =>
        writeJsonRpc(stdout, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      )
      return
    }
    if (Array.isArray(msg) && msg.length === 0) {
      queue = queue.then(() =>
        writeJsonRpc(stdout, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        }),
      )
      return
    }
    const items = Array.isArray(msg) ? msg : [msg]
    queue = queue.then(async () => {
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          writeJsonRpc(stdout, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid Request' },
          })
          continue
        }
        try {
          await forwardMessage(item, { env, fetchImpl, out: stdout, errOut: stderr, timeoutMs })
        } catch (err) {
          const reason = failureText(err)
          stderr.write(`Kioku MCP 请求失败：${reason}\n`)
          if (Object.hasOwn(item, 'id') && item.id !== undefined) {
            writeJsonRpc(stdout, errorPayload(item.id, reason, ''))
          }
        }
      }
    })
  }

  await new Promise((resolve) => {
    stdin.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        handleLine(line)
      }
    })
    stdin.once('end', () => {
      buffer += decoder.end()
      if (buffer.trim()) handleLine(buffer)
      resolve()
    })
    stdin.once('error', () => resolve())
  })

  await queue
}

const isMain = () => {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(arg)
  } catch {
    return false
  }
}

if (isMain()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err) => {
      if (!err || err.code !== 'EPIPE') throw err
    })
  }
  runBridge().catch((err) => {
    process.stderr.write(`Kioku MCP 桥接异常：${failureText(err)}\n`)
    process.exitCode = 1
  })
}
