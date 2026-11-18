// 日常记忆读写命令：search（语义+全文+关键词召回）、get（按坐标读取）、ls（按归属或前缀浏览目录）、add（新建记忆并处理明文拦阻）。
// 身份默认经 identity.ts 自动解析，支持管道读取正文、$EDITOR 交互撰写与 --json 结构化输出。

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KiokuFailure,
  UsageError,
  fetchFailure,
  isRedirect,
  plain,
  redirectError,
} from '../core.ts'
import { isInteractiveTty, resolveIdentity } from '../identity.ts'
import { isCancel, loadPrompts } from '../prompts.ts'
import type { Env, Reader, TargetConfig, Writer } from '../types.ts'
import {
  createTheme,
  layerLabel,
  renderBox,
  sensitivityBadge,
  type StrataTheme,
} from '../ui/theme.ts'
import { stripAnsi, wrapWidth } from '../ui/width.ts'

const TIMEOUT = 15_000
const STDIN_MAX_BYTES = 256 * 1024
const CURATED_ROOTS = ['user', 'app', 'persona', 'core'] as const

const SEGMENT_PATTERN = '[a-z0-9_-]{1,64}'
const MEMORY_URI_RE = new RegExp(
  `^(?!(?:persona|app)://${SEGMENT_PATTERN}$)` +
    `(core|user|persona|app)://${SEGMENT_PATTERN}(?:/${SEGMENT_PATTERN}){0,15}$`,
)

const ROOT_ALIASES: Record<string, string> = {
  本人: 'user',
  应用: 'app',
  人格: 'persona',
  通用: 'core',
}

const SENSITIVITY_ALIASES: Record<string, 'public' | 'internal' | 'private' | 'secret'> = {
  public: 'public',
  公开: 'public',
  internal: 'internal',
  内部: 'internal',
  private: 'private',
  私密: 'private',
  secret: 'secret',
  机密: 'secret',
}

export interface MemoryViewData {
  id: string
  uri: string
  title: string
  layer: string
  sensitivity: string
  provenance?: string
  originScope?: string
  content: string | null
  priority: number
  disclosure: string | null
  glossary?: string[]
  validFrom?: string
  validTo?: string | null
  version: number
  createdAt?: string
  updatedAt?: string
}

export interface RecallCandidateData {
  uri: string
  title: string
  layer: string
  priority: number
  disclosure: string | null
  score: number
  via?: string[]
  cues?: string[]
}

export interface RecallResponseData {
  candidates: RecallCandidateData[]
  subjects?: unknown[]
}

export interface MemorySummaryData {
  uri: string
  exists: boolean
  id: string | null
  title: string | null
  layer: string | null
  sensitivity: string | null
  priority: number | null
  disclosure: string | null
  childCount: number
}

export interface MemoryChildrenData {
  parent: MemoryViewData | null
  children: MemorySummaryData[]
  truncated: boolean
}

interface PlaintextSpot {
  line?: unknown
  kind?: unknown
}

function sanitizeBody(text: string): string {
  return stripAnsi(text)
    .replaceAll('\t', '  ')
    .replace(/(?!\n|\r)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
}

function boxWidthFor(out: { columns?: number }): number {
  return Math.min(92, Math.max(54, (out.columns ?? 88) - 2))
}

function maskKeyText(raw: unknown, key: string): string {
  const str = typeof raw === 'string' ? raw : ''
  const masked = key ? str.split(key).join('***') : str
  return plain(masked)
}

async function memoryRequest(
  config: TargetConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response
  let data: Record<string, unknown> | null
  try {
    res = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // 访问密钥只发给已配置的服务端地址，不跟随跳转
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), config.url))
  }
  return { status: res.status, data }
}

function throwForStatus(status: number, data: Record<string, unknown> | null, key: string): never {
  if (status === 401) throw new KiokuFailure('访问密钥无效或已吊销')
  if (status === 403) throw new KiokuFailure('当前访问密钥无权执行此操作')
  if (status === 404) throw new KiokuFailure('记忆不存在，或当前访问密钥无权读取')
  const detail = maskKeyText(data?.error, key)
  throw new KiokuFailure(detail || `Kioku 返回 HTTP ${status}`)
}

