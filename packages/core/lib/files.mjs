// kioku setup 读写平台设置文件的共用部分。设置文件是用户的，里面还有别的工具写的内容，平台自己也随时在改它，
// 所以：读不懂的不动它，符号链接改它指向的文件，先写临时文件，改名之前确认没有别人刚改过，备份只留第一份

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { errorKind, KiokuFailure } from './http.mjs'

// 读文件的原文；没有这个文件时为 null
export async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw new KiokuFailure(`无法读取 ${file}（${errorKind(err)}）`)
  }
}

// 读 JSON 的设置文件：没有这个文件、或者文件是空的，按空的设置；内容不是 JSON 对象时不动它，报错。
// text 是读到的原文，没有这个文件时为 null
export async function readSettings(file) {
  const text = await readText(file)
  if (text === null) return { settings: {}, text: null }
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
export function serialize(settings, text) {
  const indent = /\n([ \t]+)"/.exec(text ?? '')?.[1] ?? '  '
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const tail = text === null || !text.trim() || /\n$/.test(text) ? eol : ''
  return JSON.stringify(settings, null, indent).replaceAll('\n', eol) + tail
}

// 把 body 写成设置文件的新内容，返回这次有没有留备份。text 是开始时读到的原文，没有这个文件时为 null。
// - 设置文件是符号链接时改它指向的文件，不把链接换成普通文件。
// - 先写临时文件再改名：写到一半被打断时原来的设置还在；失败时临时文件删掉。
// - 改名之前再读一次，和开始时读到的不一样就不写：别的程序刚改过，写下去会盖掉它的改动。
// - 备份只留第一份：之后再改时不覆盖，最早的原文件才留得住。原文里有不该多留一份的内容时（backup 为假）不备份。
// 权限沿用原文件的，新建的只给本人
export async function safeWrite(file, body, text, { backup = true } = {}) {
  let target = file
  let temp
  try {
    if (text === null) await mkdir(dirname(file), { recursive: true })
    else target = await realpath(file)
    const mode = text === null ? 0o600 : (await stat(target)).mode & 0o777
    temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, body, { mode, flag: 'wx' })
    const current = await readFile(target, 'utf8').catch((err) => {
      if (err?.code === 'ENOENT') return null
      throw err
    })
    if (current !== text) {
      throw new KiokuFailure(`${file} 刚被别的程序改过，没有写入：重新运行一次`)
    }
    let backedUp = false
    if (text !== null && backup) {
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

// 写回 JSON 的设置文件
export function writeSettings(file, settings, text) {
  return safeWrite(file, serialize(settings, text), text)
}
