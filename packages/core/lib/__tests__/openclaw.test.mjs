import {
  chmodSync,
  existsSync,
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

const KEY = 'kioku_test_key'
const WHO = {
  app: { id: 'a', slug: 'openclaw', name: 'OpenClaw', runtimeFamily: 'openclaw' },
  scopes: {
    readLayers: ['core'],
    writeLayers: ['app'],
    maxSensitivity: 'internal',
    credentials: 'none',
  },
}
const TOOLS = [{ name: 'kioku_search', description: '搜索记忆', inputSchema: { type: 'object' } }]

let server
let base
let requests = []
let toolsStatus
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url)
    req.resume()
    req.on('end', () => {
      const mcp = req.url === '/v1/mcp'
      res.writeHead(mcp ? toolsStatus : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mcp ? { jsonrpc: '2.0', id: 1, result: { tools: TOOLS } } : WHO))
    })
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
  toolsStatus = 200
  dir = mkdtempSync(join(tmpdir(), 'kioku-openclaw-'))
  profile = join(dir, 'kioku', 'openclaw.json')
  // 假的 openclaw 命令，照实测到的样子：config set 记进一个 JSON 文件（槽位选没装的插件时失败），
  // config get --json 打印 JSON 的值、没设过时以 1 退出，plugins inspect 没装时以 1 退出
  const bin = join(dir, 'openclaw-bin')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const file = ${JSON.stringify(join(dir, 'config.json'))}
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, args.join(' ') + '\\n')
const mode = process.env.FAKE_OPENCLAW
const installed = mode !== 'not-installed'
if (mode === 'fail') process.exit(1)
if (args[0] === 'config' && args[1] === 'set') {
  if (mode === 'managed') process.exit(0)
  if (args[2] === 'plugins.slots.memory' && args[3] === 'kioku' && !installed) process.exit(1)
  data[args[2]] = args[3] === 'true' ? true : args[3]
  fs.writeFileSync(file, JSON.stringify(data))
  console.log('Updated ' + args[2] + '. Restart the gateway to apply.')
} else if (args[0] === 'config' && args[1] === 'get') {
  if (!(args[2] in data)) { console.log('Config path not found: ' + args[2]); process.exit(1) }
  console.log(JSON.stringify(data[args[2]]))
} else if (args[0] === 'plugins' && args[1] === 'inspect') {
  if (!installed) { console.log('Plugin not found: kioku.'); process.exit(1) }
  console.log('Config warnings:\\n- something')
  console.log(JSON.stringify({ plugin: { id: 'kioku', enabled: mode !== 'disabled', status: mode === 'disabled' ? 'disabled' : 'loaded', memorySlotSelected: data['plugins.slots.memory'] === 'kioku' } }))
} else process.exit(3)
`,
  )
  chmodSync(bin, 0o755)
  env = { KIOKU_CONFIG_DIR: join(dir, 'kioku'), KIOKU_OPENCLAW_BIN: bin, PATH: process.env.PATH }
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
const ACCESS = 'plugins.entries.kioku.hooks.allowConversationAccess'
const SLOT = 'plugins.slots.memory'
const settings = () =>
  existsSync(join(dir, 'config.json'))
    ? JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    : {}
const configure = (values) => writeFileSync(join(dir, 'config.json'), JSON.stringify(values))
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
const cache = () => join(dir, 'kioku', 'openclaw-tools.json')

describe('kioku setup openclaw', () => {
  it('插件装着：写下地址与访问密钥和一份工具清单，允许插件读对话，把记忆槽位选回 kioku', async () => {
    configure({ [SLOT]: 'memory-core' })
    const result = await run(setup, ['openclaw', '--server-url', `${base}/`])
    expect(result.code).toBe(0)
    expect(requests).toEqual(['/v1/whoami', '/v1/mcp'])
    expect(JSON.parse(readFileSync(profile, 'utf8'))).toEqual({ serverUrl: base, apiKey: KEY })
    expect(statSync(profile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(cache(), 'utf8'))).toMatchObject({ url: base, tools: TOOLS })
    expect(settings()).toEqual({ [ACCESS]: true, [SLOT]: 'kioku' })
    expect(result.text).toContain('OpenClaw 已配好，重启网关')
    expect(result.text).not.toContain('接下来装上插件')
    expect(result.text).toContain('只在本机入口的对话里生效')
    // 访问密钥不经过 openclaw 的命令行，也不打印
    expect(calls().join('\n')).not.toContain(KEY)
    expect(result.text).not.toContain(KEY)
  })

  it('插件还没装：只开读对话那一项，不去选槽位，说明接下来装插件', async () => {
    env.FAKE_OPENCLAW = 'not-installed'
    const result = await run(setup, ['openclaw', '--server-url', base])
    expect(result.code).toBe(0)
    expect(settings()).toEqual({ [ACCESS]: true })
    expect(calls().some((line) => line.startsWith(`config set ${SLOT}`))).toBe(false)
    expect(result.text).toContain(
      '接下来装上插件：openclaw plugins install npm:@kioku-memory/openclaw',
    )
    expect(result.text).not.toContain('已配好')
  })

  it('再运行一次：文件不用改，OpenClaw 的两项照样核对', async () => {
    await run(setup, ['openclaw', '--server-url', base])
    const before = statSync(profile).mtimeMs
    const again = await run(setup, ['openclaw'])
    expect(again.text).toContain('不用改')
    expect(statSync(profile).mtimeMs).toBe(before)
    expect(settings()).toEqual({ [ACCESS]: true, [SLOT]: 'kioku' })
  })

  it('--dry-run 只说要做什么，不写文件、不调 openclaw', async () => {
    const result = await run(setup, ['openclaw', '--server-url', base, '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.text).toContain(`${ACCESS} → true`)
    expect(result.text).toContain('没有写入（--dry-run）')
    expect(existsSync(profile)).toBe(false)
    expect(existsSync(cache())).toBe(false)
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
  })

  it('--no-check 不连 Kioku：不核对，也不取工具清单', async () => {
    const result = await run(setup, ['openclaw', '--server-url', base, '--no-check'])
    expect(result.code).toBe(0)
    expect(requests).toEqual([])
    expect(existsSync(profile)).toBe(true)
    expect(existsSync(cache())).toBe(false)
  })

  it('工具清单取不到不算失败', async () => {
    toolsStatus = 500
    const result = await run(setup, ['openclaw', '--server-url', base])
    expect(result.code).toBe(0)
    expect(existsSync(cache())).toBe(false)
    expect(result.text).toContain('OpenClaw 已配好')
  })

  it('没有 openclaw 命令：地址与访问密钥照样写下，列出要自己运行的命令', async () => {
    env.KIOKU_OPENCLAW_BIN = join(dir, 'nowhere')
    const result = await run(setup, ['openclaw', '--server-url', base])
    expect(result.code).toBe(0)
    expect(existsSync(profile)).toBe(true)
    expect(result.text).toContain('没有找到 openclaw 命令')
    expect(result.text).toContain(`openclaw config set ${ACCESS} true`)
    expect(result.text).toContain('接下来装上插件')
  })

  it('openclaw 的配置没改成（命令失败，或者成功退出却没生效）：说明已经写下了什么，列出要自己运行的', async () => {
    for (const mode of ['fail', 'managed']) {
      env.FAKE_OPENCLAW = mode
      const result = await run(setup, ['openclaw', '--server-url', base])
      expect(result.code).toBe(0)
      expect(result.text).toContain('地址与访问密钥已经写下')
      expect(result.text).toContain('OpenClaw 的配置没有改成')
      expect(result.text).toContain(`openclaw config set ${ACCESS} true`)
      expect(result.text).not.toContain('已配好')
    }
  })

  it('--undo：删掉文件与工具清单，槽位选的是 kioku 时改回自带的；换成了别的就不动', async () => {
    await run(setup, ['openclaw', '--server-url', base])
    const result = await run(setup, ['openclaw', '--undo'])
    expect(result.code).toBe(0)
    expect(existsSync(profile)).toBe(false)
    expect(existsSync(cache())).toBe(false)
    expect(settings()[SLOT]).toBe('memory-core')
    expect(result.text).toContain('openclaw plugins uninstall kioku')

    configure({ [SLOT]: 'memory-lancedb' })
    const other = await run(setup, ['openclaw', '--undo'])
    expect(other.text).toContain('现在选的不是 kioku')
    expect(other.text).toContain('本来就没有')
    expect(settings()[SLOT]).toBe('memory-lancedb')
  })

  it('--undo --dry-run 不删不改', async () => {
    await run(setup, ['openclaw', '--server-url', base])
    const result = await run(setup, ['openclaw', '--undo', '--dry-run'])
    expect(result.text).toContain(`${SLOT} → memory-core`)
    expect(existsSync(profile)).toBe(true)
    expect(settings()[SLOT]).toBe('kioku')
  })
})

describe('kioku doctor openclaw', () => {
  it('都配好时逐项打勾，并说明只在本机入口生效', async () => {
    await run(setup, ['openclaw', '--server-url', base])
    const result = await run(doctor, ['openclaw'])
    expect(result.code).toBe(0)
    expect(result.text).toContain('✓ OpenClaw 里装了 kioku 的插件')
    expect(result.text).toContain('✓ OpenClaw 的记忆槽位选的是 kioku')
    expect(result.text).toContain('✓ OpenClaw 允许 kioku 读对话')
    expect(result.text).toContain('只在本机入口的对话里生效')
    expect(result.text).not.toContain('! ')
  })

  it('没装插件、槽位被换走、没开读对话、插件没启用，各提醒各的', async () => {
    await run(setup, ['openclaw', '--server-url', base])
    env.FAKE_OPENCLAW = 'not-installed'
    expect((await run(doctor, ['openclaw'])).text).toContain(
      '! OpenClaw 里没有装 kioku 的插件：openclaw plugins install npm:@kioku-memory/openclaw',
    )
    delete env.FAKE_OPENCLAW
    configure({ [SLOT]: 'memory-core' })
    const result = await run(doctor, ['openclaw'])
    expect(result.text).toContain('! OpenClaw 的记忆槽位选的不是 kioku')
    expect(result.text).toContain('! OpenClaw 没有允许 kioku 读对话')
    env.FAKE_OPENCLAW = 'disabled'
    expect((await run(doctor, ['openclaw'])).text).toContain('没有启用或没有加载成功')
  })

  it('没配过：说运行 kioku setup openclaw；没有 openclaw 命令时说明查不了', async () => {
    env.KIOKU_OPENCLAW_BIN = join(dir, 'nowhere')
    const result = await run(doctor, ['openclaw'])
    expect(result.code).toBe(1)
    expect(result.text).toContain('还没有给 OpenClaw 配过：运行 kioku setup openclaw')
    expect(result.text).toContain('没有找到 openclaw 命令')
  })
})
