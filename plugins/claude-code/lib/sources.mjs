// kioku import 认得的来源：各平台自带的长期记忆放在哪、是什么格式、迁进 Kioku 时放到哪个坐标。
// 这里只读文件、出条目，不发请求。指令文件（AGENTS.md、CLAUDE.md）不是记忆，不在这里

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

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

// 文件开头用 --- 括起来的那一段，只认「键: 值」和缩进一层的「键: 值」（Claude Code 的记忆文件就这么多）。
// 返回 { meta, body }；没有这一段时 meta 是空的
export function frontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text.replace(/^\uFEFF/, '') }
  const meta = {}
  let parent = null
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!pair) continue
    const value = pair[3].replace(/^(["'])(.*)\1$/, '$2')
    if (pair[1] && parent) meta[`${parent}.${pair[2]}`] = value
    else {
      meta[pair[2]] = value
      parent = value === '' ? pair[2] : null
    }
  }
  return { meta, body: text.slice(match[0].length) }
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

async function readable(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function markdownFiles(dir) {
  const names = await readdir(dir).catch(() => [])
  return names.filter((name) => name.toLowerCase().endsWith('.md')).sort()
}

// Claude Code 把项目目录的路径编码成目录名（斜杠换成 -），还原不回去；
// 去掉开头的主目录与常见的上级目录，剩下的当项目名
export function claudeProjectName(encoded, home = homedir()) {
  const prefix = home.replace(/[^A-Za-z0-9]/g, '-')
  let rest = encoded.startsWith(prefix) ? encoded.slice(prefix.length) : encoded
  rest = rest.replace(/^-+/, '')
  const common =
    /^(documents|desktop|code|projects|project|src|work|workspace|dev|repos|git|github)-/i
  while (common.test(rest)) rest = rest.replace(common, '')
  return segment(rest || encoded)
}

// Claude Code 的自动记忆：<配置目录>/projects/<项目>/memory/*.md，一个文件一条，文件头里有名字、说明与类型。
// MEMORY.md 是索引，不是记忆。类型决定放到哪：
// - user（用户是谁、偏好）→ 本人；project（项目的事）、reference（外部资料在哪）→ 本人下按项目放
// - feedback（该怎么干活）→ 这个应用下按项目放：别的 agent 用不上
async function claudeCode({ env, path, app }) {
  const root = path ?? join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) return { root, found: false, entries: [] }
  // 给的是某个项目的 memory 目录时只读它，否则读每个项目的
  const direct = (await markdownFiles(root)).length > 0
  const projects = direct
    ? [{ name: claudeProjectName(basename(join(root, '..'))), dir: root }]
    : (await readdir(root).catch(() => []))
        .sort()
        .map((name) => ({ name: claudeProjectName(name), dir: join(root, name, 'memory') }))
  const entries = []
  for (const project of projects) {
    for (const name of await markdownFiles(project.dir)) {
      if (name === 'MEMORY.md') continue
      if (entries.length >= MAX_FILES) break
      const source = join(project.dir, name)
      const text = await readable(source)
      if (text === null) {
        entries.push({ source, skipped: '读不了这个文件' })
        continue
      }
      const { meta, body } = frontmatter(text)
      const id = segment(meta.name || name.replace(/\.md$/i, ''))
      const type = meta['metadata.type'] || meta.type || ''
      const uri =
        type === 'user'
          ? `user://about/${id}`
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

// 一组「文件 → 放到哪」的来源：每个文件按 sections 拆成几条，标识取小节标题，没有标题的按顺序编号
async function fromFiles(root, files) {
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) return { root, found: false, entries: [] }
  const entries = []
  for (const { file, prefix, title, single } of files) {
    const source = join(root, file)
    const text = await readable(source)
    if (text === null) continue
    const parts = single ? [{ heading: null, text: text.trim() }] : sections(text)
    const used = new Set()
    parts.forEach((part, index) => {
      // 同一个文件里标题重了的，后面的加上序号
      let id = part.heading ? segment(part.heading) : parts.length > 1 ? `n${index + 1}` : 'notes'
      if (used.has(id)) id = `${id.slice(0, MAX_SEGMENT - 4)}-${index + 1}`
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

// Hermes：<主目录>/.hermes/memories 下的 MEMORY.md（agent 自己记的）与 USER.md（用户画像）
function hermes({ env, path, app }) {
  const root = path ?? join(env.HERMES_HOME || join(homedir(), '.hermes'), 'memories')
  return fromFiles(root, [
    { file: 'MEMORY.md', prefix: `app://${app}/notes`, title: 'Hermes 的记忆' },
    { file: 'USER.md', prefix: 'user://about/hermes', title: 'Hermes 记下的用户画像' },
  ])
}

// OpenClaw：工作区下的 MEMORY.md、USER.md，以及 memory/ 里按日期的笔记（一天一个文件，整个当一条）
async function openclaw({ env, path, app }) {
  const root = path ?? join(env.OPENCLAW_HOME || join(homedir(), '.openclaw'), 'workspace')
  const daily = (await markdownFiles(join(root, 'memory')))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .slice(0, MAX_FILES)
    .map((name) => ({
      file: join('memory', name),
      prefix: `app://${app}/journal/${name.slice(0, 10)}`,
      title: `${name.slice(0, 10)} 的笔记`,
      single: true,
    }))
  return fromFiles(root, [
    { file: 'MEMORY.md', prefix: `app://${app}/notes`, title: 'OpenClaw 的记忆' },
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
