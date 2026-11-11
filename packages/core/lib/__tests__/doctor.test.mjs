import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { doctor } from '../doctor.mjs'

const KEY = 'kioku_test_key'
const WHO = {
  spaceId: '00000000-0000-4000-8000-000000000001',
  app: { id: 'a', slug: 'cc', name: 'Claude Code', runtimeFamily: 'claudecode' },
  scopes: {
    readLayers: ['core', 'persona', 'app', 'user'],
    writeLayers: ['app', 'user'],
    maxSensitivity: 'private',
    admin: false,
    credentials: 'use',
  },
}

let server
let base
let requests = []
let reply
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    const { status, headers = {}, body } = reply()
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body ?? {}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
beforeEach(() => {
  requests = []
  reply = () => ({ status: 200, body: WHO })
  dir = mkdtempSync(join(tmpdir(), 'kioku-doctor-'))
  env = { KIOKU_SERVER_URL: `${base}/`, KIOKU_API_KEY: KEY, CLAUDE_CONFIG_DIR: dir }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const settings = (value) => writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))
async function run(args = []) {
  let text = ''
  const code = await doctor(args, { env, out: { write: (chunk) => (text += chunk) } })
  return { code, text, lines: text.trimEnd().split('\n') }
}

describe('kioku doctor', () => {
  it('都配好时每项都是 ✓，访问密钥的权限用界面的说法', async () => {
    settings({ enabledPlugins: { 'kioku@kioku': true }, autoMemoryEnabled: false })
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/whoami')
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(result.lines).toEqual([
      `✓ 地址 ${base}`,
      '✓ 访问密钥可用：应用 Claude Code（cc），运行时 claudecode',
      '  读：通用、人格、应用、本人',
      '  写：应用、本人',
      '  最高敏感级：私密',
      '  凭据：取用',
      '✓ Claude Code 的 kioku 插件已启用',
      '✓ Claude Code 的自动记忆（auto memory）已停用（用户设置）',
    ])
    expect(result.text).not.toContain(KEY)
  })

  it('自动记忆还开着、插件没启用只提醒，不算有问题', async () => {
    settings({ enabledPlugins: { 'kioku@kioku': false, 'other@kioku': true } })
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(result.text).toContain('! 用户设置里没有启用 Claude Code 的 kioku 插件')
    expect(result.text).toContain('! Claude Code 的自动记忆（auto memory）还开着')
    expect(result.text).toContain('kioku setup claude-code')
  })

  it('会话里钩子配好了访问密钥文件就算插件在用；环境变量停用自动记忆也认', async () => {
    const file = join(dir, 'api-key')
    writeFileSync(file, KEY)
    env = { ...env, KIOKU_API_KEY: undefined, KIOKU_API_KEY_FILE: file, CLAUDECODE: '1' }
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = 'true'
    // 不写平台，按 CLAUDECODE 认
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.text).toContain('✓ Claude Code 的 kioku 插件已启用')
    expect(result.text).toContain('已停用（环境变量 CLAUDE_CODE_DISABLE_AUTO_MEMORY）')
  })

  it('认不出平台时只查地址与访问密钥', async () => {
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.text).toContain('✓ 访问密钥可用')
    expect(result.text).toContain('没有认出平台')
    expect(result.text).not.toContain('插件')
  })

  it('应用的运行时和平台对不上时提醒', async () => {
    reply = () => ({ status: 200, body: { ...WHO, app: { ...WHO.app, runtimeFamily: 'codex' } } })
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(result.text).toContain('! 这个应用的运行时不是 claudecode')
  })

  it('访问密钥无效、跳转、连不上、响应不对都是 ✗，退出码 1，平台的配置照查', async () => {
    settings({ autoMemoryEnabled: false })
    const cases = [
      [() => ({ status: 401, body: { error: 'x' } }), '✗ 访问密钥无效或已吊销'],
      [() => ({ status: 500, body: {} }), '✗ Kioku 返回 HTTP 500'],
      [() => ({ status: 200, body: { app: {} } }), '✗ Kioku 的响应格式不对'],
      [
        () => ({ status: 301, headers: { location: 'https://kioku.example.com/v1/whoami' } }),
        '✗ Kioku 返回了跳转（301），把地址改成跳转之后的地址（例如 https://kioku.example.com）',
      ],
    ]
    for (const [next, line] of cases) {
      reply = next
      const result = await run(['claude-code'])
      expect(result.code, line).toBe(1)
      expect(result.lines).toContain(line)
      expect(result.text).toContain('已停用（用户设置）')
    }
    env.KIOKU_SERVER_URL = 'http://127.0.0.1:1'
    const refused = await run(['claude-code'])
    expect(refused.code).toBe(1)
    expect(refused.text).toMatch(/✗ 无法连接 Kioku/)
  })

  it('没有配置、访问密钥格式不对时不发请求', async () => {
    for (const patch of [{ KIOKU_API_KEY: undefined }, { KIOKU_API_KEY: 'a b' }]) {
      env = { ...env, ...patch }
      const result = await run()
      expect(result.code).toBe(1)
      expect(result.lines[0]).toMatch(/^✗ /)
    }
    expect(requests).toHaveLength(0)
  })

  it('服务端给的名字里的控制字符不原样打印', async () => {
    reply = () => ({
      status: 200,
      body: { ...WHO, app: { ...WHO.app, name: '甲\n✓ 假的一行\u001b[2J' } },
    })
    const result = await run()
    expect(result.lines[1]).toBe('✓ 访问密钥可用：应用 甲 ✓ 假的一行 [2J（cc），运行时 claudecode')
  })

  it('设置文件坏了是 ✗', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ 坏的')
    const result = await run(['claude-code'])
    expect(result.code).toBe(1)
    expect(result.text).toMatch(/✗ .*不是 JSON 对象/)
  })
})
