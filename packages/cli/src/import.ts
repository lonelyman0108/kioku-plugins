// kioku import：把客户端自带的本地长期记忆迁进 Kioku。先读本地文件出一份计划（每条的标题与场景标签），
// 和 Kioku 里已有的比过之后列出来，确认了才写。按标题去重：
// 已经有、内容一样的跳过；已经有、内容不一样的不覆盖（可能在 Kioku 里改过），要覆盖得明说。
// 本地的文件不删、不改

import { createHash } from 'node:crypto'

import { whoami } from './api.ts'
import { callMemoryTool, type EntryDetailData } from './commands/memory.ts'
import { KiokuFailure, UsageError, plain, shownUrl } from './core.ts'
import { isInteractiveTty, resolveIdentity } from './identity.ts'
import { platformNames, PLATFORMS } from './platforms.ts'
import { isCancel, loadPrompts } from './prompts.ts'
import {
  sourceNames,
  type SourceEntry,
  SOURCES,
  titleWithSuffix,
  UNSUPPORTED_SOURCES,
} from './sources.ts'
import type { Env, Reader, TargetConfig, WhoamiResponse, Writer } from './types.ts'

export const IMPORT_USAGE = `用法：kioku import --from <来源> [--path <目录>] [--platform <平台>]
                [--dry-run] [-y|--yes] [--select] [--overwrite]

把客户端自带的本地长期记忆迁进 Kioku：先列出每条将写入的标题与场景标签，确认之后才写。

  --from <来源>      ${sourceNames()}
  --path <目录>      不用默认的位置时指明（Claude Code 是 projects 目录或某个项目的 memory 目录）
  --platform <平台>  使用已配置客户端的地址与访问密钥（${platformNames()}）；省略时自动解析身份或环境变量
  --dry-run          只列出计划，不写
  -y, --yes          不问，直接写（不在终端里运行时要带上）
  --select           在交互式终端里逐条勾选本次要写入的记忆子集
  --overwrite        Kioku 里同名记忆已经有、内容不一样的也覆盖（默认跳过）

本地的文件不删、不改。重复运行不会重复写：已经迁过、内容没变的会跳过。
未指定 --platform 时按环境变量 KIOKU_SERVER_URL/KIOKU_API_KEY 或本机已配置的默认客户端身份解析。
指令文件（AGENTS.md、CLAUDE.md）不是记忆，不迁。
`

export interface ImportOptions {
  from: string
  path?: string
  platform?: string
  dryRun: boolean
  yes: boolean
  select: boolean
  overwrite: boolean
}

export interface UsableSourceEntry {
  source: string
  title: string
  baseTitle?: string
  projects?: string[]
  runtimes?: string[]
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
    dryRun: boolean
    yes: boolean
    select: boolean
    overwrite: boolean
  } = {
    from: undefined,
    path: undefined,
    platform: undefined,
    dryRun: false,
    yes: false,
    select: false,
    overwrite: false,
  }
  let endOfFlags = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && arg === '--dry-run') options.dryRun = true
    else if (!endOfFlags && (arg === '--yes' || arg === '-y')) options.yes = true
    else if (!endOfFlags && arg === '--select') options.select = true
    else if (!endOfFlags && arg === '--overwrite') options.overwrite = true
    else if (!endOfFlags && (arg === '--from' || arg === '--path' || arg === '--platform')) {
      const value = argv[++i]
      if (!value) throw new UsageError(`${arg} 后面要写值`)
      if (arg === '--from') options.from = value
      else if (arg === '--path') options.path = value
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
    throw new UsageError(`--platform 只收本机保存了配置的客户端，可以用的：${platformNames()}`)
  }
  return options as ImportOptions
}

function formatSceneTag(item: Pick<UsableSourceEntry, 'projects' | 'runtimes'>): string {
  const parts: string[] = []
  if (item.projects?.length) parts.push(`project=${item.projects.join(',')}`)
  if (item.runtimes?.length) parts.push(`runtime=${item.runtimes.join(',')}`)
  return parts.length ? ` [${parts.join(' ')}]` : ''
}

function sourceHash6(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 6)
}

function isNotFound(res: {
  isError: boolean
  errorStatus?: number
  errorMessage?: string
}): boolean {
  if (!res.isError) return false
  if (res.errorStatus === 404) return true
  return res.errorStatus === undefined && Boolean(res.errorMessage?.includes('不存在'))
}

function isDisjointProject(detail: EntryDetailData | null, item: UsableSourceEntry): boolean {
  const itemProjects = item.projects
  const existingProjects = detail?.entry?.projects
  if (!itemProjects?.length || !Array.isArray(existingProjects) || !existingProjects.length) {
    return false
  }
  return !itemProjects.some((p) => existingProjects.includes(p))
}

