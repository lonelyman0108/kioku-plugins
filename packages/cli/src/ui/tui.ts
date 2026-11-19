// @kioku-memory/cli 全屏交互式客户端控制台：左客户端列表 + 右详情与指引 + 弹出层交互，
// 专注于本机各 AI 客户端插件接入、授权、诊断、冲突清理与本地记忆迁移；记忆编排与系统设置引导至网页端。

import { emitKeypressEvents } from 'node:readline'

import { upgradePageOf } from '../api.ts'
import { migrateCommand, planMigration, renderMigrationPlan } from '../commands/migrate.ts'
import { conflictToolsText, formatConflicts, removeConflicts } from '../conflicts.ts'
import { connectPlatforms, pluginSteps, resultsText } from '../connect.ts'
import {
  KiokuFailure,
  keyFormatError,
  loadConfig,
  plain,
  serverUrlProblem,
  shownUrl,
} from '../core.ts'
import { doctor } from '../doctor.ts'
import { rememberServerUrl } from '../identity.ts'
import { pendingOf, planImport, writeImport } from '../import.ts'
import {
  CLI_VERSION,
  formatHandshakeLines,
  installPlugin,
  removeManagedAgyPlugin,
  verifyConnectionHandshake,
} from '../installer.ts'
import {
  LOCAL_PORT,
  LOCAL_URL,
  composeState,
  composeUp,
  defaultLocalDir,
  expandDir,
  hasCompose,
  healthy,
  latestRelease,
  manualDownload,
  portBusy,
  prepareDir,
  setupCodeIn,
  setupDone,
  waitUntil,
} from '../local.ts'
import { openBrowser, type DeviceAuthPrompt } from '../login.ts'
import {
  canDisable,
  connectCandidates,
  connectionText,
  defaultServerUrl,
  effectivePresence,
  migrationCandidates,
  scanLocalPlatform,
  serverHealth,
  verifyPlatformRemote,
  type PanelServer,
  type PanelState,
  type PlatformRow,
} from '../panel.ts'
import { PLATFORMS } from '../platforms.ts'
import { setup } from '../setup.ts'
import type { Env, Reader, TargetConfig } from '../types.ts'
import { bufferOut } from '../wizard.ts'
import { copyToClipboard } from './clipboard.ts'
import {
  createLineInput,
  lineInputValue,
  renderLineWindow,
  stepLineInput,
  type LineInputKey,
  type LineInputState,
} from './lineInput.ts'
import { formatCountdown, spacedCode, type DeviceWaitHandle } from './prompts.ts'
import type { ScreenStream } from './screen.ts'
import {
  capabilityLabel,
  createTheme,
  renderBox,
  sensitivityBadge,
  type StrataTheme,
} from './theme.ts'
import { createViewport, type ViewportScreen } from './viewport.ts'
import {
  displayWidth,
  fitWidth,
  slicePlainColumns,
  stripAnsi,
  truncateWidth,
  wrapWidth,
} from './width.ts'

const SPINNER_FRAMES = ['·', '•', '●', '•']

export interface TuiToast {
  kind: 'info' | 'ok' | 'warn' | 'error'
  text: string
}

export interface ClientLogRecord {
  title: string
  lines: string[]
}

export type TuiModal =
  | {
      kind: 'text'
      title: string
      prompt: string
      placeholder?: string
      secret?: boolean
      input: LineInputState
      error?: string
    }
  | {
      kind: 'confirm'
      title: string
      lines: string[]
      question: string
      yesLabel: string
      noLabel: string
      value: boolean
      danger?: boolean
    }
  | {
      kind: 'multiselect'
      title: string
      prompt: string
      options: Array<{ value: string; label: string; hint?: string }>
      selected: string[]
      cursor: number
      scroll: number
      error?: string
    }
  | {
      kind: 'device-auth'
      title: string
      userCode: string
      verificationUrl: string
      remainingSec: number
      codeCopied: boolean
      linkCopied: boolean
    }
  | {
      kind: 'progress'
      title: string
      message: string
      lines: string[]
      code?: string | null
      openUrl?: string
      cancellable: boolean
    }
  | {
      kind: 'help'
      title: string
      lines: string[]
    }

export interface TuiState {
  version: string
  url: string | null
  server: PanelServer | null
  platforms: PlatformRow[]
  selectedId: string
  showUninstalled: boolean
  listScroll: number
  detailScroll: number
  spinnerFrame: number
  busyLabel: string | null
  toast: TuiToast | null
  resultsById: Record<string, ClientLogRecord>
  pendingById: Record<string, { pending: number | null; reason?: string }>
  modal: TuiModal | null
}

const DEFAULT_DEPS = {
  scanLocalPlatform,
  verifyPlatformRemote,
  serverHealth,
  defaultServerUrl,
  rememberServerUrl,
  connectPlatforms,
  pluginSteps,
  installPlugin,
  verifyConnectionHandshake,
  removeManagedAgyPlugin,
  setup,
  doctor,
  planMigration,
  migrateCommand,
  planImport,
  writeImport,
  removeConflicts,
  loadConfig,
  open: openBrowser,
  copy: copyToClipboard,
  local: {
    composeState,
    composeUp,
    hasCompose,
    healthy,
    latestRelease,
    portBusy,
    prepareDir,
    setupCodeIn,
    setupDone,
    waitUntil,
  },
}

export type TuiDeps = typeof DEFAULT_DEPS

function isPrimaryRow(row: PlatformRow): boolean {
  return (
    effectivePresence(row) === 'installed' ||
    row.connection !== 'none' ||
    Boolean(row.conflicts?.length)
  )
}

export function visiblePlatformRows(state: TuiState): {
  visible: PlatformRow[]
  primaryCount: number
  uninstalledCount: number
} {
  const primary = state.platforms.filter(isPrimaryRow)
  const uninstalled = state.platforms.filter((row) => !isPrimaryRow(row))
  return {
    visible: state.showUninstalled ? state.platforms : primary,
    primaryCount: primary.length,
    uninstalledCount: uninstalled.length,
  }
}

function selectedRowOf(state: TuiState): PlatformRow | null {
  const { visible } = visiblePlatformRows(state)
  return visible.find((row) => row.id === state.selectedId) ?? visible[0] ?? null
}

function isServerReady(server: PanelServer | null): boolean {
  return Boolean(
    server && !server.checking && server.reachable && !server.problem && !server.needsSetup,
  )
}

function isLocalUrl(url: string | null): boolean {
  if (!url) return false
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(url)
}

function canMigrateRow(row: PlatformRow | null, ready: boolean): boolean {
  if (!row || !ready || !row.local) return false
  if (row.connection !== 'manual' && !(row.connection === 'ok' && !row.otherServer)) return false
  return row.pending?.pending !== 0
}

function canDisableClaudeMemory(row: PlatformRow | null): boolean {
  return Boolean(
    row &&
    row.id === 'claude-code' &&
    row.present &&
    (row.connection === 'manual' || row.connection === 'ok') &&
    row.memory === 'on' &&
    !row.reenabledIn,
  )
}

function circleSummary(platforms: PlatformRow[]): string[] {
  const set = new Set<string>()
  for (const row of platforms) {
    if (row.connection !== 'ok' || !row.who) continue
    const c =
      typeof row.who.primaryCircle.name === 'string' && row.who.primaryCircle.name
        ? plain(row.who.primaryCircle.name)
        : typeof row.who.primaryCircle.slug === 'string' && row.who.primaryCircle.slug
          ? plain(row.who.primaryCircle.slug)
          : typeof row.who.primaryCircle.id === 'string'
            ? plain(row.who.primaryCircle.id).slice(0, 8)
            : ''
    if (c) set.add(c)
  }
  return [...set]
}

function horizontalRule(cols: number, junctionChar?: string, junctionCol?: number): string {
  if (!junctionChar || junctionCol === undefined || junctionCol < 0 || junctionCol >= cols) {
    return '─'.repeat(cols)
  }
  return `${'─'.repeat(junctionCol)}${junctionChar}${'─'.repeat(cols - junctionCol - 1)}`
}

function renderTopBar(
  state: TuiState,
  cols: number,
  theme: StrataTheme,
  splitCol?: number,
): [string, string] {
  const stamp = theme.brandStamp('記 憶')
  const ver = cols >= 62 ? ` ${theme.muted(`v${plain(state.version)}`)}` : ''
  const left = ` ${stamp}  ${theme.bold('kioku-plugins')}${ver}`

  let right: string
  const { server } = state
  const spinner = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]
  if (!server) {
    right = state.url
      ? `${theme.accent(spinner)} ${shownUrl(state.url)}`
      : `${theme.warn('○ 尚未设置服务地址')}${cols >= 68 ? theme.muted(' · 按 s 配置') : ''}`
  } else if (server.checking) {
    right = `${theme.accent(spinner)} ${shownUrl(server.url)}${theme.muted(' · 连接中')}`
  } else if (!server.reachable) {
    right = `${theme.error('✗')} ${shownUrl(server.url)} · ${theme.error(`无法连接（${server.problem ?? '未知错误'}）`)}`
  } else if (server.problem) {
    right = `${theme.error('!')} ${shownUrl(server.url)} · ${theme.error(server.problem)}`
  } else if (server.needsSetup) {
    right = `${theme.warn('!')} ${shownUrl(server.url)} · ${theme.warn('待初始化管理员')}`
  } else {
    const circles = circleSummary(state.platforms)
    const verNote = server.version ? ` ${plain(server.version)}` : ''
    const circleNote = circles.length > 1 ? ` · ${circles.length} 个记忆圈` : ''
    right = `${theme.ok('●')} ${shownUrl(server.url)}${theme.muted(`${verNote}${circleNote}`)}`
  }

  const leftW = displayWidth(left)
  const rightBudget = Math.max(12, cols - leftW - 3)
  const rightShown = truncateWidth(right, rightBudget)
  const gap = Math.max(1, cols - leftW - displayWidth(rightShown) - 1)
  const topLine = theme.barSurface(fitWidth(`${left}${' '.repeat(gap)}${rightShown}`, cols))
  const ruleLine = theme.hairline(horizontalRule(cols, '┬', splitCol))
  return [topLine, ruleLine]
}

