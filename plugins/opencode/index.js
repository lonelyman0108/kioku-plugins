// OpenCode 的 Kioku 插件：
// 1. 在 config 钩子里注册 Kioku 的远程 MCP 服务（不把访问密钥写进 opencode.json）；
// 2. 在 experimental.chat.system.transform 注入会话启动加载，压缩后重新获取；
// 3. 在 chat.message 注入当前输入的召回候选，并在 session.idle 时上报本轮摘要。
// 任何网络或配置问题都不阻塞对话（fail-open），只记录到 stderr

import { randomUUID } from 'node:crypto'

import { failureText, KiokuFailure } from './lib/http.mjs'
import {
  clip,
  contextOf,
  deviceKeyOf,
  MAX_PROMPT,
  MAX_REPLY,
  MAX_SESSION_ID,
  postEvent,
  projectOfAsync,
  TIMEOUTS,
} from './lib/lifecycle.mjs'
import { readProfile } from './lib/profile.mjs'

const MARKER_START = '<!-- kioku:system:start -->'
const MARKER_END = '<!-- kioku:system:end -->'
const QUIET_MS = 60_000
const MAX_TRACKED = 200
const RECALL_MARKER = 'kioku:prompt-context'
const NON_TEXT_TYPES = new Set([
  'reasoning',
  'file',
  'tool',
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'agent',
  'retry',
])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function wrapSystemContext(text) {
  return `${MARKER_START}\n${text}\n${MARKER_END}`
}

function isMarkedSystem(text) {
  return typeof text === 'string' && text.includes(MARKER_START) && text.includes(MARKER_END)
}

function isKiokuInjected(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  return metadata.kioku_injected === true || metadata.marker === RECALL_MARKER
}

export function classifyPrompt(input, output) {
  const sessionID = input?.sessionID
  if (!nonEmpty(sessionID)) return null
  if (!output?.message || output.message.role !== 'user' || output.message.summary) return null
  const messageID = output.message.id
  if (!nonEmpty(messageID)) return null
  if (nonEmpty(input.messageID) && input.messageID !== messageID) return null
  if (output.message.sessionID && output.message.sessionID !== sessionID) return null
  if (!Array.isArray(output.parts) || !output.parts.length) return null

  const texts = []
  for (const part of output.parts) {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') return null
    if (part.type === 'compaction' || part.type === 'subtask') return null
    if (part.type !== 'text') {
      if (!NON_TEXT_TYPES.has(part.type)) return null
      continue
    }
    if (part.synthetic === true || part.ignored === true || isKiokuInjected(part.metadata)) {
      continue
    }
    if (nonEmpty(part.text)) texts.push(part.text.trim())
  }
  if (!texts.length) return null
  return { sessionID, messageID, prompt: texts.join('\n\n') }
}

