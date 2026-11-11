// pi 这个平台的 kioku setup 与 kioku doctor。
// pi 没有自带的长期记忆要停用，扩展自己注册 MCP 服务，所以 setup 只做一件事：把服务地址与访问密钥写进本机的文件，
// 扩展读它

import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSettings, readText } from './files.mjs'
import { profileFile, readProfile, removeProfile, writeProfile } from './profile.mjs'
import { resolveTarget } from './target.mjs'

const SOURCE = 'git:github.com/lonelyman0108/kioku-plugins'

export function piHome(env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

// 包的来源写法有几种（git:、https://、本地路径），都带着仓库名
function installed(settings) {
  const packages = Array.isArray(settings?.packages) ? settings.packages : []
  return packages.some((entry) => {
    const source = typeof entry === 'string' ? entry : entry?.source
    return typeof source === 'string' && source.includes('kioku-plugins')
  })
}

export async function setupPi(options, io) {
  const { env, out } = io
  const profile = profileFile('pi', env)
  if (options.undo) {
    if (options.dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
    else if (await removeProfile('pi', env)) out.write(`已删掉 ${profile}\n`)
    else out.write(`${profile} 本来就没有\n`)
    out.write(`扩展要另外卸载：pi remove ${SOURCE}\n`)
    return 0
  }
  const { url, key, saved } = await resolveTarget({ id: 'pi', name: 'pi' }, options, io)
  const same = Boolean(saved && saved.url === url && saved.key === key)
  if (same) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!same) await writeProfile('pi', { url, key }, env)
  const { settings } = await readSettings(join(piHome(env), 'settings.json')).catch(() => ({}))
  out.write('pi 已配好，新开会话（或 /reload）生效。\n')
  if (!installed(settings)) out.write(`接下来装上扩展：pi install ${SOURCE}\n`)
  return 0
}

// 一份 mcp.json 里有没有叫 kioku 的服务；没有这个文件、读不懂时为假（读不懂的由 pi 自己报）
async function namesKioku(file) {
  try {
    return Object.hasOwn(JSON.parse((await readText(file)) ?? '{}')?.mcpServers ?? {}, 'kioku')
  } catch {
    return false
  }
}

export async function inspectPi({ env, cwd }, { ok, warn }) {
  const profile = await readProfile('pi', env).catch(() => null)
  if (!profile) warn('没有 kioku setup pi 写下的地址与访问密钥，扩展不会生效：运行 kioku setup pi')

  // 用户级的与当前项目的设置都看：扩展可以只装在项目里，项目的 mcp.json 也盖过扩展注册的服务
  const home = piHome(env)
  const project = join(cwd, '.pi')
  const user = await readSettings(join(home, 'settings.json'))
  const local = await readSettings(join(project, 'settings.json')).catch(() => ({}))
  if (installed(user.settings) || installed(local.settings)) ok('pi 里装了 kioku 的扩展')
  else warn(`pi 里没有装 kioku 的扩展：pi install ${SOURCE}`)

  const shadowing = []
  for (const file of [join(home, 'mcp.json'), join(project, 'mcp.json')]) {
    if (await namesKioku(file)) shadowing.push(file)
  }
  if (shadowing.length) {
    warn(`${shadowing.join('、')} 里有一个叫 kioku 的 MCP 服务，它会盖过扩展注册的那个：去掉它`)
  } else ok('MCP 服务由扩展在会话开始时注册')
  ok('pi 没有自带的长期记忆要停用')
}
