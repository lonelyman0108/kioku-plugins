import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectPlatforms, pluginSteps, resultsText } from '../connect.mjs'
import { install, installPlan, keyVariable, parseInstallArgs } from '../install.mjs'
import { main } from '../kioku.mjs'
import { machineName } from '../login.mjs'
import { fillEnv, generateSecrets, LOCAL_SETTINGS, portBusy, writeEnvFile } from '../local.mjs'
import { actionsFor, renderPanel, scan } from '../panel.mjs'
import { readProfile } from '../profile.mjs'
import { nodeSupported } from '../prompts.mjs'
import { UsageError } from '../usage.mjs'
import { barOut, bufferOut, wizard } from '../wizard.mjs'
import { mode } from './fakeCommand.mjs'

const GRANT = {
  deviceCode: 'device-code-1',
  userCode: 'BCDF-GHJK',
  verificationPath: '/authorize',
  expiresIn: 600,
  interval: 3,
}
const app = (family) => ({ id: 'a', slug: family, name: `${family} 应用`, runtimeFamily: family })
const who = (family) => ({
  spaceId: '0f1e2d3c-0000-4000-8000-000000000000',
  app: app(family),
  scopes: { readLayers: [], writeLayers: [], maxSensitivity: 'internal', credentials: 'none' },
})