export async function createKiokuPlugin({
  directory,
  worktree,
  env = process.env,
  now = () => Date.now(),
  stderr = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  let profile = null
  let profileError = null
  try {
    profile = await readProfile('opencode', env)
  } catch (err) {
    profileError = err instanceof KiokuFailure ? err.message : failureText(err)
  }

  let quietUntil = 0
  let loggedError = null
  const sessions = new Map()
  const cwd = worktree || directory || process.cwd()
  const deviceKey = deviceKeyOf(env)
  const projectPromise = projectOfAsync(cwd)

  function logOnce(reason) {
    if (loggedError === reason) return
    loggedError = reason
    stderr(`Kioku 插件未生效：${reason}`)
  }
  if (profileError) logOnce(profileError)

  function stateOf(sessionID) {
    let state = sessions.get(sessionID)
    if (!state) {
      if (sessions.size >= MAX_TRACKED) {
        const oldest = sessions.keys().next().value
        sessions.get(oldest)?.controller.abort()
        sessions.delete(oldest)
      }
      state = {
        controller: new AbortController(),
        systemContext: null,
        startupPromise: null,
        promptIDs: new Set(),
        pendingUser: null,
        turnAborted: false,
        assistantMessageIDs: new Set(),
        assistantParts: new Map(),
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  async function forward(event, body, signal) {
    if (!profile) return undefined
    if (now() < quietUntil) return undefined
    try {
      const project = await projectPromise
      const payload = {
        event,
        ...(deviceKey ? { deviceKey } : {}),
        ...(Object.keys(project).length ? { project } : {}),
        ...body,
      }
      const res = await postEvent(profile.url, profile.key, payload, TIMEOUTS[event], signal)
      loggedError = null
      const json = await res.json().catch(() => null)
      return contextOf(json?.hostOutput) ?? null
    } catch (err) {
      if (signal?.aborted) return undefined
      quietUntil = now() + QUIET_MS
      logOnce(failureText(err))
      return undefined
    }
  }

  function ensureStartup(sessionID) {
    if (!profile || !nonEmpty(sessionID)) return Promise.resolve(null)
    const state = stateOf(sessionID)
    if (state.systemContext !== null) return Promise.resolve(state.systemContext)
    if (state.startupPromise) return state.startupPromise
    state.startupPromise = forward(
      'session.start',
      { sessionId: clip(sessionID, MAX_SESSION_ID) },
      state.controller.signal,
    )
      .then((text) => {
        if (typeof text === 'string') state.systemContext = text
        return typeof text === 'string' ? text : null
      })
      .finally(() => {
        state.startupPromise = null
      })
    return state.startupPromise
  }

  return {
    config: async (mergedConfig) => {
      try {
        if (!profile || !mergedConfig || typeof mergedConfig !== 'object') return
        mergedConfig.mcp ??= {}
        if (!Object.hasOwn(mergedConfig.mcp, 'kioku')) {
          mergedConfig.mcp.kioku = {
            type: 'remote',
            url: `${profile.url}/v1/mcp`,
            headers: { Authorization: `Bearer ${profile.key}` },
            enabled: true,
          }
        }
      } catch (err) {
        logOnce(failureText(err))
      }
    },

    event: async ({ event }) => {
      try {
        const type = event?.type
        if (type === 'session.created') {
          const id = event?.properties?.info?.id
          if (nonEmpty(id)) void ensureStartup(id)
        } else if (type === 'session.compacted') {
          const id = event?.properties?.info?.id ?? event?.properties?.sessionID
          const state = id ? sessions.get(id) : null
          if (state) state.systemContext = null
        } else if (type === 'session.error') {
          const id = event?.properties?.sessionID ?? event?.properties?.info?.id
          const state = id ? sessions.get(id) : null
          if (state) {
            state.turnAborted = true
            state.pendingUser = null
            state.assistantParts.clear()
          }
        } else if (type === 'session.deleted') {
          const id = event?.properties?.info?.id
          const state = id ? sessions.get(id) : null
          state?.controller.abort()
          if (id) sessions.delete(id)
        } else if (type === 'message.updated') {
          const info = event?.properties?.info
          const state = nonEmpty(info?.sessionID) ? sessions.get(info.sessionID) : null
          if (!state || info?.role !== 'assistant' || !nonEmpty(info?.id)) return
          if (info.error) {
            state.turnAborted = true
            state.assistantParts.clear()
            return
          }
          state.assistantMessageIDs.add(info.id)
        } else if (type === 'message.part.updated') {
          const part = event?.properties?.part
          if (
            !part ||
            part.type !== 'text' ||
            part.synthetic ||
            part.ignored ||
            !nonEmpty(part.sessionID)
          ) {
            return
          }
          const state = sessions.get(part.sessionID)
          if (
            state &&
            !state.turnAborted &&
            state.assistantMessageIDs.has(part.messageID) &&
            typeof part.text === 'string'
          ) {
            state.assistantParts.set(part.id ?? part.messageID, part.text)
          }
        } else if (type === 'session.idle') {
          const id = event?.properties?.sessionID
          const state = id ? sessions.get(id) : null
          if (!state || !state.pendingUser || state.turnAborted || !profile) {
            if (state) {
              state.pendingUser = null
              state.assistantParts.clear()
              state.turnAborted = false
            }
            return
          }
          const user = state.pendingUser
          const reply = [...state.assistantParts.values()].join('\n').trim()
          state.pendingUser = null
          state.assistantParts.clear()
          if (!reply) return
          await forward(
            'turn.end',
            {
              sessionId: clip(id, MAX_SESSION_ID),
              user: clip(user, MAX_PROMPT),
              reply: clip(reply, MAX_REPLY),
            },
            state.controller.signal,
          )
        }
      } catch (err) {
        logOnce(failureText(err))
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!nonEmpty(input?.sessionID) || !output || !Array.isArray(output.system)) return
        const text = await ensureStartup(input.sessionID)
        if (!text) return
        const retained = output.system.filter((item) => !isMarkedSystem(item))
        retained.push(wrapSystemContext(text))
        output.system.splice(0, output.system.length, ...retained)
      } catch (err) {
        logOnce(failureText(err))
      }
    },

    'chat.message': async (input, output) => {
      try {
        const parsed = classifyPrompt(input, output)
        if (!parsed || !profile) return
        const state = stateOf(parsed.sessionID)
        if (state.promptIDs.has(parsed.messageID)) return
        if (state.promptIDs.size >= MAX_TRACKED) state.promptIDs.clear()
        state.promptIDs.add(parsed.messageID)
        state.pendingUser = parsed.prompt
        state.turnAborted = false
        state.assistantMessageIDs.clear()
        state.assistantParts.clear()

        const text = await forward(
          'prompt.submit',
          {
            sessionId: clip(parsed.sessionID, MAX_SESSION_ID),
            prompt: clip(parsed.prompt, MAX_PROMPT),
          },
          state.controller.signal,
        )
        if (!text) return
        output.parts.push({
          id: `prt_kioku_${randomUUID().replaceAll('-', '')}`,
          sessionID: parsed.sessionID,
          messageID: parsed.messageID,
          type: 'text',
          text,
          synthetic: true,
          metadata: { kioku_injected: true, marker: RECALL_MARKER },
        })
      } catch (err) {
        logOnce(failureText(err))
      }
    },
  }
}

export default async function kioku(input) {
  return createKiokuPlugin(input)
}
