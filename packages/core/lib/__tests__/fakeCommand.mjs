// 用例里造一个假的命令行程序：source 是一段 CommonJS 的 Node 脚本（不带 shebang）。
// 别的系统上是带 shebang 的可执行文件；Windows 上照 npm 的做法做成一个 .cmd 转给 node。返回它的完整路径
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function fakeCommand(dir, name, source) {
  if (process.platform === 'win32') {
    const script = join(dir, `${name}.js`)
    writeFileSync(script, source)
    const shim = join(dir, `${name}.cmd`)
    writeFileSync(shim, `@node "${script}" %*\r\n`)
    return shim
  }
  const bin = join(dir, name)
  writeFileSync(bin, `#!/usr/bin/env node\n${source}`)
  chmodSync(bin, 0o755)
  return bin
}
