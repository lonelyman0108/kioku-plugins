import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure, UsageError } from '../core.ts'
import { importMemories } from '../import.ts'
import { claudeProjectName, frontmatter, sections, segment, titleOf } from '../sources.ts'
import { posixOnly } from '../../../core/lib/__tests__/fakeCommand.mjs'

const KEY = 'kioku_test_key'

function canonicalSig(raw) {
  if (!raw || typeof raw !== 'object') return '{}'
  const out = {}
  for (const key of Object.keys(raw).sort()) {
    const vals = [
      ...new Set((raw[key] ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean)),
    ].sort()
    if (vals.length) out[key] = vals
  }
  return JSON.stringify(out)
}

// 假的 Kioku：whoami 与按标题/短 ID/旧坐标读、新建、修改词条。store 是库里现有的词条，rejects 是写入时要拒绝的标题
let server
let base
let requests = []
let store
let rejects
const BASE30 = '23456789abcdefghjkmnpqrstvwxyz'
function encodeShortId(n) {
  let rem = n
  let out = ''
  for (let i = 0; i < 6; i++) {
    out = BASE30[rem % 30] + out
    rem = Math.floor(rem / 30)
  }
  return `m-${out}`
}

let seq = 0

function findInStore(circle, ref) {
  for (const item of store.values()) {
    if (circle && item.circleSlug !== circle) continue
    if (item.shortId === ref || item.title === ref || item.legacyUri === ref) return item
  }
  return null
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const body = raw ? JSON.parse(raw) : null
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        auth: req.headers.authorization,
        body,
      })
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (url.pathname === '/v1/whoami') {
        return send(200, {
          primaryCircle: { id: 'c1', slug: 'personal', name: '个人圈', kind: 'personal' },
          linkedCircles: [],
          client: {
            id: 'c-cc',
            circleId: 'c1',
            slug: 'cc',
            name: 'Claude Code',
            runtimeFamily: 'claudecode',
          },
          persona: null,
          scopes: { readKinds: ['entry'], writeKinds: ['entry'] },
        })
      }
      if (req.method === 'GET' && url.pathname === '/v1/entries') {
        const found = findInStore(url.searchParams.get('circle'), url.searchParams.get('id'))
        return found ? send(200, found) : send(404, { error: '不存在或不可见' })
      }
      const key = body?.title ?? body?.id
      const rejected = rejects.get(key)
      // drop：不回答，直接断开，像网络断了
      if (rejected?.drop) return req.socket.destroy()
      if (rejected) return send(rejected.status, rejected.body)

      if (req.method === 'POST' && url.pathname === '/v1/entries') {
        const shortId = encodeShortId(seq++)
        const when = body.when ?? {}
        const record = {
          id: `uuid-${seq}`,
          shortId,
          circleId: 'c1',
          circleSlug: body.circle ?? 'personal',
          kind: 'entry',
          title: body.title,
          sensitivity: 'private',
          provenance: 'agent',
          originScope: 'app:cc',
          topics: body.topics ?? [],
          realms: when.realm ?? [],
          priority: 2,
          disclosure: body.disclosure ?? null,
          glossary: [],
          validFrom: '2026-01-01T00:00:00Z',
          validTo: null,
          version: 2,
          variants: [
            {
              id: `v-${seq}`,
              when,
              whenSignature: canonicalSig(when),
              sortOrder: 0,
              content: body.content,
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          otherVariants: [],
          links: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }
        store.set(`${record.circleSlug}::${shortId}`, record)
        return send(201, record)
      }

      if (req.method === 'PATCH' && url.pathname === '/v1/entries') {
        const existing = findInStore(body.circle, body.id)
        if (!existing) return send(404, { error: '不存在或不可见' })
        const when = body.when ?? {}
        const sig = canonicalSig(when)
        existing.version += 1
        existing.title = body.title ?? existing.title
        existing.variants = [
          {
            id: existing.variants[0]?.id ?? 'var-1',
            when,
            whenSignature: sig,
            sortOrder: 0,
            content: body.content,
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]
        return send(200, existing)
      }

      return send(404, { error: 'not found' })
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
  store = new Map()
  rejects = new Map()
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'kioku-import-'))
  env = { KIOKU_SERVER_URL: base, KIOKU_API_KEY: KEY, CLAUDE_CONFIG_DIR: join(dir, 'claude') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function file(path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
// Claude Code 的一条记忆
function memory(project, name, type, body = `关于 ${name} 的内容`, desc = `${name} 的说明`) {
  file(
    `claude/projects/${project}/memory/${name}.md`,
    `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`,
  )
}
async function run(args, { answer, tty = false } = {}) {
  let text = ''
  const stdin = Readable.from(answer === undefined ? [] : [Buffer.from(answer)])
  stdin.isTTY = tty
  const code = await importMemories(args, {
    env,
    out: { write: (chunk) => (text += chunk) },
    stdin,
  })
  return { code, text }
}
const writes = () => requests.filter((r) => r.method !== 'GET')

describe('本地记忆的解析', () => {
  it('坐标里的一段：只留小写字母、数字、_ 与 -，别的换成 -；什么都不剩时用摘要', () => {
    expect(segment('Local HTML  not_Artifact!')).toBe('local-html-not_artifact')
    expect(segment('--a--b--')).toBe('a-b')
    expect(segment('x'.repeat(100))).toHaveLength(64)
    expect(segment('全是中文')).toMatch(/^m-[0-9a-f]{10}$/)
    expect(segment('全是中文')).toBe(segment('全是中文'))
    expect(segment('另一个')).not.toBe(segment('全是中文'))
  })

  it('标题压成一行，去掉控制字符，按码点截断', () => {
    expect(titleOf(' 甲\n乙\u0007 ')).toBe('甲 乙')
    expect(Array.from(titleOf('😀'.repeat(100)))).toHaveLength(80)
  })

  it('文件头：键值与缩进一层的键值；没有文件头时正文就是全文', () => {
    const parsed = frontmatter(
      '﻿---\nname: a\ndescription: "带引号"\nmetadata:\n  type: user\n---\n\n正文',
    )
    expect(parsed.meta).toMatchObject({ name: 'a', description: '带引号', 'metadata.type': 'user' })
    expect(parsed.body.trim()).toBe('正文')
    expect(frontmatter('没有文件头\n---\n')).toEqual({ meta: {}, body: '没有文件头\n---\n' })
  })

  it('一份 Markdown 拆成几条：有分节号的分隔行按它拆，否则按二级标题，都没有就是一整条', () => {
    expect(sections('甲\n\u00a7\n乙\n\u00a7\n\n')).toEqual([
      { heading: null, text: '甲' },
      { heading: null, text: '乙' },
    ])
    expect(sections('# 总标题\n开头\n## 第一 ##\n内容一\n### 小节\n## 第二\n内容二')).toEqual([
      { heading: null, text: '# 总标题\n开头' },
      { heading: '第一', text: '## 第一 ##\n内容一\n### 小节' },
      { heading: '第二', text: '## 第二\n内容二' },
    ])
    expect(sections('只有一段')).toEqual([{ heading: null, text: '只有一段' }])
    expect(sections('  \n')).toEqual([])
  })

  it('Claude Code 的项目名：去掉主目录与常见的上级目录；前缀要对到一段的边界；太长时留后面的', () => {
    const home = '/Users/lm'
    expect(claudeProjectName('-Users-lm-Documents-code-kioku-plugins', home)).toBe('kioku-plugins')
    expect(claudeProjectName('-Users-lm-work-src-App', home)).toBe('app')
    expect(claudeProjectName('-opt-thing', home)).toBe('opt-thing')
    expect(claudeProjectName('-Users-lmx-foo', home)).toBe('users-lmx-foo')
    expect(claudeProjectName('-Users-lm', home)).toBe('users-lm')
    const deep = `-Users-lm-code-${'a'.repeat(70)}-tail`
    expect(claudeProjectName(deep, home)).toHaveLength(64)
    expect(claudeProjectName(deep, home).endsWith('-tail')).toBe(true)
    expect(claudeProjectName('c--Users-LM-Desktop-kioku-plugins', 'C:\\Users\\LM')).toBe(
      'kioku-plugins',
    )
    expect(claudeProjectName('C--Users-LM-Desktop-kioku-plugins', 'c:\\Users\\lm')).toBe(
      'kioku-plugins',
    )
    expect(claudeProjectName('c--Users-lmx-foo', 'C:\\Users\\LM')).toBe('c-users-lmx-foo')
  })
})

describe('kioku import --from claude-code', () => {
  it('按类型生成切面与主题标签，列出计划，--dry-run 不写', async () => {
    memory('-x-code-kioku', 'who-am-i', 'user')
    memory('-x-code-kioku', 'no-artifact', 'feedback')
    memory('-x-code-kioku', 'release-plan', 'project')
    memory('-x-code-other', 'dashboards', 'reference')
    file('claude/projects/-x-code-kioku/memory/MEMORY.md', '- [索引](a.md)')
    file('claude/projects/-x-code-empty/notes.txt', '没有 memory 目录')
    const result = await run(['--from', 'claude-code', '--dry-run'])
    expect(result.code).toBe(0)
    for (const label of [
      '新建  who-am-i 的说明 [project=x-code-kioku]',
      '新建  no-artifact 的说明 [project=x-code-kioku runtime=claudecode]',
      '新建  release-plan 的说明 [project=x-code-kioku]',
      '新建  dashboards 的说明 [project=x-code-other]',
    ]) {
      expect(result.text).toContain(label)
    }
    expect(result.text).not.toContain('MEMORY.md')
    expect(result.text).toContain('新建 4 条，已有且一样 0 条')
    expect(result.text).toContain('没有写入（--dry-run）')
    expect(writes()).toHaveLength(0)
    expect(result.text).not.toContain(KEY)
  })

  it('--yes 写入到 /v1/entries 并带上切面、主题标签与 --circle；支持兼容旧 URI 兜底比对', async () => {
    memory('-x-code-kioku', 'who-am-i', 'user', '用户是后端开发。')
    const before = readFileSync(
      join(dir, 'claude/projects/-x-code-kioku/memory/who-am-i.md'),
      'utf8',
    )
    const result = await run(['--from', 'claude-code', '--circle', 'personal', '--yes'])
    expect(result.code).toBe(0)
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/v1/entries',
        query: {},
        auth: `Bearer ${KEY}`,
        body: {
          circle: 'personal',
          title: 'who-am-i 的说明',
          content: '用户是后端开发。',
          when: { project: ['x-code-kioku'] },
          topics: ['claude-code', 'user'],
          disclosure: 'who-am-i 的说明',
        },
      },
    ])
    expect(result.text).toContain('写入 1 条')
    expect(
      readFileSync(join(dir, 'claude/projects/-x-code-kioku/memory/who-am-i.md'), 'utf8'),
    ).toBe(before)

    // 已有词条标题不同但带有 legacyUri 时，按标题 404 后自动兜底按 legacyUri 匹配
    store.set('personal::m-legacy1', {
      id: 'uuid-legacy',
      shortId: 'm-legacy1',
      circleId: 'c1',
      circleSlug: 'personal',
      kind: 'entry',
      title: '旧标题',
      legacyUri: 'user://about/x-code-kioku/legacy-note',
      sensitivity: 'private',
      version: 4,
      variants: [
        {
          id: 'v-leg',
          when: { project: ['x-code-kioku'] },
          whenSignature: '{"project":["x-code-kioku"]}',
          sortOrder: 0,
          content: '旧库里的相同正文',
        },
      ],
    })
    memory('-x-code-kioku', 'legacy-note', 'user', '旧库里的相同正文', '新描述标题')
    requests = []
    const dedup = await run(['--from', 'claude-code', '--yes'])
    expect(dedup.text).toContain('已有且一样 2 条')
    expect(writes()).toHaveLength(0)
  })

  it('重复运行不重复写；内容变了的默认跳过，--overwrite 才覆盖并带上 shortId 与版本', async () => {
    memory('-x-code-kioku', 'a', 'user', '第一版')
    await run(['--from', 'claude-code', '--yes'])
    requests = []
    const again = await run(['--from', 'claude-code', '--yes'])
    expect(again.text).toContain('已有，内容一样  a 的说明（m-222222）')
    expect(again.text).toContain('没有要写的')
    expect(writes()).toHaveLength(0)

    memory('-x-code-kioku', 'a', 'user', '第二版')
    const skipped = await run(['--from', 'claude-code', '--yes'])
    expect(skipped.text).toContain('已有，内容不一样  a 的说明（m-222222）')
    expect(skipped.text).toContain('要覆盖加 --overwrite')
    expect(writes()).toHaveLength(0)

    const forced = await run(['--from', 'claude-code', '--yes', '--overwrite'])
    expect(forced.code).toBe(0)
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      path: '/v1/entries',
      body: {
        id: 'm-222222',
        circle: 'personal',
        title: 'a 的说明',
        content: '第二版',
        expectedVersion: 2,
      },
    })
    expect(writes()[0].body.expectedId).toBeUndefined()
  })

  it('在终端里问一句，答 y 才写；不在终端里又没带 --yes 时不写', async () => {
    memory('-x-code-kioku', 'a', 'user')
    const no = await run(['--from', 'claude-code'], { tty: true, answer: 'n\n' })
    expect(no.text).toContain('写入这 1 条？[y/N]')
    expect(no.text).toContain('没有写入')
    expect(writes()).toHaveLength(0)
    await expect(run(['--from', 'claude-code'])).rejects.toThrow('要带 --yes')
    expect(writes()).toHaveLength(0)
    const yes = await run(['--from', 'claude-code'], { tty: true, answer: 'Y\n' })
    expect(yes.text).toContain('写入 1 条')
  })

  it('疑似明文的不写：列出第几行、哪一类，不带值；别的照常写，退出码 1', async () => {
    memory('-x-code-kioku', 'secretive', 'user', '密码是 hunter-22-secret')
    memory('-x-code-kioku', 'fine', 'user')
    rejects.set('secretive 的说明', {
      status: 400,
      body: { error: `正文里有疑似明文凭据 ${KEY}`, plaintext: [{ line: 1, kind: 'password' }] },
    })
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('写入 1 条')
    expect(result.text).toContain('没有写入  secretive 的说明')
    expect(result.text).toContain('正文第 1 行：password')
    expect(result.text).toContain('把值存成凭据')
    expect(result.text).not.toContain('hunter-22-secret')
    expect(result.text).not.toContain(KEY)
  })

  it('不迁的列出原因：太长的、没有内容的、和前面的重名的', async () => {
    memory('-x-code-kioku', 'long', 'user', '长'.repeat(20_001))
    memory('-x-code-kioku', 'blank', 'user', '  ')
    memory('-x-code-kioku', 'Dup', 'user', '正文一', '重复标题')
    file(
      'claude/projects/-x-code-kioku/memory/dup2.md',
      '---\nname: dup\ndescription: 重复标题\nmetadata:\n  type: user\n---\n另一条\n',
    )
    const result = await run(['--from', 'claude-code', '--dry-run'])
    expect(result.text).toContain('正文超过 20000 个字')
    expect(result.text).toContain('没有内容')
    expect(result.text).toContain('和前面的一条重名 重复标题')
    expect(result.text).toContain('新建 1 条')
    expect(result.text).toContain('不迁 3 条')
  })

  it('--path 指到某个项目的 memory 目录时只读它；指错了、没有记忆分别说明', async () => {
    memory('-x-code-kioku', 'a', 'user')
    memory('-x-code-other', 'b', 'user')
    const one = await run([
      '--from',
      'claude-code',
      '--path',
      join(dir, 'claude/projects/-x-code-kioku/memory'),
      '--dry-run',
    ])
    expect(one.text).toContain('a 的说明')
    expect(one.text).not.toContain('b 的说明')
    await expect(run(['--from', 'claude-code', '--path', join(dir, 'nope')])).rejects.toThrow(
      '没有找到',
    )
    mkdirSync(join(dir, 'empty'))
    const none = await run(['--from', 'claude-code', '--path', join(dir, 'empty')])
    expect(none.text).toContain('没有可以迁的记忆')
  })

  it('没有配置、访问密钥无效时不读文件、不写', async () => {
    memory('-x-code-kioku', 'a', 'user')
    env = { CLAUDE_CONFIG_DIR: join(dir, 'claude') }
    await expect(run(['--from', 'claude-code', '--yes'])).rejects.toThrow(KiokuFailure)
    expect(requests).toHaveLength(0)
  })

  it('参数：要写来源；认得但迁不了的来源说明原因', async () => {
    for (const args of [[], ['--from'], ['--from', 'nope'], ['--from', 'claude-code', '--x']]) {
      await expect(run(args), args.join(' ')).rejects.toThrow(UsageError)
    }
    await expect(run(['--from', 'codex'])).rejects.toThrow('格式没有公开')
    await expect(run(['--from', 'pi'])).rejects.toThrow('没有自带的长期记忆')
  })
})

