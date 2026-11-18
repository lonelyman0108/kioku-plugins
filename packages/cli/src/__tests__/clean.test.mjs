import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clean, parseCleanArgs } from '../clean.ts'
import { doctor } from '../doctor.ts'
import { KiokuFailure } from '../core.ts'
import { install } from '../install.ts'
import { main } from '../index.ts'
import { login } from '../login.ts'
import { actionsFor, renderPanel, scanPlatform } from '../panel.ts'
import { setup } from '../setup.ts'
import { UsageError } from '../core.ts'
import { wizard } from '../wizard.ts'

const KEY = 'kioku_test_key'

let server
let base
let requests
let answers
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method, url: req.url, body })
      if (req.url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }))
        return
      }
      if (req.url === '/v1/setup/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ needsSetup: false }))
        return
      }
      if (req.url === '/v1/device/authorize') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            deviceCode: 'dc-1',
            userCode: 'ABCD-EFGH',
            verificationPath: '/authorize',
            expiresIn: 600,
            interval: 1,
          }),
        )
        return
      }
      if (req.url === '/v1/device/token') {
        const reply = answers.length > 1 ? answers.shift() : answers[0]
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
        return
      }
      if (req.url === '/v1/whoami') {
        const key = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        const family = key.replace(/^key-/, '') || 'agy'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            spaceId: '00000000-0000-4000-8000-000000000001',
            app: { id: 'a', slug: family, name: family, runtimeFamily: family },
            scopes: {
              readLayers: ['core', 'app', 'user'],
              writeLayers: ['app', 'user'],
              maxSensitivity: 'internal',
              credentials: 'none',
            },
          }),
        )
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
beforeEach(() => {
  requests = []
  answers = [{ status: 200, body: { status: 'approved', key: KEY, app: { name: 'agy' } } }]
  dir = mkdtempSync(join(tmpdir(), 'kioku-clean-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  env = {
    HOME: home,
    PATH: '',
    KIOKU_CONFIG_DIR: join(dir, 'kioku'),
    AGY_HOME: join(home, '.gemini', 'config'),
    GEMINI_CLI_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    OPENCLAW_HOME: home,
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    DSH_HOME: join(home, '.dsh'),
    HERMES_HOME: join(home, '.hermes'),
    LORE_HOME: join(home, '.lore'),
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ttyStdin(text) {
  const stream = Readable.from([text])
  stream.isTTY = true
  return stream
}

function nonTtyStdin() {
  const stream = Readable.from([])
  stream.isTTY = false
  return stream
}

function seedAgyLore(extra = {}) {
  mkdirSync(env.AGY_HOME, { recursive: true })
  const file = join(env.AGY_HOME, 'mcp_config.json')
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        lore: { url: 'http://127.0.0.1:18901/api/mcp?client_type=mcp' },
        ...extra,
      },
    }),
  )
  return file
}

