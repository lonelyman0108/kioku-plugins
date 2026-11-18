// Strata 风格交互组件层：完全零外部依赖，使用 InlineScreen 原地局部重绘，
// 提供 intro / outro / note / log / select / multiselect / confirm / text / password / spinner，
// 以及带宽松确认码框、倒计时与快捷键（[o] 打开浏览器 / [c] 复制链接 / [Esc] 取消）的浏览器授权界面。

import { emitKeypressEvents } from 'node:readline'

import { plain } from '../core.ts'
import { applyKeys } from '../secret.ts'
import type { Reader, Writer } from '../types.ts'
import { copyToClipboard, osc8Link } from './clipboard.ts'
import { createScreen } from './screen.ts'
import { createTheme, renderBox, type StrataTheme } from './theme.ts'
import { displayWidth, padEndWidth } from './width.ts'

export const CANCEL = Symbol('kioku:cancel')

export function isCancel(value: unknown): value is symbol {
  return value === CANCEL
}

const MIN_NODE = [20, 12] as const

export function nodeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

export interface SelectOption<T = string> {
  value: T
  label: string
  hint?: string
}

export interface SelectConfig<T = string> {
  message: string
  options: SelectOption<T>[]
  initialValue?: T
  showInstructions?: boolean
}

export interface MultiselectConfig<T = string> {
  message: string
  options: SelectOption<T>[]
  initialValues?: T[]
  required?: boolean
  showInstructions?: boolean
}

export interface ConfirmConfig {
  message: string
  initialValue?: boolean
  active?: string
  inactive?: string
}

export interface TextConfig {
  message: string
  placeholder?: string
  initialValue?: string
  validate?: (value: string) => string | undefined
}

export interface PasswordConfig {
  message: string
  validate?: (value: string) => string | undefined
}

export interface SpinnerHandle {
  start: (message?: string) => void
  stop: (message?: string, code?: number) => void
  message: (text?: string) => void
}

export interface PromptsUi {
  isCancel: (value: unknown) => boolean
  intro: (title?: string) => void
  outro: (message?: string) => void
  note: (message?: string, title?: string) => void
  log: {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string) => void
    success: (message: string) => void
    message: (message: string) => void
    step: (message: string) => void
  }
  select: <T = string>(config: SelectConfig<T>) => Promise<T | symbol>
  multiselect: <T = string>(config: MultiselectConfig<T>) => Promise<T[] | symbol>
  confirm: (config: ConfirmConfig) => Promise<boolean | symbol>
  text: (config: TextConfig) => Promise<string | symbol>
  password: (config: PasswordConfig) => Promise<string | symbol>
  spinner: () => SpinnerHandle
  updateSettings?: (opts: unknown) => void
}

interface KeypressInfo {
  name?: string
  ctrl?: boolean
  meta?: boolean
}

function withRawKeypress<T>(
  stdin: NodeJS.ReadStream,
  handler: (
    str: string,
    key: KeypressInfo,
    done: (value: T) => void,
    fail: (err: unknown) => void,
  ) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw ?? false
    let settled = false
    emitKeypressEvents(stdin)
    try {
      if (stdin.isTTY) stdin.setRawMode(true)
    } catch {
      // 忽略非原生 TTY
    }
    stdin.resume()

    const cleanup = () => {
      stdin.off('keypress', onKeypress)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      try {
        if (stdin.isTTY) stdin.setRawMode(wasRaw)
      } catch {
        // 终端已关闭
      }
      stdin.pause()
    }

    const done = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onKeypress = (str: string, key: KeypressInfo = {}) => {
      if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'escape') {
        handler(str, { ...key, ctrl: key.ctrl || key.name === 'escape' }, done, fail)
        return
      }
      handler(str, key, done, fail)
    }

    const onEnd = () => done(CANCEL as unknown as T)
    const onError = (err: unknown) => fail(err)

    stdin.on('keypress', onKeypress)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
  })
}

function readHiddenLine(stdin: NodeJS.ReadStream, out: Writer): Promise<string | symbol> {
  return new Promise((resolve) => {
    let value = ''
    const wasRaw = stdin.isRaw ?? false
    const finish = (result: string | symbol) => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onEnd)
      try {
        if (stdin.isTTY) stdin.setRawMode(wasRaw)
      } catch {
        // 终端已关闭
      }
      stdin.pause()
      out.write('\n')
      resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      const res = applyKeys(value, typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      value = res.value
      if (res.done === 'enter') finish(value)
      else if (res.done === 'cancel') finish(CANCEL)
    }
    const onEnd = () => finish(CANCEL)
    try {
      if (stdin.isTTY) stdin.setRawMode(true)
    } catch {
      // 忽略
    }
    stdin.resume()
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onEnd)
  })
}