describe('kioku import --from hermes / openclaw', () => {
  it('Hermes：MEMORY.md 带 runtime=hermes，USER.md 通用，按分节号或二级标题拆并保持标题不碰撞', async () => {
    env.HERMES_HOME = join(dir, 'hermes')
    file('hermes/memories/MEMORY.md', '部署用 compose\n\u00a7\n测试先起本地库\n')
    file('hermes/memories/USER.md', '## Reply style\n简短\n## 时区\n东八区\n')
    const result = await run(['--from', 'hermes', '--yes'])
    expect(result.code).toBe(0)
    const sent = writes().map((r) => r.body)
    expect(sent).toHaveLength(4)
    expect(sent[0]).toMatchObject({
      title: expect.stringMatching(/^Hermes 的记忆（[0-9a-f]{6}）$/),
      when: { runtime: ['hermes'] },
      topics: ['hermes', 'notes'],
      content: '部署用 compose',
    })
    expect(sent[1]).toMatchObject({
      title: expect.stringMatching(/^Hermes 的记忆（[0-9a-f]{6}）$/),
      when: { runtime: ['hermes'] },
      topics: ['hermes', 'notes'],
      content: '测试先起本地库',
    })
    expect(sent[0].title).not.toBe(sent[1].title)
    expect(sent[2]).toMatchObject({
      title: 'Reply style',
      topics: ['hermes', 'about'],
      content: '## Reply style\n简短',
    })
    expect(sent[2].when).toBeUndefined()
    expect(sent[3]).toMatchObject({
      title: '时区',
      topics: ['hermes', 'about'],
      content: '## 时区\n东八区',
    })
  })

  it('OpenClaw：工作区的两个文件，加上按日期的笔记一个文件一条', async () => {
    env.OPENCLAW_HOME = join(dir, 'openclaw')
    file('openclaw/.openclaw/workspace/MEMORY.md', '只有一段')
    file('openclaw/.openclaw/workspace/memory/2026-11-10.md', '## 上午\n做了甲\n## 下午\n做了乙')
    file('openclaw/.openclaw/workspace/memory/2026-11-10-Deploy.md', '下午的部署记录')
    file(`openclaw/.openclaw/workspace/memory/2026-11-12-a--${'x'.repeat(80)}.md`, '名字很长的')
    file('openclaw/.openclaw/workspace/memory/notes.md', '不是按日期的，不读')
    const result = await run(['--from', 'openclaw', '--dry-run'])
    expect(result.text).toContain('新建  OpenClaw 的记忆 [runtime=openclaw]')
    expect(result.text).toContain('新建  2026-11-10 的笔记 [runtime=openclaw]')
    expect(result.text).toContain('新建  2026-11-10 的笔记（Deploy） [runtime=openclaw]')
    expect(result.text).toContain('新建 4 条')
  })

  it('Hermes：文件里插一条、删一条之后，别的条标题不变，再运行只写新的那条', async () => {
    env.HERMES_HOME = join(dir, 'hermes')
    const SIGN = String.fromCharCode(0xa7)
    file('hermes/memories/MEMORY.md', ['甲', '乙', '丙'].join(`\n${SIGN}\n`))
    await run(['--from', 'hermes', '--yes'])
    expect(writes()).toHaveLength(3)
    requests = []
    file('hermes/memories/MEMORY.md', ['新的', '甲', '丙'].join(`\n${SIGN}\n`))
    const again = await run(['--from', 'hermes', '--yes'])
    expect(again.text).toContain('新建 1 条，已有且一样 2 条')
    expect(writes().map((r) => r.body.content)).toEqual(['新的'])
  })

  it('两个来源迁进同一个记忆圈时不落到同一个标题', async () => {
    env.HERMES_HOME = join(dir, 'hermes')
    env.OPENCLAW_HOME = join(dir, 'openclaw')
    file('hermes/memories/MEMORY.md', '同一段话')
    file('openclaw/.openclaw/workspace/MEMORY.md', '同一段话')
    await run(['--from', 'hermes', '--yes'])
    const second = await run(['--from', 'openclaw', '--yes'])
    expect(second.text).toContain('新建 1 条')
    expect(new Set(writes().map((r) => r.body.title)).size).toBe(2)
  })
})

