import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const pluginRoot = fileURLToPath(new URL('../..', import.meta.url))
const script = fileURLToPath(new URL('../forward.mjs', import.meta.url))

let server
let base
let requests = []
let reply = () => ({ status: 200, body: { hostOutput: { mode: 'none', value: null } } })

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ url: req.url, headers: req.headers, body })
      const next = reply(body, req)
      res.writeHead(next.status ?? 200, {
        'content-type': 'application/json',
        ...(next.headers ?? {}),
      })
      res.end(JSON.stringify(next.body ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
beforeEach(() => {
  requests = []
  reply = () => ({ status: 200, body: { hostOutput: { mode: 'none', value: null } } })
  dir = mkdtempSync(join(tmpdir(), 'kioku-zcode-hook-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function runHook(args, input, envPatch = {}) {
  const env = {
    ...process.env,
    KIOKU_CONFIG_DIR: dir,
    KIOKU_DEVICE_KEY: 'zcode-dev',
  }
  delete env.ZCODE_PLUGIN_DATA
  delete env.PLUGIN_DATA
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input ?? {}))
  })
}

function seedProfile(url = base, apiKey = 'kioku_zcode_test_key') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'zcode.json'), JSON.stringify({ serverUrl: url, apiKey }))
}

describe('ZCode 插件布局与生命周期钩子', () => {
  it('清单、市场、MCP 与 hooks.json 符合 ZCode 插件规范', () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, '.zcode-plugin', 'plugin.json'), 'utf8'),
    )
    const marketplace = JSON.parse(readFileSync(join(pluginRoot, 'marketplace.json'), 'utf8'))
    const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'))
    const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'))

    expect(manifest.name).toBe('kioku')
    expect(marketplace.name).toBe('kioku')
    expect(marketplace.plugins[0]).toMatchObject({ name: 'kioku', source: './' })
    expect(mcp.mcpServers.kioku).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/hooks/mcp-stdio.mjs'],
      cwd: '${ZCODE_PROJECT_DIR}',
    })
    expect(hooks.hooks.SessionStart[0].matcher).toBe('startup|resume|clear')
    expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: 'process',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/hooks/forward.mjs', 'session.start'],
    })
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({
      type: 'process',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/hooks/forward.mjs', 'prompt.submit'],
    })
    expect(hooks.hooks.Stop[0].hooks[0]).toMatchObject({
      type: 'process',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/hooks/forward.mjs', 'turn.end'],
    })
  })

  it('SessionStart / UserPromptSubmit 注入上下文且只透传 additionalContext；Stop 提交本轮摘要', async () => {
    seedProfile()
    reply = (body) => {
      if (body.event === 'session.start') {
        return {
          status: 200,
          body: {
            hostOutput: {
              mode: 'stdout_json',
              value: {
                continue: false,
                decision: 'block',
                hookSpecificOutput: {
                  hookEventName: 'SessionStart',
                  additionalContext: 'ZCODE_BOOT_CTX',
                },
              },
            },
          },
        }
      }
      if (body.event === 'prompt.submit') {
        return {
          status: 200,
          body: {
            hostOutput: {
              mode: 'stdout_json',
              value: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: 'ZCODE_RECALL_CTX',
                },
              },
            },
          },
        }
      }
      return { status: 200, body: { hostOutput: { mode: 'none', value: null } } }
    }

    const start = await runHook(['session.start'], {
      session_id: 'z-sess-1',
      cwd: pluginRoot,
      source: 'startup',
    })
    expect(start.code).toBe(0)
    expect(JSON.parse(start.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'ZCODE_BOOT_CTX',
      },
    })
    expect(requests[0].body).toMatchObject({
      event: 'session.start',
      sessionId: 'z-sess-1',
      deviceKey: 'zcode-dev',
    })

    const prompt = await runHook(['prompt.submit'], {
      conversation_id: 'z-sess-1',
      turn_id: 'turn-1',
      prompt: '查一下发布流程',
      cwd: pluginRoot,
    })
    expect(prompt.code).toBe(0)
    expect(JSON.parse(prompt.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'ZCODE_RECALL_CTX',
      },
    })

    // stop_hook_active 为 true 时跳过且保留 pending
    const skippedStop = await runHook(['turn.end'], {
      session_id: 'z-sess-1',
      turn_id: 'turn-1',
      stop_hook_active: true,
      last_assistant_message: '中间回复',
    })
    expect(skippedStop.code).toBe(0)
    expect(skippedStop.stdout).toBe('')
    expect(requests).toHaveLength(2)

    const stop = await runHook(['turn.end'], {
      sessionId: 'z-sess-1',
      turnId: 'turn-1',
      lastAssistantMessage: '发布先跑 scripts/check.sh 再开 PR。',
    })
    expect(stop.code).toBe(0)
    expect(stop.stdout).toBe('')
    expect(requests).toHaveLength(3)
    expect(requests[2].body).toMatchObject({
      event: 'turn.end',
      sessionId: 'z-sess-1',
      user: '查一下发布流程',
      reply: '发布先跑 scripts/check.sh 再开 PR。',
    })
  })

  it('Stop 缺少 last_assistant_message 时可从 transcript_path 回退读取最后一轮', async () => {
    seedProfile()
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: '第一轮问题' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '第一轮回答' }] },
        }),
        JSON.stringify({ type: 'user', message: { content: '第二轮问题' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '第二轮回答' }] },
        }),
      ].join('\n'),
    )

    // 不传 argv[2] 时也能按 hook_event_name 识别 Stop
    const stop = await runHook([], {
      hook_event_name: 'Stop',
      session_id: 'z-sess-2',
      transcript_path: transcript,
    })
    expect(stop.code).toBe(0)
    expect(stop.stdout).toBe('')
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({
      event: 'turn.end',
      sessionId: 'z-sess-2',
      user: '第二轮问题',
      reply: '第二轮回答',
    })
  })

  it('未配置、配置损坏与服务端失败均退出 0 且不泄露访问密钥', async () => {
    const unconfiguredStart = await runHook(['session.start'], { session_id: 's0' })
    expect(unconfiguredStart.code).toBe(0)
    expect(JSON.parse(unconfiguredStart.stdout).hookSpecificOutput.additionalContext).toContain(
      'kioku login zcode',
    )

    const unconfiguredPrompt = await runHook(['prompt.submit'], { prompt: 'hello' })
    expect(unconfiguredPrompt.code).toBe(0)
    expect(unconfiguredPrompt.stdout).toBe('')

    // 访问密钥错误 / 401 绝不泄露明文且保持退出码 0
    const secret = 'kioku_zcode_secret_never_leak'
    seedProfile(base, secret)
    reply = () => ({ status: 401, body: { error: `invalid ${secret}` } })
    const failed = await runHook(['prompt.submit'], { session_id: 's1', prompt: 'hi' })
    expect(failed.code).toBe(0)
    expect(failed.stdout).toBe('')
    expect(failed.stdout + failed.stderr).not.toContain(secret)

    // 损坏配置文件在 session.start（即使通过 hook_event_name 推断）也输出提示但不崩
    writeFileSync(join(dir, 'zcode.json'), '{broken json')
    const broken = await runHook([], { hook_event_name: 'SessionStart', session_id: 's2' })
    expect(broken.code).toBe(0)
    expect(JSON.parse(broken.stdout).hookSpecificOutput.additionalContext).toContain('配置无法使用')

    // 非对象 JSON（如 null）在 session.start 下仍可正常执行启动加载
    seedProfile()
    reply = () => ({
      status: 200,
      body: {
        hostOutput: {
          mode: 'stdout_json',
          value: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'OK' } },
        },
      },
    })
    const nullInput = await runHook(['session.start'], 'null')
    expect(nullInput.code).toBe(0)
    expect(JSON.parse(nullInput.stdout).hookSpecificOutput.additionalContext).toBe('OK')
  })

  it('pending turn 校验 turnId 防跨轮错配，且无 turnId 的 Stop 同步清理精确缓存', async () => {
    seedProfile()
    // 轮次 1 记下 latest，轮次 2 覆盖 latest；若迟到的轮次 1 Stop 找不到精确文件，不得偷用轮次 2 的 latest
    await runHook(['prompt.submit'], {
      session_id: 'z-sess-race',
      turn_id: 'latest',
      prompt: '轮次一',
    })
    await runHook(['prompt.submit'], {
      session_id: 'z-sess-race',
      turn_id: 'turn-2',
      prompt: '轮次二',
    })
    // 消费掉 turn-1（不存在的旧 turnId）不得偷走 turn-2 的 latest
    requests = []
    const staleStop = await runHook(['turn.end'], {
      session_id: 'z-sess-race',
      turn_id: 'turn-gone',
      last_assistant_message: '迟到回复',
    })
    expect(staleStop.code).toBe(0)
    expect(requests).toHaveLength(0)

    // 之后不带 turnId 的 Stop 仍能正确取到轮次二，同时清理 exact 文件
    const stop2 = await runHook(['turn.end'], {
      session_id: 'z-sess-race',
      last_assistant_message: '第二轮回复',
    })
    expect(stop2.code).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({
      event: 'turn.end',
      user: '轮次二',
      reply: '第二轮回复',
    })
    // 重复 Stop 不再命中已清理的 exact 文件
    requests = []
    await runHook(['turn.end'], {
      session_id: 'z-sess-race',
      turn_id: 'turn-2',
      last_assistant_message: '重复',
    })
    expect(requests).toHaveLength(0)
  })
})