function readVisibleLine(
  stdin: NodeJS.ReadStream,
  out: Writer,
  initialValue = '',
): Promise<string | symbol> {
  let value = initialValue
  if (value) out.write(value)
  return withRawKeypress<string | symbol>(stdin, (str, key, done) => {
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      out.write('\n')
      done(CANCEL)
      return
    }
    if (key.name === 'escape') {
      out.write('\n')
      done(CANCEL)
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      out.write('\n')
      done(value)
      return
    }
    if (key.name === 'backspace') {
      const chars = Array.from(value)
      if (chars.length) {
        chars.pop()
        value = chars.join('')
        out.write('\b \b')
      }
      return
    }
    if (key.ctrl && key.name === 'u') {
      value = ''
      out.write('\r\x1b[K')
      return
    }
    if (str && !/\p{Cc}/u.test(str) && !key.ctrl && !key.meta) {
      value += str
      out.write(str)
    }
  })
}

export function createBuiltinPrompts(
  stdin: NodeJS.ReadStream = process.stdin,
  out: Writer & { isTTY?: boolean; columns?: number } = process.stdout,
): PromptsUi {
  const theme = createTheme({ stream: out })
  const writeLines = (prefix: string, body: string) => {
    for (const line of body.split('\n')) {
      out.write(`${prefix}${line}\n`)
    }
  }

  return {
    isCancel,
    intro(title = '') {
      const head = title ? `┌─ ${theme.bold(title)} ` : '┌ '
      out.write(`${head}\n`)
    },
    outro(message = '') {
      out.write(message ? `${theme.rule('└')}  ${message}\n` : `${theme.rule('└')}\n`)
    },
    note(message = '', title = '') {
      const box = renderBox({
        title: title || undefined,
        sections: [{ lines: (message || '').split('\n') }],
        width: Math.min(84, (out.columns ?? 80) - 2),
        theme,
      })
      for (const line of box.split('\n')) {
        out.write(`${theme.rule('│')}  ${line}\n`)
      }
    },
    log: {
      info: (msg) => writeLines(`${theme.rule('│')}  `, msg),
      warn: (msg) => writeLines(`${theme.rule('│')}  ${theme.warn('!')} `, msg),
      error: (msg) => writeLines(`${theme.rule('│')}  ${theme.error('✗')} `, msg),
      success: (msg) => writeLines(`${theme.rule('│')}  ${theme.ok('✓')} `, msg),
      message: (msg) => writeLines(`${theme.rule('│')}  `, msg),
      step: (msg) => writeLines(`${theme.rule('│')}  ${theme.bold('◆')} `, msg),
    },
    async select<T>({ message, options, initialValue }: SelectConfig<T>): Promise<T | symbol> {
      if (!options.length) return CANCEL
      let index =
        initialValue !== undefined ? options.findIndex((item) => item.value === initialValue) : 0
      if (index < 0) index = 0

      const screen = createScreen(out)
      screen.hideCursor()
      const render = () => {
        const lines = [`${theme.bold('◆')}  ${theme.bold(message)}`]
        options.forEach((opt, i) => {
          const mark = i === index ? theme.ok('●') : theme.muted('○')
          const label = i === index ? theme.bold(opt.label) : opt.label
          const hint = opt.hint ? theme.muted(` (${opt.hint})`) : ''
          lines.push(`${theme.rule('│')}  ${mark} ${label}${hint}`)
        })
        lines.push(`${theme.rule('│')}  ${theme.muted('↑/↓ 选择 · Enter 确认 · Esc 取消')}`)
        screen.render(lines.join('\n'))
      }

      const onResize = () => render()
      if (out.isTTY && typeof (out as NodeJS.WriteStream).on === 'function') {
        ;(out as NodeJS.WriteStream).on('resize', onResize)
      }
      render()
      try {
        return await withRawKeypress<T | symbol>(stdin, (str, key, done) => {
          if (key.ctrl || key.name === 'escape') {
            screen.commit(`${theme.error('■')}  ${message}：已取消`)
            done(CANCEL)
            return
          }
          if (key.name === 'up' || str === 'k') {
            index = (index - 1 + options.length) % options.length
            render()
          } else if (key.name === 'down' || str === 'j') {
            index = (index + 1) % options.length
            render()
          } else if (key.name === 'return' || key.name === 'enter') {
            screen.commit(`${theme.ok('◇')}  ${message} · ${options[index].label}`)
            done(options[index].value)
          }
        })
      } finally {
        if (out.isTTY && typeof (out as NodeJS.WriteStream).off === 'function') {
          ;(out as NodeJS.WriteStream).off('resize', onResize)
        }
        screen.dispose()
      }
    },
    async multiselect<T>({
      message,
      options,
      initialValues = [],
      required = false,
    }: MultiselectConfig<T>): Promise<T[] | symbol> {
      if (!options.length) return []
      let cursor = 0
      const selected = new Set<T>(initialValues)
      const screen = createScreen(out)
      screen.hideCursor()

      const render = (warning = '') => {
        const lines = [`${theme.bold('◆')}  ${theme.bold(message)}`]
        options.forEach((opt, i) => {
          const ptr = i === cursor ? theme.bold('>') : ' '
          const box = selected.has(opt.value) ? theme.ok('[✓]') : theme.muted('[ ]')
          const label = i === cursor ? theme.bold(opt.label) : opt.label
          const hint = opt.hint ? theme.muted(` (${opt.hint})`) : ''
          lines.push(`${theme.rule('│')}  ${ptr} ${box} ${label}${hint}`)
        })
        if (warning) lines.push(`${theme.rule('│')}  ${theme.error(`! ${warning}`)}`)
        lines.push(
          `${theme.rule('│')}  ${theme.muted('Space 切换 · a 全选 · Enter 确认 · Esc 取消')}`,
        )
        screen.render(lines.join('\n'))
      }

      const onResize = () => render()
      if (out.isTTY && typeof (out as NodeJS.WriteStream).on === 'function') {
        ;(out as NodeJS.WriteStream).on('resize', onResize)
      }
      render()
      try {
        return await withRawKeypress<T[] | symbol>(stdin, (str, key, done) => {
          if (key.ctrl || key.name === 'escape') {
            screen.commit(`${theme.error('■')}  ${message}：已取消`)
            done(CANCEL)
            return
          }
          if (key.name === 'up' || str === 'k') {
            cursor = (cursor - 1 + options.length) % options.length
            render()
          } else if (key.name === 'down' || str === 'j') {
            cursor = (cursor + 1) % options.length
            render()
          } else if (key.name === 'space' || str === ' ') {
            const val = options[cursor].value
            if (selected.has(val)) selected.delete(val)
            else selected.add(val)
            render()
          } else if (str === 'a') {
            if (selected.size === options.length) selected.clear()
            else options.forEach((opt) => selected.add(opt.value))
            render()
          } else if (key.name === 'return' || key.name === 'enter') {
            if (required && selected.size === 0) {
              render('至少选一项')
              return
            }
            const picked = options.filter((o) => selected.has(o.value))
            screen.commit(
              `${theme.ok('◇')}  ${message} · ${picked.map((o) => o.label).join('、') || '无'}`,
            )
            done(picked.map((o) => o.value))
          }
        })
      } finally {
        if (out.isTTY && typeof (out as NodeJS.WriteStream).off === 'function') {
          ;(out as NodeJS.WriteStream).off('resize', onResize)
        }
        screen.dispose()
      }
    },
    async confirm({
      message,
      initialValue = true,
      active = '是',
      inactive = '否',
    }: ConfirmConfig): Promise<boolean | symbol> {
      let value = initialValue
      const screen = createScreen(out)
      screen.hideCursor()
      const render = () => {
        const yes = value
          ? `${theme.ok('●')} ${theme.bold(active)}`
          : `${theme.muted('○')} ${active}`
        const no = !value
          ? `${theme.ok('●')} ${theme.bold(inactive)}`
          : `${theme.muted('○')} ${inactive}`
        screen.render(
          `${theme.bold('◆')}  ${theme.bold(message)}\n${theme.rule('│')}  ${yes}  /  ${no}`,
        )
      }
      render()
      try {
        return await withRawKeypress<boolean | symbol>(stdin, (str, key, done) => {
          if (key.ctrl || key.name === 'escape') {
            screen.commit(`${theme.error('■')}  ${message}：已取消`)
            done(CANCEL)
            return
          }
          if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || str === ' ') {
            value = !value
            render()
          } else if (str === 'y' || str === 'Y') {
            screen.commit(`${theme.ok('◇')}  ${message} · ${active}`)
            done(true)
          } else if (str === 'n' || str === 'N') {
            screen.commit(`${theme.ok('◇')}  ${message} · ${inactive}`)
            done(false)
          } else if (key.name === 'return' || key.name === 'enter') {
            screen.commit(`${theme.ok('◇')}  ${message} · ${value ? active : inactive}`)
            done(value)
          }
        })
      } finally {
        screen.dispose()
      }
    },
    async text({
      message,
      placeholder,
      initialValue = '',
      validate,
    }: TextConfig): Promise<string | symbol> {
      const hint = placeholder ? theme.muted(`（例如 ${placeholder}）`) : ''
      for (;;) {
        out.write(`${theme.bold('◆')}  ${theme.bold(message)}${hint}\n${theme.rule('│')}  `)
        const answer = await readVisibleLine(stdin, out, initialValue)
        if (isCancel(answer)) {
          out.write(`${theme.error('■')}  ${message}：已取消\n`)
          return CANCEL
        }
        const problem = validate?.(answer as string)
        if (!problem) return answer
        out.write(`${theme.rule('│')}  ${theme.error(`! ${problem}`)}\n`)
        initialValue = answer as string
      }
    },
    async password({ message, validate }: PasswordConfig): Promise<string | symbol> {
      for (;;) {
        out.write(
          `${theme.bold('◆')}  ${theme.bold(message)}${theme.muted('（不回显）')}\n${theme.rule('│')}  `,
        )
        const answer = await readHiddenLine(stdin, out)
        if (isCancel(answer)) {
          out.write(`${theme.error('■')}  ${message}：已取消\n`)
          return CANCEL
        }
        const problem = validate?.(answer as string)
        if (!problem) return answer
        out.write(`${theme.rule('│')}  ${theme.error(`! ${problem}`)}\n`)
      }
    },
    spinner(): SpinnerHandle {
      let current = ''
      let timer: ReturnType<typeof setInterval> | null = null
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      let frame = 0
      const stopTimer = () => {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
      }
      return {
        start(msg = '') {
          current = msg
          if (!out.isTTY) {
            if (current) out.write(`│  … ${current}\n`)
            return
          }
          stopTimer()
          out.write(`${theme.rule('│')}  ${frames[frame]} ${current}`)
          timer = setInterval(() => {
            frame = (frame + 1) % frames.length
            out.write(`\r\x1b[K${theme.rule('│')}  ${frames[frame]} ${current}`)
          }, 80)
        },
        message(msg = '') {
          current = msg
          if (out.isTTY && timer)
            out.write(`\r\x1b[K${theme.rule('│')}  ${frames[frame]} ${current}`)
        },
        stop(msg = '') {
          stopTimer()
          const line = msg || current
          if (out.isTTY)
            out.write(`\r\x1b[K${line ? `${theme.rule('│')}  ${theme.ok('◇')} ${line}\n` : ''}`)
          else if (line) out.write(`│  ◇ ${line}\n`)
        },
      }
    },
  }
}