function rowBadge(
  row: PlatformRow,
  spinnerFrame: number,
  theme: StrataTheme,
): { icon: string; status: string; coloredStatus: string } {
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
  if (row.checking) {
    return { icon: theme.accent(spinner), status: '核对中', coloredStatus: theme.muted('核对中') }
  }
  if (row.connection === 'invalid' || row.connection === 'broken') {
    const txt = connectionText(row)
    return { icon: theme.error('✗'), status: txt, coloredStatus: theme.error(txt) }
  }
  if (row.conflicts?.some((c) => c.removable)) {
    const txt = row.connection === 'ok' ? '有冲突' : connectionText(row)
    return { icon: theme.error('!'), status: txt, coloredStatus: theme.error(txt) }
  }
  const presence = effectivePresence(row)
  if (row.connection === 'ok') {
    if (row.otherServer) {
      return {
        icon: theme.warn('!'),
        status: '另一服务器',
        coloredStatus: theme.warn('另一服务器'),
      }
    }
    if (presence === 'absent') {
      return {
        icon: theme.warn('!'),
        status: '客户端不在',
        coloredStatus: theme.warn('客户端不在'),
      }
    }
    if (presence === 'config-only') {
      return {
        icon: theme.warn('!'),
        status: '未找到程序',
        coloredStatus: theme.warn('未找到程序'),
      }
    }
    if (row.plugin === false) {
      return { icon: theme.warn('!'), status: '待装插件', coloredStatus: theme.warn('待装插件') }
    }
    if (row.memory === 'on') {
      return { icon: theme.warn('!'), status: '记忆未关', coloredStatus: theme.warn('记忆未关') }
    }
    return { icon: theme.ok('●'), status: '已接入', coloredStatus: theme.ok('已接入') }
  }
  if (row.connection === 'manual') {
    if (row.plugin) {
      return { icon: theme.ok('•'), status: '插件已启用', coloredStatus: theme.ok('插件已启用') }
    }
    return { icon: theme.muted('○'), status: '未接入', coloredStatus: theme.muted('未接入') }
  }
  if (row.connection === 'unknown') {
    return { icon: theme.muted('?'), status: '无法判断', coloredStatus: theme.muted('无法判断') }
  }
  if (row.connection === 'none' && presence === 'config-only') {
    return {
      icon: theme.muted('○'),
      status: '仅残余配置',
      coloredStatus: theme.muted('仅残余配置'),
    }
  }
  const txt = connectionText(row)
  return { icon: theme.muted('○'), status: txt, coloredStatus: theme.muted(txt) }
}

function renderClientList(
  state: TuiState,
  width: number,
  height: number,
  theme: StrataTheme,
): string[] {
  const { visible, primaryCount, uninstalledCount } = visiblePlatformRows(state)
  const selectedIdx = Math.max(
    0,
    visible.findIndex((row) => row.id === state.selectedId),
  )
  const hasToggle = uninstalledCount > 0
  const itemSlots = Math.max(1, height - 2 - (hasToggle ? 1 : 0))

  let scroll = Math.max(0, state.listScroll)
  if (selectedIdx < scroll) scroll = selectedIdx
  if (selectedIdx >= scroll + itemSlots) scroll = selectedIdx - itemSlots + 1
  scroll = Math.max(0, Math.min(scroll, Math.max(0, visible.length - itemSlots)))

  const connectedCount = state.platforms.filter(
    (p) => p.connection === 'ok' && !p.otherServer,
  ).length
  const pager = visible.length > itemSlots ? ` · ${selectedIdx + 1}/${visible.length}` : ''
  const titleLeft = ` ${theme.bold('客户端')}`
  const stats =
    primaryCount > 0
      ? connectedCount > 0
        ? `${theme.ok(String(connectedCount))}${theme.muted(`/${primaryCount} 已接入${pager}`)}`
        : theme.muted(`0/${primaryCount} 已接入${pager}`)
      : theme.muted(`尚未检出${pager}`)
  const headGap = Math.max(1, width - displayWidth(titleLeft) - displayWidth(stats) - 1)
  const headerLine = fitWidth(`${titleLeft}${' '.repeat(headGap)}${stats}`, width)

  const lines: string[] = [headerLine, theme.hairline('─'.repeat(width))]

  if (visible.length === 0) {
    if (lines.length < 2 + itemSlots) {
      lines.push(fitWidth(theme.muted('  尚未检测到本地客户端'), width))
    }
    if (lines.length < 2 + itemSlots) {
      lines.push(fitWidth(theme.muted('  按 Tab 展开全部受支持客户端'), width))
    }
    while (lines.length < 2 + itemSlots) {
      lines.push(' '.repeat(width))
    }
  } else {
    const slice = visible.slice(scroll, scroll + itemSlots)
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i]
      const active = scroll + i === selectedIdx
      const pointer = active ? (theme.color ? `${theme.accent('┃')} ` : '› ') : '  '
      const badge = rowBadge(row, state.spinnerFrame, theme)
      const statusW = displayWidth(badge.status)
      const nameBudget = Math.max(6, width - 5 - statusW - 1)
      const rawName = truncateWidth(row.name, nameBudget)
      const nameShown = active ? theme.bold(rawName) : rawName
      const leftPart = `${pointer}${badge.icon} ${nameShown}`
      const gap = Math.max(1, width - displayWidth(leftPart) - statusW - 1)
      const rowLine = fitWidth(`${leftPart}${' '.repeat(gap)}${badge.coloredStatus} `, width)
      lines.push(active ? theme.selectedSurface(rowLine) : rowLine)
    }
    while (lines.length < 2 + itemSlots) {
      lines.push(' '.repeat(width))
    }
  }

  if (hasToggle) {
    const toggleLabel = state.showUninstalled
      ? `── Tab 折叠未检出（${uninstalledCount}）`
      : `── 折叠 ${uninstalledCount} 个未检出 · Tab 展开`
    lines.push(fitWidth(theme.muted(` ${toggleLabel}`), width))
  }
  return lines.slice(0, height)
}

function sectionHeader(title: string, width: number, theme: StrataTheme): string {
  const label = plain(title)
  const rest = Math.max(2, width - displayWidth(label) - 6)
  return ` ${theme.accent('▸')} ${theme.bold(label)} ${theme.hairline('─'.repeat(rest))}`
}

function kvLine(label: string, value: string, width: number, theme: StrataTheme): string {
  const prefix = `  ${theme.muted(fitWidth(label, 10))} `
  const restWidth = Math.max(8, width - 14)
  return fitWidth(`${prefix}${truncateWidth(value, restWidth)}`, width)
}

function pushCommandBlock(
  commands: string[],
  width: number,
  out: string[],
  theme: StrataTheme,
): void {
  const blockW = Math.max(16, width - 3)
  for (const cmd of commands) {
    for (const part of wrapWidth(cmd, Math.max(10, blockW - 4))) {
      const inner = fitWidth(` ${theme.accent('┃')} ${part}`, blockW)
      out.push(`  ${theme.subtleSurface(inner)}`)
    }
  }
}

function styledResultLine(line: string, theme: StrataTheme): string {
  const clean = plain(line)
  if (clean.startsWith('✓')) return theme.ok(clean)
  if (clean.startsWith('✗')) return theme.error(clean)
  if (clean.startsWith('!')) return theme.warn(clean)
  return clean
}

