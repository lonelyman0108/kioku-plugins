import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'dist' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n')
}

const ALLOWED_URL_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  'example.com',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'docs.astral.sh',
])

const GENERAL_BANNED: Array<[RegExp, string]> = [
  [/[一这那每几]把|共 ?\S* ?把|\d\s*把/, '访问密钥的量词应使用「个」而非「把」'],
  [/(?:私人|基础)层|个人画像|分区|情节/, '已废弃的旧模型术语'],
  [/设备码|设备授权/, '对用户显示的文案应写「浏览器授权」「确认码」'],
  [/kioku_[a-zA-Z0-9_-]{16,}/, '源码中不得硬编码访问密钥样例'],
]

const NEW_MODULE_RE = /^(?:ui\/|commands\/|installer\.ts$|identity\.ts$)/

const NEW_MODULE_BANNED: Array<[RegExp, string]> = [
  [/你/, '不使用第二人称「你」'],
  [/宿主/, '对用户显示的文案写「客户端」'],
  [/还没/, '写「暂无」或「尚未」'],
  [/(?<!地|提示|弹出|外|组件)层(?!次)/, '记忆归属用「归属」，不称「层」'],
  [/(?<![\w/`.])Keys?(?![\w`])/, '对外术语应为「访问密钥」而非「Key」'],
]

describe('CLI 文案与仓库公开信息规范', () => {
  const files = collectTsFiles(SRC_DIR)

  it('不出现禁用词、旧术语、测试访问密钥或私有部署地址', () => {
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(SRC_DIR, file).replaceAll('\\', '/')
      const body = stripLineComments(readFileSync(file, 'utf8'))
      const lines = body.split('\n')

      lines.forEach((line, index) => {
        for (const [pattern, reason] of GENERAL_BANNED) {
          if (pattern.test(line)) {
            violations.push(`${rel}:${index + 1} [${reason}]: ${line.trim()}`)
          }
        }
        if (NEW_MODULE_RE.test(rel)) {
          for (const [pattern, reason] of NEW_MODULE_BANNED) {
            if (pattern.test(line)) {
              violations.push(`${rel}:${index + 1} [${reason}]: ${line.trim()}`)
            }
          }
        }
        const urls = line.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)
        for (const match of urls) {
          const host = (match[1] ?? '').replace(/\.+$/, '').toLowerCase()
          if (!host) continue
          if (!ALLOWED_URL_HOSTS.has(host) && !host.endsWith('.example.com')) {
            violations.push(`${rel}:${index + 1} [未在公开示例白名单中的地址 ${host}]: ${match[0]}`)
          }
        }
      })
    }

    expect(violations).toEqual([])
  })
})
