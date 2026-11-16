// DeepSeek Harness 这个平台的 kioku setup 与 kioku doctor。
// 它没有自带的长期记忆要停用；插件与 MCP 客户端都由本仓库的补丁装上，读本机文件里的服务地址与访问密钥。
// 所以 setup 只做一件事：把服务地址与访问密钥写进本机的文件

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSettings } from './files.mjs'
import { profileFile, readProfile, removeProfile, writeProfile } from './profile.mjs'
import { plain } from './text.mjs'
import { resolveTarget } from './target.mjs'

const PACKAGE = 'kioku-plugins'
const SOURCE = 'github:lonelyman0108/kioku-plugins'

export function dshHome(env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

// 装了本仓库这个包的 profile 的名字；没有 profile 目录时为空
async function installedProfiles(env) {
  const root = join(dshHome(env), 'profiles')
  const names = await readdir(root).catch(() => [])
  const found = []
  for (const name of names.sort()) {
    const { settings } = await readSettings(join(root, name, 'package.json')).catch(() => ({}))
    const bundles = settings?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE)) found.push(name)
  }
  return found
}

const installHint = `dsh plugin --profile <profile> add ${SOURCE}`

export async function setupDsh(options, io) {
  const { env, out } = io
  const profile = profileFile('dsh', env)
  if (options.undo) {
    if (options.dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
    else if (await removeProfile('dsh', env)) out.write(`已删掉 ${profile}\n`)
    else out.write(`${profile} 本来就没有\n`)
    out.write(`插件要另外卸载：dsh plugin --profile <profile> remove ${PACKAGE}\n`)
    return 0
  }
  const { url, key, saved } = await resolveTarget(
    { id: 'dsh', name: 'DeepSeek Harness' },
    options,
    io,
  )
  const same = Boolean(saved && saved.url === url && saved.key === key)
  if (same) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!same) await writeProfile('dsh', { url, key }, env)
  const profiles = await installedProfiles(env)
  out.write('DeepSeek Harness 已配好，重启 dsh 后生效（读写记忆的工具在启动时连上）。\n')
  if (profiles.length) out.write(`装了插件的 profile：${profiles.map(plain).join('、')}\n`)
  else if (io.hints !== false) {
    out.write(`接下来给要用的 profile 装上插件（web、tui 这些各装一次）：${installHint}\n`)
  }
  return 0
}

export async function inspectDsh({ env }, { ok, warn, note }) {
  const profile = await readProfile('dsh', env).catch(() => null)
  if (!profile)
    warn('没有 kioku setup dsh 写下的地址与访问密钥，插件不会生效：运行 kioku setup dsh')
  const profiles = await installedProfiles(env)
  if (profiles.length) ok(`装了 kioku 插件的 profile：${profiles.map(plain).join('、')}`)
  else warn(`没有哪个 profile 装了 kioku 的插件：${installHint}`)
  note('插件按 profile 装：没装的 profile 里没有长期记忆')
  ok('DeepSeek Harness 没有自带的长期记忆要停用')
}

// 给向导的面板：有没有哪个 profile 装了插件，dsh 没有自带的长期记忆
export async function statusDsh({ env }) {
  return { plugin: (await installedProfiles(env)).length > 0, memory: 'none' }
}
