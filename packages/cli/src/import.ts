// kioku import：把平台自带的本地长期记忆迁进 Kioku。先读本地文件出一份计划（每条的标题、切面与目标记忆圈），
// 和 Kioku 里已有的比过之后列出来，确认了才写。按标题去重（兼容旧 URI 兜底对照）：
// 已经有、内容一样的跳过；已经有、内容不一样的不覆盖（可能在 Kioku 里改过），要覆盖得明说。
// 本地的文件不删、不改

import { whoami } from './api.ts'
import {
  KiokuFailure,
  UsageError,
  fetchFailure,
  isRedirect,
  loadConfig,
  plain,
  redirectError,
  shownUrl,
} from './core.ts'
import { isInteractiveTty } from './identity.ts'
import { platformNames, PLATFORMS } from './platforms.ts'
import { isCancel, loadPrompts } from './prompts.ts'
import { sourceNames, type SourceEntry, SOURCES, UNSUPPORTED_SOURCES } from './sources.ts'
import type { Env, Reader, TargetConfig, Writer } from './types.ts'

export const IMPORT_USAGE = `用法：kioku import --from <来源> [--path <目录>] [--platform <平台>] [--circle <记忆圈>]
                [--dry-run] [-y|--yes] [--select] [--overwrite]

把平台自带的本地长期记忆迁进 Kioku：先列出每条将写入的标题与记忆圈，确认之后才写。

  --from <来源>      ${sourceNames()}
  --path <目录>      不用默认的位置时指明（Claude Code 是 projects 目录或某个项目的 memory 目录）
  --platform <平台>  用 kioku setup 给这个平台配好的地址与访问密钥（${platformNames()}）；不写时读环境变量
  --circle <记忆圈>  目标记忆圈 slug（默认写入当前访问密钥所属接入实例的主场记忆圈）
  --dry-run          只列出计划，不写
  -y, --yes          不问，直接写（不在终端里运行时要带上）
  --select           在交互式终端里逐条勾选本次要写入的记忆子集
  --overwrite        Kioku 里同名词条已经有、内容不一样的也覆盖（默认跳过）

本地的文件不删、不改。重复运行不会重复写：已经迁过、内容没变的会跳过。
疑似明文凭据的不写，列出是哪个文件的哪一行：先把值存成凭据，或者从文件里去掉再迁。
地址与访问密钥读 KIOKU_SERVER_URL 与 KIOKU_API_KEY（Claude Code 的会话里已经配好），或者用 --platform 指明。
记忆迁进目标记忆圈（默认为主场记忆圈）。
指令文件（AGENTS.md、CLAUDE.md）不是记忆，不迁。
`

const TIMEOUT = 15_000

export interface ImportOptions {
  from: string
  path?: string
  platform?: string
  circle?: string
  dryRun: boolean
  yes: boolean
  select: boolean
  overwrite: boolean
}

export interface UsableSourceEntry {
  source: string
  title: string
  legacyUri?: string
  when?: Record<string, string[]>
  topics?: string[]
  content: string
  disclosure?: string
}

export interface ComparedEntry extends UsableSourceEntry {
  state: 'new' | 'same' | 'differs' | 'failed'
  reason?: string
  version?: number
  shortId?: string
}

export interface ImportPlan {
  compared: ComparedEntry[]
  skipped: SourceEntry[]
  todo: ComparedEntry[]
  empty: boolean
}

export function parseImportArgs(argv: string[]): ImportOptions {
  const options: {
    from: string | undefined
    path: string | undefined
    platform: string | undefined
    circle: string | undefined
    dryRun: boolean
    yes: boolean
    select: boolean
    overwrite: boolean
  } = {
    from: undefined,
    path: undefined,
    platform: undefined,
    circle: undefined,
    dryRun: false,
    yes: false,
    select: false,
    overwrite: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--select') options.select = true
    else if (arg === '--overwrite') options.overwrite = true
    else if (arg === '--from' || arg === '--path' || arg === '--platform' || arg === '--circle') {
      const value = argv[++i]
      if (!value) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--from') options.from = value
      else if (arg === '--path') options.path = value
      else if (arg === '--circle') options.circle = value
      else options.platform = value
    } else throw new UsageError(`不认识的参数 ${arg}`)
  }
  if (!options.from) throw new UsageError('要写来源：--from <来源>')
  if (Object.hasOwn(UNSUPPORTED_SOURCES, options.from)) {
    throw new KiokuFailure(UNSUPPORTED_SOURCES[options.from])
  }
  if (!Object.hasOwn(SOURCES, options.from)) {
    throw new UsageError(`不认识的来源 ${options.from}，可以用的：${sourceNames()}`)
  }
  if (options.platform !== undefined && !PLATFORMS[options.platform]?.readConfig) {
    throw new UsageError(
      `--platform 只收用 kioku setup 写下配置的平台，可以用的：${platformNames()}`,
    )
  }
  return options as ImportOptions
}

