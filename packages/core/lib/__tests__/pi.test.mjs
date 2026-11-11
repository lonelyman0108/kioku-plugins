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
import { setup } from '../setup.mjs'

const KEY = 'kioku_test_key'
const WHO = {
  app: { id: 'a', slug: 'pi', name: 'pi', runtimeFamily: 'pi' },
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
let env
let profile
beforeEach(() => {
  requests = []
  reply = () => ({ status: 200, body: WHO })
  dir = mkdtempSync(join(tmpdir(), 'kioku-pi-setup-'))
  mkdirSync(join(dir, 'pi'))
  env = { PI_CODING_AGENT_DIR: join(dir, 'pi'), KIOKU_CONFIG_DIR: join(dir, 'kioku') }
  profile = join(dir, 'kioku', 'pi.json')
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

describe('kioku setup pi', () => {
  it('核对后写下地址与访问密钥，不碰 pi 的设置，提示装扩展', async () => {
    const result = await run(setup, ['pi', '--server-url', `${base}/`])
    expect(result.code).toBe(0)
    expect(requests).toEqual(['/v1/whoami'])
    expect(result.text).toContain('✓ 访问密钥可用：应用 pi，运行时 pi')
    expect(result.text).toContain('pi install git:github.com/lonelyman0108/kioku-plugins')
    expect(result.text).not.toContain(KEY)
    expect(JSON.parse(readFileSync(profile, 'utf8'))).toEqual({ serverUrl: base, apiKey: KEY })
    expect(statSync(profile).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'pi'))).toEqual([])
    // 再运行一次：不用改；已经装了扩展时不再提示
    writeFileSync(
      join(dir, 'pi', 'settings.json'),
      JSON.stringify({ packages: [{ source: 'git:github.com/lonelyman0108/kioku-plugins@main' }] }),
    )
    const again = await run(setup, ['pi'], { key: '' })
    expect(again.text).toContain('不用改')
    expect(again.text).not.toContain('pi install')
  })

  it('应用的运行时不是 pi 时提醒；核对不过时什么都不写', async () => {
    reply = () => ({ status: 200, body: { ...WHO, app: { ...WHO.app, runtimeFamily: 'codex' } } })
    expect((await run(setup, ['pi', '--server-url', base])).text).toContain(
      '! 这个应用的运行时不是 pi',
    )
    rmSync(join(dir, 'kioku'), { recursive: true })
    reply = () => ({ status: 401 })
    await expect(run(setup, ['pi', '--server-url', base])).rejects.toThrow('访问密钥无效或已吊销')
    await expect(run(setup, ['pi', '--server-url', base], { key: 'a\nb' })).rejects.toThrow(
      '格式不对',
    )
    expect(readdirSync(dir)).toEqual(['pi'])
  })

  it('--dry-run 不写；--undo 删掉写下的文件', async () => {
    const preview = await run(setup, ['pi', '--server-url', base, '--dry-run'])
    expect(preview.text).toContain('没有写入')
    expect(readdirSync(dir)).toEqual(['pi'])
    await run(setup, ['pi', '--server-url', base])
    const undone = await run(setup, ['pi', '--undo'])
    expect(undone.text).toContain('pi remove')
    expect(readdirSync(join(dir, 'kioku'))).toEqual([])
    expect((await run(setup, ['pi', '--undo'])).code).toBe(0)
  })
})

describe('kioku doctor pi', () => {
  it('配好并装了扩展时各项正常', async () => {
    await run(setup, ['pi', '--server-url', base])
    writeFileSync(
      join(dir, 'pi', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/lonelyman0108/kioku-plugins'] }),
    )
    const result = await run(doctor, ['pi'])
    expect(result.code).toBe(0)
    expect(result.text).toContain(`✓ 地址 ${base}（${profile}）`)
    expect(result.text).toContain('✓ pi 里装了 kioku 的扩展')
    expect(result.text).not.toMatch(/^[!✗]/m)
  })

  it('只装在项目里的扩展认得出；项目的 mcp.json 里有同名的服务也提醒', async () => {
    await run(setup, ['pi', '--server-url', base])
    mkdirSync(join(dir, '.pi'))
    writeFileSync(
      join(dir, '.pi', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/lonelyman0108/kioku-plugins'] }),
    )
    const clean = await run(doctor, ['pi'])
    expect(clean.text).toContain('✓ pi 里装了 kioku 的扩展')
    expect(clean.text).toContain('✓ MCP 服务由扩展在会话开始时注册')
    writeFileSync(join(dir, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { kioku: {} } }))
    const shadowed = await run(doctor, ['pi'])
    expect(shadowed.text).toContain(
      `! ${join(dir, '.pi', 'mcp.json')} 里有一个叫 kioku 的 MCP 服务`,
    )
  })

  it('没配、没装、mcp.json 里有同名的服务时分别提醒', async () => {
    writeFileSync(
      join(dir, 'pi', 'mcp.json'),
      JSON.stringify({ mcpServers: { kioku: { url: 'x' } } }),
    )
    const result = await run(doctor, ['pi'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('! 没有 kioku setup pi 写下的地址与访问密钥')
    expect(result.text).toContain('! pi 里没有装 kioku 的扩展')
    expect(result.text).toContain('会盖过扩展注册的那个')
  })
})