function renderMemoryCard(
  view: MemoryViewData,
  out: { isTTY?: boolean; columns?: number },
  theme: StrataTheme,
): string {
  const width = boxWidthFor(out)
  const meta: string[] = [
    `归属：${theme.layer(view.layer)} · 敏感级：${sensitivityBadge(view.sensitivity, theme)} · 优先级：${view.priority} · 版本：${view.version}`,
  ]
  if (view.disclosure) meta.push(`触发条件：${plain(view.disclosure)}`)
  if (Array.isArray(view.glossary) && view.glossary.length) {
    meta.push(`关键词：${view.glossary.map((g) => plain(g)).join('、')}`)
  }
  if (view.validTo) meta.push(`有效期至：${plain(view.validTo)}`)

  const bodyLines =
    view.content === null
      ? [theme.muted('（机密记忆正文不随读取返回，请在管理界面查看）')]
      : wrapWidth(sanitizeBody(view.content), width - 4)

  return renderBox({
    title: plain(view.title) || '未命名记忆',
    width,
    theme,
    sections: [
      { title: '属性', lines: meta },
      { title: '正文', lines: bodyLines.length ? bodyLines : [''] },
      { title: '坐标', lines: [theme.muted(plain(view.uri))] },
    ],
  })
}

export const SEARCH_USAGE = `用法：kioku search <查询> [--limit <条数>] [--platform <平台>] [--json]

从 Kioku 召回与查询相关的记忆（综合语义、全文与关键词）。在交互式终端里可直接按回车查看某条记忆正文。

  <查询>               要检索的关键词或问题
  --limit <条数>       最多返回的条数（1 到 50，默认沿用服务端设置）
  --platform <平台>    指定使用哪个已配置客户端的身份（默认自动识别）
  --json               以 JSON 格式输出（含候选列表与联系人直连事实）
`

export function parseSearchArgs(argv: string[]): {
  query?: string
  limit?: number
  platform?: string
  json: boolean
} {
  const queryParts: string[] = []
  let limit: number | undefined
  let platform: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--limit') {
      const raw = argv[++i]
      if (!raw) throw new UsageError('--limit 后面要写条数')
      if (!/^\d+$/.test(raw)) throw new UsageError('--limit 须为 1 到 50 之间的整数')
      const num = Number(raw)
      if (!Number.isInteger(num) || num < 1 || num > 50) {
        throw new UsageError('--limit 须为 1 到 50 之间的整数')
      }
      limit = num
    } else if (arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else {
      queryParts.push(arg)
    }
  }
  const query = queryParts.join(' ').trim() || undefined
  return { query, limit, platform, json }
}

