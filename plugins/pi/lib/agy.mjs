// Antigravity (agy) 这个平台的 kioku setup 与 kioku doctor。
// agy 没有自带的长期记忆要停用，setup 做两件事：
// 1. 把服务地址与访问密钥写进本机文件（只给本人读写，插件的 hooks.json 钩子读它）；
// 2. 在 ~/.gemini/config/mcp_config.json 里写入 mcpServers.kioku（Streamable HTTP）

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSettings, safeWrite, serialize } from './files.mjs'
import { KiokuFailure } from './http.mjs'
import { profileFile, readProfile, removeProfile, writeProfile } from './profile.mjs'
import { resolveTarget } from './target.mjs'

export function agyHome(env) {
  if (env.AGY_HOME) return env.AGY_HOME
  return join(env.HOME || homedir(), '.gemini', 'config')
}

export function agyMcpFile(env) {
  return join(agyHome(env), 'mcp_config.json')
}

function checkMcpShape(settings, file) {
  if (
    settings.mcpServers !== undefined &&
    (settings.mcpServers === null ||
      typeof settings.mcpServers !== 'object' ||
      Array.isArray(settings.mcpServers))
  ) {
    throw new KiokuFailure(`${file} 里的 mcpServers 不是对象，没有改动它`)
  }
}

function mcpEntry(url, key) {
  return {
    url: `${url}/v1/mcp`,
    headers: { Authorization: `Bearer ${key}` },
  }
}

function sameMcp(existing, wanted) {
  return (
    existing?.url === wanted.url &&
    existing?.headers?.Authorization === wanted.headers.Authorization
  )
}

function hasStoredKey(settings) {
  return Boolean(settings?.mcpServers?.kioku?.headers?.Authorization)
}

function buildMcp(settings, { url, key, undo }) {
  const next = { ...settings }
  if (undo) {
    if (
      settings.mcpServers &&
      typeof settings.mcpServers === 'object' &&
      Object.hasOwn(settings.mcpServers, 'kioku')
    ) {
      const mcp = { ...settings.mcpServers }
      delete mcp.kioku
      if (Object.keys(mcp).length) next.mcpServers = mcp
      else delete next.mcpServers
    }
    return next
  }
  next.mcpServers = { ...(settings.mcpServers ?? {}), kioku: mcpEntry(url, key) }
  return next
}

async function pluginInstalled(env, cwd) {
  for (const file of [
    join(agyHome(env), 'plugins', 'kioku', 'plugin.json'),
    join(cwd, '.agents', 'plugins', 'kioku', 'plugin.json'),
  ]) {
    if ((await stat(file).catch(() => null))?.isFile()) return true
  }
  return false
}

export async function preflightAgy({ env }) {
  const file = agyMcpFile(env)
  const { settings } = await readSettings(file)
  checkMcpShape(settings, file)
}

export async function setupAgy(options, io) {
  const { env, out, cwd } = io
  const profile = profileFile('agy', env)
  const file = agyMcpFile(env)

  if (options.undo) {
    const { settings, text } = await readSettings(file)
    checkMcpShape(settings, file)
    const next = buildMcp(settings, { undo: true })
    if (JSON.stringify(settings) === JSON.stringify(next)) {
      if (text !== null) out.write(`${file} 不用改\n`)
    } else {
      out.write(`${file}：去掉 mcpServers.kioku\n`)
      if (!options.dryRun) {
        // 原文件里带着访问密钥时不留备份
        await safeWrite(file, serialize(next, text), text, { backup: !hasStoredKey(settings) })
      }
    }

    if (options.dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
    else if (await removeProfile('agy', env)) out.write(`已删掉 ${profile}\n`)
    else out.write(`${profile} 本来就没有\n`)
    return 0
  }

  await preflightAgy({ env })
  const { url, key, saved } = await resolveTarget({ id: 'agy', name: 'Antigravity' }, options, {
    ...io,
    beforeLogin: () => preflightAgy({ env }),
  })

  const { settings, text } = await readSettings(file)
  checkMcpShape(settings, file)
  const next = buildMcp(settings, { url, key, undo: false })
  const sameProfile = Boolean(saved && saved.url === url && saved.key === key)
  const sameFile = JSON.stringify(settings) === JSON.stringify(next)

  if (sameProfile) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)

  if (sameFile) out.write(`${file} 不用改\n`)
  else out.write(`${file}：配置 mcpServers.kioku\n`)

  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }

  if (!sameProfile) await writeProfile('agy', { url, key }, env)
  if (!sameFile) {
    const backedUp = await safeWrite(file, serialize(next, text), text, {
      backup: !hasStoredKey(settings),
    })
    if (backedUp) out.write(`原配置已备份到 ${file}.kioku-backup\n`)
  }
  out.write('Antigravity 已配好，新开会话生效。\n')
  if (!(await pluginInstalled(env, cwd)) && io.hints !== false) {
    out.write(
      `接下来安装插件以启用生命周期钩子：cp -r <仓库目录>/plugins/agy ${join(agyHome(env), 'plugins', 'kioku')}\n`,
    )
  }
  return 0
}

export async function inspectAgy({ env, cwd }, { ok, warn }) {
  const profile = await readProfile('agy', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup agy 写下的地址与访问密钥，插件钩子不会生效：运行 kioku setup agy')
  }

  const file = agyMcpFile(env)
  const { settings } = await readSettings(file)
  const entry = settings?.mcpServers?.kioku
  if (!entry) {
    warn(`${file} 里没有 mcpServers.kioku：运行 kioku setup agy`)
  } else if (!entry.url) {
    warn(`${file} 里的 mcpServers.kioku 缺少 url：运行 kioku setup agy`)
  } else if (profile && !sameMcp(entry, mcpEntry(profile.url, profile.key))) {
    warn(`${file} 里的 mcpServers.kioku 与当前地址或访问密钥不一致：运行 kioku setup agy`)
  } else {
    ok(`${file} 里的 mcpServers.kioku 已配好`)
  }

  if (await pluginInstalled(env, cwd)) ok('Antigravity 已安装 kioku 插件')
  else
    warn(
      `Antigravity 未安装 kioku 插件：将 plugins/agy 放到 ${join(agyHome(env), 'plugins', 'kioku')}`,
    )
  ok('Antigravity 没有自带的长期记忆要停用')
}

export async function statusAgy({ env, cwd }) {
  return { plugin: await pluginInstalled(env, cwd), memory: 'none' }
}
