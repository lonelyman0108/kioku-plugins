import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { osc52Sequence, osc8Link } from '../ui/clipboard.ts'
import {
  formatCountdown,
  renderDeviceAuthBox,
  spacedCode,
  startDeviceAuthWait,
} from '../ui/prompts.ts'
import { createScreen } from '../ui/screen.ts'
import {
  capabilityLabel,
  createTheme,
  layerLabel,
  renderBox,
  sensitivityBadge,
  supportsColor,
} from '../ui/theme.ts'
import { displayWidth, padEndWidth, stripAnsi, truncateWidth, wrapWidth } from '../ui/width.ts'

describe('ui/width', () => {
  it('正确计算中英文混排、ANSI 转义与表情符号的终端显示宽度', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('中文123')).toBe(7)
    expect(displayWidth('\x1b[31m红色\x1b[0m')).toBe(4)
    expect(displayWidth('\x1b]8;;https://kioku.example.com\x07链接\x1b]8;;\x07')).toBe(4)
    expect(stripAnsi('\x1b[1m粗体\x1b[0m')).toBe('粗体')
  })

  it('按视觉宽度对齐、截断与自动换行', () => {
    expect(padEndWidth('通用', 8)).toBe('通用    ')
    expect(truncateWidth('通用记忆标题超长测试', 10)).toBe('通用记忆…')
    expect(wrapWidth('你好世界测试', 8)).toEqual(['你好世界', '测试'])
  })
})

describe('ui/theme', () => {
  it('遵守 NO_COLOR / TERM=dumb 与 TTY 色彩开关', () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(supportsColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true)
    expect(supportsColor({ isTTY: false }, {})).toBe(false)
    const plainTheme = createTheme({ color: false })
    expect(plainTheme.error('失败')).toBe('失败')
  })

  it('提供规范的归属名、敏感级纹理与细线方框排版', () => {
    expect(layerLabel('core')).toBe('通用')
    expect(layerLabel('user')).toBe('本人')
    expect(sensitivityBadge('public')).toBe('[ ] 公开')
    expect(sensitivityBadge('internal')).toBe('[·] 内部')
    expect(sensitivityBadge('private')).toBe('[╱] 私密')
    expect(sensitivityBadge('secret')).toBe('[■] 机密')
    expect(capabilityLabel('use')).toBe('取用')

    const box = renderBox({
      title: '面板',
      width: 36,
      sections: [{ lines: ['第一行 中文对齐'] }, { title: '次级', lines: ['第二段'] }],
    })
    const lines = box.split('\n')
    expect(lines[0]).toMatch(/^┌─ 面板 ─+┐$/)
    expect(lines.at(-1)).toMatch(/^└─+┘$/)
    for (const line of lines) {
      expect(displayWidth(line)).toBe(36)
    }
  })
})

describe('ui/screen', () => {
  it('使用局部重绘控制序列而不进入 Alternate Screen，并支持光标恢复', () => {
    let written = ''
    const screen = createScreen({
      isTTY: true,
      columns: 80,
      write: (chunk) => {
        written += String(chunk)
      },
    })
    screen.hideCursor()
    screen.render('行1\n行2')
    screen.render('行A\n行B')
    screen.commit('完成')
    screen.dispose()
    expect(written).not.toContain('\x1b[?1049h')
    expect(written).toContain('\x1b[?25l')
    expect(written).toContain('\x1b[2A\r\x1b[J')
    expect(written).toContain('\x1b[?25h')
  })
})

describe('ui/clipboard & deviceAuthBox', () => {
  it('生成 OSC 8 超链接与 OSC 52 剪贴板序列', () => {
    expect(osc8Link('https://kioku.example.com', '打开', { enabled: true })).toBe(
      '\x1b]8;;https://kioku.example.com\x07打开\x1b]8;;\x07',
    )
    expect(osc8Link('https://kioku.example.com', '打开', { enabled: false })).toBe('打开')
    expect(osc52Sequence('ABCD-1234')).toBe(
      `\x1b]52;c;${Buffer.from('ABCD-1234').toString('base64')}\x07`,
    )
  })

  it('渲染宽松确认码方框与倒计时，并响应交互按键 [o] / [c] / [Esc]', async () => {
    expect(spacedCode('ABCD-1234')).toBe('A B C D - 1 2 3 4')
    expect(formatCountdown(598)).toBe('09:58')

    const rendered = renderDeviceAuthBox({
      userCode: 'ABCD-1234',
      verificationUrl: 'https://kioku.example.com/authorize',
      remainingSec: 598,
      codeCopied: true,
      linkCopied: false,
      theme: createTheme({ color: false }),
    })
    expect(rendered).toContain('A B C D - 1 2 3 4')
    expect(rendered).toContain('确认码已复制')
    expect(rendered).toContain('[o] 打开浏览器')
    expect(rendered).toContain('[c] 复制链接')
    expect(rendered).toContain('[Esc] 取消')
    expect(rendered).toContain('09:58')

    const ttyIn = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    })
    let outText = ''
    const out = {
      isTTY: true,
      columns: 80,
      write: (chunk: string | Uint8Array) => {
        outText += String(chunk)
      },
    }
    const opened: string[] = []
    const copied: string[] = []
    let cancelled = false

    const handle = await startDeviceAuthWait({
      userCode: 'ABCD-1234',
      verificationUrl: 'https://kioku.example.com/authorize',
      expiresIn: 600,
      out,
      stdin: ttyIn as unknown as NodeJS.ReadStream,
      open: (url) => opened.push(url),
      browser: false,
      interactive: true,
      copy: async (text) => {
        copied.push(text)
        return { ok: true, method: 'native' }
      },
      onCancel: () => {
        cancelled = true
      },
    })

    ttyIn.emit('keypress', 'o', { name: 'o' })
    ttyIn.emit('keypress', 'c', { name: 'c' })
    await Promise.resolve()
    ttyIn.emit('keypress', '\x1b', { name: 'escape' })
    handle.stop()

    expect(opened).toEqual(['https://kioku.example.com/authorize'])
    expect(copied).toEqual(['ABCD-1234', 'https://kioku.example.com/authorize'])
    expect(cancelled).toBe(true)
    expect(outText).toContain('A B C D - 1 2 3 4')
  })
})
