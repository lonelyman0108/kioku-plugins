import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../forward.mjs', import.meta.url))

// 一个假的 Kioku：记下收到的请求，按 reply 返回
let server
let base
let requests = []
let reply = () => ({
  status: 200,
  body: { hostOutput: { mode: 'none', value: null }, nodeUris: [] },
})

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      const { status, body } = reply()
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  requests = []
})

function run(event, input, options = {}) {
  const env = { ...process.env }
  delete env.CLAUDE_PLUGIN_OPTION_SERVER_URL
  delete env.CLAUDE_PLUGIN_OPTION_API_KEY
  if (options.configured !== false) {
    env.CLAUDE_PLUGIN_OPTION_SERVER_URL = options.url ?? `${base}/`
    env.CLAUDE_PLUGIN_OPTION_API_KEY = 'kioku_test_key'
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, event], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}

describe('Claude Code 钩子转发', () => {
  it('会话开始：带 Key 转发 session.start，把 JSON 输出原样写出', async () => {
    const value = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '启动' },
    }
    reply = () => ({
      status: 200,
      body: { hostOutput: { mode: 'stdout_json', value }, nodeUris: [] },
    })
    const dir = mkdtempSync(join(tmpdir(), 'kioku-hook-'))
    const cwd = join(dir, 'my-project')
    execFileSync('git', ['init', '-q', cwd])
    execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@example.com:someone/kioku.git'])
    try {
      const result = await run('session.start', { session_id: 's1', source: 'startup', cwd })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(value)
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe('/v1/lifecycle/event')
      expect(requests[0].headers.authorization).toBe('Bearer kioku_test_key')
      expect(requests[0].body).toEqual({
        event: 'session.start',
        sessionId: 's1',
        project: { dirName: 'my-project', repoName: 'kioku' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不在 git 仓库里时只带目录名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kioku-hook-'))
    try {
      await run('session.start', { cwd: dir })
      expect(requests[0].body.project).toEqual({ dirName: dir.split('/').pop() })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('每轮输入：转发提示语，把召回块作为附加上下文写出', async () => {
    reply = () => ({
      status: 200,
      body: { hostOutput: { mode: 'stdout_text', value: '<recall>\n</recall>' }, nodeUris: [] },
    })
    const result = await run('prompt.submit', {
      session_id: 's1',
      prompt: '  办公室的网络怎么配的  ',
    })
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<recall>\n</recall>',
      },
    })
    expect(requests[0].body).toEqual({
      event: 'prompt.submit',
      sessionId: 's1',
      prompt: '办公室的网络怎么配的',
    })
  })

  it('只转交上下文文本：服务端返回的其他控制字段不透传，挡不住用户的输入', async () => {
    reply = () => ({
      status: 200,
      body: {
        hostOutput: {
          mode: 'stdout_json',
          value: {
            decision: 'block',
            continue: false,
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '启动' },
          },
        },
        nodeUris: [],
      },
    })
    const start = await run('session.start', {})
    expect(JSON.parse(start.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '启动' },
    })

    reply = () => ({
      status: 200,
      body: { hostOutput: { mode: 'stdout_json', value: { decision: 'block' } }, nodeUris: [] },
    })
    const prompt = await run('prompt.submit', { prompt: '你好' })
    expect(prompt).toMatchObject({ code: 0, stdout: '' })

    // 纯文本恰好是一段 JSON 时，也只会作为上下文文本出现
    reply = () => ({
      status: 200,
      body: { hostOutput: { mode: 'stdout_text', value: '{"decision":"block"}' }, nodeUris: [] },
    })
    const text = JSON.parse((await run('prompt.submit', { prompt: '你好' })).stdout)
    expect(text.decision).toBeUndefined()
    expect(text.hookSpecificOutput.additionalContext).toBe('{"decision":"block"}')
  })

  it('提示语为空时不请求', async () => {
    const result = await run('prompt.submit', { session_id: 's1', prompt: '   ' })
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(requests).toHaveLength(0)
  })

  it('服务端出错或连不上时静默退出，不写标准输出', async () => {
    reply = () => ({ status: 500, body: { error: 'boom' } })
    const failed = await run('prompt.submit', { prompt: '你好' })
    expect(failed).toMatchObject({ code: 0, stdout: '' })
    expect(failed.stderr).toContain('HTTP 500')

    const unreachable = await run('session.start', {}, { url: 'http://127.0.0.1:9' })
    expect(unreachable).toMatchObject({ code: 0, stdout: '' })
  })

  it('没有配置时，会话开始提示一次，每轮输入什么都不做', async () => {
    const start = await run('session.start', {}, { configured: false })
    expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toContain('/plugin')
    const prompt = await run('prompt.submit', { prompt: '你好' }, { configured: false })
    expect(prompt.stdout).toBe('')
    expect(requests).toHaveLength(0)
  })

  it('输入不是 JSON 时按空输入处理', async () => {
    const result = await run('prompt.submit', 'not json')
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(requests).toHaveLength(0)
  })

  describe('一轮结束', () => {
    // 写一份会话记录（JSONL），返回路径
    function transcript(entries, extra = '') {
      const dir = mkdtempSync(join(tmpdir(), 'kioku-transcript-'))
      const path = join(dir, 'session.jsonl')
      writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra)
      return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
    }
    const user = (content, more = {}) => ({
      type: 'user',
      message: { role: 'user', content },
      ...more,
    })
    const assistant = (content, more = {}) => ({
      type: 'assistant',
      message: { role: 'assistant', content },
      ...more,
    })

    it('取最后一条用户输入和之后的回复文字，不带会话上下文转发 turn.end，不写标准输出', async () => {
      const { path, cleanup } = transcript(
        [
          user('上一轮的问题'),
          assistant([{ type: 'text', text: '上一轮的回复' }]),
          user('办公室的网络怎么配的'),
          assistant([
            { type: 'text', text: '先查一下记忆。' },
            { type: 'tool_use', id: 't1', name: 'kioku_search', input: { query: '网络' } },
          ]),
          user([{ type: 'tool_result', tool_use_id: 't1', content: '候选' }]),
          user([{ type: 'text', text: '系统注入的提醒' }], { isMeta: true }),
          assistant([{ type: 'text', text: '主路由器在机房。' }]),
          assistant([{ type: 'text', text: '子 Agent 的话' }], { isSidechain: true }),
        ],
        '{"type":"assistant","message":{"content":',
      )
      try {
        const result = await run('turn.end', { session_id: 's1', transcript_path: path })
        expect(result).toMatchObject({ code: 0, stdout: '' })
        expect(requests).toHaveLength(1)
        expect(requests[0].url).toBe('/v1/lifecycle/event')
        expect(requests[0].body).toEqual({
          event: 'turn.end',
          sessionId: 's1',
          user: '办公室的网络怎么配的',
          reply: '先查一下记忆。\n主路由器在机房。',
        })
      } finally {
        cleanup()
      }
    })

    it('别的钩子让 Claude 接着说时这一轮还没完，不发；没有会话记录或用户输入也不发', async () => {
      const { path, cleanup } = transcript([
        user('你好'),
        assistant([{ type: 'text', text: '你好' }]),
      ])
      try {
        await run('turn.end', { session_id: 's1', transcript_path: path, stop_hook_active: true })
        await run('turn.end', { session_id: 's1' })
        await run('turn.end', {
          session_id: 's1',
          transcript_path: join(tmpdir(), 'no-such.jsonl'),
        })
        await run('turn.end', { transcript_path: path })
        expect(requests).toHaveLength(0)
      } finally {
        cleanup()
      }
      const empty = transcript([assistant([{ type: 'text', text: '只有回复' }])])
      try {
        const result = await run('turn.end', { session_id: 's1', transcript_path: empty.path })
        expect(result).toMatchObject({ code: 0, stdout: '' })
        expect(requests).toHaveLength(0)
      } finally {
        empty.cleanup()
      }
    })

    it('服务端出错时静默退出', async () => {
      reply = () => ({ status: 500, body: { error: 'boom' } })
      const { path, cleanup } = transcript([
        user('你好'),
        assistant([{ type: 'text', text: '你好' }]),
      ])
      try {
        const result = await run('turn.end', { session_id: 's1', transcript_path: path })
        expect(result).toMatchObject({ code: 0, stdout: '' })
        expect(result.stderr).toContain('HTTP 500')
      } finally {
        cleanup()
      }
    })
  })
})
