import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../shell-env.mjs', import.meta.url))
const KEY = 'kioku_test_key'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-env-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// 跑一次钩子：默认配好了插件，给了 CLAUDE_ENV_FILE 与 CLAUDE_PLUGIN_DATA；env 里值为 null 的变量去掉
function hook(env = {}) {
  const childEnv = { ...process.env }
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith('CLAUDE_')) delete childEnv[name]
  }
  Object.assign(childEnv, {
    CLAUDE_ENV_FILE: join(dir, 'sessionstart-hook-1.sh'),
    CLAUDE_PLUGIN_DATA: join(dir, 'data'),
    CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://kioku.example.com/',
    CLAUDE_PLUGIN_OPTION_API_KEY: KEY,
  })
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete childEnv[name]
    else childEnv[name] = value
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: childEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify({ session_id: 's1', source: 'startup' }))
  })
}

// 用 sh 执行一遍环境文件，读出两个变量
function sourced(envFile) {
  return execFileSync(
    'sh',
    ['-c', '. "$1" && printf "%s\\n%s" "$KIOKU_SERVER_URL" "$KIOKU_API_KEY_FILE"', 'sh', envFile],
    { encoding: 'utf8' },
  ).split('\n')
}

describe('会话开始时给 kioku 命令配好地址与访问密钥', () => {
  it('访问密钥写进权限 600 的文件，环境文件里追加两行 export，引号转义正确', async () => {
    const data = join(dir, "it's data")
    const envFile = join(dir, 'sessionstart-hook-1.sh')
    const result = await hook({ CLAUDE_PLUGIN_DATA: data })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })

    const keyFile = join(data, 'api-key')
    expect(readFileSync(keyFile, 'utf8')).toBe(KEY)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const lines = readFileSync(envFile, 'utf8')
    expect(lines).toBe(
      "export KIOKU_SERVER_URL='https://kioku.example.com'\n" +
        `export KIOKU_API_KEY_FILE='${join(dir, 'it')}'"'"'s data/api-key'\n`,
    )
    // 每一行都只由引号串拼成，不用反斜杠
    expect(lines).not.toContain('\\')
    expect(lines).not.toContain(KEY)
    expect(sourced(envFile)).toEqual(['https://kioku.example.com', keyFile])
  })

  it('再来一次不重复写；环境文件原来的最后一行没有换行时另起一行', async () => {
    const envFile = join(dir, 'sessionstart-hook-1.sh')
    writeFileSync(envFile, "export OTHER='1'")
    await hook()
    await hook()
    const lines = readFileSync(envFile, 'utf8').split('\n')
    expect(lines).toEqual([
      "export OTHER='1'",
      "export KIOKU_SERVER_URL='https://kioku.example.com'",
      `export KIOKU_API_KEY_FILE='${join(dir, 'data', 'api-key')}'`,
      '',
    ])
    // 访问密钥改了：改名覆盖原来的文件，环境文件不变
    await hook({ CLAUDE_PLUGIN_OPTION_API_KEY: 'kioku_new_key' })
    expect(readFileSync(join(dir, 'data', 'api-key'), 'utf8')).toBe('kioku_new_key')
    expect(readFileSync(envFile, 'utf8').split('\n')).toEqual(lines)
  })

  it('没有 CLAUDE_ENV_FILE 时什么都不写', async () => {
    const result = await hook({ CLAUDE_ENV_FILE: null })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(join(dir, 'data', 'api-key'))).toBe(false)
  })

  it('插件没有配置时不写，之前写下的访问密钥文件删掉', async () => {
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'api-key'), 'kioku_old_key')
    const result = await hook({ CLAUDE_PLUGIN_OPTION_API_KEY: null })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(join(dir, 'data', 'api-key'))).toBe(false)
    expect(existsSync(join(dir, 'sessionstart-hook-1.sh'))).toBe(false)
  })

  it('出错时静默：退出码 0，不写标准输出，原因只写到标准错误、不带访问密钥', async () => {
    // 插件数据目录的位置被一个文件占着
    writeFileSync(join(dir, 'data'), '')
    const blocked = await hook()
    expect(blocked).toMatchObject({ code: 0, stdout: '' })
    expect(blocked.stderr).toContain('Kioku')
    expect(blocked.stderr).not.toContain(KEY)
    expect(existsSync(join(dir, 'sessionstart-hook-1.sh'))).toBe(false)

    // 环境文件所在的目录不存在
    const unwritable = await hook({
      CLAUDE_PLUGIN_DATA: join(dir, 'data2'),
      CLAUDE_ENV_FILE: join(dir, 'missing', 'env.sh'),
    })
    expect(unwritable).toMatchObject({ code: 0, stdout: '' })
    expect(unwritable.stderr).toContain('Kioku')
    expect(unwritable.stderr).not.toContain(KEY)

    // 地址里有换行：放不进一行赋值，不写
    const newline = await hook({
      CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://a.example.com\necho injected',
    })
    expect(newline).toMatchObject({ code: 0, stdout: '' })
    expect(existsSync(join(dir, 'sessionstart-hook-1.sh'))).toBe(false)
  })
})
