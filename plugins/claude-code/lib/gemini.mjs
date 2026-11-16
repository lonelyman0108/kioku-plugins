// Gemini CLI 这个平台的 kioku setup 与 kioku doctor。
// setup 做三件事：
// 1. 把服务地址与访问密钥写进本机文件（只给本人读写，扩展的钩子读它）；
// 2. 在 ~/.gemini/settings.json 里写入 mcpServers.kioku；
// 3. 把自带记忆工具 save_memory 加进 excludeTools 停用

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSettings, safeWrite, serialize } from './files.mjs'
import { KiokuFailure } from './http.mjs'
import { profileFile, readProfile, removeProfile, writeProfile } from './profile.mjs'
import { resolveTarget } from './target.mjs'

export function geminiHome(env) {
  if (env.GEMINI_CLI_HOME) return join(env.GEMINI_CLI_HOME, '.gemini')
  return join(env.HOME || homedir(), '.gemini')
}

export function geminiSettingsFile(env) {
  return join(geminiHome(env), 'settings.json')
}

function checkStructure(settings, file) {
  if (
    settings.mcpServers !== undefined &&
    (settings.mcpServers === null ||
      typeof settings.mcpServers !== 'object' ||
      Array.isArray(settings.mcpServers))
  ) {
    throw new KiokuFailure(`${file} 里的 mcpServers 不是对象，没有改动它`)
  }
  if (settings.excludeTools !== undefined && !Array.isArray(settings.excludeTools)) {
    throw new KiokuFailure(`${file} 里的 excludeTools 不是数组，没有改动它`)
  }
}

function mcpEntry(url, key) {
  return {
    httpUrl: `${url}/v1/mcp`,
    headers: { Authorization: `Bearer ${key}` },
  }
}

function sameMcp(existing, wanted) {
  return (
    existing?.httpUrl === wanted.httpUrl &&
    existing?.headers?.Authorization === wanted.headers.Authorization
  )
}

function hasStoredKey(settings) {
  return Boolean(settings?.mcpServers?.kioku?.headers?.Authorization)
}

function buildSettings(settings, { url, key, undo }) {
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
    if (Array.isArray(settings.excludeTools) && settings.excludeTools.includes('save_memory')) {
      const filtered = settings.excludeTools.filter((tool) => tool !== 'save_memory')
      if (filtered.length) next.excludeTools = filtered
      else delete next.excludeTools
    }
    return next
  }

  next.mcpServers = { ...(settings.mcpServers ?? {}), kioku: mcpEntry(url, key) }
  const excludes = Array.isArray(settings.excludeTools) ? [...settings.excludeTools] : []
  if (!excludes.includes('save_memory')) excludes.push('save_memory')
  next.excludeTools = excludes
  return next
}

async function extensionInstalled(env, cwd) {
  for (const dir of [
    join(geminiHome(env), 'extensions', 'kioku'),
    join(cwd, '.gemini', 'extensions', 'kioku'),
  ]) {
    if ((await stat(join(dir, 'gemini-extension.json')).catch(() => null))?.isFile()) return true
  }
  return false
}

export async function preflightGemini({ env }) {
  const file = geminiSettingsFile(env)
  const { settings } = await readSettings(file)
  checkStructure(settings, file)
}

export async function setupGemini(options, io) {
  const { env, out, cwd } = io
  const profile = profileFile('gemini', env)
  const file = geminiSettingsFile(env)

  if (options.undo) {
    const { settings, text } = await readSettings(file)
    checkStructure(settings, file)
    const next = buildSettings(settings, { undo: true })
    if (JSON.stringify(settings) === JSON.stringify(next)) {
      if (text !== null) out.write(`${file} 不用改\n`)
    } else {
      out.write(`${file}：去掉 mcpServers.kioku，恢复 save_memory\n`)
      if (!options.dryRun) {
        // 原文件里带着访问密钥时不留备份
        await safeWrite(file, serialize(next, text), text, { backup: !hasStoredKey(settings) })
      }
    }

    if (options.dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
    else if (await removeProfile('gemini', env)) out.write(`已删掉 ${profile}\n`)
    else out.write(`${profile} 本来就没有\n`)
    return 0
  }

  await preflightGemini({ env })
  const { url, key, saved } = await resolveTarget({ id: 'gemini', name: 'Gemini CLI' }, options, {
    ...io,
    beforeLogin: () => preflightGemini({ env }),
  })

  const { settings, text } = await readSettings(file)
  checkStructure(settings, file)
  const next = buildSettings(settings, { url, key, undo: false })
  const sameProfile = Boolean(saved && saved.url === url && saved.key === key)
  const sameFile = JSON.stringify(settings) === JSON.stringify(next)

  if (sameProfile) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)

  if (sameFile) out.write(`${file} 不用改\n`)
  else out.write(`${file}：配置 mcpServers.kioku，停用自带 save_memory\n`)

  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }

  if (!sameProfile) await writeProfile('gemini', { url, key }, env)
  if (!sameFile) {
    const backedUp = await safeWrite(file, serialize(next, text), text, {
      backup: !hasStoredKey(settings),
    })
    if (backedUp) out.write(`原配置已备份到 ${file}.kioku-backup\n`)
  }
  out.write('Gemini CLI 已配好，重启 Gemini CLI 后生效。\n')
  if (!(await extensionInstalled(env, cwd)) && io.hints !== false) {
    out.write(
      '接下来链接扩展以启用生命周期钩子：gemini extensions link <仓库目录>/plugins/gemini\n',
    )
  }
  return 0
}

export async function inspectGemini({ env, cwd }, { ok, warn }) {
  const profile = await readProfile('gemini', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup gemini 写下的地址与访问密钥，扩展钩子不会生效：运行 kioku setup gemini')
  }

  const file = geminiSettingsFile(env)
  const { settings } = await readSettings(file)
  const entry = settings?.mcpServers?.kioku
  if (!entry) {
    warn(`${file} 里没有 mcpServers.kioku：运行 kioku setup gemini`)
  } else if (!entry.httpUrl) {
    warn(`${file} 里的 mcpServers.kioku 缺少 httpUrl：运行 kioku setup gemini`)
  } else if (profile && !sameMcp(entry, mcpEntry(profile.url, profile.key))) {
    warn(`${file} 里的 mcpServers.kioku 与当前地址或访问密钥不一致：运行 kioku setup gemini`)
  } else {
    ok(`${file} 里的 mcpServers.kioku 已配好`)
  }

  if (Array.isArray(settings?.excludeTools) && settings.excludeTools.includes('save_memory')) {
    ok('Gemini CLI 自带的 save_memory 已停用（excludeTools）')
  } else {
    warn('Gemini CLI 自带的 save_memory 还开着：运行 kioku setup gemini 停用它')
  }

  if (await extensionInstalled(env, cwd)) ok('Gemini CLI 已安装 kioku 扩展')
  else warn('Gemini CLI 未安装 kioku 扩展：运行 gemini extensions link <仓库目录>/plugins/gemini')
}

export async function statusGemini({ env, cwd }) {
  const plugin = await extensionInstalled(env, cwd)
  const { settings } = await readSettings(geminiSettingsFile(env)).catch(() => ({}))
  const off = Array.isArray(settings?.excludeTools) && settings.excludeTools.includes('save_memory')
  return { plugin, memory: off ? 'off' : 'on' }
}
