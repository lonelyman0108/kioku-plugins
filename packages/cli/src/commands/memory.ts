// 日常记忆读写命令：search（语义+全文+关键词召回）、get（按短 ID/旧坐标/标题读取）、ls（按维度分组浏览）、add（新建记忆并处理明文拦阻）。
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
  launch,
  plain,
  redirectError,
} from '../core.ts'
import { isInteractiveTty, resolveIdentity } from '../identity.ts'
import { isCancel, loadPrompts } from '../prompts.ts'
import type { Env, Reader, TargetConfig, Writer } from '../types.ts'
import {
  createTheme,
  kindLabel,
  renderBox,
  sensitivityBadge,
  type StrataTheme,
} from '../ui/theme.ts'
import { stripAnsi, wrapWidth } from '../ui/width.ts'

const TIMEOUT = 15_000
const STDIN_MAX_BYTES = 256 * 1024

const GROUP_BY_VALUES = ['circle', 'realm', 'env', 'runtime', 'project', 'topic', 'kind'] as const
type BrowseGroupBy = (typeof GROUP_BY_VALUES)[number]

const GROUP_BY_ALIASES: Record<string, BrowseGroupBy> = {
  circle: 'circle',
  记忆圈: 'circle',
  圈: 'circle',
  realm: 'realm',
  场域: 'realm',
  env: 'env',
  环境: 'env',
  runtime: 'runtime',
  客户端: 'runtime',
  project: 'project',
  项目: 'project',
  topic: 'topic',
  主题: 'topic',
  kind: 'kind',
  物种: 'kind',
}

