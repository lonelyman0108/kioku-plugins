// 日常记忆读写命令：search、get、ls、add、edit、delete 与 boot。
// 身份默认经 identity.ts 自动解析，支持管道读取正文、$EDITOR 撰写与 --json 结构化输出。

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SUPPORTED_API,
  ServerMismatch,
  UNAVAILABLE_TEXT,
  explained,
  generationProblem,
  probeServer,
} from '../api.ts'
import {
  DATABASE_UNAVAILABLE_CODE,
  KeyRejected,
  KiokuFailure,
  TOOL_CALL_TIMEOUT,
  UsageError,
  errorCodeOf,
  fetchFailure,
  isRedirect,
  launch,
  mcpCall,
  plain,
  redirectError,
} from '../core.ts'
import { isInteractiveTty, resolveIdentity } from '../identity.ts'
import { isCancel, loadPrompts } from '../prompts.ts'
import type { Env, Reader, TargetConfig, Writer } from '../types.ts'
import { createTheme, kindLabel, renderBox, type CliTheme } from '../ui/theme.ts'
import { stripAnsi, wrapWidth } from '../ui/width.ts'

const TIMEOUT = 15_000
const STDIN_MAX_BYTES = 256 * 1024

const GROUP_BY_VALUES = ['topic', 'project', 'env', 'realm', 'runtime', 'kind'] as const
export type BrowseGroupBy = (typeof GROUP_BY_VALUES)[number]

const GROUP_BY_ALIASES: Record<string, BrowseGroupBy> = {
  topic: 'topic',
  主题: 'topic',
  project: 'project',
  项目: 'project',
  env: 'env',
  环境: 'env',
  realm: 'realm',
  场域: 'realm',
  runtime: 'runtime',
  客户端: 'runtime',
  kind: 'kind',
  类型: 'kind',
}

const ENTRY_KIND_ALIASES: Record<string, 'entry' | 'episode'> = {
  entry: 'entry',
  正式记忆: 'entry',
  episode: 'episode',
  会话摘要: 'episode',
}

const VIA_LABELS: Record<string, string> = {
  semantic: '语义',
  fulltext: '全文',
  link: '双链',
}

