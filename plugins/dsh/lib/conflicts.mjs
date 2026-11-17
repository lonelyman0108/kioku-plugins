// 冲突记忆工具（Lore 与常见记忆 MCP）的只读探测与按平台清理。
// 只解除当前目标平台上的冲突配置或插件挂载，不跨平台改动，不删用户服务端数据目录（如 ~/.lore/docker）。

import { lstat, rm, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { agyHome, agyMcpFile } from './agy.mjs'
import { bracketDelta, codexHome, headerOf } from './codex.mjs'
import { capture, hasCommand } from './command.mjs'
import { dshHome } from './dsh.mjs'
import { readSettings, readText, safeWrite, serialize } from './files.mjs'
import { geminiHome, geminiSettingsFile } from './gemini.mjs'
import { hermesHome, withEnv } from './hermes.mjs'
import { KiokuFailure } from './http.mjs'
import { confirm } from './import.mjs'
import { opencodeHome } from './opencode.mjs'
import { piHome } from './pi.mjs'
import { plain } from './text.mjs'

export const CONFLICT_TOOLS = {
  lore: 'Lore',
  mem0: 'Mem0',
  supermemory: 'Supermemory',
  'mcp-memory': 'MCP Memory',
  cipher: 'Cipher',
  'claude-mem': 'Claude-Mem',
  'unknown-memory': '疑似记忆 MCP',
}

const LORE_ENV_KEYS = [
  'LORE_BASE_URL',
  'LORE_API_TOKEN',
  'LORE_HOME',
  'LORE_CLIENT_TYPE',
  'LORE_SKILLS_ENABLED',
]
const LORE_GUIDANCE_IMPORT =
  /^(@~\/\.claude\/lore-guidance\.md|@import ~\/\.claude\/lore-guidance\.md)$/
const LORE_OPENCODE_MARKER = '@lore-managed-opencode-plugin'
const DSH_BEGIN_MARKER = '# >>> lore (managed) >>>'
const DSH_END_MARKER = '# <<< lore (managed) <<<'

function homeOf(env) {
  return env.HOME || homedir()
}

function claudeHome(env) {
  return env.CLAUDE_CONFIG_DIR || join(homeOf(env), '.claude')
}

function claudeJsonFile(env) {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homeOf(env), '.claude.json')
}

function openclawHome(env) {
  return join(env.OPENCLAW_HOME || homeOf(env), '.openclaw')
}

function loreHomeOf(env) {
  return env.LORE_HOME?.trim() || join(homeOf(env), '.lore')
}

// 文本或 JSON 设置里有没有带密钥：有的话修改文件时不留明文备份
function hasJsonSecret(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasJsonSecret)
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      if (/\bBearer\s+\S+/i.test(v)) return true
      if (/(?:authorization|api[_-]?token|api[_-]?key|token|secret)/i.test(k) && v.trim()) {
        return true
      }
    } else if (v && typeof v === 'object' && hasJsonSecret(v)) {
      return true
    }
  }
  return false
}

function backupAllowed(file, hasSecret, noBackupFiles) {
  if (hasSecret || noBackupFiles?.has(file)) {
    noBackupFiles?.add(file)
    return false
  }
  return true
}

