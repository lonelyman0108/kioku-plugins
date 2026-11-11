import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure } from '../http.mjs'
import { importMemories } from '../import.mjs'
import { claudeProjectName, frontmatter, sections, segment, titleOf } from '../sources.mjs'
import { UsageError } from '../usage.mjs'

const KEY = 'kioku_test_key'

// 假的 Kioku：whoami 与按坐标读、新建、修改记忆。store 是库里现有的记忆，rejects 是写入时要拒绝的坐标
let server
let base
let requests = []
let store
let rejects
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
        auth: req.headers.authorization,
        body,
      })
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (url.pathname === '/v1/whoami') {
        return send(200, {
          app: { slug: 'cc', name: 'Claude Code', runtimeFamily: 'claudecode' },
          scopes: {},
        })
      }
      if (req.method === 'GET') {
        const found = store.get(url.searchParams.get('uri'))
        return found ? send(200, found) : send(404, { error: '不存在或不可见' })
      }
      const rejected = rejects.get(body.uri)
      if (rejected) return send(rejected.status, rejected.body)
      store.set(body.uri, { id: 'id-1', uri: body.uri, content: body.content, version: 2 })
      send(req.method === 'POST' ? 201 : 200, store.get(body.uri))
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
  dir = mkdtempSync(join(tmpdir(), 'kioku-import-'))
  env = { KIOKU_SERVER_URL: base, KIOKU_API_KEY: KEY, CLAUDE_CONFIG_DIR: join(dir, 'claude') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function file(path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
// Claude Code 的一条记忆
function memory(project, name, type, body = `关于 ${name} 的内容`) {
  file(
    `claude/projects/${project}/memory/${name}.md`,
    `---\nname: ${name}\ndescription: ${name} 的说明\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`,
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

  it('Claude Code 的项目名：去掉主目录与常见的上级目录', () => {
    expect(claudeProjectName('-Users-lm-Documents-code-kioku-plugins', '/Users/lm')).toBe(
      'kioku-plugins',
    )
    expect(claudeProjectName('-Users-lm-work-src-App', '/Users/lm')).toBe('app')
    expect(claudeProjectName('-opt-thing', '/Users/lm')).toBe('opt-thing')
    expect(claudeProjectName('-Users-lm', '/Users/lm')).toBe('users-lm')
  })
})

describe('kioku import --from claude-code', () => {
  it('按类型放到不同的坐标，列出计划，--dry-run 不写', async () => {
    memory('-x-code-kioku', 'who-am-i', 'user')
    memory('-x-code-kioku', 'no-artifact', 'feedback')
    memory('-x-code-kioku', 'release-plan', 'project')
    memory('-x-code-other', 'dashboards', 'reference')
    file('claude/projects/-x-code-kioku/memory/MEMORY.md', '- [索引](a.md)')
    file('claude/projects/-x-code-empty/notes.txt', '没有 memory 目录')
    const result = await run(['--from', 'claude-code', '--dry-run'])
    expect(result.code).toBe(0)
    for (const uri of [
      'user://about/who-am-i',
      'app://cc/feedback/x-code-kioku/no-artifact',
      'user://projects/x-code-kioku/release-plan',
      'user://reference/x-code-other/dashboards',
    ]) {
      expect(result.text).toContain(`新建  ${uri}\n`)
    }
    expect(result.text).not.toContain('MEMORY.md')
    expect(result.text).toContain('新建 4 条，已有且一样 0 条')
    expect(result.text).toContain('没有写入（--dry-run）')
    expect(writes()).toHaveLength(0)
    expect(result.text).not.toContain(KEY)
  })

  it('--yes 写入：标题与触发场景取文件头的说明，正文不带文件头；本地的文件不动', async () => {
    memory('-x-code-kioku', 'who-am-i', 'user', '用户是后端开发。')
    const before = readFileSync(
      join(dir, 'claude/projects/-x-code-kioku/memory/who-am-i.md'),
      'utf8',
    )
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.code).toBe(0)
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/v1/memories',
        auth: `Bearer ${KEY}`,
        body: {
          uri: 'user://about/who-am-i',
          title: 'who-am-i 的说明',
          content: '用户是后端开发。',
          disclosure: 'who-am-i 的说明',
        },
      },
    ])
    expect(result.text).toContain('写入 1 条')
    expect(
      readFileSync(join(dir, 'claude/projects/-x-code-kioku/memory/who-am-i.md'), 'utf8'),
    ).toBe(before)
  })

  it('重复运行不重复写；内容变了的默认跳过，--overwrite 才覆盖并带上看到的版本', async () => {
    memory('-x-code-kioku', 'a', 'user', '第一版')
    await run(['--from', 'claude-code', '--yes'])
    requests = []
    const again = await run(['--from', 'claude-code', '--yes'])
    expect(again.text).toContain('已有，内容一样  user://about/a')
    expect(again.text).toContain('没有要写的')
    expect(writes()).toHaveLength(0)

    memory('-x-code-kioku', 'a', 'user', '第二版')
    const skipped = await run(['--from', 'claude-code', '--yes'])
    expect(skipped.text).toContain('已有，内容不一样  user://about/a')
    expect(skipped.text).toContain('要覆盖加 --overwrite')
    expect(writes()).toHaveLength(0)

    const forced = await run(['--from', 'claude-code', '--yes', '--overwrite'])
    expect(forced.code).toBe(0)
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      body: { uri: 'user://about/a', content: '第二版', expectedVersion: 2, expectedId: 'id-1' },
    })
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
    rejects.set('user://about/secretive', {
      status: 400,
      body: { error: `正文里有疑似明文凭据 ${KEY}`, plaintext: [{ line: 1, kind: 'password' }] },
    })
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('写入 1 条')
    expect(result.text).toContain('没有写入  user://about/secretive')
    expect(result.text).toContain('正文第 1 行：password')
    expect(result.text).toContain('把值存成凭据')
    expect(result.text).not.toContain('hunter-22-secret')
    expect(result.text).not.toContain(KEY)
  })

  it('不迁的列出原因：太长的、没有内容的、和前面的落到同一个坐标的', async () => {
    memory('-x-code-kioku', 'long', 'user', '长'.repeat(20_001))
    memory('-x-code-kioku', 'blank', 'user', '  ')
    memory('-x-code-kioku', 'Dup', 'user')
    file(
      'claude/projects/-x-code-kioku/memory/dup2.md',
      '---\nname: dup\nmetadata:\n  type: user\n---\n另一条\n',
    )
    const result = await run(['--from', 'claude-code', '--dry-run'])
    expect(result.text).toContain('正文超过 20000 个字')
    expect(result.text).toContain('没有内容')
    expect(result.text).toContain('和前面的一条落到同一个坐标 user://about/dup')
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
    expect(one.text).toContain('user://about/a')
    expect(one.text).not.toContain('user://about/b')
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
  it('Hermes：MEMORY.md 进这个应用，USER.md 进本人，按分节号或二级标题拆', async () => {
    env.HERMES_HOME = join(dir, 'hermes')
    file('hermes/memories/MEMORY.md', '部署用 compose\n\u00a7\n测试先起本地库\n')
    file('hermes/memories/USER.md', '## Reply style\n简短\n## 时区\n东八区\n')
    const result = await run(['--from', 'hermes', '--yes'])
    expect(result.code).toBe(0)
    expect(writes().map((r) => [r.body.uri, r.body.content])).toEqual([
      ['app://cc/notes/n1', '部署用 compose'],
      ['app://cc/notes/n2', '测试先起本地库'],
      ['user://about/hermes/reply-style', '## Reply style\n简短'],
      [expect.stringMatching(/^user:\/\/about\/hermes\/m-[0-9a-f]{10}$/), '## 时区\n东八区'],
    ])
    expect(writes()[2].body.title).toBe('Reply style')
  })

  it('OpenClaw：工作区的两个文件，加上按日期的笔记一天一条', async () => {
    env.OPENCLAW_HOME = join(dir, 'openclaw')
    file('openclaw/workspace/MEMORY.md', '只有一段')
    file('openclaw/workspace/memory/2026-11-10.md', '## 上午\n做了甲\n## 下午\n做了乙')
    file('openclaw/workspace/memory/notes.md', '不是按日期的，不读')
    const result = await run(['--from', 'openclaw', '--dry-run'])
    expect(result.text).toContain('新建  app://cc/notes/notes\n')
    expect(result.text).toContain('新建  app://cc/journal/2026-11-10\n')
    expect(result.text).toContain('2026-11-10 的笔记')
    expect(result.text).toContain('新建 2 条')
  })
})
