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
    name: 'kioku_boot',
    description: '加载当前终端透镜对应的常驻记忆与近期会话摘要',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '当前项目标识' },
        device_key: { type: 'string', description: '当前设备标识' },
      },
    },
  },
  {
    name: 'kioku_search',
    description: '按混合检索（向量 + 中文全文 + 场景亲和 + 一跳双链）召回记忆线索',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询语句或关键词' },
        limit: { type: 'integer', description: '返回条数，默认 10' },
        env: { type: 'string', description: '临时环境焦点覆盖' },
        realm: { type: 'string', description: '临时场域焦点覆盖' },
        project: { type: 'string', description: '临时项目焦点覆盖' },
        runtime: { type: 'string', description: '临时客户端焦点覆盖' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kioku_get',
    description: '按短 ID（m-xxxxxx）或精确标题读取记忆正文、元数据、双链邻居与凭据引用状态',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆短 ID（如 m-234abc）或精确标题' } },
      required: ['id'],
    },
  },
  {
    name: 'kioku_history',
    description:
      '读取单条记忆的语义化变更时间线，或按 version 查阅特定历史版本快照（默认不返回大快照，节省上下文）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆短 ID（如 m-234abc）或精确标题' },
        limit: { type: 'integer', description: '返回最近条数，默认 10' },
        version: { type: 'integer', description: '指定版本号时返回该版本的完整快照正文' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kioku_list_credentials',
    description: '列出当前访问密钥允许使用的凭据标识与说明（仅元数据，绝不返回明文值）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kioku_browse',
    description: '按项目、环境、场域、客户端、主题或类型分组浏览可见记忆目录',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: {
          type: 'string',
          enum: ['topic', 'project', 'env', 'realm', 'runtime', 'kind'],
          description: '分组维度，默认 project',
        },
        kind: { type: 'string', enum: ['entry', 'episode'], description: '按类型过滤' },
        topic: { type: 'string', description: '按主题标签过滤' },
        project: { type: 'string', description: '按项目过滤' },
        env: { type: 'string', description: '按环境过滤' },
        realm: { type: 'string', description: '按场域过滤' },
        runtime: { type: 'string', description: '按客户端过滤' },
        pinned_only: { type: 'boolean', description: '仅看常驻启动加载记忆' },
        query: { type: 'string', description: '按标题或短 ID 关键词过滤' },
        limit: { type: 'integer', description: '最多返回条数' },
      },
    },
  },
  {
    name: 'kioku_create',
    description:
      '新建一条扁平长期记忆，正文支持 Markdown、[[m-xxxxxx]] 双链与 {{cred:<slug>}} 占位符',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题' },
        content: { type: 'string', description: 'Markdown 正文' },
        topics: { type: 'array', items: { type: 'string' }, description: '主题标签列表' },
        envs: { type: 'array', items: { type: 'string' }, description: '适用环境列表' },
        realms: { type: 'array', items: { type: 'string' }, description: '适用场域列表' },
        projects: { type: 'array', items: { type: 'string' }, description: '适用项目标识列表' },
        runtimes: { type: 'array', items: { type: 'string' }, description: '适用客户端标识列表' },
        is_pinned: { type: 'boolean', description: '是否作为常驻记忆在会话启动时自动注入' },
        disclosure: { type: 'string', description: '何时需要想起此条的简短说明' },
        valid_to: { type: 'string', description: '过期时间（ISO 8601 带时区）' },
      },
      required: ['content'],
    },
  },
  {
    name: 'kioku_update',
    description: '修改已有记忆的标题、正文、场景标签、常驻状态或有效期',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆短 ID 或精确标题' },
        expected_version: { type: 'integer', description: '期望版本号（乐观锁）' },
        title: { type: 'string' },
        content: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' } },
        envs: { type: 'array', items: { type: 'string' } },
        realms: { type: 'array', items: { type: 'string' } },
        projects: { type: 'array', items: { type: 'string' } },
        runtimes: { type: 'array', items: { type: 'string' } },
        is_pinned: { type: 'boolean' },
        disclosure: { type: 'string' },
        valid_to: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kioku_delete',
    description: '软删除一条记忆（移入回收站，可在管理界面恢复）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆短 ID 或精确标题' },
        expected_version: { type: 'integer', description: '期望版本号' },
      },
      required: ['id'],
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
  typeof value === 'string' && value.length >= min && value.length <= max

