// kioku setup 给没有自己的密钥存储的平台定下要用的服务地址与访问密钥：这次给的优先，没给的沿用上次写下的；
// 先看格式，再连一次 Kioku 核对，都过了才轮到各平台去写文件

import { whoami } from './api.mjs'
import { keyFormatError, KiokuFailure } from './http.mjs'
import { readProfile, serverUrlProblem } from './profile.mjs'
import { UsageError } from './usage.mjs'

// platform：{ id, name }，id 也是应用在 Kioku 里该有的运行时。返回 { url, key, saved }：
// saved 是上次写下的（没有为 null）；预览时没给访问密钥、也没有上次的，key 为空字符串。
// io.login 是走浏览器授权的函数，只在终端里运行时有
export async function resolveTarget({ id, name }, options, { env, out, readKey, plain, login }) {
  const saved = await readProfile(id, env).catch(() => null)
  const url = (options.serverUrl ?? env.KIOKU_SERVER_URL ?? saved?.url ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) throw new UsageError('要给服务地址：--server-url https://kioku.example.com')
  const urlProblem = serverUrlProblem(url)
  if (urlProblem) throw new KiokuFailure(urlProblem)
  // 预览时不提示输入：没在环境变量里给访问密钥就沿用上次的，都没有就不核对
  const given =
    options.dryRun && !env.KIOKU_API_KEY ? '' : await readKey({ env, canLogin: Boolean(login) })
  let key = given || saved?.key || ''
  // 什么都没给（提示时直接回车）：在终端里的话改用浏览器授权
  if (!key && !options.dryRun && login) key = await login({ url, id })
  // 写文件、发请求之前先看格式：带着换行这类字符的访问密钥写进配置文件会让整份配置读不了
  const keyProblem = key ? keyFormatError(key) : null
  if (keyProblem) throw new KiokuFailure(keyProblem)
  if (!key && !options.dryRun) {
    throw new KiokuFailure('没有给访问密钥：设置 KIOKU_API_KEY，或者从标准输入给')
  }

  if (key && options.check) {
    const who = await whoami({ url, key })
    const family = who.app.runtimeFamily
    out.write(`✓ 访问密钥可用：应用 ${plain(who.app.name)}，运行时 ${plain(family)}\n`)
    if (family !== id) {
      out.write(
        `! 这个应用的运行时不是 ${id}，注入的内容不按 ${name} 的格式：在管理界面为 ${name} 另建一个应用\n`,
      )
    }
  }
  return { url, key, saved }
}
