import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { encodeWin32Clipboard, osc52Sequence, osc8Link } from '../ui/clipboard.ts'
import {
  createLineInput,
  lineInputValue,
  renderLineWindow,
  stepLineInput,
} from '../ui/lineInput.ts'
import {
  createBuiltinPrompts,
  formatCountdown,
  renderDeviceAuthBox,
  spacedCode,
  startDeviceAuthWait,
} from '../ui/prompts.ts'
import { createScreen } from '../ui/screen.ts'
import {
  capabilityLabel,
  createTheme,
  kindLabel,
  renderBox,
  sensitivityBadge,
  supportsColor,
  supportsTrueColor,
} from '../ui/theme.ts'
import { createViewport } from '../ui/viewport.ts'
import {
  displayWidth,
  fitWidth,
  padEndWidth,
  slicePlainColumns,
  stripAnsi,
  truncateWidth,
  wrapWidth,
} from '../ui/width.ts'

describe('ui/width', () => {
  it('正确计算中英文混排、ANSI 转义与表情符号的终端显示宽度', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('中文123')).toBe(7)
    expect(displayWidth('\x1b[31m红色\x1b[0m')).toBe(4)
    expect(displayWidth('\x1b]8;;https://kioku.example.com\x07链接\x1b]8;;\x07')).toBe(4)
    expect(stripAnsi('\x1b[1m粗体\x1b[0m')).toBe('粗体')
  })

  it('按视觉宽度对齐、截断与自动换行，并保留样式与精确列切片', () => {
    expect(padEndWidth('通用', 8)).toBe('通用    ')
    expect(truncateWidth('通用记忆标题超长测试', 10)).toBe('通用记忆…')
    expect(wrapWidth('你好世界测试', 8)).toEqual(['你好世界', '测试'])

    const colored = '\x1b[38;5;71m绿色长文本测试\x1b[0m'
    const cutColor = truncateWidth(colored, 7)
    expect(cutColor).toBe('\x1b[38;5;71m绿色长\x1b[0m…')
    expect(displayWidth(cutColor)).toBe(7)

    const linked = '\x1b]8;;https://kioku.example.com\x07打开链接地址\x1b]8;;\x07'
    const cutLink = truncateWidth(linked, 5)
    expect(cutLink).toBe('\x1b]8;;https://kioku.example.com\x07打开\x1b]8;;\x07…')
    expect(displayWidth(cutLink)).toBe(5)

    expect(fitWidth('中文', 6)).toBe('中文  ')
    expect(fitWidth('中文超长', 5)).toBe('中文…')

    expect(wrapWidth('\x1b[2m第一段和第二段\x1b[0m', 8)).toEqual([
      '\x1b[2m第一段和\x1b[0m',
      '\x1b[2m第二段\x1b[0m',
    ])

    expect(slicePlainColumns('你好世界', 0, 1)).toBe(' ')
    expect(slicePlainColumns('你好世界', 1, 7)).toBe(' 好世 ')
    expect(slicePlainColumns('你好世界', 7, 8)).toBe(' ')
  })
})

