// kioku import 认得的来源：各平台自带的长期记忆放在哪、是什么格式、迁进 Kioku 时放到哪个坐标。
// 这里只读文件、出条目，不发请求。指令文件（AGENTS.md、CLAUDE.md）不是记忆，不在这里

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// 与服务端 contracts 的上限一致
const MAX_CONTENT = 20_000
const MAX_TITLE = 80
const MAX_DISCLOSURE = 500
const MAX_SEGMENT = 64
// 一个来源最多读这么多个文件：指错了目录时不把整个盘读一遍
const MAX_FILES = 2000

// 坐标里的一段：小写字母、数字、_ 与 -。别的字符换成 -；什么都不剩（例如全是中文）时用内容的摘要
export function segment(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SEGMENT)
    .replace(/-+$/g, '')
  if (slug) return slug
  return `m-${createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 10)}`
}

// 标题：压成一行，去掉控制字符，按码点截断
export function titleOf(text) {
  const line = String(text ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
  return Array.from(line).slice(0, MAX_TITLE).join('')
}

function clipped(text, max) {
  return Array.from(String(text ?? '').trim())
    .slice(0, max)
    .join('')
}

// 文件开头用 --- 括起来的那一段，只认「键: 值」和缩进一层的「键: 值」（Claude Code 的记忆文件就这么多）；
// 缩进更深的、多行写法（> 与 |）的值不认。返回 { meta, body }：
// - 不是以单独一行 --- 开头，或者里面有不像键值的行：没有文件头，body 是全文（以分隔线开头的普通 Markdown）
// - 像文件头却找不到单独一行的 --- 结尾：unterminated 为真，调用方不要把它当正文发出去
export function frontmatter(text) {
  const whole = text.replace(/^\uFEFF/, '')
  const lines = whole.split(/\r?\n/)
  const plainBody = { meta: {}, body: whole }
  if (lines[0]?.trimEnd() !== '---') return plainBody
  const meta = {}
  let parent = null
  let childIndent = null
  // 上一个键用的是多行写法：后面缩进的行是它的值，跳过
  let block = false
  let keys = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimEnd() === '---') {
      return { meta, body: lines.slice(i + 1).join('\n') }
    }
    if (!line.trim()) continue
    if (block && /^\s/.test(line)) continue
    const pair = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    // 不像键值的行：前面一个键都没有的话这不是文件头；已经有键了就是文件头没写完
    if (!pair) return keys ? { meta, body: '', unterminated: true } : plainBody
    keys++
    const indent = pair[1].length
    const raw = pair[3].trim()
    block = /^[>|][+-]?$/.test(raw)
    // 多行写法的标记不是值
    const value = block ? '' : raw.replace(/^(["'])(.*)\1$/, '$2')
    if (indent === 0) {
      meta[pair[2]] = value
      parent = raw === '' ? pair[2] : null
      childIndent = null
    } else if (parent) {
      // 只收紧挨着的那一层：更深的缩进是下一层的，不摊到这一层上
      childIndent ??= indent
      if (indent === childIndent) meta[`${parent}.${pair[2]}`] = value
    }
  }
  return { meta, body: '', unterminated: true }
}

// 一份 Markdown 拆成几条：有只写着一个分节号（U+00A7，Hermes 用它隔开各条）的行就按它拆，否则按二级标题拆，都没有就是一整条。
// 每条是 { heading, text }，heading 可能没有
export function sections(text) {
  const body = text.replace(/^\uFEFF/, '')
  if (/^\u00a7\s*$/m.test(body)) {
    return body
      .split(/^\u00a7\s*$/m)
      .map((part) => ({ heading: null, text: part.trim() }))
      .filter((part) => part.text)
  }
  const parts = []
  let current = { heading: null, lines: [] }
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      parts.push(current)
      current = { heading: heading[1], lines: [line] }
    } else current.lines.push(line)
  }
  parts.push(current)
  return parts
    .map((part) => ({ heading: part.heading, text: part.lines.join('\n').trim() }))
    .filter((part) => part.text)
}

// 条目：{ source, uri, title, content, disclosure }，或者 { source, skipped: 原因 }
function entry(source, { uri, title, content, disclosure }) {
  const text = content.trim()
  if (!text) return { source, skipped: '没有内容' }
  if (Array.from(text).length > MAX_CONTENT) {
    return { source, skipped: `正文超过 ${MAX_CONTENT} 个字，拆开后再导入` }
  }
  const item = { source, uri, title: titleOf(title) || basename(source), content: text }
  const hint = clipped(disclosure, MAX_DISCLOSURE)
  return hint ? { ...item, disclosure: hint } : item
}

// 一个记忆文件最多这么大（字节）：正文上限是 2 万字，再大的不读进内存
const MAX_FILE_BYTES = 512 * 1024

