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
  transferCommand,
} from '../commands/memory.ts'
import { KiokuFailure, UsageError, writeProfile } from '../core.ts'
import { resolveIdentity, writeCliPreferences } from '../identity.ts'
import { importMemories } from '../import.ts'
import { main } from '../index.ts'
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
          primaryCircle: { id: 'c1', slug: 'personal', name: '个人圈', kind: 'personal' },
          linkedCircles: [],
          client: {
            id: 'app-1',
            circleId: 'c1',
            slug: 'cc',
            name: 'Claude Code',
            runtimeFamily: 'claudecode',
          },
          persona: null,
          scopes: { readKinds: ['entry', 'fact', 'episode'], writeKinds: ['entry'] },
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/recall') {
        const query = String(body?.query ?? '')
        if (query === 'empty') return send(200, { candidates: [], subjects: [] })
        return send(200, {
          candidates: [
            {
              entryId: 'e1',
              shortId: 'm-234567',
              title: '回复风格偏好',
              circleId: 'c1',
              circleSlug: 'personal',
              kind: 'entry',
              matchedWhen: { realm: ['work'] },
              otherVariantsCount: 1,
              priority: 5,
              disclosure: '需要组织回复时读取',
              score: 0.91,
              via: ['semantic'],
              cues: ['风格', '结论优先'],
            },
          ],
          subjects: [
            {
              role: 'sender',
              name: 'Alice',
              facts: [
                { shortId: 'm-fact01', content: '使用 pnpm', updatedAt: '2026-01-01T00:00:00Z' },
              ],
            },
          ],
        })
      }

      if (req.method === 'GET' && url.pathname === '/v1/entries') {
        const id = url.searchParams.get('id') ?? ''
        const allVariants = url.searchParams.get('allVariants') === 'true'
        if (id === 'm-234567' || id === '回复风格偏好' || id === 'user://preferences/reply_style') {
          const baseVariant = {
            id: 'var-1',
            when: {},
            whenSignature: '{}',
            sortOrder: 0,
            content: '第一行保持简洁\n  - 保留缩进列表\n第三行不要截断：' + 'x'.repeat(230),
            updatedAt: '2026-01-01T00:00:00Z',
          }
          const workVariant = {
            id: 'var-2',
            when: { realm: ['work'] },
            whenSignature: '{"realm":["work"]}',
            sortOrder: 1,
            content: '工作场景下先给结论。',
            updatedAt: '2026-01-02T00:00:00Z',
          }
          return send(200, {
            id: 'mem-1',
            shortId: 'm-234567',
            circleId: 'c1',
            circleSlug: 'personal',
            kind: 'entry',
            title: '回复风格偏好',
            sensitivity: 'private',
            provenance: 'owner',
            originScope: 'app:cc',
            topics: ['prefs'],
            realms: allVariants ? ['work'] : [],
            priority: 5,
            disclosure: '需要组织回复时读取',
            glossary: ['回复风格'],
            validFrom: '2026-01-01T00:00:00Z',
            validTo: null,
            version: 3,
            variants: allVariants ? [baseVariant, workVariant] : [baseVariant],
            otherVariants: allVariants
              ? []
              : [{ when: { realm: ['work'] }, whenSignature: '{"realm":["work"]}' }],
            links: [
              {
                shortId: 'm-345678',
                title: '关联规范',
                circleId: 'c1',
                circleSlug: 'personal',
                kind: 'entry',
                sensitivity: 'internal',
                direction: 'outgoing',
                sourceVariantId: 'var-1',
              },
            ],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          })
        }
        if (id === 'm-999999') {
          return send(200, {
            id: 'mem-2',
            shortId: 'm-999999',
            circleId: 'c1',
            circleSlug: 'personal',
            kind: 'entry',
            title: '私密令牌备注',
            sensitivity: 'secret',
            provenance: 'owner',
            originScope: 'personal',
            topics: [],
            realms: [],
            priority: 1,
            disclosure: null,
            glossary: [],
            validFrom: '2026-01-01T00:00:00Z',
            validTo: null,
            version: 1,
            variants: [
              {
                id: 'v-sec',
                when: {},
                whenSignature: '{}',
                sortOrder: 0,
                content: null,
                updatedAt: '2026-01-01T00:00:00Z',
              },
            ],
            otherVariants: [],
            links: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          })
        }
        if (id === 'm-secok2') {
          return send(200, {
            id: 'mem-3',
            shortId: 'm-secok2',
            circleId: 'c1',
            circleSlug: 'personal',
            kind: 'entry',
            title: '已解密机密记忆',
            sensitivity: 'secret',
            version: 1,
            variants: [
              {
                id: 'v-sec2',
                when: {},
                whenSignature: '{}',
                sortOrder: 0,
                content: 'decrypted-secret-content',
              },
            ],
          })
        }
        return send(404, { error: '记忆不存在或无权读取' })
      }

      if (req.method === 'PATCH' && url.pathname === '/v1/entries') {
        return send(200, {
          id: 'mem-1',
          shortId: 'm-234567',
          circleId: 'c1',
          circleSlug: 'personal',
          kind: 'entry',
          title: body?.title ?? '回复风格偏好',
          sensitivity: body?.sensitivity ?? 'private',
          priority: body?.priority ?? 5,
          disclosure: body?.disclosure ?? null,
          version: 4,
          variants: [],
        })
      }

      if (req.method === 'DELETE' && url.pathname === '/v1/entries') {
        res.writeHead(204).end()
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/entries/transfer') {
        return send(200, {
          id: 'mem-1',
          shortId: 'm-234567',
          circleId: 'c2',
          circleSlug: String(body?.toCircle ?? 'team'),
          kind: 'entry',
          title: '回复风格偏好',
          sensitivity: 'internal',
          priority: 5,
          disclosure: null,
          version: 4,
          variants: [],
        })
      }

      if (req.method === 'GET' && url.pathname === '/v1/boot') {
        return send(200, {
          personaTraits: [{ traitKey: 'tone', title: '表达风格', content: '简洁直接' }],
          entries: [
            {
              shortId: 'm-234567',
              title: '工作原则',
              circleId: 'c1',
              circleSlug: 'personal',
              kind: 'entry',
              content: '代码规范优先',
            },
          ],
          omitted: ['m-888888'],
        })
      }

      if (req.method === 'GET' && url.pathname === '/v1/entries/browse') {
        const groupBy = url.searchParams.get('groupBy') ?? 'topic'
        const circle = url.searchParams.get('circle')
        if (circle === 'missing') {
          return send(404, { error: '未找到记忆圈：missing' })
        }
        const auth = req.headers.authorization ?? ''
        if (groupBy === 'realm' && auth === `Bearer ${SCOPED_KEY}`) {
          return send(403, { error: '没有权限读取该场域' })
        }
        return send(200, {
          groupBy,
          groups: [
            {
              key: 'prefs',
              label: groupBy === 'realm' ? '通用场域' : 'prefs',
              count: 1,
              items: [
                {
                  id: 'mem-1',
                  shortId: 'm-234567',
                  title: '回复风格偏好',
                  circleId: 'c1',
                  circleSlug: 'personal',
                  kind: 'entry',
                  sensitivity: 'private',
                  priority: 5,
                  topics: ['prefs'],
                  disclosure: null,
                  variantCount: 2,
                  variantsSummary: [{}, { realm: ['work'] }],
                },
              ],
            },
          ],
          truncated: false,
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/entries') {
        const content = String(body?.content ?? '')
        if (content.includes('mock-secret-marker') && body?.plaintextOk !== true) {
          return send(400, {
            error: '正文里包含新增的疑似明文凭据',
            plaintext: [{ line: 2, kind: 'sk' }],
          })
        }
        return send(201, {
          id: 'mem-new',
          shortId: 'm-new234',
          circleId: 'c1',
          circleSlug: String(body?.circle ?? 'personal'),
          kind: 'entry',
          title: body?.title ?? 'm-new234',
          sensitivity: body?.sensitivity ?? 'private',
          provenance: 'agent',
          originScope: 'app:cc',
          topics: Array.isArray(body?.topics) ? body.topics : [],
          realms: [],
          priority: body?.priority ?? 2,
          disclosure: body?.disclosure ?? null,
          glossary: [],
          validFrom: '2026-01-01T00:00:00Z',
          validTo: null,
          version: 1,
          variants: [
            {
              id: 'v-new',
              when: (body?.when as Record<string, string[]>) ?? {},
              whenSignature: '{}',
              sortOrder: 0,
              content,
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          otherVariants: [],
          links: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
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

  it('search：格式化 Strata 结果框、短 ID、适用条件、联系人事实与 --json 输出', async () => {
    const out1 = captureOut()
    expect(
      await searchCommand(
        ['回复风格', '--limit', '5', '--when', 'realm=work', '--no-cross-circle'],
        { env, out: out1.stream },
      ),
    ).toBe(0)
    const text = out1.read()
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('m-234567')
    expect(text).toContain('正式记忆')
    expect(text).toContain('realm=work')
    expect(text).toContain('另有 1 个变体')
    expect(text).toContain('0.91')
    expect(text).toContain('使用 pnpm')
    expect(text).toContain('风格、结论优先')
    expect(lastRequests.at(-1)?.body).toEqual({
      query: '回复风格',
      limit: 5,
      facets: { realm: ['work'] },
      crossCircle: false,
    })

    const outEmpty = captureOut()
    expect(await searchCommand(['empty'], { env, out: outEmpty.stream })).toBe(0)
    expect(outEmpty.read()).toContain('暂无匹配记忆')

    const outJson = captureOut()
    expect(await searchCommand(['回复风格', '--json'], { env, out: outJson.stream })).toBe(0)
    const parsed = JSON.parse(outJson.read()) as { candidates: Array<{ shortId: string }> }
    expect(parsed.candidates[0].shortId).toBe('m-234567')
  })

  it('get：支持短 ID、--circle 与 --all-variants，区分未返回正文与已解密机密正文', async () => {
    const out = captureOut()
    expect(await getCommand(['m-234567'], { env, out: out.stream })).toBe(0)
    const text = out.read()
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('短 ID：m-234567')
    expect(text).toContain('记忆圈：personal')
    expect(text).toContain('  - 保留缩进列表')
    expect(text).toContain('x'.repeat(40))
    expect(text).toContain('其他变体（1）')
    expect(text).toContain('→ m-345678')

    const allOut = captureOut()
    expect(
      await getCommand(['m-234567', '--circle', 'personal', '--all-variants'], {
        env,
        out: allOut.stream,
      }),
    ).toBe(0)
    const allText = allOut.read()
    expect(allText).toContain('── 适用条件：通用 ──')
    expect(allText).toContain('── 适用条件：realm=work ──')
    expect(allText).toContain('工作场景下先给结论。')
    expect(lastRequests.at(-1)?.url).toContain('circle=personal')
    expect(lastRequests.at(-1)?.url).toContain('allVariants=true')

    const secretOut = captureOut()
    expect(await getCommand(['m-999999'], { env, out: secretOut.stream })).toBe(0)
    expect(secretOut.read()).toContain('正文未返回，需管理界面或具备机密读权限的访问密钥查看')

    const decryptedOut = captureOut()
    expect(await getCommand(['m-secok2'], { env, out: decryptedOut.stream })).toBe(0)
    expect(decryptedOut.read()).toContain('机密正文已解密读取')
    expect(decryptedOut.read()).toContain('decrypted-secret-content')

    await expect(getCommand(['m-404040'], { env, out: captureOut().stream })).rejects.toThrow(
      KiokuFailure,
    )
  })

  it('ls：默认按主题分组浏览，支持位置分组维度（含中文别名）与筛选参数', async () => {
    const defaultOut = captureOut()
    expect(await lsCommand([], { env, out: defaultOut.stream })).toBe(0)
    const text = defaultOut.read()
    expect(text).toContain('记忆目录（按 topic 分组）')
    expect(text).toContain('prefs（1）')
    expect(text).toContain('回复风格偏好')
    expect(text).toContain('m-234567')
    expect(text).toContain('2 个变体')
    expect(lastRequests.at(-1)?.url).toBe('/v1/entries/browse?groupBy=topic')

    const filteredOut = captureOut()
    expect(
      await lsCommand(
        ['场域', '--circle', 'personal', '--kind', 'entry', '--topic', 'prefs', '--limit', '10'],
        {
          env,
          out: filteredOut.stream,
        },
      ),
    ).toBe(0)
    expect(filteredOut.read()).toContain('按 realm 分组')
    expect(lastRequests.at(-1)?.url).toBe(
      '/v1/entries/browse?groupBy=realm&circle=personal&kind=entry&topic=prefs&limit=10',
    )

    await writeProfile('pi', { url: base, key: SCOPED_KEY }, env)
    await expect(
      lsCommand(['realm', '--platform', 'pi'], { env, out: captureOut().stream }),
    ).rejects.toThrow('没有权限读取该场域')

    await expect(
      lsCommand(['--circle', 'missing', '--platform', 'pi'], { env, out: captureOut().stream }),
    ).rejects.toThrow('未找到记忆圈：missing')

    await expect(lsCommand(['invalid-dim'], { env, out: captureOut().stream })).rejects.toThrow(
      UsageError,
    )

    const filteredWhenOut = captureOut()
    expect(
      await lsCommand(['--when', 'realm=work', '--platform', 'codex'], {
        env,
        out: filteredWhenOut.stream,
      }),
    ).toBe(0)
    expect(filteredWhenOut.read()).toContain('回复风格偏好')
    expect(lastRequests.at(-1)?.url).toBe('/v1/entries/browse?groupBy=topic')

    const unmatchedWhenOut = captureOut()
    expect(
      await lsCommand(['--when', 'realm=home', '--platform', 'codex'], {
        env,
        out: unmatchedWhenOut.stream,
      }),
    ).toBe(0)
    expect(unmatchedWhenOut.read()).toContain('暂无可见记忆')
  })

  it('add / edit / delete / transfer / boot：支持完整日常读写操作与 --version / -- 选项分隔', async () => {
    const out1 = captureOut()
    expect(
      await addCommand(
        [
          '管道测试',
          '--circle',
          'personal',
          '--topic',
          'notes,ci',
          '--when',
          'realm=work',
          '--when',
          'project=kioku',
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
    expect(out1.read()).toContain('m-new234')
    expect(lastRequests.at(-1)?.url).toBe('/v1/entries')
    expect(lastRequests.at(-1)?.body).toEqual({
      circle: 'personal',
      title: '管道测试',
      content: '通过管道写入的内容',
      topics: ['notes', 'ci'],
      when: { realm: ['work'], project: ['kioku'] },
      sensitivity: 'private',
      priority: 4,
    })

    const blockedOut = captureOut()
    const secretSample = 'line1\nvalue = mock-secret-marker\n'
    const codeBlocked = await addCommand(['--title', '密钥检查', '--content', secretSample], {
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
      ['--title', '密钥检查', '--content', secretSample, '--plaintext-ok'],
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
      addCommand(['标题', '--when', 'bad-when', '--content', 'abc'], {
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

    const validToOut = captureOut()
    expect(
      await addCommand(
        [
          '--title',
          '时效记忆',
          '--content',
          '限时规则',
          '--glossary',
          '发布,构建',
          '--valid-to',
          '2026-12-31T23:59:00+08:00',
        ],
        { env, out: validToOut.stream },
      ),
    ).toBe(0)
    expect(lastRequests.at(-1)?.body).toMatchObject({
      glossary: ['发布', '构建'],
      validTo: '2026-12-31T23:59:00+08:00',
    })

    const editOut = captureOut()
    expect(
      await editCommand(
        ['m-234567', '--title', '新标题', '--valid-to', 'clear', '--expected-version', '3'],
        { env, out: editOut.stream },
      ),
    ).toBe(0)
    expect(editOut.read()).toContain('已更新记忆')
    expect(lastRequests.at(-1)).toMatchObject({
      method: 'PATCH',
      url: '/v1/entries',
      body: { id: 'm-234567', title: '新标题', validTo: null, expectedVersion: 3 },
    })

    await expect(
      deleteCommand(['m-234567'], {
        env,
        out: captureOut().stream,
        stdin: { isTTY: false } as never,
      }),
    ).rejects.toThrow('--yes')

    const delOut = captureOut()
    expect(await deleteCommand(['m-234567', '--yes'], { env, out: delOut.stream })).toBe(0)
    expect(delOut.read()).toContain('已删除记忆')
    expect(lastRequests.at(-1)?.method).toBe('DELETE')

    const trOut = captureOut()
    expect(await transferCommand(['m-234567', '--to', 'team'], { env, out: trOut.stream })).toBe(0)
    expect(trOut.read()).toContain('已迁移记忆')
    expect(trOut.read()).toContain('team')
    expect(lastRequests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/v1/entries/transfer',
      body: { id: 'm-234567', toCircle: 'team' },
    })

    const bootOut = captureOut()
    expect(await bootCommand([], { env, out: bootOut.stream })).toBe(0)
    expect(bootOut.read()).toContain('表达风格')
    expect(bootOut.read()).toContain('代码规范优先')
    expect(bootOut.read()).toContain('m-888888')

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
