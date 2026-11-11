import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findCommand, invocation } from '../command.mjs'

const windows = { platform: 'win32' }
// 假的文件系统：只有列出来的这些文件在
const only =
  (...files) =>
  (file) =>
    files.includes(file)

describe('findCommand', () => {
  it('在 PATH 里逐个目录找，先找到的算；找不到为 null', () => {
    const env = { PATH: '/a:/b:/c' }
    const posix = { platform: 'linux', exists: only('/b/tool', '/c/tool') }
    expect(findCommand('tool', env, posix)).toBe('/b/tool')
    expect(findCommand('other', env, posix)).toBeNull()
    expect(findCommand('tool', {}, posix)).toBeNull()
    expect(findCommand('', env, posix)).toBeNull()
  })

  it('名字里带目录时只看这个位置，不去 PATH 里找', () => {
    const posix = { platform: 'linux', exists: only('/x/tool', '/a/tool') }
    expect(findCommand('/x/tool', { PATH: '/a' }, posix)).toBe('/x/tool')
    expect(findCommand('/y/tool', { PATH: '/a' }, posix)).toBeNull()
  })

  it('Windows：按 PATHEXT 补扩展名，环境变量的名字不分大小写', () => {
    const env = { Path: 'C:\\a;C:\\b', PathExt: '.EXE;.CMD' }
    expect(findCommand('openclaw', env, { ...windows, exists: only('C:\\b\\openclaw.CMD') })).toBe(
      'C:\\b\\openclaw.CMD',
    )
    // 同一个目录里按 PATHEXT 的顺序，原样的名字排最前
    expect(
      findCommand('tool', env, {
        ...windows,
        exists: only('C:\\a\\tool.CMD', 'C:\\a\\tool.EXE'),
      }),
    ).toBe('C:\\a\\tool.EXE')
    expect(findCommand('tool.cmd', env, { ...windows, exists: only('C:\\a\\tool.cmd') })).toBe(
      'C:\\a\\tool.cmd',
    )
    expect(findCommand('C:\\x\\tool', env, { ...windows, exists: only('C:\\x\\tool.CMD') })).toBe(
      'C:\\x\\tool.CMD',
    )
    // 没设 PATHEXT 时用系统默认的那几个
    expect(
      findCommand('tool', { PATH: 'C:\\a' }, { ...windows, exists: only('C:\\a\\tool.CMD') }),
    ).toBe('C:\\a\\tool.CMD')
  })
})

describe('invocation', () => {
  it('别的系统、Windows 上的 .exe：原样交给系统', () => {
    expect(invocation('/a/tool', ['x y'], {}, { platform: 'linux' })).toEqual({
      file: '/a/tool',
      args: ['x y'],
      options: {},
    })
    expect(invocation('C:\\a\\hermes.exe', ['a&b'], {}, windows)).toEqual({
      file: 'C:\\a\\hermes.exe',
      args: ['a&b'],
      options: {},
    })
  })

  it('Windows 上的 .cmd：经 cmd.exe，参数里的特殊字符都转义掉，空参数留着', () => {
    const run = invocation(
      'C:\\npm\\openclaw.cmd',
      ['config', 'set', 'a b', '', 'x&calc', '50%', 'say "hi"'],
      { ComSpec: 'C:\\Windows\\cmd.exe' },
      windows,
    )
    expect(run.file).toBe('C:\\Windows\\cmd.exe')
    expect(run.options).toEqual({ windowsVerbatimArguments: true })
    expect(run.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(run.args[3]).toBe(
      '"C:\\npm\\openclaw.cmd ^"config^" ^"set^" ^"a^ b^" ^"^" ^"x^&calc^" ^"50^%^" ^"say^ \\^"hi\\^"^""',
    )
    // 没有不带 ^ 的特殊字符露在外面：& | % 不会被 cmd.exe 当成命令或变量
    expect(run.args[3].slice(1, -1)).not.toMatch(/(?<!\^)[&|%<>]/)
  })

  it('node_modules/.bin 里的 .cmd 转义两遍；没设 ComSpec 时用 cmd.exe', () => {
    const run = invocation('C:\\p\\node_modules\\.bin\\tool.cmd', ['a b'], {}, windows)
    expect(run.file).toBe('cmd.exe')
    expect(run.args[3]).toBe('"C:\\p\\node_modules\\.bin\\tool.cmd ^^^"a^^^ b^^^""')
  })
})

describe('在这台机器上真的起一次', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kioku-command-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('找到命令并把带空格、特殊字符、空的参数原样交到', () => {
    const script = join(dir, 'echo-args.js')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    // Windows 上做成 npm 那样的 .cmd，别的系统做成带 shebang 的可执行文件
    if (process.platform === 'win32') {
      writeFileSync(join(dir, 'echo-args.cmd'), `@node "${script}" %*\r\n`)
    } else {
      const bin = join(dir, 'echo-args')
      writeFileSync(bin, `#!/bin/sh\nexec node "${script}" "$@"\n`)
      chmodSync(bin, 0o755)
    }
    const env = {
      ...process.env,
      PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? process.env.Path}`,
    }
    const found = findCommand('echo-args', env)
    expect(found).not.toBeNull()
    const args = ['config', 'a b', '', 'x&y', '50%', 'say "hi"', 'back\\slash\\']
    const run = invocation(found, args, env)
    const out = execFileSync(run.file, run.args, { env, encoding: 'utf8', ...run.options })
    expect(JSON.parse(out)).toEqual(args)
  })
})