// 一个生命周期事件哪里不合契约（contracts 的 SessionStartEvent、PromptSubmitEvent、TurnEndEvent）；合格为 null
function eventProblem(body) {
  if (!body || typeof body !== 'object') return '不是 JSON 对象'
  const optionalId = body.sessionId === undefined || text(body.sessionId, 0, 200)
  if (body.deviceKey !== undefined && !text(body.deviceKey, 1, 128)) return 'deviceKey 不对'
  if (body.project !== undefined) {
    if (!body.project || typeof body.project !== 'object' || Array.isArray(body.project)) {
      return 'project 不对'
    }
    if (body.project.dirName !== undefined && !text(body.project.dirName, 1, 128)) {
      return 'project.dirName 不对'
    }
    if (body.project.repoName !== undefined && !text(body.project.repoName, 1, 128)) {
      return 'project.repoName 不对'
    }
  }
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
export async function startFakeKioku(
  runtimeFamily,
  { apiGeneration = 3, databaseState = 'ok' } = {},
) {
  const requests = []
  const hostOutput = (event, context) => {
    if (!context) return { mode: 'none', value: null }
    const hookEventName = event === 'session.start' ? 'SessionStart' : 'UserPromptSubmit'
    if (runtimeFamily === 'claudecode') {
      return event === 'session.start'
        ? {
            mode: 'stdout_json',
            value: { hookSpecificOutput: { hookEventName, additionalContext: context } },
          }
        : { mode: 'stdout_text', value: context }
    }
    if (runtimeFamily === 'codex') {
      return {
        mode: 'stdout_json',
        value: { hookSpecificOutput: { hookEventName, additionalContext: context } },
      }
    }
    if (runtimeFamily === 'gemini') {
      return {
        mode: 'stdout_json',
        value: {
          hookSpecificOutput: {
            hookEventName: event === 'session.start' ? 'SessionStart' : 'BeforeAgent',
            additionalContext: context,
          },
        },
      }
    }
    if (runtimeFamily === 'agy') {
      return {
        mode: 'stdout_json',
        value: { injectSteps: [{ systemMessage: { systemMessage: context } }] },
      }
    }
    return { mode: 'return_value', value: { context } }
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
    if (req.url === '/v1/health') {
      if (databaseState === 'unavailable') {
        return json(res, 503, {
          status: 'unavailable',
          version: 'e2e',
          api: apiGeneration,
          database: 'unavailable',
        })
      }
      return json(
        res,
        200,
        apiGeneration === 1
          ? { status: 'ok', version: '0.5.0' }
          : { status: 'ok', version: 'e2e', api: apiGeneration },
      )
    }
    if (databaseState === 'unavailable') {
      return json(res, 503, { error: '数据库暂时无法连接', code: 'database_unavailable' })
    }
    if (!authorized) {
      return json(res, 401, { error: '访问密钥无效或已吊销' })
    }
    if (req.url === '/v1/whoami') {
      return json(res, 200, {
        accountName: 'E2E Owner',
        key: {
          id: '22222222-2222-4222-8222-222222222222',
          name: `e2e ${runtimeFamily}`,
          prefix: 'e2e000000000',
          runtimeFamily,
          envs: [],
          allowedRealms: null,
          canWrite: true,
          canResolveCredentials: false,
        },
        client: {
          slug: runtimeFamily,
          name: `e2e ${runtimeFamily}`,
          runtimeFamily,
        },
        primaryCircle: {
          slug: 'default',
          name: 'Kioku',
          kind: 'personal',
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
      return json(res, 200, { hostOutput: hostOutput(body?.event, context), shortIds: [] })
    }
    if (req.url === '/v1/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        return res.end()
      }
      const accept = String(req.headers.accept ?? '').toLowerCase()
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        return json(res, 406, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'Not Acceptable: Client must accept both application/json and text/event-stream',
          },
          id: null,
        })
      }
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.includes('application/json')) {
        return json(res, 415, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Unsupported Media Type: Content-Type must be application/json',
          },
          id: null,
        })
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
          serverInfo: { name: 'kioku', version: 'e2e' },
          instructions: 'Kioku 长期记忆服务',
        })
      }
      if (body.method === 'tools/list') return reply({ tools: TOOLS })
      if (body.method === 'tools/call') {
        const name = String(body.params?.name ?? '')
        const args =
          body.params?.arguments && typeof body.params.arguments === 'object'
            ? body.params.arguments
            : {}
        const structuredContent =
          name === 'kioku_list_credentials' || name === 'kioku_history'
            ? { items: [] }
            : name === 'kioku_delete'
              ? { deleted: true, id: String(args.id ?? 'm-222222') }
              : name === 'kioku_browse'
                ? { groupBy: String(args.group_by ?? 'project'), groups: [], truncated: false }
                : ['kioku_get', 'kioku_create', 'kioku_update'].includes(name)
                  ? {
                      entry: {
                        id: '11111111-1111-4111-8111-111111111111',
                        shortId: 'm-222222',
                        kind: 'entry',
                        title: String(args.title ?? 'e2e'),
                        content: String(args.content ?? 'e2e'),
                        disclosure: null,
                        isPinned: false,
                        envs: [],
                        realms: [],
                        projects: [],
                        runtimes: [],
                        topics: [],
                        deviceKey: null,
                        projectSlug: null,
                        validTo: null,
                        version: 1,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                        deletedAt: null,
                      },
                      outboundLinks: [],
                      backlinks: [],
                      credentialRefs: [],
                    }
                  : undefined
        return reply({
          content: [{ type: 'text', text: `e2e ${name}` }],
          ...(structuredContent ? { structuredContent } : {}),
        })
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
  const toolsJson = JSON.stringify(body?.tools ?? [])
  const convoJson = JSON.stringify(body?.messages ?? body?.input ?? [])
  return {
    boot: raw.includes(BOOT_MARK),
    recall: raw.includes(RECALL_MARK),
    tools:
      toolsJson.includes('kioku_get') &&
      toolsJson.includes('kioku_history') &&
      toolsJson.includes('kioku_list_credentials'),
    legacyTools: toolsJson.includes('kioku_transfer'),
    // 工具的名字，出问题时看得到模型手上到底有什么
    toolNames: (Array.isArray(body?.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name ?? tool?.name ?? tool?.type)
      .slice(0, 60),
    // 对话里（工具的结果）有没有出现 Kioku 的工具：按需搜索工具的平台靠它核对
    found:
      convoJson.includes('kioku_get') &&
      convoJson.includes('kioku_history') &&
      convoJson.includes('kioku_list_credentials'),
    legacyFound: convoJson.includes('kioku_transfer'),
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