export function spacedCode(code: string): string {
  return Array.from(plain(code)).join(' ')
}

export function formatCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function renderDeviceAuthBox({
  userCode,
  verificationUrl,
  remainingSec,
  codeCopied,
  linkCopied,
  out,
  theme = createTheme({ stream: out }),
}: {
  userCode: string
  verificationUrl: string
  remainingSec: number
  codeCopied: boolean
  linkCopied: boolean
  out?: { isTTY?: boolean }
  theme?: StrataTheme
}): string {
  const cleanCode = plain(userCode)
  const cleanUrl = plain(verificationUrl)
  const spaced = spacedCode(cleanCode)
  const innerWidth = Math.max(12, displayWidth(spaced) + 4)
  const statusTag = codeCopied ? theme.ok('确认码已复制') : theme.muted('对照终端输入确认码')
  const linkShown = osc8Link(cleanUrl, cleanUrl, { stream: out })
  const copyFeedback = linkCopied ? theme.ok('（链接已复制）') : ''
  const footerLeft = theme.muted('[o] 打开浏览器  [c] 复制链接  [Esc] 取消')
  const clock = theme.muted(formatCountdown(remainingSec))
  const boxWidth = Math.max(54, displayWidth(cleanUrl) + 6, innerWidth + 24)
  const gap = Math.max(2, boxWidth - 4 - displayWidth(footerLeft) - displayWidth(clock))

  return renderBox({
    title: '浏览器授权',
    width: boxWidth,
    theme,
    sections: [
      {
        lines: [
          `${theme.rule('┌')}${theme.rule('─'.repeat(innerWidth))}${theme.rule('┐')}`,
          `${theme.rule('│')}  ${theme.bold(padEndWidth(spaced, innerWidth - 4))}  ${theme.rule('│')}  ${statusTag}`,
          `${theme.rule('└')}${theme.rule('─'.repeat(innerWidth))}${theme.rule('┘')}`,
          '',
          `在浏览器里打开 ${linkShown}${copyFeedback}`,
          '',
          `${footerLeft}${' '.repeat(gap)}${clock}`,
        ],
      },
    ],
  })
}

