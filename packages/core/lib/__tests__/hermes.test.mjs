import {
  chmodSync,
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

const KEY = 'kioku_test_key'
const WHO = {
  app: { id: 'a', slug: 'hermes', name: 'Hermes', runtimeFamily: 'hermes' },
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
    requests.push(req.url)
    const { status, body } = reply()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? {}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let home
let env
let dotenv
beforeEach(() => {
  requests = []
  reply = () => ({ status: 200, body: WHO })
  dir = mkdtempSync(join(tmpdir(), 'kioku-hermes-'))
  home = join(dir, 'hermes')
  mkdirSync(home)
  dotenv = join(home, '.env')
  // 假的 hermes 命令：config set 把值记进一个 JSON 文件，config get 读它
  const bin = join(dir, 'hermes-bin')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const file = ${JSON.stringify(join(dir, 'config.json'))}
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const [group, action, key, value] = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')
if (group !== 'config') process.exit(3)
if (process.env.FAKE_HERMES === 'fail') process.exit(1)
if (process.env.FAKE_HERMES === 'managed' && action === 'set') process.exit(0)
if (action === 'set') { data[key] = value; fs.writeFileSync(file, JSON.stringify(data)) }
else if (action === 'get') console.log('some banner\\n' + (data[key] ?? ''))
`,
  )
  chmodSync(bin, 0o755)
  env = { HERMES_HOME: home, KIOKU_HERMES_BIN: bin, PATH: process.env.PATH }
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
const settings = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')

describe('kioku setup hermes', () => {
  it('核对后把地址与访问密钥写进 Hermes 的 .env，别的行不动；让 Hermes 选 kioku 并关掉内置的记忆', async () => {
    writeFileSync(dotenv, '# 别的密钥\nOPENROUTER_API_KEY=sk-other\n\n', { mode: 0o600 })
    const result = await run(setup, ['hermes', '--server-url', `${base}/`])
    expect(result.code).toBe(0)
    expect(requests).toEqual(['/v1/whoami'])
    expect(readFileSync(dotenv, 'utf8')).toBe(
      `# 别的密钥\nOPENROUTER_API_KEY=sk-other\nKIOKU_SERVER_URL=${base}\nKIOKU_API_KEY=${KEY}\n`,
    )
    expect(statSync(dotenv).mode & 0o777).toBe(0o600)
    // .env 里都是密钥，不留备份
    expect(readdirSync(home)).toEqual(['.env'])
    expect(settings()).toEqual({
      'memory.provider': 'kioku',
      'memory.memory_enabled': 'false',
      'memory.user_profile_enabled': 'false',
    })
    expect(result.text).toContain(
      'hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes',
    )
    expect(result.text).not.toContain(KEY)
    // 访问密钥不出现在 hermes 命令的参数里
    expect(calls().join('\n')).not.toContain(KEY)
  })

  it('没有 .env 时新建，只给本人读写；换访问密钥时换掉原来的那一行；再运行一次不用改', async () => {
    await run(setup, ['hermes', '--server-url', base])
    expect(statSync(dotenv).mode & 0o777).toBe(0o600)
    writeFileSync(dotenv, `export KIOKU_API_KEY="old_key"\nA=1\nKIOKU_SERVER_URL='${base}'\n`)
    await run(setup, ['hermes'], { key: 'new_key' })
    expect(readFileSync(dotenv, 'utf8')).toBe(
      `KIOKU_API_KEY=new_key\nA=1\nKIOKU_SERVER_URL=${base}\n`,
    )
    const before = statSync(dotenv).mtimeMs
    const again = await run(setup, ['hermes'], { key: '' })
    expect(again.text).toContain('不用改')
    expect(statSync(dotenv).mtimeMs).toBe(before)
  })

  it('已经装了 provider 时不再提示安装', async () => {
    mkdirSync(join(home, 'plugins', 'kioku'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'kioku', 'plugin.yaml'), 'name: kioku\n')
    const result = await run(setup, ['hermes', '--server-url', base])
    expect(result.text).not.toContain('hermes plugins install')
  })

  it('找不到 hermes 命令时照常写 .env，把要运行的三条命令列出来', async () => {
    env.KIOKU_HERMES_BIN = join(dir, 'no-such-hermes')
    const result = await run(setup, ['hermes', '--server-url', base])
    expect(result.code).toBe(0)
    expect(readFileSync(dotenv, 'utf8')).toContain(`KIOKU_API_KEY=${KEY}`)
    for (const line of [
      'hermes config set memory.provider kioku',
      'hermes config set memory.memory_enabled false',
      'hermes config set memory.user_profile_enabled false',
    ]) {
      expect(result.text).toContain(line)
    }
  })

  it('核对不过、格式不对、没有 Hermes 的目录时什么都不写', async () => {
    reply = () => ({ status: 401 })
    await expect(run(setup, ['hermes', '--server-url', base])).rejects.toThrow(
      '访问密钥无效或已吊销',
    )
    await expect(run(setup, ['hermes', '--server-url', base], { key: 'a\nb' })).rejects.toThrow(
      '格式不对',
    )
    expect(readdirSync(home)).toEqual([])
    expect(readdirSync(dir)).not.toContain('config.json')
    env.HERMES_HOME = join(dir, 'nope')
    await expect(run(setup, ['hermes', '--server-url', base])).rejects.toThrow(KiokuFailure)
  })

  it('--dry-run 不写；--undo 去掉那两行、让 Hermes 改回内置的记忆，别的行留着', async () => {
    writeFileSync(dotenv, 'A=1\n')
    const preview = await run(setup, ['hermes', '--server-url', base, '--dry-run'])
    expect(preview.text).toContain('没有写入')
    expect(readFileSync(dotenv, 'utf8')).toBe('A=1\n')
    expect(readdirSync(dir)).not.toContain('config.json')

    await run(setup, ['hermes', '--server-url', base])
    const undone = await run(setup, ['hermes', '--undo'])
    expect(readFileSync(dotenv, 'utf8')).toBe('A=1\n')
    expect(settings()).toEqual({
      'memory.provider': '',
      'memory.memory_enabled': 'true',
      'memory.user_profile_enabled': 'true',
    })
    expect(undone.text).toContain('hermes plugins remove kioku')
  })

  it('--undo：之后换成了别的 provider 时不动 Hermes 的配置，只去掉 .env 里的两行', async () => {
    await run(setup, ['hermes', '--server-url', base])
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ 'memory.provider': 'mem0', 'memory.memory_enabled': 'false' }),
    )
    const undone = await run(setup, ['hermes', '--undo'])
    expect(undone.text).toContain('不是 kioku，它的配置没有动')
    expect(settings()).toEqual({ 'memory.provider': 'mem0', 'memory.memory_enabled': 'false' })
    expect(readFileSync(dotenv, 'utf8')).toBe('')
  })

  it('同名的行写了几处时收拾成一处，后面的旧值不留；--undo 把它们都去掉', async () => {
    writeFileSync(
      dotenv,
      `KIOKU_API_KEY=first\nA=1\nKIOKU_SERVER_URL=${base}\nKIOKU_API_KEY=${KEY}\n`,
    )
    // 最后生效的值本来就是对的，也要收拾
    const result = await run(setup, ['hermes'], { key: '' })
    expect(result.text).toContain('写入')
    expect(readFileSync(dotenv, 'utf8')).toBe(
      `KIOKU_API_KEY=${KEY}\nA=1\nKIOKU_SERVER_URL=${base}\n`,
    )
    writeFileSync(dotenv, `KIOKU_API_KEY=a\nA=1\nKIOKU_API_KEY=b\nKIOKU_SERVER_URL=${base}\n`)
    await run(setup, ['hermes', '--undo'])
    expect(readFileSync(dotenv, 'utf8')).toBe('A=1\n')
  })

  it('.env 里没有要改的时候原样不动：不整理结尾的空行与换行符；值后面的注释不算值', async () => {
    const untouched = 'A=1\r\nB=2\n\n\n'
    writeFileSync(dotenv, untouched)
    const undone = await run(setup, ['hermes', '--undo'])
    expect(undone.text).not.toContain('去掉')
    expect(readFileSync(dotenv, 'utf8')).toBe(untouched)

    writeFileSync(dotenv, `KIOKU_SERVER_URL=${base} # 本地的\nKIOKU_API_KEY="${KEY}" # 备注\n`)
    const checked = await run(doctor, ['hermes'])
    expect(checked.text).toContain(`✓ 地址 ${base}（`)
  })

  it('Hermes 的命令失败、或者成功退出却没改成（托管的安装）：访问密钥照常写下，不抛错，把要做的列出来', async () => {
    for (const mode of ['fail', 'managed']) {
      rmSync(dotenv, { force: true })
      env.FAKE_HERMES = mode
      const result = await run(setup, ['hermes', '--server-url', base])
      expect(result.code, mode).toBe(0)
      expect(readFileSync(dotenv, 'utf8')).toContain(`KIOKU_API_KEY=${KEY}`)
      expect(result.text).toContain('地址与访问密钥已经写下')
      expect(result.text).toContain('Hermes 的配置没有改成')
      expect(result.text).toContain('hermes config set memory.provider kioku')
      expect(result.text).not.toContain('Hermes 已配好')
    }
  })
})

