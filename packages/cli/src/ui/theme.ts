// Strata 终端视觉规范：细线直角框、归属色彩与文字标签并重、敏感级纯字符纹理、砖红作为唯一告警/错误强调色。
// 遵循 NO_COLOR / FORCE_COLOR / TERM=dumb 与 TTY 检测。

import { plain } from '../core.ts'
import type { Env } from '../types.ts'
import { displayWidth, padEndWidth, truncateWidth } from './width.ts'

export function supportsColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: Env = process.env,
): boolean {
  if ((env.NO_COLOR ?? '') !== '' || env.TERM === 'dumb') return false
  if ((env.FORCE_COLOR ?? '') !== '' && env.FORCE_COLOR !== '0') return true
  return Boolean(stream?.isTTY)
}

export function supportsTrueColor(env: Env = process.env): boolean {
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return true
  if ((env.WT_SESSION ?? '') !== '') return true
  const prog = (env.TERM_PROGRAM ?? '').toLowerCase()
  return ['vscode', 'ghostty', 'iterm.app', 'wezterm', 'alacritty', 'rio', 'hyper'].includes(prog)
}

export interface StrataTheme {
  color: boolean
  trueColor: boolean
  ink: (text: string) => string
  bold: (text: string) => string
  muted: (text: string) => string
  rule: (text: string) => string
  hairline: (text: string) => string
  accent: (text: string) => string
  ok: (text: string) => string
  warn: (text: string) => string
  error: (text: string) => string
  kind: (kind: string, text?: string) => string
  kindChip: (kind: string, text?: string) => string
  barSurface: (text: string) => string
  selectedSurface: (text: string) => string
  subtleSurface: (text: string) => string
  modalSurface: (text: string) => string
  brandStamp: (text: string) => string
  keycap: (key: string, label: string) => string
}

export const ENTRY_KIND_ORDER = ['episode', 'fact', 'entry'] as const
export const STRATA_BANDS = [
  'episode',
  'fact',
  'personal',
  'shared-away',
  'persona',
  'primary',
] as const

const ENTRY_KIND_RANK = new Map<string, number>(ENTRY_KIND_ORDER.map((k, i) => [k, i]))

export function sortEntryKinds(kinds: readonly string[]): string[] {
  return [...kinds].sort((a, b) => (ENTRY_KIND_RANK.get(a) ?? 99) - (ENTRY_KIND_RANK.get(b) ?? 99))
}

export function bandForKind(kind: string, circleKind?: 'personal' | 'shared'): string {
  if (kind === 'entry') return circleKind === 'personal' ? 'personal' : 'primary'
  return kind
}

const KIND_LABELS: Record<string, string> = {
  entry: '正式记忆',
  fact: '联系人事实',
  episode: '会话摘要',
  personal: '个人圈记忆',
  'shared-away': '关联圈记忆',
  persona: '独立人格',
  primary: '主圈记忆',
}

// 低饱和度地层 ANSI 颜色（均配合归属文字标签显示，不单独依赖颜色传递信息）
const KIND_CODES_256: Record<string, string> = {
  episode: '\x1b[38;5;189m',
  fact: '\x1b[38;5;146m',
  personal: '\x1b[38;5;180m',
  'shared-away': '\x1b[38;5;144m',
  persona: '\x1b[38;5;108m',
  primary: '\x1b[38;5;109m',
  entry: '\x1b[38;5;109m',
}

const KIND_CODES_TRUE: Record<string, string> = {
  entry: '\x1b[38;2;159;181;193m',
  primary: '\x1b[38;2;159;181;193m',
  persona: '\x1b[38;2;156;187;168m',
  'shared-away': '\x1b[38;2;186;199;148m',
  personal: '\x1b[38;2;216;196;143m',
  fact: '\x1b[38;2;180;169;197m',
  episode: '\x1b[38;2;202;195;213m',
}

