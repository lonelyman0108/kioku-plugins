import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { forwardAgyEvent } from '../hooks/forward.mjs'

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
    const text =
      body.event === 'session.start'
        ? 'AGY_BOOT'
        : body.event === 'prompt.submit'
          ? 'AGY_RECALL'
          : ''
    res.end(
      JSON.stringify({
        hostOutput: {
          mode: 'stdout_json',
          value: { injectSteps: [{ systemMessage: { systemMessage: text } }] },
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
  dir = mkdtempSync(join(tmpdir(), 'kioku-agy-hook-'))
  env = { KIOKU_CONFIG_DIR: dir, PLUGIN_DATA: dir }
  writeFileSync(join(dir, 'agy.json'), JSON.stringify({ serverUrl: base, apiKey: KEY }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Antigravity Kioku 钩子', () => {
  it('转发 SessionStart 与 PreInvocation，同一轮内多次 PreInvocation 只召回一次，Stop 后清状态并防跨轮泄漏旧回复', async () => {
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcript,
      [JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '查网关端口' })].join('\n') +
        '\n',
    )

    const boot = await forwardAgyEvent(
      'session.start',
      JSON.stringify({ conversationId: 'conv-1', workspacePaths: [dir] }),
      env,
    )
    expect(boot).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'AGY_BOOT' } }] })

    const recall1 = await forwardAgyEvent(
      'prompt.submit',
      JSON.stringify({
        conversationId: 'conv-1',
        lastUserInput: '查网关端口',
        transcriptPath: transcript,
      }),
      env,
    )
    expect(recall1).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'AGY_RECALL' } }] })

    // 同一轮后续工具调用再次触发 PreInvocation：不再重复打 lifecycle 接口
    const recall2 = await forwardAgyEvent(
      'prompt.submit',
      JSON.stringify({
        conversationId: 'conv-1',
        lastUserInput: '查网关端口',
        transcriptPath: transcript,
      }),
      env,
    )
    expect(recall2).toEqual({})

    // 第 1 轮结束上报
    writeFileSync(
      transcript,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '查网关端口' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: '在 18920 端口。' }),
      ].join('\n') + '\n',
    )
    await forwardAgyEvent(
      'turn.end',
      JSON.stringify({
        conversationId: 'conv-1',
        lastUserInput: '查网关端口',
        transcriptPath: transcript,
      }),
      env,
    )

    // 第 2 轮无 transcriptPath 时即使输入相同「继续」也不误命中上一轮去重；若无新回复不上报上一轮旧回复
    await forwardAgyEvent(
      'prompt.submit',
      JSON.stringify({ conversationId: 'conv-1', lastUserInput: '继续' }),
      env,
    )
    await forwardAgyEvent(
      'turn.end',
      JSON.stringify({ conversationId: 'conv-1', lastUserInput: '继续', continuationActive: true }),
      env,
    )

    // 第 2 轮进入 transcript 但尚未产生 PLANNER_RESPONSE 时，绝不复用第 1 轮的回复
    writeFileSync(
      transcript,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '查网关端口' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: '在 18920 端口。' }),
        JSON.stringify({ step_index: 3, type: 'USER_INPUT', content: '继续' }),
      ].join('\n') + '\n',
    )
    await forwardAgyEvent(
      'turn.end',
      JSON.stringify({
        conversationId: 'conv-1',
        lastUserInput: '继续',
        transcriptPath: transcript,
      }),
      env,
    )

    expect(events.map((e) => e.event)).toEqual([
      'session.start',
      'prompt.submit',
      'turn.end',
      'prompt.submit',
    ])
    expect(events[2]).toMatchObject({
      sessionId: 'conv-1',
      user: '查网关端口',
      reply: '在 18920 端口。',
    })
  })
})
