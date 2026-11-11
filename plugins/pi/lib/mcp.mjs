// 向 Kioku 的 MCP 端点发一次调用（取工具清单、调用工具）。给没有自己的 MCP 客户端、
// 要把 Kioku 的工具登记成平台自己的工具的平台用。端点是无状态的，一次请求一个回答，不用先握手

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'

import { fetchFailure, isRedirect, KiokuFailure, redirectError } from './http.mjs'
import { profileDir, profileFile } from './profile.mjs'
import { plain } from './text.mjs'

export const TOOLS_TIMEOUT = 8000
export const TOOL_CALL_TIMEOUT = 30_000

// 回答可能是一段事件流：取最后一条 data
function payloadOf(text, contentType) {
  if (!contentType.includes('text/event-stream')) return text
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  return data.at(-1) ?? ''
}

// 一次 JSON-RPC 调用，返回 result。连不上、超时、取消、跳转、访问密钥无效、响应不对、服务端报错都以 KiokuFailure 抛出
export async function mcpCall({ url, key }, method, params, timeout, signal) {
  let res
  let text
  try {
    res = await fetch(`${url}/v1/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      // 不跟着跳转走：访问密钥只发给配置的地址
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeout), signal])
        : AbortSignal.timeout(timeout),
    })
    text = await res.text()
  } catch (err) {
    if (signal?.aborted) throw new KiokuFailure('已取消')
    throw new KiokuFailure(fetchFailure(err, timeout))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  if (res.status === 401) throw new KiokuFailure('访问密钥无效或已吊销')
  if (!res.ok) throw new KiokuFailure(`Kioku 返回 HTTP ${res.status}`)
  let data
  try {
    data = JSON.parse(payloadOf(text, res.headers.get('content-type') ?? ''))
  } catch {
    data = null
  }
  if (data === null || typeof data !== 'object') throw new KiokuFailure('Kioku 的响应格式不对')
  if (data.error) {
    // 服务端写的原因压成一行再给
    const reason = plain(data.error.message)
    throw new KiokuFailure(reason ? `Kioku 没有接受这次调用：${reason}` : 'Kioku 没有接受这次调用')
  }
  return data.result
}

// 清单里能用的工具：名字、说明、参数的 schema 都在的
export function toolsOf(result) {
  const tools = Array.isArray(result?.tools) ? result.tools : []
  return tools
    .filter(
      (tool) =>
        typeof tool?.name === 'string' &&
        tool.name &&
        typeof tool.description === 'string' &&
        tool.inputSchema !== null &&
        typeof tool.inputSchema === 'object' &&
        !Array.isArray(tool.inputSchema),
    )
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

export async function listTools(target, signal) {
  return toolsOf(await mcpCall(target, 'tools/list', {}, TOOLS_TIMEOUT, signal))
}

// 调用一个工具，返回 { text, isError }：结果里的文字块连成一段
export async function callTool(target, name, args, signal) {
  const result = await mcpCall(
    target,
    'tools/call',
    { name, arguments: args ?? {} },
    TOOL_CALL_TIMEOUT,
    signal,
  )
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return { text, isError: result?.isError === true }
}

// 工具清单在本机留一份：平台要求登记工具时当场给出清单、等不了一次请求的（OpenClaw 的工具工厂是同步的），
// 先用这一份，取到新的再换。和地址、访问密钥放在同一个目录，记着是哪个地址的清单
export function toolCacheFile(platform, env) {
  return profileFile(platform, env).replace(/\.json$/, '-tools.json')
}

// 同步读这一份；没有、读不懂时为 null。at 是取到这份清单的时刻（毫秒），没记时为 0
export function readToolCacheSync(platform, env) {
  try {
    const data = JSON.parse(readFileSync(toolCacheFile(platform, env), 'utf8'))
    if (typeof data?.url !== 'string') return null
    const at = Number.isFinite(data.at) && data.at > 0 ? data.at : 0
    return { url: data.url, at, tools: toolsOf(data) }
  } catch {
    return null
  }
}

// 写不进去不算失败：下次再取
export async function writeToolCache(platform, { url, tools, at = Date.now() }, env) {
  const file = toolCacheFile(platform, env)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(profileDir(env), { recursive: true, mode: 0o700 })
    await writeFile(temp, `${JSON.stringify({ url, at, tools })}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600)
    await rename(temp, file)
    return true
  } catch {
    await rm(temp, { force: true }).catch(() => {})
    return false
  }
}

export async function removeToolCache(platform, env) {
  await rm(toolCacheFile(platform, env), { force: true }).catch(() => {})
}
