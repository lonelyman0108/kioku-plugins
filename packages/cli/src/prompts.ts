// 向导的零依赖交互层：用 Node 原生终端能力实现 select、multiselect、confirm、text、password、spinner 等组件，
// 保持统一接口并在各终端上无额外依赖运行

import { emitKeypressEvents } from 'node:readline'

import { applyKeys } from './secret.ts'

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

function readHiddenLine(
  stdin: NodeJS.ReadStream,
  out: NodeJS.WriteStream,
): Promise<string | symbol> {
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
  out: NodeJS.WriteStream,
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
  out: NodeJS.WriteStream = process.stdout,
): PromptsUi {
  const writeLines = (prefix: string, body: string) => {
    for (const line of body.split('\n')) {
      out.write(`${prefix}${line}\n`)
    }
  }

  return {
    isCancel,
    intro(title = '') {
      out.write(title ? `┌  ${title}\n` : '┌\n')
    },
    outro(message = '') {
      out.write(message ? `└  ${message}\n` : '└\n')
    },
    note(message = '', title = '') {
      out.write(title ? `│\n├─ ${title}\n` : '│\n')
      if (message) writeLines('│  ', message)
      out.write('│\n')
    },
    log: {
      info: (msg) => writeLines('│  ', msg),
      warn: (msg) => writeLines('│  ! ', msg),
      error: (msg) => writeLines('│  ✗ ', msg),
      success: (msg) => writeLines('│  ✓ ', msg),
      message: (msg) => writeLines('│  ', msg),
      step: (msg) => writeLines('│  ◆ ', msg),
    },
    async select<T>({ message, options, initialValue }: SelectConfig<T>): Promise<T | symbol> {
      if (!options.length) return CANCEL
      let index =
        initialValue !== undefined ? options.findIndex((item) => item.value === initialValue) : 0
      if (index < 0) index = 0

      let drawn = 0
      const render = () => {
        if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
        const lines = [`◆  ${message}`]
        options.forEach((opt, i) => {
          const mark = i === index ? '●' : '○'
          const hint = opt.hint ? ` (${opt.hint})` : ''
          lines.push(`│  ${mark} ${opt.label}${hint}`)
        })
        out.write(`${lines.join('\n')}\n`)
        drawn = lines.length
      }

      render()
      return withRawKeypress<T | symbol>(stdin, (str, key, done) => {
        if (key.ctrl || key.name === 'escape') {
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`■  ${message}：已取消\n`)
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
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`◇  ${message} · ${options[index].label}\n`)
          done(options[index].value)
        }
      })
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
      let drawn = 0

      const render = (warning = '') => {
        if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
        const lines = [`◆  ${message}`]
        options.forEach((opt, i) => {
          const ptr = i === cursor ? '>' : ' '
          const box = selected.has(opt.value) ? '[✓]' : '[ ]'
          const hint = opt.hint ? ` (${opt.hint})` : ''
          lines.push(`│  ${ptr} ${box} ${opt.label}${hint}`)
        })
        if (warning) lines.push(`│  ! ${warning}`)
        out.write(`${lines.join('\n')}\n`)
        drawn = lines.length
      }

      render()
      return withRawKeypress<T[] | symbol>(stdin, (str, key, done) => {
        if (key.ctrl || key.name === 'escape') {
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`■  ${message}：已取消\n`)
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
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`◇  ${message} · ${picked.map((o) => o.label).join('、') || '无'}\n`)
          done(picked.map((o) => o.value))
        }
      })
    },
    async confirm({
      message,
      initialValue = true,
      active = '是',
      inactive = '否',
    }: ConfirmConfig): Promise<boolean | symbol> {
      let value = initialValue
      let drawn = 0
      const render = () => {
        if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
        out.write(
          `◆  ${message}\n│  ${value ? `● ${active}` : `○ ${active}`}  /  ${!value ? `● ${inactive}` : `○ ${inactive}`}\n`,
        )
        drawn = 2
      }
      render()
      return withRawKeypress<boolean | symbol>(stdin, (str, key, done) => {
        if (key.ctrl || key.name === 'escape') {
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`■  ${message}：已取消\n`)
          done(CANCEL)
          return
        }
        if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || str === ' ') {
          value = !value
          render()
        } else if (str === 'y' || str === 'Y') {
          value = true
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`◇  ${message} · ${active}\n`)
          done(true)
        } else if (str === 'n' || str === 'N') {
          value = false
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`◇  ${message} · ${inactive}\n`)
          done(false)
        } else if (key.name === 'return' || key.name === 'enter') {
          if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`)
          out.write(`◇  ${message} · ${value ? active : inactive}\n`)
          done(value)
        }
      })
    },
    async text({
      message,
      placeholder,
      initialValue = '',
      validate,
    }: TextConfig): Promise<string | symbol> {
      const hint = placeholder ? `（例如 ${placeholder}）` : ''
      for (;;) {
        out.write(`◆  ${message}${hint}\n│  `)
        const answer = await readVisibleLine(stdin, out, initialValue)
        if (isCancel(answer)) {
          out.write(`■  ${message}：已取消\n`)
          return CANCEL
        }
        const problem = validate?.(answer as string)
        if (!problem) return answer
        out.write(`│  ! ${problem}\n`)
        initialValue = answer as string
      }
    },
    async password({ message, validate }: PasswordConfig): Promise<string | symbol> {
      for (;;) {
        out.write(`◆  ${message}（不回显）\n│  `)
        const answer = await readHiddenLine(stdin, out)
        if (isCancel(answer)) {
          out.write(`■  ${message}：已取消\n`)
          return CANCEL
        }
        const problem = validate?.(answer as string)
        if (!problem) return answer
        out.write(`│  ! ${problem}\n`)
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
          out.write(`│  ${frames[frame]} ${current}`)
          timer = setInterval(() => {
            frame = (frame + 1) % frames.length
            out.write(`\r\x1b[K│  ${frames[frame]} ${current}`)
          }, 80)
        },
        message(msg = '') {
          current = msg
          if (out.isTTY && timer) out.write(`\r\x1b[K│  ${frames[frame]} ${current}`)
        },
        stop(msg = '') {
          stopTimer()
          const line = msg || current
          if (out.isTTY) out.write(`\r\x1b[K${line ? `│  ◇ ${line}\n` : ''}`)
          else if (line) out.write(`│  ◇ ${line}\n`)
        },
      }
    },
  }
}

// 统一交互提示样式：隐藏多余英文说明，把操作键写进多选标题，是/否采用中文
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

export async function loadPrompts(): Promise<PromptsUi | null> {
  if (!nodeSupported()) return null
  return localized(createBuiltinPrompts())
}