/* eslint-disable no-control-regex */
const SGR_RESET_RE = /\x1b\[0?m/g
/* eslint-enable no-control-regex */

function paintSurface(bgCode: string, fgCode: string): (text: string) => string {
  return (text: string) => {
    const restored = text.replace(SGR_RESET_RE, () => `\x1b[0m${bgCode}${fgCode}`)
    return `${bgCode}${fgCode}${restored}\x1b[0m`
  }
}

const SENSITIVITY_BADGES: Record<string, { mark: string; label: string }> = {
  public: { mark: '[ ]', label: '公开' },
  internal: { mark: '[·]', label: '内部' },
  private: { mark: '[╱]', label: '私密' },
  secret: { mark: '[■]', label: '机密' },
}

const CAPABILITY_NAMES: Record<string, string> = {
  none: '不可用',
  use: '取用',
  manage: '管理',
}

export function createTheme({
  stream = process.stdout,
  env = process.env,
  color,
  trueColor,
}: {
  stream?: { isTTY?: boolean }
  env?: Env
  color?: boolean
  trueColor?: boolean
} = {}): StrataTheme {
  const enabled = color ?? supportsColor(stream, env)
  const tc = enabled && (trueColor ?? supportsTrueColor(env))
  const wrap = (code: string) => (text: string) => (enabled ? `${code}${text}\x1b[0m` : text)
  const pick = (trueCode: string, code256: string) => (tc ? trueCode : code256)
  const kindMap = tc ? KIND_CODES_TRUE : KIND_CODES_256

  const kind = (kindName: string, text?: string) => {
    const label = text ?? KIND_LABELS[kindName] ?? plain(kindName)
    const code = kindMap[kindName]
    return enabled && code ? `${code}${label}\x1b[0m` : label
  }

  const keyBg = pick('\x1b[48;2;46;53;58m', '\x1b[48;5;237m')
  const keyFg = pick('\x1b[38;2;240;241;235m', '\x1b[38;5;255m')
  const keyLabelFg = pick('\x1b[38;2;162;166;163m', '\x1b[38;5;247m')
  const stampBg = pick('\x1b[48;2;45;52;56m', '\x1b[48;5;237m')
  const stampFg = pick('\x1b[38;2;232;213;156m', '\x1b[38;5;222m')

  return {
    color: enabled,
    trueColor: tc,
    ink: (text) => text,
    bold: wrap('\x1b[1m'),
    muted: wrap('\x1b[2m'),
    rule: wrap('\x1b[90m'),
    hairline: wrap(pick('\x1b[38;2;61;70;75m', '\x1b[38;5;239m')),
    // 焦点与状态提示使用加粗墨色，保持砖红为唯一的彩色强调色
    accent: wrap('\x1b[1m'),
    ok: wrap(pick('\x1b[38;2;143;194;161m', '\x1b[38;5;108m')),
    warn: wrap(pick('\x1b[38;2;216;181;107m', '\x1b[38;5;179m')),
    // 砖红只给错误与危险确认
    error: wrap(pick('\x1b[38;2;232;139;110m', '\x1b[38;5;167m')),
    kind,
    kindChip(kindName: string, text?: string) {
      const label = text ?? KIND_LABELS[kindName] ?? plain(kindName)
      return enabled ? kind(kindName, `■ ${label}`) : `[${label}]`
    },
    barSurface: enabled
      ? paintSurface(
          pick('\x1b[48;2;32;38;42m', '\x1b[48;5;235m'),
          pick('\x1b[38;2;227;228;221m', '\x1b[38;5;254m'),
        )
      : (text) => text,
    selectedSurface: enabled
      ? paintSurface(
          pick('\x1b[48;2;51;59;64m', '\x1b[48;5;237m'),
          pick('\x1b[38;2;240;241;235m', '\x1b[38;5;255m'),
        )
      : (text) => text,
    subtleSurface: enabled
      ? paintSurface(
          pick('\x1b[48;2;28;34;38m', '\x1b[48;5;234m'),
          pick('\x1b[38;2;213;216;210m', '\x1b[38;5;252m'),
        )
      : (text) => text,
    modalSurface: enabled
      ? paintSurface(
          pick('\x1b[48;2;32;38;42m', '\x1b[48;5;235m'),
          pick('\x1b[38;2;227;228;221m', '\x1b[38;5;254m'),
        )
      : (text) => text,
    brandStamp(text: string) {
      return enabled ? `${stampBg}${stampFg} ${text} \x1b[0m` : `[${text}]`
    },
    keycap(key: string, label: string) {
      if (!enabled) return `[${key}] ${label}`
      return `\x1b[1m${keyBg}${keyFg} ${key} \x1b[0m ${keyLabelFg}${label}\x1b[0m`
    },
  }
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? plain(kind)
}

export function sensitivityBadge(sensitivity: string, theme?: StrataTheme): string {
  const item = SENSITIVITY_BADGES[sensitivity]
  const text = item ? `${item.mark} ${item.label}` : `[?] ${plain(sensitivity)}`
  if (!theme) return text
  return sensitivity === 'secret' ? theme.bold(text) : theme.muted(text)
}

export function capabilityLabel(cap: string | undefined): string {
  return CAPABILITY_NAMES[cap ?? 'none'] ?? (cap ? plain(cap) : '不可用')
}

export interface BoxSection {
  title?: string
  lines: string[]
}

export function renderBox({
  title,
  sections,
  width,
  theme = createTheme({ color: false }),
}: {
  title?: string
  sections: BoxSection[]
  width?: number
  theme?: StrataTheme
}): string {
  const maxContent = Math.max(
    title ? displayWidth(title) + 4 : 16,
    ...sections.flatMap((s) => [
      s.title ? displayWidth(s.title) + 4 : 0,
      ...s.lines.map((line) => displayWidth(line)),
    ]),
  )
  const inner = Math.max(24, (width ?? maxContent + 4) - 2)
  const border = (s: string) => theme.rule(s)

  const out: string[] = []
  const maxTitleWidth = Math.max(4, inner - 4)
  if (title) {
    const label = ` ${truncateWidth(title, maxTitleWidth)} `
    const rest = Math.max(1, inner - displayWidth(label) - 1)
    out.push(`${border('┌─')}${theme.bold(label)}${border(`${'─'.repeat(rest)}┐`)}`)
  } else {
    out.push(border(`┌${'─'.repeat(inner)}┐`))
  }

  sections.forEach((sec, idx) => {
    if (idx > 0) {
      if (sec.title) {
        const label = ` ${truncateWidth(sec.title, maxTitleWidth)} `
        const rest = Math.max(1, inner - displayWidth(label) - 1)
        out.push(`${border('├─')}${theme.muted(label)}${border(`${'─'.repeat(rest)}┤`)}`)
      } else {
        out.push(border(`├${'┄'.repeat(inner)}┤`))
      }
    }
    for (const line of sec.lines) {
      const clipped = truncateWidth(line, inner - 2)
      out.push(`${border('│')} ${padEndWidth(clipped, inner - 2)} ${border('│')}`)
    }
  })

  out.push(border(`└${'─'.repeat(inner)}┘`))
  return out.join('\n')
}
