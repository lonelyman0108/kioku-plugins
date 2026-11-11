import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure } from '../http.mjs'
import { setup } from '../setup.mjs'
import { UsageError } from '../usage.mjs'

let dir
let file
let env
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kioku-setup-'))
  file = join(dir, 'settings.json')
  env = { CLAUDE_CONFIG_DIR: dir }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(args) {
  let text = ''
  const code = await setup(args, { env, out: { write: (chunk) => (text += chunk) } })
  return { code, text }
}
const saved = () => JSON.parse(readFileSync(file, 'utf8'))

describe('kioku setup claude-code', () => {
  it('停用自动记忆：只改这一项，别的设置、缩进与权限不变，留一份备份', async () => {
    const original = `{\n    "model": "x",\n    "hooks": { "Stop": [] }\n}\n`
    writeFileSync(file, original, { mode: 0o640 })
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(result.text).toContain('autoMemoryEnabled：（未设置） → false')
    expect(result.text).toContain(`${file}.kioku-backup`)
    expect(saved()).toEqual({ model: 'x', hooks: { Stop: [] }, autoMemoryEnabled: false })
    expect(readFileSync(file, 'utf8')).toContain('\n    "model"')
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(readFileSync(`${file}.kioku-backup`, 'utf8')).toBe(original)
    // 临时文件不留下
    expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.kioku-backup'])
  })

  it('没有设置文件时新建，只给本人读写，不留备份', async () => {
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(saved()).toEqual({ autoMemoryEnabled: false })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('已经停用时不写文件', async () => {
    const original = '{"autoMemoryEnabled":false}'
    writeFileSync(file, original)
    const result = await run(['claude-code'])
    expect(result.text).toContain('已停用')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('--dry-run 只显示要改什么', async () => {
    const original = '{"autoMemoryEnabled":true}'
    writeFileSync(file, original)
    const result = await run(['claude-code', '--dry-run'])
    expect(result.text).toContain('autoMemoryEnabled：true → false')
    expect(result.text).toContain('没有写入')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('--undo 去掉这一项，别的不动；环境变量仍然停用着时提醒', async () => {
    writeFileSync(file, JSON.stringify({ model: 'x', autoMemoryEnabled: false }))
    const result = await run(['claude-code', '--undo'])
    expect(result.text).toContain('autoMemoryEnabled：false → （未设置）')
    expect(result.text).not.toContain('注意')
    expect(saved()).toEqual({ model: 'x' })

    writeFileSync(file, JSON.stringify({ autoMemoryEnabled: false }))
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    const warned = await run(['claude-code', '--undo'])
    expect(warned.text).toContain('注意：环境变量 CLAUDE_CODE_DISABLE_AUTO_MEMORY仍然停用着它')
  })

  it('设置文件不是 JSON 对象时不动它', async () => {
    for (const original of ['{ 坏的', '[]', 'null', '"x"']) {
      writeFileSync(file, original)
      await expect(run(['claude-code'])).rejects.toThrow(KiokuFailure)
      expect(readFileSync(file, 'utf8')).toBe(original)
    }
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('参数不对', async () => {
    for (const args of [[], ['nope'], ['claude-code', 'codex'], ['claude-code', '--force']]) {
      await expect(run(args), args.join(' ')).rejects.toThrow(UsageError)
    }
  })
})
