// 向导的面板：扫描服务器与本机各平台的现状，排成几行文字，再按缺什么列出可做的动作。
// 只读：不写文件、不签发访问密钥。查不了的项写「无法判断」，不猜

import { stat } from 'node:fs/promises'

import { KeyRejected, whoami } from './api.mjs'
import { hasCommand } from './command.mjs'
import { failureText, fetchFailure, isRedirect, KiokuFailure } from './http.mjs'
import { countLocal } from './import.mjs'
import { PLATFORMS } from './platforms.mjs'
import { serverUrlProblem } from './profile.mjs'
import { plain, shownUrl } from './text.mjs'

const TIMEOUT = 5000

async function getJson(url, path) {
  let res
  let data
  try {
    res = await fetch(`${url}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) })
    data = await res.json().catch(() => null)
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) throw new KiokuFailure(`返回了跳转（${res.status}）`)
  return { status: res.status, data }
}

// 服务器的现状：{ reachable, version, problem, needsSetup }。不要访问密钥
export async function serverHealth(url) {
  let answer
  try {
    answer = await getJson(url, '/v1/health')
  } catch (err) {
    return { reachable: false, problem: failureText(err) }
  }
  const version = typeof answer.data?.version === 'string' ? plain(answer.data.version) : null
  if (answer.status === 503) {
    return { reachable: true, version, problem: '数据库暂时无法连接' }
  }
  if (answer.status !== 200 || answer.data?.status !== 'ok') {
    return { reachable: false, problem: `不像 Kioku（HTTP ${answer.status}）` }
  }
  let needsSetup = false
  try {
    const setup = await getJson(url, '/v1/setup/status')
    needsSetup = setup.status === 200 && setup.data?.needsSetup === true
  } catch {
    // 查不到按已初始化算
  }
  return { reachable: true, version, problem: null, needsSetup }
}

async function isDir(path) {
  return Boolean((await stat(path).catch(() => null))?.isDirectory())
}

// 各平台写下的服务地址（按平台的顺序，同一个只留一次）
export async function knownServers(env) {
  const urls = []
  for (const platform of Object.values(PLATFORMS)) {
    const config = await Promise.resolve(platform.readConfig?.(env)).catch(() => null)
    if (config?.url && !urls.includes(config.url)) urls.push(config.url)
  }
  return urls
}

// 没有指明时用哪个服务地址：KIOKU_SERVER_URL，否则各平台写下的里面最先找到的
export async function defaultServerUrl(env) {
  const fromEnv = (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  if (fromEnv && !serverUrlProblem(fromEnv)) return fromEnv
  return (await knownServers(env))[0] ?? null
}

// 一个平台的现状。connection：
// - ok：访问密钥可用；none：没配过；invalid：服务端说访问密钥无效或已吊销
// - unknown：连不上、响应不对，查不了；broken：配置文件读不懂
// - manual：Claude Code，访问密钥在它的 /plugin 里填，这里读不到
export async function scanPlatform(id, { env, cwd, url }) {
  const platform = PLATFORMS[id]
  const present = hasCommand(platform.command(env), env) || (await isDir(platform.home(env)))
  const row = { id, name: platform.name, present, connection: 'none' }

  let config = null
  if (!platform.readConfig) row.connection = 'manual'
  else {
    try {
      config = await platform.readConfig(env)
    } catch (err) {
      row.connection = 'broken'
      row.reason = failureText(err)
    }
  }
  if (config) {
    row.url = config.url
    row.otherServer = Boolean(url && config.url !== url)
    try {
      row.who = await whoami(config)
      row.connection = 'ok'
    } catch (err) {
      row.connection = err instanceof KeyRejected ? 'invalid' : 'unknown'
      row.reason = failureText(err)
    }
  }

  const status = await platform.status({ env, cwd }).catch(() => ({ plugin: null, memory: null }))
  row.plugin = status.plugin
  row.memory = status.memory
  if (status.reenabledIn) row.reenabledIn = status.reenabledIn

  // 只数本地有几条；和 Kioku 比（没迁的有几条）要一条一条地问，选了迁移再比
  if (platform.source) row.local = await countLocal(platform.source, { env }).catch(() => null)
  return row
}

// 面板的全部现状。url 为空时只扫本机
export async function scan({ env, cwd, url }) {
  const server = url ? { url, ...(await serverHealth(url)) } : null
  const platforms = await Promise.all(
    Object.keys(PLATFORMS).map((id) => scanPlatform(id, { env, cwd, url })),
  )
  return { server, platforms }
}

const PLUGIN_NAMES = new Map([
  [true, '已安装'],
  [false, '未安装'],
  [null, '无法判断'],
])
const MEMORY_NAMES = { off: '已停用', on: '未停用', none: '无' }

// 访问密钥属于哪个空间：服务端给了空间名就用名字，否则用 id 的前 8 位
function spaceText(who) {
  if (typeof who.spaceName === 'string' && who.spaceName) return plain(who.spaceName)
  return typeof who.spaceId === 'string' ? plain(who.spaceId).slice(0, 8) : null
}

// 能不能停用：配过（不管现在能不能用），或者 Claude Code 的自动记忆停着
export function canDisable(row) {
  return (
    ['ok', 'invalid', 'unknown', 'broken'].includes(row.connection) ||
    (row.connection === 'manual' && row.memory === 'off')
  )
}

// 平台接到哪一步，一个短词
export function connectionText(row) {
  if (row.connection === 'manual') return row.plugin ? '插件已启用' : '未接入'
  if (row.connection === 'ok' && row.otherServer) return '接到另一台服务器'
  return (
    {
      ok: '已接入',
      none: row.present ? '未接入' : '未安装',
      invalid: '已失效',
      unknown: '无法判断',
      broken: '配置有误',
    }[row.connection] ?? '无法判断'
  )
}

function platformLines(row) {
  const head = connectionText(row)
  const facts = []
  if (row.connection === 'ok') {
    const app = row.who.app
    facts.push(`应用 ${plain(app.name)}（${plain(app.slug)}）`)
    const space = spaceText(row.who)
    if (space) facts.push(`空间 ${space}`)
    if (typeof row.who.accountName === 'string' && row.who.accountName) {
      facts.push(`账号 ${plain(row.who.accountName)}`)
    }
    if (app.runtimeFamily !== PLATFORMS[row.id].runtimeFamily) facts.push('应用的运行时不对')
  }
  if (row.otherServer) facts.push(shownUrl(row.url))
  if (row.reason) facts.push(row.reason)
  const first = [`${row.name}：${head}`, ...facts].join(' · ')
  // 没装、也没配过的平台只写一行
  if (!row.present && row.connection === 'none') return [first]
  const details = []
  if (row.connection === 'manual') details.push('访问密钥 无法判断（在 /plugin 里填）')
  details.push(`插件 ${PLUGIN_NAMES.get(row.plugin) ?? '无法判断'}`)
  const reenabled = row.reenabledIn ? `（被 ./${row.reenabledIn} 重新启用）` : ''
  details.push(`自带记忆 ${MEMORY_NAMES[row.memory] ?? '无法判断'}${reenabled}`)
  if (row.local) {
    // 未迁移的条数只在选过迁移、和 Kioku 比过之后才有
    const pending = !row.pending
      ? ''
      : row.pending.pending === null
        ? '（未迁移 无法判断）'
        : `（未迁移 ${row.pending.pending} 条）`
    details.push(`本地记忆 ${row.local} 条${pending}`)
  }
  return [first, `  ${details.join(' · ')}`]
}

// 面板的文字
export function renderPanel(state) {
  const lines = []
  const { server } = state
  if (!server) lines.push('服务器：未设置')
  else {
    const facts = []
    if (!server.reachable) facts.push(`无法连接（${server.problem}）`)
    else {
      facts.push(server.problem ?? '可连接')
      if (server.version) facts.push(`版本 ${server.version}`)
      if (server.needsSetup) facts.push('未初始化')
    }
    lines.push(`服务器：${shownUrl(server.url)}（${facts.join(' · ')}）`)
    const spaces = [
      ...new Set(
        state.platforms
          .filter((row) => row.connection === 'ok')
          .map((row) => spaceText(row.who))
          .filter(Boolean),
      ),
    ]
    if (spaces.length > 1) lines.push(`访问密钥分属 ${spaces.length} 个空间：${spaces.join('、')}`)
  }
  lines.push('')
  for (const row of state.platforms) lines.push(...platformLines(row))
  return lines.join('\n')
}

// 要接入的候选：有自己的配置、还没接到这台服务器的（失效的另算）
export function connectCandidates(state) {
  return state.platforms.filter(
    (row) =>
      PLATFORMS[row.id].setup &&
      row.connection !== 'invalid' &&
      !(row.connection === 'ok' && !row.otherServer),
  )
}

const names = (rows) => rows.map((row) => row.name).join('、')

// 面板下面列出的动作：{ value, label, hint? }，按缺什么排在前面
export function actionsFor(state) {
  const actions = []
  const { server } = state
  const ready = Boolean(server?.reachable && !server.problem && !server.needsSetup)
  if (!server || !server.reachable) {
    actions.push({ value: 'local', label: '本机起一个 Kioku', hint: '用 Docker' })
  }
  if (!server) actions.push({ value: 'server', label: '填写服务器地址' })
  if (server?.needsSetup) {
    actions.push({ value: 'open', label: '打开管理界面初始化', hint: '建第一个管理员' })
  }
  if (ready) {
    const candidates = connectCandidates(state)
    const present = candidates.filter((row) => row.present)
    if (present.length) {
      actions.push({
        value: 'connect',
        label: `接入 ${names(present)}（${present.length} 个未接入）`,
      })
    } else if (candidates.length) {
      actions.push({ value: 'connect', label: '接入其他平台', hint: '本机没发现的' })
    }
    const invalid = state.platforms.filter((row) => row.connection === 'invalid')
    if (invalid.length) {
      actions.push({ value: 'reauth', label: `重新授权 ${names(invalid)}（访问密钥已失效）` })
    }
  }
  // Claude Code 的访问密钥在它的 /plugin 里填，浏览器授权不给它发：插件没启用时列出安装与要填的地址，
  // 顺带停用自动记忆；插件启用了、自动记忆还开着时只停用自动记忆。项目设置又启用了的，停用也没用，不提供
  const claude = state.platforms.find((row) => row.id === 'claude-code')
  if (claude?.present && server && claude.plugin === false) {
    actions.push({ value: 'claude-connect', label: '接入 Claude Code', hint: '在 /plugin 里填' })
  } else if (claude?.present && claude.memory === 'on' && !claude.reenabledIn) {
    actions.push({ value: 'claude-memory', label: '停用 Claude Code 的自动记忆' })
  }
  if (ready) {
    for (const row of state.platforms) {
      if (!row.local) continue
      // 迁移要这个平台的访问密钥（Claude Code 的另外问）
      if (row.connection !== 'manual' && !(row.connection === 'ok' && !row.otherServer)) continue
      // 比过、确实都迁了的不再提供
      if (row.pending?.pending === 0) continue
      const count =
        typeof row.pending?.pending === 'number'
          ? `未迁移 ${row.pending.pending} 条`
          : `${row.local} 条`
      actions.push({ value: `import:${row.id}`, label: `迁移 ${row.name} 的本地记忆（${count}）` })
    }
  }
  if (state.platforms.some(canDisable)) {
    actions.push({ value: 'disable', label: '停用某个平台', hint: '恢复自带记忆、清掉配置' })
  }
  actions.push({ value: 'doctor', label: '检查（doctor）' })
  if (server) actions.push({ value: 'server', label: '更换服务器地址' })
  actions.push({ value: 'refresh', label: '刷新' })
  actions.push({ value: 'exit', label: '退出' })
  return actions
}