export async function searchCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseSearchArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })

  let query = options.query
  const interactive = !options.json && isInteractiveTty(stdin, out)
  if (!query) {
    if (!interactive) throw new UsageError('请写要检索的内容，例如 kioku search 部署流程')
    const ui = await loadPrompts({ input: stdin, output: out })
    if (!ui) throw new UsageError('请写要检索的内容')
    const entered = await ui.text({
      message: '检索记忆',
      placeholder: '输入关键词或问题',
      validate: (v) => (v.trim() ? undefined : '检索内容不能为空'),
    })
    if (isCancel(entered)) return 0
    query = String(entered).trim()
  }

  const body: { query: string; limit?: number } = { query }
  if (options.limit !== undefined) body.limit = options.limit

  const { status, data } = await memoryRequest(config, 'POST', '/v1/recall', body)
  if (status !== 200) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data ?? { candidates: [], subjects: [] }, null, 2)}\n`)
    return 0
  }

  const recall = (data ?? {}) as Partial<RecallResponseData>
  const candidates = Array.isArray(recall.candidates) ? recall.candidates : []
  const theme = createTheme({ stream: out, env })
  const width = boxWidthFor(out)

  if (!candidates.length) {
    const emptyBox = renderBox({
      title: `检索：${plain(query)}`,
      width,
      theme,
      sections: [{ lines: [theme.muted('暂无匹配记忆')] }],
    })
    out.write(`${emptyBox}\n`)
    return 0
  }

  const lines: string[] = []
  candidates.forEach((c, idx) => {
    const scoreText = typeof c.score === 'number' ? c.score.toFixed(2) : '-'
    lines.push(
      `${theme.bold(`${idx + 1}.`)} ${theme.bold(plain(c.title))}  ${theme.layer(c.layer)}  ${theme.muted(`相关度 ${scoreText}`)}`,
    )
    if (c.disclosure) lines.push(`   ${theme.muted(plain(c.disclosure))}`)
    lines.push(`   ${theme.muted(`坐标：${plain(c.uri)}`)}`)
  })

  const box = renderBox({
    title: `检索：${plain(query)}（${candidates.length} 条）`,
    width,
    theme,
    sections: [{ lines }],
  })
  out.write(`${box}\n`)

  if (!interactive) return 0

  const ui = await loadPrompts({ input: stdin, output: out })
  if (!ui) return 0

  for (;;) {
    const pick = await ui.select<string>({
      message: '选择一条记忆查看正文',
      options: [
        ...candidates.map((c) => ({
          value: c.uri,
          label: plain(c.title),
          hint: `${layerLabel(c.layer)} · ${c.uri}`,
        })),
        { value: '__exit__', label: '退出查看' },
      ],
    })
    if (isCancel(pick) || pick === '__exit__' || typeof pick !== 'string') break
    const res = await memoryRequest(config, 'GET', `/v1/memories?uri=${encodeURIComponent(pick)}`)
    if (res.status !== 200) throwForStatus(res.status, res.data, config.key)
    out.write(`\n${renderMemoryCard(res.data as unknown as MemoryViewData, out, theme)}\n`)
  }
  return 0
}

export const GET_USAGE = `用法：kioku get <坐标> [--platform <平台>] [--json]

按坐标读取单条记忆的完整属性与正文。

  <坐标>             例如 core://agent、user://preferences/reply_style
  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出记忆对象
`

export function parseGetArgs(argv: string[]): { uri: string; platform?: string; json: boolean } {
  let uri: string | undefined
  let platform: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (uri !== undefined) {
      throw new UsageError('每次只指定一个记忆坐标')
    } else {
      uri = arg
    }
  }
  if (!uri) throw new UsageError('请指定记忆坐标，例如 user://preferences/reply_style')
  return { uri, platform, json }
}

export async function getCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseGetArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })

  const { status, data } = await memoryRequest(
    config,
    'GET',
    `/v1/memories?uri=${encodeURIComponent(options.uri)}`,
  )
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  out.write(`${renderMemoryCard(data as unknown as MemoryViewData, out, theme)}\n`)
  return 0
}

export const LS_USAGE = `用法：kioku ls [坐标或归属] [--platform <平台>] [--json]

浏览记忆目录结构：不写参数时按地层顺序（本人、应用、人格、通用）列出根级节点，
也可指定归属或前缀路径列出直接子节点。

  [坐标或归属]       user / app / persona / core（或本人/应用/人格/通用），或前缀如 user://projects
  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出目录子节点
