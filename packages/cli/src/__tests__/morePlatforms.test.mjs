import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { doctor } from '../doctor.ts'
import { KiokuFailure } from '../core.ts'
import { PLATFORMS } from '../platforms.ts'
import { setup } from '../setup.ts'

const KEY = 'kioku_test_key'

let server
let base
let whoFamily = 'opencode'
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        primaryCircle: {
          id: '00000000-0000-4000-8000-000000000001',
          slug: 'personal',
          name: '个人圈',
          kind: 'personal',
        },
        linkedCircles: [],
        client: {
          id: 'a',
          circleId: '00000000-0000-4000-8000-000000000001',
          slug: whoFamily,
          name: whoFamily,
          runtimeFamily: whoFamily,
        },
        persona: null,
        scopes: {
          readKinds: ['entry', 'fact', 'episode'],
          writeKinds: ['entry'],
          maxSensitivity: 'private',
          credentials: 'none',
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
  dir = mkdtempSync(join(tmpdir(), 'kioku-more-platforms-'))
  env = {
    HOME: join(dir, 'home'),
    KIOKU_CONFIG_DIR: join(dir, 'kioku'),
    OPENCODE_CONFIG_DIR: join(dir, 'opencode'),
    GEMINI_CLI_HOME: join(dir, 'gemini-home'),
    AGY_HOME: join(dir, 'agy'),
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(command, args, { key = KEY } = {}) {
  let text = ''
  const io = {
    env,
    cwd: dir,
    out: { write: (chunk) => (text += chunk) },
    readKey: async () => key,
    login: null,
  }
  return { code: await command(args, io), text }
}

describe('opencode / gemini / agy 接入与检查', () => {
  it('kioku setup opencode 与 doctor opencode：写配置、--dry-run、损坏拒绝、--undo 不留残留', async () => {
    whoFamily = 'opencode'
    const dry = await run(setup, ['opencode', '--server-url', base, '--dry-run'])
    expect(dry.text).toContain('没有写入（--dry-run）')
    expect(existsSync(join(dir, 'opencode', 'opencode.json'))).toBe(false)

    const res = await run(setup, ['opencode', '--server-url', base])
    expect(res.code).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'opencode', 'opencode.json'), 'utf8')).plugin).toEqual(
      ['@kioku-memory/plugin-opencode'],
    )
    expect(await PLATFORMS.opencode.status({ env, cwd: dir })).toEqual({
      plugin: true,
      memory: 'none',
    })

    // 项目里的 mcp.kioku 覆盖提醒
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify({ mcp: { kioku: { type: 'remote' } } }),
    )
    const doc = await run(doctor, ['opencode'])
    expect(doc.code).toBe(0)
    expect(doc.text).toContain('✓ OpenCode 里登记了 kioku 插件')
    expect(doc.text).toContain('mcp.kioku')

    const undone = await run(setup, ['opencode', '--undo'])
    expect(undone.code).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'opencode', 'opencode.json'), 'utf8'))).toEqual({})
    expect(existsSync(join(dir, 'kioku', 'opencode.json'))).toBe(false)

    // 坏配置在 --undo 时也应先报错且不动文件
    writeFileSync(join(dir, 'opencode', 'opencode.json'), JSON.stringify({ plugin: 'not-array' }))
    await expect(run(setup, ['opencode', '--undo'])).rejects.toThrow(KiokuFailure)
  })

  it('kioku setup gemini 与 doctor gemini：配置 mcpServers.kioku（httpUrl）、备份不漏访问密钥、--undo 保住用户空 mcpServers', async () => {
    whoFamily = 'gemini'
    mkdirSync(join(dir, 'gemini-home', '.gemini', 'extensions', 'kioku'), { recursive: true })
    writeFileSync(
      join(dir, 'gemini-home', '.gemini', 'extensions', 'kioku', 'gemini-extension.json'),
      JSON.stringify({ name: 'kioku' }),
    )
    const settingsPath = join(dir, 'gemini-home', '.gemini', 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'Default', excludeTools: ['run_shell_command'] }),
    )

    const res = await run(setup, ['gemini', '--server-url', base])
    expect(res.code).toBe(0)
    expect(await PLATFORMS.gemini.status({ env, cwd: dir })).toEqual({
      plugin: true,
      memory: 'off',
    })
    // 第一次改造原文件不包含密钥，可备份；换密钥再改时不把旧密钥写入备份
    expect(readFileSync(`${settingsPath}.kioku-backup`, 'utf8')).not.toContain(KEY)
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'Default',
        mcpServers: {
          kioku: {
            httpUrl: `${base}/v1/mcp`,
            headers: { Authorization: 'Bearer kioku_old_secret' },
          },
        },
        excludeTools: ['save_memory'],
      }),
    )
    await run(setup, ['gemini', '--undo'])
    expect(readFileSync(`${settingsPath}.kioku-backup`, 'utf8')).not.toContain('kioku_old_secret')

    // 空 mcpServers 时 --undo 不无端删除用户键
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }))
    const noopUndo = await run(setup, ['gemini', '--undo'])
    expect(noopUndo.text).toContain('不用改')
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ mcpServers: {} })

    expect(await PLATFORMS.gemini.status({ env, cwd: dir })).toEqual({
      plugin: true,
      memory: 'on',
    })
  })

  it('kioku setup agy 与 doctor agy：配置 mcp_config.json（Streamable HTTP）、轮换密钥不留旧密钥备份', async () => {
    whoFamily = 'agy'
    mkdirSync(join(dir, 'agy', 'plugins', 'kioku'), { recursive: true })
    writeFileSync(
      join(dir, 'agy', 'plugins', 'kioku', 'plugin.json'),
      JSON.stringify({ name: 'kioku' }),
    )
    const mcpPath = join(dir, 'agy', 'mcp_config.json')
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))

    const res = await run(setup, ['agy', '--server-url', base])
    expect(res.code).toBe(0)
    const mcpCfg = JSON.parse(readFileSync(mcpPath, 'utf8'))
    expect(mcpCfg).toEqual({
      mcpServers: {
        other: { command: 'x' },
        kioku: { url: `${base}/v1/mcp`, headers: { Authorization: `Bearer ${KEY}` } },
      },
    })
    expect(await PLATFORMS.agy.status({ env, cwd: dir })).toEqual({
      plugin: true,
      memory: 'none',
    })

    const doc = await run(doctor, ['agy'])
    expect(doc.code).toBe(0)
    expect(doc.text).toContain('✓ Antigravity 已安装 kioku 插件')

    await run(setup, ['agy', '--undo'])
    expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual({
      mcpServers: { other: { command: 'x' } },
    })

    // 缺少 url 时 doctor 准确提醒而不是报错崩溃
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { kioku: { httpUrl: base } } }))
    const warnDoc = await run(doctor, ['agy'])
    expect(warnDoc.text).toContain('缺少 url')

    // 原配置含其他服务的 Bearer 密钥时不落 .kioku-backup
    rmSync(`${mcpPath}.kioku-backup`, { force: true })
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          other: {
            url: 'http://127.0.0.1:9/mcp',
            headers: { Authorization: 'Bearer other_secret' },
          },
        },
      }),
    )
    const secretSafe = await run(setup, ['agy', '--server-url', base])
    expect(secretSafe.code).toBe(0)
    expect(existsSync(`${mcpPath}.kioku-backup`)).toBe(false)
  })
})
