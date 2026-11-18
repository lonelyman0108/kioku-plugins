// Strata 终端视觉规范：细线直角框、归属色彩与文字标签并重、敏感级纯字符纹理、砖红作为唯一告警/错误强调色。
// 遵循 NO_COLOR / FORCE_COLOR / TERM=dumb 与 TTY 检测。

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

export interface StrataTheme {
  color: boolean
  ink: (text: string) => string
  bold: (text: string) => string
  muted: (text: string) => string
  rule: (text: string) => string
  accent: (text: string) => string
  ok: (text: string) => string
  warn: (text: string) => string
  error: (text: string) => string
  layer: (layer: string, text?: string) => string
}

const LAYER_LABELS: Record<string, string> = {
  core: '通用',
  persona: '人格',
  app: '应用',
  user: '本人',
  subject: '联系人',
  episode: '会话',
}

// 低饱和度地层 ANSI 颜色（均配合归属文字标签显示，不单独依赖颜色传递信息）
const LAYER_CODES: Record<string, string> = {
  episode: '\x1b[38;5;103m',
  subject: '\x1b[38;5;138m',
  user: '\x1b[38;5;73m',
  app: '\x1b[38;5;108m',
  persona: '\x1b[38;5;144m',
  core: '\x1b[38;5;246m',
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
}: {
  stream?: { isTTY?: boolean }
  env?: Env
  color?: boolean
} = {}): StrataTheme {
  const enabled = color ?? supportsColor(stream, env)
  const wrap = (code: string) => (text: string) => (enabled ? `${code}${text}\x1b[0m` : text)
  return {
    color: enabled,
    ink: (text) => text,
    bold: wrap('\x1b[1m'),
    muted: wrap('\x1b[2m'),
    rule: wrap('\x1b[90m'),
    accent: wrap('\x1b[1m'),
    ok: wrap('\x1b[38;5;71m'),
    warn: wrap('\x1b[2m'),
    // 砖红只给错误与危险确认
    error: wrap('\x1b[38;5;167m'),
    layer(layerName: string, text?: string) {
      const label = text ?? LAYER_LABELS[layerName] ?? layerName
      const code = LAYER_CODES[layerName]
      return enabled && code ? `${code}${label}\x1b[0m` : label
    },
  }
}

export function layerLabel(layer: string): string {
  return LAYER_LABELS[layer] ?? layer
}

export function sensitivityBadge(sensitivity: string, theme?: StrataTheme): string {
  const item = SENSITIVITY_BADGES[sensitivity]
  const text = item ? `${item.mark} ${item.label}` : `[?] ${sensitivity}`
  return theme ? theme.muted(text) : text
}

export function capabilityLabel(cap: string | undefined): string {
  return CAPABILITY_NAMES[cap ?? 'none'] ?? (cap || '不可用')
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
  if (title) {
    const label = ` ${title} `
    const rest = Math.max(1, inner - displayWidth(label) - 1)
    out.push(`${border('┌─')}${theme.bold(label)}${border(`${'─'.repeat(rest)}┐`)}`)
  } else {
    out.push(border(`┌${'─'.repeat(inner)}┐`))
  }

  sections.forEach((sec, idx) => {
    if (idx > 0) {
      if (sec.title) {
        const label = ` ${sec.title} `
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