`

export function normalizeLsTarget(raw: string): string {
  const trimmed = raw.trim()
  if (Object.hasOwn(ROOT_ALIASES, trimmed)) return ROOT_ALIASES[trimmed]
  const rootMatch = /^(user|app|persona|core):\/\/$/i.exec(trimmed)
  if (rootMatch) return rootMatch[1].toLowerCase()
  return trimmed.replace(/\/+$/, '')
}

export function parseLsArgs(argv: string[]): { target?: string; platform?: string; json: boolean } {
  let target: string | undefined
  let platform: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (target !== undefined) {
      throw new UsageError('最多指定一个目录或归属')
    } else {
      target = normalizeLsTarget(arg)
    }
  }
  return { target, platform, json }
}

function formatChildLines(children: MemorySummaryData[], theme: StrataTheme): string[] {
  if (!children.length) return [theme.muted('暂无记忆')]
  const lines: string[] = []
  for (const child of children) {
    const lastSegment = child.uri.split('/').pop() ?? child.uri
    const name =
      child.exists && child.title ? theme.bold(plain(child.title)) : `${plain(lastSegment)}/`
    const tags: string[] = []
    if (child.sensitivity) tags.push(sensitivityBadge(child.sensitivity, theme))
    if (child.childCount > 0) tags.push(theme.muted(`下级 ${child.childCount} 项`))
    lines.push(
      `${name}${tags.length ? `  ${tags.join(' · ')}` : ''}  ${theme.muted(plain(child.uri))}`,
    )
  }
  return lines
}

export async function lsCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseLsArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })
  const theme = createTheme({ stream: out, env })
  const width = boxWidthFor(out)

  if (!options.target) {
    const rootResults = await Promise.all(
      CURATED_ROOTS.map(async (root) => {
        const res = await memoryRequest(
          config,
          'GET',
          `/v1/memories/children?of=${encodeURIComponent(root)}`,
        )
        return { root, label: layerLabel(root), ...res }
      }),
    )

    for (const r of rootResults) {
      if (r.status === 401) throwForStatus(401, r.data, config.key)
      if (r.status >= 500) throwForStatus(r.status, r.data, config.key)
    }

    if (options.json) {
      out.write(
        `${JSON.stringify(
          {
            roots: rootResults.map((r) => ({
              root: r.root,
              label: r.label,
              ...(r.status === 200
                ? r.data
                : { error: maskKeyText(r.data?.error, config.key) || `HTTP ${r.status}` }),
            })),
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }

    const box = renderBox({
      title: '记忆目录',
      width,
      theme,
      sections: rootResults.map((r) => {
        if (r.status === 403) {
          return {
            title: `${theme.layer(r.root)}`,
            lines: [theme.muted('（当前访问密钥无权读取）')],
          }
        }
        if (r.status !== 200) {
          return {
            title: `${theme.layer(r.root)}`,
            lines: [theme.error(maskKeyText(r.data?.error, config.key) || `HTTP ${r.status}`)],
          }
        }
        const payload = r.data as unknown as MemoryChildrenData
        const children = Array.isArray(payload.children) ? payload.children : []
        const lines = formatChildLines(children, theme)
        if (payload.truncated) {
          lines.push(theme.muted(`（已截断，仅显示前 ${children.length} 项）`))
        }
        return { title: `${theme.layer(r.root)}`, lines }
      }),
    })
    out.write(`${box}\n`)
    return 0
  }

  const { status, data } = await memoryRequest(
    config,
    'GET',
    `/v1/memories/children?of=${encodeURIComponent(options.target)}`,
  )
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data, null, 2)}\n`)
    return 0
  }

  const payload = data as unknown as MemoryChildrenData
  const children = Array.isArray(payload.children) ? payload.children : []
  const lines = formatChildLines(children, theme)
  if (payload.truncated) lines.push(theme.muted(`（已截断，仅显示前 ${children.length} 项）`))

  const sections = payload.parent
    ? [
        {
          title: '当前节点',
          lines: [
            `${theme.bold(plain(payload.parent.title))}  ${theme.layer(payload.parent.layer)} · ${sensitivityBadge(payload.parent.sensitivity, theme)}`,
          ],
        },
        { title: '下级节点', lines },
      ]
    : [{ lines }]

  const box = renderBox({
    title: `目录：${plain(options.target)}`,
    width,
    theme,
    sections,
  })
  out.write(`${box}\n`)
  return 0
}

export const ADD_USAGE = `用法：kioku add [坐标] [--title <标题>] [--content <正文>] [--sensitivity <级别>]
                [--disclosure <触发条件>] [--priority <0-99>] [--plaintext-ok] [--platform <平台>] [--json]

