// kioku 命令的地址与访问密钥：从环境变量与访问密钥文件读

import { readFile, utimes } from 'node:fs/promises'

import { errorKind, keyFormatError, KiokuFailure } from './http.mjs'

const NOT_CONFIGURED =
  '缺少 Kioku 的地址或访问密钥：在 Claude Code 里启用 kioku 插件、填好配置后新开会话，或者设置 KIOKU_SERVER_URL 与 KIOKU_API_KEY'

// 地址或访问密钥根本没有配（区别于配了但不对）
export class NotConfigured extends KiokuFailure {}

// 地址与访问密钥。访问密钥先读插件在会话开始时配好的 KIOKU_API_KEY_FILE，读不到再用 KIOKU_API_KEY；
// 两样都没有才报错，报错只写文件的位置与错误类别
export async function loadConfig(env) {
  const url = (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const file = env.KIOKU_API_KEY_FILE
  let key = ''
  let fileProblem
  if (file) {
    try {
      key = (await readFile(file, 'utf8')).trim()
      if (!key) fileProblem = '文件是空的'
    } catch (err) {
      fileProblem = errorKind(err)
    }
    // 用的时候更新修改时间：会话开始时会删掉很久没用过的访问密钥文件
    if (key) await utimes(file, new Date(), new Date()).catch(() => {})
  }
  if (!key) key = (env.KIOKU_API_KEY ?? '').trim()
  if (!url) throw new NotConfigured(NOT_CONFIGURED)
  if (!key) {
    if (!fileProblem) throw new NotConfigured(NOT_CONFIGURED)
    throw new KiokuFailure(
      `无法读取访问密钥文件 ${file}（${fileProblem}）：新开会话，或者设置 KIOKU_API_KEY`,
    )
  }
  let protocol
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new KiokuFailure('KIOKU_SERVER_URL 不是有效的地址')
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new KiokuFailure('KIOKU_SERVER_URL 要以 http:// 或 https:// 开头')
  }
  const problem = keyFormatError(key)
  if (problem) throw new KiokuFailure(problem)
  return { url, key }
}