function whenSignature(raw?: Record<string, readonly string[]> | null): string {
  if (!raw) return '{}'
  const out: Record<string, string[]> = {}
  for (const rawKey of Object.keys(raw).sort()) {
    const key = rawKey.trim().toLowerCase()
    if (!key) continue
    const unique = [
      ...new Set((raw[rawKey] ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean)),
    ].sort()
    if (unique.length) out[key] = unique
  }
  return JSON.stringify(out)
}

function formatWhenTag(when?: Record<string, string[]>): string {
  if (!when) return ''
  const parts = Object.keys(when)
    .filter((k) => when[k]?.length)
    .sort()
    .map((k) => `${k}=${when[k].join(',')}`)
  return parts.length ? ` [${parts.join(' ')}]` : ''
}

async function request(
  { url, key }: TargetConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response
  let data: Record<string, unknown> | null
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // 不跟着跳转走：访问密钥只发给配置的地址
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  return { status: res.status, data }
}

// 服务端的错误文字压成一行；万一带着访问密钥也盖掉
function serverText(data: Record<string, unknown> | null, status: number, key: string): string {
  const text = typeof data?.error === 'string' ? data.error.split(key).join('***') : ''
  return plain(text) || `HTTP ${status}`
}

async function fetchEntry(
  config: TargetConfig,
  ref: string,
  circleSlug: string,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const params = new URLSearchParams({
    id: ref,
    circle: circleSlug,
    allVariants: 'true',
  })
  return request(config, 'GET', `/v1/entries?${params.toString()}`)
}

// 和 Kioku 里现有的比：new 没有，same 有且对应切面正文一样，differs 有但不一样（含读不到正文的机密）
async function compare(
  config: TargetConfig,
  circleSlug: string,
  item: UsableSourceEntry,
): Promise<ComparedEntry> {
  let { status, data } = await fetchEntry(config, item.title, circleSlug)
  if (status === 404 && item.legacyUri) {
    const legacy = await fetchEntry(config, item.legacyUri, circleSlug)
    status = legacy.status
    data = legacy.data
  }
  if (status === 404) return { ...item, state: 'new' }
  if (status !== 200) {
    return { ...item, state: 'failed', reason: serverText(data, status, config.key) }
  }
  const sig = whenSignature(item.when)
  const variants = Array.isArray(data?.variants)
    ? (data.variants as Array<{ whenSignature?: unknown; content?: unknown }>)
    : []
  const matched =
    variants.find((v) => v?.whenSignature === sig) ??
    (variants.length === 1 && variants[0]?.whenSignature === '{}' ? variants[0] : undefined)
  const same = typeof matched?.content === 'string' && matched.content.trim() === item.content
  return {
    ...item,
    state: same ? 'same' : 'differs',
    version: typeof data?.version === 'number' ? data.version : undefined,
    shortId: typeof data?.shortId === 'string' ? data.shortId : undefined,
  }
}

interface PlaintextSpot {
  line?: unknown
  kind?: unknown
}

// 写一条：新建，或者覆盖已有的。返回 { ok } 或 { ok: false, reason, plaintext }
async function write(
  config: TargetConfig,
  circleSlug: string,
  item: ComparedEntry,
): Promise<{ ok: true } | { ok: false; reason: string; plaintext: PlaintextSpot[] | null }> {
  const hasWhen = Boolean(item.when && Object.keys(item.when).length > 0)
  const commonFields = {
    circle: circleSlug,
    title: item.title,
    content: item.content,
    ...(hasWhen ? { when: item.when } : {}),
    ...(item.topics?.length ? { topics: item.topics } : {}),
    ...(item.disclosure ? { disclosure: item.disclosure } : {}),
  }
  const { status, data } =
    item.state === 'differs'
      ? await request(config, 'PATCH', '/v1/entries', {
          id: item.shortId ?? item.title,
          ...commonFields,
          ...(Number.isInteger(item.version) ? { expectedVersion: item.version } : {}),
        })
      : await request(config, 'POST', '/v1/entries', commonFields)
  if (status === 200 || status === 201) return { ok: true }
  const plaintext = Array.isArray(data?.plaintext) ? (data.plaintext as PlaintextSpot[]) : null
  return { ok: false, reason: serverText(data, status, config.key), plaintext }
}

