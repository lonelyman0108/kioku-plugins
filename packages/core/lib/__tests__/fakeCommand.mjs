// 用例里和系统有关的几样东西
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { it } from 'vitest'

// Windows 没有这套权限位：文件一律是 666，「只给本人」靠用户目录自己的访问控制
export const mode = (posix) => (process.platform === 'win32' ? 0o666 : posix)

// 只在 POSIX 上有意义、或者只在 POSIX 上做得出来的用例（信号、直接执行带 shebang 的脚本、
// 文件名里的控制字符、靠目录权限让写入失败），在 Windows 上跳过
export const posixOnly = it.skipIf(process.platform === 'win32')
export const windowsOnly = it.skipIf(process.platform !== 'win32')

// 造一个假的命令行程序：source 是一段 CommonJS 的 Node 脚本（不带 shebang）。返回它的完整路径。
// 别的系统上是带 shebang 的可执行文件；Windows 上照 npm 的做法放三样：转给 node 的 .cmd、脚本本身，
// 以及一个同名、没有扩展名的 sh 脚本（Windows 起不了它，找命令时不能选中它）
export function fakeCommand(dir, name, source) {
  if (process.platform === 'win32') {
    const script = join(dir, `${name}.js`)
    writeFileSync(script, source)
    writeFileSync(join(dir, name), `#!/bin/sh\nexec node "${script}" "$@"\n`)
    const shim = join(dir, `${name}.cmd`)
    writeFileSync(shim, `@node "${script}" %*\r\n`)
    return shim
  }
  const bin = join(dir, name)
  writeFileSync(bin, `#!/usr/bin/env node\n${source}`)
  chmodSync(bin, 0o755)
  return bin
}