const ENTRY_KIND_ALIASES: Record<string, 'entry' | 'fact' | 'episode'> = {
  entry: 'entry',
  正式词条: 'entry',
  fact: 'fact',
  联系人事实: 'fact',
  episode: 'episode',
  会话摘要: 'episode',
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

const FACET_DIM_RE = /^[a-z][a-z0-9_]{0,31}$/
const FACET_TERM_RE = /^[a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{1,64}$/

export interface EntryVariantViewData {
  id: string
  when: Record<string, string[]>
  whenSignature: string
  sortOrder: number
  content: string | null
  updatedAt?: string
}

export interface OtherVariantHintData {
  when: Record<string, string[]>
  whenSignature: string
}

export interface EntryLinkNeighborData {
  shortId: string
  title: string
  circleId?: string
  circleSlug?: string
  kind?: string
  sensitivity?: string
  direction: 'outgoing' | 'incoming'
}

export interface EntryViewData {
  id: string
  shortId: string
  circleId: string
  circleSlug: string | null
  kind: string
  title: string
  sensitivity: string
  provenance?: string
  originScope?: string
  topics?: string[]
  realms?: string[]
  priority: number
  disclosure: string | null
  glossary?: string[]
  validFrom?: string
  validTo?: string | null
  version: number
  variants: EntryVariantViewData[]
  otherVariants?: OtherVariantHintData[]
  links?: EntryLinkNeighborData[]
  createdAt?: string
  updatedAt?: string
}

export interface RecallCandidateData {
  entryId?: string
  shortId: string
  title: string
  circleId?: string
  circleSlug?: string | null
  kind: string
  matchedWhen?: Record<string, string[]>
  otherVariantsCount?: number
  crossGroup?: boolean
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

export interface EntryBrowseItemData {
  id: string
  shortId: string
  title: string
  circleId: string
  circleSlug: string | null
  kind: string
  sensitivity: string
  priority: number
  topics: string[]
  disclosure: string | null
  variantCount: number
  variantsSummary: Array<Record<string, string[]>>
}

export interface EntryBrowseGroupData {
  key: string
  label: string
  count: number
  items: EntryBrowseItemData[]
}

export interface EntryBrowseResponseData {
  groupBy: BrowseGroupBy
  groups: EntryBrowseGroupData[]
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

export function formatWhen(when: Record<string, string[]> | undefined): string {
  if (!when) return '通用'
  const keys = Object.keys(when)
    .filter((k) => Array.isArray(when[k]) && when[k].length > 0)
    .sort()
  if (!keys.length) return '通用'
  return keys.map((k) => `${plain(k)}=${when[k].map((v) => plain(v)).join(',')}`).join(' · ')
}

function parseTopicInput(raw: string, into: string[]): void {
  for (const part of raw.split(',')) {
    const clean = part.trim().toLowerCase()
    if (!clean) continue
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/u.test(clean) || clean.length > 64) {
      throw new UsageError(`主题标签格式不对：${part.trim()}`)
    }
    if (!into.includes(clean)) into.push(clean)
  }
}

function parseWhenInput(raw: string, into: Record<string, string[]>): void {
  const eq = raw.indexOf('=')
  if (eq <= 0) {
    throw new UsageError('--when 格式应为 <维度>=<词条1,词条2>，例如 runtime=claudecode')
  }
  const dim = raw.slice(0, eq).trim().toLowerCase()
  if (!FACET_DIM_RE.test(dim)) {
    throw new UsageError(`切面维度键格式不对：${dim}`)
  }
  const terms = raw
    .slice(eq + 1)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  if (!terms.length) {
    throw new UsageError(`--when ${dim}= 后面至少要写一个词条标识`)
  }
  for (const term of terms) {
    if (!FACET_TERM_RE.test(term)) {
      throw new UsageError(`切面词条标识格式不对：${term}`)
    }
  }
  const merged = new Set([...(into[dim] ?? []), ...terms])
  into[dim] = [...merged].sort()
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

function renderEntryCard(
  view: EntryViewData,
  out: { isTTY?: boolean; columns?: number },
  theme: StrataTheme,
): string {
  const width = boxWidthFor(out)
  const meta: string[] = [
    `短 ID：${plain(view.shortId)} · 物种：${theme.kind(view.kind)} · 敏感级：${sensitivityBadge(view.sensitivity, theme)}`,
    `${view.circleSlug ? `记忆圈：${plain(view.circleSlug)} · ` : ''}优先级：${view.priority} · 版本：${view.version}`,
  ]
  if (Array.isArray(view.topics) && view.topics.length) {
    meta.push(`主题：${view.topics.map((t) => plain(t)).join('、')}`)
  }
  if (view.disclosure) meta.push(`触发条件：${plain(view.disclosure)}`)
  if (Array.isArray(view.glossary) && view.glossary.length) {
    meta.push(`关键词：${view.glossary.map((g) => plain(g)).join('、')}`)
  }
  if (view.validTo) meta.push(`有效期至：${plain(view.validTo)}`)

  const variants = Array.isArray(view.variants) ? view.variants : []
  const bodyLines: string[] = []
  if (!variants.length) {
    bodyLines.push(theme.muted('（当前切面焦点下暂无匹配的变体切片；加 --all-variants 查看全部）'))
  } else if (variants.length === 1 && formatWhen(variants[0].when) === '通用') {
    if (variants[0].content === null) {
      bodyLines.push(theme.muted('（机密记忆正文不随读取返回，请在管理界面查看）'))
    } else {
      bodyLines.push(...wrapWidth(sanitizeBody(variants[0].content), width - 4))
    }
  } else {
    variants.forEach((v, idx) => {
      if (idx > 0) bodyLines.push('')
      bodyLines.push(theme.muted(`── 切面：${formatWhen(v.when)} ──`))
      if (v.content === null) {
        bodyLines.push(theme.muted('（机密记忆正文不随读取返回，请在管理界面查看）'))
      } else {
        bodyLines.push(...wrapWidth(sanitizeBody(v.content), width - 4))
      }
    })
  }

  const sections: Array<{ title?: string; lines: string[] }> = [
    { title: '属性', lines: meta },
    { title: '正文', lines: bodyLines.length ? bodyLines : [''] },
  ]
  if (Array.isArray(view.otherVariants) && view.otherVariants.length) {
    sections.push({
      title: `其他切面变体（${view.otherVariants.length}）`,
      lines: view.otherVariants.map((ov) => theme.muted(formatWhen(ov.when))),
    })
  }
  if (Array.isArray(view.links) && view.links.length) {
    sections.push({
      title: '双链',
      lines: view.links.map((link) => {
        const arrow = link.direction === 'incoming' ? '←' : '→'
        return `${arrow} ${plain(link.shortId)}  ${plain(link.title)}`
      }),
    })
  }

  return renderBox({
    title: plain(view.title) || plain(view.shortId) || '未命名记忆',
    width,
    theme,
    sections,
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
    const crossTag = c.crossGroup ? '  [其他群印象]' : ''
    lines.push(
      `${theme.bold(`${idx + 1}.`)} ${theme.bold(plain(c.title))}  ${theme.kind(c.kind)}  ${theme.muted(`相关度 ${scoreText}`)}${crossTag}`,
    )
    if (c.disclosure) lines.push(`   ${theme.muted(plain(c.disclosure))}`)
    const circleNote = c.circleSlug ? ` · 记忆圈 ${plain(c.circleSlug)}` : ''
    const whenNote =
      c.matchedWhen && Object.keys(c.matchedWhen).length
        ? ` · 切面 ${formatWhen(c.matchedWhen)}`
        : ''
    const moreNote =
      typeof c.otherVariantsCount === 'number' && c.otherVariantsCount > 0
        ? ` · 另有 ${c.otherVariantsCount} 个变体`
        : ''
    lines.push(`   ${theme.muted(`短 ID：${plain(c.shortId)}${circleNote}${whenNote}${moreNote}`)}`)
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
          value: c.shortId,
          label: plain(c.title),
          hint: `${kindLabel(c.kind)} · ${c.shortId}${c.circleSlug ? ` · ${c.circleSlug}` : ''}`,
        })),
        { value: '__exit__', label: '退出查看' },
      ],
    })
    if (isCancel(pick) || pick === '__exit__' || typeof pick !== 'string') break
    const res = await memoryRequest(config, 'GET', `/v1/entries?id=${encodeURIComponent(pick)}`)
    if (res.status !== 200) throwForStatus(res.status, res.data, config.key)
    out.write(`\n${renderEntryCard(res.data as unknown as EntryViewData, out, theme)}\n`)
  }
  return 0
}

