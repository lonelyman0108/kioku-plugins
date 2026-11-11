#!/usr/bin/env node
// 把 packages/core 的实现复制进各个插件目录。插件按目录复制安装，装好之后引用不到目录之外的文件，
// 所以共用的实现要在每个插件目录里各有一份并提交；这些副本不手改，改 packages/core 之后重新运行本脚本。
// 用法：node scripts/sync-core.mjs [--check]   --check 只比对，有不一致时列出并以退出码 1 结束

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = 'packages/core'
// 收一份副本的目录
export const TARGETS = ['plugins/claude-code', 'plugins/codex', 'plugins/pi', 'packages/cli']

// 核心里要复制的文件（相对核心目录）：lib 下的实现与 kioku 命令的入口，不含测试
function sources() {
  const lib = readdirSync(join(root, CORE, 'lib'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => `lib/${entry.name}`)
  return [...lib.sort(), 'bin/kioku']
}

// 各副本与核心不一致的地方；write 为真时顺手改成一致
export function sync({ write }) {
  const files = sources()
  const problems = []
  for (const target of TARGETS) {
    for (const file of files) {
      const wanted = readFileSync(join(root, CORE, file))
      const path = join(root, target, file)
      if (existsSync(path) && readFileSync(path).equals(wanted)) continue
      problems.push(`${target}/${file} 与 ${CORE}/${file} 不一致`)
      if (!write) continue
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, wanted)
      if (file.startsWith('bin/')) chmodSync(path, 0o755)
    }
    // 核心里已经没有的实现，副本里也去掉
    const lib = join(root, target, 'lib')
    const stale = existsSync(lib)
      ? readdirSync(lib).filter((name) => name.endsWith('.mjs') && !files.includes(`lib/${name}`))
      : []
    for (const name of stale) {
      problems.push(`${target}/lib/${name} 在 ${CORE} 里已经没有`)
      if (write) rmSync(join(lib, name))
    }
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check')
  const problems = sync({ write: !check })
  if (check && problems.length) {
    process.stderr.write(`${problems.join('\n')}\n运行 node scripts/sync-core.mjs 同步\n`)
    process.exitCode = 1
  } else if (!check) {
    process.stdout.write(problems.length ? `已同步 ${problems.length} 处\n` : '已是最新\n')
  }
}
