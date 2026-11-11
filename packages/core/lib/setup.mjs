// kioku setup：停用平台自带的长期记忆，由 Kioku 接管。只改平台的用户设置里的那几项，
// 改之前显示要改什么、留一份备份；--undo 只把这几项改回去，不动设置里的其他内容

import { randomUUID } from 'node:crypto'
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'

import { errorKind, KiokuFailure } from './http.mjs'
import { platformNames, PLATFORMS } from './platforms.mjs'
import { UsageError } from './usage.mjs'

export const SETUP_USAGE = `用法：kioku setup <平台> [--dry-run] [--undo]

停用平台自带的长期记忆，由 Kioku 接管；只改平台的用户设置里和它有关的几项。

  <平台>     ${platformNames()}
  --dry-run  只显示要改什么，不写文件
  --undo     把这几项改回默认，重新启用平台自带的长期记忆

改之前把原来的设置文件备份成同目录下的 <文件名>.kioku-backup；改完新开会话生效。
本地已有的记忆文件不会被删掉。
`

export function parseSetupArgs(argv) {
  const options = { dryRun: false, undo: false }
  const names = []
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--undo') options.undo = true
    else if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    else names.push(arg)
  }
  if (names.length !== 1) throw new UsageError('要写一个平台')
  if (!Object.hasOwn(PLATFORMS, names[0])) {
    throw new UsageError(`不认识的平台 ${names[0]}，可以用的：${platformNames()}`)
  }
  return { ...options, platform: names[0] }
}

// 读设置文件：没有这个文件时按空的设置；内容不是 JSON 对象时不动它，报错
export async function readSettings(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { settings: {}, text: null }
    throw new KiokuFailure(`无法读取 ${file}（${errorKind(err)}）`)
  }
  let settings
  try {
    settings = JSON.parse(text)
  } catch {
    settings = null
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new KiokuFailure(`${file} 不是 JSON 对象，没有改动它`)
  }
  return { settings, text }
}

// 沿用原文件的缩进：取第一处缩进，没有就用两个空格
function indentOf(text) {
  return /\n([ \t]+)"/.exec(text ?? '')?.[1] ?? '  '
}

function shown(value) {
  return value === undefined ? '（未设置）' : JSON.stringify(value)
}

// 先写临时文件再改名：写到一半被打断时原来的设置还在。权限沿用原文件的，新建的只给本人
async function writeSettings(file, settings, text) {
  const mode = text === null ? 0o600 : (await stat(file)).mode & 0o777
  const temp = `${file}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(settings, null, indentOf(text))}\n`
  try {
    if (text !== null) await copyFile(file, `${file}.kioku-backup`)
    await writeFile(temp, body, { mode, flag: 'wx' })
    await rename(temp, file)
  } catch (err) {
    throw new KiokuFailure(`无法写入 ${file}（${errorKind(err)}）`)
  }
}

export async function setup(argv, { env = process.env, out = process.stdout } = {}) {
  const { platform: id, dryRun, undo } = parseSetupArgs(argv)
  const platform = PLATFORMS[id]
  const { memory } = platform
  const file = platform.settingsFile(env)
  const { settings, text } = await readSettings(file)
  const next = undo ? memory.restore(settings) : memory.disable(settings)
  const changes = memory.changed.filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(next[key]),
  )
  const goal = undo ? '已启用' : '已停用'
  if (!changes.length) {
    out.write(`${platform.name} 的${memory.name}${goal}，${file} 不用改\n`)
  } else {
    out.write(`${file}\n`)
    for (const key of changes) {
      out.write(`  ${key}：${shown(settings[key])} → ${shown(next[key])}\n`)
    }
    if (dryRun) {
      out.write('没有写入（--dry-run）\n')
      return 0
    }
    await writeSettings(file, next, text)
    if (text !== null) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
    out.write(`${platform.name} 的${memory.name}${goal}，新开会话生效\n`)
  }
  // 别处也停用着时，改回设置并不能重新启用它
  const by = undo ? memory.disabledBy(next, env) : null
  if (by) out.write(`注意：${by}仍然停用着它\n`)
  return 0
}
