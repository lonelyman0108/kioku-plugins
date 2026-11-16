import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { forwardGeminiEvent } from '../hooks/forward.mjs'

const KEY = 'kioku_test_key'

let server
let base
let events = []
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    events.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    const hookEventName = body.event === 'session.start' ? 'SessionStart' : 'BeforeAgent'
    const additionalContext =
      body.event === 'session.start'
        ? 'GEMINI_BOOT'
        : body.event === 'prompt.submit'
          ? 'GEMINI_RECALL'
          : ''
    res.end(
      JSON.stringify({
        hostOutput: {
          mode: 'stdout_json',
          value: { hookSpecificOutput: { hookEventName, additionalContext } },
        },
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
beforeEach(() => {
  events = []
  dir = mkdtempSync(join(tmpdir(), 'kioku-gemini-hook-'))
  env = { KIOKU_CONFIG_DIR: dir }
  writeFileSync(join(dir, 'gemini.json'), JSON.stringify({ serverUrl: base, apiKey: KEY }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Gemini CLI Kioku 钩子', () => {
  it('hooks.json 的超时单位为毫秒且至少 10000ms', () => {
    const cfg = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
    for (const entries of Object.values(cfg.hooks)) {
      for (const group of entries) {
        for (const hook of group.hooks) {
          expect(hook.timeout).toBeGreaterThanOrEqual(10_000)
        }
      }
    }
  })

  it('转发 SessionStart、BeforeAgent 与 AfterAgent，并可回退取暂存用户输入与 last_assistant_message', async () => {
    const boot = await forwardGeminiEvent('session.start', 'not-json', env)
    expect(boot).toBe('GEMINI_BOOT')

    const recall = await forwardGeminiEvent(
      'prompt.submit',
      JSON.stringify({ session_id: 'g1', prompt: '看看部署端口' }),
      env,
    )
    expect(recall).toBe('GEMINI_RECALL')

    const end = await forwardGeminiEvent(
      'turn.end',
      JSON.stringify({ session_id: 'g1', last_assistant_message: '端口是 18920' }),
      env,
    )
    expect(end).toBeNull()
    expect(events.map((e) => e.event)).toEqual(['session.start', 'prompt.submit', 'turn.end'])
    expect(events[2]).toMatchObject({
      sessionId: 'g1',
      user: '看看部署端口',
      reply: '端口是 18920',
    })
  })

  it('stop_hook_active 为真时不重复上报；缺少配置时在 SessionStart 给出提示', async () => {
    const end = await forwardGeminiEvent(
      'turn.end',
      JSON.stringify({
        session_id: 'g1',
        stop_hook_active: true,
        prompt: 'x',
        prompt_response: 'y',
      }),
      env,
    )
    expect(end).toBeNull()
    expect(events).toEqual([])

    const emptyDir = mkdtempSync(join(tmpdir(), 'kioku-gemini-empty-'))
    try {
      const hint = await forwardGeminiEvent('session.start', '{}', { KIOKU_CONFIG_DIR: emptyDir })
      expect(hint).toContain('kioku setup gemini')
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
