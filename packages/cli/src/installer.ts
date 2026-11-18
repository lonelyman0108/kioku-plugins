// 插件自动安装、版本升级、安全卸载与连通性握手（whoami + MCP tools/list）

import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { agyHome, bundledAgyDir } from './agy.ts'
import { whoami } from './api.ts'
import { capture, failureText, hasCommand, listTools, plain, writeToolCache } from './core.ts'
import { bundledGeminiDir } from './gemini.ts'
import { PLATFORMS } from './platforms.ts'
import type { Env, TargetConfig, WhoamiResponse } from './types.ts'
import { layerLabel, sensitivityBadge } from './ui/theme.ts'

export const CLI_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version
const MANAGED_MARKER = '.kioku-managed.json'
const EXCLUDE_ASSETS = new Set(['node_modules', '__tests__', '.vitest', '.DS_Store', 'coverage'])

export interface PluginInstallResult {
  id: string
  status: 'installed' | 'upgraded' | 'already' | 'manual' | 'failed'
  message: string
  commands?: string[]
  after?: string
}

async function readManagedMarker(
  dir: string,
): Promise<{ version?: string; managedBy?: string } | null> {
  try {
    const raw = await readFile(join(dir, MANAGED_MARKER), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string; managedBy?: string } | null
    if (parsed && parsed.managedBy === '@kioku-memory/cli') return parsed
    return null
  } catch {
    return null
  }
}

