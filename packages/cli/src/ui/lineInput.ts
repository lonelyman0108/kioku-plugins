// 零依赖字素簇行输入引擎：按中文/表情字素簇移动光标与删除，支持左右键、Home/End、Ctrl+U/K 与水平窗口滚动。
// 供流式终端提示（prompts.ts）与全屏 TUI 弹出层输入框共用。

import { createTheme, type StrataTheme } from './theme.ts'
import { graphemeWidth, truncateWidth } from './width.ts'

export interface LineInputKey {
  name?: string
  ctrl?: boolean
  meta?: boolean
}

export interface LineInputState {
  segments: string[]
  cursor: number
}

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

export function splitGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (item) => item.segment)
}

export function createLineInput(initialValue = ''): LineInputState {
  const segments = splitGraphemes(initialValue)
  return { segments, cursor: segments.length }
}

export function lineInputValue(state: LineInputState): string {
  return state.segments.join('')
}

export function stepLineInput(
  state: LineInputState,
  str: string,
  key: LineInputKey = {},
): { state: LineInputState; outcome?: 'submit' | 'cancel' } {
  if (key.name === 'return' || key.name === 'enter') {
    return { state, outcome: 'submit' }
  }
  if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
    return { state, outcome: 'cancel' }
  }
  if (key.name === 'left' || (key.ctrl && key.name === 'b')) {
    return {
      state: { segments: state.segments, cursor: Math.max(0, state.cursor - 1) },
    }
  }
  if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
    return {
      state: {
        segments: state.segments,
        cursor: Math.min(state.segments.length, state.cursor + 1),
      },
    }
  }
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
    return { state: { segments: state.segments, cursor: 0 } }
  }
  if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
    return { state: { segments: state.segments, cursor: state.segments.length } }
  }
  if (key.name === 'backspace') {
    if (state.cursor === 0) return { state }
    const segments = [
      ...state.segments.slice(0, state.cursor - 1),
      ...state.segments.slice(state.cursor),
    ]
    return { state: { segments, cursor: state.cursor - 1 } }
  }
  if (key.name === 'delete') {
    if (state.cursor >= state.segments.length) return { state }
    const segments = [
      ...state.segments.slice(0, state.cursor),
      ...state.segments.slice(state.cursor + 1),
    ]
    return { state: { segments, cursor: state.cursor } }
  }
  if (key.ctrl && key.name === 'u') {
    return { state: { segments: state.segments.slice(state.cursor), cursor: 0 } }
  }
  if (key.ctrl && key.name === 'k') {
    return { state: { segments: state.segments.slice(0, state.cursor), cursor: state.cursor } }
  }
  if (key.ctrl && key.name === 'w') {
    if (state.cursor === 0) return { state }
    let nextCursor = state.cursor
    while (nextCursor > 0 && /^\s$/u.test(state.segments[nextCursor - 1])) nextCursor--
    while (nextCursor > 0 && !/^\s$/u.test(state.segments[nextCursor - 1])) nextCursor--
    return {
      state: {
        segments: [...state.segments.slice(0, nextCursor), ...state.segments.slice(state.cursor)],
        cursor: nextCursor,
      },
    }
  }
  if (str && !key.ctrl && !key.meta) {
    const clean = str.replace(/\p{Cc}/gu, '')
    if (clean) {
      const inserted = splitGraphemes(clean)
      const segments = [
        ...state.segments.slice(0, state.cursor),
        ...inserted,
        ...state.segments.slice(state.cursor),
      ]
      return { state: { segments, cursor: state.cursor + inserted.length } }
    }
  }
  return { state }
}

export function renderLineWindow(
  state: LineInputState,
  {
    placeholder = '',
    maxWidth,
    mask,
    showCursor = false,
    theme = createTheme({ color: false }),
  }: {
    placeholder?: string
    maxWidth: number
    mask?: string
    showCursor?: boolean
    theme?: StrataTheme
  },
): { text: string; cursorCol: number } {
  const limit = Math.max(1, maxWidth)
  const displaySegs = mask ? state.segments.map(() => mask) : state.segments

  if (displaySegs.length === 0) {
    if (!showCursor) {
      return {
        text: placeholder ? theme.muted(truncateWidth(placeholder, limit)) : '',
        cursorCol: 0,
      }
    }
    const cursorCell = theme.color ? '\x1b[7m \x1b[27m' : '|'
    const restPlaceholder =
      placeholder && limit > 1 ? theme.muted(truncateWidth(placeholder, limit - 1)) : ''
    return { text: `${cursorCell}${restPlaceholder}`, cursorCol: 0 }
  }

  const widths = displaySegs.map((seg) => graphemeWidth(seg))
  const cursorReserve = showCursor
    ? theme.color
      ? state.cursor === displaySegs.length
        ? 1
        : 0
      : 1
    : 0
  const budget = Math.max(1, limit - cursorReserve)
  const targetEnd = state.cursor < displaySegs.length ? state.cursor + 1 : state.cursor

  let start = targetEnd
  let used = 0
  while (start > 0) {
    const nextW = widths[start - 1]
    if (used + nextW > budget && start <= state.cursor) break
    start--
    used += nextW
  }

  let end = targetEnd
  while (end < displaySegs.length && used + widths[end] <= budget) {
    used += widths[end]
    end++
  }

  let cursorCol = 0
  for (let i = start; i < state.cursor; i++) cursorCol += widths[i]

  const before = displaySegs.slice(start, state.cursor).join('')
  if (!showCursor) {
    const after = displaySegs.slice(state.cursor, end).join('')
    return { text: `${before}${after}`, cursorCol }
  }

  if (theme.color) {
    if (state.cursor < displaySegs.length) {
      const under = `\x1b[7m${displaySegs[state.cursor]}\x1b[27m`
      const after = displaySegs.slice(state.cursor + 1, end).join('')
      return { text: `${before}${under}${after}`, cursorCol }
    }
    return { text: `${before}\x1b[7m \x1b[27m`, cursorCol }
  }

  const after = displaySegs.slice(state.cursor, end).join('')
  return { text: `${before}|${after}`, cursorCol }
}
