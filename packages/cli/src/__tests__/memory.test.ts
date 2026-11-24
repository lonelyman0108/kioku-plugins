import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addCommand,
  bootCommand,
  deleteCommand,
  editCommand,
  getCommand,
  lsCommand,
  parseEditorCommand,
  searchCommand,
} from '../commands/memory.ts'
import { KiokuFailure, UsageError, writeProfile } from '../core.ts'
import { resolveIdentity, writeCliPreferences } from '../identity.ts'
import { importMemories } from '../import.ts'
import { main } from '../index.ts'
import type { Env } from '../types.ts'

const KEY = 'kioku_test_key'
const SCOPED_KEY = 'kioku_scoped'

interface RecordedRequest {
  method: string
  url: string
  body: Record<string, unknown> | null
  tool?: string
  args?: Record<string, unknown>
}

let server: Server
let base: string
let lastRequests: RecordedRequest[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return send(200, { status: 'ok', api: 3, version: '2.0.0' })
      }

      const mcpParams =
        url.pathname === '/v1/mcp'
          ? (body?.params as { name?: string; arguments?: Record<string, unknown> } | undefined)
          : undefined
      lastRequests.push({
        method: req.method ?? 'GET',
        url: `${url.pathname}${url.search}`,
        body,
        ...(mcpParams?.name ? { tool: mcpParams.name } : {}),
        ...(mcpParams?.arguments ? { args: mcpParams.arguments } : {}),
      })

      const rpcId = body?.id ?? 1
      const sendMcp = (structured: unknown, text = 'ok') =>
        send(200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            content: [{ type: 'text', text }],
            ...(structured !== undefined ? { structuredContent: structured } : {}),
          },
        })
      const sendMcpError = (status: number, error: string) =>
        send(200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            isError: true,
            content: [{ type: 'text', text: error }],
            structuredContent: { status, error },
          },
        })

      if (url.pathname === '/v1/whoami') {
        return send(200, {
          accountName: 'owner',
          key: {
            id: 'key-1',
            name: 'Claude Code',
            prefix: 'kioku_te',
            runtimeFamily: 'claudecode',
            envs: [],
            allowedRealms: null,
            canWrite: true,
            canResolveCredentials: false,
          },
          client: {
            slug: 'cc',
            name: 'Claude Code',
            runtimeFamily: 'claudecode',
          },
          primaryCircle: { slug: 'default', name: 'Kioku', kind: 'personal' },
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/recall') {
        const query = String(body?.query ?? '')
        if (query === 'empty') return send(200, { candidates: [] })
        return send(200, {
          candidates: [
            {
              entryId: 'e1',
              shortId: 'm-234567',
              title: '回复风格偏好',
              kind: 'entry',
              isPinned: true,
              envs: ['mac'],
              realms: ['work'],
              projects: ['kioku'],
              runtimes: ['claudecode'],
              disclosure: '需要组织回复时读取',
              score: 0.91,
              via: ['semantic', 'link'],
              cues: ['风格', '结论优先'],
            },
          ],
        })
      }

      if (req.method === 'GET' && url.pathname === '/v1/boot') {
        return send(200, {
          entries: [
            {
              shortId: 'm-234567',
              title: '工作原则',
              kind: 'entry',
              content: '代码规范优先',
            },
          ],
          episodes: [
            {
              shortId: 'm-ep0001',
              title: '昨日发布复盘',
              content: '完成迁移并通过集成测试',
              createdAt: '2026-01-02T00:00:00Z',
            },
          ],
          omitted: ['m-888888'],
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/mcp') {
        const toolName = mcpParams?.name
        const args = mcpParams?.arguments ?? {}

        if (toolName === 'kioku_get') {
          const id = String(args.id ?? '')
          if (id === 'm-234567' || id === '回复风格偏好') {
            return sendMcp({
              entry: {
                id: 'mem-1',
                shortId: 'm-234567',
                kind: 'entry',
                title: '回复风格偏好',
                content: '第一行保持简洁\n  - 保留缩进列表\n第三行不要截断：' + 'x'.repeat(230),
                disclosure: '需要组织回复时读取',
                isPinned: true,
                envs: ['mac'],
                realms: ['work'],
                projects: ['kioku'],
                runtimes: ['claudecode'],
                topics: ['prefs'],
                validTo: null,
                version: 3,
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-02T00:00:00Z',
              },
              outboundLinks: [
                { shortId: 'm-345678', title: '关联规范', kind: 'entry', direction: 'outgoing' },
              ],
              backlinks: [
                { shortId: 'm-456789', title: '项目约定', kind: 'entry', direction: 'incoming' },
              ],
              credentialRefs: [
                { slug: 'gh-token', field: null, available: true, label: 'GitHub 令牌' },
                { slug: 'db-pass', field: 'password', available: false, label: null },
              ],
            })
          }
          if (id === 'm-textonly') {
            return sendMcp(undefined, '纯文本回退记忆正文')
          }
          return sendMcpError(404, '记忆不存在或无权读取')
        }

        if (toolName === 'kioku_browse') {
          const groupBy = String(args.group_by ?? 'topic')
          const auth = req.headers.authorization ?? ''
          if (groupBy === 'realm' && auth === `Bearer ${SCOPED_KEY}`) {
            return sendMcpError(403, '没有权限读取该场域')
          }
          if (args.project === 'empty') {
            return sendMcp({ groupBy, groups: [], truncated: false })
          }
          return sendMcp({
            groupBy,
            groups: [
              {
                key: groupBy === 'kind' ? 'entry' : 'prefs',
                label: groupBy === 'realm' ? 'work' : 'prefs',
                count: 1,
                items: [
                  {
                    shortId: 'm-234567',
                    title: '回复风格偏好',
                    kind: 'entry',
                    isPinned: true,
                    topics: ['prefs'],
                    envs: ['mac'],
                    realms: ['work'],
                    projects: ['kioku'],
                    disclosure: null,
                  },
                ],
              },
            ],
            truncated: args.limit === 1,
          })
        }

        if (toolName === 'kioku_create') {
          return sendMcp({
            entry: {
              id: 'mem-new',
              shortId: 'm-new234',
              kind: 'entry',
              title: String(args.title ?? 'm-new234'),
              content: String(args.content ?? ''),
              disclosure: (args.disclosure as string | undefined) ?? null,
              isPinned: Boolean(args.is_pinned),
              envs: Array.isArray(args.envs) ? args.envs : [],
              realms: Array.isArray(args.realms) ? args.realms : [],
              projects: Array.isArray(args.projects) ? args.projects : [],
              runtimes: Array.isArray(args.runtimes) ? args.runtimes : [],
              topics: Array.isArray(args.topics) ? args.topics : [],
              validTo: (args.valid_to as string | undefined) ?? null,
              version: 1,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
            outboundLinks: [],
            backlinks: [],
            credentialRefs: [],
          })
        }

        if (toolName === 'kioku_update') {
          return sendMcp({
            entry: {
              id: 'mem-1',
              shortId: 'm-234567',
              kind: 'entry',
              title: String(args.title ?? '回复风格偏好'),
              content: String(args.content ?? '旧正文'),
              disclosure: args.disclosure === undefined ? null : (args.disclosure as string | null),
              isPinned: args.is_pinned === undefined ? true : Boolean(args.is_pinned),
              envs: Array.isArray(args.envs) ? args.envs : [],
              realms: Array.isArray(args.realms) ? args.realms : [],
              projects: Array.isArray(args.projects) ? args.projects : [],
              runtimes: Array.isArray(args.runtimes) ? args.runtimes : [],
              topics: Array.isArray(args.topics) ? args.topics : [],
              validTo: args.valid_to === undefined ? null : (args.valid_to as string | null),
              version: 4,
            },
            outboundLinks: [],
            backlinks: [],
            credentialRefs: [],
          })
        }

        if (toolName === 'kioku_delete') {
          return sendMcp({ deleted: true, id: String(args.id ?? '') })
        }

        return sendMcpError(400, `未知工具 ${String(toolName)}`)
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

describe('日常记忆读写命令（search / get / ls / add / edit / delete / boot）', () => {
  beforeEach(async () => {
    await writeProfile('codex', { url: base, key: KEY }, env)
  })

  it('search：格式化结果框、短 ID、场景标签、常驻标记、命中途径、线索与 --json 输出', async () => {
    const out1 = captureOut()
    expect(
      await searchCommand(
        ['回复风格', '--limit', '5', '--env', 'mac', '--realm', 'work', '--project', 'kioku'],
        { env, out: out1.stream },
      ),
    ).toBe(0)
    const text = out1.read()
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('m-234567')
    expect(text).toContain('正式记忆 · 常驻')
    expect(text).toContain('触发场景：需要组织回复时读取')
    expect(text).toContain('项目 kioku')
    expect(text).toContain('环境 mac')
    expect(text).toContain('场域 work')
    expect(text).toContain('语义/双链')
    expect(text).toContain('0.91')
    expect(text).toContain('风格、结论优先')
    expect(lastRequests.at(-1)?.url).toBe('/v1/recall')
    expect(lastRequests.at(-1)?.body).toEqual({
      query: '回复风格',
      limit: 5,
      env: 'mac',
      realm: 'work',
      project: 'kioku',
    })

    const outEmpty = captureOut()
    expect(await searchCommand(['empty'], { env, out: outEmpty.stream })).toBe(0)
    expect(outEmpty.read()).toContain('暂无匹配记忆')

    const outJson = captureOut()
    expect(await searchCommand(['回复风格', '--json'], { env, out: outJson.stream })).toBe(0)
    const parsed = JSON.parse(outJson.read()) as { candidates: Array<{ shortId: string }> }
    expect(parsed.candidates[0].shortId).toBe('m-234567')
  })

  it('get：通过 MCP kioku_get 渲染属性、正文、正反双链与凭据引用状态，支持文本回退与 --json', async () => {
    const out = captureOut()
    expect(await getCommand(['m-234567'], { env, out: out.stream })).toBe(0)
    const text = out.read()
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('短 ID：m-234567 · 类型：正式记忆 · 常驻 · 版本：v3') // lint-comments: allow
    expect(text).toContain('项目：kioku')
    expect(text).toContain('环境：mac')
    expect(text).toContain('场域：work')
    expect(text).toContain('客户端：claudecode')
    expect(text).toContain('主题：prefs')
    expect(text).toContain('触发场景：需要组织回复时读取')
    expect(text).toContain('  - 保留缩进列表')
    expect(text).toContain('x'.repeat(40))
    expect(text).toContain('→ m-345678  关联规范')
    expect(text).toContain('← m-456789  项目约定')
    expect(text).toContain('{{cred:gh-token}}')
    expect(text).toContain('可用')
    expect(text).toContain('{{cred:db-pass#password}}')
    expect(text).toContain('不可用')
    expect(lastRequests.at(-1)).toMatchObject({
      url: '/v1/mcp',
      tool: 'kioku_get',
      args: { id: 'm-234567' },
    })

    const fallbackOut = captureOut()
    expect(await getCommand(['m-textonly'], { env, out: fallbackOut.stream })).toBe(0)
    expect(fallbackOut.read()).toContain('纯文本回退记忆正文')

    const jsonOut = captureOut()
    expect(await getCommand(['m-234567', '--json'], { env, out: jsonOut.stream })).toBe(0)
    const parsed = JSON.parse(jsonOut.read()) as { entry: { shortId: string } }
    expect(parsed.entry.shortId).toBe('m-234567')

    await expect(getCommand(['m-404040'], { env, out: captureOut().stream })).rejects.toThrow(
      KiokuFailure,
    )
  })

  it('ls：通过 MCP kioku_browse 按维度分组浏览，支持中文位置维度与扁平筛选参数', async () => {
    const defaultOut = captureOut()
    expect(await lsCommand([], { env, out: defaultOut.stream })).toBe(0)
    const text = defaultOut.read()
    expect(text).toContain('记忆目录（按 topic 分组）')
    expect(text).toContain('prefs（1）')
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('常驻')
    expect(text).toContain('m-234567')
    expect(lastRequests.at(-1)).toMatchObject({
      url: '/v1/mcp',
      tool: 'kioku_browse',
      args: { group_by: 'topic' },
    })

    const filteredOut = captureOut()
    expect(
      await lsCommand(
        [
          '场域',
          '--kind',
          'entry',
          '--topic',
          'prefs',
          '--project',
          'kioku',
          '--env',
          'mac',
          '--realm',
          'work',
          '--pinned',
          '--query',
          '回复',
          '--limit',
          '1',
        ],
        { env, out: filteredOut.stream },
      ),
    ).toBe(0)
    const filteredText = filteredOut.read()
    expect(filteredText).toContain('按 realm 分组')
    expect(filteredText).toContain('结果已截断')
    expect(lastRequests.at(-1)).toMatchObject({
      tool: 'kioku_browse',
      args: {
        group_by: 'realm',
        kind: 'entry',
        topic: 'prefs',
        project: 'kioku',
        env: 'mac',
        realm: 'work',
        pinned_only: true,
        query: '回复',
        limit: 1,
      },
    })

    const emptyOut = captureOut()
    expect(await lsCommand(['--project', 'empty'], { env, out: emptyOut.stream })).toBe(0)
    expect(emptyOut.read()).toContain('暂无可见记忆')

    await writeProfile('pi', { url: base, key: SCOPED_KEY }, env)
    await expect(
      lsCommand(['realm', '--platform', 'pi'], { env, out: captureOut().stream }),
    ).rejects.toThrow('没有权限读取该场域')

    await expect(lsCommand(['invalid-dim'], { env, out: captureOut().stream })).rejects.toThrow(
      UsageError,
    )
  })

  it('add / edit / delete / boot：经 MCP 与 /v1/boot 完成日常读写，支持 --version', async () => {
    const out1 = captureOut()
    expect(
      await addCommand(
        [
          '管道测试',
          '--topic',
          'notes,ci',
          '--env',
          'mac',
          '--realm',
          'work',
          '--project',
          'kioku',
          '--runtime',
          'claudecode',
          '--pinned',
          '--disclosure',
          '写 CI 配置时参考',
          '--valid-to',
          '2026-12-31T23:59:00+08:00',
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
    expect(out1.read()).toContain('m-new234')
    expect(lastRequests.at(-1)).toMatchObject({
      url: '/v1/mcp',
      tool: 'kioku_create',
      args: {
        title: '管道测试',
        content: '通过管道写入的内容',
        topics: ['notes', 'ci'],
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        runtimes: ['claudecode'],
        is_pinned: true,
        disclosure: '写 CI 配置时参考',
        valid_to: '2026-12-31T23:59:00+08:00',
      },
    })

    await expect(
      addCommand(['标题', '--circle', 'personal', '--content', 'abc'], {
        env,
        out: captureOut().stream,
      }),
    ).rejects.toThrow(UsageError)
    await expect(
      addCommand(['位置标题', '--title', '参数标题', '--content', 'abc'], {
        env,
        out: captureOut().stream,
      }),
    ).rejects.toThrow(UsageError)

    const editOut = captureOut()
    expect(
      await editCommand(
        [
          'm-234567',
          '--title',
          '新标题',
          '--env',
          'clear',
          '--unpinned',
          '--disclosure',
          'clear',
          '--valid-to',
          'clear',
          '--expected-version',
          '3',
        ],
        { env, out: editOut.stream },
      ),
    ).toBe(0)
    expect(editOut.read()).toContain('已更新记忆')
    expect(editOut.read()).toContain('v4') // lint-comments: allow
    expect(lastRequests.at(-1)).toMatchObject({
      url: '/v1/mcp',
      tool: 'kioku_update',
      args: {
        id: 'm-234567',
        title: '新标题',
        envs: [],
        is_pinned: false,
        disclosure: null,
        valid_to: null,
        expected_version: 3,
      },
    })

    await expect(
      editCommand(['m-234567', '--pinned', '--unpinned'], { env, out: captureOut().stream }),
    ).rejects.toThrow(UsageError)
    await expect(
      editCommand(['m-234567'], {
        env,
        out: captureOut().stream,
        stdin: { isTTY: false } as never,
      }),
    ).rejects.toThrow(UsageError)

    await expect(
      deleteCommand(['m-234567'], {
        env,
        out: captureOut().stream,
        stdin: { isTTY: false } as never,
      }),
    ).rejects.toThrow('--yes')

    const delOut = captureOut()
    expect(
      await deleteCommand(['m-234567', '--yes', '--expected-version', '4'], {
        env,
        out: delOut.stream,
      }),
    ).toBe(0)
    expect(delOut.read()).toContain('已删除记忆')
    expect(lastRequests.at(-1)).toMatchObject({
      url: '/v1/mcp',
      tool: 'kioku_delete',
      args: { id: 'm-234567', expected_version: 4 },
    })

    const bootOut = captureOut()
    expect(await bootCommand(['--project', 'kioku'], { env, out: bootOut.stream })).toBe(0)
    const bootText = bootOut.read()
    expect(bootText).toContain('常驻记忆（1）')
    expect(bootText).toContain('代码规范优先')
    expect(bootText).toContain('近期会话摘要（1）')
    expect(bootText).toContain('昨日发布复盘')
    expect(bootText).toContain('字数预算外（1）')
    expect(bootText).toContain('m-888888')
    expect(lastRequests.at(-1)?.url).toBe('/v1/boot?project=kioku')

    expect(parseEditorCommand('"/Applications/VS Code.app/code" --wait')).toEqual([
      '/Applications/VS Code.app/code',
      '--wait',
    ])

    let verOut = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      verOut += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      expect(await main(['--version'])).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    expect(verOut.trim()).toMatch(/^\d+\.\d+\.\d+/)
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
