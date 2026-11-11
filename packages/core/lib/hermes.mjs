// Hermes 这个平台的 kioku setup 与 kioku doctor。
// Hermes 的记忆 provider 从这个 profile 的 .env 读 KIOKU_SERVER_URL 与 KIOKU_API_KEY，所以地址与访问密钥写在那里
// （不另放一份）；选 provider、关掉内置的两份记忆文件是 config.yaml 里的三项，交给 Hermes 自己的 hermes config set 去改，
// 不自己动它的 YAML

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readText, safeWrite } from './files.mjs'
import { keyFormatError, KiokuFailure } from './http.mjs'
import { serverUrlProblem } from './profile.mjs'
import { resolveTarget } from './target.mjs'

const SOURCE = 'lonelyman0108/kioku-plugins/plugins/hermes'
// 要 Hermes 改的三项：选 Kioku，关掉内置的 MEMORY.md 与 USER.md（不关的话两边各记一份）
const SETTINGS = [
  ['memory.provider', 'kioku'],
  ['memory.memory_enabled', 'false'],
  ['memory.user_profile_enabled', 'false'],
]
const RESTORED = [
  ['memory.provider', ''],
  ['memory.memory_enabled', 'true'],
  ['memory.user_profile_enabled', 'true'],
]
const URL_KEY = 'KIOKU_SERVER_URL'
const API_KEY = 'KIOKU_API_KEY'

export function hermesHome(env) {
  return env.HERMES_HOME || join(homedir(), '.hermes')
}

// .env 里的一行「名字=值」；值两边成对的引号去掉。不是这种行时为 null
function envLine(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
  if (!match) return null
  return { name: match[1], value: match[2].replace(/^(["'])(.*)\1$/, '$2') }
}

// .env 里现在写的地址与访问密钥；没有、不完整、格式不对时为 null
export async function readHermesConfig(env) {
  const file = join(hermesHome(env), '.env')
  const text = await readText(file)
  const values = {}
  for (const line of (text ?? '').split(/\r?\n/)) {
    const pair = envLine(line)
    if (pair) values[pair.name] = pair.value
  }
  const url = (values[URL_KEY] ?? '').trim().replace(/\/+$/, '')
  const key = (values[API_KEY] ?? '').trim()
  if (!url || !key || serverUrlProblem(url) || keyFormatError(key)) return null
  return { url, key, file }
}

// 把这两项写进 .env 的全文：原来有的那一行换掉，没有的加在最后；values 里为 null 的去掉。别的行不动
function withEnv(text, values) {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const left = { ...values }
  const lines = []
  for (const line of text ? text.split(/\r?\n/) : []) {
    const pair = envLine(line)
    if (!pair || !Object.hasOwn(left, pair.name)) {
      lines.push(line)
      continue
    }
    if (left[pair.name] !== null) lines.push(`${pair.name}=${left[pair.name]}`)
    delete left[pair.name]
  }
  while (lines.length && lines.at(-1) === '') lines.pop()
  for (const [name, value] of Object.entries(left)) {
    if (value !== null) lines.push(`${name}=${value}`)
  }
  return lines.length ? `${lines.join(eol)}${eol}` : ''
}

// 调 hermes 命令。找不到这个命令时返回 null；失败时抛 KiokuFailure（不带输出：里面可能有别的配置）
function hermes(env, args) {
  const bin = env.KIOKU_HERMES_BIN || 'hermes'
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30_000 }, (err, stdout) => {
      if (err?.code === 'ENOENT') resolve(null)
      else if (err) reject(new KiokuFailure(`hermes ${args.slice(0, 3).join(' ')} 没有成功`))
      else resolve(stdout)
    })
  })
}

async function configValue(env, key) {
  const out = await hermes(env, ['config', 'get', key]).catch(() => undefined)
  if (out === null) return null
  return (out ?? '').trim().split(/\r?\n/).at(-1)?.trim() ?? ''
}

// 逐项让 Hermes 改配置。找不到 hermes 命令时返回 false，由调用方把要运行的命令列给用户
async function applySettings(env, settings) {
  for (const [key, value] of settings) {
    if ((await hermes(env, ['config', 'set', key, value])) === null) return false
  }
  return true
}