const KINDS: Record<'new' | 'same' | 'differs', string> = {
  new: '新建',
  same: '已有，内容一样',
  differs: '已有，内容不一样',
}

// 问一句是或否；只认 y 开头的回答
export async function confirm(
  question: string,
  { stdin, out }: { stdin: AsyncIterable<Buffer | string>; out: Writer },
): Promise<boolean> {
  out.write(question)
  for await (const chunk of stdin) {
    return /^\s*y/i.test(chunk.toString('utf8'))
  }
  return false
}

// 本地的这个来源里有几条能迁的记忆（不和 Kioku 比）。来源的目录不在时为 null
export async function countLocal(
  from: string,
  { env, path }: { env: Env; path?: string },
): Promise<number | null> {
  const { found, entries } = await SOURCES[from].read({ env, path, client: 'client' })
  return found ? entries.filter((item) => !item.skipped).length : null
}

// 按顺序对每一项做 fn，同时最多 limit 个；结果的顺序和 items 一样
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// 和 Kioku 里比时同时发的请求数
const COMPARE_CONCURRENCY = 8

// 计划里还没迁进 Kioku 的条数（Kioku 里同名词条还没有的）。有比对失败的（不是 200、404）时
// 说不准，pending 为 null，reason 写明几条读取失败
export function pendingOf(plan: Pick<ImportPlan, 'compared'>): {
  pending: number | null
  reason?: string
} {
  const failed = plan.compared.filter((item) => item.state === 'failed').length
  if (failed) return { pending: null, reason: `${failed} 条读取失败` }
  return { pending: plan.compared.filter((item) => item.state === 'new').length }
}

// 读本地的记忆、和 Kioku 里的比过，列出计划：每条的标题、切面与目标记忆圈。
// 返回 { compared, skipped, todo }；没有可以迁的时 todo 是空的、empty 为真
export async function planImport(
  config: TargetConfig,
  {
    from,
    path,
    circle,
    overwrite = false,
  }: { from: string; path?: string; circle?: string; overwrite?: boolean },
  { env, out }: { env: Env; out: Writer },
): Promise<ImportPlan> {
  const source = SOURCES[from]
  const who = await whoami(config)
  const targetCircle = circle ?? who.primaryCircle.slug
  out.write(
    `Kioku：${shownUrl(config.url)}，接入实例 ${plain(who.client.name)}（${plain(who.client.slug)}），记忆圈 ${plain(targetCircle)}\n`,
  )

  const { root, found, entries } = await source.read({ env, path, client: who.client.slug })
  if (!found) {
    throw new KiokuFailure(`没有找到${source.name}：${plain(root)} 不是目录，用 --path 指明位置`)
  }
  out.write(`来源：${source.name}（${plain(root)}）\n`)
  if (!entries.length) {
    out.write('没有可以迁的记忆\n')
    return { compared: [], skipped: [], todo: [], empty: true }
  }

  // 两条标题一样的只留第一条，避免与服务端同名冲突
  const seen = new Set<string>()
  const usable: UsableSourceEntry[] = []
  const skipped: SourceEntry[] = []
  for (const item of entries) {
    if (item.skipped) skipped.push(item)
    else if (seen.has(item.title!)) {
      skipped.push({ ...item, skipped: `和前面的一条重名 ${item.title}` })
    } else {
      seen.add(item.title!)
      usable.push(item as UsableSourceEntry)
    }
  }
  // 一条一个请求：有界并发，几百条也不至于等太久
  const compared = await mapLimit(usable, COMPARE_CONCURRENCY, (item) =>
    compare(config, targetCircle, item),
  )

  out.write('\n')
  for (const item of compared) {
    const kind = item.state === 'failed' ? `读取失败（${item.reason}）` : KINDS[item.state]
    const idNote = item.shortId ? `（${plain(item.shortId)}）` : ''
    out.write(
      `${kind}  ${plain(item.title)}${idNote}${formatWhenTag(item.when)}\n    ← ${plain(item.source)}\n`,
    )
  }
  for (const item of skipped) out.write(`不迁  ${plain(item.source)}\n    ${item.skipped}\n`)

  const count = (state: ComparedEntry['state']) =>
    compared.filter((item) => item.state === state).length
  const todo = compared.filter(
    (item) => item.state === 'new' || (item.state === 'differs' && overwrite),
  )
  out.write(
    `\n新建 ${count('new')} 条，已有且一样 ${count('same')} 条，已有但不一样 ${count('differs')} 条` +
      `（${overwrite ? '覆盖' : '跳过，要覆盖加 --overwrite'}），不迁 ${skipped.length} 条\n`,
  )
  return { compared, skipped, todo, empty: false }
}