function buildDetailBody(
  state: TuiState,
  row: PlatformRow | null,
  width: number,
  theme: StrataTheme,
): string[] {
  const wrapBudget = Math.max(12, width - 3)
  const out: string[] = []
  const pushWrapped = (text: string, prefix = '  ') => {
    for (const part of wrapWidth(text, Math.max(8, wrapBudget - displayWidth(prefix)))) {
      out.push(`${prefix}${part}`)
    }
  }

  if (state.server?.mismatch === 'legacy' && state.url) {
    out.push(sectionHeader('服务端等待数据迁移', width, theme))
    pushWrapped(theme.error('! 服务端已升级、尚未迁移旧数据'))
    pushWrapped(`按 o 打开升级页：${upgradePageOf(state.url)}`)
    out.push('')
  } else if (state.server?.mismatch === 'older' || state.server?.mismatch === 'newer') {
    out.push(sectionHeader('服务端代际不匹配', width, theme))
    pushWrapped(theme.error(`! ${state.server.problem ?? '服务端与命令行代际不兼容'}`))
    out.push('')
  } else if (isServerReady(state.server)) {
    const migrateList = migrationCandidates({ server: state.server, platforms: state.platforms })
    if (migrateList.length) {
      out.push(sectionHeader('发现旧版客户端迁移项', width, theme))
      pushWrapped(theme.warn(`! 检测到 ${migrateList.length} 个客户端需从旧版迁移`))
      pushWrapped(`按 M 查看计划并一键迁移（${migrateList.map((c) => c.name).join('、')}）`)
      out.push('')
    }
  }

  if (!row) {
    out.push('  尚未在本机检出已安装的 AI 客户端。')
    out.push('')
    out.push(sectionHeader('常用操作', width, theme))
    out.push(`  ${theme.keycap('Tab', '展开全部受支持客户端并预先写入配置')}`)
    out.push(`  ${theme.keycap('s', '设置或更换 Kioku 服务地址')}`)
    out.push(`  ${theme.keycap('l', '在本机用 Docker Compose 启动 Kioku')}`)
    out.push(`  ${theme.keycap('o', '在浏览器打开 Kioku 管理界面')}`)
    return out
  }

  // 服务与权限分区
  out.push(sectionHeader('服务与权限', width, theme))
  if (row.checking) {
    out.push(kvLine('接入状态', theme.muted('正在向服务端校验访问密钥…'), width, theme))
  } else if (row.connection === 'ok' && row.who) {
    const { primaryCircle, linkedCircles, client, scopes } = row.who
    const clientText = `${theme.bold(plain(client.name))} ${theme.muted(`（${plain(client.slug)}）`)}`
    const mismatch =
      client.runtimeFamily !== PLATFORMS[row.id].runtimeFamily
        ? ` ${theme.error('! 运行时类型不匹配')}`
        : ''
    out.push(kvLine('接入实例', `${clientText}${mismatch}`, width, theme))

    const circle =
      typeof primaryCircle.name === 'string' && primaryCircle.name
        ? plain(primaryCircle.name)
        : typeof primaryCircle.slug === 'string' && primaryCircle.slug
          ? plain(primaryCircle.slug)
          : typeof primaryCircle.id === 'string'
            ? plain(primaryCircle.id).slice(0, 8)
            : '主场记忆圈'
    const linkedCount = Array.isArray(linkedCircles) ? linkedCircles.length : 0
    const linked = linkedCount > 0 ? ` · 关联 ${linkedCount} 圈` : ''
    const acct =
      typeof row.who.accountName === 'string' && row.who.accountName
        ? ` · ${theme.muted(`账号 ${plain(row.who.accountName)}`)}`
        : ''
    out.push(kvLine('主场记忆圈', `${circle}${linked}${acct}`, width, theme))

    const readChips =
      (scopes.readKinds ?? []).map((k) => theme.kindChip(k)).join('  ') || theme.muted('无')
    const writeChips =
      (scopes.writeKinds ?? []).map((k) => theme.kindChip(k)).join('  ') || theme.muted('无')
    out.push(kvLine('读取物种', readChips, width, theme))
    out.push(kvLine('写入物种', writeChips, width, theme))

    const sens = sensitivityBadge(scopes.maxSensitivity ?? 'internal', theme)
    const cred = capabilityLabel(scopes.credentials)
    out.push(kvLine('安全边界', `${sens} · 凭据 ${cred}`, width, theme))
  } else if (row.connection === 'invalid' || row.connection === 'broken') {
    out.push(kvLine('接入状态', theme.error(row.reason || connectionText(row)), width, theme))
  } else {
    out.push(
      kvLine(
        '接入状态',
        row.reason ? theme.muted(row.reason) : theme.muted(connectionText(row)),
        width,
        theme,
      ),
    )
  }

  if (row.otherServer && row.url) {
    out.push(kvLine('已配地址', theme.warn(shownUrl(row.url)), width, theme))
  }

  // 本机环境分区
  const presence = effectivePresence(row)
  out.push('')
  out.push(sectionHeader('本机环境', width, theme))
  const clientDesc =
    presence === 'installed'
      ? row.installKind === 'desktop'
        ? theme.ok('✓ 本机已检出（桌面端）')
        : row.installKind === 'ide'
          ? theme.ok('✓ 本机已检出（编辑器扩展，无全局命令）')
          : theme.ok('✓ 本机已检出')
      : presence === 'config-only'
        ? theme.warn('! 仅发现配置目录（未找到可执行程序）')
        : row.connection !== 'none'
          ? theme.warn('! 本机未检出（客户端可能已卸载）')
          : theme.muted('○ 本机未检出')
  out.push(kvLine('客户端', clientDesc, width, theme))

  const noCliNote = row.hasCli === false ? '无法判断（未找到命令）' : '无法判断'
  const pluginText =
    row.plugin === true
      ? theme.ok('✓ 已安装')
      : row.plugin === false
        ? theme.warn('! 未安装')
        : theme.muted(noCliNote)
  out.push(kvLine('插件状态', pluginText, width, theme))

  const memLabel =
    row.memory === 'off'
      ? theme.ok('✓ 已停用')
      : row.memory === 'on'
        ? theme.warn('! 未停用')
        : row.memory === 'none'
          ? theme.muted('无内置记忆')
          : theme.muted(noCliNote)
  const reenabled = row.reenabledIn ? theme.error(`（被 ./${row.reenabledIn} 重新启用）`) : ''
  out.push(kvLine('自带记忆', `${memLabel}${reenabled}`, width, theme))

  if (row.legacyPlugin?.legacySource) {
    out.push(kvLine('旧插件来源', theme.warn(`! ${row.legacyPlugin.legacySource}`), width, theme))
  }
  if (row.legacyPlugin?.outdatedPlugin) {
    out.push(kvLine('旧版插件', theme.warn(`! ${row.legacyPlugin.outdatedPlugin}`), width, theme))
  }

  if (row.local !== undefined && row.local !== null) {
    const pendingText = !row.pending
      ? ''
      : row.pending.pending === null
        ? theme.muted('（未迁移 无法判断）')
        : row.pending.pending > 0
          ? theme.warn(`（待迁移 ${row.pending.pending} 条）`)
          : theme.ok('（已全部迁移）')
    out.push(kvLine('本地记忆', `${row.local} 条${pendingText}`, width, theme))
  }

  if (row.conflicts?.length) {
    out.push(kvLine('冲突工具', theme.error(`! ${conflictToolsText(row.conflicts)}`), width, theme))
    for (const conflict of row.conflicts) {
      pushWrapped(`${conflict.removable ? '可清理' : '提示'} · ${conflict.summary}`, '    ')
    }
  }

  // 最近结果或操作指引
  const record = state.resultsById[row.id]
  out.push('')
  if (record) {
    out.push(sectionHeader(record.title, width, theme))
    for (const line of record.lines) {
      if (!line) {
        out.push('')
        continue
      }
      pushWrapped(styledResultLine(line, theme), '  ')
    }
  } else {
    out.push(sectionHeader('操作指引', width, theme))
    if (!state.server) {
      pushWrapped('尚未设置 Kioku 服务地址：按 s 填写地址，或按 l 在本机通过 Docker 启动。')
    } else if (!state.server.reachable) {
      pushWrapped('当前无法连接服务器：按 s 更换地址，或按 l 检查/启动本机容器。')
    } else if (state.server.needsSetup) {
      pushWrapped('服务端尚未初始化管理员：按 o 打开网页端完成首次初始化。')
    } else if (row.connection === 'invalid') {
      pushWrapped('当前访问密钥已失效或被吊销：按 Enter 重新走浏览器授权签发新访问密钥。')
    } else if (row.connection === 'broken') {
      pushWrapped('本机配置文件格式无法解析：检查文件后按 Enter 重新写入，或按 d 查看诊断。')
    } else if (row.connection === 'manual') {
      pushWrapped(
        row.plugin
          ? '已在 /plugin 中启用插件；可直接在 /plugin 填地址与访问密钥，或按 Enter 浏览器授权写入本机配置文件。'
          : '按 Enter 发起浏览器授权写入 ~/.config/kioku/claude-code.json，并在 Claude Code 安装插件。',
      )
      if (row.memory === 'on' && !row.reenabledIn) {
        pushWrapped('检测到自带自动记忆仍开启：按 m 停用 autoMemoryEnabled。')
      }
    } else if (row.connection === 'none' || row.otherServer) {
      pushWrapped(
        PLATFORMS[row.id].setup
          ? '按 Enter 发起浏览器授权：自动写入配置、停用自带记忆、尝试安装插件并做 MCP 握手验证。'
          : '在对应客户端插件配置中填写服务地址与访问密钥。',
      )
    } else if (row.plugin === false) {
      pushWrapped('凭据已配置，但尚未检测到客户端插件：按 p 自动安装，或按 y 复制命令手动执行。')
    } else {
      pushWrapped(
        '接入状态正常。可按 d 运行完整诊断，按 p 更新插件并刷新工具缓存，或按 o 打开网页端管理记忆与访问密钥。',
      )
    }

    if (row.connection !== 'none' && presence !== 'installed') {
      pushWrapped(
        theme.warn(
          '未在本机找到可执行程序：若通过编辑器扩展使用可忽略；若客户端已卸载，可按 u 断开并清理本机配置。',
        ),
      )
    }

    if (row.plugin === false || row.connection === 'none' || row.connection === 'manual') {
      const guide = PLATFORMS[row.id].install
      if (guide.commands.length) {
        out.push('')
        out.push(`  ${theme.muted('手动安装命令（按 y 复制）：')}`)
        pushCommandBlock(guide.commands, width, out, theme)
        if (guide.after) pushWrapped(theme.muted(guide.after), '  ')
      }
    }
  }

  return out
}

function detailMaxScroll(state: TuiState, cols: number, rows: number, theme: StrataTheme): number {
  const safeCols = Math.max(48, cols)
  const safeRows = Math.max(12, rows)
  const bodyRows = Math.max(4, safeRows - 4)
  let width: number
  let height: number
  if (safeCols >= 84) {
    const leftWidth = Math.min(36, Math.max(28, Math.floor(safeCols * 0.34)))
    width = safeCols - leftWidth - 3
    height = bodyRows
  } else {
    const { visible } = visiblePlatformRows(state)
    const listHeight = Math.min(
      Math.max(4, Math.floor(bodyRows * 0.45)),
      Math.max(4, visible.length + 3),
    )
    width = safeCols
    height = Math.max(2, bodyRows - listHeight - 1)
  }
  const row = selectedRowOf(state)
  const bodyLines = buildDetailBody(state, row, width, theme)
  const contentSlots = Math.max(1, height - 2)
  return Math.max(0, bodyLines.length - contentSlots)
}

function renderClientDetail(
  state: TuiState,
  width: number,
  height: number,
  theme: StrataTheme,
): string[] {
  const row = selectedRowOf(state)
  const bodyLines = buildDetailBody(state, row, width, theme)
  const contentSlots = Math.max(1, height - 2)
  const maxScroll = Math.max(0, bodyLines.length - contentSlots)
  const scroll = Math.max(0, Math.min(state.detailScroll, maxScroll))

  const titleBadge = row ? rowBadge(row, state.spinnerFrame, theme) : null
  const scrollNote =
    bodyLines.length > contentSlots
      ? theme.muted(
          ` ${scroll + 1}-${Math.min(bodyLines.length, scroll + contentSlots)}/${bodyLines.length} · [/]`,
        )
      : ''

  let headerLine: string
  if (!row || !titleBadge) {
    headerLine = fitWidth(` ${theme.bold('概览')}${scrollNote}`, width)
  } else {
    const left = ` ${theme.bold(row.name)}  ${theme.muted(row.id)}`
    const badgePart = `${titleBadge.icon} ${titleBadge.coloredStatus}`
    const rightText = scrollNote ? `${badgePart} ${scrollNote}` : badgePart
    const gap = Math.max(1, width - displayWidth(left) - displayWidth(rightText) - 1)
    headerLine = fitWidth(`${left}${' '.repeat(gap)}${rightText}`, width)
  }

  const lines: string[] = [headerLine, theme.hairline('─'.repeat(width))]
  const visibleSlice = bodyLines.slice(scroll, scroll + contentSlots)
  for (const line of visibleSlice) {
    lines.push(fitWidth(line, width))
  }
  while (lines.length < height) {
    lines.push(' '.repeat(width))
  }
  return lines.slice(0, height)
}

function renderBottomBar(
  state: TuiState,
  cols: number,
  theme: StrataTheme,
  splitCol?: number,
): [string, string] {
  const spinner = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]
  let statusRow: string
  if (state.toast) {
    const icon =
      state.toast.kind === 'ok'
        ? theme.ok('✓')
        : state.toast.kind === 'error'
          ? theme.error('✗')
          : state.toast.kind === 'warn'
            ? theme.warn('!')
            : theme.accent('·')
    const spinNote = state.busyLabel ? ` ${theme.muted(`${spinner} ${state.busyLabel}`)}` : ''
    statusRow = fitWidth(` ${icon} ${state.toast.text}${spinNote}`, cols)
  } else if (state.busyLabel) {
    statusRow = fitWidth(` ${theme.accent(spinner)} ${state.busyLabel}`, cols)
  } else {
    statusRow = theme.hairline(horizontalRule(cols, '┴', splitCol))
  }

  const row = selectedRowOf(state)
  const ready = isServerReady(state.server)
  const { uninstalledCount } = visiblePlatformRows(state)
  const anyRemovableConflict =
    Boolean(row?.conflicts?.some((c) => c.removable)) ||
    state.platforms.some((p) => p.conflicts?.some((c) => c.removable))

  const items: string[] = [theme.keycap('↑↓', '选择')]
  if (
    ready &&
    migrationCandidates({ server: state.server, platforms: state.platforms }).length > 0
  ) {
    items.push(theme.keycap('M', '旧版迁移'))
  }
  if (row && ready) {
    if (row.connection === 'invalid') items.push(theme.keycap('Enter', '重授权'))
    else if (row.connection !== 'ok' || row.otherServer) {
      if (PLATFORMS[row.id].setup) items.push(theme.keycap('Enter', '接入'))
    } else if (row.plugin === false) {
      items.push(theme.keycap('p', '装插件'))
    }
  }
  if (ready && connectCandidates(state).length > 0) items.push(theme.keycap('a', '批量'))
  if (row) items.push(theme.keycap('p', '插件'), theme.keycap('d', '诊断'))
  if (canMigrateRow(row, ready)) items.push(theme.keycap('i', '迁移'))
  if (anyRemovableConflict) items.push(theme.keycap('x', '消冲突'))
  if (canDisableClaudeMemory(row)) items.push(theme.keycap('m', '停记忆'))
  if (row && canDisable(row)) items.push(theme.keycap('u', '断开'))
  items.push(theme.keycap('s', '服务'))
  if (!state.server || !state.server.reachable || isLocalUrl(state.url)) {
    items.push(theme.keycap('l', '容器'))
  }
  if (state.url) items.push(theme.keycap('o', '网页'))
  if ((row && PLATFORMS[row.id].install.commands.length) || state.url) {
    items.push(theme.keycap('y', '复制'))
  }
  if (uninstalledCount > 0) items.push(theme.keycap('Tab', '未检出'))
  items.push(theme.keycap('r', '刷新'))

  const tail = ` ${theme.keycap('?', '帮助')}  ${theme.keycap('q', '退出')} `
  const tailW = displayWidth(tail)
  const budget = Math.max(8, cols - tailW - 1)
  let bar = ' '
  for (const item of items) {
    const piece = bar === ' ' ? item : `  ${item}`
    if (displayWidth(bar) + displayWidth(piece) > budget) break
    bar += piece
  }
  const tailGap = Math.max(1, cols - displayWidth(bar) - tailW)
  const shortcutRow = theme.barSurface(fitWidth(`${bar}${' '.repeat(tailGap)}${tail}`, cols))
  return [statusRow, shortcutRow]
}

