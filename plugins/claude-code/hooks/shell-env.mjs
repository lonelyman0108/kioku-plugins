// Claude Code 的 SessionStart 钩子：给 kioku 命令配好 Kioku 的地址与访问密钥。
// Bash 工具执行的命令拿不到插件配置（CLAUDE_PLUGIN_OPTION_*），所以访问密钥写进插件数据目录里
// 只有本人能读的文件，地址与这个文件的位置以 export 语句追加到 CLAUDE_ENV_FILE：
// Claude Code 每次执行 Bash 命令之前都先执行这个文件。访问密钥本身不进环境变量，env 打印出来也带不出它。
// 任何失败都以退出码 0 结束、不写标准输出：kioku 命令用不了，不能挡住会话开始

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const KEY_FILE = 'api-key'
const CONTROL = /\p{Cc}/u

// shell 的单引号串。值里的单引号写成 '"'"'，不用反斜杠：每一行仍是几段引号串拼成的纯赋值，
// 按行解析这个文件、只认纯赋值的读取方也认得
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

// 先建好只有本人能读写的空文件、设好权限再写内容，最后改名过去：任何时刻都没有别人读得到的访问密钥
async function writeKeyFile(dir, key) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.${KEY_FILE}.${process.pid}.${randomUUID()}`)
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(key)
    await handle.close()
    handle = undefined
    await rename(temp, join(dir, KEY_FILE))
  } catch (err) {
    await handle?.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

async function main() {
  const envFile = process.env.CLAUDE_ENV_FILE
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
  if (!dataDir) return
  const keyFile = join(dataDir, KEY_FILE)
  const base = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const key = (process.env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  if (!base || !key) {
    // 配置清掉了：之前写下的访问密钥也不留着
    await rm(keyFile, { force: true })
    return
  }
  if (!envFile) return
  // 换行这类字符放不进一行赋值
  if (CONTROL.test(base) || CONTROL.test(keyFile))
    throw new Error('服务地址或插件数据目录里有控制字符')
  await writeKeyFile(dataDir, key)
  const block = `export KIOKU_SERVER_URL=${shellQuote(base)}\nexport KIOKU_API_KEY_FILE=${shellQuote(keyFile)}\n`
  let before = ''
  try {
    before = await readFile(envFile, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  // 恢复、压缩会话时会再来一次：最后两行已经是这样就不重复写
  if (before.endsWith(block)) return
  await appendFile(envFile, `${before && !before.endsWith('\n') ? '\n' : ''}${block}`)
}

main().catch((err) => {
  // 标准错误只出现在 Claude Code 的调试输出里，不进上下文；错误文字只有路径，不含访问密钥
  process.stderr.write(
    `Kioku kioku 命令的配置未写入：${err instanceof Error ? err.message : err}\n`,
  )
})
