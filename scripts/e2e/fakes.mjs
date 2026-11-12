// 端到端实测用的两个假服务：假的 Kioku 与假的模型服务。都只听本机，记下收到的请求。
// 假的 Kioku 照服务端的格式回答（接口变了要跟着改）；假的模型不生成内容，只把「请求里看没看到注入的标记、
// 有没有 Kioku 的工具」写成一句回答，用来核对注入确实到了模型手上

import { createServer } from 'node:http'

export const KEY = 'kioku_e2e_key'
export const MODEL_KEY = 'sk-e2e-model'
export const MODEL = 'e2e-model'
export const BOOT_MARK = 'KIOKU-E2E-BOOT'
export const RECALL_MARK = 'KIOKU-E2E-RECALL'

const TOOLS = [
  {
    name: 'kioku_get',
    description: '读一条记忆',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string', description: '坐标' } },
      required: ['uri'],
    },
  },
  {
    name: 'kioku_search',
    description: '搜索记忆',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '查询' } },
      required: ['query'],
    },
  },
]

function listen(handler) {
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      Promise.resolve()
        .then(() => handler(req, res, raw))
        .catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        // 平台留在后台的进程可能还连着：先断开，否则 close 一直等
        close: () =>
          new Promise((done) => {
            server.close(done)
            server.closeAllConnections()
          }),
      })
      // 平台留着的长连接不拦着关服务
      server.unref()
    })
  })
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const text = (value, min, max) =>
  typeof value === 'string' && value.length >= min && Array.from(value).length <= max

// 一个生命周期事件哪里不合契约（contracts 的 SessionStartEvent、PromptSubmitEvent、TurnEndEvent）；合格为 null
function eventProblem(body) {
  if (!body || typeof body !== 'object') return '不是 JSON 对象'
  const optionalId = body.sessionId === undefined || text(body.sessionId, 0, 200)
  if (body.event === 'session.start') return optionalId ? null : 'sessionId 不对'
  if (body.event === 'prompt.submit') {
    if (!optionalId) return 'sessionId 不对'
    return text(body.prompt, 1, 20_000) ? null : 'prompt 不对'
  }
  if (body.event === 'turn.end') {
    if (!text(body.sessionId, 1, 200)) return 'turn.end 要带 sessionId'
    if (!text(body.user, 1, 20_000)) return 'user 不对'
    return text(body.reply, 0, 20_000) ? null : 'reply 不对'
  }
  return `不认识的事件 ${String(body.event)}`
}

// 假的 Kioku。runtimeFamily 决定生命周期输出的格式，和服务端的 hostOutput 一样
export async function startFakeKioku(runtimeFamily) {
  const requests = []
  const hostOutput = (event, context) => {
    if (!context) return { mode: 'none', value: null }
    if (runtimeFamily !== 'codex') return { mode: 'return_value', value: { context } }
    const hookEventName = event === 'session.start' ? 'SessionStart' : 'UserPromptSubmit'
    return {
      mode: 'stdout_json',
      value: { hookSpecificOutput: { hookEventName, additionalContext: context } },
    }
  }
  const server = await listen((req, res, raw) => {
    const authorized = req.headers.authorization === `Bearer ${KEY}`
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    requests.push({ method: req.method, path: req.url, authorized, body })
    if (req.url === '/v1/health') return json(res, 200, { status: 'ok', version: 'e2e' })
    if (!authorized) return json(res, 401, { error: '访问密钥无效' })
    if (req.url === '/v1/whoami') {
      return json(res, 200, {
        app: { id: 'app', slug: runtimeFamily, name: `e2e ${runtimeFamily}`, runtimeFamily },
        scopes: {
          readLayers: ['core', 'app', 'user'],
          writeLayers: ['app', 'user'],
          maxSensitivity: 'private',
          admin: false,
          credentials: 'none',
        },
      })
    }
    if (req.url === '/v1/lifecycle/event' && req.method === 'POST') {
      // 照服务端的契约校验：不合格的事件服务端回 400，插件按设计不出声，不校验的话这里会当成收到了
      const problem = eventProblem(body)
      if (problem) {
        requests.at(-1).rejected = problem
        return json(res, 400, { error: problem })
      }
      const context =
        body?.event === 'session.start'
          ? `${BOOT_MARK}：这是启动加载`
          : body?.event === 'prompt.submit'
            ? `${RECALL_MARK}：这是召回`
            : ''
      return json(res, 200, { hostOutput: hostOutput(body?.event, context), nodeUris: [] })
    }
    if (req.url === '/v1/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        return res.end()
      }
      const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: body.id, result })
      if (body?.id === undefined) {
        // 通知：没有回答
        res.writeHead(202)
        return res.end()
      }
      if (body.method === 'initialize') {
        return reply({
          protocolVersion: body.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'kioku-e2e', version: '0.0.0' },
        })
      }
      if (body.method === 'tools/list') return reply({ tools: TOOLS })
      if (body.method === 'tools/call') {
        return reply({ content: [{ type: 'text', text: `e2e ${body.params?.name}` }] })
      }
      if (body.method === 'ping') return reply({})
      return json(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Method not found' },
      })
    }
    return json(res, 404, { error: '接口不存在' })
  })
  // 收下的事件（带访问密钥、合格的）；from 是从第几个请求算起
  const events = (from = 0) =>
    requests
      .slice(from)
      .filter((r) => r.path === '/v1/lifecycle/event' && r.authorized && !r.rejected)
      .map((r) => r.body ?? {})
  const rejected = () => requests.filter((r) => r.rejected).map((r) => r.rejected)
  const mcp = (from = 0) =>
    requests
      .slice(from)
      .filter((r) => r.path === '/v1/mcp' && r.authorized)
      .map((r) => r.body?.method)
  return { ...server, requests, events, rejected, mcp }
}