// 按计划写入，返回退出码：有没写成的、读取失败的为 1
export async function writeImport(
  config: TargetConfig,
  { compared, todo, circle }: Pick<ImportPlan, 'compared' | 'todo'> & { circle?: string },
  { out }: { out: Writer },
): Promise<number> {
  const targetCircle = circle ?? (await whoami(config)).primaryCircle.slug
  let written = 0
  const failed: Array<{ item: ComparedEntry; reason: string; plaintext: PlaintextSpot[] | null }> =
    []
  // 连不上、超时这类不是某一条的问题：停下来，把已经写了多少、还剩多少说清楚，不让它跳出整个命令
  let stopped: { reason: string; left: number } | null = null
  for (const [index, item] of todo.entries()) {
    let result: Awaited<ReturnType<typeof write>>
    try {
      result = await write(config, targetCircle, item)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      stopped = { reason: err.message, left: todo.length - index }
      break
    }
    if (result.ok) written++
    else failed.push({ item, ...result })
  }
  out.write(`\n写入 ${written} 条\n`)
  for (const { item, reason, plaintext } of failed) {
    out.write(`没有写入  ${plain(item.title)}\n    ← ${plain(item.source)}\n    ${reason}\n`)
    // 只说第几行、哪一类，不带值；行号按正文算（文件头之后）
    for (const spot of plaintext ?? []) {
      out.write(`    正文第 ${Number(spot.line) || '?'} 行：${plain(spot.kind)}\n`)
    }
  }
  if (failed.some((entry) => entry.plaintext)) {
    out.write('疑似明文凭据的没有写：把值存成凭据、正文里写占位符，或者从文件里去掉，再运行一次\n')
  }
  if (stopped) {
    out.write(
      `${stopped.reason}：还有 ${stopped.left} 条没有写，重新运行会接着写（已经写进去的会跳过）\n`,
    )
  }
  out.write('本地的文件没有动。\n')
  return stopped || failed.length || compared.some((item) => item.state === 'failed') ? 1 : 0
}

export async function importMemories(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    stdin = process.stdin,
  }: { env?: Env; out?: Writer; stdin?: Reader } = {},
): Promise<number> {
  const options = parseImportArgs(argv)
  // 地址与访问密钥：指明了平台就用 kioku setup 给它写下的，否则读环境变量
  let config: TargetConfig | null
  if (options.platform) {
    config = (await PLATFORMS[options.platform].readConfig?.(env)) ?? null
    if (!config) {
      throw new KiokuFailure(
        `还没有给 ${options.platform} 配过：先运行 kioku setup ${options.platform}`,
      )
    }
  } else config = await loadConfig(env)
  const plan = await planImport(config, options, { env, out })
  if (plan.empty) return 0
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!plan.todo.length) {
    out.write('没有要写的\n')
    return plan.compared.some((item) => item.state === 'failed') ? 1 : 0
  }
  let selectedTodo = plan.todo
  if (!options.yes) {
    if (options.select) {
      if (!isInteractiveTty(stdin, out as Writer & { isTTY?: boolean })) {
        throw new KiokuFailure('--select 需要在交互式终端中运行')
      }
      const ui = await loadPrompts({ input: stdin, output: out })
      if (!ui) throw new KiokuFailure('--select 需要 Node.js 20.12 以上版本')
      const picked = await ui.multiselect({
        message: '选择本次要写入的记忆',
        options: plan.todo.map((item, idx) => ({
          value: idx,
          label: plain(item.title),
          hint: `${item.topics?.join(',') ?? ''}${formatWhenTag(item.when)}`.trim(),
        })),
        initialValues: plan.todo.map((_, idx) => idx),
      })
      if (isCancel(picked) || !Array.isArray(picked) || !picked.length) {
        out.write('没有写入\n')
        return 0
      }
      const chosenSet = new Set(picked)
      selectedTodo = plan.todo.filter((_, idx) => chosenSet.has(idx))
    } else {
      if (!stdin.isTTY) {
        throw new KiokuFailure('不在终端里运行时要带 --yes 才写；先用 --dry-run 看计划')
      }
      if (!(await confirm(`写入这 ${plan.todo.length} 条？[y/N] `, { stdin, out }))) {
        out.write('没有写入\n')
        return 0
      }
    }
  }
  return writeImport(
    config,
    {
      compared: plan.compared,
      todo: selectedTodo,
      ...(options.circle ? { circle: options.circle } : {}),
    },
    { out },
  )
}