const SCENE_SLUG_RE = /^[a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{1,64}$/
const VALID_TO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

export interface EntryLinkNeighborData {
  shortId: string
  title: string
  kind?: string
  direction: 'outgoing' | 'incoming'
}

export interface CredentialRefStatusData {
  slug: string
  field: string | null
  available: boolean
  label: string | null
}

export interface EntryViewData {
  id: string
  shortId: string
  kind: string
  title: string
  content: string
  disclosure: string | null
  isPinned: boolean
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  deviceKey?: string | null
  projectSlug?: string | null
  validTo: string | null
  version: number
  createdAt?: string
  updatedAt?: string
  deletedAt?: string | null
}

export interface EntryDetailData {
  entry: EntryViewData
  outboundLinks?: EntryLinkNeighborData[]
  backlinks?: EntryLinkNeighborData[]
  credentialRefs?: CredentialRefStatusData[]
}

export interface RecallCandidateData {
  entryId?: string
  shortId: string
  title: string
  kind: string
  isPinned?: boolean
  envs?: string[]
  realms?: string[]
  projects?: string[]
  runtimes?: string[]
  disclosure: string | null
  score: number
  via?: string[]
  cues?: string[]
}

export interface RecallResponseData {
  candidates: RecallCandidateData[]
}

export interface EntryBrowseItemData {
  shortId: string
  title: string
  kind: string
  isPinned?: boolean
  topics?: string[]
  envs?: string[]
  realms?: string[]
  projects?: string[]
  runtimes?: string[]
  disclosure: string | null
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

export interface BootEntryData {
  shortId: string
  title: string
  kind: string
  bootMode?: 'none' | 'index' | 'full'
  content: string
  summary?: string | null
  envs?: string[]
  realms?: string[]
  projects?: string[]
  runtimes?: string[]
  updatedAt?: string
  lastChangeSummary?: string | null
}

export interface BootOmittedItemData {
  shortId: string
  title: string
  bootMode?: 'none' | 'index' | 'full'
  reason?: 'index' | 'oversized' | 'budget'
  summary?: string | null
  disclosure?: string | null
  envs?: string[]
  realms?: string[]
  projects?: string[]
  runtimes?: string[]
  charCount?: number
}

export interface BootEpisodeData {
  shortId: string
  title: string
  content: string
  createdAt?: string
}

export interface BootResponseData {
  entries: BootEntryData[]
  episodes?: BootEpisodeData[]
  omitted: string[]
  omittedItems?: BootOmittedItemData[]
}

export interface McpToolOutcome<T = Record<string, unknown>> {
  text: string
  structured: T | null
  isError: boolean
  errorStatus?: number
  errorCode?: string
  errorMessage?: string
}

function sanitizeBody(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', '  ')
    .replace(/(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
}

function boxWidthFor(out: { columns?: number }): number {
  return Math.min(92, Math.max(54, (out.columns ?? 88) - 2))
}

function maskKeyText(raw: unknown, key: string): string {
  const str = typeof raw === 'string' ? raw : ''
  const masked = key ? str.split(key).join('***') : str
  return plain(masked)
}

function validateTopicTag(raw: string): string {
  const clean = raw.trim().toLowerCase()
  if (!clean) throw new UsageError('--topic 后面要写主题标签')
  if (
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/u.test(clean) ||
    clean.length > 64 ||
    clean.includes('{{cred:')
  ) {
    throw new UsageError(`主题标签格式不对：${raw.trim()}`)
  }
  return clean
}

function parseTopicInput(raw: string, into: string[], allowClear = false): void {
  const trimmed = raw.trim()
  if (allowClear && (trimmed === '' || trimmed === 'clear' || trimmed === '清除')) return
  for (const part of raw.split(',')) {
    if (!part.trim()) continue
    const clean = validateTopicTag(part)
    if (!into.includes(clean)) into.push(clean)
  }
}

function validateSceneTag(raw: string, flagName: string): string {
  const clean = raw.trim().toLowerCase()
  if (!clean) throw new UsageError(`${flagName} 后面要写标签标识`)
  if (!SCENE_SLUG_RE.test(clean) || clean.includes('{{cred:')) {
    throw new UsageError(`${flagName} 标签格式不对：${raw.trim()}`)
  }
  return clean
}

function parseSceneListInput(
  raw: string,
  flagName: string,
  into: string[],
  allowClear = false,
): void {
  const trimmed = raw.trim()
  if (allowClear && (trimmed === '' || trimmed === 'clear' || trimmed === '清除')) return
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) throw new UsageError(`${flagName} 后面要写标签标识`)
  for (const part of parts) {
    const clean = validateSceneTag(part, flagName)
    if (!into.includes(clean)) into.push(clean)
  }
}

function parseVersion(val: string): number {
  if (!/^\d+$/.test(val)) throw new UsageError('--expected-version 须为整数')
  const num = Number(val)
  if (!Number.isInteger(num) || num < 1) {
    throw new UsageError('--expected-version 须为正整数')
  }
  return num
}

function parseValidTo(val: string, allowClear: true): string | null
function parseValidTo(val: string, allowClear?: false): string
function parseValidTo(val: string, allowClear = false): string | null {
  const clean = val.trim()
  if (
    allowClear &&
    (clean === '' || clean === 'null' || clean === 'none' || clean === 'clear' || clean === '清除')
  ) {
    return null
  }
  if (!VALID_TO_OFFSET_RE.test(clean) || Number.isNaN(Date.parse(clean))) {
    throw new UsageError(
      '--valid-to 须为带时区的 ISO 8601 时间（例如 2026-12-31T23:59:00+08:00 或 2026-12-31T15:59:00Z）',
    )
  }
  return clean
}

function formatSceneInline(item: {
  projects?: string[]
  envs?: string[]
  realms?: string[]
  runtimes?: string[]
}): string {
  const parts: string[] = []
  if (item.projects?.length) parts.push(`项目 ${item.projects.map((v) => plain(v)).join(',')}`)
  if (item.envs?.length) parts.push(`环境 ${item.envs.map((v) => plain(v)).join(',')}`)
  if (item.realms?.length) parts.push(`场域 ${item.realms.map((v) => plain(v)).join(',')}`)
  if (item.runtimes?.length) parts.push(`客户端 ${item.runtimes.map((v) => plain(v)).join(',')}`)
  return parts.join(' · ')
}

export async function callMemoryTool<T = Record<string, unknown>>(
  config: TargetConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolOutcome<T>> {
  let raw: unknown
  try {
    raw = await mcpCall(config, 'tools/call', { name, arguments: args }, TOOL_CALL_TIMEOUT)
  } catch (err) {
    if (err instanceof KeyRejected) throw err
    if (err instanceof KiokuFailure) throw await explained(config.url, err)
    throw err
  }
  const result = (raw && typeof raw === 'object' ? raw : {}) as {
    content?: unknown
    structuredContent?: unknown
    isError?: unknown
  }
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
      ),
    )
    .map((block) => block.text)
    .join('\n')
  const structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as T)
      : null
  const isError = result.isError === true
  if (!isError) return { text, structured, isError: false }
  const errObj = structured as { status?: unknown; code?: unknown; error?: unknown } | null
  const errorStatus = typeof errObj?.status === 'number' ? errObj.status : undefined
  const errorCode = typeof errObj?.code === 'string' ? errObj.code : undefined
  const rawMessage = typeof errObj?.error === 'string' ? errObj.error : text
  const errorMessage = maskKeyText(rawMessage, config.key)
  return { text, structured, isError: true, errorStatus, errorCode, errorMessage }
}

function throwForToolError(outcome: McpToolOutcome<unknown>): never {
  if (outcome.errorMessage) throw new KiokuFailure(outcome.errorMessage)
  if (outcome.errorStatus === 401) throw new KeyRejected()
  if (outcome.errorStatus === 403) throw new KiokuFailure('当前访问密钥无权执行此操作')
  if (outcome.errorStatus === 404) throw new KiokuFailure('记忆不存在，或当前访问密钥无权读取')
  if (outcome.errorStatus === 409) throw new KiokuFailure('版本已变更或发生冲突，请重新读取后再试')
  throw new KiokuFailure(
    outcome.errorStatus ? `Kioku 返回 HTTP ${outcome.errorStatus}` : '操作未能完成',
  )
}

async function requireMemoryTool<T = Record<string, unknown>>(
  config: TargetConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: T | null }> {
  const outcome = await callMemoryTool<T>(config, name, args)
  if (outcome.isError) throwForToolError(outcome)
  return { text: outcome.text, structured: outcome.structured }
}

async function memoryRequest(
  config: TargetConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response
  let data: Record<string, unknown> | null = null
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
    if (res.status !== 204) {
      data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    }
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), config.url))
  }
  if (res.status === 401) throw new KeyRejected()
  if (res.status === 404 || res.status >= 500) {
    const probe = await probeServer(config.url)
    const problem = generationProblem(probe)
    if (problem) throw new ServerMismatch(problem, probe)
    if (probe.state === 'unavailable') throw new ServerMismatch(UNAVAILABLE_TEXT, probe)
  }
  if (res.status === 503 && errorCodeOf(data) === DATABASE_UNAVAILABLE_CODE) {
    throw new ServerMismatch(UNAVAILABLE_TEXT, {
      generation: SUPPORTED_API,
      state: 'unavailable',
      version: null,
    })
  }
  return { status: res.status, data }
}

function throwForStatus(status: number, data: Record<string, unknown> | null, key: string): never {
  const detail = maskKeyText(data?.error, key)
  if (status === 401) throw new KeyRejected()
  if (status === 403) throw new KiokuFailure(detail || '当前访问密钥无权执行此操作')
  if (status === 404) throw new KiokuFailure(detail || '记忆不存在，或当前访问密钥无权读取')
  if (status === 409) throw new KiokuFailure(detail || '版本已变更或发生冲突，请重新读取后再试')
  throw new KiokuFailure(detail || `Kioku 返回 HTTP ${status}`)
}