// 读一个记忆文件的文字。只读普通文件：符号链接不跟（它可以指到记忆目录之外的任何文件，读出来就发给服务端了），
// 管道、设备这类也不读；太大的、不是文本的不读。读得了返回 { text }，读不了返回 { problem }；没有这个文件返回 null
async function readable(file) {
  const info = await lstat(file).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink()) return { problem: '是符号链接，不读' }
  if (!info.isFile()) return { problem: '不是普通文件' }
  if (info.size > MAX_FILE_BYTES) return { problem: '文件太大，不读' }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { problem: '读不了这个文件' }
  }
  // 带着空字符或解码不了的字节（成了替换字符）的不是文本
  if (text.includes('\0') || text.includes('\uFFFD')) return { problem: '不是文本文件' }
  return { text }
}

// 是不是真的目录（不是指向别处的符号链接）
async function isRealDir(dir) {
  return (await lstat(dir).catch(() => null))?.isDirectory() ?? false
}

async function markdownFiles(dir) {
  const names = await readdir(dir).catch(() => [])
  return names.filter((name) => name.toLowerCase().endsWith('.md')).sort()
}

// 坐标里的一段，从末尾取：太长时留后面的（路径越靠后越能区分）
function tailSegment(text) {
  const slug = segment(text.length > MAX_SEGMENT ? text.slice(-MAX_SEGMENT) : text)
  return slug.replace(/^-+/, '') || segment(text)
}

// Claude Code 把项目目录的路径编码成目录名（斜杠等换成 -），还原不回去。
// 去掉开头的主目录与常见的上级目录，剩下的当项目名：坐标里要的是认得出的名字，不是整段路径。
// 代价是分不清的情况会得到同一个名字（~/code/dev-proxy 与 ~/code/proxy）：这时两个项目里同名的记忆落到同一个坐标，
// 计划里会列出来，不会悄悄顶掉。主目录对不上时（换了机器、换了用户）项目名会带着整段路径
const CONTAINERS =
  /^(documents|desktop|code|projects|project|src|work|workspace|dev|repos|git|github)-/i
export function claudeProjectName(encoded, home = homedir()) {
  const prefix = home.replace(/[^A-Za-z0-9]/g, '-')
  // 前缀之后要正好是一段的开头，/Users/lm 不能去掉 -Users-lmx-… 的开头
  let rest = encoded.startsWith(`${prefix}-`) ? encoded.slice(prefix.length + 1) : encoded
  rest = rest.replace(/^-+/, '')
  while (CONTAINERS.test(rest)) rest = rest.replace(CONTAINERS, '')
  return tailSegment(rest || encoded)
}

// Claude Code 的自动记忆：<配置目录>/projects/<项目>/memory/*.md，一个文件一条，文件头里有名字、说明与类型。
// MEMORY.md 是索引，不是记忆。类型决定放到哪，都带着项目名（不同项目里同名的不互相顶掉）：
// - user（用户是谁、偏好）→ 本人的 about；project（项目的事）、reference（外部资料在哪）→ 本人下按项目放
// - feedback（该怎么干活）→ 这个应用下按项目放：别的 agent 用不上
async function claudeCode({ env, path, app }) {
  // 先变成绝对路径：相对路径取上一级的名字会取到 . 或 ..
  const root = resolve(
    path ?? join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
  )
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) return { root, found: false, entries: [] }
  // 给的是某个项目的 memory 目录时只读它，否则读每个项目的
  const direct = (await markdownFiles(root)).length > 0
  const projects = direct
    ? [{ name: claudeProjectName(basename(dirname(root))), dir: root }]
    : (await readdir(root).catch(() => []))
        .sort()
        .map((name) => ({ name: claudeProjectName(name), dir: join(root, name, 'memory') }))
  const entries = []
  for (const project of projects) {
    // 项目的 memory 目录是符号链接时不进去
    if (!direct && !(await isRealDir(project.dir))) continue
    for (const name of await markdownFiles(project.dir)) {
      if (name === 'MEMORY.md') continue
      if (entries.length >= MAX_FILES) break
      const source = join(project.dir, name)
      const read = await readable(source)
      if (!read) continue
      if (read.problem) {
        entries.push({ source, skipped: read.problem })
        continue
      }
      const { meta, body, unterminated } = frontmatter(read.text)
      if (unterminated) {
        entries.push({ source, skipped: '文件头没有结尾的 ---，分不清哪些是正文' })
        continue
      }
      const id = segment(meta.name || name.replace(/\.md$/i, ''))
      const type = meta['metadata.type'] || meta.type || ''
      const uri =
        type === 'user'
          ? `user://about/${project.name}/${id}`
          : type === 'feedback'
            ? `app://${app}/feedback/${project.name}/${id}`
            : type === 'reference'
              ? `user://reference/${project.name}/${id}`
              : `user://projects/${project.name}/${id}`
      entries.push(
        entry(source, {
          uri,
          title: meta.description || meta.name || name,
          content: body,
          disclosure: meta.description,
        }),
      )
    }
  }
  return { root, found: true, entries }
}

