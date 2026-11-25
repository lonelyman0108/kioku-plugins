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

function stripComments(text: string): string {
  let out = ''
  let i = 0
  let inBlock = false
  let quote: '"' | "'" | '`' | null = null
  let inRegex = false
  let inRegexClass = false
  let prevSig = ''

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i += 2
        continue
      }
      if (ch === '\n') out += '\n'
      i++
      continue
    }

    if (quote) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        prevSig = '"'
      }
      i++
      continue
    }

    if (inRegex) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (ch === '[') inRegexClass = true
      else if (ch === ']' && inRegexClass) inRegexClass = false
      else if (ch === '/' && !inRegexClass) {
        inRegex = false
        prevSig = '/'
      } else if (ch === '\n') {
        inRegex = false
        inRegexClass = false
      }
      i++
      continue
    }

    if (ch === '/' && next === '*') {
      inBlock = true
      i += 2
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }
    if (
      ch === '/' &&
      (!prevSig || '(=,:[!&|?{};\n'.includes(prevSig) || /[+\-*%<>^~!]/.test(prevSig))
    ) {
      inRegex = true
      inRegexClass = false
      out += ch
      i++
      continue
    }
    out += ch
    if (!/[\t ]/.test(ch)) prevSig = ch
    i++
  }
  return out
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

const BANNED_RULES: Array<[RegExp, string]> = [
  [/[一这那每几]把|共 ?\S* ?把|\d\s*把/, '访问密钥的量词应使用「个」而非「把」'],
  [/(?:私人|基础)层|个人画像|分区|情节/, '已废弃的旧模型术语'],
  [/设备码|设备授权/, '对用户显示的文案应写「浏览器授权」「确认码」'],
  [
    /kioku_(?!(?:list_credentials|credential_delete|credential_save)\b)[a-zA-Z0-9_-]{16,}/,
    '源码中不得硬编码访问密钥样例',
  ],
  [/接入实例/, '应使用「客户端」而非旧词「接入实例」'],
  [/物种/, '应使用「类型」而非旧词「物种」'],
  [/正式词条|词条/, '应使用「正式记忆」或「记忆」而非旧词「词条」'],
  [/切片|变体/, '扁平模型不再使用「切片」「变体」'],
  [/切面|默认语境/, '扁平模型不再使用「切面」「默认语境」'],
  [/主场|客场|记忆圈|主圈|关联圈|个人圈|独立圈/, '单人扁平架构不再使用记忆圈术语'],
  [/独立人格|人格配置/, '单人扁平架构不再使用独立人格术语'],
  [/敏感级|机密记忆/, '单人扁平架构不再使用敏感级与机密记忆术语'],
  [/联系人事实/, '单人扁平架构不再使用联系人事实术语'],
  [/地层/, '不再使用旧版地层视觉模型术语'],
  [/「客户端」页|legacy-upgrade/, '管理界面应引导至「设置 → 连接与终端」，无旧升级页'],
  [/召回说明|触发条件/, '应使用「触发场景」而非「召回说明」「触发条件」'],
  [/记忆 ?provider/i, '应使用「记忆提供方」'],
  [/启动上下文/, '应使用「启动加载」而非「启动上下文」'],
  [/宿主/, '对用户显示的文案应使用「客户端」而非「宿主」'],
  [/你/, '不使用第二人称「你」'],
  [/还没/, '应写「暂无」或「尚未」'],
  [/占着|用不了|读不了|拿不到|看得到|读得到|查不了|查不到/, '应使用正式产品用语替代口语'],
  [/坐标/, '不再使用旧坐标体系'],
  [/(?<!提示|弹出|外|组件|底)层(?!次|叠)/, '不再把记忆分类称为「层」'],
  [/(?<![\w/`.])Keys?(?![\w`])/, '对外术语应为「访问密钥」而非「Key」'],
  [/(?:所属|这个|该)应用|「应用」/, '服务端客户端实体应称「客户端」'],
]

describe('CLI 文案与仓库公开信息规范', () => {
  const files = collectTsFiles(SRC_DIR)

  it('不出现禁用词、旧术语、测试访问密钥或私有部署地址', () => {
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(SRC_DIR, file).replaceAll('\\', '/')
      const body = stripComments(readFileSync(file, 'utf8'))
      const lines = body.split('\n')

      lines.forEach((line, index) => {
        for (const [pattern, reason] of BANNED_RULES) {
          if (pattern.test(line)) {
            violations.push(`${rel}:${index + 1} [${reason}]: ${line.trim()}`)
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
