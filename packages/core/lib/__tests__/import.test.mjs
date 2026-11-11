import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure } from '../http.mjs'
import { importMemories } from '../import.mjs'
import { claudeProjectName, frontmatter, sections, segment, titleOf } from '../sources.mjs'
import { UsageError } from '../usage.mjs'
import { posixOnly } from './fakeCommand.mjs'

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
      // drop：不回答，直接断开，像网络断了
      if (rejected?.drop) return req.socket.destroy()
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

  it('Claude Code 的项目名：去掉主目录与常见的上级目录；前缀要对到一段的边界；太长时留后面的', () => {
    const home = '/Users/lm'
    expect(claudeProjectName('-Users-lm-Documents-code-kioku-plugins', home)).toBe('kioku-plugins')
    expect(claudeProjectName('-Users-lm-work-src-App', home)).toBe('app')
    expect(claudeProjectName('-opt-thing', home)).toBe('opt-thing')
    // 主目录是 /Users/lm 时不去掉 -Users-lmx-… 的开头
    expect(claudeProjectName('-Users-lmx-foo', home)).toBe('users-lmx-foo')
    expect(claudeProjectName('-Users-lm', home)).toBe('users-lm')
    const deep = `-Users-lm-code-${'a'.repeat(70)}-tail`
    expect(claudeProjectName(deep, home)).toHaveLength(64)
    expect(claudeProjectName(deep, home).endsWith('-tail')).toBe(true)
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
      'user://about/x-code-kioku/who-am-i',
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
          uri: 'user://about/x-code-kioku/who-am-i',
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
    expect(again.text).toContain('已有，内容一样  user://about/x-code-kioku/a')
    expect(again.text).toContain('没有要写的')
    expect(writes()).toHaveLength(0)

    memory('-x-code-kioku', 'a', 'user', '第二版')
    const skipped = await run(['--from', 'claude-code', '--yes'])
    expect(skipped.text).toContain('已有，内容不一样  user://about/x-code-kioku/a')
    expect(skipped.text).toContain('要覆盖加 --overwrite')
    expect(writes()).toHaveLength(0)

    const forced = await run(['--from', 'claude-code', '--yes', '--overwrite'])
    expect(forced.code).toBe(0)
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      body: {
        uri: 'user://about/x-code-kioku/a',
        content: '第二版',
        expectedVersion: 2,
        expectedId: 'id-1',
      },
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
    rejects.set('user://about/x-code-kioku/secretive', {
      status: 400,
      body: { error: `正文里有疑似明文凭据 ${KEY}`, plaintext: [{ line: 1, kind: 'password' }] },
    })
    const result = await run(['--from', 'claude-code', '--yes'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('写入 1 条')
    expect(result.text).toContain('没有写入  user://about/x-code-kioku/secretive')
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
    expect(result.text).toContain('和前面的一条落到同一个坐标 user://about/x-code-kioku/dup')
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
    expect(one.text).toContain('user://about/x-code-kioku/a')
    expect(one.text).not.toContain('user://about/x-code-kioku/b')
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
    const hash = expect.stringMatching(/^m-[0-9a-f]{10}$/)
    const rows = writes().map((r) => [
      r.body.uri.replace(/[^/]+$/, ''),
      r.body.uri.match(/[^/]+$/)[0],
      r.body.content,
    ])
    expect(rows).toEqual([
      ['app://cc/hermes/notes/', hash, '部署用 compose'],
      ['app://cc/hermes/notes/', hash, '测试先起本地库'],
      ['user://about/hermes/', 'reply-style', '## Reply style\n简短'],
      ['user://about/hermes/', hash, '## 时区\n东八区'],
    ])
    expect(rows[0][1]).not.toBe(rows[1][1])
    expect(writes()[2].body.title).toBe('Reply style')
  })

  it('OpenClaw：工作区的两个文件，加上按日期的笔记一个文件一条', async () => {
    env.OPENCLAW_HOME = join(dir, 'openclaw')
    file('openclaw/.openclaw/workspace/MEMORY.md', '只有一段')
    file('openclaw/.openclaw/workspace/memory/2026-11-10.md', '## 上午\n做了甲\n## 下午\n做了乙')
    file('openclaw/.openclaw/workspace/memory/2026-11-10-Deploy.md', '下午的部署记录')
    file(`openclaw/.openclaw/workspace/memory/2026-11-12-a--${'x'.repeat(80)}.md`, '名字很长的')
    file('openclaw/.openclaw/workspace/memory/notes.md', '不是按日期的，不读')
    const result = await run(['--from', 'openclaw', '--dry-run'])
    expect(result.text).toContain('新建  app://cc/openclaw/notes/m-')
    expect(result.text).toContain('新建  app://cc/openclaw/journal/2026-11-10\n')
    expect(result.text).toContain('新建  app://cc/openclaw/journal/2026-11-10-deploy\n')
    expect(result.text).toContain('2026-11-10 的笔记\n')
    expect(result.text).toContain('2026-11-10 的笔记（Deploy）')
    // 坐标里的一段和别的来源一样规整：连着的连字符并成一个，不超过 64 个字符
    expect(result.text).toContain(
      `新建  app://cc/openclaw/journal/2026-11-12-a-${'x'.repeat(51)}\n`,
    )
    expect(result.text).toContain('新建 4 条')
  })

  it('Hermes：文件里插一条、删一条之后，别的条的坐标不变，再运行只写新的那条', async () => {
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

  it('两个来源迁进同一个应用时不落到同一个坐标', async () => {
    env.HERMES_HOME = join(dir, 'hermes')
    env.OPENCLAW_HOME = join(dir, 'openclaw')
    file('hermes/memories/MEMORY.md', '同一段话')
    file('openclaw/.openclaw/workspace/MEMORY.md', '同一段话')
    await run(['--from', 'hermes', '--yes'])
    const second = await run(['--from', 'openclaw', '--yes'])
    expect(second.text).toContain('新建 1 条')
    expect(new Set(writes().map((r) => r.body.uri)).size).toBe(2)
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
    expect(writes().map((r) => r.body.uri)).toEqual(['user://about/x-code-kioku/ok'])
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
    const bodies = Object.fromEntries(writes().map((r) => [r.body.uri, r.body.content]))
    expect(bodies['user://about/x-code-kioku/rule']).toBe(
      '第一段\n\n---\n\n第二段\n| a | b |\n|---|---|',
    )
    expect(bodies['user://projects/x-code-kioku/plain']).toBe('---\n\n只是以分隔线开头')
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

  it('同名的 user 类记忆在不同项目里各有各的坐标；相对路径和绝对路径算出同一个项目名', async () => {
    memory('-x-code-kioku', 'role', 'user', '甲')
    memory('-x-code-other', 'role', 'user', '乙')
    const all = await run(['--from', 'claude-code', '--yes'])
    expect(all.text).toContain('新建 2 条')
    requests = []
    const cwd = process.cwd()
    process.chdir(join(dir, 'claude/projects/-x-code-kioku/memory'))
    try {
      const relative = await run(['--from', 'claude-code', '--path', '.', '--yes'])
      expect(relative.text).toContain('已有，内容一样  user://about/x-code-kioku/role')
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
    rejects.set('user://about/x-code-kioku/b', { drop: true })
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
    await expect(run(['--from', 'claude-code', '--platform', 'claude-code'])).rejects.toThrow(
      UsageError,
    )
    mkdirSync(join(dir, 'kioku'))
    writeFileSync(
      join(dir, 'kioku', 'pi.json'),
      JSON.stringify({ serverUrl: base, apiKey: 'kioku_pi_key' }),
    )
    const result = await run(['--from', 'claude-code', '--platform', 'pi', '--yes'])
    expect(result.code).toBe(0)
    expect(requests.every((r) => r.auth === 'Bearer kioku_pi_key')).toBe(true)
  })
})