function manual(out, settings) {
  out.write('没有找到 hermes 命令，这几项要自己运行：\n')
  for (const [key, value] of settings) out.write(`  hermes config set ${key} ${value || '""'}\n`)
}

async function installed(env) {
  return Boolean(
    await stat(join(hermesHome(env), 'plugins', 'kioku', 'plugin.yaml')).catch(() => null),
  )
}

async function undo({ dryRun }, { env, out }) {
  const file = join(hermesHome(env), '.env')
  const text = await readText(file)
  const next = withEnv(text, { [URL_KEY]: null, [API_KEY]: null })
  if (text !== null && next !== text) out.write(`${file}\n  ${URL_KEY}、${API_KEY}：去掉\n`)
  out.write('Hermes 的配置\n')
  for (const [key, value] of RESTORED) out.write(`  ${key} → ${value || '（内置的）'}\n`)
  if (dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  // .env 里有访问密钥与别的密钥，不留备份
  if (text !== null && next !== text) await safeWrite(file, next, text, { backup: false })
  if (!(await applySettings(env, RESTORED))) manual(out, RESTORED)
  out.write(`Hermes 改回用内置的记忆。provider 要另外卸载：hermes plugins remove kioku\n`)
  return 0
}

export async function setupHermes(options, io) {
  const { env, out } = io
  if (options.undo) return undo(options, io)
  const home = hermesHome(env)
  if (!(await stat(home).catch(() => null))?.isDirectory()) {
    throw new KiokuFailure(
      `没有找到 Hermes 的目录 ${home}：先装好并运行一次 Hermes，或者用 HERMES_HOME 指明`,
    )
  }
  const { url, key, saved } = await resolveTarget({ id: 'hermes', name: 'Hermes' }, options, {
    ...io,
    readSaved: () => readHermesConfig(env),
  })
  const file = join(home, '.env')
  const same = Boolean(saved && saved.url === url && saved.key === key)
  if (same) out.write(`${file} 不用改\n`)
  else out.write(`${file}\n  ${URL_KEY}、${API_KEY}：写入\n`)
  out.write('Hermes 的配置\n')
  for (const [name, value] of SETTINGS) out.write(`  ${name} → ${value}\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!same) {
    const text = await readText(file)
    // .env 里有访问密钥与别的密钥，不留备份；新建的只给本人读写（safeWrite 的规矩）
    await safeWrite(file, withEnv(text, { [URL_KEY]: url, [API_KEY]: key }), text, {
      backup: false,
    })
  }
  if (!(await applySettings(env, SETTINGS))) manual(out, SETTINGS)
  out.write('Hermes 已配好，新开会话生效。内置的 MEMORY.md、USER.md 不再读写，文件还在。\n')
  if (!(await installed(env)))
    out.write(`接下来装上 provider：hermes plugins install ${SOURCE} --enable\n`)
  return 0
}

export async function inspectHermes({ env }, { ok, warn, note }) {
  const home = hermesHome(env)
  if (!(await readHermesConfig(env))) {
    warn(
      `${join(home, '.env')} 里没有 Kioku 的地址与访问密钥，provider 不会生效：运行 kioku setup hermes`,
    )
  }
  if (await installed(env)) ok('Hermes 里装了 kioku 的记忆 provider')
  else warn(`Hermes 里没有装 kioku 的记忆 provider：hermes plugins install ${SOURCE} --enable`)

  const provider = await configValue(env, 'memory.provider')
  if (provider === null) {
    note('没有找到 hermes 命令，查不了它的配置：用 hermes memory status 看')
    return
  }
  if (provider === 'kioku') ok('Hermes 选的记忆 provider 是 kioku')
  else warn(`Hermes 现在选的记忆 provider 不是 kioku：运行 kioku setup hermes`)
  const builtin = []
  for (const [key, label] of [
    ['memory.memory_enabled', 'MEMORY.md'],
    ['memory.user_profile_enabled', 'USER.md'],
  ]) {
    if (/^true$/i.test((await configValue(env, key)) ?? '')) builtin.push(label)
  }
  if (builtin.length) {
    warn(
      `Hermes 内置的 ${builtin.join('、')} 还开着，会和 Kioku 各记一份：运行 kioku setup hermes 关掉`,
    )
  } else ok('Hermes 内置的记忆文件已停用')
  note('只在本机的会话里生效；消息网关来的会话里不注入、不上报、不给工具')
}