describe('ui/theme', () => {
  it('遵守 NO_COLOR / TERM=dumb 与 TTY 色彩开关', () => {
    expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(supportsColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
    expect(supportsColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true)
    expect(supportsColor({ isTTY: false }, {})).toBe(false)
    expect(supportsTrueColor({ COLORTERM: 'truecolor' })).toBe(true)
    expect(supportsTrueColor({ WT_SESSION: 'wt-1' })).toBe(true)
    expect(supportsTrueColor({ TERM: 'xterm-256color' })).toBe(false)

    const plainTheme = createTheme({ color: false })
    expect(plainTheme.error('失败')).toBe('失败')
    expect(plainTheme.brandStamp('記 憶')).toBe('[記 憶]')
    expect(plainTheme.kindChip('entry')).toBe('[正式词条]')
    expect(plainTheme.keycap('Enter', '接入')).toBe('[Enter] 接入')

    const tcTheme = createTheme({ color: true, env: { COLORTERM: 'truecolor' } })
    expect(tcTheme.trueColor).toBe(true)
    expect(tcTheme.warn('注意')).toContain('\x1b[38;2;216;181;107m')
    expect(tcTheme.warn('注意')).not.toBe('\x1b[2m注意\x1b[0m')
    expect(displayWidth(tcTheme.kindChip('entry'))).toBe(displayWidth('■ 正式词条'))

    const theme256 = createTheme({ color: true, env: { TERM: 'xterm-256color' } })
    expect(theme256.trueColor).toBe(false)
    expect(theme256.warn('注意')).toContain('\x1b[38;5;179m')

    // 内嵌状态色彩重置后，表面背景应自动恢复且不改变视觉宽度
    const inner = `  ${tcTheme.ok('●')} 正常  ${tcTheme.muted('说明')}  `
    const row = tcTheme.selectedSurface(inner)
    expect(displayWidth(row)).toBe(displayWidth(inner))
    expect(row).toContain('\x1b[0m\x1b[48;2;51;59;64m\x1b[38;2;240;241;235m')
    expect(row.endsWith('\x1b[0m')).toBe(true)
  })

  it('提供规范的物种名、敏感级纹理与细线方框排版', () => {
    expect(kindLabel('entry')).toBe('正式词条')
    expect(kindLabel('fact')).toBe('联系人事实')
    expect(kindLabel('episode')).toBe('会话摘要')
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
    const winBuf = encodeWin32Clipboard('C:\\用户\\kioku\\中文')
    expect(winBuf[0]).toBe(0xff)
    expect(winBuf[1]).toBe(0xfe)
    expect(winBuf.subarray(2).toString('utf16le')).toBe('C:\\用户\\kioku\\中文')
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

describe('ui/lineInput & prompts', () => {
  it('按字素簇处理中文双列退格、光标左右移动、中间插入与多字粘贴', () => {
    let state = createLineInput('你好世界')
    state = stepLineInput(state, '', { name: 'backspace' }).state
    expect(lineInputValue(state)).toBe('你好世')

    state = stepLineInput(state, '', { name: 'left' }).state
    state = stepLineInput(state, '啊').state
    expect(lineInputValue(state)).toBe('你好啊世')

    state = stepLineInput(state, '', { name: 'home' }).state
    state = stepLineInput(state, '', { name: 'delete' }).state
    expect(lineInputValue(state)).toBe('好啊世')

    state = stepLineInput(state, '', { name: 'end' }).state
    state = stepLineInput(state, '测试粘贴').state
    expect(lineInputValue(state)).toBe('好啊世测试粘贴')

    const win = renderLineWindow(state, { maxWidth: 8, showCursor: true })
    expect(displayWidth(win.text)).toBeLessThanOrEqual(8)
    expect(win.text).toContain('|')

    state = stepLineInput(state, ' hello').state
    state = stepLineInput(state, '\x17', { name: 'w', ctrl: true }).state
    expect(lineInputValue(state)).toBe('好啊世测试粘贴 ')
    state = stepLineInput(state, '\x17', { name: 'w', ctrl: true }).state
    expect(lineInputValue(state)).toBe('')
  })

  it('text 提示框用整行重绘代替单列退格，避免中文退格错位', async () => {
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
        return true
      },
    }
    vi.stubEnv('TERM', 'xterm-256color')
    vi.stubEnv('NO_COLOR', '')
    try {
      const prompts = createBuiltinPrompts(ttyIn as unknown as NodeJS.ReadStream, out)
      const pending = prompts.text({ message: '输入目录' })

      ttyIn.emit('keypress', '中', { name: '中' })
      ttyIn.emit('keypress', '文', { name: '文' })
      ttyIn.emit('keypress', '', { name: 'backspace' })
      ttyIn.emit('keypress', '字', { name: '字' })
      ttyIn.emit('keypress', '\r', { name: 'return' })

      await expect(pending).resolves.toBe('中字')
      expect(outText).not.toContain('\b \b')
      expect(outText).toContain('\r\x1b[K\x1b[90m│\x1b[0m  中\r\x1b[5C')
      expect(outText).toContain('\r\x1b[K\x1b[90m│\x1b[0m  中字\r\x1b[7C')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('ui/viewport', () => {
  it('进入 Alternate Screen 后按行 diff 重绘，不启用鼠标捕获，退出时恢复光标与主屏', () => {
    const writes: string[] = []
    const viewport = createViewport({
      isTTY: true,
      columns: 60,
      rows: 12,
      write: (chunk) => {
        writes.push(String(chunk))
        return true
      },
    })
    viewport.enter()
    expect(writes[0]).toContain('\x1b[?1049h\x1b[?25l')
    expect(writes[0]).toContain('\x1b[?7l')
    expect(writes[0]).not.toContain('\x1b[?1000h')

    viewport.paint(['第一行', '第二行'])
    const frame2Idx = writes.length
    viewport.paint(['第一行', '改了第二行'])
    expect(writes[frame2Idx]).not.toContain('\x1b[1;1H')
    expect(writes[frame2Idx]).toContain('\x1b[2;1H\x1b[2K改了第二行')

    viewport.dispose()
    expect(writes.at(-1)).toContain('\x1b[?25h\x1b[?1049l')
    expect(writes.at(-1)).toContain('\x1b[?7h')
  })
})
