// Gemini CLI 这个平台的 kioku setup 与 kioku doctor。
// 把服务地址与访问密钥写进本机文件（只给本人读写，扩展的钩子读它）；
// 在 ~/.gemini/settings.json 里写入 mcpServers.kioku；并把自带记忆工具 save_memory 加进 excludeTools 停用

import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KiokuFailure,
  profileDir,
  profileFile,
  readProfile,
  removeProfile,
  writeProfile,
} from './core.ts'
import { hasInlineSecret, type JsonSettings, readSettings, safeWrite, serialize } from './files.ts'
import { resolveTarget } from './target.ts'
import type { Env, InspectCallbacks, PlatformStatus, SetupIo, SetupOptions } from './types.ts'

export function geminiHome(env: Env): string {
  if (env.GEMINI_CLI_HOME) return join(env.GEMINI_CLI_HOME, '.gemini')
  return join(env.HOME || homedir(), '.gemini')
}

export function geminiSettingsFile(env: Env): string {
  return join(geminiHome(env), 'settings.json')
}

export function bundledGeminiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const packaged = resolve(here, '..', 'assets', 'plugins', 'gemini')
  if (existsSync(packaged)) return packaged
  return resolve(here, '..', '..', '..', 'plugins', 'gemini')
}

function checkStructure(settings: JsonSettings, file: string): void {
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

interface GeminiMcpEntry {
  httpUrl?: string
  headers?: { Authorization?: string }
}

function mcpEntry(
  url: string,
  key: string,
): { httpUrl: string; headers: { Authorization: string } } {
  return {
    httpUrl: `${url}/v1/mcp`,
    headers: { Authorization: `Bearer ${key}` },
  }
}

function sameMcp(existing: GeminiMcpEntry | undefined, wanted: GeminiMcpEntry): boolean {
  return (
    existing?.httpUrl === wanted.httpUrl &&
    existing?.headers?.Authorization === wanted.headers?.Authorization
  )
}

function hasStoredKey(settings: JsonSettings): boolean {
  const mcp = settings?.mcpServers as { kioku?: GeminiMcpEntry } | undefined
  return Boolean(mcp?.kioku?.headers?.Authorization)
}

function buildSettings(
  settings: JsonSettings,
  { url, key, undo }: { url?: string; key?: string; undo: boolean },
): JsonSettings {
  const next = { ...settings }
  if (undo) {
    if (
      settings.mcpServers &&
      typeof settings.mcpServers === 'object' &&
      !Array.isArray(settings.mcpServers) &&
      Object.hasOwn(settings.mcpServers, 'kioku')
    ) {
      const mcp = { ...(settings.mcpServers as Record<string, unknown>) }
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

  next.mcpServers = {
    ...((settings.mcpServers as Record<string, unknown> | undefined) ?? {}),
    kioku: mcpEntry(url ?? '', key ?? ''),
  }
  const excludes = Array.isArray(settings.excludeTools) ? [...settings.excludeTools] : []
  if (!excludes.includes('save_memory')) excludes.push('save_memory')
  next.excludeTools = excludes
  return next
}

async function extensionInstalled(env: Env, cwd: string): Promise<boolean> {
  for (const dir of [
    join(geminiHome(env), 'extensions', 'kioku'),
    join(cwd, '.gemini', 'extensions', 'kioku'),
  ]) {
    if ((await stat(join(dir, 'gemini-extension.json')).catch(() => null))?.isFile()) return true
  }
  return false
}

export async function preflightGemini({ env }: { env: Env }): Promise<void> {
  const file = geminiSettingsFile(env)
  const { settings } = await readSettings(file)
  checkStructure(settings, file)
}

export async function setupGemini(options: SetupOptions, io: SetupIo): Promise<number> {
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
        await safeWrite(file, serialize(next, text), text, {
          backup: !hasStoredKey(settings) && !hasInlineSecret(text),
        })
      }
    }

    if (options.dryRun) out.write(`${profile}：删掉\n没有写入（--dry-run）\n`)
    else {
      if (await removeProfile('gemini', env)) out.write(`已删掉 ${profile}\n`)
      else out.write(`${profile} 本来就没有\n`)
      await rm(join(profileDir(env), 'gemini-state'), { recursive: true, force: true }).catch(
        () => {},
      )
      if (await extensionInstalled(env, cwd)) {
        out.write('扩展要另外卸载：gemini extensions uninstall kioku\n')
      }
    }
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
      backup: !hasStoredKey(settings) && !hasInlineSecret(text),
    })
    if (backedUp) out.write(`原配置已备份到 ${file}.kioku-backup\n`)
  }
  out.write('Gemini CLI 已配好，重启 Gemini CLI 后生效。\n')
  if (!(await extensionInstalled(env, cwd)) && io.hints !== false) {
    out.write(`接下来链接扩展以启用生命周期钩子：gemini extensions link ${bundledGeminiDir()}\n`)
  }
  return 0
}

export async function inspectGemini(
  { env, cwd }: { env: Env; cwd: string },
  { ok, warn }: InspectCallbacks,
): Promise<void> {
  const profile = await readProfile('gemini', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup gemini 写下的地址与访问密钥，扩展钩子不会生效：运行 kioku setup gemini')
  }

  const file = geminiSettingsFile(env)
  const { settings } = await readSettings(file)
  const entry = (settings?.mcpServers as Record<string, GeminiMcpEntry> | undefined)?.kioku
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
  else warn(`Gemini CLI 未安装 kioku 扩展：运行 gemini extensions link ${bundledGeminiDir()}`)
}

export async function statusGemini({
  env,
  cwd,
}: {
  env: Env
  cwd: string
}): Promise<PlatformStatus> {
  const plugin = await extensionInstalled(env, cwd)
  const { settings } = await readSettings(geminiSettingsFile(env)).catch(() => ({
    settings: undefined,
  }))
  const off = Array.isArray(settings?.excludeTools) && settings.excludeTools.includes('save_memory')
  return { plugin, memory: off ? 'off' : 'on' }
}
