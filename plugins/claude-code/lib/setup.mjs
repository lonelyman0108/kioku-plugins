// kioku setup：停用平台自带的长期记忆，由 Kioku 接管。只改平台的用户设置里的那几项，
// 改之前显示要改什么、留一份备份；--undo 只把这几项改回去，不动设置里的其他内容（文件会按 JSON 重新排版）

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { errorKind, KiokuFailure } from './http.mjs'
import { platformNames, PLATFORMS } from './platforms.mjs'
import { UsageError } from './usage.mjs'

export const SETUP_USAGE = `用法：kioku setup <平台> [--dry-run] [--undo]

停用平台自带的长期记忆，由 Kioku 接管；只改平台的用户设置里和它有关的几项。

  <平台>     ${platformNames()}
  --dry-run  只显示要改什么，不写文件
  --undo     把这几项改回默认，重新启用平台自带的长期记忆

第一次改之前把原来的设置文件备份成同目录下的 <文件名>.kioku-backup（已有备份时不覆盖）；
设置文件会按 JSON 重新排版。改完新开会话生效。本地已有的记忆文件不会被删掉。
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

// 读设置文件：没有这个文件、或者文件是空的，按空的设置；内容不是 JSON 对象时不动它，报错。
// text 是读到的原文，没有这个文件时为 null
export async function readSettings(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { settings: {}, text: null }
    throw new KiokuFailure(`无法读取 ${file}（${errorKind(err)}）`)
  }
  // 开头的 BOM 不算内容
  const body = text.replace(/^\uFEFF/, '')
  if (!body.trim()) return { settings: {}, text }
  let settings
  try {
    settings = JSON.parse(body)
  } catch {
    settings = null
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new KiokuFailure(`${file} 不是 JSON 对象，没有改动它`)
  }
  return { settings, text }
}

// 沿用原文件的缩进（取第一处，没有就用两个空格）、换行符和结尾有没有换行；别的排版按 JSON 的默认写法
function serialize(settings, text) {
  const indent = /\n([ \t]+)"/.exec(text ?? '')?.[1] ?? '  '
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const tail = text === null || !text.trim() || /\n$/.test(text) ? eol : ''
  return JSON.stringify(settings, null, indent).replaceAll('\n', eol) + tail
}

function shown(value) {
  return value === undefined ? '（未设置）' : JSON.stringify(value)
}

// 写回设置文件，返回这次有没有留备份。
// - 设置文件是符号链接时改它指向的文件，不把链接换成普通文件。
// - 先写临时文件再改名：写到一半被打断时原来的设置还在；失败时临时文件删掉。
// - 改名之前再读一次，和开始时读到的不一样就不写：别的程序刚改过，写下去会盖掉它的改动。
// - 备份只留第一份：之后再改时不覆盖，最早的原文件才留得住。
// 权限沿用原文件的，新建的只给本人
export async function writeSettings(file, settings, text) {
  let target = file
  let temp
  try {
    if (text === null) await mkdir(dirname(file), { recursive: true })
    else target = await realpath(file)
    const mode = text === null ? 0o600 : (await stat(target)).mode & 0o777
    temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, serialize(settings, text), { mode, flag: 'wx' })
    const current = await readFile(target, 'utf8').catch((err) => {
      if (err?.code === 'ENOENT') return null
      throw err
    })
    if (current !== text) {
      throw new KiokuFailure(`${file} 刚被别的程序改过，没有写入：重新运行一次`)
    }
    let backedUp = false
    if (text !== null) {
      try {
        await copyFile(target, `${file}.kioku-backup`, constants.COPYFILE_EXCL)
        backedUp = true
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err
      }
    }
    await rename(temp, target)
    return backedUp
  } catch (err) {
    if (temp) await rm(temp, { force: true }).catch(() => {})
    if (err instanceof KiokuFailure) throw err
    throw new KiokuFailure(`无法写入 ${file}（${errorKind(err)}）`)
  }
}

export async function setup(
  argv,
  { env = process.env, out = process.stdout, cwd = process.cwd() } = {},
) {
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
    const backedUp = await writeSettings(file, next, text)
    if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
    else if (text !== null) out.write(`${file}.kioku-backup 已有更早的备份，没有覆盖\n`)
    out.write(`${platform.name} 的${memory.name}${goal}，新开会话生效\n`)
  }
  // 别处也停用着时，改回设置并不能重新启用它；别处又启用了时，停用也不生效
  const by = undo ? memory.disabledBy(next, env) : null
  if (by) out.write(`注意：${by}仍然停用着它\n`)
  const again = undo ? null : await memory.enabledBy(env, cwd)
  if (again) out.write(`注意：${again}又启用了它，要在那里一起改\n`)
  return 0
}