describe('kioku clean', () => {
  it('解析参数：支持平台、--tool、--dry-run、--yes，拒绝对不认识的值', () => {
    expect(parseCleanArgs([])).toEqual({
      platform: null,
      tool: null,
      dryRun: false,
      yes: false,
    })
    expect(parseCleanArgs(['agy', '--tool', 'lore', '--dry-run', '-y'])).toEqual({
      platform: 'agy',
      tool: 'lore',
      dryRun: true,
      yes: true,
    })
    expect(() => parseCleanArgs(['unknown'])).toThrow(UsageError)
    expect(() => parseCleanArgs(['agy', 'pi'])).toThrow(UsageError)
    expect(() => parseCleanArgs(['--tool', 'nope'])).toThrow(UsageError)
    expect(() => parseCleanArgs(['--bad'])).toThrow(UsageError)
  })

  it('--dry-run 与 --yes、--tool 过滤、TTY 确认与非 TTY 护栏', async () => {
    const agyFile = seedAgyLore({ mem0: { command: 'npx', args: ['mem0-mcp'] } })
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md'), '# lore')

    let text = ''
    const out = { write: (c) => (text += c) }

    // --dry-run 不修改文件
    expect(await clean(['agy', '--dry-run'], { env, cwd: dir, out, stdin: nonTtyStdin() })).toBe(0)
    expect(text).toContain('没有改动（--dry-run）')
    expect(Object.keys(JSON.parse(readFileSync(agyFile, 'utf8')).mcpServers)).toEqual([
      'lore',
      'mem0',
    ])

    // 非 TTY 且无 --yes 时拒绝执行
    await expect(clean(['agy'], { env, cwd: dir, out, stdin: nonTtyStdin() })).rejects.toThrow(
      KiokuFailure,
    )

    // --tool mem0 --yes 只清 mem0，保留 agy 的 lore 与 claude-code 的 lore
    text = ''
    expect(
      await clean(['agy', '--tool', 'mem0', '--yes'], { env, cwd: dir, out, stdin: nonTtyStdin() }),
    ).toBe(0)
    expect(Object.keys(JSON.parse(readFileSync(agyFile, 'utf8')).mcpServers)).toEqual(['lore'])
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md'))).toBe(true)

    // TTY 输入 n 取消，输入 y 清理
    text = ''
    expect(await clean(['agy'], { env, cwd: dir, out, stdin: ttyStdin('n\n') })).toBe(0)
    expect(text).toContain('没有改动')
    expect(Object.keys(JSON.parse(readFileSync(agyFile, 'utf8')).mcpServers)).toEqual(['lore'])

    text = ''
    expect(await clean(['agy'], { env, cwd: dir, out, stdin: ttyStdin('y\n') })).toBe(0)
    expect(JSON.parse(readFileSync(agyFile, 'utf8'))).toEqual({})

    // 入口分发帮助
    expect(await main(['clean', '--help'])).toBe(0)
  })

  it('仅有不可自动移除的疑似项时提示而不误删', async () => {
    const file = join(env.AGY_HOME, 'mcp_config.json')
    mkdirSync(env.AGY_HOME, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { memory: { command: 'node', args: ['custom.js'] } } }),
    )
    let text = ''
    const code = await clean(['agy', '--yes'], {
      env,
      cwd: dir,
      out: { write: (c) => (text += c) },
      stdin: nonTtyStdin(),
    })
    expect(code).toBe(0)
    expect(text).toContain('没有可自动卸载的项')
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.memory).toBeDefined()
  })
})