function buildModalBox(modal: TuiModal, cols: number, rows: number, theme: StrataTheme): string {
  const maxBoxWidth = Math.max(32, cols - 4)
  if (modal.kind === 'text') {
    const width = Math.min(maxBoxWidth, 68)
    const innerInputWidth = Math.max(16, width - 6)
    const rendered = renderLineWindow(modal.input, {
      placeholder: modal.placeholder,
      maxWidth: innerInputWidth,
      mask: modal.secret ? '•' : undefined,
      showCursor: true,
      theme,
    })
    const lines = [
      modal.prompt,
      '',
      `${theme.rule('>')} ${rendered.text}`,
      ...(modal.error ? ['', theme.error(`! ${modal.error}`)] : []),
      '',
      theme.muted('Enter 确认 · Esc 取消'),
    ]
    return renderBox({ title: modal.title, width, theme, sections: [{ lines }] })
  }

  if (modal.kind === 'confirm') {
    const width = Math.min(maxBoxWidth, 72)
    const maxLines = Math.max(3, rows - 10)
    const wrapped: string[] = []
    for (const line of modal.lines) {
      wrapped.push(...wrapWidth(line, width - 6))
    }
    const clipped =
      wrapped.length > maxLines
        ? [
            ...wrapped.slice(0, maxLines - 1),
            theme.muted(`… 其余 ${wrapped.length - maxLines + 1} 行省略`),
          ]
        : wrapped
    const yesBtn = modal.value
      ? `${modal.danger ? theme.error('●') : theme.ok('●')} ${theme.bold(modal.yesLabel)}`
      : `${theme.muted('○')} ${modal.yesLabel}`
    const noBtn = !modal.value
      ? `${theme.ok('●')} ${theme.bold(modal.noLabel)}`
      : `${theme.muted('○')} ${modal.noLabel}`
    const sections = [
      ...(clipped.length ? [{ lines: clipped }] : []),
      {
        lines: [
          theme.bold(modal.question),
          `${yesBtn}   /   ${noBtn}   ${theme.muted('(←/→ 切换 · y/n · Enter 确认 · Esc 取消)')}`,
        ],
      },
    ]
    return renderBox({ title: modal.title, width, theme, sections })
  }

  if (modal.kind === 'multiselect') {
    const width = Math.min(maxBoxWidth, 68)
    const maxOpts = Math.max(3, rows - 9)
    const scroll = Math.max(0, Math.min(modal.scroll, Math.max(0, modal.options.length - maxOpts)))
    const slice = modal.options.slice(scroll, scroll + maxOpts)
    const selectedSet = new Set(modal.selected)
    const optLines = slice.map((opt, idx) => {
      const realIdx = scroll + idx
      const ptr = realIdx === modal.cursor ? theme.bold('›') : ' '
      const box = selectedSet.has(opt.value) ? theme.ok('[✓]') : theme.muted('[ ]')
      const label = realIdx === modal.cursor ? theme.bold(opt.label) : opt.label
      const hint = opt.hint ? theme.muted(` (${opt.hint})`) : ''
      return `${ptr} ${box} ${label}${hint}`
    })
    const lines = [
      modal.prompt,
      '',
      ...optLines,
      ...(modal.error ? ['', theme.error(`! ${modal.error}`)] : []),
      '',
      theme.muted('↑/↓ 移动 · Space 勾选 · a 全选 · Enter 确认 · Esc 取消'),
    ]
    return renderBox({ title: modal.title, width, theme, sections: [{ lines }] })
  }

  if (modal.kind === 'device-auth') {
    const cleanCode = plain(modal.userCode)
    const cleanUrl = plain(modal.verificationUrl)
    const spaced = spacedCode(cleanCode)
    const innerWidth = Math.max(12, displayWidth(spaced) + 4)
    const linkCopiedNote = modal.linkCopied ? theme.ok('（链接已复制）') : ''
    const openLine = `在浏览器里打开 ${cleanUrl}${linkCopiedNote}`
    const statusTag = modal.codeCopied
      ? theme.ok('确认码已复制')
      : theme.muted('对照终端输入确认码')
    const footerLeft = `${theme.keycap('o', '打开浏览器')}  ${theme.keycap('c', '复制链接')}  ${theme.keycap('Esc', '取消')}`
    const clock = theme.muted(formatCountdown(modal.remainingSec))
    const width = Math.min(
      maxBoxWidth,
      Math.max(58, displayWidth(openLine) + 6, innerWidth + 24, displayWidth(footerLeft) + 14),
    )
    const gap = Math.max(2, width - 4 - displayWidth(footerLeft) - displayWidth(clock))
    const urlLines =
      displayWidth(openLine) <= width - 4 ? [openLine] : wrapWidth(openLine, width - 4)
    return renderBox({
      title: modal.title,
      width,
      theme,
      sections: [
        {
          lines: [
            `${theme.rule('┌')}${theme.rule('─'.repeat(innerWidth))}${theme.rule('┐')}`,
            `${theme.rule('│')}  ${theme.bold(truncateWidth(spaced, innerWidth - 4))}  ${theme.rule('│')}  ${statusTag}`,
            `${theme.rule('└')}${theme.rule('─'.repeat(innerWidth))}${theme.rule('┘')}`,
            '',
            ...urlLines,
            '',
            `${footerLeft}${' '.repeat(gap)}${clock}`,
          ],
        },
      ],
    })
  }

  if (modal.kind === 'progress') {
    const width = Math.min(maxBoxWidth, 72)
    const lines: string[] = [modal.message]
    if (modal.code) {
      lines.push('', `初始化码：${theme.bold(plain(modal.code))}`)
    }
    for (const extra of modal.lines) {
      lines.push(...wrapWidth(extra, width - 6))
    }
    const hints: string[] = []
    if (modal.openUrl) hints.push(theme.keycap('o', '打开浏览器'))
    if (modal.code) hints.push(theme.keycap('y', '复制初始化码'))
    if (modal.cancellable) hints.push(theme.keycap('Esc', '中止等待'))
    if (hints.length) lines.push('', hints.join('  '))
    return renderBox({ title: modal.title, width, theme, sections: [{ lines }] })
  }

  // help
  const width = Math.min(maxBoxWidth, 76)
  const maxLines = Math.max(5, rows - 6)
  const wrapped: string[] = []
  for (const line of modal.lines) {
    wrapped.push(...(line ? wrapWidth(line, width - 6) : ['']))
  }
  return renderBox({
    title: modal.title,
    width,
    theme,
    sections: [{ lines: wrapped.slice(0, maxLines) }],
  })
}

function overlayModal(
  baseLines: string[],
  modal: TuiModal,
  cols: number,
  rows: number,
  theme: StrataTheme,
): string[] {
  const boxLines = buildModalBox(modal, cols, rows, theme).split('\n')
  const clippedBox =
    boxLines.length <= rows ? boxLines : [...boxLines.slice(0, rows - 1), boxLines.at(-1)!]
  const boxHeight = clippedBox.length
  const boxWidth = displayWidth(clippedBox[0] ?? '')
  const topRow = Math.max(0, Math.floor((rows - boxHeight) / 2))
  const leftCol = Math.max(0, Math.floor((cols - boxWidth) / 2))

  const out = [...baseLines]
  for (let i = 0; i < clippedBox.length; i++) {
    const r = topRow + i
    if (r >= rows) break
    const plainBg = stripAnsi(out[r] ?? '')
    const leftBg = slicePlainColumns(plainBg, 0, leftCol)
    const rightBg = slicePlainColumns(plainBg, leftCol + boxWidth, cols)
    const modalLine = theme.color ? theme.modalSurface(clippedBox[i]) : clippedBox[i]
    out[r] = `${theme.muted(leftBg)}${modalLine}${theme.muted(rightBg)}`
  }
  return out
}

export function renderTuiFrame(
  state: TuiState,
  cols: number,
  rows: number,
  theme: StrataTheme = createTheme({ color: true }),
): string[] {
  const safeCols = Math.max(48, cols)
  const safeRows = Math.max(12, rows)
  const wide = safeCols >= 84
  const leftWidth = wide ? Math.min(36, Math.max(28, Math.floor(safeCols * 0.34))) : safeCols
  const splitCol = wide ? leftWidth + 1 : undefined
  const [top0, top1] = renderTopBar(state, safeCols, theme, splitCol)
  const [bot0, bot1] = renderBottomBar(state, safeCols, theme, splitCol)
  const bodyRows = Math.max(4, safeRows - 4)

  const bodyLines: string[] = []
  if (wide) {
    const rightWidth = safeCols - leftWidth - 3
    const leftPane = renderClientList(state, leftWidth, bodyRows, theme)
    const rightPane = renderClientDetail(state, rightWidth, bodyRows, theme)
    const sep = theme.hairline(' │ ')
    const cross = theme.hairline('─┼─')
    for (let i = 0; i < bodyRows; i++) {
      bodyLines.push(
        `${fitWidth(leftPane[i] ?? '', leftWidth)}${i === 1 ? cross : sep}${fitWidth(rightPane[i] ?? '', rightWidth)}`,
      )
    }
  } else {
    const { visible } = visiblePlatformRows(state)
    const listHeight = Math.min(
      Math.max(4, Math.floor(bodyRows * 0.45)),
      Math.max(4, visible.length + 3),
    )
    const detailHeight = Math.max(2, bodyRows - listHeight - 1)
    bodyLines.push(...renderClientList(state, safeCols, listHeight, theme))
    bodyLines.push(theme.hairline('─'.repeat(safeCols)))
    bodyLines.push(...renderClientDetail(state, safeCols, detailHeight, theme))
  }

  const base = [top0, top1, ...bodyLines.slice(0, bodyRows), bot0, bot1]
  while (base.length < safeRows) base.push(' '.repeat(safeCols))
  return state.modal ? overlayModal(base, state.modal, safeCols, safeRows, theme) : base
}

