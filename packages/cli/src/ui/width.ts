// 终端显示宽度计算与排版工具：剥离 ANSI 转义序列、按字素簇准确计算 CJK 全角与表情符号列宽，
// 提供按视觉列宽补齐、截断与自动换行，确保 Strata 框线在含中文与终端链接的输出里严丝合缝。

/* eslint-disable no-control-regex */
const ANSI_PATTERN =
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-9;?]*[ -/]*[@-~]|P[^\u001b]*\u001b\\|.)/g
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

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
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

export function truncateWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return ''
  if (displayWidth(text) <= maxWidth) return text
  const suffixWidth = displayWidth(ellipsis)
  if (suffixWidth >= maxWidth) {
    return Array.from(segmenter.segment(ellipsis))
      .slice(0, maxWidth)
      .map((s) => s.segment)
      .join('')
  }
  const budget = maxWidth - suffixWidth
  const plain = stripAnsi(text)
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(plain)) {
    const w = graphemeWidth(segment)
    if (used + w > budget) break
    out += segment
    used += w
  }
  return `${out}${ellipsis}`
}

export function wrapWidth(text: string, maxWidth: number): string[] {
  const target = Math.max(8, maxWidth)
  const lines: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) {
      lines.push('')
      continue
    }
    let current = ''
    let used = 0
    for (const { segment } of segmenter.segment(stripAnsi(rawLine))) {
      const w = graphemeWidth(segment)
      if (used + w > target && current) {
        lines.push(current)
        current = segment
        used = w
      } else {
        current += segment
        used += w
      }
    }
    lines.push(current)
  }
  return lines
}
