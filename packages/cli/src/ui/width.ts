// 终端显示宽度计算与排版工具：剥离或保留 ANSI 转义序列、按字素簇准确计算 CJK 全角与表情符号列宽，
// 提供按视觉列宽补齐、保留样式截断、自动换行与任意列区间精确截取，确保 Strata 框线与弹出层严丝合缝。

/* eslint-disable no-control-regex */
const ANSI_PATTERN =
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-9;?]*[ -/]*[@-~]|P[^\u001b]*\u001b\\|.)/g
const SGR_PATTERN = /^\u001b\[([0-9;]*)m$/
const OSC8_PATTERN = /^\u001b\]8;[^;]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)$/
/* eslint-enable no-control-regex */

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

function isZeroWidthCode(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
}

function isWideCode(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x3247) ||
      (code >= 0x3250 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) ||
      (code >= 0xa960 && code <= 0xa97f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b001) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x20000 && code <= 0x3fffd))
  )
}

const PICTOGRAPHIC = /\p{Emoji_Presentation}/u
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u
const VARIATION_WIDE = /\uFE0F/

export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0
  if (PICTOGRAPHIC.test(grapheme) || REGIONAL_INDICATOR.test(grapheme)) return 2
  const first = grapheme.codePointAt(0)
  if (first === undefined) return 0
  if (isZeroWidthCode(first)) return 0
  if (VARIATION_WIDE.test(grapheme) && first <= 0x2fff) return 2
  return isWideCode(first) ? 2 : 1
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text)
  let total = 0
  for (const { segment } of segmenter.segment(plain)) {
    total += graphemeWidth(segment)
  }
  return total
}

export function padEndWidth(text: string, width: number, fill = ' '): string {
  const diff = width - displayWidth(text)
  if (diff <= 0) return text
  return text + fill.repeat(diff)
}

export function padStartWidth(text: string, width: number, fill = ' '): string {
  const diff = width - displayWidth(text)
  if (diff <= 0) return text
  return fill.repeat(diff) + text
}

type AnsiToken = { kind: 'ansi'; seq: string } | { kind: 'text'; text: string }

function tokenizeAnsi(text: string): AnsiToken[] {
  const tokens: AnsiToken[] = []
  ANSI_PATTERN.lastIndex = 0
  let last = 0
  for (const match of text.matchAll(ANSI_PATTERN)) {
    const idx = match.index ?? 0
    if (idx > last) tokens.push({ kind: 'text', text: text.slice(last, idx) })
    tokens.push({ kind: 'ansi', seq: match[0] })
    last = idx + match[0].length
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) })
  return tokens
}

interface StyleState {
  sgr: string[]
  osc8: string | null
}

function updateStyle(style: StyleState, seq: string): void {
  const sgr = SGR_PATTERN.exec(seq)
  if (sgr) {
    const raw = sgr[1]
    if (raw === '' || raw === '0') {
      style.sgr = []
      return
    }
    const parts = raw.split(';')
    if (parts[0] === '0') {
      style.sgr = []
      const rest = parts.slice(1).filter(Boolean)
      if (rest.length) style.sgr.push(`\x1b[${rest.join(';')}m`)
      return
    }
    style.sgr.push(seq)
    return
  }
  const osc8 = OSC8_PATTERN.exec(seq)
  if (osc8) {
    style.osc8 = osc8[1] ? seq : null
  }
}

function closeStyleSuffix(style: StyleState): string {
  let suffix = ''
  if (style.osc8) suffix += '\x1b]8;;\x07'
  if (style.sgr.length) suffix += '\x1b[0m'
  return suffix
}

function reopenStylePrefix(style: StyleState): string {
  return `${style.sgr.join('')}${style.osc8 ?? ''}`
}

export function truncateWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return ''
  if (displayWidth(text) <= maxWidth) return text
  const suffixWidth = displayWidth(ellipsis)
  if (suffixWidth >= maxWidth) {
    let out = ''
    let used = 0
    for (const { segment } of segmenter.segment(stripAnsi(ellipsis))) {
      const w = graphemeWidth(segment)
      if (used + w > maxWidth) break
      out += segment
      used += w
    }
    return out
  }
  const budget = maxWidth - suffixWidth
  const style: StyleState = { sgr: [], osc8: null }
  let out = ''
  let used = 0
  let truncated = false

  for (const token of tokenizeAnsi(text)) {
    if (token.kind === 'ansi') {
      if (budget > 0) {
        out += token.seq
        updateStyle(style, token.seq)
      }
      continue
    }
    for (const { segment } of segmenter.segment(token.text)) {
      const w = graphemeWidth(segment)
      if (used + w > budget) {
        truncated = true
        break
      }
      out += segment
      used += w
    }
    if (truncated) break
  }

  return `${out}${closeStyleSuffix(style)}${ellipsis}`
}

export function fitWidth(text: string, width: number): string {
  if (width <= 0) return ''
  return padEndWidth(truncateWidth(text, width), width)
}

export function wrapWidth(text: string, maxWidth: number): string[] {
  const target = Math.max(8, maxWidth)
  const lines: string[] = []
  const style: StyleState = { sgr: [], osc8: null }

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) {
      lines.push('')
      continue
    }
    let current = reopenStylePrefix(style)
    let used = 0
    let hasVisible = false

    for (const token of tokenizeAnsi(rawLine)) {
      if (token.kind === 'ansi') {
        current += token.seq
        updateStyle(style, token.seq)
        continue
      }
      for (const { segment } of segmenter.segment(token.text)) {
        const w = graphemeWidth(segment)
        if (used + w > target && hasVisible) {
          lines.push(`${current}${closeStyleSuffix(style)}`)
          current = reopenStylePrefix(style)
          used = 0
          hasVisible = false
        }
        current += segment
        used += w
        if (w > 0) hasVisible = true
      }
    }
    lines.push(`${current}${closeStyleSuffix(style)}`)
  }
  return lines
}

// 按视觉列区间 [startCol, endCol) 精确切出纯文本片段；被切开的双列字符以单个空格补齐宽度
export function slicePlainColumns(plainText: string, startCol: number, endCol: number): string {
  const targetWidth = endCol - startCol
  if (targetWidth <= 0) return ''
  const clean = stripAnsi(plainText)
  let out = ''
  let outWidth = 0
  let col = 0

  for (const { segment } of segmenter.segment(clean)) {
    const w = graphemeWidth(segment)
    if (w === 0) continue
    const segStart = col
    const segEnd = col + w
    col = segEnd
    if (segEnd <= startCol) continue
    if (segStart >= endCol) break
    if (segStart >= startCol && segEnd <= endCol) {
      out += segment
      outWidth += w
    } else {
      const overlap = Math.min(segEnd, endCol) - Math.max(segStart, startCol)
      out += ' '.repeat(overlap)
      outWidth += overlap
    }
  }

  if (outWidth < targetWidth) {
    out += ' '.repeat(targetWidth - outWidth)
  }
  return out
}
