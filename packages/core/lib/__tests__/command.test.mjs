import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { capture, envValue, findCommand, launch } from '../command.mjs'
import { KiokuFailure } from '../http.mjs'
import { fakeCommand, windowsOnly } from './fakeCommand.mjs'

const windows = { platform: 'win32' }
// 假的文件系统：只有列出来的这些文件在
const only =
  (...files) =>
  (file) =>
    files.includes(file)

describe('envValue', () => {
  it('名字不分大小写；写了几种大小写时取排序后的第一个，和 Node 交给子进程的一样', () => {
    expect(envValue({ Path: 'a' }, 'PATH')).toBe('a')
    expect(envValue({ Path: 'old', PATH: 'new' }, 'path')).toBe('new')
    expect(envValue({}, 'PATH')).toBeUndefined()
  })
})

describe('findCommand（Windows 上找命令）', () => {
  const env = { Path: 'C:\\a;"C:\\b c";C:\\d', PathExt: '.EXE;.CMD' }

  it('在 PATH 里逐个目录找，按 PATHEXT 补扩展名；目录带引号的去掉引号', () => {
    expect(findCommand('openclaw', env, { exists: only('C:\\b c\\openclaw.CMD') })).toBe(
      'C:\\b c\\openclaw.CMD',
    )
    expect(findCommand('tool', env, { exists: only('C:\\a\\tool.CMD', 'C:\\a\\tool.EXE') })).toBe(
      'C:\\a\\tool.EXE',
    )
    expect(findCommand('other', env, { exists: only('C:\\a\\tool.EXE') })).toBeNull()
    expect(findCommand('', env)).toBeNull()
  })

  it('没写扩展名时不选同名、没有扩展名的文件：那是 npm 放给 sh 用的脚本', () => {
    const npm = only('C:\\a\\openclaw', 'C:\\a\\openclaw.CMD', 'C:\\a\\openclaw.ps1')
    expect(findCommand('openclaw', env, { exists: npm })).toBe('C:\\a\\openclaw.CMD')
    expect(findCommand('openclaw', env, { exists: only('C:\\a\\openclaw') })).toBeNull()
  })

  it('写了扩展名的先找原样的；带目录的只看这个位置；没设 PATHEXT 用系统默认的', () => {
    expect(findCommand('tool.cmd', env, { exists: only('C:\\a\\tool.cmd') })).toBe(
      'C:\\a\\tool.cmd',
    )
    expect(findCommand('C:\\x\\tool', env, { exists: only('C:\\x\\tool.CMD') })).toBe(
      'C:\\x\\tool.CMD',
    )
    expect(findCommand('C:\\y\\tool', env, { exists: only('C:\\a\\tool.CMD') })).toBeNull()
    expect(findCommand('tool', { PATH: 'C:\\a' }, { exists: only('C:\\a\\tool.CMD') })).toBe(
      'C:\\a\\tool.CMD',
    )
  })
})