export const GET_USAGE = `用法：kioku get <短ID或标题> [--circle <记忆圈>] [--all-variants] [--platform <平台>] [--json]

读取单条词条的完整属性、变体切片与双链关系。

  <短ID或标题>         例如 m-234567、词条标题或兼容旧 URI
  --circle <记忆圈>    限定在指定记忆圈内查找
  --all-variants       返回全部切面变体切片（不按当前焦点过滤）
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出词条对象
`

export function parseGetArgs(argv: string[]): {
  id: string
  circle?: string
  allVariants: boolean
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let circle: string | undefined
  let allVariants = false
  let platform: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--all-variants') allVariants = true
    else if (arg === '--circle') {
      const val = argv[++i]
      if (!val) throw new UsageError('--circle 后面要写记忆圈标识')
      circle = val
    } else if (arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (id !== undefined) {
      throw new UsageError('每次只指定一个记忆短 ID 或标题')
    } else {
      id = arg
    }
  }
  if (!id) throw new UsageError('请指定记忆短 ID 或标题，例如 m-234567')
  return { id, circle, allVariants, platform, json }
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

  const params = new URLSearchParams({ id: options.id })
  if (options.circle) params.set('circle', options.circle)
  if (options.allVariants) params.set('allVariants', 'true')

  const { status, data } = await memoryRequest(config, 'GET', `/v1/entries?${params.toString()}`)
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  out.write(`${renderEntryCard(data as unknown as EntryViewData, out, theme)}\n`)
  return 0
}

export const LS_USAGE = `用法：kioku ls [分组维度] [--circle <记忆圈>] [--kind <物种>] [--topic <主题>]
                [--query <关键词>] [--limit <条数>] [--platform <平台>] [--json]

按维度分组浏览可见的记忆目录，默认按主题（topic）分组。

  [分组维度]         topic / circle / realm / env / runtime / project / kind（也收中文名）
  --circle <记忆圈>  只看指定记忆圈
  --kind <物种>      只看 正式词条 / 联系人事实 / 会话摘要（entry / fact / episode）
  --topic <主题>     按主题标签过滤
  --query <关键词>   按标题关键词过滤
  --limit <条数>     最多返回的词条数（1 到 500）
  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出分组结果
`

