// 全屏双缓冲 Alternate Screen 控制器：按行 diff 局部重绘，绝不滚屏、绝不开启鼠标捕获以保留框选复制；
// 正常退出、Ctrl-C 或异常退出时始终恢复光标与原终端屏幕。

import type { ScreenStream } from './screen.ts'

export class ViewportScreen {
  readonly stream: ScreenStream
  private prevLines: string[] = []
  private prevCols = 0
  private prevRows = 0
  private active = false
  private disposed = false
  private onSigInt?: () => void
  private onSigTerm?: () => void
  private onSigBreak?: () => void
  private onExit?: () => void

  constructor(stream: ScreenStream = process.stdout) {
    this.stream = stream
  }

  get interactive(): boolean {
    return Boolean(this.stream.isTTY)
  }

  get cols(): number {
    return Math.max(48, this.stream.columns ?? 88)
  }

  get rows(): number {
    return Math.max(12, this.stream.rows ?? 26)
  }

  enter(): void {
    if (this.disposed || this.active) return
    this.active = true
    this.prevLines = []
    this.prevCols = 0
    this.prevRows = 0
    if (!this.interactive) return
    this.installRestoreHooks()
    // 禁用行末自动折行（DECAWM），避免特定字体回退偏宽时顶歪整屏框线
    this.stream.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H')
  }

  resetDiff(): void {
    this.prevLines = []
  }

  paint(lines: string[]): void {
    const cols = this.cols
    const rows = this.rows
    const next = Array.from({ length: rows }, (_, i) => lines[i] ?? '')
    if (!this.interactive || !this.active) {
      this.prevLines = next
      return
    }

    const resized = cols !== this.prevCols || rows !== this.prevRows
    let buf = ''
    if (resized) {
      buf += '\x1b[2J'
      this.prevLines = []
    }

    const limit = Math.max(rows, this.prevLines.length)
    for (let r = 0; r < limit; r++) {
      const target = r < rows ? next[r] : ''
      if (!resized && this.prevLines[r] === target) continue
      buf += `\x1b[${r + 1};1H\x1b[2K${target}`
    }

    this.prevLines = next
    this.prevCols = cols
    this.prevRows = rows
    if (buf) this.stream.write(buf)
  }

  leave(): void {
    if (!this.active) return
    this.active = false
    this.prevLines = []
    if (this.interactive) {
      this.stream.write('\x1b[?7h\x1b[?25h\x1b[?1049l')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.leave()
    this.disposed = true
    if (this.onSigInt) process.off('SIGINT', this.onSigInt)
    if (this.onSigTerm) process.off('SIGTERM', this.onSigTerm)
    if (this.onSigBreak) process.off('SIGBREAK', this.onSigBreak)
    if (this.onExit) process.off('exit', this.onExit)
  }

  private installRestoreHooks(): void {
    if (this.onExit) return
    this.onExit = () => {
      if (this.active && this.interactive) {
        this.active = false
        this.stream.write('\x1b[?7h\x1b[?25h\x1b[?1049l')
      }
    }
    this.onSigInt = () => {
      const only = process.listenerCount('SIGINT') === 1
      this.dispose()
      if (only) process.kill(process.pid, 'SIGINT')
    }
    this.onSigTerm = () => {
      const only = process.listenerCount('SIGTERM') === 1
      this.dispose()
      if (only) process.kill(process.pid, 'SIGTERM')
    }
    process.on('exit', this.onExit)
    process.on('SIGINT', this.onSigInt)
    process.on('SIGTERM', this.onSigTerm)
    if (process.platform === 'win32') {
      this.onSigBreak = () => {
        const only = process.listenerCount('SIGBREAK') === 1
        this.dispose()
        if (only) process.kill(process.pid, 'SIGBREAK')
      }
      process.on('SIGBREAK', this.onSigBreak)
    }
  }
}

export function createViewport(stream: ScreenStream = process.stdout): ViewportScreen {
  return new ViewportScreen(stream)
}