function hasSameProjects(detail: EntryDetailData | null, item: UsableSourceEntry): boolean {
  const itemProjects = item.projects ?? []
  const existingProjects = detail?.entry?.projects ?? []
  if (!itemProjects.length) return existingProjects.length === 0
  return itemProjects.some((p) => existingProjects.includes(p))
}

function validateImportTarget(who: WhoamiResponse): void {
  if (!who.key.canWrite) {
    throw new KiokuFailure('当前访问密钥为只读，无法写入记忆')
  }
}

// 和 Kioku 里现有的比：按标题精确查找（跨项目重名自动转项目后缀，避免顶掉其他项目记忆）；
// new 没有，same 有且正文一样，differs 有但正文不一样
async function compare(config: TargetConfig, item: UsableSourceEntry): Promise<ComparedEntry> {
  let effectiveTitle = item.title
  let res = await callMemoryTool<EntryDetailData>(config, 'kioku_get', { id: effectiveTitle })

  const proj = item.projects?.[0]
  if (
    proj &&
    !effectiveTitle.endsWith(`（${proj}）`) &&
    ((res.isError && res.errorStatus === 409) ||
      (!res.isError && isDisjointProject(res.structured, item)))
  ) {
    const projTitle = titleWithSuffix(effectiveTitle, `（${proj}）`)
    if (projTitle !== effectiveTitle) {
      effectiveTitle = projTitle
      res = await callMemoryTool<EntryDetailData>(config, 'kioku_get', { id: effectiveTitle })
    }
  } else if (res.isError && res.errorStatus === 409) {
    const disambiguated = titleWithSuffix(effectiveTitle, `（${sourceHash6(item.source)}）`)
    if (disambiguated !== effectiveTitle) {
      effectiveTitle = disambiguated
      res = await callMemoryTool<EntryDetailData>(config, 'kioku_get', { id: effectiveTitle })
    }
  } else if (isNotFound(res) && item.baseTitle && item.baseTitle !== effectiveTitle) {
    const baseRes = await callMemoryTool<EntryDetailData>(config, 'kioku_get', {
      id: item.baseTitle,
    })
    if (!baseRes.isError && hasSameProjects(baseRes.structured, item)) {
      effectiveTitle = item.baseTitle
      res = baseRes
    }
  } else if (
    isNotFound(res) &&
    !item.baseTitle &&
    proj &&
    !effectiveTitle.endsWith(`（${proj}）`)
  ) {
    const suffixedTitle = titleWithSuffix(effectiveTitle, `（${proj}）`)
    if (suffixedTitle !== effectiveTitle) {
      const suffixedRes = await callMemoryTool<EntryDetailData>(config, 'kioku_get', {
        id: suffixedTitle,
      })
      if (!suffixedRes.isError && hasSameProjects(suffixedRes.structured, item)) {
        effectiveTitle = suffixedTitle
        res = suffixedRes
      }
    }
  }

  if (isNotFound(res)) return { ...item, title: effectiveTitle, state: 'new' }
  if (res.isError) {
    return {
      ...item,
      title: effectiveTitle,
      state: 'failed',
      reason: res.errorMessage || (res.errorStatus ? `HTTP ${res.errorStatus}` : '读取失败'),
    }
  }
  const existing = res.structured?.entry
  const same = typeof existing?.content === 'string' && existing.content.trim() === item.content
  return {
    ...item,
    title: effectiveTitle,
    state: same ? 'same' : 'differs',
    version: typeof existing?.version === 'number' ? existing.version : undefined,
    shortId: typeof existing?.shortId === 'string' ? existing.shortId : undefined,
  }
}

// 写一条：新建，或者覆盖已有的。返回 { ok } 或 { ok: false, reason }
async function write(
  config: TargetConfig,
  item: ComparedEntry,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const commonArgs: Record<string, unknown> = {
    title: item.title,
    content: item.content,
    ...(item.projects?.length ? { projects: item.projects } : {}),
    ...(item.runtimes?.length ? { runtimes: item.runtimes } : {}),
    ...(item.topics?.length ? { topics: item.topics } : {}),
    ...(item.disclosure ? { disclosure: item.disclosure } : {}),
  }

  let res =
    item.state === 'differs'
      ? await callMemoryTool<EntryDetailData>(config, 'kioku_update', {
          id: item.shortId ?? item.title,
          ...commonArgs,
          ...(Number.isInteger(item.version) ? { expected_version: item.version } : {}),
        })
      : await callMemoryTool<EntryDetailData>(config, 'kioku_create', commonArgs)

  if (item.state === 'new' && res.isError && res.errorStatus === 409 && !item.projects?.length) {
    const disambiguated = titleWithSuffix(item.title, `（${sourceHash6(item.source)}）`)
    if (disambiguated !== item.title) {
      res = await callMemoryTool<EntryDetailData>(config, 'kioku_create', {
        ...commonArgs,
        title: disambiguated,
      })
    }
  }
  if (!res.isError) return { ok: true }
  return {
    ok: false,
    reason: res.errorMessage || (res.errorStatus ? `HTTP ${res.errorStatus}` : '写入失败'),
  }
}

