// 日常记忆读写命令：search、get、ls、add、edit、delete、transfer 与 boot。
// 身份默认经 identity.ts 自动解析，支持管道读取正文、$EDITOR 撰写、明文拦阻确认与 --json 结构化输出。

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ServerMismatch, UNAVAILABLE_TEXT, generationProblem, probeServer } from '../api.ts'
import {
  DATABASE_UNAVAILABLE_CODE,
  KiokuFailure,
  UsageError,
  errorCodeOf,
  fetchFailure,
  isRedirect,
  launch,
  plain,
  redirectError,
  rejectionOf,
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
  形态: 'kind',
}

const ENTRY_KIND_ALIASES: Record<string, 'entry' | 'fact' | 'episode'> = {
  entry: 'entry',
  正式记忆: 'entry',
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

const VIA_LABELS: Record<string, string> = {
  semantic: '语义',
  fulltext: '全文',
  glossary: '关键词',
  link: '双链',
}

const PLAINTEXT_KIND_NAMES: Record<string, string> = {
  label: '标注的密码或令牌',
  sk: 'sk- 开头的密钥',
  github: 'GitHub 令牌',
  gitlab: 'GitLab 令牌',
  slack: 'Slack 令牌',
  aws: 'AWS 密钥 ID',
  jwt: 'JWT',
  private_key: '私钥',
  kioku: 'Kioku 访问密钥',
  provider_token: '第三方服务令牌',
  url_password: '网址内嵌密码',
  header_secret: '请求头凭据',
  wallet_key: '加密钱包私钥',
  seed_phrase: '钱包助记词',
  custom: '自定义规则命中',
}

const FACET_DIM_RE = /^[a-z][a-z0-9_]{0,31}$/
const FACET_TERM_RE = /^[a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{1,64}$/
const VALID_TO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

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

export interface SubjectFactData {
  shortId?: string
  content: string
  crossGroup?: boolean
  updatedAt?: string
}

export interface SubjectFactsData {
  role: 'sender' | 'group'
  name: string | null
  facts: SubjectFactData[]
}

export interface RecallResponseData {
  candidates: RecallCandidateData[]
  subjects?: SubjectFactsData[]
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

export interface BootPersonaTraitData {
  traitKey: string
  title: string
  content: string
}

export interface BootEntryData {
  shortId: string
  title: string
  circleId: string
  circleSlug: string | null
  kind: string
  content: string
}

export interface BootResponseData {
  personaTraits: BootPersonaTraitData[]
  entries: BootEntryData[]
  omitted: string[]
}

interface PlaintextSpot {
  line?: unknown
  kind?: unknown
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

export function plaintextKindLabel(kind: unknown): string {
  const clean = typeof kind === 'string' ? kind.trim() : ''
  if (!clean) return '未知类型'
  return PLAINTEXT_KIND_NAMES[clean] ?? plain(clean)
}

export function formatWhen(when: Record<string, string[]> | undefined): string {
  if (!when) return '通用'
  const keys = Object.keys(when)
    .filter((k) => Array.isArray(when[k]) && when[k].length > 0)
    .sort()
  if (!keys.length) return '通用'
  return keys.map((k) => `${plain(k)}=${when[k].map((v) => plain(v)).join(',')}`).join(' · ')
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

function parseTopicInput(raw: string, into: string[]): void {
  for (const part of raw.split(',')) {
    if (!part.trim()) continue
    const clean = validateTopicTag(part)
    if (!into.includes(clean)) into.push(clean)
  }
}

function parseKeywordInput(
  raw: string,
  into: string[],
  { allowSingleChar = false }: { allowSingleChar?: boolean } = {},
): void {
  const minLen = allowSingleChar ? 1 : 2
  for (const part of raw.split(',')) {
    const clean = part.trim()
    if (!clean) continue
    if (
      clean.length < minLen ||
      clean.length > 64 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(clean) ||
      clean.includes('{{cred:')
    ) {
      throw new UsageError(`关键词格式不对（须为 ${minLen} 到 64 个字符）：${clean}`)
    }
    if (!into.includes(clean)) into.push(clean)
  }
}

function parseWhenInput(raw: string, into: Record<string, string[]>): void {
  const eq = raw.indexOf('=')
  if (eq <= 0) {
    throw new UsageError('--when 格式应为 <维度>=<标识1,标识2>，例如 runtime=claudecode')
  }
  const dim = raw.slice(0, eq).trim().toLowerCase()
  if (!FACET_DIM_RE.test(dim)) {
    throw new UsageError(`语境维度键格式不对：${dim}`)
  }
  const terms = raw
    .slice(eq + 1)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  if (!terms.length) {
    throw new UsageError(`--when ${dim}= 后面至少要写一个条件标识`)
  }
  for (const term of terms) {
    if (!FACET_TERM_RE.test(term)) {
      throw new UsageError(`语境条件标识格式不对：${term}`)
    }
  }
  const merged = new Set([...(into[dim] ?? []), ...terms])
  into[dim] = [...merged].sort()
}

function parseSingleWhen(raw: string): Record<string, string[]> {
  const trimmed = raw.trim()
  if (trimmed === '{}' || trimmed === '通用' || trimmed.toLowerCase() === 'generic') {
    return {}
  }
  const target: Record<string, string[]> = {}
  parseWhenInput(trimmed, target)
  return target
}

function parseSensitivity(val: string): 'public' | 'internal' | 'private' | 'secret' {
  const mapped = SENSITIVITY_ALIASES[val.trim().toLowerCase()]
  if (!mapped) {
    throw new UsageError(
      '--sensitivity 只收 公开、内部、私密、机密（或 public、internal、private、secret）',
    )
  }
  return mapped
}

function parsePriority(val: string): number {
  if (!/^\d+$/.test(val)) throw new UsageError('--priority 须为 0 到 99 之间的整数')
  const num = Number(val)
  if (!Number.isInteger(num) || num < 0 || num > 99) {
    throw new UsageError('--priority 须为 0 到 99 之间的整数')
  }
  return num
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

function matchesWhenFilter(
  summaries: Array<Record<string, string[]>> | undefined,
  filter: Record<string, string[]>,
): boolean {
  const dims = Object.keys(filter)
  if (!dims.length) return true
  if (!Array.isArray(summaries) || !summaries.length) return false
  return summaries.some((summary) =>
    dims.every((dim) => {
      const candidateTerms = summary[dim]
      return Array.isArray(candidateTerms) && filter[dim].some((t) => candidateTerms.includes(t))
    }),
  )
}

async function memoryRequest(
  config: TargetConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  const rejected = res.ok ? null : rejectionOf(res.status, data, config.url)
  if (rejected) throw rejected
  // 新版接口落到旧版或维护中服务端时会回 404 或 5xx：查一眼健康检查识别代际与库状态
  if (res.status === 404 || res.status >= 500) {
    const probe = await probeServer(config.url)
    const problem = generationProblem(probe, config.url)
    if (problem) throw new ServerMismatch(problem, probe)
    if (probe.state === 'unavailable') throw new ServerMismatch(UNAVAILABLE_TEXT, probe)
  }
  if (res.status === 503 && errorCodeOf(data) === DATABASE_UNAVAILABLE_CODE) {
    throw new ServerMismatch(UNAVAILABLE_TEXT, {
      generation: 2,
      state: 'unavailable',
      version: null,
    })
  }
  return { status: res.status, data }
}

function throwForStatus(status: number, data: Record<string, unknown> | null, key: string): never {
  const detail = maskKeyText(data?.error, key)
  if (status === 401) throw new KiokuFailure(detail || '访问密钥无效或已吊销')
  if (status === 403) throw new KiokuFailure(detail || '当前访问密钥无权执行此操作')
  if (status === 404) throw new KiokuFailure(detail || '记忆不存在，或当前访问密钥无权读取')
  if (status === 409) throw new KiokuFailure(detail || '版本已变更或发生冲突，请重新读取后再试')
  throw new KiokuFailure(detail || `Kioku 返回 HTTP ${status}`)
}

function renderEntryCard(
  view: EntryViewData,
  out: { isTTY?: boolean; columns?: number },
  theme: StrataTheme,
): string {
  const width = boxWidthFor(out)
  const meta: string[] = [
    `短 ID：${plain(view.shortId)} · 形态：${theme.kind(view.kind)} · 敏感级：${sensitivityBadge(view.sensitivity, theme)}`,
    `${view.circleSlug ? `记忆圈：${plain(view.circleSlug)} · ` : ''}优先级：P${view.priority} · 版本：v${view.version}`,
  ]
  if (view.provenance) meta.push(`来源：${plain(view.provenance)}`)
  if (Array.isArray(view.realms) && view.realms.length) {
    meta.push(`场域：${view.realms.map((r) => plain(r)).join('、')}`)
  }
  if (Array.isArray(view.topics) && view.topics.length) {
    meta.push(`主题：${view.topics.map((t) => plain(t)).join('、')}`)
  }
  if (view.disclosure) meta.push(`召回说明：${plain(view.disclosure)}`)
  if (Array.isArray(view.glossary) && view.glossary.length) {
    meta.push(`关键词：${view.glossary.map((g) => plain(g)).join('、')}`)
  }
  if (view.validTo) meta.push(`有效期：${plain(view.validTo)}`)
  if (view.createdAt || view.updatedAt) {
    const timeParts: string[] = []
    if (view.createdAt) timeParts.push(`创建 ${plain(view.createdAt)}`)
    if (view.updatedAt) timeParts.push(`更新 ${plain(view.updatedAt)}`)
    meta.push(timeParts.join(' · '))
  }

  const variants = Array.isArray(view.variants) ? view.variants : []
  if (view.sensitivity === 'secret' && variants.some((v) => v.content !== null)) {
    meta.push(`${theme.warn('!')} 机密正文已解密读取，请勿留存到日志`)
  }
  const bodyLines: string[] = []
  if (!variants.length) {
    bodyLines.push(theme.muted('（当前语境焦点下暂无匹配的变体；加 --all-variants 查看全部）'))
  } else if (variants.length === 1 && formatWhen(variants[0].when) === '通用') {
    if (variants[0].content === null) {
      bodyLines.push(theme.muted('（正文未返回，需管理界面或具备机密读权限的访问密钥查看）'))
    } else {
      bodyLines.push(...wrapWidth(sanitizeBody(variants[0].content), width - 4))
    }
  } else {
    variants.forEach((v, idx) => {
      if (idx > 0) bodyLines.push('')
      bodyLines.push(theme.muted(`── 适用条件：${formatWhen(v.when)} ──`))
      if (v.content === null) {
        bodyLines.push(theme.muted('（正文未返回，需管理界面或具备机密读权限的访问密钥查看）'))
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
      title: `其他变体（${view.otherVariants.length}）`,
      lines: view.otherVariants.map((ov) => theme.muted(formatWhen(ov.when))),
    })
  }
  if (Array.isArray(view.links) && view.links.length) {
    sections.push({
      title: '双链',
      lines: view.links.map((link) => {
        const arrow = link.direction === 'incoming' ? '←' : '→'
        const circleNote = link.circleSlug ? `  ${theme.muted(`[${plain(link.circleSlug)}]`)}` : ''
        return `${arrow} ${plain(link.shortId)}  ${plain(link.title)}${circleNote}`
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

async function submitWithPlaintextGuard({
  config,
  method,
  path,
  payload,
  plaintextOk,
  interactive,
  json,
  env,
  out,
  stdin,
  cancelLabel,
}: {
  config: TargetConfig
  method: 'POST' | 'PATCH'
  path: string
  payload: Record<string, unknown>
  plaintextOk: boolean
  interactive: boolean
  json: boolean
  env: Env
  out: Writer & { isTTY?: boolean; columns?: number }
  stdin: Reader
  cancelLabel: string
}): Promise<
  | { cancelled: true; exitCode: number }
  | { cancelled: false; status: number; data: Record<string, unknown> | null }
> {
  let { status, data } = await memoryRequest(config, method, path, payload)

  if (status === 400 && Array.isArray(data?.plaintext) && data.plaintext.length > 0) {
    const spots = data.plaintext as PlaintextSpot[]
    const spotLines = spots.map(
      (spot) => `正文第 ${Number(spot.line) || '?'} 行：${plaintextKindLabel(spot.kind)}`,
    )
    const theme = createTheme({ stream: out, env })

    if (interactive && !plaintextOk) {
      const box = renderBox({
        title: '检测到疑似明文凭据',
        width: boxWidthFor(out),
        theme,
        sections: [{ lines: spotLines }],
      })
      out.write(`${box}\n`)
      const ui = await loadPrompts({ input: stdin, output: out, env })
      if (!ui) return { cancelled: true, exitCode: 1 }
      const decision = await ui.select<'cancel' | 'plaintextOk'>({
        message: '选择处理方式',
        options: [
          {
            value: 'cancel',
            label: `${cancelLabel}（先存为凭据或改用占位符）`,
          },
          {
            value: 'plaintextOk',
            label: '确认不是凭据，照常写入（进入待处理列表）',
          },
        ],
      })
      if (isCancel(decision) || decision !== 'plaintextOk') {
        out.write(`${cancelLabel}\n`)
        return { cancelled: true, exitCode: 1 }
      }
      const retry = await memoryRequest(config, method, path, {
        ...payload,
        plaintextOk: true,
      })
      status = retry.status
      data = retry.data
    } else {
      if (json) {
        out.write(`${JSON.stringify(data, null, 2)}\n`)
        return { cancelled: true, exitCode: 1 }
      }
      out.write(`${theme.error('✗')} 检测到疑似明文凭据，已阻止写入：\n`)
      for (const line of spotLines) out.write(`  ${line}\n`)
      out.write('确认不是凭据时加 --plaintext-ok 重试；若是凭据请先存入密码库或托管凭据\n')
      return { cancelled: true, exitCode: 1 }
    }
  }

  return { cancelled: false, status, data }
}

export const SEARCH_USAGE = `用法：kioku search <查询> [--when <维=值>...] [--no-cross-circle] [--limit <条数>]
                    [--platform <平台>] [--json]

从 Kioku 召回与查询相关的记忆（综合语义、全文与关键词）。交互式终端中可直接选择某条记忆展开详情。

  <查询>               要检索的关键词或问题
  --when <维=值>       按语境条件缩小与调制排序（可重复传入，如 --when realm=work）
  --no-cross-circle    只检索主圈，不跨关联圈召回
  --limit <条数>       最多返回的条数（1 到 50，默认沿用服务端设置）
  --platform <平台>    指定使用哪个已配置客户端的身份（默认自动识别）
  --json               以 JSON 格式输出（含候选列表与联系人直连事实）
`

export function parseSearchArgs(argv: string[]): {
  query?: string
  when: Record<string, string[]>
  crossCircle?: boolean
  limit?: number
  platform?: string
  json: boolean
} {
  const queryParts: string[] = []
  const when: Record<string, string[]> = {}
  let crossCircle: boolean | undefined
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
    else if (!endOfFlags && arg === '--no-cross-circle') crossCircle = false
    else if (!endOfFlags && arg === '--when') {
      const val = argv[++i]
      if (!val) throw new UsageError('--when 后面要写 <维度>=<标识1,标识2>')
      parseWhenInput(val, when)
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
  return { query, when, crossCircle, limit, platform, json }
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
    facets?: Record<string, string[]>
    crossCircle?: boolean
  } = { query }
  if (options.limit !== undefined) body.limit = options.limit
  if (Object.keys(options.when).length) body.facets = options.when
  if (options.crossCircle === false) body.crossCircle = false

  const { status, data } = await memoryRequest(config, 'POST', '/v1/recall', body)
  if (status !== 200) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data ?? { candidates: [], subjects: [] }, null, 2)}\n`)
    return 0
  }

  const recall = (data ?? {}) as Partial<RecallResponseData>
  const candidates = Array.isArray(recall.candidates) ? recall.candidates : []
  const subjects = Array.isArray(recall.subjects) ? recall.subjects : []
  const hasSubjectFacts = subjects.some((s) => Array.isArray(s.facts) && s.facts.length > 0)
  const theme = createTheme({ stream: out, env })
  const width = boxWidthFor(out)

  if (!candidates.length && !hasSubjectFacts) {
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
    const crossTag = c.crossGroup ? '  [跨群印象]' : ''
    lines.push(
      `${theme.bold(`${idx + 1}.`)} ${theme.bold(plain(c.title))}  ${theme.kind(c.kind)}  ${theme.muted(`P${c.priority} · 相关度 ${scoreText}`)}${crossTag}`,
    )
    if (c.disclosure) lines.push(`   ${theme.muted(plain(c.disclosure))}`)
    const circleNote = c.circleSlug ? ` · 记忆圈 ${plain(c.circleSlug)}` : ''
    const whenNote =
      c.matchedWhen && Object.keys(c.matchedWhen).length
        ? ` · 适用条件 ${formatWhen(c.matchedWhen)}`
        : ''
    const moreNote =
      typeof c.otherVariantsCount === 'number' && c.otherVariantsCount > 0
        ? ` · 另有 ${c.otherVariantsCount} 个变体`
        : ''
    const viaNote =
      Array.isArray(c.via) && c.via.length
        ? ` · 命中 ${c.via.map((v) => VIA_LABELS[v] ?? plain(v)).join('/')}`
        : ''
    lines.push(
      `   ${theme.muted(`短 ID：${plain(c.shortId)}${circleNote}${whenNote}${moreNote}${viaNote}`)}`,
    )
    if (Array.isArray(c.cues) && c.cues.length) {
      lines.push(`   ${theme.muted(`线索：${c.cues.map((x) => plain(x)).join('、')}`)}`)
    }
  })

  const sections: Array<{ title?: string; lines: string[] }> = []
  if (lines.length) sections.push({ title: `候选记忆（${candidates.length}）`, lines })
  for (const subject of subjects) {
    if (!Array.isArray(subject.facts) || !subject.facts.length) continue
    const roleName = subject.role === 'sender' ? '发言人事实' : '当前群事实'
    const header = subject.name ? `${roleName} · ${plain(subject.name)}` : roleName
    sections.push({
      title: header,
      lines: subject.facts.map((fact) => {
        const prefix = fact.shortId ? `${plain(fact.shortId)}  ` : ''
        const cross = fact.crossGroup ? '  [跨群]' : ''
        return `${prefix}${plain(fact.content)}${cross}`
      }),
    })
  }

  const box = renderBox({
    title: `检索：${plain(query)}（${candidates.length} 条）`,
    width,
    theme,
    sections,
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
          hint: plain(
            `${kindLabel(c.kind)} · ${c.shortId}${c.circleSlug ? ` · ${c.circleSlug}` : ''}`,
          ),
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

读取单条记忆的完整属性、变体与双链关系。

  <短ID或标题>         例如 m-234567、记忆标题或旧坐标
  --circle <记忆圈>    限定在指定记忆圈内查找
  --all-variants       返回全部变体（不按当前语境焦点过滤）
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出记忆对象
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
  let endOfFlags = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--json') json = true
    else if (!endOfFlags && arg === '--all-variants') allVariants = true
    else if (!endOfFlags && arg === '--circle') {
      const val = argv[++i]
      if (!val) throw new UsageError('--circle 后面要写记忆圈标识')
      circle = val
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

export const LS_USAGE = `用法：kioku ls [分组维度] [--circle <记忆圈>] [--kind <形态>] [--topic <主题>]
                [--when <维=值>...] [--query <关键词>] [--limit <条数>] [--platform <平台>] [--json]

按维度分组浏览可见的记忆目录，默认按主题（topic）分组。

  [分组维度]         topic / circle / realm / env / runtime / project / kind（也收中文名）
  --circle <记忆圈>  只看指定记忆圈
  --kind <形态>      只看 正式记忆 / 联系人事实 / 会话摘要（entry / fact / episode）
  --topic <主题>     按主题标签过滤
  --when <维=值>     按变体适用条件过滤（可重复传入）
  --query <关键词>   按标题关键词过滤
  --limit <条数>     最多返回的记忆数（1 到 500）
  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出分组结果
`

export function parseLsArgs(argv: string[]): {
  groupBy: BrowseGroupBy
  circle?: string
  kind?: 'entry' | 'fact' | 'episode'
  topic?: string
  when: Record<string, string[]>
  query?: string
  limit?: number
  platform?: string
  json: boolean
} {
  let groupBy: BrowseGroupBy | undefined
  let circle: string | undefined
  let kind: 'entry' | 'fact' | 'episode' | undefined
  let topic: string | undefined
  const when: Record<string, string[]> = {}
  let query: string | undefined
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
    else if (!endOfFlags && arg === '--circle') {
      const val = argv[++i]
      if (!val) throw new UsageError('--circle 后面要写记忆圈标识')
      circle = val
    } else if (!endOfFlags && arg === '--kind') {
      const val = argv[++i]
      if (!val) throw new UsageError('--kind 后面要写形态')
      const mapped = ENTRY_KIND_ALIASES[val.trim().toLowerCase()] ?? ENTRY_KIND_ALIASES[val.trim()]
      if (!mapped) throw new UsageError('--kind 只收 entry、fact、episode（或对应中文形态名）')
      kind = mapped
    } else if (!endOfFlags && arg === '--topic') {
      const val = argv[++i]
      if (!val) throw new UsageError('--topic 后面要写主题标签')
      topic = validateTopicTag(val)
    } else if (!endOfFlags && arg === '--when') {
      const val = argv[++i]
      if (!val) throw new UsageError('--when 后面要写 <维度>=<标识1,标识2>')
      parseWhenInput(val, when)
    } else if (!endOfFlags && arg === '--query') {
      const val = argv[++i]
      if (!val) throw new UsageError('--query 后面要写关键词')
      query = val
    } else if (!endOfFlags && arg === '--limit') {
      const val = argv[++i]
      if (!val || !/^\d+$/.test(val)) throw new UsageError('--limit 须为 1 到 500 之间的整数')
      const num = Number(val)
      if (!Number.isInteger(num) || num < 1 || num > 500) {
        throw new UsageError('--limit 须为 1 到 500 之间的整数')
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
      const normalized = arg.trim().toLowerCase()
      const mapped = GROUP_BY_ALIASES[normalized] ?? GROUP_BY_ALIASES[arg.trim()]
      if (!mapped) {
        throw new UsageError(`不认识的分组维度 ${arg}，可选：${GROUP_BY_VALUES.join('、')}`)
      }
      groupBy = mapped
    }
  }
  return { groupBy: groupBy ?? 'topic', circle, kind, topic, when, query, limit, platform, json }
}

function formatBrowseItems(items: EntryBrowseItemData[], theme: StrataTheme): string[] {
  if (!items.length) return [theme.muted('暂无记忆')]
  return items.map((item) => {
    const tags = [
      theme.kind(item.kind),
      sensitivityBadge(item.sensitivity, theme),
      theme.muted(`P${item.priority}`),
    ]
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

  const payload = data as unknown as EntryBrowseResponseData
  let groups = Array.isArray(payload.groups) ? payload.groups : []
  if (Object.keys(options.when).length) {
    groups = groups
      .map((group) => {
        const items = (Array.isArray(group.items) ? group.items : []).filter((item) =>
          matchesWhenFilter(item.variantsSummary, options.when),
        )
        return { ...group, items, count: items.length }
      })
      .filter((group) => group.items.length > 0)
  }

  if (options.json) {
    const output = Object.keys(options.when).length ? { ...payload, groups } : data
    out.write(`${JSON.stringify(output, null, 2)}\n`)
    return 0
  }

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
      options.groupBy === 'kind' &&
      (group.key === 'entry' || group.key === 'fact' || group.key === 'episode')
        ? kindLabel(group.key)
        : plain(group.label)
    return {
      lines: [
        theme.bold(`${groupTitle}（${group.count}）`),
        ...formatBrowseItems(Array.isArray(group.items) ? group.items : [], theme),
      ],
    }
  })
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
                [--when <维=值>...] [--sensitivity <级别>] [--disclosure <说明>]
                [--priority <0-99>] [--glossary <关键词>...] [--valid-to <时间>]
                [--plaintext-ok] [--platform <平台>] [--json]

写入一条新正式记忆（也可以经标准输入管道传入正文，或在交互式终端打开编辑器填写）。

  [标题]               记忆标题（也可改用 --title；省略时取正文首个一级标题或短 ID）
  --circle <记忆圈>    目标记忆圈 slug（默认写入当前客户端主圈）
  --content <正文>     记忆正文；省略时读取管道标准输入或打开编辑器
  --topic <标签>       主题标签（可重复传入或逗号分隔）
  --when <维=值>       生效适用条件（可重复传入，如 --when realm=work --when project=kioku）
  --sensitivity <级别> 公开 / 内部 / 私密 / 机密（也收 public / internal / private / secret）
  --disclosure <说明>  召回说明：提示何时展开读取这条记忆
  --priority <0-99>    优先级整数（0–99）
  --glossary <关键词>  触发词关键词（至少 2 个字，可重复传入或逗号分隔）
  --valid-to <时间>    有效期（带时区 ISO 8601，例如 2026-12-31T23:59:00+08:00）
  --plaintext-ok       确认正文疑似明文不是凭据，照常写入（记忆将进入待处理）
  --platform <平台>    指定使用哪个已配置客户端的身份
  --json               以 JSON 格式输出创建的记忆
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
  glossary: string[]
  validTo?: string
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
  const glossary: string[] = []
  let validTo: string | undefined
  let plaintextOk = false
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
    else if (!endOfFlags && (arg === '--plaintext-ok' || arg === '--allow-plaintext')) {
      plaintextOk = true
    } else if (
      !endOfFlags &&
      (arg === '--title' ||
        arg === '--circle' ||
        arg === '--content' ||
        arg === '--topic' ||
        arg === '--when' ||
        arg === '--sensitivity' ||
        arg === '--disclosure' ||
        arg === '--priority' ||
        arg === '--glossary' ||
        arg === '--valid-to' ||
        arg === '--platform')
    ) {
      const val = argv[++i]
      if (val === undefined) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--title') flagTitle = val
      else if (arg === '--circle') circle = val
      else if (arg === '--content') content = val
      else if (arg === '--topic') parseTopicInput(val, topics)
      else if (arg === '--when') parseWhenInput(val, when)
      else if (arg === '--disclosure') disclosure = val
      else if (arg === '--glossary') parseKeywordInput(val, glossary)
      else if (arg === '--valid-to') validTo = parseValidTo(val)
      else if (arg === '--platform') platform = val
      else if (arg === '--sensitivity') sensitivity = parseSensitivity(val)
      else priority = parsePriority(val)
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
    circle,
    content,
    topics,
    when,
    sensitivity,
    disclosure,
    priority,
    glossary,
    validTo,
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

  const basePayload: Record<string, unknown> = {
    content,
    ...(options.circle ? { circle: options.circle } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(Object.keys(options.when).length ? { when: options.when } : {}),
    ...(options.topics.length ? { topics: options.topics } : {}),
    ...(options.sensitivity !== undefined ? { sensitivity: options.sensitivity } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
    ...(options.glossary.length ? { glossary: options.glossary } : {}),
    ...(options.validTo !== undefined ? { validTo: options.validTo } : {}),
    ...(options.plaintextOk ? { plaintextOk: true } : {}),
  }

  const res = await submitWithPlaintextGuard({
    config,
    method: 'POST',
    path: '/v1/entries',
    payload: basePayload,
    plaintextOk: options.plaintextOk,
    interactive,
    json: options.json,
    env,
    out,
    stdin,
    cancelLabel: '已取消写入',
  })
  if (res.cancelled) return res.exitCode

  const { status, data } = res
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

export const EDIT_USAGE = `用法：kioku edit <短ID或标题> [--circle <记忆圈>] [--title <标题>] [--content <正文> | --stdin]
                  [--when <维=值>...] [--remove-when <维=值>...] [--topic <标签>...]
                  [--sensitivity <级别>] [--priority <0-99>] [--disclosure <说明|clear>]
                  [--glossary-add <关键词>...] [--glossary-remove <关键词>...]
                  [--valid-to <时间|clear>] [--expected-version <版本号>]
                  [--plaintext-ok] [--platform <平台>] [--json]

修改单条记忆的属性、内容或语境变体。

  <短ID或标题>            例如 m-234567、记忆标题或旧坐标
  --circle <记忆圈>       限定所在记忆圈
  --title <标题>          更新记忆标题
  --content <正文>        更新正文（默认更新通用变体，配合 --when 更新指定条件变体）
  --stdin                 从管道标准输入读取新正文
  --when <维=值>          配合 --content 指定本次写入的变体适用条件
  --remove-when <维=值>   删除指定适用条件的变体（通用变体传 通用 或 {}）
  --topic <标签>          覆盖主题标签列表（可重复或逗号分隔）
  --sensitivity <级别>    公开 / 内部 / 私密 / 机密
  --priority <0-99>       优先级整数（0–99）
  --disclosure <说明>     更新召回说明，传入 clear 清空
  --glossary-add <词>     追加触发关键词（至少 2 个字）
  --glossary-remove <词>  移除触发关键词
  --valid-to <时间>       更新有效期（ISO 8601），传入 clear 设为长期有效
  --expected-version <号> 乐观锁版本号
  --plaintext-ok          确认正文疑似明文不是凭据，照常更新
  --platform <平台>       指定使用哪个已配置客户端的身份
  --json                  以 JSON 格式输出更新后的记忆
`

export function parseEditArgs(argv: string[]): {
  id: string
  circle?: string
  title?: string
  content?: string
  fromStdin: boolean
  when: Record<string, string[]>
  removeVariantWhens: Array<Record<string, string[]>>
  topics?: string[]
  sensitivity?: 'public' | 'internal' | 'private' | 'secret'
  priority?: number
  disclosure?: string | null
  glossaryAdd: string[]
  glossaryRemove: string[]
  validTo?: string | null
  expectedVersion?: number
  plaintextOk: boolean
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let circle: string | undefined
  let title: string | undefined
  let content: string | undefined
  let fromStdin = false
  const when: Record<string, string[]> = {}
  const removeVariantWhens: Array<Record<string, string[]>> = []
  let topics: string[] | undefined
  let sensitivity: 'public' | 'internal' | 'private' | 'secret' | undefined
  let priority: number | undefined
  let disclosure: string | null | undefined
  const glossaryAdd: string[] = []
  const glossaryRemove: string[] = []
  let validTo: string | null | undefined
  let expectedVersion: number | undefined
  let plaintextOk = false
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
    else if (!endOfFlags && (arg === '--plaintext-ok' || arg === '--allow-plaintext')) {
      plaintextOk = true
    } else if (
      !endOfFlags &&
      (arg === '--circle' ||
        arg === '--title' ||
        arg === '--content' ||
        arg === '--when' ||
        arg === '--remove-when' ||
        arg === '--topic' ||
        arg === '--sensitivity' ||
        arg === '--priority' ||
        arg === '--disclosure' ||
        arg === '--glossary-add' ||
        arg === '--glossary-remove' ||
        arg === '--valid-to' ||
        arg === '--expected-version' ||
        arg === '--platform')
    ) {
      const val = argv[++i]
      if (val === undefined) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--circle') circle = val
      else if (arg === '--title') title = val
      else if (arg === '--content') content = val
      else if (arg === '--when') parseWhenInput(val, when)
      else if (arg === '--remove-when') removeVariantWhens.push(parseSingleWhen(val))
      else if (arg === '--topic') {
        topics ??= []
        parseTopicInput(val, topics)
      } else if (arg === '--sensitivity') sensitivity = parseSensitivity(val)
      else if (arg === '--priority') priority = parsePriority(val)
      else if (arg === '--disclosure') {
        const clean = val.trim()
        disclosure =
          clean === 'clear' || clean === 'none' || clean === 'null' || clean === '清除'
            ? null
            : clean
      } else if (arg === '--glossary-add') parseKeywordInput(val, glossaryAdd)
      else if (arg === '--glossary-remove') {
        parseKeywordInput(val, glossaryRemove, { allowSingleChar: true })
      } else if (arg === '--valid-to') validTo = parseValidTo(val, true)
      else if (arg === '--expected-version') expectedVersion = parseVersion(val)
      else if (arg === '--platform') platform = val
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
    circle,
    title,
    content,
    fromStdin,
    when,
    removeVariantWhens,
    topics,
    sensitivity,
    priority,
    disclosure,
    glossaryAdd,
    glossaryRemove,
    validTo,
    expectedVersion,
    plaintextOk,
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

  if (Object.keys(options.when).length > 0 && content === undefined) {
    throw new UsageError(
      '指定 --when 更新变体时要配合 --content（或 --stdin）传入正文；删除变体用 --remove-when',
    )
  }

  const hasFields =
    options.title !== undefined ||
    content !== undefined ||
    options.removeVariantWhens.length > 0 ||
    options.topics !== undefined ||
    options.sensitivity !== undefined ||
    options.priority !== undefined ||
    options.disclosure !== undefined ||
    options.glossaryAdd.length > 0 ||
    options.glossaryRemove.length > 0 ||
    options.validTo !== undefined

  if (!hasFields) {
    if (interactive) {
      const fromEditor = await editInTempEditor(env)
      if (fromEditor !== null) {
        if (!fromEditor.trim()) {
          out.write('已取消更新\n')
          return 0
        }
        content = fromEditor
      }
    }
  }

  const payload: Record<string, unknown> = {
    id: options.id,
    ...(options.circle ? { circle: options.circle } : {}),
    ...(options.expectedVersion !== undefined ? { expectedVersion: options.expectedVersion } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(Object.keys(options.when).length ? { when: options.when } : {}),
    ...(options.removeVariantWhens.length
      ? { removeVariantWhens: options.removeVariantWhens }
      : {}),
    ...(options.topics !== undefined ? { topics: options.topics } : {}),
    ...(options.sensitivity !== undefined ? { sensitivity: options.sensitivity } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
    ...(options.glossaryAdd.length ? { glossaryAdd: options.glossaryAdd } : {}),
    ...(options.glossaryRemove.length ? { glossaryRemove: options.glossaryRemove } : {}),
    ...(options.validTo !== undefined ? { validTo: options.validTo } : {}),
    ...(options.plaintextOk ? { plaintextOk: true } : {}),
  }

  if (
    payload.title === undefined &&
    payload.content === undefined &&
    payload.removeVariantWhens === undefined &&
    payload.topics === undefined &&
    payload.sensitivity === undefined &&
    payload.priority === undefined &&
    payload.disclosure === undefined &&
    payload.glossaryAdd === undefined &&
    payload.glossaryRemove === undefined &&
    payload.validTo === undefined
  ) {
    throw new UsageError('至少指定一项要修改的内容（如 --title、--content、--topic 等）')
  }

  const res = await submitWithPlaintextGuard({
    config,
    method: 'PATCH',
    path: '/v1/entries',
    payload,
    plaintextOk: options.plaintextOk,
    interactive,
    json: options.json,
    env,
    out,
    stdin,
    cancelLabel: '已取消更新',
  })
  if (res.cancelled) return res.exitCode

  const { status, data } = res
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  const updated = data as Partial<EntryViewData>
  if (options.json) {
    out.write(`${JSON.stringify(updated, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  const label = plain(updated.title ?? updated.shortId ?? options.id)
  const verNote = typeof updated.version === 'number' ? ` · v${updated.version}` : ''
  const idNote = updated.shortId ? `（${plain(updated.shortId)}${verNote}）` : ''
  out.write(`${theme.ok('✓')} 已更新记忆  ${label}${idNote}\n`)
  return 0
}

export const DELETE_USAGE = `用法：kioku delete <短ID或标题> [--circle <记忆圈>] [--expected-version <版本号>]
                    [--yes | -y] [--platform <平台>] [--json]
别称：kioku rm

软删除单条记忆（保留审计历史，可在管理界面回收站恢复）。

  <短ID或标题>            例如 m-234567、记忆标题或旧坐标
  --circle <记忆圈>       限定所在记忆圈
  --expected-version <号> 乐观锁版本号
  --yes, -y               免交互确认（非终端且未传 --json 时必需）
  --platform <平台>       指定使用哪个已配置客户端的身份
  --json                  以 JSON 格式输出删除结果
`

export function parseDeleteArgs(argv: string[]): {
  id: string
  circle?: string
  expectedVersion?: number
  yes: boolean
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let circle: string | undefined
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
    else if (!endOfFlags && arg === '--circle') {
      const val = argv[++i]
      if (!val) throw new UsageError('--circle 后面要写记忆圈标识')
      circle = val
    } else if (!endOfFlags && arg === '--expected-version') {
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
  return { id, circle, expectedVersion, yes, platform, json }
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

  const params = new URLSearchParams({ id: options.id })
  if (options.circle) params.set('circle', options.circle)
  if (options.expectedVersion !== undefined) {
    params.set('expectedVersion', String(options.expectedVersion))
  }

  const { status, data } = await memoryRequest(config, 'DELETE', `/v1/entries?${params.toString()}`)
  if (status !== 204 && status !== 200) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(
      `${JSON.stringify(
        {
          deleted: true,
          id: options.id,
          ...(options.circle ? { circle: options.circle } : {}),
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  const theme = createTheme({ stream: out, env })
  out.write(`${theme.ok('✓')} 已删除记忆  ${plain(options.id)}\n`)
  return 0
}

export const TRANSFER_USAGE = `用法：kioku transfer <短ID或标题> --to <目标记忆圈> [--from <源记忆圈>]
                      [--expected-version <版本号>] [--platform <平台>] [--json]

将一条记忆在两个都有读写权限的独立圈之间迁移（机密记忆及跨个人圈迁移仅限管理界面）。

  <短ID或标题>            例如 m-234567、记忆标题或旧坐标
  --to <目标记忆圈>       目标记忆圈 slug 或 UUID（必需）
  --from <源记忆圈>       源记忆圈 slug（重名标题消歧用）
  --expected-version <号> 乐观锁版本号
  --platform <平台>       指定使用哪个已配置客户端的身份
  --json                  以 JSON 格式输出迁移后的记忆
`

export function parseTransferArgs(argv: string[]): {
  id: string
  toCircle: string
  fromCircle?: string
  expectedVersion?: number
  platform?: string
  json: boolean
} {
  let id: string | undefined
  let toCircle: string | undefined
  let fromCircle: string | undefined
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
    else if (!endOfFlags && arg === '--to') {
      const val = argv[++i]
      if (!val) throw new UsageError('--to 后面要写目标记忆圈标识')
      toCircle = val
    } else if (!endOfFlags && arg === '--from') {
      const val = argv[++i]
      if (!val) throw new UsageError('--from 后面要写源记忆圈标识')
      fromCircle = val
    } else if (!endOfFlags && arg === '--expected-version') {
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
  if (!toCircle) throw new UsageError('要用 --to 指定目标记忆圈')
  return { id, toCircle, fromCircle, expectedVersion, platform, json }
}

export async function transferCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer & { isTTY?: boolean; columns?: number }; stdin?: Reader } = {},
): Promise<number> {
  const options = parseTransferArgs(argv)
  const { config } = await resolveIdentity({ platform: options.platform, env, stdin, out })

  const payload = {
    id: options.id,
    toCircle: options.toCircle,
    ...(options.fromCircle ? { fromCircle: options.fromCircle } : {}),
    ...(options.expectedVersion !== undefined ? { expectedVersion: options.expectedVersion } : {}),
  }

  const { status, data } = await memoryRequest(config, 'POST', '/v1/entries/transfer', payload)
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  const transferred = data as Partial<EntryViewData>
  if (options.json) {
    out.write(`${JSON.stringify(transferred, null, 2)}\n`)
    return 0
  }

  const theme = createTheme({ stream: out, env })
  const label = plain(transferred.title ?? transferred.shortId ?? options.id)
  const targetLabel = plain(transferred.circleSlug ?? options.toCircle)
  out.write(`${theme.ok('✓')} 已迁移记忆  ${label} → ${targetLabel}\n`)
  return 0
}

export const BOOT_USAGE = `用法：kioku boot [--platform <平台>] [--json]

预览会话启动时自动加载的独立人格特征与高优先级记忆。

  --platform <平台>  指定使用哪个已配置客户端的身份
  --json             以 JSON 格式输出启动加载内容
`

export function parseBootArgs(argv: string[]): {
  platform?: string
  json: boolean
} {
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
    } else {
      throw new UsageError(`多余的参数 ${arg}`)
    }
  }
  return { platform, json }
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

  const { status, data } = await memoryRequest(config, 'GET', '/v1/boot')
  if (status !== 200 || !data) throwForStatus(status, data, config.key)

  if (options.json) {
    out.write(`${JSON.stringify(data, null, 2)}\n`)
    return 0
  }

  const boot = data as Partial<BootResponseData>
  const personaTraits = Array.isArray(boot.personaTraits) ? boot.personaTraits : []
  const entries = Array.isArray(boot.entries) ? boot.entries : []
  const omitted = Array.isArray(boot.omitted) ? boot.omitted : []
  const theme = createTheme({ stream: out, env })
  const width = boxWidthFor(out)

  if (!personaTraits.length && !entries.length) {
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
  if (personaTraits.length) {
    const traitLines: string[] = []
    personaTraits.forEach((trait, idx) => {
      if (idx > 0) traitLines.push('')
      traitLines.push(`${theme.bold(plain(trait.title))}  ${theme.muted(plain(trait.traitKey))}`)
      traitLines.push(...wrapWidth(sanitizeBody(trait.content), width - 4))
    })
    sections.push({ title: `独立人格特征（${personaTraits.length}）`, lines: traitLines })
  }

  if (entries.length) {
    const entryLines: string[] = []
    entries.forEach((entry, idx) => {
      if (idx > 0) entryLines.push('')
      const circleNote = entry.circleSlug ? ` · ${plain(entry.circleSlug)}` : ''
      entryLines.push(
        `${theme.bold(plain(entry.title))}  ${theme.kind(entry.kind)}  ${theme.muted(`${plain(entry.shortId)}${circleNote}`)}`,
      )
      entryLines.push(...wrapWidth(sanitizeBody(entry.content), width - 4))
    })
    sections.push({ title: `启动记忆（${entries.length}）`, lines: entryLines })
  }

  if (omitted.length) {
    sections.push({
      title: `字数预算外（${omitted.length}）`,
      lines: [theme.muted(omitted.map((id) => plain(id)).join('、'))],
    })
  }

  const box = renderBox({
    title: '启动加载预览',
    width,
    theme,
    sections,
  })
  out.write(`${box}\n`)
  return 0
}