describe('launch', () => {
  it('别的系统上什么都不做：名字原样交给系统去找', () => {
    expect(launch('hermes', ['x y'], {}, { platform: 'linux' })).toEqual({
      file: 'hermes',
      args: ['x y'],
      options: {},
      shell: false,
    })
  })

  it('Windows：找不到为 null；.exe 直接起', () => {
    const env = { PATH: 'C:\\a' }
    expect(launch('hermes', [], env, { ...windows, exists: only() })).toBeNull()
    expect(
      launch('hermes', ['a&b'], env, { ...windows, exists: only('C:\\a\\hermes.EXE') }),
    ).toEqual({ file: 'C:\\a\\hermes.EXE', args: ['a&b'], options: {}, shell: false })
  })

  it('Windows 上的 .cmd：经 cmd.exe，参数里的特殊字符都转义掉，空参数留着', () => {
    const run = launch(
      'openclaw',
      ['config', 'set', 'a b', '', 'x&calc', '50%', 'say "hi"'],
      { PATH: 'C:\\npm', ComSpec: 'C:\\Windows\\cmd.exe' },
      { ...windows, exists: only('C:\\npm\\openclaw.CMD') },
    )
    expect(run.file).toBe('C:\\Windows\\cmd.exe')
    expect(run.shell).toBe(true)
    expect(run.options).toEqual({ windowsVerbatimArguments: true })
    expect(run.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(run.args[3]).toBe(
      '"C:\\npm\\openclaw.CMD ^"config^" ^"set^" ^"a^ b^" ^"^" ^"x^&calc^" ^"50^%^" ^"say^ \\^"hi\\^"^""',
    )
    // 没有不带 ^ 的特殊字符露在外面：& | % 不会被 cmd.exe 当成命令或变量
    expect(run.args[3].slice(1, -1)).not.toMatch(/(?<!\^)[&|%<>]/)
  })

  it('node_modules/.bin 里的 .cmd 转义两遍；没设 ComSpec 时用 cmd.exe', () => {
    const file = 'C:\\p\\node_modules\\.bin\\tool.cmd'
    const run = launch(file, ['a b'], {}, { ...windows, exists: only(file) })
    expect(run.file).toBe('cmd.exe')
    expect(run.args[3]).toBe(`"${file} ^^^"a^^^ b^^^""`)
  })

  it('经 cmd.exe 起的命令，参数里有换行就不起：cmd.exe 会把换行之后的悄悄丢掉', () => {
    const options = { ...windows, exists: only('C:\\a\\tool.CMD') }
    expect(() => launch('tool', ['a\nb'], { PATH: 'C:\\a' }, options)).toThrow(KiokuFailure)
    expect(() => launch('tool', ['a\rb'], { PATH: 'C:\\a' }, options)).toThrow(KiokuFailure)
    // 直接起的 .exe 收得到，不拦
    expect(
      launch('tool', ['a\nb'], { PATH: 'C:\\a' }, { ...windows, exists: only('C:\\a\\tool.EXE') }),
    ).not.toBeNull()
  })
})

describe('在这台机器上真的起一次', () => {
  let dir
  let env
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kioku-command-'))
    // 把目录加到 PATH 前面，沿用环境里原来那个键的写法（Windows 上可能叫 Path）
    const key = Object.keys(process.env).find((item) => item.toLowerCase() === 'path') ?? 'PATH'
    env = { ...process.env, [key]: `${dir}${delimiter}${process.env[key] ?? ''}` }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('按名字找到命令，把带空格、特殊字符、空的参数原样交到', () => {
    fakeCommand(dir, 'echo-args', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const args = ['config', 'a b', '', 'x&y', '50%', 'say "hi"', 'back\\slash\\']
    const run = launch('echo-args', args, env)
    const out = execFileSync(run.file, run.args, { env, encoding: 'utf8', ...run.options })
    expect(JSON.parse(out)).toEqual(args)
  })

  it('capture：收下输出与成败；没有这个命令时说没有', async () => {
    fakeCommand(
      dir,
      'tool',
      'console.log("out:" + process.argv[2]); console.error("err"); process.exit(process.argv[2] === "bad" ? 3 : 0)',
    )
    expect(await capture('tool', ['fine'], env)).toMatchObject({
      found: true,
      ok: true,
      stdout: expect.stringContaining('out:fine'),
    })
    const failed = await capture('tool', ['bad'], env)
    expect(failed).toMatchObject({ found: true, ok: false })
    expect(failed.output).toContain('err')
    expect(await capture('no-such-kioku-tool', [], env)).toEqual({ found: false })
  })

  it('capture：超过时限就结束命令，算失败，不一直等', async () => {
    fakeCommand(dir, 'hang', 'console.log("started"); setInterval(() => {}, 1000)')
    const started = Date.now()
    const result = await capture('hang', [], env, { timeout: 1500 })
    expect(result).toMatchObject({ found: true, ok: false })
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)

  windowsOnly('Windows：同一个目录里有 npm 放的无扩展名脚本时，起的是 .cmd', () => {
    fakeCommand(dir, 'shimmed', 'process.stdout.write("via cmd")')
    const run = launch('shimmed', [], env)
    expect(run.shell).toBe(true)
    expect(execFileSync(run.file, run.args, { env, encoding: 'utf8', ...run.options })).toBe(
      'via cmd',
    )
  })
})
