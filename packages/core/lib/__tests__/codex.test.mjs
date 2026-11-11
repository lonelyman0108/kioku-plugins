import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { doctor } from '../doctor.mjs'
import { KiokuFailure } from '../http.mjs'
import { setup } from '../setup.mjs'
import { UsageError } from '../usage.mjs'
import { mode } from './fakeCommand.mjs'

const KEY = 'kioku_test_key'
const WHO = {
  app: { id: 'a', slug: 'codex', name: 'Codex', runtimeFamily: 'codex' },
  scopes: {
    readLayers: ['core'],
    writeLayers: ['app'],
    maxSensitivity: 'internal',
    credentials: 'none',
  },
}

let server
let base
let requests = []
let reply
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    const { status, body } = reply()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? {}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
let toml
let profile
beforeEach(() => {
  requests = []
  reply = () => ({ status: 200, body: WHO })
  dir = mkdtempSync(join(tmpdir(), 'kioku-codex-setup-'))
  mkdirSync(join(dir, 'codex'))
  env = { CODEX_HOME: join(dir, 'codex'), KIOKU_CONFIG_DIR: join(dir, 'kioku') }
  toml = join(dir, 'codex', 'config.toml')
  profile = join(dir, 'kioku', 'codex.json')
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
  const code = await command(args, io)
  return { code, text }
}
const block = (url, key = KEY) =>
  [
    '[mcp_servers.kioku]',
    `url = "${url}/v1/mcp"`,
    '',
    '[mcp_servers.kioku.http_headers]',
    `Authorization = "Bearer ${key}"`,
    '',
  ].join('\n')

describe('kioku setup codex', () => {
  it('核对访问密钥，写下地址与访问密钥，在 config.toml 末尾加上 MCP 服务，别的内容不动', async () => {
    const original = 'model = "x"\n\n[mcp_servers.other]\nurl = "http://127.0.0.1:1/mcp"\n'
    writeFileSync(toml, original, { mode: 0o640 })
    const result = await run(setup, ['codex', '--server-url', `${base}/`])
    expect(result.code).toBe(0)
    expect(requests.map((r) => [r.url, r.headers.authorization])).toEqual([
      ['/v1/whoami', `Bearer ${KEY}`],
    ])
    expect(result.text).toContain('✓ 访问密钥可用：应用 Codex，运行时 codex')
    expect(result.text).toContain(`mcp_servers.kioku：（未设置） → ${base}/v1/mcp`)
    expect(result.text).toContain('codex plugin add kioku@kioku')
    expect(result.text).not.toContain(KEY)
    expect(readFileSync(toml, 'utf8')).toBe(`${original}\n${block(base)}`)
    expect(statSync(toml).mode & 0o777).toBe(mode(0o640))
    expect(readFileSync(`${toml}.kioku-backup`, 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(profile, 'utf8'))).toEqual({ serverUrl: base, apiKey: KEY })
    expect(statSync(profile).mode & 0o777).toBe(mode(0o600))
    expect(statSync(join(dir, 'kioku')).mode & 0o777).toBe(mode(0o700))
  })

  it('没有 config.toml 时新建；再运行一次什么都不改', async () => {
    await run(setup, ['codex', '--server-url', base])
    expect(readFileSync(toml, 'utf8')).toBe(block(base))
    const before = statSync(toml).mtimeMs
    const again = await run(setup, ['codex'], { key: '' })
    expect(again.text).toContain('不用改')
    expect(statSync(toml).mtimeMs).toBe(before)
    expect(readdirSync(join(dir, 'codex'))).toEqual(['config.toml'])
  })

  it('换地址或访问密钥时去掉原来的那一段、加在最后，别的段与换行符不变', async () => {
    const crlf = (text) => text.replaceAll('\n', '\r\n')
    writeFileSync(toml, crlf(`a = 1\n\n${block('http://old.example.com', 'old')}\n[z]\nb = 2\n`))
    const result = await run(setup, ['codex', '--server-url', base, '--no-check'])
    expect(requests).toHaveLength(0)
    expect(result.text).toContain(
      `mcp_servers.kioku：http://old.example.com/v1/mcp → ${base}/v1/mcp`,
    )
    expect(readFileSync(toml, 'utf8')).toBe(crlf(`a = 1\n\n[z]\nb = 2\n\n${block(base)}`))
  })

  it('Codex 自己重写过 config.toml 之后（后面多了别的段、请求头写成行内表）照样认得，不碰别的段', async () => {
    const rest = '[marketplaces.kioku]\nsource = "x"\n\n[plugins."kioku@kioku"]\nenabled = true\n'
    const rewritten = `[mcp_servers.kioku]\nurl = "${base}/v1/mcp"\nhttp_headers = { Authorization = "Bearer ${KEY}" }\n\n${rest}`
    writeFileSync(toml, rewritten)
    mkdirSync(join(dir, 'kioku'))
    writeFileSync(profile, JSON.stringify({ serverUrl: base, apiKey: KEY }))
    // 同一个地址与访问密钥：不改
    const same = await run(setup, ['codex', '--no-check'], { key: '' })
    expect(same.text).toContain('不用改')
    expect(same.text).not.toContain('接下来在 Codex 这一边')
    expect(readFileSync(toml, 'utf8')).toBe(rewritten)
    // 换访问密钥：只换这个服务的那几行
    const rotated = await run(setup, ['codex', '--no-check'], { key: 'new_key' })
    expect(rotated.text).toContain('mcp_servers.kioku：换访问密钥')
    expect(rotated.text).not.toContain('new_key')
    expect(readFileSync(toml, 'utf8')).toBe(`${rest}\n${block(base, 'new_key')}`)
    // 撤销：别的段还在
    await run(setup, ['codex', '--undo'])
    expect(readFileSync(toml, 'utf8')).toBe(rest)
  })

  it('关掉 Memories：[features] 段里的与写在最前面的都认，别的段里同名的不动', async () => {
    writeFileSync(
      toml,
      '[other]\nmemories = true\n\n[features]\nhooks = true\nmemories = true # 注释\n',
    )
    const result = await run(setup, ['codex', '--server-url', base])
    expect(result.text).toContain('features.memories：true → false')
    expect(readFileSync(toml, 'utf8')).toContain(
      '[other]\nmemories = true\n\n[features]\nhooks = true\nmemories = false # 注释\n',
    )

    writeFileSync(toml, 'features.memories = true\n')
    await run(setup, ['codex', '--server-url', base])
    expect(readFileSync(toml, 'utf8')).toMatch(/^features\.memories = false\n/)
  })

  it('访问密钥里的引号与反斜杠在 TOML 里转义，读回来还是原样', async () => {
    const odd = 'k"e\\y'
    await run(setup, ['codex', '--server-url', base, '--no-check'], { key: odd })
    expect(readFileSync(toml, 'utf8')).toContain('Authorization = "Bearer k\\"e\\\\y"')
    // 再运行一次认得出是同一个，不改
    const again = await run(setup, ['codex', '--no-check'], { key: '' })
    expect(again.text).toContain('不用改')
  })

  it('核对不过（访问密钥无效、连不上）时什么都不写', async () => {
    reply = () => ({ status: 401, body: {} })
    await expect(run(setup, ['codex', '--server-url', base])).rejects.toThrow(
      '访问密钥无效或已吊销',
    )
    await expect(run(setup, ['codex', '--server-url', 'http://127.0.0.1:1'])).rejects.toThrow(
      /无法连接/,
    )
    expect(readdirSync(dir)).toEqual(['codex'])
    expect(readdirSync(join(dir, 'codex'))).toEqual([])
  })

  it('应用的运行时不是 codex 时提醒，照常写', async () => {
    reply = () => ({
      status: 200,
      body: { ...WHO, app: { ...WHO.app, runtimeFamily: 'claudecode' } },
    })
    const result = await run(setup, ['codex', '--server-url', base])
    expect(result.text).toContain('! 这个应用的运行时不是 codex')
    expect(readFileSync(toml, 'utf8')).toBe(block(base))
  })

  it('已有手写的同名 MCP 服务时换成 setup 的写法，改动里写出原来的地址', async () => {
    writeFileSync(toml, '[mcp_servers.kioku]\nurl = "http://127.0.0.1:1/other"\nenabled = false\n')
    const result = await run(setup, ['codex', '--server-url', base])
    expect(result.text).toContain(`mcp_servers.kioku：http://127.0.0.1:1/other → ${base}/v1/mcp`)
    expect(readFileSync(toml, 'utf8')).toBe(block(base))
    expect(readFileSync(`${toml}.kioku-backup`, 'utf8')).toContain('enabled = false')
  })

  it('访问密钥、地址里有换行这类字符时在写文件、发请求之前就拦下', async () => {
    for (const key of ['kk_abc\nnote', 'kk\u0015abc', 'a\tb']) {
      await expect(run(setup, ['codex', '--server-url', base], { key })).rejects.toThrow('格式不对')
      await expect(
        run(setup, ['codex', '--server-url', base, '--no-check'], { key }),
      ).rejects.toThrow('格式不对')
    }
    for (const url of [`${base}/a\nb`, `http://127.0.0.1\t:1`, 'http://a b']) {
      await expect(run(setup, ['codex', '--server-url', url, '--no-check'])).rejects.toThrow(
        '空白或控制字符',
      )
    }
    expect(requests).toHaveLength(0)
    expect(readdirSync(dir)).toEqual(['codex'])
    expect(readdirSync(join(dir, 'codex'))).toEqual([])
  })

  it('段名的等价写法（带引号、点两边有空白）认作同一个服务，换掉而不是再加一段', async () => {
    for (const header of [
      '[mcp_servers."kioku"]',
      "[ mcp_servers . 'kioku' ]",
      '[mcp_servers.kioku] # 注释',
    ]) {
      writeFileSync(
        toml,
        `a = 1\n\n${header}\nurl = "http://old.example.com/v1/mcp"\n\n[mcp_servers."kioku".http_headers]\nAuthorization = "Bearer old"\n`,
      )
      await run(setup, ['codex', '--server-url', base, '--no-check'])
      expect(readFileSync(toml, 'utf8'), header).toBe(`a = 1\n\n${block(base)}`)
    }
  })

  it('用行内表或带点的键定义的 kioku 服务按行认不出范围：不动 config.toml', async () => {
    for (const original of [
      'mcp_servers.kioku.url = "http://127.0.0.1:1"\n',
      'mcp_servers."kioku" = { url = "http://127.0.0.1:1" }\n',
      'mcp_servers = { kioku = { url = "http://127.0.0.1:1" } }\n',
      '[mcp_servers]\nkioku = { url = "http://127.0.0.1:1" }\n',
      '[mcp_servers]\n"kioku".url = "http://127.0.0.1:1"\n',
    ]) {
      writeFileSync(toml, original)
      await expect(
        run(setup, ['codex', '--server-url', base], { key: KEY }),
        original,
      ).rejects.toThrow('没有改动它')
      // 地址没给时先报用法错误，不先报这个
      await expect(run(setup, ['codex']), original).rejects.toThrow(UsageError)
      expect(readFileSync(toml, 'utf8')).toBe(original)
      const checked = await run(doctor, ['codex'])
      expect(checked.text).toContain('用了行内表或带点的键')
    }
    // 名字里带着 kioku 的别的服务不算
    writeFileSync(
      toml,
      '[mcp_servers]\nkioku_old = { url = "x" }\n\n[mcp_servers.kioku2]\nurl = "y"\n',
    )
    await run(setup, ['codex', '--server-url', base, '--no-check'])
    expect(readFileSync(toml, 'utf8')).toContain(
      '[mcp_servers.kioku2]\nurl = "y"\n\n[mcp_servers.kioku]',
    )
  })

  it('多行数组里单独成行的方括号不当成段的标题；别处的空行、紧跟在后面的注释都不动', async () => {
    const original = [
      '[features]',
      'list = [',
      '  [1, 2],',
      '  [3]',
      ']',
      'memories = true',
      '',
      '',
      '[mcp_servers.kioku]',
      'args = [',
      '  [1]',
      ']',
      'url = "http://old.example.com/v1/mcp"',
      '',
      '# 下面这个是另一个服务',
      '[mcp_servers.other]',
      'url = "z"',
      '',
    ].join('\n')
    writeFileSync(toml, original)
    await run(setup, ['codex', '--server-url', base, '--no-check'])
    expect(readFileSync(toml, 'utf8')).toBe(
      [
        '[features]',
        'list = [',
        '  [1, 2],',
        '  [3]',
        ']',
        'memories = false',
        '',
        '',
        '# 下面这个是另一个服务',
        '[mcp_servers.other]',
        'url = "z"',
        '',
        block(base),
      ].join('\n'),
    )
  })

  it('config.toml 里已经写着访问密钥时不留备份：换访问密钥、撤销之后旧的不留在备份里', async () => {
    await run(setup, ['codex', '--server-url', base])
    await run(setup, ['codex', '--no-check'], { key: 'second_key' })
    expect(readdirSync(join(dir, 'codex'))).toEqual(['config.toml'])
    await run(setup, ['codex', '--undo'])
    expect(readdirSync(join(dir, 'codex'))).toEqual(['config.toml'])
    expect(readFileSync(toml, 'utf8')).toBe('')
  })

  it('--undo 一起删掉钩子记下的用户输入', async () => {
    await run(setup, ['codex', '--server-url', base])
    const fallback = join(dir, 'kioku', 'codex-state', 'turns')
    const data = join(dir, 'codex', 'plugins', 'data', 'kioku-kioku', 'turns')
    const other = join(dir, 'codex', 'plugins', 'data', 'other-x', 'turns')
    for (const turns of [fallback, data, other]) {
      mkdirSync(turns, { recursive: true })
      writeFileSync(join(turns, 'turn.s.t.json'), '{}')
    }
    await run(setup, ['codex', '--undo'])
    expect(readdirSync(join(dir, 'kioku'))).toEqual([])
    expect(readdirSync(join(dir, 'codex', 'plugins', 'data', 'kioku-kioku'))).toEqual([])
    expect(readdirSync(other)).toEqual(['turn.s.t.json'])
  })

  it('改动里的地址只写协议、主机与路径，不带账号密码与查询参数', async () => {
    writeFileSync(
      toml,
      '[mcp_servers.kioku]\nurl = "https://user:hunter-22@old.example.com/v1/mcp?token=abc"\n',
    )
    const result = await run(setup, ['codex', '--server-url', base, '--dry-run'])
    expect(result.text).toContain(
      `mcp_servers.kioku：https://old.example.com/v1/mcp → ${base}/v1/mcp`,
    )
    expect(result.text).not.toMatch(/hunter-22|token=abc/)
    writeFileSync(toml, '[mcp_servers.kioku]\ncommand = "x"\n')
    expect((await run(setup, ['codex', '--server-url', base, '--dry-run'])).text).toContain(
      'mcp_servers.kioku：（认不出的写法） →',
    )
  })

  it('features 写成行内表时认不出 Memories 的开关：提醒，不当成已经关着', async () => {
    writeFileSync(toml, 'features = { memories = true }\n')
    const result = await run(setup, ['codex', '--server-url', base])
    expect(result.text).toContain('codex features disable memories')
    const checked = await run(doctor, ['codex'])
    expect(checked.text).toContain('features 的写法认不出来')
    expect(checked.text).not.toContain('Memories 没有启用')
    // 带引号的键照样认得
    writeFileSync(toml, '[features]\n"memories" = true\n')
    await run(setup, ['codex', '--server-url', base])
    expect(readFileSync(toml, 'utf8')).toMatch(/^\[features\]\n"memories" = false\n/)
  })

  it('--dry-run 不提示输入、不发请求、不写文件', async () => {
    writeFileSync(toml, '[features]\nmemories = true\n')
    const result = await run(setup, ['codex', '--server-url', base, '--dry-run'], {
      key: '不该读到',
    })
    expect(result.text).toContain(`mcp_servers.kioku：（未设置） → ${base}/v1/mcp`)
    expect(result.text).toContain('features.memories：true → false')
    expect(result.text).toContain('没有写入')
    expect(requests).toHaveLength(0)
    expect(readFileSync(toml, 'utf8')).toBe('[features]\nmemories = true\n')
    expect(readdirSync(dir)).toEqual(['codex'])
  })

  it('--undo 去掉 MCP 服务那一段和写下的文件，别的内容不动，Memories 不重新打开', async () => {
    writeFileSync(toml, 'a = 1\n\n[features]\nmemories = false\n')
    await run(setup, ['codex', '--server-url', base])
    const result = await run(setup, ['codex', '--undo'])
    expect(readFileSync(toml, 'utf8')).toBe('a = 1\n\n[features]\nmemories = false\n')
    expect(readdirSync(join(dir, 'kioku'))).toEqual([])
    expect(result.text).toContain('codex plugin remove kioku@kioku')
    // 再来一次也不报错
    expect((await run(setup, ['codex', '--undo'])).code).toBe(0)
  })

  it('地址、访问密钥没给或不对时报错，什么都不写', async () => {
    await expect(run(setup, ['codex'])).rejects.toThrow(UsageError)
    await expect(run(setup, ['codex', '--server-url'])).rejects.toThrow(UsageError)
    await expect(run(setup, ['codex', '--server-url', base], { key: '' })).rejects.toThrow(
      '没有给访问密钥',
    )
    for (const url of [
      'ftp://x',
      '不是地址',
      'https://u:p@kioku.example.com',
      `${base}/?token=1`,
    ]) {
      await expect(run(setup, ['codex', '--server-url', url, '--no-check'])).rejects.toThrow(
        KiokuFailure,
      )
    }
    await expect(
      run(setup, ['codex', '--server-url', base, '--no-check'], { key: 'a b' }),
    ).rejects.toThrow('格式不对')
    await expect(run(setup, ['claude-code', '--server-url', base])).rejects.toThrow(UsageError)
    expect(readdirSync(dir)).toEqual(['codex'])
  })
})

describe('kioku doctor codex', () => {
  it('配好之后各项都是 ✓，地址与访问密钥取自 setup 写下的文件', async () => {
    await run(setup, ['codex', '--server-url', base])
    writeFileSync(toml, `${readFileSync(toml, 'utf8')}\n[plugins."kioku@kioku"]\nenabled = true\n`)
    requests = []
    const result = await run(doctor, ['codex'])
    expect(result.code).toBe(0)
    expect(requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(result.text).toContain(`✓ 地址 ${base}（${profile}）`)
    expect(result.text).toContain('✓ Codex 里配了 Kioku 的 MCP 服务')
    expect(result.text).toContain('✓ Codex 的 kioku 插件已启用')
    expect(result.text).toContain('✓ Codex 自带的 Memories 没有启用')
    expect(result.text).toContain('/hooks')
    expect(result.text).not.toMatch(/^[!✗]/m)
    expect(result.text).not.toContain(KEY)
  })

  it('没配过：说怎么给 Codex 配，其余各项提醒', async () => {
    writeFileSync(toml, '[features]\nmemories = true\n\n[plugins."kioku@kioku"]\nenabled = false\n')
    const result = await run(doctor, ['codex'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('✗ 还没有给 Codex 配过：运行 kioku setup codex')
    expect(result.text).toContain('! 没有 kioku setup codex 写下的地址与访问密钥')
    expect(result.text).toContain('里没有 Kioku 的 MCP 服务')
    expect(result.text).toContain('! Codex 的 kioku 插件没有启用')
    expect(result.text).toContain('! Codex 自带的 Memories 开着')
  })

  it('MCP 服务和钩子用的访问密钥对不上是 ✗', async () => {
    await run(setup, ['codex', '--server-url', base])
    writeFileSync(profile, JSON.stringify({ serverUrl: base, apiKey: 'another_key' }))
    const result = await run(doctor, ['codex'])
    expect(result.code).toBe(1)
    expect(result.text).toMatch(/^✗ .*对不上：重新运行 kioku setup codex/m)
  })
})
