// Claude Code 的钩子：给 kioku 命令配好 Kioku 的地址与访问密钥。Bash 工具执行的命令拿不到插件配置
// （CLAUDE_PLUGIN_OPTION_*），所以：
// - 会话开始（session.start）：访问密钥写进插件数据目录里只有本人能读写的 api-key.<会话>，
//   地址与这个文件的位置以 export 语句追加到 CLAUDE_ENV_FILE，Claude Code 每次执行 Bash 命令之前都先执行它。
//   访问密钥不放进环境变量，只是防 env 之类把它顺手打印出来；同一个用户的进程照样读得到这个文件，这不是隔离。
//   顺手删掉很久没用过的访问密钥文件和写到一半留下的临时文件。
// - 会话结束（session.end）：删掉这个会话的访问密钥文件。
// 任何失败都以退出码 0 结束、不写标准输出：kioku 命令用不了，不能挡住会话；原因写到标准错误，不带访问密钥

import { randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { failureText, KiokuFailure } from '../lib/http.mjs'

const KEY_PREFIX = 'api-key.'
const TEMP_PREFIX = '.api-key.'
// 会话标识要拼进文件名，只收这些字符
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
// 超过这么久没用过的访问密钥文件，在会话开始时删掉；kioku run 每次读都会更新修改时间
const KEY_MAX_AGE = 7 * 24 * 60 * 60 * 1000
// 临时文件超过这么久还在，就是写到一半被打断留下的；更新的可能是同时开始的别的会话正在写
const TEMP_MAX_AGE = 60 * 1000
const CONTROL = /\p{Cc}/u

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// shell 的单引号串。值里的单引号写成 '"'"'，不用反斜杠：每一行仍是几段引号串拼成的纯赋值，
// 按行解析这个文件、只认纯赋值的读取方也认得
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

// 删掉很久没用过的访问密钥文件，和写到一半被打断留下的临时文件；删不掉的跳过
async function cleanup(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  await Promise.all(
    names.map(async (name) => {
      const maxAge = name.startsWith(TEMP_PREFIX)
        ? TEMP_MAX_AGE
        : name.startsWith(KEY_PREFIX)
          ? KEY_MAX_AGE
          : null
      if (maxAge === null) return
      const path = join(dir, name)
      try {
        if (now - (await lstat(path)).mtimeMs > maxAge) await rm(path, { force: true })
      } catch {
        // 别的会话同时删掉了，或者删不掉
      }
    }),
  )
}

// 先建好只有本人能读写的空文件、设好权限再写内容，最后改名过去：任何时刻都没有别人读得到的访问密钥
async function writeKeyFile(dir, path, key) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `${TEMP_PREFIX}${process.pid}.${randomUUID()}`)
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(key)
    await handle.close()
    handle = undefined
    await rename(temp, path)
  } catch (err) {
    await handle?.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

async function main(event) {
  if (event !== 'session.start' && event !== 'session.end') {
    throw new KiokuFailure(`未知事件 ${event}`)
  }
  let input = {}
  try {
    input = JSON.parse((await readStdin()) || '{}')
  } catch {
    // 输入不是 JSON 时按空输入处理，下面因为没有会话标识而跳过
  }
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
  if (!dataDir) throw new KiokuFailure('没有 CLAUDE_PLUGIN_DATA')
  const session = typeof input.session_id === 'string' ? input.session_id : ''
  if (!SESSION.test(session)) throw new KiokuFailure('会话标识不可用')
  const keyFile = join(dataDir, `${KEY_PREFIX}${session}`)
  if (event === 'session.end') {
    await rm(keyFile, { force: true })
    return
  }

  await cleanup(dataDir)
  const base = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const key = (process.env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  if (!base || !key) {
    // 配置清掉了：这个会话之前写下的访问密钥也不留着，别的会话的不动
    await rm(keyFile, { force: true })
    throw new KiokuFailure('插件没有配置服务地址或访问密钥')
  }
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) throw new KiokuFailure('没有 CLAUDE_ENV_FILE')
  // 换行这类字符放不进一行赋值
  if (CONTROL.test(base) || CONTROL.test(keyFile)) {
    throw new KiokuFailure('服务地址或插件数据目录里有控制字符')
  }
  await writeKeyFile(dataDir, keyFile, key)
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

const event = process.argv[2]
main(event).catch((err) => {
  // 标准错误只出现在 Claude Code 的调试输出里，不进上下文
  const what =
    event === 'session.end' ? '会话结束时 kioku 命令的访问密钥文件未删除' : 'kioku 命令的配置未写入'
  process.stderr.write(`Kioku ${what}：${failureText(err)}\n`)
})
