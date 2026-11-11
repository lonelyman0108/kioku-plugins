import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Windows 没有这套权限位：文件一律是 666，「只给本人」靠用户目录自己的访问控制
const mode = (posix) => (process.platform === 'win32' ? 0o666 : posix)

const script = fileURLToPath(new URL('../shell-env.mjs', import.meta.url))
const KEY = 'kioku_test_key'
const SESSION = '0b6c1f3e-5f3a-4c47-9d1e-2a7f0c9b8e11'
const DAY = 24 * 60 * 60 * 1000

let dir
let data
let envFile
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-env-'))
  data = join(dir, 'data')
  envFile = join(dir, 'sessionstart-hook-1.sh')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// 跑一次钩子：默认配好了插件，给了 CLAUDE_ENV_FILE 与 CLAUDE_PLUGIN_DATA；env 里值为 null 的变量去掉
function hook(event = 'session.start', { env = {}, input = { session_id: SESSION } } = {}) {
  const childEnv = { ...process.env }
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith('CLAUDE_')) delete childEnv[name]
  }
  Object.assign(childEnv, {
    CLAUDE_ENV_FILE: envFile,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://kioku.example.com/',
    CLAUDE_PLUGIN_OPTION_API_KEY: KEY,
  })
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete childEnv[name]
    else childEnv[name] = value
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, event], { env: childEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}

// 用 sh 执行一遍环境文件，读出两个变量
function sourced(file) {
  return execFileSync(
    'sh',
    ['-c', '. "$1" && printf "%s\\n%s" "$KIOKU_SERVER_URL" "$KIOKU_API_KEY_FILE"', 'sh', file],
    { encoding: 'utf8' },
  ).split('\n')
}

// 在数据目录里放一个文件，修改时间是 age 毫秒以前
function plant(name, age, content = 'kioku_other_key') {
  mkdirSync(data, { recursive: true })
  const path = join(data, name)
  writeFileSync(path, content)
  const at = new Date(Date.now() - age)
  utimesSync(path, at, at)
  return path
}

