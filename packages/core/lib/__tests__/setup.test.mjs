import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KiokuFailure } from '../http.mjs'
import { setup, writeSettings } from '../setup.mjs'
import { UsageError } from '../usage.mjs'
import { mode, posixOnly } from './fakeCommand.mjs'

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
  const code = await setup(args, { env, cwd: dir, out: { write: (chunk) => (text += chunk) } })
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
    expect(statSync(file).mode & 0o777).toBe(mode(0o640))
    expect(readFileSync(`${file}.kioku-backup`, 'utf8')).toBe(original)
    // 临时文件不留下
    expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.kioku-backup'])
  })

  it('没有设置文件时新建，只给本人读写，不留备份', async () => {
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(saved()).toEqual({ autoMemoryEnabled: false })
    expect(statSync(file).mode & 0o777).toBe(mode(0o600))
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

  it('设置文件是符号链接时改它指向的文件，链接还在', async () => {
    const real = join(dir, 'dotfiles', 'settings.json')
    mkdirSync(join(dir, 'dotfiles'))
    writeFileSync(real, '{"model":"x"}\n')
    symlinkSync(real, file)
    await run(['claude-code'])
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ model: 'x', autoMemoryEnabled: false })
    expect(readdirSync(join(dir, 'dotfiles'))).toEqual(['settings.json'])
    expect(readFileSync(`${file}.kioku-backup`, 'utf8')).toBe('{"model":"x"}\n')
  })

  it('空文件与带 BOM 的文件照常读；换行符与结尾有没有换行沿用原文件', async () => {
    writeFileSync(file, '  \n')
    await run(['claude-code'])
    expect(saved()).toEqual({ autoMemoryEnabled: false })

    writeFileSync(file, '\uFEFF{\r\n  "model": "x"\r\n}')
    await run(['claude-code'])
    expect(readFileSync(file, 'utf8')).toBe(
      '{\r\n  "model": "x",\r\n  "autoMemoryEnabled": false\r\n}',
    )
  })

  it('设置目录还没有时建出来', async () => {
    env.CLAUDE_CONFIG_DIR = join(dir, 'new', 'claude')
    file = join(env.CLAUDE_CONFIG_DIR, 'settings.json')
    const result = await run(['claude-code'])
    expect(result.code).toBe(0)
    expect(saved()).toEqual({ autoMemoryEnabled: false })
  })

  it('备份只留第一份，之后再改不覆盖', async () => {
    const original = '{"model":"x"}\n'
    writeFileSync(file, original)
    await run(['claude-code'])
    const undone = await run(['claude-code', '--undo'])
    expect(undone.text).toContain('已有更早的备份，没有覆盖')
    expect(undone.text).not.toContain('原来的设置备份在')
    expect(readFileSync(`${file}.kioku-backup`, 'utf8')).toBe(original)
  })

  it('读过之后文件被别的程序改了就不写，也不留临时文件和备份', async () => {
    writeFileSync(file, '{"model":"新的"}')
    await expect(
      writeSettings(file, { autoMemoryEnabled: false }, '{"model":"旧的"}'),
    ).rejects.toThrow('刚被别的程序改过')
    expect(readFileSync(file, 'utf8')).toBe('{"model":"新的"}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
    // 读的时候没有这个文件，写的时候有了，也一样
    await expect(writeSettings(file, {}, null)).rejects.toThrow('刚被别的程序改过')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  posixOnly('写不进去时报无法写入，原文件不变', async () => {
    writeFileSync(file, '{}')
    // 目录只读：临时文件建不出来
    chmodSync(dir, 0o500)
    try {
      await expect(run(['claude-code'])).rejects.toThrow(/无法写入 .*（E[A-Z]+）/)
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(readFileSync(file, 'utf8')).toBe('{}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('项目的设置又启用了自动记忆时提醒；环境变量停用着时不提', async () => {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"autoMemoryEnabled":true}')
    const result = await run(['claude-code'])
    expect(result.text).toContain('注意：项目的 .claude/settings.local.json 又启用了它')
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = ' 1 '
    expect((await run(['claude-code'])).text).not.toContain('注意')
  })

  it('参数不对', async () => {
    for (const args of [[], ['nope'], ['claude-code', 'codex'], ['claude-code', '--force']]) {
      await expect(run(args), args.join(' ')).rejects.toThrow(UsageError)
    }
  })
})
