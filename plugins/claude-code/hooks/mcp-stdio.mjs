// Claude Code 的 MCP stdio 桥接：从标准输入按行读取 JSON-RPC 2.0 消息，
// 转发到 Kioku 的 Streamable HTTP 端点（POST /v1/mcp），并将响应单行写回标准输出。
// 优先使用 /plugin 配置注入的 CLAUDE_PLUGIN_OPTION_*，未填写时回退读取 ~/.config/kioku/claude-code.json。
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
const LOGIN_HINT =
  '运行 kioku login claude-code（没有 kioku 命令时用 npx @kioku-memory/cli login claude-code）'

async function resolveMcpConfig(env) {
  let url = (env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  let key = (env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  if (!url && !key) {
    const profile = await readProfile('claude-code', env)
    if (profile) {
      url = profile.url
      key = profile.key
    }
  } else if (!url || !key) {
    throw new KiokuFailure(
      `Kioku 只在 /plugin 里填写了服务地址或访问密钥中的一项，须成对填写或同时留空（也可${LOGIN_HINT}）`,
    )
  }
  if (!url || !key) {
    throw new KiokuFailure(`Kioku 尚未配置服务地址和访问密钥：${LOGIN_HINT}或在 /plugin 里填写`)
  }
  const problem = serverUrlProblem(url) ?? keyFormatError(key)
  if (problem) throw new KiokuFailure(problem)
  return { url, key }
}

// 从 SSE 文本或普通 JSON 响应中提取需要写回给 MCP 客户端的 JSON-RPC 消息列表
function extractPayloads(text, contentType) {
  if (!text.trim()) return []
  if (!contentType.includes('text/event-stream')) return [text]
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

  // 通知消息不需要在 stdout 返回响应
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
    const items = Array.isArray(msg) ? msg : [msg]
    queue = queue.then(async () => {
      for (const item of items) {
        await forwardMessage(item, { env, fetchImpl, out: stdout, errOut: stderr, timeoutMs })
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