describe('会话开始时给 kioku 命令配好地址与访问密钥', () => {
  it('访问密钥按会话写进权限 600 的文件，环境文件里追加两行 export，引号转义正确', async () => {
    data = join(dir, "it's data")
    const result = await hook()
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })

    const keyFile = join(data, `api-key.${SESSION}`)
    expect(readFileSync(keyFile, 'utf8')).toBe(KEY)
    expect(statSync(keyFile).mode & 0o777).toBe(mode(0o600))
    const lines = readFileSync(envFile, 'utf8')
    expect(lines).toBe(
      "export KIOKU_SERVER_URL='https://kioku.example.com'\n" +
        `export KIOKU_API_KEY_FILE='${join(dir, 'it')}'"'"'s data/api-key.${SESSION}'\n`,
    )
    // 每一行都只由引号串拼成，不用反斜杠
    expect(lines).not.toContain('\\')
    expect(lines).not.toContain(KEY)
    expect(sourced(envFile)).toEqual(['https://kioku.example.com', keyFile])
  })

  it('再来一次不重复写；环境文件原来的最后一行没有换行时另起一行', async () => {
    writeFileSync(envFile, "export OTHER='1'")
    await hook()
    await hook()
    const lines = readFileSync(envFile, 'utf8').split('\n')
    expect(lines).toEqual([
      "export OTHER='1'",
      "export KIOKU_SERVER_URL='https://kioku.example.com'",
      `export KIOKU_API_KEY_FILE='${join(data, `api-key.${SESSION}`)}'`,
      '',
    ])
    // 访问密钥改了：改名覆盖原来的文件，环境文件不变
    await hook('session.start', { env: { CLAUDE_PLUGIN_OPTION_API_KEY: 'kioku_new_key' } })
    expect(readFileSync(join(data, `api-key.${SESSION}`), 'utf8')).toBe('kioku_new_key')
    expect(readFileSync(envFile, 'utf8').split('\n')).toEqual(lines)
  })

  it('两个会话各写各的文件，互不覆盖', async () => {
    await hook()
    const other = join(dir, 'sessionstart-hook-2.sh')
    await hook('session.start', {
      env: { CLAUDE_ENV_FILE: other, CLAUDE_PLUGIN_OPTION_API_KEY: 'kioku_second_key' },
      input: { session_id: 'second-session' },
    })
    expect(readFileSync(join(data, `api-key.${SESSION}`), 'utf8')).toBe(KEY)
    expect(readFileSync(join(data, 'api-key.second-session'), 'utf8')).toBe('kioku_second_key')
    expect(sourced(other)[1]).toBe(join(data, 'api-key.second-session'))
  })

  it('会话开始时删掉超过 30 天没用过的访问密钥文件和写到一半留下的临时文件', async () => {
    const stale = plant('api-key.old-session', 31 * DAY)
    const recent = plant('api-key.recent-session', 29 * DAY)
    const leftover = plant('.api-key.123.0f0e', 2 * 60 * 1000)
    // 刚建的临时文件可能是同时开始的别的会话正在写的
    const writing = plant('.api-key.456.1a2b', 0)
    const unrelated = plant('notes.txt', 30 * DAY)
    expect((await hook()).code).toBe(0)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(leftover)).toBe(false)
    for (const path of [recent, writing, unrelated]) expect(existsSync(path)).toBe(true)
    expect(existsSync(join(data, `api-key.${SESSION}`))).toBe(true)
  })

  it('访问密钥格式不对时不写密钥文件，也不追加环境变量，报错不带访问密钥', async () => {
    const mine = plant(`api-key.${SESSION}`, 0, 'kioku_old_key')
    const result = await hook('session.start', {
      env: { CLAUDE_PLUGIN_OPTION_API_KEY: 'kioku_first_half\nkioku_second_half' },
    })
    expect(result).toEqual({
      code: 0,
      stdout: '',
      stderr:
        'Kioku kioku 命令的配置未写入：访问密钥的格式不对：只能是可见的 ASCII 字符，不能有空白\n',
    })
    expect(existsSync(mine)).toBe(false)
    expect(readdirSync(data)).toEqual([])
    expect(existsSync(envFile)).toBe(false)
  })

  it('会话结束时只删掉这个会话的访问密钥文件', async () => {
    await hook()
    const other = plant('api-key.other-session', 0)
    const result = await hook('session.end')
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(join(data, `api-key.${SESSION}`))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('插件没有配置时不写，只删掉这个会话之前写下的访问密钥文件', async () => {
    const mine = plant(`api-key.${SESSION}`, 0)
    const other = plant('api-key.other-session', 0)
    const result = await hook('session.start', { env: { CLAUDE_PLUGIN_OPTION_API_KEY: null } })
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.stderr).toBe('Kioku kioku 命令的配置未写入：插件没有配置服务地址或访问密钥\n')
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(envFile)).toBe(false)
  })

  it('没有 CLAUDE_ENV_FILE 或 CLAUDE_PLUGIN_DATA 时不写，在标准错误里说缺的是哪一个', async () => {
    const noEnvFile = await hook('session.start', { env: { CLAUDE_ENV_FILE: null } })
    expect(noEnvFile).toEqual({
      code: 0,
      stdout: '',
      stderr: 'Kioku kioku 命令的配置未写入：没有 CLAUDE_ENV_FILE\n',
    })
    expect(existsSync(join(data, `api-key.${SESSION}`))).toBe(false)

    const noData = await hook('session.start', { env: { CLAUDE_PLUGIN_DATA: null } })
    expect(noData).toEqual({
      code: 0,
      stdout: '',
      stderr: 'Kioku kioku 命令的配置未写入：没有 CLAUDE_PLUGIN_DATA\n',
    })
    expect(existsSync(envFile)).toBe(false)
  })

  it('会话标识不能直接拼进文件名时不写', async () => {
    for (const input of [{ session_id: '../escape' }, { session_id: '.hidden' }, {}, 'not json']) {
      const result = await hook('session.start', { input })
      expect(result).toMatchObject({ code: 0, stdout: '' })
      expect(result.stderr).toContain('会话标识不可用')
    }
    expect(existsSync(data) ? readdirSync(data) : []).toEqual([])
    expect(existsSync(envFile)).toBe(false)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })

  it('出错时静默：退出码 0，不写标准输出，原因只写到标准错误、不带访问密钥', async () => {
    // 插件数据目录的位置被一个文件占着
    writeFileSync(data, '')
    const blocked = await hook()
    expect(blocked).toMatchObject({ code: 0, stdout: '' })
    expect(blocked.stderr).toMatch(/^Kioku kioku 命令的配置未写入：E[A-Z]+\n$/)
    expect(existsSync(envFile)).toBe(false)

    // 环境文件所在的目录不存在
    const unwritable = await hook('session.start', {
      env: {
        CLAUDE_PLUGIN_DATA: join(dir, 'data2'),
        CLAUDE_ENV_FILE: join(dir, 'missing', 'env.sh'),
      },
    })
    expect(unwritable).toMatchObject({ code: 0, stdout: '' })
    expect(unwritable.stderr).toBe('Kioku kioku 命令的配置未写入：ENOENT\n')

    // 地址里有换行：放不进一行赋值，不写
    const newline = await hook('session.start', {
      env: {
        CLAUDE_PLUGIN_DATA: join(dir, 'data3'),
        CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://a.example.com\necho injected',
      },
    })
    expect(newline).toMatchObject({ code: 0, stdout: '' })
    expect(newline.stderr).toContain('控制字符')
    expect(existsSync(envFile)).toBe(false)
    for (const result of [blocked, unwritable, newline]) expect(result.stderr).not.toContain(KEY)
  })
})