describe('kioku import：读文件与写入的边界', () => {
  it('符号链接、太大的、不是文本的文件不读，列出原因；指到别处的 memory 目录不进去', async () => {
    file('outside/secret.env', 'TOKEN=不该被读到')
    memory('-x-code-kioku', 'ok', 'user')
    const mem = join(dir, 'claude/projects/-x-code-kioku/memory')
    symlinkSync(join(dir, 'outside/secret.env'), join(mem, 'link.md'))
    writeFileSync(join(mem, 'big.md'), 'x'.repeat(600 * 1024))
    writeFileSync(join(mem, 'binary.md'), Buffer.from([0x23, 0x00, 0xff, 0xfe]))
    mkdirSync(join(dir, 'claude/projects/-x-linked'), { recursive: true })
    mkdirSync(join(dir, 'elsewhere'))
    writeFileSync(join(dir, 'elsewhere/x.md'), '别处的文件')
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'claude/projects/-x-linked/memory'))
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.text).toContain('是符号链接，不读')
    expect(result.text).toContain('文件太大，不读')
    expect(result.text).toContain('不是文本文件')
    expect(writes().map((r) => r.body.title)).toEqual(['ok 的说明'])
    expect(JSON.stringify(requests)).not.toMatch(/不该被读到|别处的文件/)
  })

  it('文件头：没有结尾的不迁；正文里的分隔线不当成结尾；以分隔线开头的普通 Markdown 整个是正文', async () => {
    file(
      'claude/projects/-x-code-kioku/memory/open.md',
      '---\nname: open\nmetadata:\n  type: user\n\n正文在这里\n',
    )
    file(
      'claude/projects/-x-code-kioku/memory/rule.md',
      '---\nname: rule\nmetadata:\n  type: user\n---\n第一段\n\n---\n\n第二段\n| a | b |\n|---|---|\n',
    )
    file('claude/projects/-x-code-kioku/memory/plain.md', '---\n\n只是以分隔线开头\n')
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.text).toContain('文件头没有结尾的 ---')
    const bodies = Object.fromEntries(writes().map((r) => [r.body.title, r.body.content]))
    expect(bodies.rule).toBe('第一段\n\n---\n\n第二段\n| a | b |\n|---|---|')
    expect(bodies.plain).toBe('---\n\n只是以分隔线开头')
    expect(Object.keys(bodies)).toHaveLength(2)
  })

  it('文件头里更深一层的键不摊到上一层，多行写法的标记不当成值', () => {
    const { meta } = frontmatter(
      '---\nname: a\ndescription: >\n  多行的说明\nmetadata:\n  type: user\n  origin:\n    type: feedback\n---\n正文',
    )
    expect(meta['metadata.type']).toBe('user')
    expect(meta.description).toBe('')
    expect(frontmatter('---\nname: a\n').unterminated).toBe(true)
  })

  it('相对路径与绝对路径算出同一个项目名并跳过已迁内容', async () => {
    memory('-x-code-kioku', 'role', 'user', '甲', 'kioku role')
    memory('-x-code-other', 'role', 'user', '乙', 'other role')
    const all = await run(['--from', 'claude-code', '--yes'])
    expect(all.text).toContain('新建 2 条')
    requests = []
    const cwd = process.cwd()
    process.chdir(join(dir, 'claude/projects/-x-code-kioku/memory'))
    try {
      const relative = await run(['--from', 'claude-code', '--path', '.', '--yes'])
      expect(relative.text).toContain('已有，内容一样  kioku role')
      expect(relative.text).toContain('新建 0 条')
    } finally {
      process.chdir(cwd)
    }
  })

  posixOnly('路径里的控制字符不原样打印', async () => {
    file(
      'claude/projects/-x-code-kioku/memory/a\n新建  伪造的一行.md',
      '---\nname: weird\nmetadata:\n  type: user\n---\n正文',
    )
    const result = await run(['--from', 'claude-code', '--dry-run'])
    expect(result.text.split('\n')).not.toContain('新建  伪造的一行.md')
    expect(result.text).toContain('a 新建  伪造的一行.md')
  })

  it('写到一半连不上：停下来，说清楚写了多少、还剩多少，退出码 1', async () => {
    for (const name of ['a', 'b', 'c']) memory('-x-code-kioku', name, 'user')
    rejects.set('b 的说明', { drop: true })
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('写入 1 条')
    expect(result.text).toMatch(/还有 2 条没有写，重新运行会接着写/)
    expect(result.text).toContain('本地的文件没有动')
  })

  it('--platform 用 kioku setup 给那个平台写下的配置；没配过、不认得的分别说明', async () => {
    memory('-x-code-kioku', 'a', 'user')
    env = { CLAUDE_CONFIG_DIR: join(dir, 'claude'), KIOKU_CONFIG_DIR: join(dir, 'kioku') }
    await expect(run(['--from', 'claude-code', '--platform', 'pi', '--yes'])).rejects.toThrow(
      '还没有给 pi 配过',
    )
    await expect(
      run(['--from', 'claude-code', '--platform', 'claude-code', '--yes']),
    ).rejects.toThrow('还没有给 claude-code 配过')
    await expect(run(['--from', 'claude-code', '--platform', 'nope'])).rejects.toThrow(UsageError)
    mkdirSync(join(dir, 'kioku'))
    writeFileSync(
      join(dir, 'kioku', 'pi.json'),
      JSON.stringify({ serverUrl: base, apiKey: 'kioku_pi_key' }),
    )
    const result = await run(['--from', 'claude-code', '--platform', 'pi', '--yes'])
    expect(result.code).toBe(0)
    expect(requests.every((r) => r.auth === 'Bearer kioku_pi_key')).toBe(true)

    writeFileSync(
      join(dir, 'kioku', 'claude-code.json'),
      JSON.stringify({ serverUrl: base, apiKey: 'kioku_cc_key' }),
    )
    requests = []
    const ccResult = await run(['--from', 'claude-code', '--platform', 'claude-code', '--yes'])
    expect(ccResult.code).toBe(0)
    expect(requests.every((r) => r.auth === 'Bearer kioku_cc_key')).toBe(true)
  })
})