async function copyBundledAgy({
  env,
  upgrade = false,
}: {
  env: Env
  upgrade?: boolean
}): Promise<PluginInstallResult> {
  const targetDir = join(agyHome(env), 'plugins', 'kioku')
  const st = await lstat(targetDir).catch(() => null)
  const marker = st?.isDirectory() ? await readManagedMarker(targetDir) : null

  if (st && !marker) {
    return {
      id: 'agy',
      status: 'already',
      message: `Antigravity 插件目录已存在（手动管理：${plain(targetDir)}）`,
    }
  }
  if (marker && !upgrade) {
    return {
      id: 'agy',
      status: 'already',
      message: `Antigravity 插件已安装（版本 ${plain(marker.version ?? CLI_VERSION)}）`,
    }
  }

  const srcDir = bundledAgyDir()
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  await cp(srcDir, targetDir, {
    recursive: true,
    filter: (src) => !EXCLUDE_ASSETS.has(src.split(/[/\\]/).pop() ?? ''),
  })
  await writeFile(
    join(targetDir, MANAGED_MARKER),
    `${JSON.stringify({ name: 'kioku', managedBy: '@kioku-memory/cli', version: CLI_VERSION, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  return {
    id: 'agy',
    status: marker ? 'upgraded' : 'installed',
    message: `${marker ? '已更新' : '已安装'} Antigravity 插件到 ${plain(targetDir)}`,
  }
}

export async function removeManagedAgyPlugin({ env }: { env: Env }): Promise<boolean> {
  const targetDir = join(agyHome(env), 'plugins', 'kioku')
  const marker = await readManagedMarker(targetDir)
  if (!marker) return false
  await rm(targetDir, { recursive: true, force: true })
  return true
}

async function runCliSteps(
  bin: string,
  steps: string[][],
  env: Env,
  timeout = 60_000,
): Promise<{ ok: boolean; found: boolean }> {
  if (!hasCommand(bin, env)) return { ok: false, found: false }
  for (const args of steps) {
    const res = await capture(bin, args, env, { timeout })
    if (!res.found) return { ok: false, found: false }
    if (!res.ok) return { ok: false, found: true }
  }
  return { ok: true, found: true }
}

export async function installPlugin(
  id: string,
  { env, cwd = process.cwd(), upgrade = false }: { env: Env; cwd?: string; upgrade?: boolean },
): Promise<PluginInstallResult> {
  const platform = PLATFORMS[id]
  if (!platform) {
    return { id, status: 'failed', message: `不认识的平台 ${id}` }
  }

  const currentStatus = await platform.status({ env, cwd }).catch(() => ({ plugin: null }))
  if (currentStatus.plugin === true && !upgrade && id !== 'agy') {
    return { id, status: 'already', message: `${platform.name} 插件已安装` }
  }

  if (id === 'agy') {
    return copyBundledAgy({ env, upgrade })
  }

  if (id === 'opencode') {
    return {
      id,
      status: currentStatus.plugin ? 'already' : 'manual',
      message: currentStatus.plugin
        ? 'OpenCode 已在 opencode.json 中登记插件'
        : '运行 kioku connect opencode（或 kioku setup opencode）自动写入 opencode.json',
      commands: platform.install.commands,
      after: platform.install.after,
    }
  }

  if (id === 'claude-code') {
    const bin = platform.command(env)
    const steps = upgrade
      ? [
          ['plugin', 'marketplace', 'update'],
          ['plugin', 'update', 'kioku@kioku'],
        ]
      : [
          ['plugin', 'marketplace', 'add', 'lonelyman0108/kioku-plugins'],
          ['plugin', 'install', 'kioku@kioku'],
        ]
    const res = await runCliSteps(bin, steps, env)
    if (res.ok) {
      return {
        id,
        status: upgrade ? 'upgraded' : 'installed',
        message: `${upgrade ? '已更新' : '已安装'} Claude Code 插件`,
      }
    }
    return {
      id,
      status: 'manual',
      message: res.found
        ? '未能自动安装 Claude Code 插件，请在 Claude Code 会话内手动安装'
        : '未找到 claude 命令，请在 Claude Code 会话内运行以下命令',
      commands: platform.install.commands,
      after: platform.install.after,
    }
  }

  if (id === 'codex') {
    const bin = platform.command(env)
    const steps = upgrade
      ? [['plugin', 'add', 'kioku@kioku']]
      : [
          ['plugin', 'marketplace', 'add', 'lonelyman0108/kioku-plugins'],
          ['plugin', 'add', 'kioku@kioku'],
        ]
    const res = await runCliSteps(bin, steps, env)
    if (res.ok) {
      return {
        id,
        status: upgrade ? 'upgraded' : 'installed',
        message: `${upgrade ? '已更新' : '已安装'} Codex 插件（请打开 Codex 在 /hooks 中信任钩子）`,
        after: platform.install.after,
      }
    }
    return {
      id,
      status: 'manual',
      message: res.found ? '未能自动安装 Codex 插件，请手动运行' : '未找到 codex 命令，请手动运行',
      commands: platform.install.commands,
      after: platform.install.after,
    }
  }

  if (id === 'gemini') {
    const bin = platform.command(env)
    const bundled = bundledGeminiDir()
    const res = await runCliSteps(bin, [['extensions', 'link', bundled]], env)
    if (res.ok) {
      return {
        id,
        status: upgrade ? 'upgraded' : 'installed',
        message: `${upgrade ? '已重新链接' : '已链接'} Gemini CLI 扩展（${plain(bundled)}）`,
      }
    }
    return {
      id,
      status: 'manual',
      message: res.found
        ? '未能自动链接 Gemini CLI 扩展，请手动运行'
        : '未找到 gemini 命令，请手动运行',
      commands: [`gemini extensions link ${bundled}`],
      after: platform.install.after,
    }
  }

  if (id === 'pi') {
    const bin = platform.command(env)
    const step = upgrade
      ? ['update', 'git:github.com/lonelyman0108/kioku-plugins']
      : ['install', 'git:github.com/lonelyman0108/kioku-plugins']
    const res = await runCliSteps(bin, [step], env)
    if (res.ok) {
      return {
        id,
        status: upgrade ? 'upgraded' : 'installed',
        message: `${upgrade ? '已更新' : '已安装'} pi 扩展`,
      }
    }
    return {
      id,
      status: 'manual',
      message: res.found ? '未能自动安装 pi 扩展，请手动运行' : '未找到 pi 命令，请手动运行',
      commands: platform.install.commands,
      after: platform.install.after,
    }
  }

  if (id === 'hermes') {
    const bin = platform.command(env)
    const res = await runCliSteps(
      bin,
      [['plugins', 'install', 'lonelyman0108/kioku-plugins/plugins/hermes', '--enable']],
      env,
      120_000,
    )
    if (res.ok) {
      return {
        id,
        status: upgrade ? 'upgraded' : 'installed',
        message: `${upgrade ? '已更新' : '已安装'} Hermes 记忆 provider`,
      }
    }
    return {
      id,
      status: 'manual',
      message: res.found
        ? '未能自动安装 Hermes 插件，请手动运行'
        : '未找到 hermes 命令，请手动运行',
      commands: platform.install.commands,
      after: platform.install.after,
    }
  }

  if (id === 'openclaw') {
    const bin = platform.command(env)
    const res = await runCliSteps(
      bin,
      [
        ['plugins', 'install', 'npm:@kioku-memory/openclaw'],
        ['gateway', 'restart'],
      ],
      env,
      120_000,
    )
    if (res.ok) {
      return {
        id,
        status: upgrade ? 'upgraded' : 'installed',
        message: `${upgrade ? '已更新' : '已安装'} OpenClaw 插件并重启网关`,
      }
    }
    return {
      id,
      status: 'manual',
      message: res.found
        ? '未能自动安装 OpenClaw 插件，请手动运行'
        : '未找到 openclaw 命令，请手动运行',
      commands: platform.install.commands,
      after: platform.install.after,
    }
  }

  // DeepSeek Harness 需要用户指定目标 profile（如 web / tui）
  return {
    id,
    status: 'manual',
    message: 'DeepSeek Harness 需按 profile 分别安装扩展，请在要使用的 profile 上运行',
    commands: platform.install.commands,
    after: platform.install.after,
  }
}

export interface HandshakeReport {
  ok: boolean
  who?: WhoamiResponse
  tools?: Array<{ name: string; description?: string }>
  toolCount?: number
  problem?: string
}

export async function verifyConnectionHandshake(
  id: string,
  config: TargetConfig,
  { env }: { env: Env },
): Promise<HandshakeReport> {
  try {
    const who = await whoami(config)
    let tools: Array<{ name: string; description?: string }> = []
    try {
      tools = (await listTools(config)) as Array<{ name: string; description?: string }>
      if (id === 'openclaw' && tools.length) {
        await writeToolCache('openclaw', { url: config.url, tools }, env).catch(() => {})
      }
    } catch {
      // MCP 握手失败不阻断身份验证展示
      return { ok: true, who }
    }
    return { ok: true, who, tools, toolCount: tools.length }
  } catch (err) {
    return { ok: false, problem: failureText(err) }
  }
}

export function formatHandshakeLines(report: HandshakeReport): string[] {
  if (!report.ok || !report.who) {
    return [`✗ 连通测试失败：${report.problem ?? '未知错误'}`]
  }
  const { who, toolCount } = report
  const space = who.spaceName
    ? plain(who.spaceName)
    : who.spaceId
      ? plain(who.spaceId).slice(0, 8)
      : '默认空间'
  const readScopes = (who.scopes.readLayers ?? []).map(layerLabel).join('、') || '无'
  const writeScopes = (who.scopes.writeLayers ?? []).map(layerLabel).join('、') || '无'
  const maxSens = sensitivityBadge(who.scopes.maxSensitivity ?? 'internal')
  const mcpNote = typeof toolCount === 'number' ? ` · MCP 工具 ${toolCount} 个` : ''
  return [
    `✓ 握手成功：应用 ${plain(who.app.name)}（${plain(who.app.slug)}） · 空间 ${space}${mcpNote}`,
    `  读归属：${readScopes} · 写归属：${writeScopes} · 上限：${maxSens}`,
  ]
}