describe('doctor / setup / login / install / wizard 冲突联动', () => {
  it('kioku doctor agy 发现 Lore 冲突时输出警告与清理命令', async () => {
    seedAgyLore()
    let text = ''
    const code = await doctor(['agy'], {
      env: { ...env, KIOKU_SERVER_URL: base, KIOKU_API_KEY: KEY },
      cwd: dir,
      out: { write: (c) => (text += c) },
    })
    expect(code).toBe(0)
    expect(text).toContain('! 发现冲突的记忆工具（Lore）')
    expect(text).toContain('清理冲突：运行 kioku clean agy')
  })

  it('kioku setup agy：非 TTY 默认阻断，--remove-conflicts 先卸载再接入，TTY 询问确认', async () => {
    const file = seedAgyLore()
    let text = ''
    const out = { write: (c) => (text += c) }

    await expect(
      setup(['agy', '--server-url', base], {
        env,
        cwd: dir,
        out,
        stdin: nonTtyStdin(),
        readKey: async () => KEY,
        login: null,
      }),
    ).rejects.toThrow(/存在冲突的记忆工具/)
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.kioku).toBeUndefined()

    // TTY 拒绝时不写入
    text = ''
    expect(
      await setup(['agy', '--server-url', base], {
        env,
        cwd: dir,
        out,
        stdin: ttyStdin('n\n'),
        readKey: async () => KEY,
        login: null,
      }),
    ).toBe(0)
    expect(text).toContain('没有写入')

    // --remove-conflicts 先卸载 Lore 再写入 Kioku
    text = ''
    expect(
      await setup(['agy', '--server-url', base, '--remove-conflicts'], {
        env,
        cwd: dir,
        out,
        stdin: nonTtyStdin(),
        readKey: async () => KEY,
        login: null,
      }),
    ).toBe(0)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.mcpServers.lore).toBeUndefined()
    expect(saved.mcpServers.kioku.url).toBe(`${base}/v1/mcp`)
  })

  it('kioku login agy：有冲突且未传 --remove-conflicts 时在申请设备码之前阻断', async () => {
    const file = seedAgyLore()
    let text = ''
    const out = { write: (c) => (text += c) }

    await expect(
      login(['agy', '--server-url', base, '--no-browser'], {
        env,
        cwd: dir,
        out,
        stdin: nonTtyStdin(),
        open: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow(/存在冲突的记忆工具/)
    // 确保没有向服务端申请 deviceCode，避免留下孤儿申请或访问密钥
    expect(requests.some((r) => r.url === '/v1/device/authorize')).toBe(false)

    expect(
      await login(['agy', '--server-url', base, '--no-browser', '--remove-conflicts'], {
        env,
        cwd: dir,
        out,
        stdin: nonTtyStdin(),
        open: () => {},
        sleep: async () => {},
      }),
    ).toBe(0)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.mcpServers.lore).toBeUndefined()
    expect(saved.mcpServers.kioku.url).toBe(`${base}/v1/mcp`)
  })

  it('kioku install：非交互未传 --remove-conflicts 时阻塞冲突平台，加了参数后先清再接', async () => {
    const file = seedAgyLore()
    let text = ''
    const out = { write: (c) => (text += c) }
    const installEnv = { ...env, KIOKU_API_KEY_AGY: 'key-agy', KIOKU_API_KEY_PI: 'key-pi' }

    const code1 = await install(['--platforms', 'agy,pi', '--server-url', base, '-y'], {
      env: installEnv,
      cwd: dir,
      out,
      stdin: nonTtyStdin(),
    })
    expect(code1).toBe(1)
    expect(text).toContain('失败：Antigravity（存在冲突（Lore）')
    expect(text).toContain('已接入：pi')
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.lore).toBeDefined()

    text = ''
    const code2 = await install(
      ['--platforms', 'agy,pi', '--server-url', base, '-y', '--remove-conflicts'],
      {
        env: installEnv,
        cwd: dir,
        out,
        stdin: nonTtyStdin(),
      },
    )
    expect(code2).toBe(0)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.mcpServers.lore).toBeUndefined()
    expect(saved.mcpServers.kioku.url).toBe(`${base}/v1/mcp`)
  })

  it('panel 与 wizard：面板列出冲突并提供清理动作；接入前先清理冲突再签发访问密钥', async () => {
    const file = seedAgyLore()
    const row = await scanPlatform('agy', { env, cwd: dir, url: base })
    expect(row.conflicts).toHaveLength(1)
    const state = { server: { url: base, reachable: true, problem: null }, platforms: [row] }
    expect(renderPanel(state)).toContain('冲突 Lore')
    expect(actionsFor(state).map((a) => a.value)).toContain('clean')

    // 通过 wizard 的 connect 接入 agy 时，应先清理冲突，再调用 connectPlatforms
    const order = []
    const choices = ['connect', 'exit']
    const fakeUi = {
      isCancel: () => false,
      intro: () => {},
      outro: () => {},
      note: () => {},
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: { warn: () => {}, info: () => {}, error: () => {}, success: () => {} },
      select: async () => choices.shift(),
      multiselect: async () => ['agy'],
      confirm: async () => true,
    }
    const res = await wizard({
      ui: fakeUi,
      env,
      cwd: dir,
      out: { write: () => true },
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => ({
          server: { url: base, reachable: true, problem: null, needsSetup: false },
          platforms: [await scanPlatform('agy', { env, cwd: dir, url: base })],
        }),
        removeConflicts: async (items) => {
          order.push('removeConflicts')
          return Promise.all(items.map(async (i) => ({ item: i, ok: true, ...(await i.remove()) })))
        },
        connectPlatforms: async ({ ids }) => {
          order.push(`connect:${ids.join(',')}`)
          return ids.map((id) => ({ id, status: 'connected' }))
        },
        pluginSteps: async () => '',
      },
    })
    expect(res).toBe(0)
    expect(order).toEqual(['removeConflicts', 'connect:agy'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('wizard：选择 clean 动作可直接清理多个平台冲突；清理失败时不调用 connectPlatforms', async () => {
    const agyFile = seedAgyLore()
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
    const ccGuidance = join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md')
    writeFileSync(ccGuidance, '# lore')

    const cleanChoices = ['clean', 'exit']
    const fakeUi1 = {
      isCancel: () => false,
      intro: () => {},
      outro: () => {},
      note: () => {},
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: { warn: () => {}, info: () => {}, error: () => {}, success: () => {} },
      select: async () => cleanChoices.shift(),
      multiselect: async () => ['agy', 'claude-code'],
      confirm: async () => true,
    }
    await wizard({
      ui: fakeUi1,
      env,
      cwd: dir,
      out: { write: () => true },
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => ({
          server: { url: base, reachable: true, problem: null, needsSetup: false },
          platforms: [
            await scanPlatform('agy', { env, cwd: dir, url: base }),
            await scanPlatform('claude-code', { env, cwd: dir, url: base }),
          ],
        }),
      },
    })
    expect(JSON.parse(readFileSync(agyFile, 'utf8'))).toEqual({})
    expect(existsSync(ccGuidance)).toBe(false)

    // 清理失败时不签发访问密钥
    seedAgyLore()
    let connectedCalled = false
    const notes = []
    const failChoices = ['connect', 'exit']
    const fakeUi2 = {
      isCancel: () => false,
      intro: () => {},
      outro: () => {},
      note: (msg, title) => notes.push({ title, msg }),
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: { warn: () => {}, info: () => {}, error: () => {}, success: () => {} },
      select: async () => failChoices.shift(),
      multiselect: async () => ['agy'],
      confirm: async () => true,
    }
    await wizard({
      ui: fakeUi2,
      env,
      cwd: dir,
      out: { write: () => true },
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => ({
          server: { url: base, reachable: true, problem: null, needsSetup: false },
          platforms: [await scanPlatform('agy', { env, cwd: dir, url: base })],
        }),
        removeConflicts: async (items) =>
          items.map((i) => ({ item: i, ok: false, message: 'fail' })),
        connectPlatforms: async () => {
          connectedCalled = true
          return []
        },
        pluginSteps: async () => '',
      },
    })
    expect(connectedCalled).toBe(false)
    expect(notes.some((n) => n.title === '结果' && n.msg.includes('清理冲突没有全部成功'))).toBe(
      true,
    )

    // claude-connect：即使自动记忆已停用，存在冲突时仍先展示清理计划并卸载
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false }),
    )
    const ccGuidance2 = join(env.CLAUDE_CONFIG_DIR, 'lore-guidance.md')
    writeFileSync(ccGuidance2, '# lore')
    const ccNotes = []
    const ccChoices = ['claude-connect', 'exit']
    await wizard({
      ui: {
        isCancel: () => false,
        intro: () => {},
        outro: () => {},
        note: (msg, title) => ccNotes.push({ title, msg }),
        spinner: () => ({ start: () => {}, stop: () => {} }),
        log: { warn: () => {}, info: () => {}, error: () => {}, success: () => {} },
        select: async () => ccChoices.shift(),
        confirm: async () => true,
      },
      env,
      cwd: dir,
      out: { write: () => true },
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => ({
          server: { url: base, reachable: true, problem: null, needsSetup: false },
          platforms: [await scanPlatform('claude-code', { env, cwd: dir, url: base })],
        }),
        pluginSteps: async () => '',
      },
    })
    expect(ccNotes.some((n) => n.title === '计划' && n.msg.includes('清理冲突的记忆工具'))).toBe(
      true,
    )
    expect(existsSync(ccGuidance2)).toBe(false)
  })
})
