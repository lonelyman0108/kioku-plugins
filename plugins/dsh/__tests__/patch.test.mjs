import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { profileFile, readProfile, writeProfile } from '../lib/profile.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
const root = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8'))

// 补丁里某一项的表达式（!!js "……"）。表达式里只用单引号，所以到行尾的双引号为止
function expression(key) {
  const match = new RegExp(`^\\s*${key}: !!js "(.*)"$`, 'm').exec(patch)
  if (!match) throw new Error(`补丁里没有 ${key} 的表达式`)
  return match[1]
}
// 照 DeepSeek Harness 的做法当成一个表达式求值；环境变量换成用例的
function evaluate(key, env) {
  const saved = process.env
  process.env = { ...env }
  try {
    return new Function(`return (${expression(key)})`)()
  } finally {
    process.env = saved
  }
}

let dir
let env
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-dsh-patch-'))
  env = { KIOKU_CONFIG_DIR: join(dir, 'kioku') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('DeepSeek Harness 的补丁', () => {
  it('根 package.json 把它登记成 bundle；插件按补丁旁边的相对路径装载', () => {
    expect(root.dsh).toEqual({ bundle: { patch: './plugins/dsh/cordis.patch.yml' } })
    expect(patch).toMatch(/^\s*name: \.\/index\.js$/m)
    expect(patch).toMatch(/^\s*name: '@deepseek-ai\/dsh-mcp-client'$/m)
    expect(patch).toMatch(/^\s*serverName: kioku$/m)
  })

  it('kioku setup dsh 写下的文件：MCP 这一行启用，地址与请求头从里面取', async () => {
    await writeProfile('dsh', { url: 'https://kioku.example.com/', key: 'kioku_test_key' }, env)
    expect(evaluate('disabled', env)).toBe(false)
    expect(evaluate('url', env)).toBe('https://kioku.example.com/v1/mcp')
    expect(evaluate('Authorization', env)).toBe('Bearer kioku_test_key')
  })

  it('找文件的规则和 profile.mjs 一样：KIOKU_CONFIG_DIR，否则 XDG 的配置目录，否则主目录下的 .config', async () => {
    for (const where of [
      { KIOKU_CONFIG_DIR: join(dir, 'a') },
      { XDG_CONFIG_HOME: join(dir, 'b') },
      { KIOKU_CONFIG_DIR: join(dir, 'c'), XDG_CONFIG_HOME: join(dir, 'unused') },
    ]) {
      await writeProfile('dsh', { url: 'https://kioku.example.com', key: 'k' }, where)
      expect(evaluate('disabled', where)).toBe(false)
      // 表达式读到的就是 profile.mjs 写的那个文件
      rmSync(profileFile('dsh', where))
      expect(evaluate('disabled', where)).toBe(true)
    }
  })

  it('手改过的文件：和 profile.mjs 读出来的一样，去掉首尾空白与结尾的斜杠', async () => {
    mkdirSync(env.KIOKU_CONFIG_DIR)
    writeFileSync(
      join(env.KIOKU_CONFIG_DIR, 'dsh.json'),
      JSON.stringify({ serverUrl: ' https://kioku.example.com// ', apiKey: 'kioku_test_key\n' }),
    )
    const read = await readProfile('dsh', env)
    expect(evaluate('disabled', env)).toBe(false)
    expect(evaluate('url', env)).toBe(`${read.url}/v1/mcp`)
    expect(evaluate('Authorization', env)).toBe(`Bearer ${read.key}`)
  })

  it('访问密钥、地址中间带着空白或换行的不收：放进请求头会出错', () => {
    mkdirSync(env.KIOKU_CONFIG_DIR)
    const file = join(env.KIOKU_CONFIG_DIR, 'dsh.json')
    for (const value of [
      { serverUrl: 'https://kioku.example.com', apiKey: 'a\nb' },
      { serverUrl: 'https://kioku.example.com', apiKey: 'a b' },
      { serverUrl: 'https://kioku .example.com', apiKey: 'k' },
      { serverUrl: 'ftp://kioku.example.com', apiKey: 'k' },
    ]) {
      writeFileSync(file, JSON.stringify(value))
      expect(evaluate('disabled', env)).toBe(true)
      expect(evaluate('Authorization', env)).toBe('')
    }
  })

  it('没有这个文件、读不懂、内容不全：这一行不启用，两个值是空的，不抛错', () => {
    const blank = () => {
      expect(evaluate('disabled', env)).toBe(true)
      expect(evaluate('url', env)).toBe('')
      expect(evaluate('Authorization', env)).toBe('')
    }
    blank()
    mkdirSync(env.KIOKU_CONFIG_DIR)
    const file = join(env.KIOKU_CONFIG_DIR, 'dsh.json')
    for (const text of [
      '{',
      'null',
      '{"serverUrl":"https://kioku.example.com"}',
      '{"serverUrl":"","apiKey":"k"}',
      '{"serverUrl":1,"apiKey":2}',
    ]) {
      writeFileSync(file, text)
      blank()
    }
  })
})
