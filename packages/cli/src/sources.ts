// kioku import 认得的来源：各客户端自带的长期记忆放在哪、是什么格式、迁进 Kioku 时生成什么样的记忆。
// 这里只读文件、出记忆项，不发请求。指令文件（AGENTS.md、CLAUDE.md）不是记忆，不在这里

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import type { Env } from './types.ts'

// 与服务端 contracts 的上限一致
const MAX_CONTENT = 100_000
const MAX_TITLE = 200
const MAX_DISCLOSURE = 500
const MAX_SEGMENT = 64
// 一个来源最多读这么多个文件：指错了目录时不把整个盘读一遍
const MAX_FILES = 2000

export interface SourceEntry {
  source: string
  title?: string
  baseTitle?: string
  projects?: string[]
  runtimes?: string[]
  topics?: string[]
  content?: string
  disclosure?: string
  skipped?: string
}

export interface SourceReadResult {
  root: string
  found: boolean
  entries: SourceEntry[]
}

// 标签或标识的一段：小写字母、数字、_ 与 -。别的字符换成 -；什么都不剩（例如全是中文）时用内容的摘要
export function segment(text: unknown): string {
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
export function titleOf(text: unknown): string {
  const line = String(text ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
  return Array.from(line).slice(0, MAX_TITLE).join('')
}

export function titleWithSuffix(base: string, suffix: string): string {
  const cleanSuffix = titleOf(suffix)
  const suffixChars = Array.from(cleanSuffix)
  if (suffixChars.length >= MAX_TITLE) return suffixChars.slice(0, MAX_TITLE).join('')
  const prefix = Array.from(base)
    .slice(0, MAX_TITLE - suffixChars.length)
    .join('')
    .trimEnd()
  return `${prefix}${cleanSuffix}`
}

function clipped(text: unknown, max: number): string {
  return Array.from(String(text ?? '').trim())
    .slice(0, max)
    .join('')
}

// 文件开头用 --- 括起来的那一段，只认「键: 值」和缩进一层的「键: 值」（Claude Code 的记忆文件就这么多）；
// 缩进更深的、多行写法（> 与 |）的值不认。返回 { meta, body }：
// - 不是以单独一行 --- 开头，或者里面有不像键值的行：没有文件头，body 是全文（以分隔线开头的普通 Markdown）
// - 像文件头却找不到单独一行的 --- 结尾：unterminated 为真，调用方不要把它当正文发出去
export function frontmatter(text: string): {
  meta: Record<string, string>
  body: string
  unterminated?: boolean
} {
  const whole = text.replace(/^\uFEFF/, '')
  const lines = whole.split(/\r?\n/)
  const plainBody = { meta: {}, body: whole }
  if (lines[0]?.trimEnd() !== '---') return plainBody
  const meta: Record<string, string> = {}
  let parent: string | null = null
  let childIndent: number | null = null
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

// 一份 Markdown 拆成几条：围栏代码块内部的分隔行与标题行不触发拆分；有只写着一个分节号（U+00A7，Hermes 用它隔开各条）的行就按它拆，
// 否则按二级标题拆，都没有就是一整条。每条是 { heading, text }，heading 可能没有
export function sections(text: string): Array<{ heading: string | null; text: string }> {
  const body = text.replace(/^\uFEFF/, '')
  const lines = body.split(/\r?\n/)
  let fence: { char: string; len: number } | null = null
  let hasSectionSep = false
  const insideFence = lines.map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!fence && open) {
      const char = open[1][0]
      if (char === '~' || !open[2].includes('`')) {
        fence = { char, len: open[1].length }
        return true
      }
    } else if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        fence = null
      }
      return true
    }
    if (/^\u00a7\s*$/.test(line)) hasSectionSep = true
    return false
  })

  if (hasSectionSep) {
    const parts: string[][] = [[]]
    lines.forEach((line, idx) => {
      if (!insideFence[idx] && /^\u00a7\s*$/.test(line)) parts.push([])
      else parts[parts.length - 1].push(line)
    })
    return parts
      .map((group) => ({ heading: null, text: group.join('\n').trim() }))
      .filter((part) => part.text)
  }

  const parts: Array<{ heading: string | null; lines: string[] }> = []
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] }
  lines.forEach((line, idx) => {
    const heading = !insideFence[idx] ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (heading) {
      parts.push(current)
      current = { heading: heading[1], lines: [line] }
    } else current.lines.push(line)
  })
  parts.push(current)
  return parts
    .map((part) => ({ heading: part.heading, text: part.lines.join('\n').trim() }))
    .filter((part) => part.text)
}

