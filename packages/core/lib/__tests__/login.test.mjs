import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure } from '../http.mjs'
import { login } from '../login.mjs'
import { setup } from '../setup.mjs'
import { UsageError } from '../usage.mjs'

const KEY = 'kioku_issued_key'
const GRANT = {
  deviceCode: 'device-code-1',
  userCode: 'BCDF-GHJK',
  verificationPath: '/authorize',
  expiresIn: 600,
  interval: 3,
}
const WHO = {
  app: { id: 'a', slug: 'pi', name: 'pi', runtimeFamily: 'pi' },
  scopes: { readLayers: [], writeLayers: [], maxSensitivity: 'internal', credentials: 'none' },
}

// 假的 Kioku：申请、轮询与 whoami。answers 是轮询依次得到的回答，用完之后一直是最后一个
let server
let base
let requests = []
let answers
let authorize
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ url: req.url, auth: req.headers.authorization, body })
      const reply =
        req.url === '/v1/device/authorize'
          ? authorize()
          : req.url === '/v1/device/token'
            ? answers.length > 1
              ? answers.shift()
              : answers[0]
            : { status: 200, body: WHO }
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
      res.end(JSON.stringify(reply.body ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
let env
let slept
let clock
let opened
beforeEach(() => {
  requests = []
  authorize = () => ({ status: 201, body: GRANT })
  answers = [{ status: 200, body: { status: 'approved', key: KEY, app: WHO.app } }]
  slept = []
  clock = 0
  opened = []
  dir = mkdtempSync(join(tmpdir(), 'kioku-login-'))
  mkdirSync(join(dir, 'pi'))
  env = { PI_CODING_AGENT_DIR: join(dir, 'pi'), KIOKU_CONFIG_DIR: join(dir, 'kioku') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const pending = { status: 200, body: { status: 'pending' } }
function io(extra = {}) {
  let text = ''
  return {
    env,
    cwd: dir,
    out: { write: (chunk) => (text += chunk) },
    // 不真的等：记下等了多久，时钟跟着走
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
    now: () => clock,
    open: (address) => opened.push(address),
    clientName: 'laptop',
    text: () => text,
    ...extra,
  }
}
async function run(args, extra) {
  const context = io(extra)
  const code = await login(args, context)
  return { code, text: context.text() }
}
const tokenPolls = () => requests.filter((r) => r.url === '/v1/device/token')

describe('kioku login', () => {
  it('申请、显示确认码、打开确认页、等到确认后交给这个平台的 setup；访问密钥不显示', async () => {
    answers = [pending, pending, answers[0]]
    const result = await run(['pi', '--server-url', `${base}/`])
    expect(result.code).toBe(0)
    expect(requests[0]).toMatchObject({
      url: '/v1/device/authorize',
      body: { runtimeFamily: 'pi', clientName: 'laptop' },
    })
    expect(result.text).toContain('确认码：BCDF-GHJK')
    expect(result.text).toContain(`${base}/authorize`)
    // 打开的地址里不带确认码
    expect(opened).toEqual([`${base}/authorize`])
    expect(tokenPolls().map((r) => r.body)).toEqual(Array(3).fill({ deviceCode: 'device-code-1' }))
    expect(slept).toEqual([3000, 3000, 3000])
    // 拿到的访问密钥经 setup 核对后写下
    expect(requests.at(-1)).toMatchObject({ url: '/v1/whoami', auth: `Bearer ${KEY}` })
    expect(JSON.parse(readFileSync(join(dir, 'kioku', 'pi.json'), 'utf8'))).toEqual({
      serverUrl: base,
      apiKey: KEY,
    })
    expect(result.text).toContain('✓ 已确认：应用 pi（pi）')
    expect(result.text).not.toContain(KEY)
    expect(result.text).not.toContain('device-code-1')
  })

  it('--no-browser 不打开浏览器；地址沿用上次配的', async () => {
    await run(['pi', '--server-url', base])
    opened = []
    requests = []
    const again = await run(['pi', '--no-browser'])
    expect(again.code).toBe(0)
    expect(opened).toEqual([])
    expect(requests[0].url).toBe('/v1/device/authorize')
  })

  it('被拒绝、过期、一直没人确认：报错，什么都不写', async () => {
    answers = [pending, { status: 200, body: { status: 'denied' } }]
    await expect(run(['pi', '--server-url', base])).rejects.toThrow('没有签发访问密钥')
    answers = [{ status: 200, body: { status: 'expired' } }]
    await expect(run(['pi', '--server-url', base])).rejects.toThrow('申请过期了')
    // 一直待确认：到了时限就停，不无限轮询
    answers = [pending]
    requests = []
    clock = 0
    await expect(run(['pi', '--server-url', base])).rejects.toThrow('申请过期了')
    expect(tokenPolls()).toHaveLength(200)
    expect(readdirSync(dir)).toEqual(['pi'])
  })

  it('服务端嫌轮询太勤时隔久一点；连不上几次不算失败', async () => {
    answers = [{ status: 429 }, { status: 429 }, pending, answers[0]]
    await run(['pi', '--server-url', base])
    expect(slept).toEqual([3000, 4000, 5000, 5000])
  })

  it('申请不下来：旧的服务端、申请太多、响应不对、地址跳转', async () => {
    const cases = [
      [{ status: 404 }, '还不支持浏览器授权'],
      [{ status: 429 }, '待确认的申请太多'],
      [{ status: 500 }, 'HTTP 500'],
      [{ status: 201, body: { deviceCode: 'x' } }, '响应格式不对'],
      [
        { status: 201, body: { ...GRANT, verificationPath: 'https://evil.example.com/' } },
        '响应格式不对',
      ],
      [{ status: 302, headers: { location: 'https://kioku.example.com/x' } }, '返回了跳转'],
    ]
    for (const [reply, message] of cases) {
      authorize = () => reply
      await expect(run(['pi', '--server-url', base]), message).rejects.toThrow(message)
    }
    expect(opened).toEqual([])
    expect(readdirSync(dir)).toEqual(['pi'])
  })

  it('确认码、应用名里的控制字符不原样显示；机器名压成一行再报上去', async () => {
    authorize = () => ({ status: 201, body: { ...GRANT, userCode: 'BCDF\n✓ 假的一行' } })
    answers = [
      { status: 200, body: { status: 'approved', key: KEY, app: { name: '甲\n乙', slug: 'pi' } } },
    ]
    const result = await run(['pi', '--server-url', base], { clientName: 'lap\ntop‮' })
    expect(result.text).toContain('确认码：BCDF ✓ 假的一行\n')
    expect(result.text).toContain('应用 甲 乙（pi）')
    expect(requests[0].body.clientName).toBe('lap top')
  })

  it('参数：要写平台与地址；Claude Code 不走这里', async () => {
    for (const args of [[], ['nope'], ['pi', '--x'], ['pi', '--server-url'], ['claude-code']]) {
      await expect(run(args), args.join(' ')).rejects.toThrow(UsageError)
    }
    await expect(run(['pi'])).rejects.toThrow(UsageError)
    await expect(run(['pi', '--server-url', 'ftp://x'])).rejects.toThrow(KiokuFailure)
    expect(requests).toHaveLength(0)
  })
})

describe('kioku setup 没给访问密钥时改用浏览器授权', () => {
  async function runSetup(args, extra = {}) {
    let text = ''
    const code = await setup(args, {
      env,
      cwd: dir,
      out: { write: (chunk) => (text += chunk) },
      readKey: async () => '',
      ...extra,
    })
    return { code, text }
  }

  it('在终端里：提示时直接回车就走浏览器授权，拿到的访问密钥照常核对、写下', async () => {
    const asked = []
    const result = await runSetup(['pi', '--server-url', base], {
      readKey: async (options) => {
        asked.push(options.canLogin)
        return ''
      },
      login: async ({ url, id }) => {
        expect({ url, id }).toEqual({ url: base, id: 'pi' })
        return KEY
      },
    })
    expect(result.code).toBe(0)
    // 提示里会说可以直接回车
    expect(asked).toEqual([true])
    expect(JSON.parse(readFileSync(join(dir, 'kioku', 'pi.json'), 'utf8')).apiKey).toBe(KEY)
  })

  it('不在终端里（没有 login）照旧报没有给访问密钥；预览、已有访问密钥时不走', async () => {
    await expect(runSetup(['pi', '--server-url', base], { login: undefined })).rejects.toThrow(
      '没有给访问密钥',
    )
    let called = 0
    const login = async () => {
      called++
      return KEY
    }
    await runSetup(['pi', '--server-url', base, '--dry-run'], { login })
    await runSetup(['pi', '--server-url', base], { readKey: async () => 'kioku_typed', login })
    await runSetup(['pi'], { login })
    expect(called).toBe(0)
  })
})
