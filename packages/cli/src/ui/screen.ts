// 原地局部重绘控制器：绝不进入 Alternate Screen，让输出保留在终端滚动历史中；
// 交互结束、Ctrl-C 或异常退出时始终恢复光标。

import { displayWidth } from './width.ts'

export interface ScreenStream {
  isTTY?: boolean
  columns?: number
  rows?: number
  write(chunk: string | Uint8Array): unknown
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export class InlineScreen {
  readonly stream: ScreenStream
  private drawnLines = 0
  private hiddenCursor = false
  private disposed = false
  private onSigInt?: () => void
  private onSigTerm?: () => void
  private onExit?: () => void

  constructor(stream: ScreenStream = process.stdout) {
    this.stream = stream
  }

  get interactive(): boolean {
    return Boolean(this.stream.isTTY)
  }

  get columns(): number {
    const cols = this.stream.columns ?? 80
    return Math.max(40, cols)
  }

  private countPhysicalLines(text: string): number {
    if (!text) return 0
    const cols = this.columns
    const logical = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    let rows = 0
    for (const line of logical) {
      const len = displayWidth(line)
      rows += Math.max(1, Math.ceil(Math.max(1, len) / cols))
    }
    return rows
  }

  hideCursor(): void {
    if (!this.interactive || this.hiddenCursor) return
    this.hiddenCursor = true
    this.stream.write('\x1b[?25l')
    this.installRestoreHooks()
  }

  showCursor(): void {
    if (!this.interactive || !this.hiddenCursor) return
    this.hiddenCursor = false
    this.stream.write('\x1b[?25h')
  }

  render(text: string): void {
    const output = text.endsWith('\n') ? text : `${text}\n`
    if (this.interactive && this.drawnLines > 0) {
      this.stream.write(`\x1b[${this.drawnLines}A\r\x1b[J`)
    }
    this.stream.write(output)
    this.drawnLines = this.interactive ? this.countPhysicalLines(output) : 0
  }

  clear(): void {
    if (this.interactive && this.drawnLines > 0) {
      this.stream.write(`\x1b[${this.drawnLines}A\r\x1b[J`)
    }
    this.drawnLines = 0
  }

  // 把已绘制的块定格（不再覆盖），通常在交互确认后调用
  commit(finalText?: string): void {
    if (finalText !== undefined) {
      this.clear()
      const output = finalText.endsWith('\n') ? finalText : `${finalText}\n`
      this.stream.write(output)
    }
    this.drawnLines = 0
    this.showCursor()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.showCursor()
    if (this.onSigInt) process.off('SIGINT', this.onSigInt)
    if (this.onSigTerm) process.off('SIGTERM', this.onSigTerm)
    if (this.onExit) process.off('exit', this.onExit)
  }

  private installRestoreHooks(): void {
    if (this.onExit) return
    this.onExit = () => {
      if (this.hiddenCursor) this.stream.write('\x1b[?25h')
    }
    this.onSigInt = () => {
      this.dispose()
    }
    this.onSigTerm = () => {
      this.dispose()
    }
    process.on('exit', this.onExit)
    process.on('SIGINT', this.onSigInt)
    process.on('SIGTERM', this.onSigTerm)
  }
}

export function createScreen(stream: ScreenStream = process.stdout): InlineScreen {
  return new InlineScreen(stream)
}