function renderEntryCard(
  detail: EntryDetailData,
  out: { isTTY?: boolean; columns?: number },
  theme: CliTheme,
): string {
  const width = boxWidthFor(out)
  const view = detail.entry
  const pinnedPart = view.isPinned ? ' · 常驻' : ''
  const meta: string[] = [
    `短 ID：${plain(view.shortId)} · 类型：${kindLabel(view.kind)}${pinnedPart} · 版本：v${view.version}`,
  ]
  if (Array.isArray(view.projects) && view.projects.length) {
    meta.push(`项目：${view.projects.map((p) => plain(p)).join('、')}`)
  }
  if (Array.isArray(view.envs) && view.envs.length) {
    meta.push(`环境：${view.envs.map((e) => plain(e)).join('、')}`)
  }
  if (Array.isArray(view.realms) && view.realms.length) {
    meta.push(`场域：${view.realms.map((r) => plain(r)).join('、')}`)
  }
  if (Array.isArray(view.runtimes) && view.runtimes.length) {
    meta.push(`客户端：${view.runtimes.map((r) => plain(r)).join('、')}`)
  }
  if (Array.isArray(view.topics) && view.topics.length) {
    meta.push(`主题：${view.topics.map((t) => plain(t)).join('、')}`)
  }
  if (view.disclosure) meta.push(`触发场景：${plain(view.disclosure)}`)
  if (view.validTo) meta.push(`有效期：${plain(view.validTo)}`)
  if (view.createdAt || view.updatedAt) {
    const timeParts: string[] = []
    if (view.createdAt) timeParts.push(`创建 ${plain(view.createdAt)}`)
    if (view.updatedAt) timeParts.push(`更新 ${plain(view.updatedAt)}`)
    meta.push(timeParts.join(' · '))
  }

  const bodyLines = wrapWidth(sanitizeBody(view.content), width - 4)
  const sections: Array<{ title?: string; lines: string[] }> = [
    { title: '属性', lines: meta },
    { title: '正文', lines: bodyLines.length ? bodyLines : [''] },
  ]

  const outbound = Array.isArray(detail.outboundLinks) ? detail.outboundLinks : []
  const backlinks = Array.isArray(detail.backlinks) ? detail.backlinks : []
  const allLinks = [
    ...outbound.map((link) => `→ ${plain(link.shortId)}  ${plain(link.title)}`),
    ...backlinks.map((link) => `← ${plain(link.shortId)}  ${plain(link.title)}`),
  ]
  if (allLinks.length) {
    sections.push({ title: '双链', lines: allLinks })
  }

  const creds = Array.isArray(detail.credentialRefs) ? detail.credentialRefs : []
  if (creds.length) {
    sections.push({
      title: '凭据引用',
      lines: creds.map((ref) => {
        const token = `{{cred:${plain(ref.slug)}${ref.field ? `#${plain(ref.field)}` : ''}}}`
        const state = ref.available ? theme.ok('可用') : theme.warn('不可用')
        const label = ref.label ? `  ${theme.muted(plain(ref.label))}` : ''
        return `${token}  ${state}${label}`
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

export const SEARCH_USAGE = `用法：kioku search <查询> [--env <环境>] [--realm <场域>] [--project <项目>]
                    [--runtime <客户端>] [--limit <条数>] [--platform <平台>] [--json]

从 Kioku 召回与查询相关的记忆（综合语义、全文、场景亲和与双链）。交互式终端中可直接选择某条记忆展开详情。

  <查询>               要检索的关键词或问题
  --env <环境>         按环境焦点调制排序（例如 mac、linux、win）
  --realm <场域>       按场域焦点调制排序（例如 work、personal）
  --project <项目>     按项目焦点调制排序
  --runtime <客户端>   按客户端焦点调制排序
  --limit <条数>       最多返回的条数（1 到 50，默认沿用服务端设置）
  --platform <平台>    指定使用哪个已配置客户端的身份（默认自动识别）
  --json               以 JSON 格式输出候选列表
`

export function parseSearchArgs(argv: string[]): {
  query?: string
  env?: string
  realm?: string
  project?: string
  runtime?: string
  limit?: number
  platform?: string
  json: boolean
} {
  const queryParts: string[] = []
  let envTag: string | undefined
  let realm: string | undefined
  let project: string | undefined
  let runtime: string | undefined
  let limit: number | undefined
  let platform: string | undefined
  let json = false
  let endOfFlags = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--env') {
      const val = argv[++i]
      if (!val) throw new UsageError('--env 后面要写环境标识')
      envTag = validateSceneTag(val, '--env')
    } else if (!endOfFlags && arg === '--realm') {
      const val = argv[++i]
      if (!val) throw new UsageError('--realm 后面要写场域标识')
      realm = validateSceneTag(val, '--realm')
    } else if (!endOfFlags && arg === '--project') {
      const val = argv[++i]
      if (!val) throw new UsageError('--project 后面要写项目标识')
      project = validateSceneTag(val, '--project')
    } else if (!endOfFlags && arg === '--runtime') {
      const val = argv[++i]
      if (!val) throw new UsageError('--runtime 后面要写客户端标识')
      runtime = validateSceneTag(val, '--runtime')
    } else if (!endOfFlags && arg === '--limit') {
      const raw = argv[++i]
      if (!raw) throw new UsageError('--limit 后面要写条数')
      if (!/^\d+$/.test(raw)) throw new UsageError('--limit 须为 1 到 50 之间的整数')
      const num = Number(raw)
      if (!Number.isInteger(num) || num < 1 || num > 50) {
        throw new UsageError('--limit 须为 1 到 50 之间的整数')
      }
      limit = num
    } else if (!endOfFlags && arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else {
      queryParts.push(arg)
    }
  }
  const query = queryParts.join(' ').trim() || undefined
  return { query, env: envTag, realm, project, runtime, limit, platform, json }
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
    if (!interactive) throw new UsageError('要指定检索内容，例如 kioku search 部署流程')
    const ui = await loadPrompts({ input: stdin, output: out, env })
    if (!ui) throw new UsageError('要指定检索内容')
    const entered = await ui.text({
      message: '检索记忆',
      placeholder: '输入关键词或问题',
      validate: (v) => (v.trim() ? undefined : '检索内容不能为空'),
    })
    if (isCancel(entered)) return 0
    query = String(entered).trim()
  }

  const body: {
    query: string
    limit?: number
    env?: string
    realm?: string
    project?: string
    runtime?: string
  } = { query }
  if (options.limit !== undefined) body.limit = options.limit
  if (options.env) body.env = options.env
  if (options.realm) body.realm = options.realm
  if (options.project) body.project = options.project
  if (options.runtime) body.runtime = options.runtime

  const { status, data } = await memoryRequest(config, 'POST', '/v1/recall', body)
  if (status !== 200) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data ?? { candidates: [] }, null, 2)}\n`)
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
    const pinnedTag = c.isPinned ? ' · 常驻' : ''
    lines.push(
      `${theme.bold(`${idx + 1}.`)} ${theme.bold(plain(c.title))}  ${theme.muted(`${kindLabel(c.kind)}${pinnedTag} · 相关度 ${scoreText}`)}`,
    )
    if (c.disclosure) lines.push(`   ${theme.muted(`触发场景：${plain(c.disclosure)}`)}`)
    const sceneText = formatSceneInline(c)
    const viaNote =
      Array.isArray(c.via) && c.via.length
        ? ` · 命中 ${c.via.map((v) => VIA_LABELS[v] ?? plain(v)).join('/')}`
        : ''
    lines.push(`   ${theme.muted(`短 ID：${plain(c.shortId)}${viaNote}`)}`)
    if (sceneText) lines.push(`   ${theme.muted(`场景：${sceneText}`)}`)
    if (Array.isArray(c.cues) && c.cues.length) {
      lines.push(`   ${theme.muted(`线索：${c.cues.map((x) => plain(x)).join('、')}`)}`)
    }
  })

  const box = renderBox({
    title: `检索：${plain(query)}（${candidates.length} 条）`,
    width,
    theme,
    sections: [{ title: `候选记忆（${candidates.length}）`, lines }],
  })
  out.write(`${box}\n`)

  if (!interactive || !candidates.length) return 0

  const ui = await loadPrompts({ input: stdin, output: out, env })
  if (!ui) return 0

  for (;;) {
    const pick = await ui.select<string>({
      message: '选择一条记忆查看正文',
      options: [
        ...candidates.map((c) => ({
          value: c.shortId,
          label: plain(c.title),
          hint: plain(`${kindLabel(c.kind)} · ${c.shortId}`),
        })),
        { value: '__exit__', label: '退出查看' },
      ],
    })
    if (isCancel(pick) || pick === '__exit__' || typeof pick !== 'string') break
    const res = await requireMemoryTool<EntryDetailData>(config, 'kioku_get', { id: pick })
    if (res.structured?.entry) {
      out.write(`\n${renderEntryCard(res.structured, out, theme)}\n`)
    } else {
      out.write(`\n${sanitizeBody(res.text)}\n`)
    }
  }
  return 0
}

export const GET_USAGE = `用法：kioku get <短ID或标题> [--platform <平台>] [--json]

读取单条记忆的完整正文、属性、关联双链与凭据引用状态。

  <短ID或标题>         例如 m-234567 或记忆标题
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出记忆详情对象
`

export function parseGetArgs(argv: string[]): {
  id: string
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let platform: string | undefined
  let json = false
  let endOfFlags = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (id !== undefined) {
      throw new UsageError('每次只指定一个记忆短 ID 或标题')
    } else {
      id = arg
    }
  }
  if (!id) throw new UsageError('要指定记忆短 ID 或标题，例如 m-234567')
  return { id, platform, json }
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

  const { text, structured } = await requireMemoryTool<EntryDetailData>(config, 'kioku_get', {
    id: options.id,
  })

  if (options.json) {
    out.write(`${JSON.stringify(structured ?? { text }, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  if (structured?.entry) {
    out.write(`${renderEntryCard(structured, out, theme)}\n`)
  } else {
    const fallbackBox = renderBox({
      title: plain(options.id),
      width: boxWidthFor(out),
      theme,
      sections: [{ lines: wrapWidth(sanitizeBody(text), boxWidthFor(out) - 4) }],
    })
    out.write(`${fallbackBox}\n`)
  }
  return 0
}

export const LS_USAGE = `用法：kioku ls [分组维度] [--group-by <维度>] [--kind <类型>] [--topic <主题>]
                [--project <项目>] [--env <环境>] [--realm <场域>] [--runtime <客户端>]
                [--pinned] [--query <关键词>] [--limit <条数>] [--platform <平台>] [--json]

按维度分组浏览可见的记忆目录，默认按主题（topic）分组。

  [分组维度]         topic / project / env / realm / runtime / kind（也收中文名）
  --group-by <维度>  指定分组维度（与位置参数二选一）
  --kind <类型>      只看 正式记忆 / 会话摘要（entry / episode）
  --topic <主题>     按主题标签过滤
  --project <项目>   按项目标签过滤
  --env <环境>       按环境标签过滤
  --realm <场域>     按场域标签过滤
  --runtime <客户端> 按客户端标签过滤
  --pinned           只看常驻记忆
  --query <关键词>   按标题或短 ID 关键词过滤
  --limit <条数>     最多返回的记忆数（1 到 200）
  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出分组结果
`

export function parseLsArgs(argv: string[]): {
  groupBy: BrowseGroupBy
  kind?: 'entry' | 'episode'
  topic?: string
  project?: string
  env?: string
  realm?: string
  runtime?: string
  pinnedOnly?: boolean
  query?: string
  limit?: number
  platform?: string
  json: boolean
} {
  let groupBy: BrowseGroupBy | undefined
  let kind: 'entry' | 'episode' | undefined
  let topic: string | undefined
  let project: string | undefined
  let envTag: string | undefined
  let realm: string | undefined
  let runtime: string | undefined
  let pinnedOnly: boolean | undefined
  let query: string | undefined
  let limit: number | undefined
  let platform: string | undefined
  let json = false
  let endOfFlags = false

  const parseGroupByValue = (raw: string): BrowseGroupBy => {
    const normalized = raw.trim().toLowerCase()
    const mapped = GROUP_BY_ALIASES[normalized] ?? GROUP_BY_ALIASES[raw.trim()]
    if (!mapped) {
      throw new UsageError(`不认识的分组维度 ${raw}，可选：${GROUP_BY_VALUES.join('、')}`)
    }
    return mapped
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--pinned') pinnedOnly = true
    else if (!endOfFlags && arg === '--group-by') {
      const val = argv[++i]
      if (!val) throw new UsageError('--group-by 后面要写分组维度')
      if (groupBy !== undefined) throw new UsageError('最多指定一个分组维度')
      groupBy = parseGroupByValue(val)
    } else if (!endOfFlags && arg === '--kind') {
      const val = argv[++i]
      if (!val) throw new UsageError('--kind 后面要写类型')
      const mapped = ENTRY_KIND_ALIASES[val.trim().toLowerCase()] ?? ENTRY_KIND_ALIASES[val.trim()]
      if (!mapped) throw new UsageError('--kind 只收 entry、episode（或 正式记忆、会话摘要）')
      kind = mapped
    } else if (!endOfFlags && arg === '--topic') {
      const val = argv[++i]
      if (!val) throw new UsageError('--topic 后面要写主题标签')
      topic = validateTopicTag(val)
    } else if (!endOfFlags && arg === '--project') {
      const val = argv[++i]
      if (!val) throw new UsageError('--project 后面要写项目标识')
      project = validateSceneTag(val, '--project')
    } else if (!endOfFlags && arg === '--env') {
      const val = argv[++i]
      if (!val) throw new UsageError('--env 后面要写环境标识')
      envTag = validateSceneTag(val, '--env')
    } else if (!endOfFlags && arg === '--realm') {
      const val = argv[++i]
      if (!val) throw new UsageError('--realm 后面要写场域标识')
      realm = validateSceneTag(val, '--realm')
    } else if (!endOfFlags && arg === '--runtime') {
      const val = argv[++i]
      if (!val) throw new UsageError('--runtime 后面要写客户端标识')
      runtime = validateSceneTag(val, '--runtime')
    } else if (!endOfFlags && arg === '--query') {
      const val = argv[++i]
      if (!val) throw new UsageError('--query 后面要写关键词')
      query = val
    } else if (!endOfFlags && arg === '--limit') {
      const val = argv[++i]
      if (!val || !/^\d+$/.test(val)) throw new UsageError('--limit 须为 1 到 200 之间的整数')
      const num = Number(val)
      if (!Number.isInteger(num) || num < 1 || num > 200) {
        throw new UsageError('--limit 须为 1 到 200 之间的整数')
      }
      limit = num
    } else if (!endOfFlags && arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (groupBy !== undefined) {
      throw new UsageError('最多指定一个分组维度')
    } else {
      groupBy = parseGroupByValue(arg)
    }
  }
  return {
    groupBy: groupBy ?? 'topic',
    kind,
    topic,
    project,
    env: envTag,
    realm,
    runtime,
    pinnedOnly,
    query,
    limit,
    platform,
    json,
  }
}

function formatBrowseItems(items: EntryBrowseItemData[], theme: CliTheme): string[] {
  if (!items.length) return [theme.muted('暂无记忆')]
  return items.map((item) => {
    const tags = [theme.muted(kindLabel(item.kind))]
    if (item.isPinned) tags.push(theme.bold('常驻'))
    const sceneText = formatSceneInline(item)
    if (sceneText) tags.push(theme.muted(sceneText))
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

  const toolArgs: Record<string, unknown> = {
    group_by: options.groupBy,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.topic ? { topic: options.topic } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.realm ? { realm: options.realm } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.pinnedOnly ? { pinned_only: true } : {}),
    ...(options.query ? { query: options.query } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  }

  const { text, structured } = await requireMemoryTool<EntryBrowseResponseData>(
    config,
    'kioku_browse',
    toolArgs,
  )

  if (options.json) {
    out.write(`${JSON.stringify(structured ?? { text }, null, 2)}\n`)
    return 0
  }

  if (!structured || !Array.isArray(structured.groups)) {
    const fallbackBox = renderBox({
      title: `记忆目录（按 ${options.groupBy} 分组）`,
      width,
      theme,
      sections: [{ lines: wrapWidth(sanitizeBody(text) || '暂无可见记忆', width - 4) }],
    })
    out.write(`${fallbackBox}\n`)
    return 0
  }

  const groups = structured.groups
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

  const sections: Array<{ title?: string; lines: string[] }> = groups.map((group) => {
    const groupTitle =
      options.groupBy === 'kind' && (group.key === 'entry' || group.key === 'episode')
        ? kindLabel(group.key)
        : plain(group.label)
    return {
      lines: [
        theme.bold(`${groupTitle}（${group.count}）`),
        ...formatBrowseItems(Array.isArray(group.items) ? group.items : [], theme),
      ],
    }
  })
  if (structured.truncated) {
    sections.push({
      lines: [theme.muted('（结果已截断，可加 --project / --topic / --query 缩小范围）')],
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

export const ADD_USAGE = `用法：kioku add [标题] [--title <标题>] [--content <正文>] [--topic <标签>...]
                [--env <环境>...] [--realm <场域>...] [--project <项目>...]
                [--runtime <客户端>...] [--pinned] [--disclosure <说明>]
                [--valid-to <时间>] [--platform <平台>] [--json]

写入一条新正式记忆（也可以经标准输入管道传入正文，或在交互式终端打开编辑器填写）。

  [标题]               记忆标题（也可改用 --title；省略时取正文首个一级标题或短 ID）
  --content <正文>     记忆正文；省略时读取管道标准输入或打开编辑器
  --topic <标签>       主题标签（可重复传入或逗号分隔）
  --env <环境>         适用环境或自定义主机标识，如 mac、linux、win、home-24（可重复或逗号分隔；多标签任一命中，单机隔离仅标主机标识）
  --realm <场域>       适用场域标签，例如 work、personal（可重复或逗号分隔）
  --project <项目>     适用项目标识（可重复或逗号分隔）
  --runtime <客户端>   适用客户端标识（可重复或逗号分隔）
  --pinned             设为常驻记忆（会话启动时自动加载）
  --disclosure <说明>  触发场景：说明何时需要想起这条记忆
  --valid-to <时间>    有效期（带时区 ISO 8601，例如 2026-12-31T23:59:00+08:00）
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出创建的记忆
`

export function parseAddArgs(argv: string[]): {
  title?: string
  content?: string
  topics: string[]
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  isPinned: boolean
  disclosure?: string
  validTo?: string
  platform?: string
  json: boolean
} {
  let positionalTitle: string | undefined
  let flagTitle: string | undefined
  let content: string | undefined
  const topics: string[] = []
  const envs: string[] = []
  const realms: string[] = []
  const projects: string[] = []
  const runtimes: string[] = []
  let isPinned = false
  let disclosure: string | undefined
  let validTo: string | undefined
  let platform: string | undefined
  let json = false
  let endOfFlags = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--pinned') isPinned = true
    else if (
      !endOfFlags &&
      (arg === '--title' ||
        arg === '--content' ||
        arg === '--topic' ||
        arg === '--env' ||
        arg === '--realm' ||
        arg === '--project' ||
        arg === '--runtime' ||
        arg === '--disclosure' ||
        arg === '--valid-to' ||
        arg === '--platform')
    ) {
      const val = argv[++i]
      if (val === undefined) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--title') flagTitle = val
      else if (arg === '--content') content = val
      else if (arg === '--topic') parseTopicInput(val, topics)
      else if (arg === '--env') parseSceneListInput(val, '--env', envs)
      else if (arg === '--realm') parseSceneListInput(val, '--realm', realms)
      else if (arg === '--project') parseSceneListInput(val, '--project', projects)
      else if (arg === '--runtime') parseSceneListInput(val, '--runtime', runtimes)
      else if (arg === '--disclosure') disclosure = val
      else if (arg === '--valid-to') validTo = parseValidTo(val)
      else platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
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
    content,
    topics,
    envs,
    realms,
    projects,
    runtimes,
    isPinned,
    disclosure,
    validTo,
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

// 拆分带单双引号的编辑器命令行，保留带空格的可执行文件路径（如 macOS .app）
export function parseEditorCommand(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let inToken = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        const next = raw[i + 1]
        if (next === '"' || next === '\\') {
          current += next
          i++
          continue
        }
      }
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += ch
      inToken = true
    }
  }
  if (inToken) tokens.push(current)
  return tokens
}

async function editInTempEditor(env: Env, initial = ''): Promise<string | null> {
  const editorRaw = (env.VISUAL || env.EDITOR || '').trim()
  if (!editorRaw) return null
  const parts = parseEditorCommand(editorRaw)
  if (!parts.length) return null
  const dir = await mkdtemp(join(tmpdir(), 'kioku-edit-'))
  const file = join(dir, 'memory.md')
  try {
    await writeFile(file, initial, { encoding: 'utf8', mode: 0o600 })
    const run = launch(parts[0], [...parts.slice(1), file], env)
    if (!run) throw new KiokuFailure(`无法启动编辑器：${plain(parts[0])}`)
    const res = spawnSync(run.file, run.args, { stdio: 'inherit', env, ...run.options })
    if (res.error || res.status !== 0) {
      throw new KiokuFailure('编辑器未正常退出，已取消操作')
    }
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
    const ui = await loadPrompts({ input: stdin, output: out, env })
    if (ui) {
      const entered = await ui.text({
        message: '记忆标题（留空则自动生成）',
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
        if (!fromEditor.trim()) {
          out.write('已取消写入\n')
          return 0
        }
        content = fromEditor
      } else {
        const ui = await loadPrompts({ input: stdin, output: out, env })
        if (!ui) throw new UsageError('要用 --content 指定记忆正文')
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

  const toolArgs: Record<string, unknown> = {
    content,
    ...(title !== undefined ? { title } : {}),
    ...(options.topics.length ? { topics: options.topics } : {}),
    ...(options.envs.length ? { envs: options.envs } : {}),
    ...(options.realms.length ? { realms: options.realms } : {}),
    ...(options.projects.length ? { projects: options.projects } : {}),
    ...(options.runtimes.length ? { runtimes: options.runtimes } : {}),
    ...(options.isPinned ? { is_pinned: true } : {}),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
    ...(options.validTo !== undefined ? { valid_to: options.validTo } : {}),
  }

  const { text, structured } = await requireMemoryTool<EntryDetailData>(
    config,
    'kioku_create',
    toolArgs,
  )

  if (options.json) {
    out.write(`${JSON.stringify(structured ?? { text }, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  const created = structured?.entry
  const label = plain(created?.title ?? title ?? created?.shortId ?? '')
  const idNote = created?.shortId ? `（${plain(created.shortId)}）` : ''
  out.write(`${theme.ok('✓')} 已创建记忆  ${label}${idNote}\n`)
  return 0
}

export const EDIT_USAGE = `用法：kioku edit <短ID或标题> [--title <标题>] [--content <正文> | --stdin]
                  [--topic <标签>...] [--env <环境>...] [--realm <场域>...]
                  [--project <项目>...] [--runtime <客户端>...]
                  [--pinned | --unpinned] [--disclosure <说明|clear>]
                  [--valid-to <时间|clear>] [--expected-version <版本号>]
                  [--platform <平台>] [--json]

修改单条记忆的标题、正文、场景标签、常驻状态或有效期。

  <短ID或标题>            例如 m-234567 或记忆标题
  --title <标题>          更新记忆标题
  --content <正文>        更新记忆正文
  --stdin                 从管道标准输入读取新正文
  --topic <标签>          覆盖主题标签列表（可重复或逗号分隔，传 clear 清空）
  --env <环境>            覆盖环境或自定义主机标识列表（如 mac、home-24；可重复或逗号分隔，传 clear 清空）
  --realm <场域>          覆盖场域标签列表（可重复或逗号分隔，传 clear 清空）
  --project <项目>        覆盖项目标签列表（可重复或逗号分隔，传 clear 清空）
  --runtime <客户端>      覆盖客户端标签列表（可重复或逗号分隔，传 clear 清空）
  --pinned / --unpinned   开启或取消常驻状态
  --disclosure <说明>     更新触发场景说明，传入 clear 清空
  --valid-to <时间>       更新有效期（ISO 8601），传入 clear 设为长期有效
  --expected-version <号> 乐观锁版本号
  --platform <平台>       指定使用哪个已配置客户端的身份
  --json                  以 JSON 格式输出更新后的记忆
`

export function parseEditArgs(argv: string[]): {
  id: string
  title?: string
  content?: string
  fromStdin: boolean
  topics?: string[]
  envs?: string[]
  realms?: string[]
  projects?: string[]
  runtimes?: string[]
  isPinned?: boolean
  disclosure?: string | null
  validTo?: string | null
  expectedVersion?: number
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let title: string | undefined
  let content: string | undefined
  let fromStdin = false
  let topics: string[] | undefined
  let envs: string[] | undefined
  let realms: string[] | undefined
  let projects: string[] | undefined
  let runtimes: string[] | undefined
  let isPinned: boolean | undefined
  let disclosure: string | null | undefined
  let validTo: string | null | undefined
  let expectedVersion: number | undefined
  let platform: string | undefined
  let json = false
  let endOfFlags = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--stdin') fromStdin = true
    else if (!endOfFlags && arg === '--pinned') {
      if (isPinned === false) throw new UsageError('--pinned 与 --unpinned 不能同时传入')
      isPinned = true
    } else if (!endOfFlags && arg === '--unpinned') {
      if (isPinned === true) throw new UsageError('--pinned 与 --unpinned 不能同时传入')
      isPinned = false
    } else if (
      !endOfFlags &&
      (arg === '--title' ||
        arg === '--content' ||
        arg === '--topic' ||
        arg === '--env' ||
        arg === '--realm' ||
        arg === '--project' ||
        arg === '--runtime' ||
        arg === '--disclosure' ||
        arg === '--valid-to' ||
        arg === '--expected-version' ||
        arg === '--platform')
    ) {
      const val = argv[++i]
      if (val === undefined) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--title') title = val
      else if (arg === '--content') content = val
      else if (arg === '--topic') {
        topics ??= []
        parseTopicInput(val, topics, true)
      } else if (arg === '--env') {
        envs ??= []
        parseSceneListInput(val, '--env', envs, true)
      } else if (arg === '--realm') {
        realms ??= []
        parseSceneListInput(val, '--realm', realms, true)
      } else if (arg === '--project') {
        projects ??= []
        parseSceneListInput(val, '--project', projects, true)
      } else if (arg === '--runtime') {
        runtimes ??= []
        parseSceneListInput(val, '--runtime', runtimes, true)
      } else if (arg === '--disclosure') {
        const clean = val.trim()
        disclosure =
          clean === '' ||
          clean === 'clear' ||
          clean === 'none' ||
          clean === 'null' ||
          clean === '清除'
            ? null
            : clean
      } else if (arg === '--valid-to') validTo = parseValidTo(val, true)
      else if (arg === '--expected-version') expectedVersion = parseVersion(val)
      else platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (id !== undefined) {
      throw new UsageError('每次只指定一个记忆短 ID 或标题')
    } else {
      id = arg
    }
  }

  if (!id) throw new UsageError('要指定记忆短 ID 或标题，例如 m-234567')
  if (content !== undefined && fromStdin) {
    throw new UsageError('--content 与 --stdin 不能同时传入')
  }
  return {
    id,
    title,
    content,
    fromStdin,
    topics,
    envs,
    realms,
    projects,
    runtimes,
    isPinned,
    disclosure,
    validTo,
    expectedVersion,
    platform,
    json,
  }
}

export async function editCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseEditArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })
  const interactive = !options.json && isInteractiveTty(stdin, out)

  let content = options.content
  if (options.fromStdin) {
    if (stdin.isTTY) throw new UsageError('--stdin 只能配合管道或重定向标准输入使用')
    content = await readPipedStdin(stdin)
  }

  const hasFields =
    options.title !== undefined ||
    content !== undefined ||
    options.topics !== undefined ||
    options.envs !== undefined ||
    options.realms !== undefined ||
    options.projects !== undefined ||
    options.runtimes !== undefined ||
    options.isPinned !== undefined ||
    options.disclosure !== undefined ||
    options.validTo !== undefined

  if (!hasFields && interactive) {
    const fromEditor = await editInTempEditor(env)
    if (fromEditor !== null) {
      if (!fromEditor.trim()) {
        out.write('已取消更新\n')
        return 0
      }
      content = fromEditor
    }
  }

  const toolArgs: Record<string, unknown> = {
    id: options.id,
    ...(options.expectedVersion !== undefined ? { expected_version: options.expectedVersion } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(options.topics !== undefined ? { topics: options.topics } : {}),
    ...(options.envs !== undefined ? { envs: options.envs } : {}),
    ...(options.realms !== undefined ? { realms: options.realms } : {}),
    ...(options.projects !== undefined ? { projects: options.projects } : {}),
    ...(options.runtimes !== undefined ? { runtimes: options.runtimes } : {}),
    ...(options.isPinned !== undefined ? { is_pinned: options.isPinned } : {}),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
    ...(options.validTo !== undefined ? { valid_to: options.validTo } : {}),
  }

  if (
    toolArgs.title === undefined &&
    toolArgs.content === undefined &&
    toolArgs.topics === undefined &&
    toolArgs.envs === undefined &&
    toolArgs.realms === undefined &&
    toolArgs.projects === undefined &&
    toolArgs.runtimes === undefined &&
    toolArgs.is_pinned === undefined &&
    toolArgs.disclosure === undefined &&
    toolArgs.valid_to === undefined
  ) {
    throw new UsageError('至少指定一项要修改的内容（如 --title、--content、--topic 等）')
  }

  const { text, structured } = await requireMemoryTool<EntryDetailData>(
    config,
    'kioku_update',
    toolArgs,
  )

  if (options.json) {
    out.write(`${JSON.stringify(structured ?? { text }, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  const updated = structured?.entry
  const label = plain(updated?.title ?? updated?.shortId ?? options.id)
  const verNote = typeof updated?.version === 'number' ? ` · v${updated.version}` : ''
  const idNote = updated?.shortId ? `（${plain(updated.shortId)}${verNote}）` : ''
  out.write(`${theme.ok('✓')} 已更新记忆  ${label}${idNote}\n`)
  return 0
}

export const DELETE_USAGE = `用法：kioku delete <短ID或标题> [--expected-version <版本号>]
                    [--yes | -y] [--platform <平台>] [--json]
别称：kioku rm

软删除单条记忆（移入回收站，可在管理界面恢复）。

  <短ID或标题>            例如 m-234567 或记忆标题
  --expected-version <号> 乐观锁版本号
  --yes, -y               免交互确认（非终端且未传 --json 时必需）
  --platform <平台>       指定使用哪个已配置客户端的身份
  --json                  以 JSON 格式输出删除结果
`

export function parseDeleteArgs(argv: string[]): {
  id: string
  expectedVersion?: number
  yes: boolean
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let expectedVersion: number | undefined
  let yes = false
  let platform: string | undefined
  let json = false
  let endOfFlags = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && (arg === '--yes' || arg === '-y')) yes = true
    else if (!endOfFlags && arg === '--expected-version') {
      const val = argv[++i]
      if (!val) throw new UsageError('--expected-version 后面要写整数')
      expectedVersion = parseVersion(val)
    } else if (!endOfFlags && arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (id !== undefined) {
      throw new UsageError('每次只指定一个记忆短 ID 或标题')
    } else {
      id = arg
    }
  }
  if (!id) throw new UsageError('要指定记忆短 ID 或标题，例如 m-234567')
  return { id, expectedVersion, yes, platform, json }
}

export async function deleteCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseDeleteArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })
  const interactive = !options.json && isInteractiveTty(stdin, out)

  if (!options.yes && !options.json) {
    if (!interactive) {
      throw new KiokuFailure('不在终端里运行时要加 --yes 才删除记忆')
    }
    const ui = await loadPrompts({ input: stdin, output: out, env })
    if (!ui) throw new KiokuFailure('无法打开确认提示：加 --yes 确认删除')
    const ok = await ui.confirm({
      message: `确认删除记忆 ${plain(options.id)}？`,
      initialValue: false,
    })
    if (isCancel(ok) || ok !== true) {
      out.write('已取消删除\n')
      return 0
    }
  }

  const toolArgs: Record<string, unknown> = {
    id: options.id,
    ...(options.expectedVersion !== undefined ? { expected_version: options.expectedVersion } : {}),
  }
  const { structured } = await requireMemoryTool<{ deleted: boolean; id: string }>(
    config,
    'kioku_delete',
    toolArgs,
  )

  if (options.json) {
    out.write(`${JSON.stringify(structured ?? { deleted: true, id: options.id }, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  out.write(`${theme.ok('✓')} 已删除记忆  ${plain(options.id)}\n`)
  return 0
}

export const BOOT_USAGE = `用法：kioku boot [--project <项目>] [--platform <平台>] [--json]

预览会话启动时自动加载的常驻记忆与近期会话摘要。

  --project <项目>   按指定项目标识预览（省略时按默认透镜编译）
  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出启动加载内容
`

export function parseBootArgs(argv: string[]): {
  project?: string
  platform?: string
  json: boolean
} {
  let project: string | undefined
  let platform: string | undefined
  let json = false
  let endOfFlags = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--project') {
      const val = argv[++i]
      if (!val) throw new UsageError('--project 后面要写项目标识')
      project = validateSceneTag(val, '--project')
    } else if (!endOfFlags && arg === '--platform') {
      const val = argv[++i]
      if (!val) throw new UsageError('--platform 后面要写客户端名')
      platform = val
    } else if (!endOfFlags && arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else {
      throw new UsageError(`多余的参数 ${arg}`)
    }
  }
  return { project, platform, json }
}

export async function bootCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseBootArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })

  const query = options.project ? `?project=${encodeURIComponent(options.project)}` : ''
  const { status, data } = await memoryRequest(config, 'GET', `/v1/boot${query}`)
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data, null, 2)}\n`)
    return 0
  }

  const boot = data as Partial<BootResponseData>
  const entries = Array.isArray(boot.entries) ? boot.entries : []
  const episodes = Array.isArray(boot.episodes) ? boot.episodes : []
  const omitted = Array.isArray(boot.omitted) ? boot.omitted : []
  const omittedItems = Array.isArray(boot.omittedItems) ? boot.omittedItems : []
  const isCatalogItem = (item: BootOmittedItemData) =>
    item.reason === 'index' || (!item.reason && item.bootMode === 'index')
  const catalogItems = omittedItems.filter(isCatalogItem)
  const overflowItems = omittedItems.filter((item) => !isCatalogItem(item))
  const overflowCount = overflowItems.length || (!omittedItems.length ? omitted.length : 0)
  const theme = createTheme({ stream: out, env })
  const width = boxWidthFor(out)
  const indentWrapWidth = Math.max(20, width - 6)

  if (!entries.length && !episodes.length && !omittedItems.length && !omitted.length) {
    const emptyBox = renderBox({
      title: '启动加载',
      width,
      theme,
      sections: [{ lines: [theme.muted('暂无启动加载内容')] }],
    })
    out.write(`${emptyBox}\n`)
    return 0
  }

  const sections: Array<{ title?: string; lines: string[] }> = []

  if (entries.length) {
    const entryLines: string[] = []
    entries.forEach((entry, idx) => {
      if (idx > 0) entryLines.push('')
      entryLines.push(
        `${theme.bold(plain(entry.title))}  ${theme.muted(`${kindLabel(entry.kind)} · ${plain(entry.shortId)}`)}`,
      )
      const scene = formatSceneInline(entry)
      if (scene) {
        entryLines.push(
          ...wrapWidth(`场景：${scene}`, indentWrapWidth).map((l) => `  ${theme.muted(l)}`),
        )
      }
      entryLines.push(...wrapWidth(sanitizeBody(entry.content), width - 4))
    })
    sections.push({ title: `常驻记忆（${entries.length}）`, lines: entryLines })
  }

  if (catalogItems.length) {
    const catalogLines: string[] = []
    catalogItems.forEach((item) => {
      catalogLines.push(`${theme.bold(plain(item.title))}  ${theme.muted(plain(item.shortId))}`)
      const scene = formatSceneInline(item)
      if (scene) {
        catalogLines.push(
          ...wrapWidth(`场景：${scene}`, indentWrapWidth).map((l) => `  ${theme.muted(l)}`),
        )
      }
      const note = plain(stripAnsi(item.summary ?? '')) || plain(stripAnsi(item.disclosure ?? ''))
      if (note) {
        catalogLines.push(...wrapWidth(note, indentWrapWidth).map((l) => `  ${theme.muted(l)}`))
      }
    })
    sections.push({ title: `常驻目录（${catalogItems.length}）`, lines: catalogLines })
  }

  if (episodes.length) {
    const episodeLines: string[] = []
    episodes.forEach((episode, idx) => {
      if (idx > 0) episodeLines.push('')
      const timeNote = episode.createdAt ? ` · ${plain(episode.createdAt)}` : ''
      episodeLines.push(
        `${theme.bold(plain(episode.title))}  ${theme.muted(`${plain(episode.shortId)}${timeNote}`)}`,
      )
      episodeLines.push(...wrapWidth(sanitizeBody(episode.content), width - 4))
    })
    sections.push({ title: `近期会话摘要（${episodes.length}）`, lines: episodeLines })
  }

  if (overflowItems.length) {
    const overflowLines: string[] = []
    overflowItems.forEach((item) => {
      const reasonText = item.reason === 'oversized' ? '单条超限' : '预算外'
      overflowLines.push(
        `${plain(item.title)}  ${theme.muted(`${plain(item.shortId)} · ${reasonText}`)}`,
      )
      const scene = formatSceneInline(item)
      if (scene) {
        overflowLines.push(
          ...wrapWidth(`场景：${scene}`, indentWrapWidth).map((l) => `  ${theme.muted(l)}`),
        )
      }
    })
    sections.push({ title: `字数预算外（${overflowItems.length}）`, lines: overflowLines })
  } else if (!omittedItems.length && omitted.length) {
    sections.push({
      title: `字数预算外（${omitted.length}）`,
      lines: [theme.muted(omitted.map((id) => plain(id)).join('、'))],
    })
  }

  const boxTitle = entries.length
    ? `启动加载预览 · 常驻记忆（${entries.length}）`
    : catalogItems.length
      ? `启动加载预览 · 常驻目录（${catalogItems.length}）`
      : episodes.length
        ? `启动加载预览 · 近期会话摘要（${episodes.length}）`
        : overflowCount
          ? `启动加载预览 · 字数预算外（${overflowCount}）`
          : '启动加载预览'

  const box = renderBox({
    title: boxTitle,
    width,
    theme,
    sections,
  })
  out.write(`${box}\n`)
  return 0
}