type KeypressInput = Reader & {
  isRaw?: boolean
}

export async function runTui({
  env = process.env,
  cwd = process.cwd(),
  stdin = process.stdin,
  out = process.stdout,
  deps: customDeps = {},
  viewport: customViewport,
}: {
  env?: Env
  cwd?: string
  stdin?: Reader
  out?: ScreenStream
  deps?: Partial<TuiDeps>
  viewport?: ViewportScreen
} = {}): Promise<number> {
  const deps: TuiDeps = {
    ...DEFAULT_DEPS,
    ...customDeps,
    local: { ...DEFAULT_DEPS.local, ...customDeps.local },
  }
  const viewport = customViewport ?? createViewport(out)
  const theme = createTheme({ stream: out, env })

  const state: TuiState = {
    version: CLI_VERSION,
    url: null,
    server: null,
    platforms: [],
    selectedId: '',
    showUninstalled: false,
    listScroll: 0,
    detailScroll: 0,
    spinnerFrame: 0,
    busyLabel: null,
    toast: null,
    resultsById: {},
    pendingById: {},
    modal: null,
  }

  let settled = false
  let scanGen = 0
  let busy = false
  let modalHandler: ((str: string, key: LineInputKey) => void) | null = null
  let spinTimer: ReturnType<typeof setInterval> | null = null

  const syncSpinner = () => {
    const active =
      !settled &&
      Boolean(
        state.busyLabel || state.server?.checking || state.platforms.some((row) => row.checking),
      )
    if (active && !spinTimer) {
      spinTimer = setInterval(() => {
        state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length
        paint()
      }, 140)
      spinTimer.unref?.()
    } else if (!active && spinTimer) {
      clearInterval(spinTimer)
      spinTimer = null
    }
  }

  const paint = () => {
    if (settled) return
    syncSpinner()
    viewport.paint(renderTuiFrame(state, viewport.cols, viewport.rows, theme))
  }

  const setToast = (kind: TuiToast['kind'], text: string) => {
    state.toast = { kind, text }
    paint()
  }

  const syncSelected = () => {
    const { visible } = visiblePlatformRows(state)
    if (!visible.length) {
      state.selectedId = ''
      return
    }
    if (!visible.some((row) => row.id === state.selectedId)) {
      state.selectedId = visible[0].id
      state.detailScroll = 0
    }
  }

  const refreshAll = async () => {
    const gen = ++scanGen
    if (!state.url) state.url = await deps.defaultServerUrl(env)
    if (gen !== scanGen) return

    const url = state.url
    state.server = url ? { url, reachable: false, problem: null, checking: true } : null

    const ids = Object.keys(PLATFORMS)
    const locals = await Promise.all(ids.map((id) => deps.scanLocalPlatform(id, { env, cwd, url })))
    if (gen !== scanGen) return

    state.platforms = locals.map(({ row }) =>
      state.pendingById[row.id] ? { ...row, pending: state.pendingById[row.id] } : row,
    )
    syncSelected()
    paint()

    const tasks: Promise<void>[] = []
    if (url) {
      tasks.push(
        deps.serverHealth(url).then((health) => {
          if (gen !== scanGen) return
          state.server = { url, ...health }
          paint()
        }),
      )
    }

    for (const { row, config } of locals) {
      if (!config) continue
      tasks.push(
        deps.verifyPlatformRemote(row, config).then((verified) => {
          if (gen !== scanGen) return
          const idx = state.platforms.findIndex((p) => p.id === row.id)
          if (idx >= 0) {
            state.platforms[idx] = state.pendingById[row.id]
              ? { ...verified, pending: state.pendingById[row.id] }
              : verified
            paint()
          }
        }),
      )
    }
    await Promise.all(tasks)
  }

  const openTextModal = ({
    title,
    prompt,
    placeholder,
    initialValue = '',
    secret = false,
    validate,
  }: {
    title: string
    prompt: string
    placeholder?: string
    initialValue?: string
    secret?: boolean
    validate?: (value: string) => string | undefined
  }): Promise<string | null> =>
    new Promise((resolve) => {
      const modal: TuiModal = {
        kind: 'text',
        title,
        prompt,
        placeholder,
        secret,
        input: createLineInput(initialValue),
      }
      state.modal = modal
      paint()
      modalHandler = (str, key) => {
        const res = stepLineInput(modal.input, str, key)
        modal.input = res.state
        if (res.outcome === 'cancel') {
          modalHandler = null
          state.modal = null
          paint()
          resolve(null)
          return
        }
        if (res.outcome === 'submit') {
          const val = lineInputValue(modal.input)
          const problem = validate?.(val)
          if (problem) {
            modal.error = problem
            paint()
            return
          }
          modalHandler = null
          state.modal = null
          paint()
          resolve(val)
          return
        }
        modal.error = undefined
        paint()
      }
    })

  const openConfirmModal = ({
    title,
    lines,
    question,
    yesLabel = '确认',
    noLabel = '取消',
    initialValue = true,
    danger = false,
  }: {
    title: string
    lines: string[]
    question: string
    yesLabel?: string
    noLabel?: string
    initialValue?: boolean
    danger?: boolean
  }): Promise<boolean> =>
    new Promise((resolve) => {
      const modal: TuiModal = {
        kind: 'confirm',
        title,
        lines,
        question,
        yesLabel,
        noLabel,
        value: initialValue,
        danger,
      }
      state.modal = modal
      paint()
      const finish = (ok: boolean) => {
        modalHandler = null
        state.modal = null
        paint()
        resolve(ok)
      }
      modalHandler = (str, key) => {
        if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
          finish(false)
          return
        }
        if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || str === ' ') {
          modal.value = !modal.value
          paint()
        } else if (str === 'y' || str === 'Y') finish(true)
        else if (str === 'n' || str === 'N') finish(false)
        else if (key.name === 'return' || key.name === 'enter') finish(modal.value)
      }
    })

  const openMultiselectModal = ({
    title,
    prompt,
    options,
    initialValues = [],
    required = true,
  }: {
    title: string
    prompt: string
    options: Array<{ value: string; label: string; hint?: string }>
    initialValues?: string[]
    required?: boolean
  }): Promise<string[] | null> => {
    if (!options.length) return Promise.resolve([])
    return new Promise((resolve) => {
      const selected = new Set(initialValues)
      const modal: TuiModal = {
        kind: 'multiselect',
        title,
        prompt,
        options,
        selected: [...selected],
        cursor: 0,
        scroll: 0,
      }
      state.modal = modal
      paint()
      const finish = (vals: string[] | null) => {
        modalHandler = null
        state.modal = null
        paint()
        resolve(vals)
      }
      modalHandler = (str, key) => {
        if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
          finish(null)
          return
        }
        if (key.name === 'up' || str === 'k') {
          modal.cursor = (modal.cursor - 1 + options.length) % options.length
          const maxOpts = Math.max(3, viewport.rows - 9)
          if (modal.cursor < modal.scroll) modal.scroll = modal.cursor
          else if (modal.cursor >= modal.scroll + maxOpts) modal.scroll = modal.cursor - maxOpts + 1
          paint()
        } else if (key.name === 'down' || str === 'j') {
          modal.cursor = (modal.cursor + 1) % options.length
          const maxOpts = Math.max(3, viewport.rows - 9)
          if (modal.cursor < modal.scroll) modal.scroll = modal.cursor
          else if (modal.cursor >= modal.scroll + maxOpts) modal.scroll = modal.cursor - maxOpts + 1
          paint()
        } else if (key.name === 'space' || str === ' ') {
          const val = options[modal.cursor].value
          if (selected.has(val)) selected.delete(val)
          else selected.add(val)
          modal.selected = [...selected]
          modal.error = undefined
          paint()
        } else if (str === 'a') {
          if (selected.size === options.length) selected.clear()
          else options.forEach((opt) => selected.add(opt.value))
          modal.selected = [...selected]
          modal.error = undefined
          paint()
        } else if (key.name === 'return' || key.name === 'enter') {
          if (required && selected.size === 0) {
            modal.error = '至少选一项'
            paint()
            return
          }
          finish(options.filter((o) => selected.has(o.value)).map((o) => o.value))
        }
      }
    })
  }

  const openHelpModal = (): Promise<void> =>
    new Promise((resolve) => {
      state.modal = {
        kind: 'help',
        title: '操作说明与分工边界',
        lines: [
          '快捷键：',
          '  ↑ / ↓ 或 j / k      切换客户端',
          '  Enter / c           接入当前客户端（或重新授权已失效访问密钥）',
          '  a                   批量接入多个客户端（浏览器确认一次）',
          '  M                   迁移旧版客户端插件与已失效访问密钥',
          '  p                   自动安装或更新客户端插件并刷新工具缓存',
          '  d / D               诊断当前客户端 / 诊断全部已安装客户端（doctor）',
          '  i                   扫描并迁入当前客户端的本地记忆',
          '  x                   清理冲突的记忆工具（Lore 及常见记忆 MCP）',
          '  m                   停用 Claude Code 自带自动记忆',
          '  u                   断开当前客户端并恢复自带记忆',
          '  s / l               设置 Kioku 服务地址 / 启动本机 Docker 容器',
          '  o / y               在浏览器打开管理界面 / 复制安装命令或服务地址',
          '  Tab / [ / ] / r     展开未检出 / 滚动详情面板 / 重新扫描',
          '',
          '职责分工：',
          '  本控制台专注于本机客户端插件、配置文件与本地记忆迁移；',
          '  记忆目录编排、人格配置、访问密钥签发与凭据管理请按 [o] 在网页端操作。',
          '',
          '按任意键关闭说明',
        ],
      }
      paint()
      modalHandler = () => {
        modalHandler = null
        state.modal = null
        paint()
        resolve()
      }
    })

  const tuiAuthPrompt: DeviceAuthPrompt = async ({
    userCode,
    verificationUrl,
    expiresIn,
    open,
    browser,
    onCancel,
  }): Promise<DeviceWaitHandle> => {
    const cleanCode = plain(userCode)
    const cleanUrl = plain(verificationUrl)
    const modal: TuiModal = {
      kind: 'device-auth',
      title: '浏览器授权',
      userCode: cleanCode,
      verificationUrl: cleanUrl,
      remainingSec: expiresIn,
      codeCopied: false,
      linkCopied: false,
    }
    state.modal = modal
    paint()
    if (browser) open(cleanUrl)
    void deps.copy(cleanCode, { out, env }).then((res) => {
      if (res.ok && state.modal === modal) {
        modal.codeCopied = true
        paint()
      }
    })
    const timer = setInterval(() => {
      if (state.modal !== modal) return
      modal.remainingSec = Math.max(0, modal.remainingSec - 1)
      paint()
    }, 1000)
    timer.unref?.()

    let closed = false
    modalHandler = (str, key) => {
      if (closed) return
      if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
        onCancel()
        return
      }
      if (str === 'o' || str === 'O') {
        open(cleanUrl)
        return
      }
      if (str === 'c' || str === 'C') {
        void deps.copy(cleanUrl, { out, env }).then((res) => {
          if (res.ok && !closed && state.modal === modal) {
            modal.linkCopied = true
            paint()
          }
        })
      }
    }

    return {
      stop(finalMessage?: string) {
        if (closed) return
        closed = true
        clearInterval(timer)
        modalHandler = null
        if (state.modal === modal) state.modal = null
        if (finalMessage) setToast('ok', finalMessage)
        else paint()
      },
    }
  }

  const runProgress = async <T>(
    opts: {
      title: string
      message: string
      lines?: string[]
      code?: string | null
      openUrl?: string
      cancellable?: boolean
    },
    task: (ctl: {
      signal: AbortSignal
      update: (msg: string, lines?: string[]) => void
    }) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController()
    const modal: TuiModal = {
      kind: 'progress',
      title: opts.title,
      message: opts.message,
      lines: opts.lines ?? [],
      code: opts.code,
      openUrl: opts.openUrl,
      cancellable: opts.cancellable ?? true,
    }
    state.modal = modal
    paint()
    modalHandler = (str, key) => {
      if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
        if (modal.cancellable) controller.abort()
        return
      }
      if ((str === 'o' || str === 'O') && modal.openUrl) {
        deps.open(modal.openUrl)
        return
      }
      if ((str === 'y' || str === 'Y') && modal.code) {
        void deps.copy(modal.code, { out, env }).then((res) => {
          if (res.ok) setToast('ok', '已复制初始化码')
        })
      }
    }
    try {
      return await task({
        signal: controller.signal,
        update(msg, lines) {
          if (state.modal !== modal) return
          modal.message = msg
          if (lines !== undefined) modal.lines = lines
          paint()
        },
      })
    } finally {
      modalHandler = null
      if (state.modal === modal) state.modal = null
      paint()
    }
  }

  const connectIds = async (ids: string[], { reauth = false }: { reauth?: boolean } = {}) => {
    if (!ids.length || !state.url) return
    const rows = ids
      .map((id) => state.platforms.find((p) => p.id === id))
      .filter((r): r is PlatformRow => Boolean(r))
    if (!rows.length) return

    const plan = rows.map((row) => {
      const memory = row.memory === 'none' ? '' : '，停用自带的长期记忆'
      const conflicts = row.conflicts?.filter((c) => c.removable) ?? []
      const clean = conflicts.length ? `，先清理 ${conflictToolsText(conflicts)}` : ''
      const moved = row.otherServer && row.url ? `；原来接到 ${shownUrl(row.url)}` : ''
      return `${PLATFORMS[row.id].name}：签发访问密钥，写入配置${memory}${clean}${moved}`
    })

    const ok = await openConfirmModal({
      title: reauth ? '重新授权计划' : '接入计划',
      lines: [`服务器 ${shownUrl(state.url)}`, ...plan, '', '浏览器里确认一次，访问密钥不显示'],
      question: '开始执行？',
    })
    if (!ok) return

    state.busyLabel = '正在接入…'
    paint()
    try {
      const logBuf = bufferOut()
      const readyIds: string[] = []
      const preFailed: Array<{ id: string; status: 'failed'; reason: string }> = []
      for (const row of rows) {
        const conflicts = row.conflicts?.filter((c) => c.removable) ?? []
        if (!conflicts.length) {
          readyIds.push(row.id)
          continue
        }
        const cleanRes = await deps.removeConflicts(conflicts, { env, cwd, out: logBuf })
        if (cleanRes.some((r) => !r.ok)) {
          preFailed.push({ id: row.id, status: 'failed', reason: '清理冲突没有全部成功' })
        } else {
          readyIds.push(row.id)
        }
      }

      const results = readyIds.length
        ? await deps.connectPlatforms(
            { url: state.url, ids: readyIds },
            { env, out: logBuf, cwd, authPrompt: tuiAuthPrompt },
          )
        : []
      const allResults = [...preFailed, ...results]
      const done = allResults.filter((item) => item.status === 'connected').map((item) => item.id)

      if (!done.length) {
        const msgLines = resultsText(allResults).split('\n').filter(Boolean)
        for (const id of ids) {
          state.resultsById[id] = { title: '接入未完成', lines: msgLines }
          delete state.pendingById[id]
        }
        setToast('warn', '没有完成任何客户端接入')
        await refreshAll()
        return
      }

      for (const id of done) {
        delete state.pendingById[id]
        state.busyLabel = `正在为 ${PLATFORMS[id].name} 安装插件并验证握手…`
        paint()
        const lines: string[] = []
        const installRes = await deps.installPlugin(id, { env, cwd })
        lines.push(
          `${installRes.status === 'failed' ? '✗' : installRes.status === 'manual' ? '!' : '✓'} ${installRes.message}`,
        )
        if (installRes.status === 'manual') {
          const steps = await deps.pluginSteps([id], { env, cwd, url: state.url })
          if (steps) lines.push('', ...steps.split('\n'))
        }
        const cfg = await PLATFORMS[id].readConfig?.(env).catch(() => null)
        if (cfg) {
          const handshake = await deps.verifyConnectionHandshake(id, cfg, { env })
          lines.push(...formatHandshakeLines(handshake))
        }
        state.resultsById[id] = { title: '接入与连通性', lines }
      }
      for (const res of allResults.filter((r) => r.status !== 'connected')) {
        state.resultsById[res.id] = {
          title: '接入结果',
          lines: resultsText([res]).split('\n').filter(Boolean),
        }
      }
      await deps.rememberServerUrl(state.url, env).catch(() => {})
      setToast('ok', `已接入 ${done.map((id) => PLATFORMS[id].name).join('、')}`)
      await refreshAll()
    } finally {
      state.busyLabel = null
      paint()
    }
  }

  let onUnexpectedError: ((err: unknown) => void) | null = null

  const doAction = async (fn: () => Promise<void>) => {
    if (busy) return
    busy = true
    try {
      await fn()
    } catch (err) {
      if (err instanceof KiokuFailure) {
        setToast('error', err.message)
      } else {
        onUnexpectedError?.(err)
      }
    } finally {
      state.busyLabel = null
      busy = false
      paint()
    }
  }

  const actionServer = () =>
    doAction(async () => {
      const entered = await openTextModal({
        title: '设置服务地址',
        prompt: 'Kioku 的服务地址',
        placeholder: 'https://kioku.example.com',
        initialValue: state.url ?? '',
        validate: (text) => serverUrlProblem((text ?? '').trim().replace(/\/+$/, '')) ?? undefined,
      })
      if (entered === null) return
      const url = entered.trim().replace(/\/+$/, '')
      state.busyLabel = `正在检查 ${shownUrl(url)}…`
      paint()
      const health = await deps.serverHealth(url)
      state.busyLabel = null
      if (!health.reachable) {
        const keep = await openConfirmModal({
          title: '服务器暂时无法连接',
          lines: [`地址：${shownUrl(url)}`, `原因：${health.problem ?? '未知错误'}`],
          question: '仍然保留这个服务地址？',
          initialValue: false,
          danger: true,
        })
        if (!keep) return
      }
      state.url = url
      state.pendingById = {}
      await deps.rememberServerUrl(url, env).catch(() => {})
      setToast('ok', `已切换到 ${shownUrl(url)}`)
      await refreshAll()
    })

  const actionEnter = () =>
    doAction(async () => {
      const row = selectedRowOf(state)
      if (!row) return
      if (!state.url || !state.server) {
        setToast('warn', '请先按 [s] 设置服务地址，或按 [l] 在本机启动 Kioku')
        return
      }
      if (!state.server.reachable) {
        setToast('warn', '服务器当前无法连接，可按 [s] 更换地址或 [l] 检查本机容器')
        return
      }
      if (state.server.needsSetup) {
        setToast('warn', '服务端尚未初始化管理员，请按 [o] 打开网页完成初始化')
        return
      }
      if (row.connection === 'invalid') {
        await connectIds([row.id], { reauth: true })
        return
      }
      if (row.connection === 'ok' && !row.otherServer) {
        if (row.plugin === false) {
          await actionPluginInternal(row)
        } else {
          setToast('info', `${row.name} 已接入；可按 [d] 诊断或 [p] 更新插件`)
        }
        return
      }
      if (!PLATFORMS[row.id].setup) {
        setToast('info', `${row.name} 需在对应插件设置中填写访问密钥`)
        return
      }
      await connectIds([row.id])
    })

  const actionBatchConnect = () =>
    doAction(async () => {
      if (!isServerReady(state.server)) {
        setToast('warn', '请先确保服务端已连接并完成初始化')
        return
      }
      const panelState: PanelState = { server: state.server, platforms: state.platforms }
      const candidates = connectCandidates(panelState)
      if (!candidates.length) {
        setToast('info', '没有待接入的客户端')
        return
      }
      const picked = await openMultiselectModal({
        title: '批量接入客户端',
        prompt: '选择要接入的客户端（浏览器内一次确认）：',
        options: candidates.map((row) => {
          const presence = effectivePresence(row)
          const hint =
            presence === 'installed'
              ? row.installKind === 'ide'
                ? '编辑器扩展'
                : undefined
              : presence === 'config-only'
                ? '仅发现配置，未找到程序'
                : '本机未检出'
          return {
            value: row.id,
            label: row.name,
            ...(hint ? { hint } : {}),
          }
        }),
        initialValues: candidates
          .filter((r) => effectivePresence(r) === 'installed')
          .map((r) => r.id),
      })
      if (!picked || !picked.length) return
      await connectIds(picked)
    })

  const actionPluginInternal = async (row: PlatformRow) => {
    const upgrade = row.plugin === true
    if (upgrade) {
      const ok = await openConfirmModal({
        title: `更新 ${row.name} 插件`,
        lines: ['将执行插件更新流程并刷新本地 MCP 工具清单缓存。'],
        question: '确认执行？',
      })
      if (!ok) return
    }
    state.busyLabel = `正在${upgrade ? '更新' : '安装'} ${row.name} 插件…`
    paint()
    const res = await deps.installPlugin(row.id, { env, cwd, upgrade })
    const lines: string[] = [
      `${res.status === 'failed' ? '✗' : res.status === 'manual' ? '!' : '✓'} ${res.message}`,
    ]
    if (res.commands?.length && res.status === 'manual') {
      lines.push('', '请手动运行：', ...res.commands.map((cmd) => `  ${cmd}`))
      if (res.after) lines.push('', res.after)
    }
    const cfg = await PLATFORMS[row.id].readConfig?.(env).catch(() => null)
    if (cfg) {
      const handshake = await deps.verifyConnectionHandshake(row.id, cfg, { env })
      lines.push(...formatHandshakeLines(handshake))
    }
    state.resultsById[row.id] = { title: '插件与连通性', lines }
    setToast(res.status === 'failed' ? 'error' : 'ok', res.message)
    await refreshAll()
  }

  const actionPlugin = () =>
    doAction(async () => {
      const row = selectedRowOf(state)
      if (!row) return
      await actionPluginInternal(row)
    })

  const actionDoctor = (all: boolean) =>
    doAction(async () => {
      const row = selectedRowOf(state)
      if (!all && !row) return
      state.busyLabel = all ? '正在巡检全部客户端…' : `正在诊断 ${row!.name}…`
      paint()
      const buf = bufferOut()
      const exitCode = await deps.doctor([all ? '--all' : row!.id], { env, out: buf, cwd })
      const lines = buf.text().split('\n')
      if (all) {
        const targetId = row?.id ?? state.platforms[0]?.id ?? 'all'
        state.resultsById[targetId] = { title: '全量诊断报告（doctor --all）', lines }
      } else if (row) {
        state.resultsById[row.id] = { title: '诊断报告（doctor）', lines }
      }
      state.detailScroll = 0
      setToast(
        exitCode === 0 ? 'ok' : 'warn',
        exitCode === 0 ? '诊断通过' : '诊断发现需要注意的项目',
      )
    })

  const actionImport = () =>
    doAction(async () => {
      const row = selectedRowOf(state)
      if (!row) return
      const platform = PLATFORMS[row.id]
      if (!platform.source) {
        setToast('info', `${row.name} 没有可迁移的本地记忆来源`)
        return
      }
      if (!isServerReady(state.server)) {
        setToast('warn', '请先确保服务端已连接并可用')
        return
      }
      let config: TargetConfig | null = platform.readConfig ? await platform.readConfig(env) : null
      if (!config) {
        config = await deps.loadConfig(env).catch(() => null)
        if ((!config || (state.url && config.url !== state.url)) && state.url) {
          const secret = await openTextModal({
            title: `填写 ${row.name} 访问密钥`,
            prompt: `${row.name} 所属接入实例的访问密钥（记忆将写入其主场记忆圈）`,
            secret: true,
            validate: (text) => keyFormatError((text ?? '').trim()) ?? undefined,
          })
          if (secret === null) return
          config = { url: state.url, key: secret.trim() }
        }
      }
      if (!config) throw new KiokuFailure(`尚未给 ${row.name} 配过访问密钥：请先接入`)

      state.busyLabel = `正在比对 ${row.name} 的本地记忆…`
      paint()
      const planBuf = bufferOut()
      const plan = await deps.planImport(config, { from: platform.source }, { env, out: planBuf })
      state.busyLabel = null

      if (plan.empty) {
        state.pendingById[row.id] = { pending: 0 }
        state.resultsById[row.id] = { title: '本地迁移比对', lines: ['没有可迁移的本地记忆'] }
        setToast('info', '没有可迁移的本地记忆')
        await refreshAll()
        return
      }
      state.pendingById[row.id] = pendingOf(plan)
      const planLines = planBuf.text().split('\n').filter(Boolean)
      state.resultsById[row.id] = { title: '本地迁移计划', lines: planLines }

      if (!plan.todo.length) {
        setToast('ok', '本地记忆均已与服务端同步，无需写入')
        await refreshAll()
        return
      }
      const ok = await openConfirmModal({
        title: `迁移 ${row.name} 本地记忆`,
        lines: planLines,
        question: `写入这 ${plan.todo.length} 条记忆？`,
      })
      if (!ok) {
        await refreshAll()
        return
      }
      state.busyLabel = `正在写入 ${plan.todo.length} 条记忆…`
      paint()
      const writeBuf = bufferOut()
      const code = await deps.writeImport(config, plan, { out: writeBuf })
      delete state.pendingById[row.id]
      state.resultsById[row.id] = {
        title: '迁移结果',
        lines: writeBuf.text().split('\n').filter(Boolean),
      }
      setToast(
        code === 0 ? 'ok' : 'warn',
        code === 0 ? '本地记忆迁移完成' : '部分记忆未写入，请看右侧详情',
      )
      await refreshAll()
    })

  const actionMigrateLegacy = () =>
    doAction(async () => {
      if (!state.url || !isServerReady(state.server)) {
        setToast('warn', '请先确保服务端已连接并完成迁移与初始化')
        return
      }
      state.busyLabel = '正在生成旧版迁移计划…'
      paint()
      const plan = await deps.planMigration(state.url, { env, cwd })
      state.busyLabel = null
      if (!plan.items.length) {
        setToast('info', '本机已接入客户端均已是最新，无需迁移')
        paint()
        return
      }
      const previewLines = renderMigrationPlan(plan, { columns: Math.min(80, viewport.cols - 6) })
        .split('\n')
        .filter(Boolean)
      const ok = await openConfirmModal({
        title: '旧版客户端迁移计划',
        lines: previewLines,
        question: '确认执行以上迁移？',
      })
      if (!ok) return

      state.busyLabel = '正在迁移旧版客户端…'
      paint()
      const buf = bufferOut()
      const code = await deps.migrateCommand(
        [...plan.items.map((item) => item.id), '--server-url', state.url, '-y'],
        {
          env,
          cwd,
          out: buf,
          open: deps.open,
          authPrompt: tuiAuthPrompt,
        },
      )
      const lines = buf.text().split('\n').filter(Boolean)
      for (const item of plan.items) {
        state.resultsById[item.id] = { title: '旧版迁移结果', lines }
      }
      setToast(
        code === 0 ? 'ok' : 'warn',
        code === 0 ? '旧版客户端迁移完成' : '部分客户端迁移未完成，请看右侧详情',
      )
      await refreshAll()
    })

  const actionClean = () =>
    doAction(async () => {
      const row = selectedRowOf(state)
      const conflicted = state.platforms.filter((p) => p.conflicts?.some((c) => c.removable))
      if (!conflicted.length) {
        setToast('info', '未检测到可自动清理的冲突工具')
        return
      }
      let targetIds: string[]
      if (row?.conflicts?.some((c) => c.removable)) {
        targetIds = [row.id]
      } else if (conflicted.length === 1) {
        targetIds = [conflicted[0].id]
      } else {
        const picked = await openMultiselectModal({
          title: '选择要清理冲突的客户端',
          prompt: '以下客户端存在可自动卸载的冲突记忆工具：',
          options: conflicted.map((p) => ({
            value: p.id,
            label: p.name,
            hint: conflictToolsText(p.conflicts!.filter((c) => c.removable)),
          })),
          initialValues: conflicted.map((p) => p.id),
        })
        if (!picked || !picked.length) return
        targetIds = picked
      }
      const items = state.platforms
        .filter((p) => targetIds.includes(p.id))
        .flatMap((p) => p.conflicts!.filter((c) => c.removable))
      const ok = await openConfirmModal({
        title: '清理冲突记忆工具',
        lines: formatConflicts(items, PLATFORMS),
        question: `清理这 ${items.length} 项冲突？`,
        danger: true,
      })
      if (!ok) return

      state.busyLabel = '正在清理冲突…'
      paint()
      const buf = bufferOut()
      const res = await deps.removeConflicts(items, { env, cwd, out: buf })
      const failed = res.some((r) => !r.ok)
      for (const id of targetIds) {
        state.resultsById[id] = {
          title: '冲突清理结果',
          lines: buf.text().split('\n').filter(Boolean),
        }
      }
      setToast(
        failed ? 'error' : 'ok',
        failed ? '部分冲突未清理成功' : '冲突已清理，重启对应客户端后生效',
      )
      await refreshAll()
    })

  const actionClaudeMemory = () =>
    doAction(async () => {
      const row = selectedRowOf(state)
      if (!canDisableClaudeMemory(row)) {
        setToast('info', '当前无需单独停用 Claude Code 自动记忆')
        return
      }
      const preview = bufferOut()
      await deps.setup(['claude-code', '--dry-run'], {
        env,
        out: preview,
        cwd,
        login: null,
        skipConflicts: true,
      })
      const planText = preview.text().replace(/\n?没有写入（--dry-run）$/, '')
      const ok = await openConfirmModal({
        title: '停用 Claude Code 自动记忆',
        lines: planText.split('\n'),
        question: '确认写入设置？',
      })
      if (!ok) return
      const runBuf = bufferOut()
      await deps.setup(['claude-code'], { env, out: runBuf, cwd, login: null, skipConflicts: true })
      state.resultsById['claude-code'] = {
        title: '自动记忆设置',
        lines: runBuf.text().split('\n').filter(Boolean),
      }
      setToast('ok', '已停用 Claude Code 自带自动记忆')
      await refreshAll()
    })

  const actionDisable = () =>
    doAction(async () => {
      const row = selectedRowOf(state)
      if (!row || !canDisable(row)) {
        setToast('info', '当前选中客户端尚未接入，无需断开')
        return
      }
      const preview = bufferOut()
      await deps.setup([row.id, '--undo', '--dry-run'], {
        env,
        out: preview,
        cwd,
        login: null,
        skipConflicts: true,
      })
      const lines = preview
        .text()
        .replace(/\n?没有写入（--dry-run）$/, '')
        .split('\n')
      if (row.id === 'agy') {
        lines.push('同时清理托管安装的 Antigravity 插件目录（非托管目录保留不动）')
      }
      const ok = await openConfirmModal({
        title: `断开 ${row.name}`,
        lines,
        question: `确认断开 ${row.name} 并恢复自带记忆？`,
        danger: true,
      })
      if (!ok) return

      state.busyLabel = `正在断开 ${row.name}…`
      paint()
      const runBuf = bufferOut()
      await deps.setup([row.id, '--undo'], {
        env,
        out: runBuf,
        cwd,
        login: null,
        skipConflicts: true,
      })
      if (row.id === 'agy' && (await deps.removeManagedAgyPlugin({ env }))) {
        runBuf.write('✓ 已移除托管安装的 Antigravity 插件目录\n')
      }
      delete state.pendingById[row.id]
      state.resultsById[row.id] = {
        title: '已断开接入',
        lines: runBuf.text().split('\n').filter(Boolean),
      }
      setToast('ok', `已断开 ${row.name}`)
      await refreshAll()
    })

  const awaitLocalSetup = async (dir: string, code: string | null): Promise<boolean> => {
    const lines = code
      ? [
          `已在浏览器打开 ${LOCAL_URL}，或手动打开后输入上面的初始化码建立第一个管理员。`,
          '（若找不到初始化码，可按 Esc 后运行 kioku local logs 查看）',
        ]
      : [`已在浏览器打开 ${LOCAL_URL}。初始化码可查看：kioku local logs --dir ${dir}`]
    deps.open(LOCAL_URL)
    return runProgress(
      {
        title: '等待管理员初始化',
        message: `等待在 ${LOCAL_URL} 建好管理员…`,
        lines,
        code,
        openUrl: LOCAL_URL,
        cancellable: true,
      },
      ({ signal }) =>
        deps.local.waitUntil(() => deps.local.setupDone(LOCAL_URL), {
          timeoutMs: 60 * 60_000,
          intervalMs: 3000,
          signal,
        }),
    )
  }

  const actionLocal = () =>
    doAction(async () => {
      const local = deps.local
      if (await local.healthy(LOCAL_URL)) {
        state.url = LOCAL_URL
        await deps.rememberServerUrl(LOCAL_URL, env).catch(() => {})
        setToast('ok', `本机 ${LOCAL_PORT} 端口已有 Kioku 运行，已切换地址`)
        await refreshAll()
        return
      }
      if (!(await local.hasCompose(env))) {
        throw new KiokuFailure('没有找到 docker compose：先装好 Docker（含 compose 插件）再来')
      }
      const rawDir = await openTextModal({
        title: '本机启动 Kioku（Docker）',
        prompt: '部署目录',
        initialValue: defaultLocalDir(env),
        validate: (text) => ((text ?? '').trim() ? undefined : '目录不能为空'),
      })
      if (rawDir === null) return
      const dir = expandDir(rawDir.trim(), env)
      const existing = await local.composeState(dir, env)
      let code: string | null

      if (existing === 'running') {
        const up = await runProgress(
          { title: '本机 Kioku 容器', message: '等待容器健康检查通过…' },
          ({ signal }) =>
            local.waitUntil(() => local.healthy(LOCAL_URL), { timeoutMs: 180_000, signal }),
        )
        if (!up) {
          throw new KiokuFailure(
            `Kioku 在 3 分钟内没有就绪：运行 kioku local logs --dir ${dir} 看原因`,
          )
        }
        code = await local.setupCodeIn(dir)
      } else if (existing === 'stopped') {
        const ok = await openConfirmModal({
          title: '启动本机 Kioku',
          lines: [`目录：${dir}`, '该目录已有配置，将执行 docker compose up -d。'],
          question: '立即启动？',
        })
        if (!ok) return
        const up = await runProgress(
          { title: '启动本机 Kioku', message: '正在运行 docker compose up -d…' },
          async ({ signal, update }) => {
            await local.composeUp(dir, env)
            update('等待 Kioku 就绪…')
            return local.waitUntil(() => local.healthy(LOCAL_URL), { timeoutMs: 180_000, signal })
          },
        )
        if (!up) {
          throw new KiokuFailure(
            `Kioku 在 3 分钟内没有就绪：运行 kioku local logs --dir ${dir} 看原因`,
          )
        }
        code = await local.setupCodeIn(dir)
      } else {
        if (await local.portBusy(LOCAL_PORT)) {
          throw new KiokuFailure(
            `端口 ${LOCAL_PORT} 被别的程序占用：先停掉对应进程，或修改 compose.yaml 端口后手动启动`,
          )
        }
        state.busyLabel = '正在获取最新版本信息…'
        paint()
        const release = await local.latestRelease()
        state.busyLabel = null
        const ok = await openConfirmModal({
          title: '准备本机 Kioku 部署',
          lines: [
            `目录：${dir}`,
            `版本：${release.imageTag}${release.release ? '（最新正式版）' : `（未取到正式版：${release.problem}，退回 edge）`}`,
            `下载 ${release.ref} 的 compose.yaml 与 .env.example（已有文件不覆盖）`,
            `生成随机密钥写入 .env，端口仅绑定 127.0.0.1:${LOCAL_PORT}`,
          ],
          question: '开始准备并启动？',
        })
        if (!ok) return

        let prepared
        try {
          prepared = await local.prepareDir(dir, release)
        } catch (err) {
          if (err instanceof KiokuFailure) {
            const target = selectedRowOf(state)?.id ?? state.platforms[0]?.id
            if (target) {
              state.resultsById[target] = {
                title: '手动下载部署文件',
                lines: manualDownload(dir, release.ref).split('\n'),
              }
            }
          }
          throw err
        }
        code = prepared.env.setupCode
        if (prepared.env.written) {
          const target = selectedRowOf(state)?.id ?? state.platforms[0]?.id
          if (target) {
            state.resultsById[target] = {
              title: '本机 Kioku 部署提示',
              lines: [
                `! 主密钥保存在 ${prepared.env.file} 的 KIOKU_MASTER_KEY`,
                '  请另外备份该密钥，并与数据库备份分开放；丢失将无法解开机密记忆与托管凭据。',
              ],
            }
          }
        }
        const up = await runProgress(
          {
            title: '启动本机 Kioku',
            message: '正在执行 docker compose up -d（首次拉取镜像可能需要几分钟）…',
            lines: prepared.env.written
              ? [`主密钥保存在 ${prepared.env.file}（KIOKU_MASTER_KEY），请另外备份。`]
              : [`已沿用现有的 ${prepared.env.file}`],
          },
          async ({ signal, update }) => {
            await local.composeUp(dir, env)
            update('等待 Kioku 健康检查通过…')
            return local.waitUntil(() => local.healthy(LOCAL_URL), { timeoutMs: 180_000, signal })
          },
        )
        if (!up) {
          throw new KiokuFailure(
            `Kioku 在 3 分钟内没有就绪：运行 kioku local logs --dir ${dir} 看原因`,
          )
        }
      }

      state.url = LOCAL_URL
      await deps.rememberServerUrl(LOCAL_URL, env).catch(() => {})
      let readyToConnect = await local.setupDone(LOCAL_URL)
      if (!readyToConnect) {
        readyToConnect = await awaitLocalSetup(dir, code)
      }
      await refreshAll()
      if (readyToConnect) {
        setToast('ok', '本机 Kioku 已就绪，可按 [a] 批量接入客户端')
      } else {
        setToast('warn', '已退出等待初始化；完成管理员创建后按 [r] 刷新')
      }
    })

  const moveSelection = (delta: number) => {
    const { visible, uninstalledCount } = visiblePlatformRows(state)
    if (!visible.length) return
    const idx = visible.findIndex((row) => row.id === state.selectedId)
    const cur = idx >= 0 ? idx : 0
    const next = (cur + delta + visible.length) % visible.length
    state.selectedId = visible[next].id
    state.detailScroll = 0

    const bodyRows = Math.max(4, viewport.rows - 4)
    const listHeight =
      viewport.cols >= 84
        ? bodyRows
        : Math.min(Math.max(4, Math.floor(bodyRows * 0.45)), Math.max(4, visible.length + 3))
    const itemSlots = Math.max(1, listHeight - 2 - (uninstalledCount > 0 ? 1 : 0))
    if (next < state.listScroll) state.listScroll = next
    else if (next >= state.listScroll + itemSlots) state.listScroll = next - itemSlots + 1
    paint()
  }

  const handleGlobalKey = (str: string, key: LineInputKey, done: (code: number) => void) => {
    if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || str === 'q' || str === 'Q') {
      done(0)
      return
    }
    if (key.name === 'escape') {
      if (state.toast) {
        state.toast = null
        paint()
      }
      return
    }
    if (busy) return

    if (key.name === 'up' || str === 'k') {
      moveSelection(-1)
      return
    }
    if (key.name === 'down' || str === 'j') {
      moveSelection(1)
      return
    }
    if (key.name === 'tab') {
      state.showUninstalled = !state.showUninstalled
      syncSelected()
      paint()
      return
    }
    if (str === '[' || key.name === 'pageup') {
      state.detailScroll = Math.max(0, state.detailScroll - 4)
      paint()
      return
    }
    if (str === ']' || key.name === 'pagedown') {
      const cap = detailMaxScroll(state, viewport.cols, viewport.rows, theme)
      state.detailScroll = Math.min(cap, state.detailScroll + 4)
      paint()
      return
    }
    if (key.name === 'return' || key.name === 'enter' || str === 'c') {
      void actionEnter()
      return
    }
    if (str === 'a') {
      void actionBatchConnect()
      return
    }
    if (str === 'M') {
      void actionMigrateLegacy()
      return
    }
    if (str === 'p') {
      void actionPlugin()
      return
    }
    if (str === 'd') {
      void actionDoctor(false)
      return
    }
    if (str === 'D') {
      void actionDoctor(true)
      return
    }
    if (str === 'i') {
      void actionImport()
      return
    }
    if (str === 'x') {
      void actionClean()
      return
    }
    if (str === 'm') {
      void actionClaudeMemory()
      return
    }
    if (str === 'u') {
      void actionDisable()
      return
    }
    if (str === 's') {
      void actionServer()
      return
    }
    if (str === 'l') {
      void actionLocal()
      return
    }
    if (str === 'o') {
      if (!state.url) setToast('warn', '请先按 [s] 设置服务器地址')
      else {
        const target =
          state.server?.mismatch === 'legacy' ? upgradePageOf(state.url) : shownUrl(state.url)
        deps.open(target)
        setToast('ok', `已在浏览器打开 ${target}`)
      }
      return
    }
    if (str === 'y') {
      const row = selectedRowOf(state)
      const cmds = row ? PLATFORMS[row.id].install.commands : []
      const text = cmds.length ? cmds.join(' && ') : state.url
      if (!text) {
        setToast('info', '当前没有可复制的命令或地址')
        return
      }
      void deps.copy(text, { out, env }).then((res) => {
        if (res.ok)
          setToast('ok', cmds.length ? '已复制安装命令到剪贴板' : '已复制服务地址到剪贴板')
        else setToast('warn', '未能写入系统剪贴板，请直接用鼠标框选复制')
      })
      return
    }
    if (str === 'r') {
      void doAction(async () => {
        setToast('info', '正在重新扫描…')
        await refreshAll()
        state.toast = null
      })
      return
    }
    if (str === '?') {
      void openHelpModal()
    }
  }

  viewport.enter()
  const ttyIn = stdin as KeypressInput
  const wasRaw = ttyIn.isRaw ?? false
  emitKeypressEvents(ttyIn as unknown as NodeJS.ReadableStream)
  try {
    if (ttyIn.isTTY) ttyIn.setRawMode?.(true)
  } catch {
    // 忽略非原生 TTY
  }
  ttyIn.resume?.()

  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      if (settled) return false
      settled = true
      if (spinTimer) {
        clearInterval(spinTimer)
        spinTimer = null
      }
      ttyIn.off?.('keypress', onKeypress)
      ttyIn.off?.('end', onEnd)
      ttyIn.off?.('error', onEnd)
      if (out.isTTY && typeof out.off === 'function') {
        out.off('resize', onResize)
      }
      try {
        if (ttyIn.isTTY) ttyIn.setRawMode?.(wasRaw)
      } catch {
        // 终端已关闭
      }
      ttyIn.pause?.()
      viewport.dispose()
      return true
    }

    const finish = (code: number) => {
      if (cleanup()) resolve(code)
    }

    onUnexpectedError = (err: unknown) => {
      if (cleanup()) reject(err)
    }

    const onKeypress = (...args: unknown[]) => {
      if (settled) return
      const str = typeof args[0] === 'string' ? args[0] : ''
      const key = (args[1] as LineInputKey | undefined) ?? {}
      if (modalHandler) {
        modalHandler(str, key)
        return
      }
      handleGlobalKey(str, key, finish)
    }

    const onResize = () => {
      viewport.resetDiff()
      paint()
    }

    const onEnd = () => finish(0)

    ttyIn.on?.('keypress', onKeypress)
    ttyIn.once?.('end', onEnd)
    ttyIn.once?.('error', onEnd)
    if (out.isTTY && typeof out.on === 'function') {
      out.on('resize', onResize)
    }

    paint()
    void refreshAll().catch((err) => onUnexpectedError?.(err))
  })
}