function hasTextSecret(text) {
  return (
    /\bBearer\s+\S+/i.test(text) ||
    /\b(?:api[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"'\s#]+/i.test(text)
  )
}

function serializeSpec(entry) {
  if (typeof entry === 'string') return entry.toLowerCase()
  try {
    return JSON.stringify(entry ?? {}).toLowerCase()
  } catch {
    return ''
  }
}

// 识别 MCP 条目属于哪款记忆工具；只命中泛用名 memory 但特征不明的仅告警不自动删
export function matchMcpTool(name, entry) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
  const spec = serializeSpec(entry)

  if (
    key === 'lore' ||
    key === 'lore-skills' ||
    key === 'lore-memory' ||
    /lore-mcp|@loremem\/|lore-memory|\/api\/mcp\?client_type=/.test(spec)
  ) {
    return { tool: 'lore', toolName: CONFLICT_TOOLS.lore, removable: true }
  }
  if (
    key === 'mem0' ||
    key === 'mem0-mcp' ||
    key === 'openmemory' ||
    /mem0-mcp|@mem0\/|openmemory|mem0ai/.test(spec)
  ) {
    return { tool: 'mem0', toolName: CONFLICT_TOOLS.mem0, removable: true }
  }
  if (key === 'supermemory' || /supermemory\.ai|@supermemory\//.test(spec)) {
    return { tool: 'supermemory', toolName: CONFLICT_TOOLS.supermemory, removable: true }
  }
  if (
    /@byterover\/cipher|byterover-cipher/.test(spec) ||
    (key === 'cipher' && /\bcipher\b/.test(spec))
  ) {
    return { tool: 'cipher', toolName: CONFLICT_TOOLS.cipher, removable: true }
  }
  if (key === 'claude-mem' || /claude-mem|thedotmack\/claude-mem/.test(spec)) {
    return { tool: 'claude-mem', toolName: CONFLICT_TOOLS['claude-mem'], removable: true }
  }
  if (/@modelcontextprotocol\/server-memory|mcp-server-memory/.test(spec)) {
    return { tool: 'mcp-memory', toolName: CONFLICT_TOOLS['mcp-memory'], removable: true }
  }
  if (key === 'memory' || key === 'memory-mcp' || key === 'long-term-memory') {
    return {
      tool: 'unknown-memory',
      toolName: CONFLICT_TOOLS['unknown-memory'],
      removable: false,
      hint: '未命中已知记忆服务包名，确认不需要后可手动删除',
    }
  }
  return null
}

async function readJsonSafe(file) {
  try {
    return { ok: true, ...(await readSettings(file)) }
  } catch (err) {
    return { ok: false, error: err instanceof KiokuFailure ? err.message : `无法读取 ${file}` }
  }
}

async function scanJsonMcp(items, { platform, file, containerKey = 'mcpServers', onRemove }) {
  const res = await readJsonSafe(file)
  if (!res.ok || res.text === null) return
  const container = res.settings?.[containerKey]
  if (!container || typeof container !== 'object' || Array.isArray(container)) return

  for (const [name, entry] of Object.entries(container)) {
    const matched = matchMcpTool(name, entry)
    if (!matched) continue
    items.push({
      id: `${platform}:${matched.tool}:mcp:${file}#${name}`,
      platform,
      tool: matched.tool,
      toolName: matched.toolName,
      kind: matched.removable ? 'mcp' : 'warning',
      summary: `${containerKey}.${name}（${plain(file)}）`,
      removable: matched.removable,
      ...(matched.hint ? { hint: matched.hint } : {}),
      ...(matched.removable
        ? {
            remove: async ({ noBackupFiles } = {}) => {
              if (onRemove) await onRemove(name, matched)
              const latest = await readSettings(file)
              const current = latest.settings?.[containerKey]
              if (
                !current ||
                typeof current !== 'object' ||
                Array.isArray(current) ||
                !Object.hasOwn(current, name)
              ) {
                return { changed: false, message: `${plain(file)} 里的 ${name} 已不在` }
              }
              const next = { ...latest.settings }
              const nextContainer = { ...current }
              delete nextContainer[name]
              if (Object.keys(nextContainer).length) next[containerKey] = nextContainer
              else delete next[containerKey]
              await safeWrite(file, serialize(next, latest.text), latest.text, {
                backup: backupAllowed(file, hasJsonSecret(latest.settings), noBackupFiles),
              })
              return { changed: true, message: `已从 ${plain(file)} 移除 ${containerKey}.${name}` }
            },
          }
        : {}),
    })
  }
}

async function scanPathRemoval(
  items,
  { platform, tool, toolName, kind, target, summary, checkDir },
) {
  let st
  try {
    st = await lstat(target)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    items.push({
      id: `${platform}:${tool}:${kind}:${target}`,
      platform,
      tool,
      toolName,
      kind,
      summary,
      removable: true,
      remove: async () => {
        try {
          await unlink(target)
          return { changed: true, message: `已移除符号链接 ${plain(target)}` }
        } catch (err) {
          if (err?.code === 'ENOENT') return { changed: false, message: `${plain(target)} 已不在` }
          throw new KiokuFailure(`无法移除 ${plain(target)}`)
        }
      },
    })
    return
  }
  if (st.isDirectory()) {
    const owned = checkDir ? await checkDir(target) : true
    if (owned) {
      items.push({
        id: `${platform}:${tool}:${kind}:${target}`,
        platform,
        tool,
        toolName,
        kind,
        summary,
        removable: true,
        remove: async () => {
          await rm(target, { recursive: true, force: true })
          return { changed: true, message: `已移除目录 ${plain(target)}` }
        },
      })
    } else {
      items.push({
        id: `${platform}:${tool}:warn:${target}`,
        platform,
        tool,
        toolName,
        kind: 'warning',
        summary: `${summary}（不是符号链接且缺少托管标记，未自动删除）`,
        removable: false,
      })
    }
    return
  }
  items.push({
    id: `${platform}:${tool}:warn:${target}`,
    platform,
    tool,
    toolName,
    kind: 'warning',
    summary: `${summary}（非预期文件类型，未自动删除）`,
    removable: false,
  })
}

async function hasJsonName(file, expectedNames) {
  const res = await readJsonSafe(file)
  if (!res.ok || res.text === null) return false
  return expectedNames.includes(String(res.settings?.name ?? '').toLowerCase())
}

// ── Antigravity (agy) ────────────────────────────────────────────────────────

async function scanAgyConflicts(items, { env, cwd }) {
  const home = agyHome(env)
  await scanJsonMcp(items, { platform: 'agy', file: agyMcpFile(env), containerKey: 'mcpServers' })

  for (const [tool, dirName] of [
    ['lore', 'lore'],
    ['mem0', 'mem0'],
    ['claude-mem', 'claude-mem'],
  ]) {
    for (const dir of [join(home, 'plugins', dirName), join(cwd, '.agents', 'plugins', dirName)]) {
      await scanPathRemoval(items, {
        platform: 'agy',
        tool,
        toolName: CONFLICT_TOOLS[tool],
        kind: 'plugin',
        target: dir,
        summary: `插件目录 ${plain(dir)}`,
        checkDir: (p) => hasJsonName(join(p, 'plugin.json'), [dirName]),
      })
    }
  }
}

// ── Gemini CLI (gemini) ──────────────────────────────────────────────────────

async function scanGeminiConflicts(items, { env, cwd }) {
  const home = geminiHome(env)
  await scanJsonMcp(items, {
    platform: 'gemini',
    file: geminiSettingsFile(env),
    containerKey: 'mcpServers',
  })

  for (const dir of [
    join(home, 'extensions', 'lore'),
    join(cwd, '.gemini', 'extensions', 'lore'),
  ]) {
    await scanPathRemoval(items, {
      platform: 'gemini',
      tool: 'lore',
      toolName: 'Lore',
      kind: 'plugin',
      target: dir,
      summary: `Gemini 扩展 ${plain(dir)}`,
      checkDir: (p) => hasJsonName(join(p, 'gemini-extension.json'), ['lore']),
    })
  }
}

// ── Claude Code (claude-code) ────────────────────────────────────────────────

const CLAUDE_CONFLICT_PLUGINS = [
  { prefix: 'lore@', tool: 'lore', toolName: 'Lore' },
  { prefix: 'claude-mem@', tool: 'claude-mem', toolName: 'Claude-Mem' },
]

async function scanClaudeConflicts(items, { env, cwd }) {
  const home = claudeHome(env)
  const settingsFile = join(home, 'settings.json')
  const hasClaude = hasCommand('claude', env)

  const removeClaudeMcp = async (name) => {
    if (hasClaude) {
      await capture('claude', ['mcp', 'remove', name], env, { timeout: 15_000 })
    }
  }

  // ~/.claude.json、settings.json、项目 .mcp.json 里的 mcpServers
  await scanJsonMcp(items, {
    platform: 'claude-code',
    file: claudeJsonFile(env),
    containerKey: 'mcpServers',
    onRemove: removeClaudeMcp,
  })
  await scanJsonMcp(items, {
    platform: 'claude-code',
    file: settingsFile,
    containerKey: 'mcpServers',
    onRemove: removeClaudeMcp,
  })
  await scanJsonMcp(items, {
    platform: 'claude-code',
    file: join(cwd, '.mcp.json'),
    containerKey: 'mcpServers',
    onRemove: removeClaudeMcp,
  })

  const res = await readJsonSafe(settingsFile)
  if (res.ok && res.text !== null) {
    const enabled = res.settings?.enabledPlugins
    if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
      for (const [pluginId, on] of Object.entries(enabled)) {
        if (on !== true) continue
        const match = CLAUDE_CONFLICT_PLUGINS.find((p) => pluginId.startsWith(p.prefix))
        if (!match) continue
        items.push({
          id: `claude-code:${match.tool}:plugin:${pluginId}`,
          platform: 'claude-code',
          tool: match.tool,
          toolName: match.toolName,
          kind: 'plugin',
          summary: `插件 ${plain(pluginId)}（${plain(settingsFile)}）`,
          removable: true,
          remove: async ({ noBackupFiles } = {}) => {
            if (hasCommand('claude', env)) {
              await capture('claude', ['plugins', 'uninstall', pluginId], env, { timeout: 20_000 })
            }
            const latest = await readSettings(settingsFile)
            if (
              latest.settings?.enabledPlugins &&
              Object.hasOwn(latest.settings.enabledPlugins, pluginId)
            ) {
              const next = { ...latest.settings }
              const nextPlugins = { ...latest.settings.enabledPlugins }
              delete nextPlugins[pluginId]
              if (Object.keys(nextPlugins).length) next.enabledPlugins = nextPlugins
              else delete next.enabledPlugins
              await safeWrite(settingsFile, serialize(next, latest.text), latest.text, {
                backup: backupAllowed(settingsFile, hasJsonSecret(latest.settings), noBackupFiles),
              })
            }
            return { changed: true, message: `已卸载 Claude Code 插件 ${plain(pluginId)}` }
          },
        })
      }
    }

    const envMap = res.settings?.env
    if (envMap && typeof envMap === 'object' && !Array.isArray(envMap)) {
      const foundKeys = LORE_ENV_KEYS.filter((k) => Object.hasOwn(envMap, k))
      if (foundKeys.length) {
        items.push({
          id: `claude-code:lore:env:${settingsFile}`,
          platform: 'claude-code',
          tool: 'lore',
          toolName: 'Lore',
          kind: 'env',
          summary: `${plain(settingsFile)} 里的环境变量 ${foundKeys.join('、')}`,
          removable: true,
          remove: async ({ noBackupFiles } = {}) => {
            const latest = await readSettings(settingsFile)
            const curEnv = latest.settings?.env
            if (!curEnv || typeof curEnv !== 'object' || Array.isArray(curEnv)) {
              return { changed: false, message: `${plain(settingsFile)} 里的 env 已不在` }
            }
            const nextEnv = { ...curEnv }
            let changed = false
            for (const k of LORE_ENV_KEYS) {
              if (Object.hasOwn(nextEnv, k)) {
                delete nextEnv[k]
                changed = true
              }
            }
            if (!changed) return { changed: false, message: '环境变量已清理' }
            const next = { ...latest.settings }
            if (Object.keys(nextEnv).length) next.env = nextEnv
            else delete next.env
            await safeWrite(settingsFile, serialize(next, latest.text), latest.text, {
              backup: backupAllowed(settingsFile, true, noBackupFiles),
            })
            return { changed: true, message: `已从 ${plain(settingsFile)} 移除 Lore 环境变量` }
          },
        })
      }
    }
  }

  for (const [tool, dirName] of [
    ['lore', 'lore'],
    ['claude-mem', 'claude-mem'],
  ]) {
    await scanPathRemoval(items, {
      platform: 'claude-code',
      tool,
      toolName: CONFLICT_TOOLS[tool],
      kind: 'plugin',
      target: join(home, 'plugins', 'cache', dirName),
      summary: `插件缓存 ${plain(join(home, 'plugins', 'cache', dirName))}`,
    })
  }

  const guidanceFile = join(home, 'lore-guidance.md')
  if ((await lstat(guidanceFile).catch(() => null))?.isFile()) {
    items.push({
      id: `claude-code:lore:guidance:${guidanceFile}`,
      platform: 'claude-code',
      tool: 'lore',
      toolName: 'Lore',
      kind: 'guidance',
      summary: `指引文件 ${plain(guidanceFile)}`,
      removable: true,
      remove: async () => {
        await rm(guidanceFile, { force: true })
        return { changed: true, message: `已删除 ${plain(guidanceFile)}` }
      },
    })
  }

  const claudeMd = join(home, 'CLAUDE.md')
  const mdText = await readText(claudeMd).catch(() => null)
  if (mdText !== null) {
    const lines = mdText.split(/\r?\n/)
    const hasImport = lines.some((line) => LORE_GUIDANCE_IMPORT.test(line))
    if (hasImport) {
      items.push({
        id: `claude-code:lore:guidance-import:${claudeMd}`,
        platform: 'claude-code',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'guidance',
        summary: `${plain(claudeMd)} 里的 lore-guidance.md 导入行`,
        removable: true,
        remove: async () => {
          const latest = await readText(claudeMd)
          if (latest === null) return { changed: false, message: `${plain(claudeMd)} 已不在` }
          const eol = latest.includes('\r\n') ? '\r\n' : '\n'
          const filtered = latest.split(/\r?\n/).filter((line) => !LORE_GUIDANCE_IMPORT.test(line))
          while (filtered.length && filtered[0] === '') filtered.shift()
          const next = filtered.join(eol)
          const normalized =
            next && latest.endsWith('\n') && !next.endsWith(eol) ? `${next}${eol}` : next
          if (normalized === latest) return { changed: false, message: '导入行已不在' }
          await safeWrite(claudeMd, normalized, latest)
          return { changed: true, message: `已从 ${plain(claudeMd)} 移除 lore-guidance.md 导入行` }
        },
      })
    } else if (/\blore_(?:boot|search|get_node)\b/i.test(mdText)) {
      items.push({
        id: `claude-code:lore:guidance-manual:${claudeMd}`,
        platform: 'claude-code',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'warning',
        summary: `${plain(claudeMd)} 里仍有手写的 Lore 指引（未自动修改）`,
        removable: false,
      })
    }
  }
}