// 假的 Kioku：访问密钥写成 key-<运行时>，whoami 据此回应用；key-revoked 回 401
let server
let base
let requests
let authorize
let answers
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization })
      let reply
      if (req.url === '/v1/device/authorize') reply = authorize(body)
      else if (req.url === '/v1/device/token') {
        reply = answers.length > 1 ? answers.shift() : answers[0]
      } else if (req.url === '/v1/health')
        reply = { status: 200, body: { status: 'ok', version: '0.1.0' } }
      else if (req.url === '/v1/setup/status') reply = { status: 200, body: { needsSetup: false } }
      else if (req.url === '/v1/whoami') {
        const key = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        reply =
          key === 'key-revoked'
            ? { status: 401, body: { error: 'invalid' } }
            : { status: 200, body: who(key.replace(/^key-/, '')) }
      } else if (req.url.startsWith('/v1/memories')) reply = { status: 404, body: {} }
      else reply = { status: 404, body: {} }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body ?? {}))
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
  authorize = () => ({ status: 201, body: GRANT })
  answers = [{ status: 200, body: { status: 'pending' } }]
  dir = mkdtempSync(join(tmpdir(), 'kioku-wizard-'))
  for (const name of ['home', 'pi', 'dsh', 'codex', 'hermes', 'claude']) mkdirSync(join(dir, name))
  env = {
    HOME: join(dir, 'home'),
    PATH: '',
    KIOKU_CONFIG_DIR: join(dir, 'kioku'),
    PI_CODING_AGENT_DIR: join(dir, 'pi'),
    DSH_HOME: join(dir, 'dsh'),
    CODEX_HOME: join(dir, 'codex'),
    HERMES_HOME: join(dir, 'hermes'),
    OPENCLAW_HOME: join(dir, 'home'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function output() {
  let text = ''
  return { write: (chunk) => ((text += chunk), true), text: () => text }
}

const fast = { sleep: async () => {}, now: () => 0, open: () => {} }

describe('kioku install 的参数', () => {
  it('平台的环境变量名：大写，连字符换成下划线', () => {
    expect(keyVariable('claude-code')).toBe('KIOKU_API_KEY_CLAUDE_CODE')
    expect(keyVariable('openclaw')).toBe('KIOKU_API_KEY_OPENCLAW')
  })

  it('解析平台列表，去掉重复与空项', () => {
    const options = parseInstallArgs([
      '--platforms',
      'codex, pi,,codex',
      '--server-url',
      base,
      '-y',
    ])
    expect(options).toMatchObject({ platforms: ['codex', 'pi'], serverUrl: base, yes: true })
  })

  it('不认识的平台、没写平台、不认识的参数都报错', () => {
    expect(() => parseInstallArgs(['--platforms', 'codex,vim'])).toThrow(UsageError)
    expect(() => parseInstallArgs([])).toThrow(/要写平台/)
    expect(() => parseInstallArgs(['--platforms', ','])).toThrow(/要写平台/)
    expect(() => parseInstallArgs(['--platforms', 'pi', '--force'])).toThrow(/不认识的参数/)
  })

  it('没给访问密钥、格式不对的平台跳过并写明原因', () => {
    const plan = installPlan(['pi', 'dsh', 'codex'], {
      KIOKU_API_KEY_PI: ' key-pi ',
      KIOKU_API_KEY_DSH: 'bad key',
    })
    expect(plan[0]).toEqual({ id: 'pi', key: 'key-pi' })
    expect(plan[1].skip).toMatch(/KIOKU_API_KEY_DSH/)
    expect(plan[2].skip).toBe('没有 KIOKU_API_KEY_CODEX')
  })
})

describe('kioku install', () => {
  const run = (args, extra = {}) => {
    const out = output()
    return install(args, {
      env: { ...env, ...extra },
      out,
      cwd: dir,
      stdin: { isTTY: false },
    }).then((code) => ({ code, text: out.text() }))
  }

  it('给了访问密钥的平台写下配置，没给的跳过，最后列出装插件的命令', async () => {
    const { code, text } = await run(['--platforms', 'pi,dsh,hermes', '--server-url', base], {
      KIOKU_API_KEY_PI: 'key-pi',
      KIOKU_API_KEY_DSH: 'key-dsh',
    })
    expect(code).toBe(0)
    expect((await readProfile('pi', env)).key).toBe('key-pi')
    expect((await readProfile('dsh', env)).key).toBe('key-dsh')
    expect(text).toContain('跳过  Hermes（没有 KIOKU_API_KEY_HERMES）')
    expect(text).toContain('已接入：pi、DeepSeek Harness')
    expect(text).toContain('跳过：Hermes（没有 KIOKU_API_KEY_HERMES）')
    expect(text).toContain('pi install git:github.com/lonelyman0108/kioku-plugins')
    // 各平台 setup 自己的「接下来装上」不重复出现
    expect(text).not.toContain('接下来装上扩展')
  })

  it('--dry-run 只列计划', async () => {
    const { code, text } = await run(['--platforms', 'pi', '--server-url', base, '--dry-run'], {
      KIOKU_API_KEY_PI: 'key-pi',
    })
    expect(code).toBe(0)
    expect(text).toContain('接入  pi')
    expect(await readProfile('pi', env)).toBeNull()
  })

  it('访问密钥失效的平台算失败，退出码为 1', async () => {
    const { code, text } = await run(['--platforms', 'pi', '--server-url', base], {
      KIOKU_API_KEY_PI: 'key-revoked',
    })
    expect(code).toBe(1)
    expect(text).toContain('失败：pi（访问密钥无效或已吊销）')
  })

  it('Claude Code：核对访问密钥、停用自动记忆，地址与访问密钥留给 /plugin', async () => {
    const { code, text } = await run(['--platforms', 'claude-code', '--server-url', base], {
      KIOKU_API_KEY_CLAUDE_CODE: 'key-claudecode',
    })
    expect(code).toBe(0)
    const settings = JSON.parse(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8'))
    expect(settings.autoMemoryEnabled).toBe(false)
    expect(text).toContain('待完成：Claude Code（地址与访问密钥在 /plugin 里填）')
    expect(text).toContain('/plugin install kioku --marketplace lonelyman0108/kioku-plugins')
  })

  it('一个都没给时退出码为 1', async () => {
    const { code, text } = await run(['--platforms', 'pi', '--server-url', base])
    expect(code).toBe(1)
    expect(text).toContain('没有要接入的平台')
  })
})

describe('几个平台一起的浏览器授权', () => {
  const connect = (ids, extra = {}) => {
    const out = output()
    return connectPlatforms({ url: base, ids }, { env, out, cwd: dir, ...fast, ...extra }).then(
      (results) => ({ results, text: out.text() }),
    )
  }

  it('一次申请几个平台，签发的都写下', async () => {
    answers = [
      {
        status: 200,
        body: {
          status: 'approved',
          keys: [
            { runtimeFamily: 'pi', status: 'issued', key: 'key-pi', app: app('pi') },
            { runtimeFamily: 'dsh', status: 'issued', key: 'key-dsh', app: app('dsh') },
          ],
        },
      },
    ]
    const { results, text } = await connect(['pi', 'dsh'], { clientName: 'laptop' })
    const asked = requests.filter((r) => r.url === '/v1/device/authorize')
    expect(asked).toHaveLength(1)
    expect(asked[0].body).toEqual({
      platforms: [{ runtimeFamily: 'pi' }, { runtimeFamily: 'dsh' }],
      clientName: 'laptop',
    })
    expect(results.map((r) => r.status)).toEqual(['connected', 'connected'])
    expect((await readProfile('pi', env)).key).toBe('key-pi')
    expect((await readProfile('dsh', env)).key).toBe('key-dsh')
    expect(text).toContain('确认码：BCDF-GHJK')
    expect(text).toContain('✓ 已确认，签发了 2 个访问密钥')
    expect(text).not.toContain('key-pi')
    expect(resultsText(results)).toBe(
      '已接入：pi（应用 pi 应用）、DeepSeek Harness（应用 dsh 应用）',
    )
  })

  it('确认页上没选的算跳过，拒绝的带原因，服务端没提到的也算跳过', async () => {
    mkdirSync(join(dir, 'home', '.openclaw'))
    answers = [
      {
        status: 200,
        body: {
          status: 'approved',
          keys: [
            { runtimeFamily: 'pi', status: 'issued', key: 'key-pi', app: app('pi') },
            { runtimeFamily: 'dsh', status: 'skipped' },
            { runtimeFamily: 'codex', status: 'denied', reason: '应用\n不可用' },
            // 没申请的不收
            { runtimeFamily: 'hermes', status: 'issued', key: 'key-hermes' },
          ],
        },
      },
    ]
    const { results } = await connect(['pi', 'dsh', 'codex', 'openclaw'])
    expect(results).toEqual([
      { id: 'pi', status: 'connected', app: app('pi') },
      { id: 'dsh', status: 'skipped', reason: '确认页上没有勾选' },
      { id: 'codex', status: 'denied', reason: '应用 不可用' },
      { id: 'openclaw', status: 'skipped', reason: '确认页上没有勾选' },
    ])
    expect(await readProfile('dsh', env)).toBeNull()
    expect(existsSync(join(dir, 'hermes', '.env'))).toBe(false)
  })

  it('确认了却一个都没签发（例如确认人已停用）：每个平台都是被拒绝，不算接上', async () => {
    const reason = '确认人已不在空间或已停用'
    answers = [
      {
        status: 200,
        body: {
          status: 'approved',
          keys: [
            { runtimeFamily: 'pi', status: 'denied', reason },
            { runtimeFamily: 'dsh', status: 'denied', reason },
          ],
        },
      },
    ]
    const { results, text } = await connect(['pi', 'dsh'])
    expect(results).toEqual([
      { id: 'pi', status: 'denied', reason },
      { id: 'dsh', status: 'denied', reason },
    ])
    expect(text).toContain('✗ 已确认，但没有签发访问密钥')
    expect(text).not.toContain('✓ 已确认')
    expect(await readProfile('pi', env)).toBeNull()
    expect(resultsText(results)).toBe(`被拒绝：pi（${reason}）、DeepSeek Harness（${reason}）`)
  })

  it('机器名去掉 .local 这类后缀与控制字符', () => {
    expect(machineName('mac-mini.local')).toBe('mac-mini')
    expect(machineName('box.LAN')).toBe('box')
    expect(machineName('dev\nbox')).toBe('dev box')
    expect(machineName('a'.repeat(80))).toHaveLength(64)
  })

  it('整个申请被拒绝时每个平台都算失败', async () => {
    answers = [{ status: 200, body: { status: 'denied' } }]
    const { results } = await connect(['pi', 'dsh'])
    expect(results.every((r) => r.status === 'failed' && /拒绝/.test(r.reason))).toBe(true)
  })

  it('旧的服务端回 400：退回逐个平台申请，每个确认一次', async () => {
    authorize = (body) =>
      body.platforms ? { status: 400, body: {} } : { status: 201, body: GRANT }
    answers = [
      { status: 200, body: { status: 'approved', key: 'key-pi', app: app('pi') } },
      { status: 200, body: { status: 'approved', key: 'key-dsh', app: app('dsh') } },
    ]
    const { results, text } = await connect(['pi', 'dsh'])
    expect(text).toContain('服务端版本较旧，需要逐个确认')
    const asked = requests.filter((r) => r.url === '/v1/device/authorize').map((r) => r.body)
    expect(asked.map((b) => b.runtimeFamily ?? 'many')).toEqual(['many', 'pi', 'dsh'])
    expect(results.map((r) => r.status)).toEqual(['connected', 'connected'])
    expect((await readProfile('dsh', env)).key).toBe('key-dsh')
  })

  it('签发了却写不下的提醒去吊销；申请之前就过不了的不申请', async () => {
    rmSync(join(dir, 'hermes'), { recursive: true })
    // pi 的配置目录写不进去：放一个同名的文件
    writeFileSync(join(dir, 'kioku'), '')
    answers = [
      {
        status: 200,
        body: {
          status: 'approved',
          keys: [{ runtimeFamily: 'pi', status: 'issued', key: 'key-pi', app: app('pi') }],
        },
      },
    ]
    const { results } = await connect(['hermes', 'pi'])
    expect(results[0].status).toBe('failed')
    expect(results[0].reason).toMatch(/没有找到 Hermes 的目录/)
    expect(results[1].status).toBe('failed')
    expect(results[1].reason).toMatch(/吊销它（应用 pi 应用）/)
    const asked = requests.filter((r) => r.url === '/v1/device/authorize')
    expect(asked[0].body.platforms).toEqual([{ runtimeFamily: 'pi' }])
  })

  it('装插件的命令：装好了的不列', async () => {
    writeFileSync(
      join(dir, 'pi', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/lonelyman0108/kioku-plugins'] }),
    )
    const steps = await pluginSteps(['pi', 'codex'], { env, cwd: dir })
    expect(steps).not.toContain('pi install')
    expect(steps).toContain('Codex（在终端里运行）\n  codex plugin marketplace add')
    expect(steps).toContain('然后：打开 codex，在 /hooks 里信任')
  })
})

describe('面板', () => {
  beforeEach(async () => {
    const { writeProfile } = await import('../profile.mjs')
    await writeProfile('pi', { url: base, key: 'key-pi' }, env)
    await writeProfile('dsh', { url: base, key: 'key-revoked' }, env)
    // Codex 接在另一台连不上的服务器上
    await writeProfile('codex', { url: 'http://127.0.0.1:9', key: 'key-codex' }, env)
    writeFileSync(
      join(dir, 'hermes', '.env'),
      `KIOKU_SERVER_URL=${base}\nKIOKU_API_KEY=key-hermes\n`,
    )
    mkdirSync(join(dir, 'hermes', 'memories'))
    writeFileSync(join(dir, 'hermes', 'memories', 'MEMORY.md'), '## 甲\n一\n\n## 乙\n二\n')
    mkdirSync(join(dir, 'claude', 'projects', '-x', 'memory'), { recursive: true })
    writeFileSync(
      join(dir, 'claude', 'projects', '-x', 'memory', 'a.md'),
      '---\nname: a\ntype: user\n---\n内容\n',
    )
  })

  it('按本机的文件与服务端的回答算出每个平台的现状', async () => {
    const state = await scan({ env, cwd: dir, url: base })
    expect(state.server).toMatchObject({ url: base, reachable: true, version: '0.1.0' })
    const row = (id) => state.platforms.find((item) => item.id === id)
    expect(row('pi')).toMatchObject({
      present: true,
      connection: 'ok',
      plugin: false,
      memory: 'none',
    })
    expect(row('dsh').connection).toBe('invalid')
    expect(row('codex')).toMatchObject({ connection: 'unknown', otherServer: true, memory: 'off' })
    // 没有 hermes 命令：自带记忆查不了
    expect(row('hermes')).toMatchObject({ connection: 'ok', local: 2, memory: null, plugin: false })
    expect(row('hermes').pending).toEqual({ pending: 2, capped: false })
    expect(row('claude-code')).toMatchObject({ present: true, connection: 'manual', memory: 'on' })
    expect(row('claude-code').local).toBe(1)
    expect(row('openclaw')).toMatchObject({ present: false, connection: 'none', plugin: null })

    const text = renderPanel(state)
    expect(text).toContain(`服务器：${base}（可连接 · 版本 0.1.0）`)
    expect(text).toContain('pi：已接入 · 应用 pi 应用（pi） · 空间 0f1e2d3c')
    expect(text).toContain('DeepSeek Harness：已失效 · 访问密钥无效或已吊销')
    expect(text).toMatch(/Codex：无法判断 · http:\/\/127\.0\.0\.1:9 · 无法连接 Kioku/)
    expect(text).toContain('插件 未安装 · 自带记忆 无法判断 · 本地记忆 2 条（未迁移 2 条）')
    expect(text).toContain('Claude Code：未接入')
    expect(text).toContain('访问密钥 无法判断（在 /plugin 里填）')
    expect(text).toContain('OpenClaw：未安装')
    // 访问密钥不出现在面板上
    expect(text).not.toContain('key-')

    const actions = actionsFor(state)
    const labels = actions.map((item) => item.label)
    expect(labels).toEqual([
      '接入 Codex（1 个未接入）',
      '重新授权 DeepSeek Harness（访问密钥已失效）',
      '停用 Claude Code 的自动记忆',
      '迁移 Claude Code 的 1 条本地记忆',
      '迁移 Hermes 的 2 条本地记忆',
      '停用某个平台',
      '检查（doctor）',
      '更换服务器地址',
      '刷新',
      '退出',
    ])
  })

  it('没有服务器地址时先给本机起一个与填地址', async () => {
    const state = await scan({ env, cwd: dir, url: null })
    expect(state.server).toBeNull()
    expect(renderPanel(state)).toMatch(/^服务器：未设置/)
    const values = actionsFor(state).map((item) => item.value)
    expect(values.slice(0, 2)).toEqual(['local', 'server'])
    expect(values).not.toContain('connect')
  })

  it('服务器连不上时不给接入', async () => {
    const state = await scan({ env, cwd: dir, url: 'http://127.0.0.1:9' })
    expect(state.server.reachable).toBe(false)
    const values = actionsFor(state).map((item) => item.value)
    expect(values).toContain('local')
    expect(values).not.toContain('connect')
    expect(values).not.toContain('reauth')
  })
})

describe('本机起一个 Kioku 的 .env', () => {
  it('随机值的格式：十六进制的密码与初始化码，32 字节的 base64 主密钥', () => {
    const values = generateSecrets()
    expect(values.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    expect(values.KIOKU_DB_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    expect(values.POSTGRES_PASSWORD).not.toBe(values.KIOKU_DB_PASSWORD)
    expect(Buffer.from(values.KIOKU_MASTER_KEY, 'base64')).toHaveLength(32)
    expect(values.KIOKU_SETUP_CODE.length).toBeGreaterThanOrEqual(16)
  })

  it('照示例填：在原处填上，注释掉的也填上，没有的加在最后', () => {
    const template = '# 说明\nPOSTGRES_PASSWORD=\n# KIOKU_SETUP_CODE=\nKIOKU_BIND=0.0.0.0\n'
    const text = fillEnv(template, {
      POSTGRES_PASSWORD: 'p',
      KIOKU_SETUP_CODE: 'c',
      ...LOCAL_SETTINGS,
    })
    expect(text).toBe(
      '# 说明\nPOSTGRES_PASSWORD=p\nKIOKU_SETUP_CODE=c\nKIOKU_BIND=127.0.0.1\nKIOKU_COOKIE_SECURE=false\n',
    )
  })

  it('注释里举的例子不填，填真正的那一行', () => {
    const text = fillEnv(
      '# 例如 # KIOKU_MASTER_KEY=abc\n# KIOKU_MASTER_KEY=\nKIOKU_MASTER_KEY=\n',
      {
        KIOKU_MASTER_KEY: 'k',
      },
    )
    expect(text).toBe('# 例如 # KIOKU_MASTER_KEY=abc\n# KIOKU_MASTER_KEY=\nKIOKU_MASTER_KEY=k\n')
  })

  it('端口被占：连得上就算', async () => {
    const busy = createServer()
    await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve))
    const { port } = busy.address()
    try {
      expect(await portBusy(port)).toBe(true)
    } finally {
      await new Promise((resolve) => busy.close(resolve))
    }
    expect(await portBusy(port)).toBe(false)
  })

  it('只给本人读写，已有的不覆盖', async () => {
    const template =
      'POSTGRES_PASSWORD=\nKIOKU_DB_PASSWORD=\nKIOKU_MASTER_KEY=\n# KIOKU_SETUP_CODE=\n'
    const first = await writeEnvFile(dir, template)
    expect(first.written).toBe(true)
    expect(statSync(first.file).mode & 0o777).toBe(mode(0o600))
    const body = readFileSync(first.file, 'utf8')
    expect(body).toContain(`KIOKU_SETUP_CODE=${first.setupCode}`)
    expect(body).toContain('KIOKU_COOKIE_SECURE=false')
    const second = await writeEnvFile(dir, template)
    expect(second).toEqual({ written: false, file: first.file, setupCode: first.setupCode })
    expect(readFileSync(first.file, 'utf8')).toBe(body)
  })
})

describe('入口', () => {
  it('不在终端里时不进向导，照旧打印用法', async () => {
    const start = vi.fn(async () => 0)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await main([], { interactive: false, wizard: start })).toBe(2)
    } finally {
      write.mockRestore()
    }
    expect(start).not.toHaveBeenCalled()
  })

  it('在终端里不带参数进向导；带子命令的不进', async () => {
    const start = vi.fn(async () => 0)
    expect(await main([], { interactive: true, wizard: start })).toBe(0)
    expect(start).toHaveBeenCalledOnce()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await main(['install', '--help'], { interactive: true, wizard: start })
    } finally {
      write.mockRestore()
    }
    expect(start).toHaveBeenCalledOnce()
  })

  it('Node 的版本够不够跑交互库', () => {
    expect(nodeSupported('20.12.0')).toBe(true)
    expect(nodeSupported('20.11.1')).toBe(false)
    expect(nodeSupported('18.20.0')).toBe(false)
    expect(nodeSupported('22.1.0')).toBe(true)
  })
})

// 假的交互层：按顺序给出回答，记下显示过的东西
function fakeUi(replies) {
  const shown = []
  const next = (kind, options) => {
    shown.push({ kind, ...options })
    if (!replies.length) throw new Error(`没有准备 ${kind} 的回答`)
    return replies.shift()
  }
  const CANCEL = Symbol('cancel')
  return {
    CANCEL,
    shown,
    intro: () => {},
    outro: (text) => shown.push({ kind: 'outro', text }),
    note: (text, title) => shown.push({ kind: 'note', title, text }),
    log: {
      info: (text) => shown.push({ kind: 'info', text }),
      warn: (text) => shown.push({ kind: 'warn', text }),
      error: (text) => shown.push({ kind: 'error', text }),
    },
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    isCancel: (value) => value === CANCEL,
    select: async (options) => next('select', options),
    multiselect: async (options) => next('multiselect', options),
    confirm: async (options) => next('confirm', options),
    text: async (options) => next('text', options),
    password: async (options) => next('password', options),
  }
}

describe('向导', () => {
  const state = (connection) => ({
    server: { url: base, reachable: true, problem: null, version: '0.1.0', needsSetup: false },
    platforms: [
      {
        id: 'pi',
        name: 'pi',
        present: true,
        connection,
        plugin: false,
        memory: 'none',
        ...(connection === 'ok' ? { who: who('pi') } : {}),
      },
      {
        id: 'dsh',
        name: 'DeepSeek Harness',
        present: false,
        connection: 'none',
        plugin: false,
        memory: 'none',
      },
    ],
  })

  it('接入：选平台、看计划、确认之后一次授权，做完回到面板', async () => {
    const scans = [state('none'), state('ok')]
    const connect = vi.fn(async () => [{ id: 'pi', status: 'connected' }])
    const ui = fakeUi(['connect', ['pi'], true, 'exit'])
    const code = await wizard({
      ui,
      env,
      cwd: dir,
      out: bufferOut(),
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => scans.shift(),
        connectPlatforms: connect,
        pluginSteps: async () => '接下来自己装插件',
      },
    })
    expect(code).toBe(0)
    expect(connect).toHaveBeenCalledWith({ url: base, ids: ['pi'] }, expect.anything())
    const picker = ui.shown.find((item) => item.kind === 'multiselect')
    // 本机没发现的平台也列出来，但默认不选
    expect(picker.options.map((o) => o.value)).toEqual(['pi', 'dsh'])
    expect(picker.initialValues).toEqual(['pi'])
    const plan = ui.shown.find((item) => item.kind === 'note' && item.title === '计划')
    expect(plan.text).toContain('pi：签发访问密钥，写下配置\n')
    expect(ui.shown.find((item) => item.title === '结果').text).toBe('已接入：pi')
    // 第二次的面板上 pi 已接入，不再给接入 pi
    const menus = ui.shown.filter((item) => item.kind === 'select')
    expect(menus[1].options.map((o) => o.label)).not.toContain('接入 pi（1 个未接入）')
  })

  it('一个平台都没接上时结果里写明', async () => {
    const reason = '确认人已不在空间或已停用'
    const ui = fakeUi(['connect', ['pi'], true, 'exit'])
    await wizard({
      ui,
      env,
      cwd: dir,
      out: bufferOut(),
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => state('none'),
        connectPlatforms: async () => [{ id: 'pi', status: 'denied', reason }],
        pluginSteps: vi.fn(async () => ''),
      },
    })
    expect(ui.shown.find((item) => item.title === '结果').text).toBe(
      `一个平台都没有接上\n被拒绝：pi（${reason}）`,
    )
  })

  it('计划没有确认就不做，取消时退出', async () => {
    const connect = vi.fn()
    const ui = fakeUi([['pi'], false])
    ui.select = vi.fn().mockResolvedValueOnce('connect').mockResolvedValueOnce(ui.CANCEL)
    const code = await wizard({
      ui: { ...ui, select: ui.select },
      env,
      cwd: dir,
      out: bufferOut(),
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => state('none'),
        connectPlatforms: connect,
      },
    })
    expect(code).toBe(0)
    expect(connect).not.toHaveBeenCalled()
  })

  it('动作的失败显示出来，回到面板', async () => {
    const ui = fakeUi(['doctor', 'pi', 'exit'])
    const code = await wizard({
      ui,
      env,
      cwd: dir,
      out: bufferOut(),
      deps: {
        defaultServerUrl: async () => base,
        scan: async () => state('ok'),
        doctor: async () => {
          const { KiokuFailure } = await import('../http.mjs')
          throw new KiokuFailure('坏了')
        },
      },
    })
    expect(code).toBe(0)
    expect(ui.shown).toContainEqual({ kind: 'error', text: '坏了' })
  })

  const local = (overrides = {}) => ({
    healthy: vi.fn(async () => false),
    hasCompose: async () => true,
    portBusy: async () => false,
    prepareDir: vi.fn(async () => ({
      files: {},
      env: { written: true, file: '/x/.env', setupCode: 'setup-code-1234567' },
    })),
    composeUp: vi.fn(async () => {}),
    waitUntil: async (check) => check(),
    setupDone: async () => true,
    ...overrides,
  })

  it('本机起一个 Kioku：准备目录、启动、等就绪与初始化，接着进入接入', async () => {
    const fake = local()
    // 启动之前没有在跑的，启动之后就绪
    fake.healthy.mockResolvedValueOnce(false).mockResolvedValue(true)
    const opened = []
    const connect = vi.fn(async () => [{ id: 'pi', status: 'connected' }])
    const scans = [{ ...state('none'), server: null }, state('none'), state('ok')]
    const ui = fakeUi(['local', '~/kioku-here', true, ['pi'], true, 'exit'])
    const code = await wizard({
      ui,
      env: { ...env, HOME: '/home/someone' },
      cwd: dir,
      out: bufferOut(),
      deps: {
        defaultServerUrl: async () => null,
        scan: async () => scans.shift(),
        connectPlatforms: connect,
        pluginSteps: async () => '',
        open: (url) => opened.push(url),
        local: fake,
      },
    })
    expect(code).toBe(0)
    expect(fake.prepareDir).toHaveBeenCalledWith(resolve('/home/someone', 'kioku-here'))
    expect(fake.composeUp).toHaveBeenCalledOnce()
    expect(opened).toEqual(['http://127.0.0.1:18920'])
    const notes = ui.shown.filter((item) => item.kind === 'note').map((item) => item.text)
    expect(notes.some((text) => text.includes('初始化码：setup-code-1234567'))).toBe(true)
    expect(
      ui.shown.some((item) => item.kind === 'warn' && /KIOKU_MASTER_KEY/.test(item.text)),
    ).toBe(true)
    expect(connect).toHaveBeenCalledWith(
      { url: 'http://127.0.0.1:18920', ids: ['pi'] },
      expect.anything(),
    )
  })

  it('本机起一个 Kioku：端口被占时说明，不启动', async () => {
    const fake = local({ portBusy: async () => true })
    const ui = fakeUi(['local', 'exit'])
    await wizard({
      ui,
      env,
      cwd: dir,
      out: bufferOut(),
      deps: {
        defaultServerUrl: async () => null,
        scan: async () => ({ ...state('none'), server: null }),
        local: fake,
      },
    })
    expect(ui.shown.find((item) => item.kind === 'error').text).toMatch(/端口 18920 被别的程序占着/)
    expect(fake.prepareDir).not.toHaveBeenCalled()
    expect(fake.composeUp).not.toHaveBeenCalled()
  })

  it('输出接在竖线下面', () => {
    const out = output()
    const bar = barOut(out)
    bar.write('一\n二')
    bar.write('三\n\n')
    expect(out.text()).toBe('│  一\n│  二三\n│\n')
  })
})