// 记忆项：{ source, title, projects, runtimes, topics, content, disclosure }，或者 { source, skipped: 原因 }
function entry(
  source: string,
  {
    title,
    baseTitle,
    projects,
    runtimes,
    topics,
    content,
    disclosure,
  }: {
    title: string
    baseTitle?: string
    projects?: string[]
    runtimes?: string[]
    topics?: string[]
    content: string
    disclosure?: string
  },
): SourceEntry {
  const text = content.trim()
  if (!text) return { source, skipped: '没有内容' }
  if (text.length > MAX_CONTENT) {
    return { source, skipped: `正文超过 ${MAX_CONTENT} 个字，拆开后再导入` }
  }
  const item: SourceEntry = {
    source,
    title: titleOf(title) || titleOf(basename(source)) || '未命名记忆',
    ...(baseTitle ? { baseTitle } : {}),
    ...(projects?.length ? { projects } : {}),
    ...(runtimes?.length ? { runtimes } : {}),
    ...(topics?.length ? { topics } : {}),
    content: text,
  }
  const hint = clipped(disclosure, MAX_DISCLOSURE)
  return hint ? { ...item, disclosure: hint } : item
}

// 一个记忆文件最多这么大（字节）：正文上限是 10 万字，再大的不读进内存
const MAX_FILE_BYTES = 512 * 1024

// 读一个记忆文件的文字。只读普通文件：符号链接不跟（它可以指到记忆目录之外的任何文件，读出来就发给服务端了），
// 管道、设备这类也不读；太大的、不是文本的不读。可读取返回 { text }，失败返回 { problem }；没有这个文件返回 null
async function readable(file: string): Promise<{ text: string } | { problem: string } | null> {
  const info = await lstat(file).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink()) return { problem: '是符号链接，不读' }
  if (!info.isFile()) return { problem: '不是普通文件' }
  if (info.size > MAX_FILE_BYTES) return { problem: '文件太大，不读' }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { problem: '无法读取这个文件' }
  }
  // 带着空字符或解码不了的字节（成了替换字符）的不是文本
  if (text.includes('\0') || text.includes('\uFFFD')) return { problem: '不是文本文件' }
  return { text }
}

// 是不是真的目录（不是指向别处的符号链接）
async function isRealDir(dir: string): Promise<boolean> {
  return (await lstat(dir).catch(() => null))?.isDirectory() ?? false
}

async function markdownFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((name) => name.toLowerCase().endsWith('.md')).sort()
}

// 标识里的一段，从末尾取：太长时留后面的（路径越靠后越能区分）
function tailSegment(text: string): string {
  const slug = segment(text.length > MAX_SEGMENT ? text.slice(-MAX_SEGMENT) : text)
  return slug.replace(/^-+/, '') || segment(text)
}

// Claude Code 把项目目录的路径编码成目录名（斜杠等换成 -），还原不回去。
// 去掉开头的主目录与常见的上级目录，剩下的当项目名：标签里要的是认得出的名字，不是整段路径。
// 代价是分不清的情况会得到同一个名字（~/code/dev-proxy 与 ~/code/proxy）：这时两个项目里同名的记忆会按来源摘要消歧，
// 不会悄悄顶掉。主目录对不上时（换了机器、换了用户）项目名会带着整段路径
const CONTAINERS =
  /^(documents|desktop|code|projects|project|src|work|workspace|dev|repos|git|github)-/i
export function claudeProjectName(encoded: string, home = homedir()): string {
  const prefix = home.replace(/[^A-Za-z0-9]/g, '-')
  // 前缀之后要正好是一段的开头，/Users/lm 不能去掉 -Users-lmx-… 的开头；Windows 下盘符与路径大小写不敏感
  const hasPrefix =
    encoded.length > prefix.length &&
    encoded[prefix.length] === '-' &&
    encoded.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  let rest = hasPrefix ? encoded.slice(prefix.length + 1) : encoded
  rest = rest.replace(/^-+/, '')
  while (CONTAINERS.test(rest)) rest = rest.replace(CONTAINERS, '')
  return tailSegment(rest || encoded)
}

