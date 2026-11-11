// kioku setup 给没有自己的密钥存储的平台定下要用的服务地址与访问密钥：这次给的优先，没给的沿用上次写下的；
// 先看格式，再连一次 Kioku 核对，都过了才轮到各平台去写文件

import { whoami } from './api.mjs'
import { keyFormatError, KiokuFailure } from './http.mjs'
import { readProfile, serverUrlProblem } from './profile.mjs'
import { UsageError } from './usage.mjs'

// 服务地址：这次给的、环境变量里的、上次写下的，依次取；没有、格式不对时抛错
export function resolveServerUrl(options, env, saved) {
  const url = (options.serverUrl ?? env.KIOKU_SERVER_URL ?? saved?.url ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) throw new UsageError('要给服务地址：--server-url https://kioku.example.com')
  const problem = serverUrlProblem(url)
  if (problem) throw new KiokuFailure(problem)
  return url
}

// platform：{ id, name }，id 也是应用在 Kioku 里该有的运行时。返回 { url, key, saved }：
// saved 是上次写下的（没有为 null）；预览时没给访问密钥、也没有上次的，key 为空字符串。
// io.login 是走浏览器授权的函数，只在终端里运行时有；io.beforeLogin 是走它之前平台要先做的检查
export async function resolveTarget(
  { id, name },
  options,
  { env, out, readKey, plain, login, beforeLogin },
) {
  const saved = await readProfile(id, env).catch(() => null)
  const url = resolveServerUrl(options, env, saved)
  // 已经有上次写下的访问密钥时，提示里直接回车是沿用它；没有时直接回车才是改用浏览器授权
  const hasSaved = Boolean(saved?.key)
  const canLogin = Boolean(login) && !hasSaved
  // 预览时不提示输入：没在环境变量里给访问密钥就沿用上次的，都没有就不核对
  const given =
    options.dryRun && !env.KIOKU_API_KEY ? '' : await readKey({ env, canLogin, hasSaved })
  let key = given || saved?.key || ''
  // 什么都没给：在终端里的话改用浏览器授权。先让平台看一眼自己这边写不写得进去：
  // 访问密钥只在签发时给一次，签了却写不下的话会留下一个没人拿着的访问密钥
  if (!key && !options.dryRun && login) {
    await beforeLogin?.()
    key = await login({ url, id })
  }
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