const KINDS: Record<'new' | 'same' | 'differs', string> = {
  new: '新建',
  same: '已有，内容一样',
  differs: '已有，内容不一样',
}

// 问一句是或否；只认 y 开头的回答，不因提前退出关闭 stdin 迭代器
export async function confirm(
  question: string,
  { stdin, out }: { stdin: Reader; out: Writer },
): Promise<boolean> {
  out.write(question)
  if (typeof stdin.on === 'function') {
    return new Promise((resolve) => {
      let line = ''
      let settled = false
      const cleanup = () => {
        if (settled) return
        settled = true
        stdin.off?.('data', onData)
        stdin.off?.('end', onEnd)
        stdin.off?.('error', onError)
        stdin.removeListener?.('data', onData)
        stdin.removeListener?.('end', onEnd)
        stdin.removeListener?.('error', onError)
        stdin.pause?.()
      }
      const finish = (answer: string) => {
        cleanup()
        resolve(/^\s*y/i.test(answer))
      }
      const onData = (chunk: unknown) => {
        line +=
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
        if (/[\r\n]/.test(line)) finish(line)
      }
      const onEnd = () => finish(line)
      const onError = () => finish('')
      stdin.resume?.()
      stdin.on?.('data', onData)
      stdin.on?.('end', onEnd)
      stdin.on?.('error', onError)
    })
  }
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
  const { found, entries } = await SOURCES[from].read({ env, path })
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

// 计划里尚未迁进 Kioku 的条数。有比对失败的时说不准，pending 为 null，reason 写明几条读取失败
export function pendingOf(plan: Pick<ImportPlan, 'compared'>): {
  pending: number | null
  reason?: string
} {
  const failed = plan.compared.filter((item) => item.state === 'failed').length
  if (failed) return { pending: null, reason: `${failed} 条读取失败` }
  return { pending: plan.compared.filter((item) => item.state === 'new').length }
}

// 读本地的记忆、和 Kioku 里的比过，列出计划：每条的标题与场景标签。
// 返回 { compared, skipped, todo }；没有可以迁的时 todo 是空的、empty 为真
export async function planImport(
  config: TargetConfig,
  { from, path, overwrite = false }: { from: string; path?: string; overwrite?: boolean },
  { env, out }: { env: Env; out: Writer },
): Promise<ImportPlan> {
  const source = SOURCES[from]
  const who = await whoami(config)
  validateImportTarget(who)
  out.write(
    `Kioku：${shownUrl(config.url)}，账号 ${plain(who.accountName)}，访问密钥 ${plain(who.key.name)}（${plain(who.key.prefix)}）\n`,
  )

  const { root, found, entries } = await source.read({ env, path })
  if (!found) {
    throw new KiokuFailure(`未找到${source.name}：${plain(root)} 不是目录，用 --path 指明位置`)
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
  const compared = await mapLimit(usable, COMPARE_CONCURRENCY, (item) => compare(config, item))

  out.write('\n')
  for (const item of compared) {
    const kind = item.state === 'failed' ? `读取失败（${item.reason}）` : KINDS[item.state]
    const idNote = item.shortId ? `（${plain(item.shortId)}）` : ''
    out.write(
      `${kind}  ${plain(item.title)}${idNote}${formatSceneTag(item)}\n    ← ${plain(item.source)}\n`,
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
  { compared, todo }: Pick<ImportPlan, 'compared' | 'todo'>,
  { out }: { out: Writer },
): Promise<number> {
  let written = 0
  const failed: Array<{ item: ComparedEntry; reason: string }> = []
  // 连不上、超时这类不是某一条的问题：停下来，把已经写了多少、还剩多少说清楚，不让它跳出整个命令
  let stopped: { reason: string; left: number } | null = null
  for (const [index, item] of todo.entries()) {
    let result: Awaited<ReturnType<typeof write>>
    try {
      result = await write(config, item)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      stopped = { reason: err.message, left: todo.length - index }
      break
    }
    if (result.ok) written++
    else failed.push({ item, ...result })
  }
  out.write(`\n写入 ${written} 条\n`)
  for (const { item, reason } of failed) {
    out.write(`没有写入  ${plain(item.title)}\n    ← ${plain(item.source)}\n    ${reason}\n`)
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
  const { config } = await resolveIdentity({
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    env,
    stdin,
    out,
  })
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
      const ui = await loadPrompts({ input: stdin, output: out, env })
      if (!ui) throw new KiokuFailure('--select 需要 Node.js 20.12 以上版本')
      const picked = await ui.multiselect({
        message: '选择本次要写入的记忆',
        options: plan.todo.map((item, idx) => ({
          value: idx,
          label: plain(item.title),
          hint: `${item.topics?.join(',') ?? ''}${formatSceneTag(item)}`.trim(),
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
    },
    { out },
  )
}