// Claude Code 的自动记忆：<配置目录>/projects/<项目>/memory/*.md，一个文件一条，文件头里有名字、说明与类型。
// MEMORY.md 是索引，不是记忆；带上项目、客户端与主题标签
async function claudeCode({
  env,
  path,
}: {
  env: Env
  path?: string
  client?: string
}): Promise<SourceReadResult> {
  // 先变成绝对路径：相对路径取上一级的名字会取到 . 或 ..
  const root = resolve(
    path ?? join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
  )
  const info =
    path !== undefined ? await lstat(root).catch(() => null) : await stat(root).catch(() => null)
  if (!info?.isDirectory()) return { root, found: false, entries: [] }
  // 指定 --path 时区分「某个项目的 memory 目录」与「projects 根目录」；默认路径固定为 projects 根目录
  let direct = false
  if (path !== undefined) {
    if (basename(root) === 'memory') direct = true
    else if ((await markdownFiles(root)).length > 0) {
      const subNames = await readdir(root).catch(() => [] as string[])
      const checks = await Promise.all(subNames.map((n) => isRealDir(join(root, n, 'memory'))))
      direct = !checks.some(Boolean)
    }
  }
  const projects: Array<{ name: string; rawDir: string; dir: string }> = direct
    ? [{ name: claudeProjectName(basename(dirname(root))), rawDir: root, dir: root }]
    : (
        await Promise.all(
          (await readdir(root).catch(() => [] as string[])).sort().map(async (name) => {
            const projDir = join(root, name)
            const memDir = join(projDir, 'memory')
            if (!(await isRealDir(projDir)) || !(await isRealDir(memDir))) return null
            return { name: claudeProjectName(name), rawDir: name, dir: memDir }
          }),
        )
      ).filter((item): item is { name: string; rawDir: string; dir: string } => item !== null)
  const entries: SourceEntry[] = []
  const titleProject = new Map<string, string>()
  for (const project of projects) {
    for (const name of await markdownFiles(project.dir)) {
      if (name.toUpperCase() === 'MEMORY.MD') continue
      if (entries.length >= MAX_FILES) break
      const source = join(project.dir, name)
      const read = await readable(source)
      if (!read) continue
      if ('problem' in read) {
        entries.push({ source, skipped: read.problem })
        continue
      }
      const { meta, body, unterminated } = frontmatter(read.text)
      if (unterminated) {
        entries.push({ source, skipped: '文件头没有结尾的 ---，分不清哪些是正文' })
        continue
      }
      const stem = name.replace(/\.md$/i, '')
      const type = meta['metadata.type'] || meta.type || ''
      const runtimes = type === 'feedback' ? ['claudecode'] : undefined
      const topics = ['claude-code', segment(type || 'project')]
      const baseTitle =
        titleOf(meta.description || meta.name || stem) || titleOf(stem) || '未命名记忆'
      const prevProjDir = titleProject.get(baseTitle)
      let itemTitle = baseTitle
      if (prevProjDir !== undefined && prevProjDir !== project.dir) {
        const withProj = titleWithSuffix(baseTitle, `（${project.name}）`)
        const clash = titleProject.get(withProj)
        itemTitle =
          clash === undefined || clash === project.dir
            ? withProj
            : titleWithSuffix(baseTitle, `（${project.name}-${digest(source).slice(2, 6)}）`)
      }
      const built = entry(source, {
        title: itemTitle,
        ...(itemTitle !== baseTitle ? { baseTitle } : {}),
        projects: [project.name],
        ...(runtimes ? { runtimes } : {}),
        topics,
        content: body,
        disclosure: meta.description,
      })
      if (!built.skipped && !titleProject.has(itemTitle)) {
        titleProject.set(itemTitle, project.dir)
      }
      entries.push(built)
    }
  }
  return { root, found: true, entries }
}

// 一段文字的摘要，做标题消歧标识：内容不变标识就不变
function digest(text: string): string {
  return `m-${createHash('sha256').update(text).digest('hex').slice(0, 10)}`
}

interface SourceFileSpec {
  file: string
  title: string
  runtimes?: string[]
  topics: string[]
  single?: boolean
}

// 一组「文件 → 迁入记忆」的来源：每个文件按 sections 拆成几条。标题优先取小节标题，无小节标题或重名时按内容摘要消歧；
// 不按顺序编号：文件里插一条、删一条之后，别的条标题不能跟着变，否则去重就认不出它们了。
async function fromFiles(root: string, files: SourceFileSpec[]): Promise<SourceReadResult> {
  const info = await lstat(root).catch(() => null)
  if (!info?.isDirectory()) return { root, found: false, entries: [] }
  const entries: SourceEntry[] = []
  const usedTitles = new Set<string>()
  for (const { file, title, runtimes, topics, single } of files) {
    const source = join(root, file)
    const read = await readable(source)
    if (!read) continue
    if ('problem' in read) {
      entries.push({ source, skipped: read.problem })
      continue
    }
    const parts = single ? [{ heading: null, text: read.text.trim() }] : sections(read.text)
    parts.forEach((part, index) => {
      const headingTitle = part.heading ? titleOf(part.heading) : ''
      const baseTitle = single ? titleOf(title) || title : headingTitle || titleOf(title) || title
      let itemTitle: string
      if (single) {
        itemTitle = baseTitle
      } else if (parts.length === 1) {
        itemTitle = baseTitle
      } else {
        itemTitle =
          headingTitle && !usedTitles.has(headingTitle)
            ? headingTitle
            : titleWithSuffix(baseTitle, `（${digest(part.text).slice(2, 8)}）`)
      }
      if (usedTitles.has(itemTitle)) {
        itemTitle = titleWithSuffix(
          baseTitle,
          `（${digest(`${file}:${index}:${part.text}`).slice(2, 8)}）`,
        )
      }
      usedTitles.add(itemTitle)

      entries.push(
        entry(parts.length > 1 ? `${source}（第 ${index + 1} 段）` : source, {
          title: itemTitle,
          ...(runtimes ? { runtimes } : {}),
          topics,
          content: part.text,
        }),
      )
    })
  }
  return { root, found: true, entries }
}

