// Codex 这个平台的 kioku setup 与 kioku doctor。
// Codex 的插件没有自己的配置项，MCP 服务的地址也只能写在用户的 config.toml 里，所以 setup 做三件事：
// 把服务地址与访问密钥写进本机的文件（钩子读它）、在 config.toml 里加上 Kioku 的 MCP 服务、关掉 Codex 自带的 Memories。
// config.toml 只按行改：不解析整份 TOML，只认段的标题与要改的那几行。名叫 kioku 的 MCP 服务
// （[mcp_servers.kioku] 与它的子段）整个归 kioku setup 管。不用标记行圈范围：Codex 自己也会重写这个文件，
// 注释会被它挪到别的段后面

import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { whoami } from './api.mjs'
import { readText, safeWrite } from './files.mjs'
import { keyFormatError, KiokuFailure } from './http.mjs'
import {
  profileDir,
  profileFile,
  readProfile,
  removeProfile,
  serverUrlProblem,
  writeProfile,
} from './profile.mjs'
import { plain as plainText, shownUrl } from './text.mjs'
import { UsageError } from './usage.mjs'

const SERVER = 'mcp_servers.kioku'
const MARKETPLACE = 'lonelyman0108/kioku-plugins'

export function codexHome(env) {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

// TOML 的基本字符串：反斜杠与双引号要转义。地址与访问密钥都只有可见的 ASCII 字符
function quoted(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function unquoted(value) {
  return (value ?? '').replace(/\\(["\\])/g, '$1')
}

// 写进 config.toml 的那几行
function blockOf({ url, key }) {
  return [
    `[${SERVER}]`,
    `url = ${quoted(`${url}/v1/mcp`)}`,
    '',
    `[${SERVER}.http_headers]`,
    `Authorization = ${quoted(`Bearer ${key}`)}`,
  ]
}

// 标题里的一段名字：不带引号的，或者带引号的
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`
const HEADER = new RegExp(
  String.raw`^\s*\[\[?\s*(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*\]\]?\s*(#.*)?$`,
)

// 段的标题：[a.b] 或 [[a.b]]，返回里面的名字；不是标题时为 null。
// 名字规整成一种写法再比：点两边的空白去掉，只含普通字符的那一段去掉引号
function headerOf(line) {
  const name = HEADER.exec(line)?.[1]
  if (name === undefined) return null
  return name
    .replace(/\s*\.\s*/g, '.')
    .replace(/"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'/g, (_, a, b) => a ?? b)
}

// 这一行让没有合上的方括号多了几层：多行的数组里，单独成行的 [1, 2] 不是标题。引号里的不算
function bracketDelta(line) {
  const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*$/, '')
  return (bare.match(/\[/g)?.length ?? 0) - (bare.match(/\]/g)?.length ?? 0)
}

// 把 config.toml 按行读成要用的几样：
// - owned：kioku 的 MCP 服务占了哪些行
// - unsupported：这个服务用按行认不出范围的写法定义了（行内表、带点的键），不能再加一段同名的
// - memories：Memories 的开关写在哪一行；memoriesUnknown：features 用认不出的写法写了
// - plugin：kioku 插件启用没有
export function scanConfig(text) {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  const found = {
    eol,
    lines,
    owned: [],
    unsupported: false,
    memories: null,
    memoriesUnknown: false,
    plugin: false,
  }
  let section = ''
  let depth = 0
  lines.forEach((line, index) => {
    const header = depth === 0 ? headerOf(line) : null
    if (header !== null) section = header
    else depth = Math.max(0, depth + bracketDelta(line))
    if (section === SERVER || section.startsWith(`${SERVER}.`)) {
      found.owned.push(index)
      return
    }
    if (header !== null) return
    // 这个服务的别的写法：最前面的 mcp_servers.kioku…、mcp_servers = { kioku… }，或者 [mcp_servers] 段里的 kioku
    const quotedName = String.raw`["']?kioku["']?`
    if (
      (section === '' &&
        new RegExp(String.raw`^\s*mcp_servers\s*(\.\s*${quotedName}\s*[.=]|=.*\bkioku\b)`).test(
          line,
        )) ||
      (section === 'mcp_servers' && new RegExp(String.raw`^\s*${quotedName}\s*[.=]`).test(line))
    ) {
      found.unsupported = true
    }
    // Memories 的开关：[features] 段里的 memories，或者写在最前面的 features.memories
    const name = String.raw`["']?memories["']?`
    const key =
      section === 'features' ? name : section === '' ? String.raw`features\s*\.\s*${name}` : null
    const flag = key && new RegExp(String.raw`^(\s*${key}\s*=\s*)(true|false)\b(.*)$`).exec(line)
    if (flag) found.memories = { index, value: flag[2] === 'true', parts: flag }
    // features 写成行内表时认不出里面的开关
    if (section === '' && /^\s*features\s*=/.test(line)) found.memoriesUnknown = true
    // 插件：[plugins."kioku@<市场>"] 段里的 enabled = true
    if (/^plugins\.["']kioku@[^"']+["']$/.test(section) && /^\s*enabled\s*=\s*true\b/.test(line)) {
      found.plugin = true
    }
  })
  // 这一段后面的空行与注释不算它的（注释多半是写给下一段的）：去掉这一段时不连带去掉
  while (found.owned.length && /^\s*(#.*)?$/.test(lines[found.owned.at(-1)])) found.owned.pop()
  return found
}

// kioku 的 MCP 服务现在写的地址与访问密钥；没有这个服务时为 null，有但认不出写法的那一项为空
export function blockValues(found) {
  if (!found.owned.length) return null
  const inside = found.owned.map((index) => found.lines[index]).join('\n')
  const url = /^\s*url\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(inside)?.[1]
  const key = /\bAuthorization\s*=\s*"Bearer ((?:[^"\\]|\\.)*)"/.exec(inside)?.[1]
  // rawUrl 是原样写着的地址，只用来显示
  return { url: unquoted(url).replace(/\/v1\/mcp$/, ''), key: unquoted(key), rawUrl: unquoted(url) }
}

// 新的全文：去掉 kioku 的 MCP 服务原来的那些行，把 block 加在最后（为 null 时只去掉；keep 为真时这一段原样留在原处），
// memoriesOff 为真时把 Memories 关掉。别的行原样不动，只收拾去掉的地方两边多出来的空行
function rewrite(found, block, { memoriesOff, keep = false }) {
  const owned = new Set(keep ? [] : found.owned)
  const lines = []
  found.lines.forEach((line, index) => {
    if (owned.has(index)) return
    // 去掉一段之后，它前后的空行并成一行
    if (line === '' && owned.has(index - 1) && (lines.at(-1) ?? '') === '') return
    if (memoriesOff && found.memories?.value && index === found.memories.index) {
      const [, head, , tail] = found.memories.parts
      lines.push(`${head}false${tail}`)
    } else lines.push(line)
  })
  if (!owned.size && !block) return lines.join(found.eol)
  // 文件以一个换行结尾，新的一段前面空一行
  while (lines.length && lines.at(-1) === '') lines.pop()
  if (block) lines.push(...(lines.length ? [''] : []), ...block)
  return lines.length ? `${lines.join(found.eol)}${found.eol}` : ''
}

// 现在的 config.toml 里有没有写着访问密钥：有的话不留备份，免得撤销、换访问密钥之后旧的还留在备份里
function holdsKey(found) {
  return Boolean(blockValues(found)?.key)
}

// 记下的用户输入（钩子在每轮提交时写的）：撤销时一起删掉
async function removePendingTurns(env) {
  const dirs = [join(profileDir(env), 'codex-state')]
  const data = join(codexHome(env), 'plugins', 'data')
  for (const name of await readdir(data).catch(() => [])) {
    if (name.startsWith('kioku-')) dirs.push(join(data, name, 'turns'))
  }
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

// 地址只打印协议、主机与路径；解析不了的压成一行再打印
function shown(url) {
  try {
    return shownUrl(url)
  } catch {
    return plainText(url)
  }
}

const NEXT_STEPS = `接下来在 Codex 这一边：
  1. codex plugin marketplace add ${MARKETPLACE}
  2. codex plugin add kioku@kioku
  3. 打开 codex，在 /hooks 里信任 kioku 的三个钩子（没信任过的钩子不会运行）
`

async function undo({ dryRun }, { env, out }) {
  const file = join(codexHome(env), 'config.toml')
  const text = await readText(file)
  const found = scanConfig(text)
  const profile = profileFile('codex', env)
  if (!found.owned.length) out.write(`${file} 里没有 Kioku 的 MCP 服务，不用改\n`)
  else {
    out.write(`${file}\n  ${SERVER}：去掉\n`)
    if (!dryRun) {
      // 现在的文件里写着访问密钥，不留备份
      await safeWrite(file, rewrite(found, null, { memoriesOff: false }), text, { backup: false })
    }
  }
  if (found.unsupported) {
    out.write(`${file} 里还有用别的写法定义的 kioku 服务，没有改动它，要手动去掉\n`)
  }
  if (dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
  else {
    if (await removeProfile('codex', env)) out.write(`已删掉 ${profile}\n`)
    await removePendingTurns(env)
  }
  out.write('Codex 自带的 Memories 没有重新打开：要用的话运行 codex features enable memories\n')
  out.write('插件要另外卸载：codex plugin remove kioku@kioku\n')
  return 0
}

export async function setupCodex(options, io) {
  const { env, out, readKey, plain } = io
  if (options.undo) return undo(options, io)
  const file = join(codexHome(env), 'config.toml')
  const text = await readText(file)
  const found = scanConfig(text)

  // 地址与访问密钥：这次给的优先，没给的沿用上次写下的
  const saved = await readProfile('codex', env).catch(() => null)
  const url = (options.serverUrl ?? env.KIOKU_SERVER_URL ?? saved?.url ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) throw new UsageError('要给服务地址：--server-url https://kioku.example.com')
  const urlProblem = serverUrlProblem(url)
  if (urlProblem) throw new KiokuFailure(urlProblem)
  if (found.unsupported) {
    throw new KiokuFailure(
      `${file} 里已经用行内表或带点的键定义了 kioku 这个 MCP 服务，没有改动它：删掉那个定义后重新运行`,
    )
  }
  // 预览时不提示输入：没在环境变量里给访问密钥就沿用上次的，都没有就不核对
  const given = options.dryRun && !env.KIOKU_API_KEY ? '' : await readKey({ env })
  const key = given || saved?.key || ''
  // 写文件、发请求之前先看格式：带着换行这类字符的访问密钥写进 config.toml 会让整份配置读不了
  const keyProblem = key ? keyFormatError(key) : null
  if (keyProblem) throw new KiokuFailure(keyProblem)
  if (!key && !options.dryRun) {
    throw new KiokuFailure('没有给访问密钥：设置 KIOKU_API_KEY，或者从标准输入给')
  }

  if (key && options.check) {
    const who = await whoami({ url, key })
    const family = who.app.runtimeFamily
    out.write(`✓ 访问密钥可用：应用 ${plain(who.app.name)}，运行时 ${plain(family)}\n`)
    if (family !== 'codex') {
      out.write(
        '! 这个应用的运行时不是 codex，注入的内容不按 Codex 的格式：在管理界面为 Codex 另建一个应用\n',
      )
    }
  }

  const before = blockValues(found)
  const sameBlock = Boolean(before && key && before.url === url && before.key === key)
  const changes = []
  if (!sameBlock) {
    const was = !before ? '（未设置）' : before.rawUrl ? shown(before.rawUrl) : '（认不出的写法）'
    // 地址没变时只是换访问密钥，不把同一个地址写两遍
    if (before?.url === url) changes.push(`  ${SERVER}：换访问密钥`)
    else changes.push(`  ${SERVER}：${was} → ${shown(url)}/v1/mcp`)
  }
  if (found.memories?.value) changes.push('  features.memories：true → false')
  const profile = profileFile('codex', env)
  const sameProfile = Boolean(saved && saved.url === url && saved.key === key)

  if (!changes.length) out.write(`${file} 不用改\n`)
  else out.write(`${file}\n${changes.join('\n')}\n`)
  if (!sameProfile) out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (changes.length) {
    const body = sameBlock
      ? rewrite(found, null, { memoriesOff: true, keep: true })
      : rewrite(found, blockOf({ url, key }), { memoriesOff: true })
    const backedUp = await safeWrite(file, body, text, { backup: !holdsKey(found) })
    if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
  }
  if (!sameProfile) await writeProfile('codex', { url, key }, env)
  if (found.memoriesUnknown) {
    out.write(
      `! ${file} 里 features 的写法认不出来，没有核对 Memories：运行 codex features disable memories 关掉它\n`,
    )
  }
  out.write(`Codex 已配好，新开会话生效。\n${found.plugin ? '' : NEXT_STEPS}`)
  return 0
}

export async function inspectCodex({ env }, { ok, warn, bad, note }) {
  const file = join(codexHome(env), 'config.toml')
  const found = scanConfig(await readText(file))
  const profile = await readProfile('codex', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup codex 写下的地址与访问密钥，钩子不会生效：运行 kioku setup codex')
  }

  const block = blockValues(found)
  if (found.unsupported) {
    warn(`${file} 里的 kioku 服务用了行内表或带点的键，没有核对它：改成 kioku setup codex 的写法`)
  } else if (!block) {
    warn(`${file} 里没有 Kioku 的 MCP 服务，读写记忆的工具用不了：运行 kioku setup codex`)
  } else if (profile && (block.url !== profile.url || block.key !== profile.key)) {
    bad(`${file} 里 Kioku 的 MCP 服务和钩子用的地址或访问密钥对不上：重新运行 kioku setup codex`)
  } else ok('Codex 里配了 Kioku 的 MCP 服务')

  if (found.plugin) ok('Codex 的 kioku 插件已启用')
  else {
    warn(
      `Codex 的 kioku 插件没有启用：codex plugin marketplace add ${MARKETPLACE}，再 codex plugin add kioku@kioku`,
    )
  }
  note('钩子要在 Codex 的 /hooks 里信任过才会运行，这里查不到')

  if (found.memoriesUnknown && !found.memories) {
    warn(`${file} 里 features 的写法认不出来，没有核对 Memories：用 codex features list 看它开没开`)
  } else if (found.memories?.value) {
    warn('Codex 自带的 Memories 开着，会和 Kioku 各记一份：运行 kioku setup codex 关掉它')
  } else ok('Codex 自带的 Memories 没有启用')
}