describe('kioku doctor hermes', () => {
  it('配好并装了 provider 时各项正常，地址与访问密钥取自 Hermes 的 .env', async () => {
    await run(setup, ['hermes', '--server-url', base])
    mkdirSync(join(home, 'plugins', 'kioku'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'kioku', 'plugin.yaml'), 'name: kioku\n')
    const result = await run(doctor, ['hermes'])
    expect(result.code).toBe(0)
    expect(result.text).toContain(`✓ 地址 ${base}（${dotenv}）`)
    expect(result.text).toContain('✓ Hermes 里装了 kioku 的记忆 provider')
    expect(result.text).toContain('✓ Hermes 选的记忆 provider 是 kioku')
    expect(result.text).toContain('✓ Hermes 内置的记忆文件已停用')
    expect(result.text).not.toMatch(/^[!✗]/m)
    expect(result.text).not.toContain(KEY)
  })

  it('没配过：说怎么给 Hermes 配，其余各项提醒', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ 'memory.provider': 'mem0', 'memory.memory_enabled': 'True' }),
    )
    const result = await run(doctor, ['hermes'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('✗ 还没有给 Hermes 配过：运行 kioku setup hermes')
    expect(result.text).toContain('! Hermes 里没有装 kioku 的记忆 provider')
    expect(result.text).toContain('! Hermes 现在选的记忆 provider 不是 kioku')
    expect(result.text).toContain('! Hermes 内置的 MEMORY.md 还开着')
  })

  it('Hermes 的配置读不出来时不下结论', async () => {
    await run(setup, ['hermes', '--server-url', base])
    env.FAKE_HERMES = 'fail'
    const result = await run(doctor, ['hermes'])
    expect(result.text).toContain('Hermes 的配置没有读出来')
    expect(result.text).not.toContain('已停用')
    expect(result.text).not.toContain('不是 kioku')
  })

  it('环境变量里配了但不对时照原样报，不说成没配过', async () => {
    env.KIOKU_SERVER_URL = 'not a url'
    env.KIOKU_API_KEY = KEY
    const result = await run(doctor, ['hermes'])
    expect(result.text).toContain('KIOKU_SERVER_URL 不是有效的地址')
    expect(result.text).not.toContain('还没有给 Hermes 配过')
  })

  it('找不到 hermes 命令时说明查不了它的配置', async () => {
    await run(setup, ['hermes', '--server-url', base])
    env.KIOKU_HERMES_BIN = join(dir, 'no-such-hermes')
    const result = await run(doctor, ['hermes'])
    expect(result.text).toContain('没有找到 hermes 命令')
    expect(result.code).toBe(0)
  })
})
