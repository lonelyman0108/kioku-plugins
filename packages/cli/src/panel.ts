// 向导的面板：扫描服务器与本机各平台的现状，排成几行文字，再按缺什么列出可做的动作。
// 只读：不写文件、不签发访问密钥。查不了的项写「无法判断」，不猜

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  generationProblem,
  KeyRejected,
  probeServer,
  SUPPORTED_API,
  upgradePageOf,
  whoami,
} from './api.ts'
import { conflictToolsText, scanConflicts, type ConflictItem } from './conflicts.ts'
import {
  KiokuFailure,
  envValue,
  failureText,
  fetchFailure,
  findCommand,
  hasCommand,
  isRedirect,
  plain,
  serverUrlProblem,
  shownUrl,
} from './core.ts'
import { geminiHome } from './gemini.ts'
import { readCliPreferences } from './identity.ts'
import { countLocal } from './import.ts'
import { detectLegacyPlugin, type LegacyPluginFindings } from './legacy.ts'
import { PLATFORMS } from './platforms.ts'
import type {
  Env,
  PlatformInstallKind,
  PlatformPresence,
  TargetConfig,
  WhoamiResponse,
} from './types.ts'

const TIMEOUT = 5000

async function getJson(
  url: string,
  path: string,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response
  let data: Record<string, unknown> | null
  try {
    res = await fetch(`${url}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) })
    data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) throw new KiokuFailure(`返回了跳转（${res.status}）`)
  return { status: res.status, data }
}

export interface ServerHealthState {
  reachable: boolean
  version?: string | null
  problem: string | null
  needsSetup?: boolean
  checking?: boolean
  // 接口代际；连不上时没有
  generation?: number | null
  // 代际不对（older / newer）或库待迁移（legacy）：这时 problem 写着下一步
  mismatch?: 'older' | 'newer' | 'legacy'
}

export interface PanelServer extends ServerHealthState {
  url: string
}

export interface PlatformRow {
  id: string
  name: string
  present: boolean
  presence?: PlatformPresence
  installKind?: PlatformInstallKind
  hasCli?: boolean
  connection: 'ok' | 'none' | 'invalid' | 'unknown' | 'broken' | 'manual'
  // connection 为 invalid 时：访问密钥是升级前签发的
  legacyKey?: boolean
  legacyPlugin?: LegacyPluginFindings
  url?: string
  otherServer?: boolean
  who?: WhoamiResponse
  reason?: string
  checking?: boolean
  plugin: boolean | null
  memory: 'on' | 'off' | 'none' | null
  reenabledIn?: string
  local?: number | null
  pending?: { pending: number | null; reason?: string }
  conflicts?: ConflictItem[]
}

export function effectivePresence(
  row: Pick<PlatformRow, 'present' | 'presence'>,
): PlatformPresence {
  return row.presence ?? (row.present ? 'installed' : 'absent')
}

export interface PanelState {
  server: PanelServer | null
  platforms: PlatformRow[]
}

// 服务器的现状：{ reachable, version, problem, needsSetup, generation, mismatch }。不要访问密钥。
// 代际不对、库待迁移时 problem 写着下一步，不报成「HTTP 503」
export async function serverHealth(url: string): Promise<ServerHealthState> {
  const probe = await probeServer(url)
  if (probe.state === 'unreachable') {
    return { reachable: false, problem: probe.problem ?? '无法连接' }
  }
  const { version, generation } = probe
  const problem = generationProblem(probe, url)
  if (problem) {
    const mismatch =
      generation !== null && generation < SUPPORTED_API
        ? 'older'
        : generation !== null && generation > SUPPORTED_API
          ? 'newer'
          : 'legacy'
    return { reachable: true, version, generation, problem, mismatch }
  }
  if (probe.state === 'unavailable') {
    return { reachable: true, version, generation, problem: '数据库暂时无法连接' }
  }
  let needsSetup = false
  try {
    const setup = await getJson(url, '/v1/setup/status')
    needsSetup = setup.status === 200 && setup.data?.needsSetup === true
  } catch {
    // 查不到按已初始化算
  }
  return { reachable: true, version, generation, problem: null, needsSetup }
}

async function isDir(path: string): Promise<boolean> {
  return Boolean((await stat(path).catch(() => null))?.isDirectory())
}

function userHomeOf(env: Env): string {
  return env.HOME || env.USERPROFILE || homedir()
}

function localAppDataOf(env: Env): string {
  const home = userHomeOf(env)
  if (env.LOCALAPPDATA && (!env.USERPROFILE || !env.HOME || env.HOME === env.USERPROFILE)) {
    return env.LOCALAPPDATA
  }
  return join(home, 'AppData', 'Local')
}

// Antigravity 会把数据写进 ~/.gemini/antigravity 与 ~/.gemini/config；裸目录不能算 Gemini CLI
const GEMINI_AGY_ONLY_ENTRIES = new Set([
  'antigravity',
  'antigravity-ide',
  'antigravity-cli',
  'config',
])

const IDE_EXTENSION_RE: Record<string, RegExp> = {
  'claude-code': /^anthropic\.claude-code-/i,
  codex: /^openai\.(?:chatgpt|codex)-/i,
}

export function resolvePlatformCommand(
  id: string,
  env: Env,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): string | null {
  const desc = PLATFORMS[id]
  if (!desc) return null
  const cmd = desc.command(env)
  if (!cmd) return null
  if (hasCommand(cmd, env, { platform })) return cmd
  if (/[\\/]/.test(cmd) || !(envValue(env, 'PATH') ?? '').trim()) return null

  const home = userHomeOf(env)
  const candidates = [join(home, '.local', 'bin', cmd)]
  if (platform === 'win32' && id === 'claude-code') {
    candidates.push(join(localAppDataOf(env), 'Programs', 'claude', 'claude.exe'))
  }
  for (const candidate of candidates) {
    if (platform === 'win32') {
      const resolved = findCommand(candidate, env)
      if (resolved) return resolved
    } else if (hasCommand(candidate, env, { platform })) {
      return candidate
    }
  }
  return null
}

async function detectAppOrIde(id: string, env: Env): Promise<PlatformInstallKind | null> {
  if (id === 'agy') {
    const home = userHomeOf(env)
    for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      if (await isDir(join(home, '.gemini', sub))) return 'desktop'
    }
    return null
  }
  const pattern = IDE_EXTENSION_RE[id]
  if (!pattern) return null
  const home = userHomeOf(env)
  for (const editorDir of ['.vscode', '.cursor', '.windsurf']) {
    const entries = await readdir(join(home, editorDir, 'extensions')).catch(() => [] as string[])
    if (entries.some((name) => pattern.test(name))) return 'ide'
  }
  return null
}

async function hasPlatformConfigDir(id: string, env: Env): Promise<boolean> {
  if (id === 'gemini') {
    const entries = await readdir(geminiHome(env)).catch(() => null)
    if (!entries || entries.length === 0) return false
    return entries.some((name) => !GEMINI_AGY_ONLY_ENTRIES.has(name.toLowerCase()))
  }
  return isDir(PLATFORMS[id].home(env))
}

export async function detectPlatformPresence(
  id: string,
  env: Env,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): Promise<{
  presence: PlatformPresence
  installKind?: PlatformInstallKind
  hasCli: boolean
  resolvedCmd: string | null
}> {
  const desc = PLATFORMS[id]
  if (!desc) return { presence: 'absent', hasCli: false, resolvedCmd: null }

  const resolvedCmd = resolvePlatformCommand(id, env, { platform })
  const hasCli = resolvedCmd !== null
  if (hasCli || desc.detect(env)) {
    return { presence: 'installed', installKind: 'cli', hasCli, resolvedCmd }
  }

  const appKind = await detectAppOrIde(id, env)
  if (appKind) {
    return { presence: 'installed', installKind: appKind, hasCli: false, resolvedCmd: null }
  }

  if (await hasPlatformConfigDir(id, env)) {
    return { presence: 'config-only', hasCli: false, resolvedCmd: null }
  }
  return { presence: 'absent', hasCli: false, resolvedCmd: null }
}

// 各平台写下的服务地址（按平台的顺序，同一个只留一次）
export async function knownServers(env: Env): Promise<string[]> {
  const urls: string[] = []
  for (const platform of Object.values(PLATFORMS)) {
    const config = await Promise.resolve(platform.readConfig?.(env)).catch(() => null)
    if (config?.url && !urls.includes(config.url)) urls.push(config.url)
  }
  return urls
}

// 没有指明时用哪个服务地址：KIOKU_SERVER_URL → cli.json 记住的地址 → 各平台写下的里面最先找到的
export async function defaultServerUrl(env: Env): Promise<string | null> {
  const fromEnv = (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  if (fromEnv && !serverUrlProblem(fromEnv)) return fromEnv
  const prefs = await readCliPreferences(env).catch(() => ({}) as { serverUrl?: string })
  if (prefs.serverUrl) return prefs.serverUrl
  return (await knownServers(env))[0] ?? null
}

// 只扫描本机现状，不发 whoami 网络请求；配好访问密钥时标记 checking: true
export async function scanLocalPlatform(
  id: string,
  { env, cwd, url }: { env: Env; cwd: string; url: string | null },
): Promise<{ row: PlatformRow; config: TargetConfig | null }> {
  const platform = PLATFORMS[id]
  const detected = await detectPlatformPresence(id, env)
  const present = detected.presence !== 'absent'
  const row: PlatformRow = {
    id,
    name: platform.name,
    present,
    presence: detected.presence,
    ...(detected.installKind ? { installKind: detected.installKind } : {}),
    hasCli: detected.hasCli,
    connection: 'none',
    plugin: null,
    memory: null,
  }

  let config: TargetConfig | null = null
  if (!platform.readConfig) row.connection = 'manual'
  else {
    try {
      config = await platform.readConfig(env)
    } catch (err) {
      row.connection = 'broken'
      row.reason = failureText(err)
    }
  }
  if (config) {
    row.url = config.url
    row.otherServer = Boolean(url && config.url !== url)
    row.connection = 'unknown'
    row.checking = true
  }

  const status = await platform.status({ env, cwd }).catch(() => ({
    plugin: null,
    memory: null,
    reenabledIn: undefined,
  }))
  row.plugin = status.plugin
  row.memory = status.memory
  if (status.reenabledIn) row.reenabledIn = status.reenabledIn

  if (!config && row.connection === 'none' && id === 'claude-code' && status.plugin === true) {
    row.connection = 'manual'
  }

  // 只数本地有几条；和 Kioku 比（没迁的有几条）要一条一条地问，选了迁移再比
  if (platform.source) row.local = await countLocal(platform.source, { env }).catch(() => null)
  const legacyPlugin = await detectLegacyPlugin(id, { env, cwd }).catch(() => null)
  if (
    legacyPlugin &&
    (legacyPlugin.legacySource ||
      legacyPlugin.outdatedPlugin ||
      legacyPlugin.staleToolCache ||
      legacyPlugin.manualInstallDir)
  ) {
    row.legacyPlugin = legacyPlugin
  }
  const conflicts = await scanConflicts(id, { env, cwd }).catch(() => [])
  if (conflicts.length) row.conflicts = conflicts
  return { row, config }
}

// 远端校验单个已配置的平台，填好 who / connection / reason
export async function verifyPlatformRemote(
  row: PlatformRow,
  config: TargetConfig,
): Promise<PlatformRow> {
  const next: PlatformRow = { ...row }
  delete next.checking
  try {
    next.who = await whoami(config)
    next.connection = 'ok'
  } catch (err) {
    next.connection = err instanceof KeyRejected ? 'invalid' : 'unknown'
    if (err instanceof KeyRejected && err.legacy) next.legacyKey = true
    next.reason = failureText(err)
  }
  return next
}

// 一个平台的现状。connection：
// - ok：访问密钥可用；none：没配过；invalid：服务端说访问密钥无效或已吊销（legacyKey 为真时是升级前签发的）
// - unknown：连不上、响应不对，查不了；broken：配置文件读不懂
// - manual：未写入 profile，但 Claude Code 在 /plugin 里已启用插件
export async function scanPlatform(
  id: string,
  { env, cwd, url }: { env: Env; cwd: string; url: string | null },
): Promise<PlatformRow> {
  const { row, config } = await scanLocalPlatform(id, { env, cwd, url })
  return config ? verifyPlatformRemote(row, config) : row
}

// 面板的全部现状。url 为空时只扫本机
export async function scan({
  env,
  cwd,
  url,
}: {
  env: Env
  cwd: string
  url: string | null
}): Promise<PanelState> {
  const server = url ? { url, ...(await serverHealth(url)) } : null
  const platforms = await Promise.all(
    Object.keys(PLATFORMS).map((id) => scanPlatform(id, { env, cwd, url })),
  )
  return { server, platforms }
}

const PLUGIN_NAMES = new Map<boolean | null, string>([
  [true, '已安装'],
  [false, '未安装'],
  [null, '无法判断'],
])
const MEMORY_NAMES: Record<string, string> = { off: '已停用', on: '未停用', none: '无' }

// 访问密钥属于哪个主场记忆圈：服务端给了名称就用名称，否则用 slug 或 id 前 8 位
function circleText(who: WhoamiResponse): string | null {
  if (who.primaryCircle.name) return plain(who.primaryCircle.name)
  if (who.primaryCircle.slug) return plain(who.primaryCircle.slug)
  return typeof who.primaryCircle.id === 'string' ? plain(who.primaryCircle.id).slice(0, 8) : null
}

// 能不能停用：配过（不管现在能不能用），或者 Claude Code 的自动记忆停着
export function canDisable(row: Pick<PlatformRow, 'connection' | 'memory'>): boolean {
  return (
    ['ok', 'invalid', 'unknown', 'broken'].includes(row.connection) ||
    (row.connection === 'manual' && row.memory === 'off')
  )
}

// 平台接到哪一步，一个短词
export function connectionText(
  row: Pick<PlatformRow, 'connection' | 'plugin' | 'otherServer' | 'present' | 'legacyKey'>,
): string {
  if (row.connection === 'manual') return row.plugin ? '插件已启用' : '未接入'
  if (row.connection === 'ok' && row.otherServer) return '接到另一台服务器'
  if (row.connection === 'invalid' && row.legacyKey) return '旧密钥已失效'
  return (
    {
      ok: '已接入',
      none: row.present ? '未接入' : '未安装',
      invalid: '已失效',
      unknown: '无法判断',
      broken: '配置有误',
    }[row.connection] ?? '无法判断'
  )
}

export function platformDetails(row: PlatformRow): {
  head: string
  facts: string[]
  details: string[]
} {
  const head = connectionText(row)
  const facts: string[] = []
  if (row.connection === 'ok' && row.who) {
    const client = row.who.client
    facts.push(`接入实例 ${plain(client.name)}（${plain(client.slug)}）`)
    const circle = circleText(row.who)
    if (circle) facts.push(`记忆圈 ${circle}`)
    const linkedCount = Array.isArray(row.who.linkedCircles) ? row.who.linkedCircles.length : 0
    if (linkedCount > 0) {
      facts.push(`关联 ${linkedCount} 个客场圈`)
    }
    if (typeof row.who.accountName === 'string' && row.who.accountName) {
      facts.push(`账号 ${plain(row.who.accountName)}`)
    }
    if (client.runtimeFamily !== PLATFORMS[row.id].runtimeFamily) facts.push('接入实例的运行时不对')
  }
  if (row.otherServer && row.url) facts.push(shownUrl(row.url))
  if (row.reason) facts.push(row.reason)

  const details: string[] = []
  if (row.connection === 'manual') details.push('访问密钥 无法判断（在 /plugin 里填）')
  details.push(`插件 ${PLUGIN_NAMES.get(row.plugin) ?? '无法判断'}`)
  const reenabled = row.reenabledIn ? `（被 ./${row.reenabledIn} 重新启用）` : ''
  details.push(`自带记忆 ${(row.memory && MEMORY_NAMES[row.memory]) ?? '无法判断'}${reenabled}`)
  if (row.local) {
    const pending = !row.pending
      ? ''
      : row.pending.pending === null
        ? '（未迁移 无法判断）'
        : `（未迁移 ${row.pending.pending} 条）`
    details.push(`本地记忆 ${row.local} 条${pending}`)
  }
  if (row.legacyPlugin?.legacySource) details.push(`旧插件来源 ${row.legacyPlugin.legacySource}`)
  if (row.legacyPlugin?.outdatedPlugin) details.push(`插件过旧 ${row.legacyPlugin.outdatedPlugin}`)
  if (row.conflicts?.length) {
    details.push(`冲突 ${conflictToolsText(row.conflicts)}`)
  }
  return { head, facts, details }
}

function platformLines(row: PlatformRow): string[] {
  const { head, facts, details } = platformDetails(row)
  const first = [`${row.name}：${head}`, ...facts].join(' · ')
  // 没装、也没配过且没有冲突的平台只写一行
  if (!row.present && row.connection === 'none' && !row.conflicts?.length) return [first]
  return [first, `  ${details.join(' · ')}`]
}

// 面板的文字
export function renderPanel(
  state: PanelState,
  { collapseUninstalled = false }: { collapseUninstalled?: boolean } = {},
): string {
  const lines: string[] = []
  const { server } = state
  if (!server) lines.push('服务器：未设置')
  else {
    const facts: string[] = []
    if (!server.reachable) facts.push(`无法连接（${server.problem}）`)
    else {
      facts.push(server.problem ?? '可连接')
      if (server.version) facts.push(`版本 ${server.version}`)
      if (server.needsSetup) facts.push('未初始化')
    }
    lines.push(`服务器：${shownUrl(server.url)}（${facts.join(' · ')}）`)
    const circles = [
      ...new Set(
        state.platforms
          .filter((row) => row.connection === 'ok' && row.who)
          .map((row) => circleText(row.who!))
          .filter((s): s is string => Boolean(s)),
      ),
    ]
    if (circles.length > 1)
      lines.push(`访问密钥分属 ${circles.length} 个记忆圈：${circles.join('、')}`)
  }
  lines.push('')
  const uninstalled: PlatformRow[] = []
  for (const row of state.platforms) {
    if (
      collapseUninstalled &&
      !row.present &&
      row.connection === 'none' &&
      !row.conflicts?.length
    ) {
      uninstalled.push(row)
      continue
    }
    lines.push(...platformLines(row))
  }
  if (uninstalled.length) {
    lines.push(
      `未检测到客户端（${uninstalled.length} 个）：${uninstalled.map((r) => r.name).join('、')}`,
    )
  }
  return lines.join('\n')
}

// 需要从旧版迁移的客户端：带旧密钥、旧插件市场来源、过旧插件或旧工具清单缓存
export function migrationCandidates(state: PanelState): PlatformRow[] {
  return state.platforms.filter(
    (row) =>
      !row.otherServer &&
      Boolean(
        row.legacyKey ||
        row.legacyPlugin?.legacySource ||
        row.legacyPlugin?.outdatedPlugin ||
        row.legacyPlugin?.staleToolCache,
      ),
  )
}

// 要接入的候选：有自己的配置、还没接到这台服务器的（失效的与仅 /plugin 手动配置的另算）
export function connectCandidates(state: PanelState): PlatformRow[] {
  return state.platforms.filter(
    (row) =>
      PLATFORMS[row.id].setup &&
      row.connection !== 'invalid' &&
      row.connection !== 'manual' &&
      !(row.connection === 'ok' && !row.otherServer),
  )
}

const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name).join('、')

export interface PanelAction {
  value: string
  label: string
  hint?: string
}

// 面板下面列出的动作：{ value, label, hint? }，按缺什么排在前面
export function actionsFor(state: PanelState): PanelAction[] {
  const actions: PanelAction[] = []
  const { server } = state
  const ready = Boolean(server?.reachable && !server.problem && !server.needsSetup)
  if (server?.mismatch === 'legacy') {
    actions.push({
      value: 'open-upgrade',
      label: '打开管理界面迁移旧数据',
      hint: upgradePageOf(server.url),
    })
  }
  if (!server || !server.reachable) {
    actions.push({ value: 'local', label: '本机起一个 Kioku', hint: '用 Docker' })
  }
  if (!server) actions.push({ value: 'server', label: '填写服务器地址' })
  if (server?.needsSetup) {
    actions.push({ value: 'open', label: '打开管理界面初始化', hint: '建第一个管理员' })
  }
  if (ready) {
    const migrateList = migrationCandidates(state)
    if (migrateList.length) {
      actions.push({
        value: 'migrate',
        label: `从旧版迁移 ${names(migrateList)}（${migrateList.length} 个客户端）`,
        hint: '更新插件并批量重新授权',
      })
    }
    const candidates = connectCandidates(state)
    const present = candidates.filter((row) => row.present)
    if (present.length) {
      actions.push({
        value: 'connect',
        label: `接入 ${names(present)}（${present.length} 个未接入）`,
      })
    } else if (candidates.length) {
      actions.push({ value: 'connect', label: '接入其他平台', hint: '本机没发现的' })
    }
    const invalid = state.platforms.filter((row) => row.connection === 'invalid' && !row.legacyKey)
    if (invalid.length) {
      actions.push({ value: 'reauth', label: `重新授权 ${names(invalid)}（访问密钥已失效）` })
    }
  }
  const claude = state.platforms.find((row) => row.id === 'claude-code')
  if (
    claude?.present &&
    (claude.connection === 'manual' || claude.connection === 'ok') &&
    claude.memory === 'on' &&
    !claude.reenabledIn
  ) {
    actions.push({ value: 'claude-memory', label: '停用 Claude Code 的自动记忆' })
  }
  if (ready) {
    for (const row of state.platforms) {
      if (!row.local) continue
      // 迁移要这个平台的访问密钥
      if (row.connection !== 'manual' && !(row.connection === 'ok' && !row.otherServer)) continue
      // 比过、确实都迁了的不再提供
      if (row.pending?.pending === 0) continue
      const count =
        typeof row.pending?.pending === 'number'
          ? `未迁移 ${row.pending.pending} 条`
          : `${row.local} 条`
      actions.push({ value: `import:${row.id}`, label: `迁移 ${row.name} 的本地记忆（${count}）` })
    }
  }
  const conflicted = state.platforms.filter((row) => row.conflicts?.some((c) => c.removable))
  if (conflicted.length) {
    actions.push({
      value: 'clean',
      label: '清理冲突的记忆工具',
      hint: conflictToolsText(
        conflicted.flatMap((row) => row.conflicts!.filter((c) => c.removable)),
      ),
    })
  }
  if (state.platforms.some(canDisable)) {
    actions.push({ value: 'disable', label: '停用某个平台', hint: '恢复自带记忆、清掉配置' })
  }
  actions.push({ value: 'doctor', label: '检查（doctor）' })
  if (server) actions.push({ value: 'server', label: '更换服务器地址' })
  actions.push({ value: 'refresh', label: '刷新' })
  actions.push({ value: 'exit', label: '退出' })
  return actions
}