// ── Codex (codex) ────────────────────────────────────────────────────────────

// 按行扫描 Codex config.toml 里除 kioku 之外的插件段与 MCP 段，复用 codex.mjs 的标题解析
function scanCodexTomlSections(text) {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  const sections = []
  let current = null
  let depth = 0

  const finish = () => {
    if (!current) return
    while (current.indices.length && /^\s*(#.*)?$/.test(lines[current.indices.at(-1)])) {
      current.indices.pop()
    }
    if (current.indices.length) sections.push(current)
    current = null
  }

  lines.forEach((line, index) => {
    const header = depth === 0 ? headerOf(line) : null
    if (header !== null) {
      finish()
      current = { name: header, indices: [index] }
      return
    }
    depth = Math.max(0, depth + bracketDelta(line))
    if (current) current.indices.push(index)
  })
  finish()

  return { eol, lines, sections }
}

function removeTomlSections(text, targetPrefixes) {
  const { eol, lines, sections } = scanCodexTomlSections(text)
  const owned = new Set()
  for (const sec of sections) {
    if (targetPrefixes.some((prefix) => sec.name === prefix || sec.name.startsWith(`${prefix}.`))) {
      for (const idx of sec.indices) owned.add(idx)
    }
  }
  if (!owned.size) return text
  const kept = []
  lines.forEach((line, index) => {
    if (owned.has(index)) return
    if (line === '' && owned.has(index - 1) && (kept.at(-1) ?? '') === '') return
    kept.push(line)
  })
  while (kept.length && kept.at(-1) === '') kept.pop()
  return kept.length ? `${kept.join(eol)}${eol}` : ''
}

async function scanCodexConflicts(items, { env }) {
  const home = codexHome(env)
  const cfgPath = join(home, 'config.toml')
  const text = await readText(cfgPath).catch(() => null)
  const hasCodex = hasCommand('codex', env)

  if (text !== null) {
    const { lines, sections } = scanCodexTomlSections(text)
    // 把 [mcp_servers.<name>] 和它的子段（如 [mcp_servers.<name>.http_headers]）归成一组
    const mcpGroups = new Map()
    for (const sec of sections) {
      const pluginMatch = /^plugins\.["']?(lore@[^"']+|claude-mem@[^"']+)["']?$/.exec(sec.name)
      if (pluginMatch) {
        const pluginName = pluginMatch[1]
        const tool = pluginName.startsWith('lore@') ? 'lore' : 'claude-mem'
        items.push({
          id: `codex:${tool}:toml-plugin:${sec.name}`,
          platform: 'codex',
          tool,
          toolName: CONFLICT_TOOLS[tool],
          kind: 'plugin',
          summary: `[${sec.name}]（${plain(cfgPath)}）`,
          removable: true,
          remove: async ({ noBackupFiles } = {}) => {
            if (hasCodex && tool === 'lore') {
              await capture('codex', ['plugin', 'marketplace', 'remove', 'lore'], env, {
                timeout: 15_000,
              })
            }
            const latest = await readText(cfgPath)
            if (latest === null) return { changed: false, message: `${plain(cfgPath)} 已不在` }
            const next = removeTomlSections(latest, [sec.name])
            if (next === latest) return { changed: false, message: `[${sec.name}] 已不在` }
            await safeWrite(cfgPath, next, latest, {
              backup: backupAllowed(cfgPath, hasTextSecret(latest), noBackupFiles),
            })
            return { changed: true, message: `已从 ${plain(cfgPath)} 移除 [${sec.name}]` }
          },
        })
        continue
      }
      const mcpMatch = /^mcp_servers\.("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^.]+)(?:\.|$)/.exec(
        sec.name,
      )
      if (mcpMatch) {
        const serverName = mcpMatch[1].replace(/^["']|["']$/g, '')
        if (serverName === 'kioku') continue
        const group = mcpGroups.get(serverName) ?? { root: `mcp_servers.${mcpMatch[1]}`, lines: [] }
        for (const idx of sec.indices) group.lines.push(lines[idx])
        mcpGroups.set(serverName, group)
      }
    }

    // 行内表或带点键写法的 MCP（如 mcp_servers.lore = ...）按行删不安全，仅提示
    for (const inlineName of [
      'lore',
      'lore-skills',
      'mem0',
      'openmemory',
      'supermemory',
      'claude-mem',
    ]) {
      const escaped = inlineName.replaceAll('-', '\\-')
      const inlineRe = new RegExp(
        String.raw`^\s*(?:mcp_servers\s*\.\s*["']?${escaped}["']?\s*[.=]|["']?${escaped}["']?\s*=\s*\{)`,
        'm',
      )
      if (!mcpGroups.has(inlineName) && inlineRe.test(text)) {
        const matched = matchMcpTool(inlineName, '')
        if (matched) {
          items.push({
            id: `codex:${matched.tool}:inline:${inlineName}`,
            platform: 'codex',
            tool: matched.tool,
            toolName: matched.toolName,
            kind: 'warning',
            summary: `${plain(cfgPath)} 里用行内表或带点键定义了 ${inlineName}（未自动修改，需手动删掉）`,
            removable: false,
          })
        }
      }
    }

    for (const [serverName, group] of mcpGroups) {
      const matched = matchMcpTool(serverName, group.lines.join('\n'))
      if (!matched) continue
      items.push({
        id: `codex:${matched.tool}:mcp:${serverName}`,
        platform: 'codex',
        tool: matched.tool,
        toolName: matched.toolName,
        kind: matched.removable ? 'mcp' : 'warning',
        summary: `[${group.root}]（${plain(cfgPath)}）`,
        removable: matched.removable,
        ...(matched.hint ? { hint: matched.hint } : {}),
        ...(matched.removable
          ? {
              remove: async ({ noBackupFiles } = {}) => {
                if (hasCodex) {
                  await capture('codex', ['mcp', 'remove', serverName], env, { timeout: 15_000 })
                }
                const latest = await readText(cfgPath)
                if (latest === null) return { changed: false, message: `${plain(cfgPath)} 已不在` }
                const next = removeTomlSections(latest, [group.root, `mcp_servers.${serverName}`])
                if (next === latest) return { changed: false, message: `[${group.root}] 已不在` }
                await safeWrite(cfgPath, next, latest, {
                  backup: backupAllowed(cfgPath, hasTextSecret(latest), noBackupFiles),
                })
                return { changed: true, message: `已从 ${plain(cfgPath)} 移除 [${group.root}]` }
              },
            }
          : {}),
      })
    }
  }

  for (const [sub, desc] of [
    [join('plugins', 'lore-local-marketplace'), '本地插件市场'],
    [join('plugins', 'cache', 'lore'), '插件缓存'],
    [join('hooks', 'lore'), '钩子目录'],
  ]) {
    await scanPathRemoval(items, {
      platform: 'codex',
      tool: 'lore',
      toolName: 'Lore',
      kind: 'plugin',
      target: join(home, sub),
      summary: `${desc} ${plain(join(home, sub))}`,
    })
  }

  const hooksFile = join(home, 'hooks.json')
  const hooksRes = await readJsonSafe(hooksFile)
  if (hooksRes.ok && hooksRes.text !== null && hooksRes.settings?.hooks) {
    const hooksObj = hooksRes.settings.hooks
    const hasLoreHook =
      typeof hooksObj === 'object' &&
      !Array.isArray(hooksObj) &&
      Object.values(hooksObj).some(
        (entries) =>
          Array.isArray(entries) &&
          entries.some(
            (entry) =>
              Array.isArray(entry?.hooks) &&
              entry.hooks.some((h) => /[/\\]hooks[/\\]lore[/\\]/.test(String(h?.command ?? ''))),
          ),
      )
    if (hasLoreHook) {
      items.push({
        id: `codex:lore:hooks:${hooksFile}`,
        platform: 'codex',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'hook',
        summary: `${plain(hooksFile)} 里的 Lore 钩子`,
        removable: true,
        remove: async () => {
          const latest = await readSettings(hooksFile)
          const curHooks = latest.settings?.hooks
          if (!curHooks || typeof curHooks !== 'object' || Array.isArray(curHooks)) {
            return { changed: false, message: `${plain(hooksFile)} 已无 hooks` }
          }
          const nextHooks = {}
          let changed = false
          for (const [ev, entries] of Object.entries(curHooks)) {
            if (!Array.isArray(entries)) {
              nextHooks[ev] = entries
              continue
            }
            const filtered = entries.filter(
              (entry) =>
                !(
                  Array.isArray(entry?.hooks) &&
                  entry.hooks.some((h) => /[/\\]hooks[/\\]lore[/\\]/.test(String(h?.command ?? '')))
                ),
            )
            if (filtered.length < entries.length) changed = true
            if (filtered.length) nextHooks[ev] = filtered
          }
          if (!changed) return { changed: false, message: 'Lore 钩子已不在' }
          const next = { ...latest.settings }
          if (Object.keys(nextHooks).length) next.hooks = nextHooks
          else delete next.hooks
          await safeWrite(hooksFile, serialize(next, latest.text), latest.text)
          return { changed: true, message: `已从 ${plain(hooksFile)} 移除 Lore 钩子` }
        },
      })
    }
  }
}

// ── OpenCode (opencode) ──────────────────────────────────────────────────────

async function scanOpenCodeConflicts(items, { env, cwd }) {
  const userDir = opencodeHome(env)
  const pluginFile = join(userDir, 'plugins', 'lore-memory.js')
  const pluginText = await readText(pluginFile).catch(() => null)
  if (pluginText !== null) {
    if (pluginText.includes(LORE_OPENCODE_MARKER)) {
      items.push({
        id: `opencode:lore:plugin:${pluginFile}`,
        platform: 'opencode',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'plugin',
        summary: `插件文件 ${plain(pluginFile)}`,
        removable: true,
        remove: async () => {
          await rm(pluginFile, { force: true })
          return { changed: true, message: `已删除 ${plain(pluginFile)}` }
        },
      })
    } else {
      items.push({
        id: `opencode:lore:warn:${pluginFile}`,
        platform: 'opencode',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'warning',
        summary: `${plain(pluginFile)} 没有 Lore 托管标记（未自动删除）`,
        removable: false,
      })
    }
  }

  for (const cfgFile of [join(userDir, 'opencode.json'), join(cwd, 'opencode.json')]) {
    await scanJsonMcp(items, { platform: 'opencode', file: cfgFile, containerKey: 'mcp' })
    const res = await readJsonSafe(cfgFile)
    if (res.ok && res.text !== null && Array.isArray(res.settings?.plugin)) {
      const lorePlugins = res.settings.plugin.filter(
        (entry) =>
          typeof entry === 'string' && (/lore-memory|@loremem\//i.test(entry) || entry === 'lore'),
      )
      for (const entry of lorePlugins) {
        items.push({
          id: `opencode:lore:plugin-entry:${cfgFile}:${entry}`,
          platform: 'opencode',
          tool: 'lore',
          toolName: 'Lore',
          kind: 'plugin',
          summary: `${plain(cfgFile)} 的 plugin 里的 ${plain(entry)}`,
          removable: true,
          remove: async ({ noBackupFiles } = {}) => {
            const latest = await readSettings(cfgFile)
            const list = latest.settings?.plugin
            if (!Array.isArray(list) || !list.includes(entry)) {
              return { changed: false, message: `${plain(entry)} 已不在` }
            }
            const nextList = list.filter((x) => x !== entry)
            const next = { ...latest.settings }
            if (nextList.length) next.plugin = nextList
            else delete next.plugin
            await safeWrite(cfgFile, serialize(next, latest.text), latest.text, {
              backup: backupAllowed(cfgFile, hasJsonSecret(latest.settings), noBackupFiles),
            })
            return { changed: true, message: `已从 ${plain(cfgFile)} 移除 ${plain(entry)}` }
          },
        })
      }
    }
  }

  const loreHome = loreHomeOf(env)
  const compatState = join(loreHome, 'opencode-compat.json')
  if ((await lstat(compatState).catch(() => null))?.isFile()) {
    const compatHelper = join(loreHome, 'opencode-compat.py')
    const hasHelper = (await lstat(compatHelper).catch(() => null))?.isFile()
    if (hasHelper && hasCommand('python3', env)) {
      items.push({
        id: `opencode:lore:compat:${compatState}`,
        platform: 'opencode',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'compat',
        summary: `OpenCode 兼容回滚状态 ${plain(compatState)}`,
        removable: true,
        remove: async () => {
          const res = await capture(
            'python3',
            [compatHelper, 'uninstall', '--home', homeOf(env), '--lore-home', loreHome],
            env,
            { timeout: 15_000 },
          )
          if (!res.ok) throw new KiokuFailure(`恢复 ${plain(compatState)} 失败`)
          if (!(await lstat(compatState).catch(() => null))) {
            await rm(compatHelper, { force: true }).catch(() => {})
          }
          return { changed: true, message: '已恢复 OpenCode 兼容配置' }
        },
      })
    } else {
      items.push({
        id: `opencode:lore:compat-warn:${compatState}`,
        platform: 'opencode',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'warning',
        summary: `发现 ${plain(compatState)}（缺少 python3 或辅助脚本，请检查 oh-my-openagent 配置）`,
        removable: false,
      })
    }
  }
}

// ── OpenClaw (openclaw) ──────────────────────────────────────────────────────

const OPENCLAW_MEMORY_PLUGINS = [
  { id: 'lore', tool: 'lore', toolName: 'Lore' },
  { id: 'mem0', tool: 'mem0', toolName: 'Mem0' },
  { id: 'openmemory', tool: 'mem0', toolName: 'Mem0' },
  { id: 'supermemory', tool: 'supermemory', toolName: 'Supermemory' },
  { id: 'claude-mem', tool: 'claude-mem', toolName: 'Claude-Mem' },
]

async function scanOpenclawConflicts(items, { env }) {
  const home = openclawHome(env)
  const cfgPath = join(home, 'openclaw.json')
  const bin = env.KIOKU_OPENCLAW_BIN || 'openclaw'
  const res = await readJsonSafe(cfgPath)

  if (res.ok && res.text !== null) {
    const entries = res.settings?.plugins?.entries
    const slot = res.settings?.plugins?.slots?.memory
    for (const plugin of OPENCLAW_MEMORY_PLUGINS) {
      const hasEntry =
        entries &&
        typeof entries === 'object' &&
        !Array.isArray(entries) &&
        Object.hasOwn(entries, plugin.id)
      const hasSlot = slot === plugin.id
      if (!hasEntry && !hasSlot) continue
      items.push({
        id: `openclaw:${plugin.tool}:plugin:${plugin.id}`,
        platform: 'openclaw',
        tool: plugin.tool,
        toolName: plugin.toolName,
        kind: 'plugin',
        summary: `OpenClaw 插件 ${plugin.id}（${plain(cfgPath)}）`,
        removable: true,
        remove: async ({ noBackupFiles } = {}) => {
          if (hasCommand(bin, env)) {
            await capture(bin, ['plugins', 'disable', plugin.id], env, { timeout: 30_000 })
            await capture(bin, ['plugins', 'uninstall', plugin.id], env, { timeout: 30_000 })
          }
          const latest = await readSettings(cfgPath)
          let changed = false
          const next = { ...latest.settings }
          if (
            next.plugins?.entries &&
            typeof next.plugins.entries === 'object' &&
            Object.hasOwn(next.plugins.entries, plugin.id)
          ) {
            const nextEntries = { ...next.plugins.entries }
            delete nextEntries[plugin.id]
            next.plugins = { ...next.plugins, entries: nextEntries }
            changed = true
          }
          if (next.plugins?.slots?.memory === plugin.id) {
            next.plugins = {
              ...next.plugins,
              slots: { ...next.plugins.slots, memory: 'memory-core' },
            }
            changed = true
          }
          if (changed) {
            await safeWrite(cfgPath, serialize(next, latest.text), latest.text, {
              backup: backupAllowed(cfgPath, hasJsonSecret(latest.settings), noBackupFiles),
            })
          }
          return { changed: true, message: `已清理 OpenClaw 插件 ${plugin.id}` }
        },
      })
    }
  }

  await scanPathRemoval(items, {
    platform: 'openclaw',
    tool: 'lore',
    toolName: 'Lore',
    kind: 'plugin',
    target: join(home, 'extensions', 'lore'),
    summary: `扩展目录 ${plain(join(home, 'extensions', 'lore'))}`,
  })
}

// ── pi (pi) ──────────────────────────────────────────────────────────────────

async function scanPiConflicts(items, { env, cwd }) {
  const home = piHome(env)
  await scanPathRemoval(items, {
    platform: 'pi',
    tool: 'lore',
    toolName: 'Lore',
    kind: 'plugin',
    target: join(home, 'extensions', 'lore'),
    summary: `pi 扩展 ${plain(join(home, 'extensions', 'lore'))}`,
    // pi 扩展可能不是软链而是用户自建目录：只删软链，普通目录保留并警告
    checkDir: async () => false,
  })

  for (const mcpFile of [join(home, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]) {
    await scanJsonMcp(items, { platform: 'pi', file: mcpFile, containerKey: 'mcpServers' })
  }

  for (const settingsFile of [join(home, 'settings.json'), join(cwd, '.pi', 'settings.json')]) {
    const res = await readJsonSafe(settingsFile)
    if (!res.ok || res.text === null || !Array.isArray(res.settings?.packages)) continue
    const lorePkgs = res.settings.packages.filter((entry) => {
      const source = typeof entry === 'string' ? entry : entry?.source
      return typeof source === 'string' && /@loremem\/|\/lore(?:\.git)?(?:$|#)/.test(source)
    })
    for (const pkg of lorePkgs) {
      const source = typeof pkg === 'string' ? pkg : pkg.source
      items.push({
        id: `pi:lore:package:${settingsFile}:${source}`,
        platform: 'pi',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'plugin',
        summary: `${plain(settingsFile)} 的 packages 里的 ${plain(source)}`,
        removable: true,
        remove: async () => {
          const latest = await readSettings(settingsFile)
          const packages = latest.settings?.packages
          if (!Array.isArray(packages)) return { changed: false, message: 'packages 已不在' }
          const filtered = packages.filter((entry) => {
            const s = typeof entry === 'string' ? entry : entry?.source
            return s !== source
          })
          if (filtered.length === packages.length) return { changed: false, message: '已不在' }
          const next = { ...latest.settings }
          if (filtered.length) next.packages = filtered
          else delete next.packages
          await safeWrite(settingsFile, serialize(next, latest.text), latest.text, {
            backup: !hasJsonSecret(latest.settings),
          })
          return { changed: true, message: `已从 ${plain(settingsFile)} 移除 ${plain(source)}` }
        },
      })
    }
  }
}

// ── DeepSeek Harness (dsh) ───────────────────────────────────────────────────

function removeDshManagedBlock(content) {
  if (!(content.includes(DSH_BEGIN_MARKER) && content.includes(DSH_END_MARKER))) return content
  const start = content.indexOf(DSH_BEGIN_MARKER)
  const end = content.indexOf(DSH_END_MARKER) + DSH_END_MARKER.length
  let remaining = (content.slice(0, start) + content.slice(end))
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
  const meaningful = remaining
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (meaningful.length === 0) {
    const comments = remaining
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('#') || line.trim() === '')
      .join('\n')
      .replace(/\n+$/, '\n')
    return `${comments}[]\n`
  }
  return `${remaining.replace(/\s+$/, '')}\n`
}

async function scanDshConflicts(items, { env }) {
  const file = join(dshHome(env), 'cordis.patch.yml')
  const text = await readText(file).catch(() => null)
  if (text === null) return

  if (text.includes(DSH_BEGIN_MARKER) && text.includes(DSH_END_MARKER)) {
    items.push({
      id: `dsh:lore:patch:${file}`,
      platform: 'dsh',
      tool: 'lore',
      toolName: 'Lore',
      kind: 'plugin',
      summary: `${plain(file)} 里的 Lore 托管块`,
      removable: true,
      remove: async () => {
        const latest = await readText(file)
        if (latest === null) return { changed: false, message: `${plain(file)} 已不在` }
        const next = removeDshManagedBlock(latest)
        if (next === latest) return { changed: false, message: 'Lore 托管块已不在' }
        await safeWrite(file, next, latest, { backup: !hasTextSecret(latest) })
        return { changed: true, message: `已从 ${plain(file)} 移除 Lore 托管块` }
      },
    })
  }

  // 非托管区块里若写了其他记忆 MCP 的 serverName，仅提示不改 YAML
  const stripped = removeDshManagedBlock(text)
  for (const match of stripped.matchAll(/^\s*serverName:\s*["']?([A-Za-z0-9_-]+)["']?/gm)) {
    const matched = matchMcpTool(match[1], '')
    if (!matched) continue
    items.push({
      id: `dsh:${matched.tool}:warn:${file}:${match[1]}`,
      platform: 'dsh',
      tool: matched.tool,
      toolName: matched.toolName,
      kind: 'warning',
      summary: `${plain(file)} 里有非托管的 serverName: ${match[1]}（未自动修改）`,
      removable: false,
    })
  }
}

// ── Hermes (hermes) ──────────────────────────────────────────────────────────

async function hasHermesLoreFiles(dir) {
  const yaml = await readText(join(dir, 'plugin.yaml')).catch(() => null)
  if (yaml && /\bname:\s*["']?lore/i.test(yaml)) return true
  const initPy = await readText(join(dir, '__init__.py')).catch(() => null)
  return Boolean(initPy && /\bLORE_(?:BASE_URL|API_TOKEN)\b/.test(initPy))
}

async function scanHermesConflicts(items, { env }) {
  const home = hermesHome(env)
  for (const sub of ['skills', 'plugins']) {
    await scanPathRemoval(items, {
      platform: 'hermes',
      tool: 'lore',
      toolName: 'Lore',
      kind: 'plugin',
      target: join(home, sub, 'lore_memory'),
      summary: `Hermes ${sub === 'skills' ? '技能' : '插件'} ${plain(join(home, sub, 'lore_memory'))}`,
      checkDir: hasHermesLoreFiles,
    })
  }

  const envFile = join(home, '.env')
  const envText = await readText(envFile).catch(() => null)
  if (envText !== null) {
    const presentKeys = LORE_ENV_KEYS.filter((key) =>
      new RegExp(String.raw`^\s*(?:export\s+)?${key}\s*=`, 'm').test(envText),
    )
    if (presentKeys.length) {
      items.push({
        id: `hermes:lore:env:${envFile}`,
        platform: 'hermes',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'env',
        summary: `${plain(envFile)} 里的 ${presentKeys.join('、')}`,
        removable: true,
        remove: async () => {
          const latest = await readText(envFile)
          if (latest === null) return { changed: false, message: `${plain(envFile)} 已不在` }
          const removals = Object.fromEntries(LORE_ENV_KEYS.map((k) => [k, null]))
          const next = withEnv(latest, removals)
          if (next === latest) return { changed: false, message: '环境变量已清理' }
          await safeWrite(envFile, next, latest, { backup: false })
          return { changed: true, message: `已从 ${plain(envFile)} 移除 Lore 环境变量` }
        },
      })
    }
  }

  const bin = env.KIOKU_HERMES_BIN || 'hermes'
  const hasHome = Boolean((await lstat(home).catch(() => null))?.isDirectory())
  if (hasHome && hasCommand(bin, env)) {
    const res = await capture(bin, ['config', 'get', 'memory.provider'], env, { timeout: 15_000 })
    const provider = res.ok ? res.stdout.trim().split(/\r?\n/).at(-1)?.trim() : ''
    if (provider && /^(?:lore|lore_memory)$/i.test(provider)) {
      items.push({
        id: `hermes:lore:provider:${provider}`,
        platform: 'hermes',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'provider',
        summary: `Hermes 当前记忆 provider 为 ${plain(provider)}`,
        removable: true,
        remove: async () => {
          const setRes = await capture(bin, ['config', 'set', 'memory.provider', ''], env, {
            timeout: 15_000,
          })
          if (!setRes.ok) throw new KiokuFailure('清除 Hermes 的 memory.provider 没有成功')
          return {
            changed: true,
            message: `已清除 Hermes 的 memory.provider（原为 ${plain(provider)}）`,
          }
        },
      })
    }
  } else if (hasHome) {
    const cfgYaml = await readText(join(home, 'config.yaml')).catch(() => null)
    if (cfgYaml && /^\s*provider:\s*["']?lore(?:_memory)?["']?\s*(?:#.*)?$/m.test(cfgYaml)) {
      items.push({
        id: `hermes:lore:provider-warn:${home}`,
        platform: 'hermes',
        tool: 'lore',
        toolName: 'Lore',
        kind: 'warning',
        summary: `${plain(join(home, 'config.yaml'))} 里的 provider 为 lore（缺少 hermes 命令，需手动清除或重新接入）`,
        removable: false,
      })
    }
  }
}

const SCANNERS = {
  agy: scanAgyConflicts,
  gemini: scanGeminiConflicts,
  'claude-code': scanClaudeConflicts,
  codex: scanCodexConflicts,
  opencode: scanOpenCodeConflicts,
  openclaw: scanOpenclawConflicts,
  pi: scanPiConflicts,
  dsh: scanDshConflicts,
  hermes: scanHermesConflicts,
}

// 只读扫描单个平台的冲突记忆工具，返回冲突项数组
export async function scanConflicts(platformId, { env = process.env, cwd = process.cwd() } = {}) {
  const fn = SCANNERS[platformId]
  if (!fn) return []
  const items = []
  await fn(items, { env, cwd })
  return items
}

// 扫描多个平台（默认全部）
export async function scanAllConflicts(
  platformIds = Object.keys(SCANNERS),
  { env = process.env, cwd = process.cwd() } = {},
) {
  const lists = await Promise.all(platformIds.map((id) => scanConflicts(id, { env, cwd })))
  return lists.flat()
}

// 逐项执行清理，返回结果数组；单条失败不中断其余项
export async function removeConflicts(items, { env = process.env, cwd = process.cwd(), out } = {}) {
  const results = []
  const noBackupFiles = new Set()
  for (const item of items) {
    if (!item.removable || typeof item.remove !== 'function') {
      results.push({ item, ok: false, skipped: true, message: item.summary })
      continue
    }
    try {
      const res = await item.remove({ env, cwd, noBackupFiles })
      out?.write(`✓ ${res.message}\n`)
      results.push({ item, ok: true, changed: res.changed, message: res.message })
    } catch (err) {
      const message = err instanceof KiokuFailure ? err.message : `清理失败：${item.summary}`
      out?.write(`✗ ${message}\n`)
      results.push({ item, ok: false, message })
    }
  }
  return results
}

export function conflictToolsText(items) {
  return [...new Set(items.map((item) => item.toolName))].join('、')
}

export function formatConflicts(items, platforms) {
  return items.map((item) => {
    const label = platforms?.[item.platform]?.name ?? item.platform
    const prefix = item.removable ? '  清理' : '  提示'
    const hint = item.hint ? `（${item.hint}）` : ''
    return `${prefix}  [${label}] ${item.toolName}：${item.summary}${hint}`
  })
}

// 接入或登录前检查平台上的冲突：有可清理的冲突时，--dry-run 只预览，--remove-conflicts 或终端确认后清理，
// 非终端且未传 --remove-conflicts 时阻断
export async function ensureNoConflicts(
  platformId,
  platformName,
  {
    env = process.env,
    cwd = process.cwd(),
    out = process.stdout,
    stdin = process.stdin,
    remove = false,
    dryRun = false,
  } = {},
) {
  const items = await scanConflicts(platformId, { env, cwd })
  const warnings = items.filter((item) => !item.removable)
  for (const w of warnings) {
    const hint = w.hint ? `（${w.hint}）` : ''
    out.write(`! ${w.toolName}：${w.summary}${hint}\n`)
  }
  const removable = items.filter((item) => item.removable)
  if (!removable.length) return 'ok'

  out.write(`发现冲突的记忆工具（${platformName}）：\n`)
  out.write(`${formatConflicts(removable).join('\n')}\n`)

  if (dryRun) {
    out.write(
      remove
        ? `将先清理以上 ${removable.length} 项冲突\n`
        : `注意：存在冲突，写入前需先清理（运行 kioku clean ${platformId}，或加 --remove-conflicts）\n`,
    )
    return 'ok'
  }

  if (!remove) {
    if (!stdin?.isTTY) {
      throw new KiokuFailure(
        `${platformName} 存在冲突的记忆工具，未继续：先运行 kioku clean ${platformId}，或加上 --remove-conflicts`,
      )
    }
    if (!(await confirm('先卸载这些冲突再继续？[y/N] ', { stdin, out }))) {
      out.write('没有写入\n')
      return 'cancelled'
    }
  }

  const results = await removeConflicts(removable, { env, cwd, out })
  if (results.some((r) => !r.ok)) {
    throw new KiokuFailure(`清理 ${platformName} 上的冲突没有全部成功，已停下`)
  }
  return 'cleaned'
}
