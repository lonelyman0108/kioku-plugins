import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addCommand, getCommand, lsCommand, searchCommand } from '../commands/memory.ts'
import { KiokuFailure, UsageError, writeProfile } from '../core.ts'
import { resolveIdentity, writeCliPreferences } from '../identity.ts'
import { importMemories } from '../import.ts'
import type { Env } from '../types.ts'

const KEY = 'kioku_test_key'
const SCOPED_KEY = 'kioku_scoped'

let server: Server
let base: string
let lastRequests: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      lastRequests.push({ method: req.method ?? 'GET', url: `${url.pathname}${url.search}`, body })

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (url.pathname === '/v1/whoami') {
        return send(200, {
          app: { id: 'app-1', slug: 'cc', name: 'Claude Code', runtimeFamily: 'claudecode' },
          scopes: { readLayers: ['user', 'app', 'core'], writeLayers: ['app', 'user'] },
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/recall') {
        const query = String(body?.query ?? '')
        if (query === 'empty') return send(200, { candidates: [], subjects: [] })
        return send(200, {
          candidates: [
            {
              uri: 'user://preferences/reply_style',
              title: '回复风格偏好',
              layer: 'user',
              priority: 5,
              disclosure: '需要组织回复时读取',
              score: 0.91,
              via: ['semantic'],
              cues: [],
            },
          ],
          subjects: [],
        })
      }

      if (req.method === 'GET' && url.pathname === '/v1/memories') {
        const uri = url.searchParams.get('uri') ?? ''
        if (uri === 'user://preferences/reply_style') {
          return send(200, {
            id: 'mem-1',
            uri,
            title: '回复风格偏好',
            layer: 'user',
            sensitivity: 'private',
            provenance: 'curated',
            originScope: 'app:cc',
            content: '第一行保持简洁\n  - 保留缩进列表\n第三行不要截断：' + 'x'.repeat(230),
            priority: 5,
            disclosure: '需要组织回复时读取',
            glossary: ['回复风格'],
            validFrom: '2026-01-01T00:00:00Z',
            validTo: null,
            version: 3,
          })
        }
        if (uri === 'user://secrets/token') {
          return send(200, {
            id: 'mem-2',
            uri,
            title: '私密令牌备注',
            layer: 'user',
            sensitivity: 'secret',
            content: null,
            priority: 1,
            disclosure: null,
            glossary: [],
            version: 1,
          })
        }
        return send(404, { error: '记忆不存在或无权读取' })
      }

      if (req.method === 'GET' && url.pathname === '/v1/memories/children') {
        const of = url.searchParams.get('of') ?? ''
        const auth = req.headers.authorization ?? ''
        if (of === 'core' && auth === `Bearer ${SCOPED_KEY}`) {
          return send(403, { error: '没有权限读取通用归属' })
        }
        if (of === 'user') {
          return send(200, {
            parent: null,
            children: [
              {
                uri: 'user://preferences',
                exists: false,
                id: null,
                title: null,
                layer: null,
                sensitivity: null,
                priority: null,
                disclosure: null,
                childCount: 2,
              },
            ],
            truncated: false,
          })
        }
        if (of === 'user://preferences') {
          return send(200, {
            parent: null,
            children: [
              {
                uri: 'user://preferences/reply_style',
                exists: true,
                id: 'mem-1',
                title: '回复风格偏好',
                layer: 'user',
                sensitivity: 'private',
                priority: 5,
                disclosure: null,
                childCount: 0,
              },
            ],
            truncated: false,
          })
        }
        return send(200, { parent: null, children: [], truncated: false })
      }

      if (req.method === 'POST' && url.pathname === '/v1/memories') {
        const content = String(body?.content ?? '')
        if (content.includes('mock-secret-marker') && body?.plaintextOk !== true) {
          return send(400, {
            error: '正文里包含新增的疑似明文凭据',
            plaintext: [{ line: 2, kind: 'sk' }],
          })
        }
        return send(201, {
          id: 'mem-new',
          uri: body?.uri,
          title: body?.title ?? 'note',
          layer: String(body?.uri ?? '').split('://')[0],
          sensitivity: body?.sensitivity ?? 'internal',
          content,
          priority: body?.priority ?? 2,
          disclosure: body?.disclosure ?? null,
          glossary: [],
          version: 1,
        })
      }

      send(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

let dir: string
let env: Env

beforeEach(() => {
  lastRequests = []
  dir = mkdtempSync(join(tmpdir(), 'kioku-mem-'))
  env = {
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: join(dir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(dir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    KIOKU_CONFIG_DIR: join(dir, 'kioku'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    HERMES_HOME: join(dir, 'hermes'),
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function captureOut() {
  let text = ''
  return {
    stream: {
      isTTY: false,
      columns: 90,
      write(chunk: string | Uint8Array) {
        text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      },
    },
    read: () => text,
  }
}

describe('身份自动解析与切换（identity）', () => {
  it('支持显式 --platform、环境变量与唯一本机配置自动识别', async () => {
    await expect(resolveIdentity({ env })).rejects.toThrow(KiokuFailure)

    await writeProfile('pi', { url: base, key: KEY }, env)
    const single = await resolveIdentity({ env })
    expect(single.platform).toBe('pi')
    expect(single.config.key).toBe(KEY)

    await writeProfile('codex', { url: base, key: SCOPED_KEY }, env)
    await expect(
      resolveIdentity({ env, stdin: Readable.from([]), out: captureOut().stream }),
    ).rejects.toThrow('--platform')

    const explicit = await resolveIdentity({ platform: 'codex', env })
    expect(explicit.platform).toBe('codex')
    expect(explicit.config.key).toBe(SCOPED_KEY)

    await writeCliPreferences({ defaultPlatform: 'pi' }, env)
    const savedDefault = await resolveIdentity({ env })
    expect(savedDefault.platform).toBe('pi')
    expect(savedDefault.source).toBe('default:pi')

    const byEnv = await resolveIdentity({
      env: { ...env, KIOKU_SERVER_URL: base, KIOKU_API_KEY: KEY },
    })
    expect(byEnv.source).toBe('env')
  })
})

describe('日常记忆读写命令（search / get / ls / add）', () => {
  beforeEach(async () => {
    await writeProfile('codex', { url: base, key: KEY }, env)
  })

  it('search：格式化 Strata 结果框、空状态与 --json 输出', async () => {
    const out1 = captureOut()
    expect(await searchCommand(['回复风格', '--limit', '5'], { env, out: out1.stream })).toBe(0)
    expect(out1.read()).toContain('回复风格偏好')
    expect(out1.read()).toContain('user://preferences/reply_style')
    expect(out1.read()).toContain('0.91')
    expect(lastRequests.at(-1)?.body).toEqual({ query: '回复风格', limit: 5 })

    const outEmpty = captureOut()
    expect(await searchCommand(['empty'], { env, out: outEmpty.stream })).toBe(0)
    expect(outEmpty.read()).toContain('暂无匹配记忆')

    const outJson = captureOut()
    expect(await searchCommand(['回复风格', '--json'], { env, out: outJson.stream })).toBe(0)
    const parsed = JSON.parse(outJson.read()) as { candidates: Array<{ uri: string }> }
    expect(parsed.candidates[0].uri).toBe('user://preferences/reply_style')
  })

  it('get：完整保留多行与缩进正文（不截断于 200 字），坐标置于底部卡片区域', async () => {
    const out = captureOut()
    expect(await getCommand(['user://preferences/reply_style'], { env, out: out.stream })).toBe(0)
    const text = out.read()
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('  - 保留缩进列表')
    expect(text).toContain('x'.repeat(40))
    expect(text.lastIndexOf('user://preferences/reply_style')).toBeGreaterThan(
      text.indexOf('回复风格偏好'),
    )

    const secretOut = captureOut()
    expect(await getCommand(['user://secrets/token'], { env, out: secretOut.stream })).toBe(0)
    expect(secretOut.read()).toContain('机密记忆正文不随读取返回')

    await expect(
      getCommand(['user://missing/one'], { env, out: captureOut().stream }),
    ).rejects.toThrow(KiokuFailure)
  })

  it('ls：无参按地层顺序展示四类归属（部分无权限时降级提示），有参列出子节点', async () => {
    const allOut = captureOut()
    expect(await lsCommand([], { env, out: allOut.stream })).toBe(0)
    const full = allOut.read()
    expect(full.indexOf('本人')).toBeLessThan(full.indexOf('应用'))
    expect(full.indexOf('应用')).toBeLessThan(full.indexOf('人格'))
    expect(full.indexOf('人格')).toBeLessThan(full.indexOf('通用'))
    expect(full).toContain('user://preferences')
    expect(full).toContain('下级 2 项')

    const subOut = captureOut()
    expect(await lsCommand(['user://preferences/'], { env, out: subOut.stream })).toBe(0)
    expect(subOut.read()).toContain('回复风格偏好')
    expect(lastRequests.at(-1)?.url).toContain('of=user%3A%2F%2Fpreferences')

    await writeProfile('pi', { url: base, key: SCOPED_KEY }, env)
    const scopedOut = captureOut()
    expect(await lsCommand(['--platform', 'pi'], { env, out: scopedOut.stream })).toBe(0)
    expect(scopedOut.read()).toContain('无权读取')
  })

  it('add：支持参数与管道 stdin，遇到明文拦阻时绝不回显密钥且支持 --plaintext-ok 放行', async () => {
    const out1 = captureOut()
    expect(
      await addCommand(
        [
          'user://notes/pipe_test',
          '--title',
          '管道测试',
          '--sensitivity',
          '私密',
          '--priority',
          '4',
        ],
        {
          env,
          out: out1.stream,
          stdin: Object.assign(Readable.from([Buffer.from('通过管道写入的内容')]), {
            isTTY: false,
          }),
        },
      ),
    ).toBe(0)
    expect(out1.read()).toContain('已创建记忆')
    expect(lastRequests.at(-1)?.body).toMatchObject({
      uri: 'user://notes/pipe_test',
      title: '管道测试',
      content: '通过管道写入的内容',
      sensitivity: 'private',
      priority: 4,
    })

    const blockedOut = captureOut()
    const secretSample = 'line1\nvalue = mock-secret-marker\n'
    const codeBlocked = await addCommand(['user://notes/secret_check', '--content', secretSample], {
      env,
      out: blockedOut.stream,
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
    })
    expect(codeBlocked).toBe(1)
    expect(blockedOut.read()).toContain('正文第 2 行：sk')
    expect(blockedOut.read()).toContain('--plaintext-ok')
    expect(blockedOut.read()).not.toContain('mock-secret-marker')

    const retryOut = captureOut()
    const codeOk = await addCommand(
      ['user://notes/secret_check', '--content', secretSample, '--plaintext-ok'],
      {
        env,
        out: retryOut.stream,
        stdin: Object.assign(Readable.from([]), { isTTY: false }),
      },
    )
    expect(codeOk).toBe(0)
    expect(lastRequests.at(-1)?.body?.plaintextOk).toBe(true)
    expect(lastRequests.at(-1)?.body?.allowPlaintext).toBeUndefined()

    await expect(
      addCommand(['invalid-uri', '--content', 'abc'], { env, out: captureOut().stream }),
    ).rejects.toThrow(UsageError)
  })

  it('import：支持 -y 短参数免确认写入', async () => {
    const claudeMemDir = join(dir, 'claude/projects/-x-code-demo/memory')
    mkdirSync(claudeMemDir, { recursive: true })
    writeFileSync(
      join(claudeMemDir, 'prefs.md'),
      '---\nname: prefs\nmetadata:\n  node_type: memory\n  type: user\n---\n\n使用 pnpm\n',
    )
    const out = captureOut()
    const code = await importMemories(['--from', 'claude-code', '-y'], {
      env: { ...env, KIOKU_SERVER_URL: base, KIOKU_API_KEY: KEY },
      out: out.stream,
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
    })
    expect(code).toBe(0)
    expect(out.read()).toContain('写入 1 条')
  })
})