写入一条新记忆（也可以经标准输入管道传入正文，或在交互式终端打开编辑器填写）。

  [坐标]               core://...、user://...、persona://<标识>/... 或 app://<标识>/...
  --title <标题>       显示名称（省略时取正文首个一级标题或坐标最后一段）
  --content <正文>     记忆正文；省略时读取管道标准输入或打开编辑器
  --sensitivity <级别> 公开 / 内部 / 私密 / 机密（也收 public / internal / private / secret）
  --disclosure <条件>  说明何时让模型展开读取这条记忆
  --priority <0-99>    优先级整数（0–99）
  --plaintext-ok       确认正文疑似明文不是凭据，照常写入（记忆将进入待处理）
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出创建的记忆
`

export function parseAddArgs(argv: string[]): {
  uri?: string
  title?: string
  content?: string
  sensitivity?: 'public' | 'internal' | 'private' | 'secret'
  disclosure?: string
  priority?: number
  plaintextOk: boolean
  platform?: string
  json: boolean
} {
  let uri: string | undefined
  let title: string | undefined
  let content: string | undefined
  let sensitivity: 'public' | 'internal' | 'private' | 'secret' | undefined
  let disclosure: string | undefined
  let priority: number | undefined
  let plaintextOk = false
  let platform: string | undefined
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--plaintext-ok' || arg === '--allow-plaintext') plaintextOk = true
    else if (
      arg === '--title' ||
      arg === '--content' ||
      arg === '--sensitivity' ||
      arg === '--disclosure' ||
      arg === '--priority' ||
      arg === '--platform'
    ) {
      const val = argv[++i]
      if (val === undefined) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--title') title = val
      else if (arg === '--content') content = val
      else if (arg === '--disclosure') disclosure = val
      else if (arg === '--platform') platform = val
      else if (arg === '--sensitivity') {
        const mapped = SENSITIVITY_ALIASES[val.trim().toLowerCase()]
        if (!mapped) {
          throw new UsageError(
            '--sensitivity 只收 公开、内部、私密、机密（或 public、internal、private、secret）',
          )
        }
        sensitivity = mapped
      } else {
        if (!/^\d+$/.test(val)) throw new UsageError('--priority 须为 0 到 99 之间的整数')
        const num = Number(val)
        if (!Number.isInteger(num) || num < 0 || num > 99) {
          throw new UsageError('--priority 须为 0 到 99 之间的整数')
        }
        priority = num
      }
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (uri !== undefined) {
      throw new UsageError('最多指定一个记忆坐标')
    } else {
      uri = arg
    }
  }
  return { uri, title, content, sensitivity, disclosure, priority, plaintextOk, platform, json }
}

async function readPipedStdin(stdin: Reader): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    total += buf.length
    if (total > STDIN_MAX_BYTES) {
      throw new KiokuFailure(`标准输入超出 ${STDIN_MAX_BYTES / 1024} KB 限制`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function editInTempEditor(env: Env): Promise<string | null> {
  const editorRaw = (env.VISUAL || env.EDITOR || '').trim()
  if (!editorRaw) return null
  const parts = editorRaw.split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const dir = await mkdtemp(join(tmpdir(), 'kioku-edit-'))
  const file = join(dir, 'memory.md')
  try {
    await writeFile(file, '', 'utf8')
    const res = spawnSync(parts[0], [...parts.slice(1), file], { stdio: 'inherit', env })
    if (res.error || res.status !== 0) return null
    return await readFile(file, 'utf8')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function addCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseAddArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })
  const interactive = !options.json && isInteractiveTty(stdin, out)

  let uri = options.uri
  if (!uri) {
    if (!interactive) throw new UsageError('请指定记忆坐标，例如 user://preferences/reply_style')
    const ui = await loadPrompts({ input: stdin, output: out })
    if (!ui) throw new UsageError('请指定记忆坐标')
    const root = await ui.select<'user' | 'app' | 'persona' | 'core'>({
      message: '选择记忆归属',
      options: [
        { value: 'user', label: '本人（user://）', hint: '个人习惯与偏好' },
        { value: 'app', label: '应用（app://）', hint: '特定客户端规则' },
        { value: 'persona', label: '人格（persona://）', hint: '特定人格设定' },
        { value: 'core', label: '通用（core://）', hint: '所有客户端共用' },
      ],
    })
    if (isCancel(root) || typeof root !== 'string') return 0
    const hintPath =
      root === 'app'
        ? 'claudecode/rules/coding'
        : root === 'persona'
          ? 'default/style'
          : 'preferences/reply_style'
    const restPath = await ui.text({
      message: `填写 ${root}:// 后的路径与标识`,
      placeholder: hintPath,
      validate: (v) => {
        const candidate = `${root}://${v.trim().replace(/^\/+/, '')}`
        return MEMORY_URI_RE.test(candidate)
          ? undefined
          : '坐标片段只支持小写字母、数字、_ 或 -，应用与人格至少需要两段'
      },
    })
    if (isCancel(restPath)) return 0
    uri = `${root}://${String(restPath).trim().replace(/^\/+/, '')}`
  }

  if (!MEMORY_URI_RE.test(uri)) {
    throw new UsageError(
      '坐标格式不对：支持 core://…、user://…、persona://<标识>/…、app://<标识>/…，每段用小写字母、数字、_ 或 -',
    )
  }

  let content = options.content
  if (content === undefined) {
    if (!stdin.isTTY) {
      content = await readPipedStdin(stdin)
    } else if (interactive) {
      const fromEditor = await editInTempEditor(env)
      if (fromEditor !== null) {
        content = fromEditor
      } else {
        const ui = await loadPrompts({ input: stdin, output: out })
        if (!ui) throw new UsageError('请用 --content 指定记忆正文')
        const entered = await ui.text({
          message: '记忆正文',
          validate: (v) => (v.trim() ? undefined : '正文不能为空'),
        })
        if (isCancel(entered)) return 0
        content = String(entered)
      }
    }
  }

  if (!content || !content.trim()) {
    throw new UsageError('记忆正文不能为空（可用 --content 传入或经标准输入管道提供）')
  }

  const basePayload: Record<string, unknown> = {
    uri,
    content,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.sensitivity !== undefined ? { sensitivity: options.sensitivity } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
    ...(options.plaintextOk ? { plaintextOk: true } : {}),
  }

  let { status, data } = await memoryRequest(config, 'POST', '/v1/memories', basePayload)

  if (status === 400 && Array.isArray(data?.plaintext) && data.plaintext.length > 0) {
    const spots = data.plaintext as PlaintextSpot[]
    const spotLines = spots.map(
      (spot) => `正文第 ${Number(spot.line) || '?'} 行：${plain(spot.kind)}`,
    )
    const theme = createTheme({ stream: out, env })

    if (interactive && !options.plaintextOk) {
      const box = renderBox({
        title: '检测到疑似明文凭据',
        width: boxWidthFor(out),
        theme,
        sections: [{ lines: spotLines }],
      })
      out.write(`${box}\n`)
      const ui = await loadPrompts({ input: stdin, output: out })
      if (!ui) return 1
      const decision = await ui.select<'cancel' | 'plaintextOk'>({
        message: '请选择处理方式',
        options: [
          {
            value: 'cancel',
            label: '取消写入（先存为凭据或改用占位符）',
          },
          {
            value: 'plaintextOk',
            label: '确认不是凭据，照常写入（进入待处理列表）',
          },
        ],
      })
      if (isCancel(decision) || decision !== 'plaintextOk') {
        out.write('已取消写入\n')
        return 1
      }
      const retry = await memoryRequest(config, 'POST', '/v1/memories', {
        ...basePayload,
        plaintextOk: true,
      })
      status = retry.status
      data = retry.data
    } else {
      if (options.json) {
        out.write(`${JSON.stringify(data, null, 2)}\n`)
        return 1
      }
      out.write(`${theme.error('✗')} 检测到疑似明文凭据，已阻止写入：\n`)
      for (const line of spotLines) out.write(`  ${line}\n`)
      out.write('确认不是凭据时加 --plaintext-ok 重试；若是凭据请先存入密码库或托管凭据\n')
      return 1
    }
  }

  if (status !== 201 && status !== 200) throwForStatus(status, data, config.key)

  const created = (data ?? {}) as Partial<MemoryViewData>
  if (options.json) {
    out.write(`${JSON.stringify(created, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  out.write(
    `${theme.ok('✓')} 已创建记忆  ${plain(created.title ?? uri)}（${plain(created.uri ?? uri)}）\n`,
  )
  return 0
}