export function parseLsArgs(argv: string[]): {
  groupBy: BrowseGroupBy
  circle?: string
  kind?: 'entry' | 'fact' | 'episode'
  topic?: string
  query?: string
  limit?: number
  platform?: string
  json: boolean
} {
  let groupBy: BrowseGroupBy | undefined
  let circle: string | undefined
  let kind: 'entry' | 'fact' | 'episode' | undefined
  let topic: string | undefined
  let query: string | undefined
  let limit: number | undefined
  let platform: string | undefined
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--circle') {
      const val = argv[++i]
      if (!val) throw new UsageError('--circle 后面要写记忆圈标识')
      circle = val
    } else if (arg === '--kind') {
      const val = argv[++i]
      if (!val) throw new UsageError('--kind 后面要写物种')
      const mapped = ENTRY_KIND_ALIASES[val.trim().toLowerCase()] ?? ENTRY_KIND_ALIASES[val.trim()]
      if (!mapped) throw new UsageError('--kind 只收 entry、fact、episode')
      kind = mapped
    } else if (arg === '--topic') {
      const val = argv[++i]
      if (!val) throw new UsageError('--topic 后面要写主题标签')
      topic = val.trim().toLowerCase()
    } else if (arg === '--query') {
      const val = argv[++i]
      if (!val) throw new UsageError('--query 后面要写关键词')
      query = val
    } else if (arg === '--limit') {
      const val = argv[++i]
      if (!val || !/^\d+$/.test(val)) throw new UsageError('--limit 须为 1 到 500 之间的整数')
      const num = Number(val)
      if (!Number.isInteger(num) || num < 1 || num > 500) {
        throw new UsageError('--limit 须为 1 到 500 之间的整数')
      }
      limit = num
    } else if (arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (groupBy !== undefined) {
      throw new UsageError('最多指定一个分组维度')
    } else {
      const normalized = arg.trim().toLowerCase()
      const mapped = GROUP_BY_ALIASES[normalized] ?? GROUP_BY_ALIASES[arg.trim()]
      if (!mapped) {
        throw new UsageError(`不认识的分组维度 ${arg}，可选：${GROUP_BY_VALUES.join('、')}`)
      }
      groupBy = mapped
    }
  }
  return { groupBy: groupBy ?? 'topic', circle, kind, topic, query, limit, platform, json }
}

function formatBrowseItems(items: EntryBrowseItemData[], theme: StrataTheme): string[] {
  if (!items.length) return [theme.muted('暂无记忆')]
  return items.map((item) => {
    const tags = [theme.kind(item.kind), sensitivityBadge(item.sensitivity, theme)]
    if (item.variantCount > 1) tags.push(theme.muted(`${item.variantCount} 个变体`))
    if (item.circleSlug) tags.push(theme.muted(plain(item.circleSlug)))
    return `${theme.bold(plain(item.title))}  ${tags.join(' · ')}  ${theme.muted(plain(item.shortId))}`
  })
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

  const params = new URLSearchParams({ groupBy: options.groupBy })
  if (options.circle) params.set('circle', options.circle)
  if (options.kind) params.set('kind', options.kind)
  if (options.topic) params.set('topic', options.topic)
  if (options.query) params.set('query', options.query)
  if (options.limit !== undefined) params.set('limit', String(options.limit))

  const { status, data } = await memoryRequest(
    config,
    'GET',
    `/v1/entries/browse?${params.toString()}`,
  )
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data, null, 2)}\n`)
    return 0
  }

  const payload = data as unknown as EntryBrowseResponseData
  const groups = Array.isArray(payload.groups) ? payload.groups : []
  if (!groups.length) {
    const emptyBox = renderBox({
      title: '记忆目录',
      width,
      theme,
      sections: [{ lines: [theme.muted('暂无可见记忆')] }],
    })
    out.write(`${emptyBox}\n`)
    return 0
  }

  const sections: Array<{ title?: string; lines: string[] }> = groups.map((group) => ({
    lines: [
      theme.bold(`${plain(group.label)}（${group.count}）`),
      ...formatBrowseItems(Array.isArray(group.items) ? group.items : [], theme),
    ],
  }))
  if (payload.truncated) {
    sections.push({
      lines: [theme.muted('（结果已截断，可加 --circle / --topic / --query 缩小范围）')],
    })
  }

  const box = renderBox({
    title: `记忆目录（按 ${options.groupBy} 分组）`,
    width,
    theme,
    sections,
  })
  out.write(`${box}\n`)
  return 0
}

export const ADD_USAGE = `用法：kioku add [标题] [--circle <记忆圈>] [--content <正文>] [--topic <标签>...]
                [--when <维=值>...] [--sensitivity <级别>] [--disclosure <条件>]
                [--priority <0-99>] [--plaintext-ok] [--platform <平台>] [--json]

