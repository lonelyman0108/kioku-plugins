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

// .env 里的一行「名字=值」。值两边成对的引号去掉；没加引号的值后面的「 # 注释」不算值。不是这种行时为 null
function envLine(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
  if (!match) return null
  const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(match[2])
  const value = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '')
  return { name: match[1], value }
}

// .env 里现在写的地址与访问密钥（同名的写了几行时以最后一行为准，和 Hermes 读它的方式一致）；
// 没有、不完整、格式不对时为 null
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

// 把这几项写进 .env 的全文：同名的行只留一处（换成新值），没有的加在最后；values 里为 null 的全都去掉。
// 别的行不动；没有要改的时候原样返回，不顺手整理空行与换行符
function withEnv(text, values) {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const written = new Set()
  let touched = false
  const lines = []
  for (const line of text ? text.split(/\r?\n/) : []) {
    const pair = envLine(line)
    if (!pair || !Object.hasOwn(values, pair.name)) {
      lines.push(line)
      continue
    }
    const wanted = values[pair.name]
    // 同名的第二行起、要去掉的：都不留（留着的话 Hermes 读到的是最后那一行的旧值）
    if (wanted === null || written.has(pair.name)) {
      touched = true
      continue
    }
    written.add(pair.name)
    const next = `${pair.name}=${wanted}`
    if (next !== line) touched = true
    lines.push(next)
  }
  const missing = Object.entries(values).filter(
    ([name, value]) => value !== null && !written.has(name),
  )
  if (!touched && !missing.length) return text ?? ''
  while (lines.length && lines.at(-1) === '') lines.pop()
  for (const [name, value] of missing) lines.push(`${name}=${value}`)
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

// 读 Hermes 的一项配置：null 是没有 hermes 命令，undefined 是没读出来（命令失败），否则是值（没设时是空字符串）
async function configValue(env, key) {
  let out
  try {
    out = await hermes(env, ['config', 'get', key])
  } catch {
    return undefined
  }
  if (out === null) return null
  return out.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
}

const sameValue = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

// 逐项让 Hermes 改配置，改完读回来核对（托管的安装里 config set 不生效却照样成功退出）。
// 返回 'done'、'no-hermes'（没有这个命令）或 'failed'（命令失败或没改成）。不抛错：
// 调用方这时多半已经把访问密钥写下了，不能让这里的失败看起来像什么都没写
async function applySettings(env, settings) {
  try {
    for (const [key, value] of settings) {
      if ((await hermes(env, ['config', 'set', key, value])) === null) return 'no-hermes'
    }
    for (const [key, value] of settings) {
      const now = await configValue(env, key)
      if (now === null || now === undefined || !sameValue(now, value)) return 'failed'
    }
    return 'done'
  } catch {
    return 'failed'
  }
}

function manual(out, settings, state) {
  out.write(
    state === 'no-hermes'
      ? '没有找到 hermes 命令，这几项要自己运行：\n'
      : 'Hermes 的配置没有改成（它的命令失败了，或者这份安装的配置是托管的），这几项要自己处理：\n',
  )
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
  const changed = text !== null && next !== text
  if (changed) out.write(`${file}\n  ${URL_KEY}、${API_KEY}：去掉\n`)
  // 只在现在选的还是 kioku 时把配置改回去：之后换成了别的 provider 的话，不去动它
  const provider = await configValue(env, 'memory.provider')
  const ours = provider === 'kioku'
  if (ours) {
    out.write('Hermes 的配置\n')
    for (const [key, value] of RESTORED) out.write(`  ${key} → ${value || '（内置的）'}\n`)
  } else if (provider === null) {
    out.write('没有找到 hermes 命令，Hermes 的配置没有动\n')
  } else {
    out.write('Hermes 现在选的记忆 provider 不是 kioku，它的配置没有动\n')
  }
  if (dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  // .env 里有访问密钥与别的密钥，不留备份
  if (changed) await safeWrite(file, next, text, { backup: false })
  if (ours) {
    const state = await applySettings(env, RESTORED)
    if (state !== 'done') manual(out, RESTORED, state)
    else out.write('Hermes 改回用内置的记忆（两个开关都打开了；之前自己关过的要再关一次）。\n')
  }
  out.write('provider 要另外卸载：hermes plugins remove kioku\n')
  return 0
}

// kioku login 申请之前、setup 动手之前先看：Hermes 的目录在不在
export async function preflightHermes({ env }) {
  const home = hermesHome(env)
  if (!(await stat(home).catch(() => null))?.isDirectory()) {
    throw new KiokuFailure(
      `没有找到 Hermes 的目录 ${home}：先装好并运行一次 Hermes，或者用 HERMES_HOME 指明`,
    )
  }
}

export async function setupHermes(options, io) {
  const { env, out } = io
  if (options.undo) return undo(options, io)
  const home = hermesHome(env)
  await preflightHermes({ env })
  const { url, key, saved } = await resolveTarget({ id: 'hermes', name: 'Hermes' }, options, {
    ...io,
    readSaved: () => readHermesConfig(env),
  })
  const file = join(home, '.env')
  const text = await readText(file)
  const next = withEnv(text, { [URL_KEY]: url, [API_KEY]: key })
  // 同名的行写了几处时，哪怕最后生效的值是对的也要收拾成一处
  const same = Boolean(saved && saved.url === url && saved.key === key) && next === (text ?? '')
  if (same) out.write(`${file} 不用改\n`)
  else out.write(`${file}\n  ${URL_KEY}、${API_KEY}：写入\n`)
  out.write('Hermes 的配置\n')
  for (const [name, value] of SETTINGS) out.write(`  ${name} → ${value}\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  // .env 里有访问密钥与别的密钥，不留备份；新建的只给本人读写（safeWrite 的规矩）
  if (!same) await safeWrite(file, next, text, { backup: false })
  // 访问密钥这时已经写下了：后面改 Hermes 的配置不成也不算失败，把要做的列出来
  const state = await applySettings(env, SETTINGS)
  if (state === 'done') {
    out.write('Hermes 已配好，新开会话生效。内置的 MEMORY.md、USER.md 不再读写，文件还在。\n')
  } else {
    out.write('地址与访问密钥已经写下。\n')
    manual(out, SETTINGS, state)
  }
  if (!(await installed(env))) {
    out.write(`接下来装上 provider：hermes plugins install ${SOURCE} --enable\n`)
  }
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
  const flags = [
    [await configValue(env, 'memory.memory_enabled'), 'MEMORY.md'],
    [await configValue(env, 'memory.user_profile_enabled'), 'USER.md'],
  ]
  // 没读出来的不下结论
  if (provider === undefined || flags.some(([value]) => value === undefined)) {
    warn('Hermes 的配置没有读出来（hermes config get 失败了）：用 hermes memory status 看')
    return
  }
  if (provider === 'kioku') ok('Hermes 选的记忆 provider 是 kioku')
  else warn(`Hermes 现在选的记忆 provider 不是 kioku：运行 kioku setup hermes`)
  const builtin = flags.filter(([value]) => /^true$/i.test(value)).map(([, label]) => label)
  if (builtin.length) {
    warn(
      `Hermes 内置的 ${builtin.join('、')} 还开着，会和 Kioku 各记一份：运行 kioku setup hermes 关掉`,
    )
  } else ok('Hermes 内置的记忆文件已停用')
  note('只在本机的会话里生效；消息网关来的会话里不注入、不上报、不给工具')
}
