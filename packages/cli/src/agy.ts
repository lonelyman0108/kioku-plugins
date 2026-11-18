// Antigravity (agy) 这个平台的 kioku setup 与 kioku doctor。
// agy 没有自带的长期记忆要停用，setup 做两件事：
// 1. 把服务地址与访问密钥写进本机文件（只给本人读写，插件的 hooks.json 钩子读它）；
// 2. 在 ~/.gemini/config/mcp_config.json 里写入 mcpServers.kioku（Streamable HTTP）

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KiokuFailure, profileFile, readProfile, removeProfile, writeProfile } from './core.ts'
import { type JsonSettings, readSettings, safeWrite, serialize } from './files.ts'
import { resolveTarget } from './target.ts'
import type { Env, InspectCallbacks, PlatformStatus, SetupIo, SetupOptions } from './types.ts'

export function agyHome(env: Env): string {
  if (env.AGY_HOME) return env.AGY_HOME
  return join(env.HOME || homedir(), '.gemini', 'config')
}

export function agyMcpFile(env: Env): string {
  return join(agyHome(env), 'mcp_config.json')
}

export function bundledAgyDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const packaged = resolve(here, '..', 'assets', 'plugins', 'agy')
  if (existsSync(packaged)) return packaged
  return resolve(here, '..', '..', '..', 'plugins', 'agy')
}

function checkMcpShape(settings: JsonSettings, file: string): void {
  if (
    settings.mcpServers !== undefined &&
    (settings.mcpServers === null ||
      typeof settings.mcpServers !== 'object' ||
      Array.isArray(settings.mcpServers))
  ) {
    throw new KiokuFailure(`${file} 里的 mcpServers 不是对象，没有改动它`)
  }
}

interface AgyMcpEntry {
  url?: string
  headers?: { Authorization?: string }
}

function mcpEntry(url: string, key: string): { url: string; headers: { Authorization: string } } {
  return {
    url: `${url}/v1/mcp`,
    headers: { Authorization: `Bearer ${key}` },
  }
}

function sameMcp(existing: AgyMcpEntry | undefined, wanted: AgyMcpEntry): boolean {
  return (
    existing?.url === wanted.url &&
    existing?.headers?.Authorization === wanted.headers?.Authorization
  )
}

function hasStoredKey(settings: JsonSettings): boolean {
  const mcp = settings?.mcpServers as { kioku?: AgyMcpEntry } | undefined
  return Boolean(mcp?.kioku?.headers?.Authorization)
}

function buildMcp(
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
    return next
  }
  next.mcpServers = {
    ...((settings.mcpServers as Record<string, unknown> | undefined) ?? {}),
    kioku: mcpEntry(url ?? '', key ?? ''),
  }
  return next
}

async function pluginInstalled(env: Env, cwd: string): Promise<boolean> {
  for (const file of [
    join(agyHome(env), 'plugins', 'kioku', 'plugin.json'),
    join(cwd, '.agents', 'plugins', 'kioku', 'plugin.json'),
  ]) {
    if ((await stat(file).catch(() => null))?.isFile()) return true
  }
  return false
}

export async function preflightAgy({ env }: { env: Env }): Promise<void> {
  const file = agyMcpFile(env)
  const { settings } = await readSettings(file)
  checkMcpShape(settings, file)
}

export async function setupAgy(options: SetupOptions, io: SetupIo): Promise<number> {
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
      `接下来安装插件以启用生命周期钩子：cp -r ${bundledAgyDir()} ${join(agyHome(env), 'plugins', 'kioku')}\n`,
    )
  }
  return 0
}

export async function inspectAgy(
  { env, cwd }: { env: Env; cwd: string },
  { ok, warn }: InspectCallbacks,
): Promise<void> {
  const profile = await readProfile('agy', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup agy 写下的地址与访问密钥，插件钩子不会生效：运行 kioku setup agy')
  }

  const file = agyMcpFile(env)
  const { settings } = await readSettings(file)
  const entry = (settings?.mcpServers as Record<string, AgyMcpEntry> | undefined)?.kioku
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
  else {
    warn(
      `Antigravity 未安装 kioku 插件：将 ${bundledAgyDir()} 放到 ${join(agyHome(env), 'plugins', 'kioku')}`,
    )
  }
  ok('Antigravity 没有自带的长期记忆要停用')
}

export async function statusAgy({ env, cwd }: { env: Env; cwd: string }): Promise<PlatformStatus> {
  return { plugin: await pluginInstalled(env, cwd), memory: 'none' }
}