// Hermes：<主目录>/.hermes/memories 下的 MEMORY.md（agent 自己记的）与 USER.md（个人偏好）
function hermes({
  env,
  path,
}: {
  env: Env
  path?: string
  client?: string
}): Promise<SourceReadResult> {
  const root = resolve(path ?? join(env.HERMES_HOME || join(homedir(), '.hermes'), 'memories'))
  return fromFiles(root, [
    {
      file: 'MEMORY.md',
      title: 'Hermes 的记忆',
      runtimes: ['hermes'],
      topics: ['hermes', 'notes'],
    },
    {
      file: 'USER.md',
      title: 'Hermes 记下的个人偏好',
      topics: ['hermes', 'about'],
    },
  ])
}

// OpenClaw：工作区下的 MEMORY.md、USER.md，以及 memory/ 里按日期的笔记（一个文件整个当一条）。
// OPENCLAW_HOME 换的是主目录，工作区默认在它下面的 .openclaw/workspace；配置里改过工作区位置的用 --path 指明
async function openclaw({
  env,
  path,
}: {
  env: Env
  path?: string
  client?: string
}): Promise<SourceReadResult> {
  const root = resolve(path ?? join(env.OPENCLAW_HOME || homedir(), '.openclaw', 'workspace'))
  const notes = join(root, 'memory')
  const daily: SourceFileSpec[] = ((await isRealDir(notes)) ? await markdownFiles(notes) : [])
    // 一天可以有几个：2026-11-10.md，或者带后缀的 2026-11-10-<名字>.md
    .filter((name) => /^\d{4}-\d{2}-\d{2}(-[A-Za-z0-9][A-Za-z0-9-]*)?\.md$/.test(name))
    .slice(0, MAX_FILES)
    .map((name) => {
      const stem = name.slice(0, -3)
      const suffix = stem.slice(11)
      return {
        file: join('memory', name),
        title: suffix ? `${stem.slice(0, 10)} 的笔记（${suffix}）` : `${stem} 的笔记`,
        runtimes: ['openclaw'],
        topics: ['openclaw', 'journal'],
        single: true,
      }
    })
  return fromFiles(root, [
    {
      file: 'MEMORY.md',
      title: 'OpenClaw 的记忆',
      runtimes: ['openclaw'],
      topics: ['openclaw', 'notes'],
    },
    {
      file: 'USER.md',
      title: 'OpenClaw 记下的个人偏好',
      topics: ['openclaw', 'about'],
    },
    ...daily,
  ])
}

export const SOURCES: Record<
  string,
  {
    name: string
    read: (opts: { env: Env; path?: string; client?: string }) => Promise<SourceReadResult>
  }
> = {
  'claude-code': { name: 'Claude Code 的自动记忆', read: claudeCode },
  hermes: { name: 'Hermes 的记忆文件', read: hermes },
  openclaw: { name: 'OpenClaw 工作区的记忆文件', read: openclaw },
}

// 认得、但不可迁移的来源，说明原因
export const UNSUPPORTED_SOURCES: Record<string, string> = {
  codex:
    'Codex 自带的 Memories 存在它自己的数据库里，格式未公开，无法迁移；它在本地默认处于关闭状态',
  pi: 'pi 没有自带的长期记忆',
  dsh: 'DeepSeek Harness 没有自带的长期记忆',
  opencode: 'OpenCode 没有自带的长期记忆文件',
  gemini: 'Gemini CLI 没有自带的独立长期记忆目录',
  agy: 'Antigravity 没有自带的长期记忆文件',
  zcode: 'ZCode 没有自带的可迁移长期记忆文件',
}

export function sourceNames(): string {
  return Object.keys(SOURCES).join('、')
}
