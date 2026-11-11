import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { mode } from './fakeCommand.mjs'

const KEY = 'kioku_test_key'
const WHO = {
  app: { id: 'a', slug: 'dsh', name: 'DeepSeek Harness', runtimeFamily: 'dsh' },
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
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(WHO))
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
  dir = mkdtempSync(join(tmpdir(), 'kioku-dsh-'))
  profile = join(dir, 'kioku', 'dsh.json')
  env = { KIOKU_CONFIG_DIR: join(dir, 'kioku'), DSH_HOME: join(dir, 'dsh') }
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
// 一个 profile 的 package.json：bundles 里列着它用的包
function dshProfile(name, bundles) {
  mkdirSync(join(dir, 'dsh', 'profiles', name), { recursive: true })
  writeFileSync(
    join(dir, 'dsh', 'profiles', name, 'package.json'),
    typeof bundles === 'string' ? bundles : JSON.stringify({ dsh: { profile: { bundles } } }),
  )
}

describe('kioku setup dsh', () => {
  it('核对后写下地址与访问密钥；没有哪个 profile 装了插件时说明怎么装', async () => {
    const result = await run(setup, ['dsh', '--server-url', `${base}/`])
    expect(result.code).toBe(0)
    expect(requests).toEqual(['/v1/whoami'])
    expect(JSON.parse(readFileSync(profile, 'utf8'))).toEqual({ serverUrl: base, apiKey: KEY })
    expect(statSync(profile).mode & 0o777).toBe(mode(0o600))
    expect(result.text).toContain('重启 dsh 后生效')
    expect(result.text).toContain(
      'dsh plugin --profile <profile> add github:lonelyman0108/kioku-plugins',
    )
    expect(result.text).not.toContain(KEY)
  })

  it('列出装了插件的 profile；读不懂的、没装的不算', async () => {
    dshProfile('web', ['@deepseek-ai/dsh-base', 'kioku-plugins'])
    dshProfile('tui', ['@deepseek-ai/dsh-base'])
    dshProfile('broken', '{')
    const result = await run(setup, ['dsh', '--server-url', base])
    expect(result.text).toContain('装了插件的 profile：web\n')
    expect(result.text).not.toContain('接下来')
  })

  it('再运行一次不用改；--dry-run 不写；--undo 删掉文件并说明怎么卸载', async () => {
    const preview = await run(setup, ['dsh', '--server-url', base, '--dry-run'])
    expect(preview.text).toContain('没有写入（--dry-run）')
    expect(existsSync(profile)).toBe(false)
    await run(setup, ['dsh', '--server-url', base])
    expect((await run(setup, ['dsh'])).text).toContain('不用改')
    const undone = await run(setup, ['dsh', '--undo'])
    expect(existsSync(profile)).toBe(false)
    expect(undone.text).toContain('dsh plugin --profile <profile> remove kioku-plugins')
    expect((await run(setup, ['dsh', '--undo'])).text).toContain('本来就没有')
  })
})

describe('kioku doctor dsh', () => {
  it('配好并装了插件时逐项打勾', async () => {
    dshProfile('web', ['kioku-plugins'])
    await run(setup, ['dsh', '--server-url', base])
    const result = await run(doctor, ['dsh'])
    expect(result.code).toBe(0)
    expect(result.text).toContain('✓ 访问密钥可用：应用 DeepSeek Harness（dsh），运行时 dsh')
    expect(result.text).toContain('✓ 装了 kioku 插件的 profile：web')
    expect(result.text).not.toContain('! ')
  })

  it('没配过、没有 profile 装插件，各提醒各的', async () => {
    const result = await run(doctor, ['dsh'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('还没有给 DeepSeek Harness 配过：运行 kioku setup dsh')
    expect(result.text).toContain('! 没有哪个 profile 装了 kioku 的插件')
  })
})
