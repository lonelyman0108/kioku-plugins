// Codex 这个平台的 kioku setup 与 kioku doctor。
// Codex 的插件没有自己的配置项，MCP 服务的地址也只能写在用户的 config.toml 里，所以 setup 做三件事：
// 把服务地址与访问密钥写进本机的文件（钩子读它）、在 config.toml 里加上 Kioku 的 MCP 服务、关掉 Codex 自带的 Memories。
// config.toml 只按行改：不解析整份 TOML，只认段的标题与要改的那几行。名叫 kioku 的 MCP 服务
// （[mcp_servers.kioku] 与它的子段）整个归 kioku setup 管。不用标记行圈范围：Codex 自己也会重写这个文件，
// 注释会被它挪到别的段后面

import { homedir } from 'node:os'
import { join } from 'node:path'

import { whoami } from './api.mjs'
import { readText, safeWrite } from './files.mjs'
import { KiokuFailure } from './http.mjs'
import {
  profileFile,
  readProfile,
  removeProfile,
  serverUrlProblem,
  writeProfile,
} from './profile.mjs'
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

// 段的标题：[a.b] 或 [[a.b]]，返回里面的名字；不是标题时为 null
function headerOf(line) {
  return /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line)?.[1] ?? null
}

// 把 config.toml 按行读成要用的几样：kioku 的 MCP 服务占了哪些行、Memories 的开关写在哪一行、kioku 插件启用没有
export function scanConfig(text) {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  const found = { eol, lines, owned: [], memories: null, plugin: false }
  let section = ''
  lines.forEach((line, index) => {
    const header = headerOf(line)
    if (header !== null) section = header
    if (section === SERVER || section.startsWith(`${SERVER}.`)) {
      found.owned.push(index)
      return
    }
    if (header !== null) return
    // Memories 的开关：[features] 段里的 memories，或者写在最前面的 features.memories
    const key = section === 'features' ? 'memories' : section === '' ? 'features\\.memories' : null
    const flag = key && new RegExp(`^(\\s*${key}\\s*=\\s*)(true|false)\\b(.*)$`).exec(line)
    if (flag) found.memories = { index, value: flag[2] === 'true', parts: flag }
    // 插件：[plugins."kioku@<市场>"] 段里的 enabled = true
    if (/^plugins\.["']kioku@[^"']+["']$/.test(section) && /^\s*enabled\s*=\s*true\b/.test(line)) {
      found.plugin = true
    }
  })
  // 这一段后面的空行不算它的：去掉这一段时不连带去掉
  while (found.owned.length && lines[found.owned.at(-1)].trim() === '') found.owned.pop()
  return found
}

// kioku 的 MCP 服务现在写的地址与访问密钥；没有这个服务时为 null，有但认不出写法的那一项为空
export function blockValues(found) {
  if (!found.owned.length) return null
  const inside = found.owned.map((index) => found.lines[index]).join('\n')
  const url = /^\s*url\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(inside)?.[1]
  const key = /\bAuthorization\s*=\s*"Bearer ((?:[^"\\]|\\.)*)"/.exec(inside)?.[1]
  return { url: unquoted(url).replace(/\/v1\/mcp$/, ''), key: unquoted(key) }
}

// 新的全文：去掉 kioku 的 MCP 服务原来的那些行，把 block 加在最后（为 null 时只去掉；keep 为真时这一段原样留在原处），
// memoriesOff 为真时把 Memories 关掉
function rewrite(found, block, { memoriesOff, keep = false }) {
  const owned = new Set(keep ? [] : found.owned)
  let lines = found.lines.map((line, index) => {
    if (!memoriesOff || !found.memories?.value || index !== found.memories.index) return line
    const [, head, , tail] = found.memories.parts
    return `${head}false${tail}`
  })
  lines = lines.filter((_, index) => !owned.has(index))
  // 开头不留空行，文件以一个换行结尾，新的一段前面空一行；连着的空行并成一行
  while (lines.length && lines[0] === '') lines.shift()
  while (lines.length && lines.at(-1) === '') lines.pop()
  if (block) lines = [...lines, ...(lines.length ? [''] : []), ...block]
  lines = lines.filter((line, index) => !(line === '' && lines[index - 1] === ''))
  return lines.length ? `${lines.join(found.eol)}${found.eol}` : ''
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
      const backedUp = await safeWrite(file, rewrite(found, null, { memoriesOff: false }), text)
      if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
    }
  }
  if (dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
  else if (await removeProfile('codex', env)) out.write(`已删掉 ${profile}\n`)
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
  // 预览时不提示输入：没在环境变量里给访问密钥就沿用上次的，都没有就不核对
  const given = options.dryRun && !env.KIOKU_API_KEY ? '' : await readKey({ env })
  const key = given || saved?.key || ''
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
    const was = before ? `${plain(before.url) || '（认不出的写法）'}/v1/mcp` : '（未设置）'
    changes.push(`  ${SERVER}：${was} → ${url}/v1/mcp`)
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
    const backedUp = await safeWrite(file, body, text)
    if (backedUp) out.write(`原来的设置备份在 ${file}.kioku-backup\n`)
  }
  if (!sameProfile) await writeProfile('codex', { url, key }, env)
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
  if (!block) {
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

  if (found.memories?.value) {
    warn('Codex 自带的 Memories 开着，会和 Kioku 各记一份：运行 kioku setup codex 关掉它')
  } else ok('Codex 自带的 Memories 没有启用')
}