export interface DeviceWaitHandle {
  stop: (finalMessage?: string) => void
}

export async function startDeviceAuthWait({
  userCode,
  verificationUrl,
  expiresIn,
  out,
  stdin = process.stdin,
  open,
  browser,
  onCancel,
  interactive,
  copy = copyToClipboard,
}: {
  userCode: string
  verificationUrl: string
  expiresIn: number
  out: Writer & { isTTY?: boolean; columns?: number }
  stdin?: Reader
  open: (url: string) => void
  browser: boolean
  onCancel?: () => void
  interactive?: boolean
  copy?: typeof copyToClipboard
}): Promise<DeviceWaitHandle> {
  const cleanCode = plain(userCode)
  const cleanUrl = plain(verificationUrl)
  const isInteractive =
    interactive ?? Boolean(out?.isTTY && (stdin as NodeJS.ReadStream | undefined)?.isTTY)

  if (!isInteractive) {
    out.write(`确认码：${cleanCode}\n`)
    out.write(`在浏览器里打开 ${cleanUrl}，登录后输入这个确认码\n`)
    out.write(`等待确认（${Math.ceil(expiresIn / 60)} 分钟内有效）…\n`)
    if (browser) open(cleanUrl)
    return {
      stop: () => {},
    }
  }

  let codeCopied = false
  let linkCopied = false
  let remaining = expiresIn
  const theme = createTheme({ stream: out })
  const screen = createScreen(out)
  screen.hideCursor()

  const draw = () => {
    screen.render(
      renderDeviceAuthBox({
        userCode: cleanCode,
        verificationUrl: cleanUrl,
        remainingSec: remaining,
        codeCopied,
        linkCopied,
        out,
        theme,
      }),
    )
  }

  draw()
  if (browser) open(cleanUrl)
  void copy(cleanCode, { out }).then((res) => {
    if (res.ok) {
      codeCopied = true
      draw()
    }
  })

  const timer = setInterval(() => {
    remaining = Math.max(0, remaining - 1)
    draw()
  }, 1000)
  timer.unref()

  const ttyIn = stdin as NodeJS.ReadStream
  const wasRaw = ttyIn.isRaw ?? false
  let stopped = false
  emitKeypressEvents(ttyIn)
  try {
    ttyIn.setRawMode?.(true)
  } catch {
    // 忽略非原生 TTY
  }
  ttyIn.resume?.()

  const onKeypress = (str: string, key: KeypressInfo = {}) => {
    if (stopped) return
    if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
      onCancel?.()
      return
    }
    if (str === 'o' || str === 'O') {
      open(cleanUrl)
      return
    }
    if (str === 'c' || str === 'C') {
      void copy(cleanUrl, { out }).then((res) => {
        if (res.ok && !stopped) {
          linkCopied = true
          draw()
        }
      })
    }
  }

  ttyIn.on?.('keypress', onKeypress)

  return {
    stop(finalMessage?: string) {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      ttyIn.off?.('keypress', onKeypress)
      try {
        ttyIn.setRawMode?.(wasRaw)
      } catch {
        // 终端已关闭
      }
      ttyIn.pause?.()
      if (finalMessage !== undefined) screen.commit(finalMessage)
      else screen.clear()
      screen.dispose()
    },
  }
}

export function localized(impl: PromptsUi): PromptsUi {
  impl.updateSettings?.({ messages: { cancel: '已取消', error: '出错了' } })
  return {
    ...impl,
    select: (options) => impl.select({ showInstructions: false, ...options }),
    multiselect: (options) =>
      impl.multiselect({
        showInstructions: false,
        required: false,
        ...options,
        message: `${options.message}（空格选中，回车确认）`,
      }),
    confirm: (options) => impl.confirm({ active: '是', inactive: '否', ...options }),
  }
}

export async function loadPrompts({
  input = process.stdin,
  output = process.stdout,
}: {
  input?: Reader
  output?: Writer & { isTTY?: boolean; columns?: number }
} = {}): Promise<PromptsUi | null> {
  if (!nodeSupported()) return null
  return localized(createBuiltinPrompts(input as NodeJS.ReadStream, output))
}