写入一条新词条（也可以经标准输入管道传入正文，或在交互式终端打开编辑器填写）。

  [标题]               词条标题（也可改用 --title；省略时取正文首个一级标题或短 ID）
  --circle <记忆圈>    目标记忆圈 slug（默认写入当前接入实例主场记忆圈）
  --content <正文>     记忆正文；省略时读取管道标准输入或打开编辑器
  --topic <标签>       主题标签（可重复传入或逗号分隔）
  --when <维=值>       生效切面条件（可重复传入，如 --when realm=work --when project=kioku）
  --sensitivity <级别> 公开 / 内部 / 私密 / 机密（也收 public / internal / private / secret）
  --disclosure <条件>  说明何时让模型展开读取这条记忆
  --priority <0-99>    优先级整数（0–99）
  --plaintext-ok       确认正文疑似明文不是凭据，照常写入（记忆将进入待处理）
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出创建的词条
`

export function parseAddArgs(argv: string[]): {
  title?: string
  circle?: string
  content?: string
  topics: string[]
  when: Record<string, string[]>
  sensitivity?: 'public' | 'internal' | 'private' | 'secret'
  disclosure?: string
  priority?: number
  plaintextOk: boolean
  platform?: string
  json: boolean
} {
  let positionalTitle: string | undefined
  let flagTitle: string | undefined
  let circle: string | undefined
  let content: string | undefined
  const topics: string[] = []
  const when: Record<string, string[]> = {}
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
      arg === '--circle' ||
      arg === '--content' ||
      arg === '--topic' ||
      arg === '--when' ||
      arg === '--sensitivity' ||
      arg === '--disclosure' ||
      arg === '--priority' ||
      arg === '--platform'
    ) {
      const val = argv[++i]
      if (val === undefined) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--title') flagTitle = val
      else if (arg === '--circle') circle = val
      else if (arg === '--content') content = val
      else if (arg === '--topic') parseTopicInput(val, topics)
      else if (arg === '--when') parseWhenInput(val, when)
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
    } else if (positionalTitle !== undefined) {
      throw new UsageError('最多指定一个标题')
    } else {
      positionalTitle = arg
    }
  }
  if (positionalTitle !== undefined && flagTitle !== undefined) {
    throw new UsageError('不能同时传入位置标题和 --title')
  }
  return {
    title: flagTitle ?? positionalTitle,
    circle,
    content,
    topics,
    when,
    sensitivity,
    disclosure,
    priority,
    plaintextOk,
    platform,
    json,
  }
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
    const run = launch(parts[0], [...parts.slice(1), file], env)
    if (!run) return null
    const res = spawnSync(run.file, run.args, { stdio: 'inherit', env, ...run.options })
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

  let title = options.title?.trim() || undefined
  if (title === undefined && interactive) {
    const ui = await loadPrompts({ input: stdin, output: out })
    if (ui) {
      const entered = await ui.text({
        message: '词条标题（留空则自动生成）',
        placeholder: '可留空，自动取正文一级标题或短 ID',
      })
      if (isCancel(entered)) return 0
      title = String(entered).trim() || undefined
    }
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
    content,
    ...(options.circle ? { circle: options.circle } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(Object.keys(options.when).length ? { when: options.when } : {}),
    ...(options.topics.length ? { topics: options.topics } : {}),
    ...(options.sensitivity !== undefined ? { sensitivity: options.sensitivity } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
    ...(options.plaintextOk ? { plaintextOk: true } : {}),
  }

  let { status, data } = await memoryRequest(config, 'POST', '/v1/entries', basePayload)

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
      const retry = await memoryRequest(config, 'POST', '/v1/entries', {
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

  const created = (data ?? {}) as Partial<EntryViewData>
  if (options.json) {
    out.write(`${JSON.stringify(created, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  const label = plain(created.title ?? title ?? created.shortId ?? '')
  const idNote = created.shortId ? `（${plain(created.shortId)}）` : ''
  out.write(`${theme.ok('✓')} 已创建记忆  ${label}${idNote}\n`)
  return 0
}