// 这次请求里模型看到了什么：注入的两个标记，以及工具清单里有没有 Kioku 的工具
// （只看 tools 字段：正文里提到工具名不算）
function seen(raw, body) {
  return {
    boot: raw.includes(BOOT_MARK),
    recall: raw.includes(RECALL_MARK),
    tools: JSON.stringify(body?.tools ?? []).includes('kioku_get'),
    // 工具的名字，出问题时看得到模型手上到底有什么
    toolNames: (Array.isArray(body?.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name ?? tool?.name ?? tool?.type)
      .slice(0, 60),
    // 对话里（工具的结果）有没有出现 Kioku 的工具：按需搜索工具的平台靠它核对
    found: JSON.stringify(body?.messages ?? body?.input ?? []).includes('kioku_get'),
  }
}
export const replyText = ({ boot, recall, tools }) =>
  `E2E-REPLY boot=${boot ? 1 : 0} recall=${recall ? 1 : 0} tools=${tools ? 1 : 0}`

const sse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  return (event, data) => {
    if (event) res.write(`event: ${event}\n`)
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  }
}

// 假的模型服务：Chat Completions 与 Responses 两种接口，流式与非流式都回同一句
export async function startFakeModel() {
  const requests = []
  let n = 0
  const server = await listen((req, res, raw) => {
    const path = req.url.split('?')[0]
    if (req.method === 'GET' && /\/models$/.test(path)) {
      return json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] })
    }
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = {}
    }
    const flags = seen(raw, body)
    const text = replyText(flags)
    const id = `e2e-${++n}`
    const created = Math.floor(Date.now() / 1000)
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    if (/\/chat\/completions$/.test(path)) {
      requests.push({ api: 'chat', ...flags })
      // 平台把工具放在按需搜索后面时（请求里有 tool_search、还没有工具的结果）：先让模型搜一次 kioku，
      // 下一个请求里带着搜索结果，从里面看 Kioku 的工具登记上没有
      const searchable = (Array.isArray(body.tools) ? body.tools : []).some(
        (tool) => tool?.function?.name === 'tool_search',
      )
      const searched = (Array.isArray(body.messages) ? body.messages : []).some(
        (message) => message?.role === 'tool',
      )
      if (searchable && !searched) {
        const call = {
          id: `call_${id}`,
          type: 'function',
          function: { name: 'tool_search', arguments: JSON.stringify({ query: 'kioku' }) },
        }
        if (!body.stream) {
          return json(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model: body.model ?? MODEL,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: null, tool_calls: [call] },
                finish_reason: 'tool_calls',
              },
            ],
            usage,
          })
        }
        const send = sse(res)
        const chunk = (delta, finish) => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model ?? MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
        send(
          null,
          chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, ...call }] }, null),
        )
        send(null, chunk({}, 'tool_calls'))
        send(null, { ...chunk({}, null), choices: [], usage })
        send(null, '[DONE]')
        return res.end()
      }
      if (!body.stream) {
        return json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: body.model ?? MODEL,
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage,
        })
      }
      const send = sse(res)
      const chunk = (delta, finish) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model ?? MODEL,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      send(null, chunk({ role: 'assistant', content: '' }, null))
      send(null, chunk({ content: text }, null))
      send(null, chunk({}, 'stop'))
      send(null, { ...chunk({}, null), choices: [], usage })
      send(null, '[DONE]')
      return res.end()
    }
    if (/\/responses$/.test(path)) {
      requests.push({ api: 'responses', ...flags })
      const item = {
        id: `msg_${id}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      }
      const response = (status, output) => ({
        id: `resp_${id}`,
        object: 'response',
        created_at: created,
        status,
        model: body.model ?? MODEL,
        output,
        usage:
          status === 'completed' ? { input_tokens: 1, output_tokens: 1, total_tokens: 2 } : null,
      })
      if (!body.stream) return json(res, 200, response('completed', [item]))
      const send = sse(res)
      let seq = 0
      const emit = (type, data) => send(type, { type, sequence_number: seq++, ...data })
      const at = { item_id: item.id, output_index: 0, content_index: 0 }
      emit('response.created', { response: response('in_progress', []) })
      emit('response.in_progress', { response: response('in_progress', []) })
      emit('response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      })
      emit('response.content_part.added', {
        ...at,
        part: { type: 'output_text', text: '', annotations: [] },
      })
      emit('response.output_text.delta', { ...at, delta: text })
      emit('response.output_text.done', { ...at, text })
      emit('response.content_part.done', { ...at, part: item.content[0] })
      emit('response.output_item.done', { output_index: 0, item })
      emit('response.completed', { response: response('completed', [item]) })
      return res.end()
    }
    requests.push({ api: `unknown ${req.method} ${path}` })
    return json(res, 404, { error: { message: 'not found' } })
  })
  return { ...server, requests }
}
