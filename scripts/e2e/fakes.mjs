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
        close: () => new Promise((done) => server.close(done)),
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
  const events = () =>
    requests
      .filter((r) => r.path === '/v1/lifecycle/event' && r.authorized)
      .map((r) => r.body ?? {})
  const mcp = () =>
    requests.filter((r) => r.path === '/v1/mcp' && r.authorized).map((r) => r.body?.method)
  return { ...server, requests, events, mcp }
}

// 这次请求里模型看到了什么：注入的两个标记、Kioku 的工具
function seen(raw) {
  return {
    boot: raw.includes(BOOT_MARK),
    recall: raw.includes(RECALL_MARK),
    tools: raw.includes('kioku_get'),
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
    const flags = seen(raw)
    const text = replyText(flags)
    const id = `e2e-${++n}`
    const created = Math.floor(Date.now() / 1000)
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    if (/\/chat\/completions$/.test(path)) {
      requests.push({ api: 'chat', ...flags })
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
