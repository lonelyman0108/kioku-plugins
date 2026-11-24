import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { classifyPrompt, createKiokuPlugin } from '../index.js'

const KEY = 'kioku_test_key'

let server
let base
let events = []
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    events.push({ url: req.url, auth: req.headers.authorization, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    const context =
      body.event === 'session.start'
        ? 'BOOT_RULES'
        : body.event === 'prompt.submit'
          ? 'RECALL_HIT'
          : ''
    res.end(
      JSON.stringify({
        hostOutput: {
          mode: 'return_value',
          value: { context },
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
  dir = mkdtempSync(join(tmpdir(), 'kioku-opencode-plugin-'))
  env = { KIOKU_CONFIG_DIR: dir }
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ serverUrl: base, apiKey: KEY }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('OpenCode Kioku 插件', () => {
  it('在 config 钩子注册远程 MCP（保留用户已有 kioku 配置），注入系统提示与消息，并过滤异常/中止回合', async () => {
    const plugin = await createKiokuPlugin({ directory: dir, env })

    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.mcp.kioku).toEqual({
      type: 'remote',
      url: `${base}/v1/mcp`,
      headers: { Authorization: `Bearer ${KEY}` },
      enabled: true,
    })

    const userCfg = { mcp: { kioku: { type: 'remote', url: 'https://custom.example.com/v1/mcp' } } }
    await plugin.config(userCfg)
    expect(userCfg.mcp.kioku.url).toBe('https://custom.example.com/v1/mcp')

    const longSid = 's'.repeat(250)
    const sysOutput = { system: ['base system'] }
    await plugin['experimental.chat.system.transform']({ sessionID: longSid }, sysOutput)
    expect(sysOutput.system).toHaveLength(2)
    expect(sysOutput.system[1]).toContain('BOOT_RULES')

    const msgOutput = {
      message: { id: 'm1', sessionID: longSid, role: 'user' },
      parts: [{ id: 'p1', sessionID: longSid, messageID: 'm1', type: 'text', text: '查一下配置' }],
    }
    await plugin['chat.message']({ sessionID: longSid, messageID: 'm1' }, msgOutput)
    // 同 messageID 重复触发时去重
    await plugin['chat.message']({ sessionID: longSid, messageID: 'm1' }, msgOutput)
    expect(msgOutput.parts).toHaveLength(2)
    expect(msgOutput.parts[1]).toMatchObject({
      type: 'text',
      text: 'RECALL_HIT',
      synthetic: true,
      metadata: { kioku_injected: true },
    })

    // 正常回合在 session.idle 上报且裁剪 sessionId 到 200 字符
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'a1', sessionID: longSid, role: 'assistant' } },
      },
    })
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'ap1', sessionID: longSid, messageID: 'a1', type: 'text', text: '这是结果' },
        },
      },
    })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: longSid } } })

    expect(events.map((e) => e.body.event)).toEqual(['session.start', 'prompt.submit', 'turn.end'])
    expect(events[0].body).toMatchObject({
      deviceKey: expect.any(String),
      project: { dirName: expect.any(String) },
    })
    expect(events[1].body).toMatchObject({
      deviceKey: expect.any(String),
      project: { dirName: expect.any(String) },
    })
    expect(events[2].body.sessionId).toHaveLength(200)
    expect(events[2].body).toMatchObject({
      deviceKey: expect.any(String),
      project: { dirName: expect.any(String) },
      user: '查一下配置',
      reply: '这是结果',
    })

    // 中止/报错的回合不上报半截回复
    const abortedMsg = {
      message: { id: 'm2', sessionID: longSid, role: 'user' },
      parts: [{ id: 'p2', sessionID: longSid, messageID: 'm2', type: 'text', text: '第二轮' }],
    }
    await plugin['chat.message']({ sessionID: longSid, messageID: 'm2' }, abortedMsg)
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'a2', sessionID: longSid, role: 'assistant', error: 'aborted' } },
      },
    })
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'ap2', sessionID: longSid, messageID: 'a2', type: 'text', text: '半截内容' },
        },
      },
    })
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: longSid } } })
    expect(events.filter((e) => e.body.event === 'turn.end')).toHaveLength(1)
  })

  it('classifyPrompt 过滤合成、压缩与子任务消息；压缩会话后重新取启动加载', async () => {
    expect(
      classifyPrompt(
        { sessionID: 's1' },
        {
          message: { id: 'm1', sessionID: 's1', role: 'user' },
          parts: [{ type: 'compaction' }, { type: 'text', text: '正文' }],
        },
      ),
    ).toBeNull()
    expect(
      classifyPrompt(
        { sessionID: 's1' },
        {
          message: { id: 'm1', sessionID: 's1', role: 'user' },
          parts: [
            { type: 'text', text: '忽略', ignored: true },
            { type: 'text', text: '已注入', metadata: { kioku_injected: true } },
            { type: 'text', text: '真实输入' },
          ],
        },
      )?.prompt,
    ).toBe('真实输入')

    const plugin = await createKiokuPlugin({ directory: dir, env })
    const sys = { system: ['base'] }
    await plugin['experimental.chat.system.transform']({ sessionID: 's1' }, sys)
    await plugin.event({ event: { type: 'session.compacted', properties: { sessionID: 's1' } } })
    await plugin['experimental.chat.system.transform']({ sessionID: 's1' }, sys)
    expect(events.filter((e) => e.body.event === 'session.start')).toHaveLength(2)
    expect(sys.system).toHaveLength(2)
  })
})