// 一段文字的摘要，做坐标里的标识：内容不变标识就不变
function digest(text) {
  return `m-${createHash('sha256').update(text).digest('hex').slice(0, 10)}`
}

// 一组「文件 → 放到哪」的来源：每个文件按 sections 拆成几条。标识取小节标题；没有标题的、标题重了的取内容的摘要，
// 不按顺序编号：文件里插一条、删一条之后，别的条的坐标不能跟着变，否则去重就认不出它们了。
// 代价是没有标题的一段改了内容就是新的一条，旧的留在 Kioku 里
async function fromFiles(root, files) {
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) return { root, found: false, entries: [] }
  const entries = []
  for (const { file, prefix, title, single } of files) {
    const source = join(root, file)
    const read = await readable(source)
    if (!read) continue
    if (read.problem) {
      entries.push({ source, skipped: read.problem })
      continue
    }
    const parts = single ? [{ heading: null, text: read.text.trim() }] : sections(read.text)
    const used = new Set()
    parts.forEach((part, index) => {
      let id = part.heading ? segment(part.heading) : digest(part.text)
      if (used.has(id)) id = digest(part.text)
      used.add(id)
      entries.push(
        entry(parts.length > 1 ? `${source}（第 ${index + 1} 段）` : source, {
          uri: single ? prefix : `${prefix}/${id}`,
          title: part.heading || title,
          content: part.text,
        }),
      )
    })
  }
  return { root, found: true, entries }
}

// Hermes：<主目录>/.hermes/memories 下的 MEMORY.md（agent 自己记的）与 USER.md（用户画像）。
// 坐标里带着来源的名字：几个来源迁进同一个应用时不落到一起
function hermes({ env, path, app }) {
  const root = resolve(path ?? join(env.HERMES_HOME || join(homedir(), '.hermes'), 'memories'))
  return fromFiles(root, [
    { file: 'MEMORY.md', prefix: `app://${app}/hermes/notes`, title: 'Hermes 的记忆' },
    { file: 'USER.md', prefix: 'user://about/hermes', title: 'Hermes 记下的用户画像' },
  ])
}

// OpenClaw：工作区下的 MEMORY.md、USER.md，以及 memory/ 里按日期的笔记（一个文件整个当一条）。
// OPENCLAW_HOME 换的是主目录，工作区默认在它下面的 .openclaw/workspace；配置里改过工作区位置的用 --path 指明
async function openclaw({ env, path, app }) {
  const root = resolve(path ?? join(env.OPENCLAW_HOME || homedir(), '.openclaw', 'workspace'))
  const notes = join(root, 'memory')
  const daily = ((await isRealDir(notes)) ? await markdownFiles(notes) : [])
    // 一天可以有几个：2026-11-10.md，或者带后缀的 2026-11-10-<名字>.md
    .filter((name) => /^\d{4}-\d{2}-\d{2}(-[A-Za-z0-9][A-Za-z0-9-]*)?\.md$/.test(name))
    .slice(0, MAX_FILES)
    .map((name) => {
      const stem = name.slice(0, -3)
      const suffix = stem.slice(11)
      return {
        file: join('memory', name),
        // 和别的来源一样规整成坐标里的一段（长度、连着的连字符）；只差大小写的两个文件会落到同一个坐标，
        // 后一个在计划里按撞名列出来
        prefix: `app://${app}/openclaw/journal/${segment(stem)}`,
        title: suffix ? `${stem.slice(0, 10)} 的笔记（${suffix}）` : `${stem} 的笔记`,
        single: true,
      }
    })
  return fromFiles(root, [
    { file: 'MEMORY.md', prefix: `app://${app}/openclaw/notes`, title: 'OpenClaw 的记忆' },
    { file: 'USER.md', prefix: 'user://about/openclaw', title: 'OpenClaw 记下的用户画像' },
    ...daily,
  ])
}

export const SOURCES = {
  'claude-code': { name: 'Claude Code 的自动记忆', read: claudeCode },
  hermes: { name: 'Hermes 的记忆文件', read: hermes },
  openclaw: { name: 'OpenClaw 工作区的记忆文件', read: openclaw },
}

// 认得、但迁不了的来源，说明原因
export const UNSUPPORTED_SOURCES = {
  codex:
    'Codex 自带的 Memories 存在它自己的数据库里，格式没有公开，迁不了；它在本地默认是关着的，多半没有内容',
  pi: 'pi 没有自带的长期记忆',
}

export function sourceNames() {
  return Object.keys(SOURCES).join('、')
}
