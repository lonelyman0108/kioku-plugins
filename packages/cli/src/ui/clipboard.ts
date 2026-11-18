// 终端剪贴板与可点击超链接辅助：
// - OSC 8 在支持的终端（iTerm2、Ghostty、Windows Terminal、VS Code 等）生成可点击链接
// - 复制依次尝试系统剪贴板命令（不经过 shell）与 OSC 52 转义序列，无图形环境时不报错

import { spawn } from 'node:child_process'

import type { Env, Writer } from '../types.ts'

export function supportsOsc8(
  stream: { isTTY?: boolean } = process.stdout,
  env: Env = process.env,
): boolean {
  if (!stream?.isTTY || env.TERM === 'dumb') return false
  return Boolean(
    env.WT_SESSION ||
    env.TERM_PROGRAM ||
    env.VTE_VERSION ||
    env.KITTY_WINDOW_ID ||
    env.GHOSTTY_RESOURCES_DIR,
  )
}

export function osc8Link(
  url: string,
  label = url,
  {
    stream = process.stdout,
    env = process.env,
    enabled,
  }: {
    stream?: { isTTY?: boolean }
    env?: Env
    enabled?: boolean
  } = {},
): string {
  const active = enabled ?? supportsOsc8(stream, env)
  if (!active) return label
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
}

export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

// Windows 下 clip.exe 把 UTF-8 按系统代码页解析，中文会乱码；加 BOM 的 UTF-16LE 能原生正确识别
export function encodeWin32Clipboard(text: string): Buffer {
  return Buffer.from(`\uFEFF${text}`, 'utf16le')
}

function tryPipeCommand(cmd: string, args: string[], payload: string | Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      const timer = setTimeout(() => {
        child.kill()
        finish(false)
      }, 1500)
      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
      child.stdin?.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.stdin?.end(payload)
    } catch {
      finish(false)
    }
  })
}

export async function copyToClipboard(
  text: string,
  {
    out,
    env = process.env,
    platform = process.platform,
  }: { out?: Writer & { isTTY?: boolean }; env?: Env; platform?: string } = {},
): Promise<{ ok: boolean; method: 'native' | 'osc52' | 'none' }> {
  const candidates: Array<[string, string[]]> =
    platform === 'darwin'
      ? [['pbcopy', []]]
      : platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ]

  const payload = platform === 'win32' ? encodeWin32Clipboard(text) : text
  for (const [cmd, args] of candidates) {
    if (await tryPipeCommand(cmd, args, payload)) {
      return { ok: true, method: 'native' }
    }
  }

  if (out?.isTTY && env.TERM !== 'dumb') {
    out.write(osc52Sequence(text))
    return { ok: true, method: 'osc52' }
  }

  return { ok: false, method: 'none' }
}
