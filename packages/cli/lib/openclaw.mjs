// OpenClaw 这个平台的 kioku setup 与 kioku doctor。
// 插件读本机文件里的服务地址与访问密钥（不放进 OpenClaw 的配置：那份配置会被 openclaw config get 打印出来）；
// OpenClaw 自己的两项（记忆槽位、允许插件读对话）交给它的 openclaw config set 去改，不自己动它的配置文件

import { execFile } from 'node:child_process'

import { findCommand, invocation } from './command.mjs'
import { KiokuFailure } from './http.mjs'
import { listTools, removeToolCache, writeToolCache } from './mcp.mjs'
import { profileFile, readProfile, removeProfile, writeProfile } from './profile.mjs'
import { resolveTarget } from './target.mjs'

const PLUGIN = 'kioku'
const SOURCE = 'npm:@kioku-memory/openclaw'
// 允许插件读对话：第三方插件默认拿不到每轮的输入与回复，召回与会话摘要都要它
const ACCESS = `plugins.entries.${PLUGIN}.hooks.allowConversationAccess`
const SLOT = 'plugins.slots.memory'
// OpenClaw 自带的记忆插件，还原时选回它
const BUILTIN = 'memory-core'

// 命令以失败退出：output 是它打印的内容，只用来认是哪种失败，不打印（里面可能有别的配置）
class CommandFailed extends KiokuFailure {
  constructor(args, output) {
    super(`openclaw ${args.slice(0, 3).join(' ')} 没有成功`)
    this.output = output
  }
}

// 调 openclaw 命令。找不到这个命令时返回 null；失败时抛 CommandFailed
function openclaw(env, args) {
  // 自己在 PATH 里找：Windows 上 openclaw 是 npm 装的 .cmd，要经 cmd.exe 起
  const found = findCommand(env.KIOKU_OPENCLAW_BIN || 'openclaw', env)
  if (!found) return Promise.resolve(null)
  const run = invocation(found, args, env)
  return new Promise((resolve, reject) => {
    execFile(
      run.file,
      run.args,
      { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...run.options },
      (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') resolve(null)
        else if (err) reject(new CommandFailed(args, `${stdout ?? ''}\n${stderr ?? ''}`))
        else resolve(stdout)
      },
    )
  })
}

// 读 OpenClaw 的一项配置：null 是没有 openclaw 命令，undefined 是没读出来，否则是值（没设时是空字符串）
async function configValue(env, key) {
  let out
  try {
    out = await openclaw(env, ['config', 'get', key, '--json'])
  } catch (err) {
    // 没设过的项它以失败退出，并说没有这个路径；别的失败（超时这类）不当成没设
    return /not found/i.test(err?.output ?? '') ? '' : undefined
  }
  if (out === null) return null
  const last = out.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
  try {
    const value = JSON.parse(last)
    return typeof value === 'string' || typeof value === 'boolean' ? String(value) : undefined
  } catch {
    return undefined
  }
}

// 输出里的那个 JSON 对象：前面可能有几行提示，其中也可能带花括号，所以从每一个行首的花括号试
function jsonIn(out) {
  for (const match of out.matchAll(/^\{/gm)) {
    try {
      return JSON.parse(out.slice(match.index))
    } catch {
      // 不是从这里开始的
    }
  }
  return undefined
}

// 插件在 OpenClaw 里的状态：null 是没有 openclaw 命令，false 是没装，undefined 是没查出来
// （命令失败、输出读不懂），否则是 { enabled, loaded, slot }。没查出来不当成没装：照着没装去做会留下半截的配置
async function pluginState(env) {
  let out
  try {
    out = await openclaw(env, ['plugins', 'inspect', PLUGIN, '--json'])
  } catch (err) {
    return /plugin not found/i.test(err?.output ?? '') ? false : undefined
  }
  if (out === null) return null
  const plugin = jsonIn(out)?.plugin
  if (plugin?.id !== PLUGIN) return undefined
  return {
    enabled: plugin.enabled === true,
    loaded: plugin.status === 'loaded',
    slot: plugin.memorySlotSelected === true,
  }
}

// 让 OpenClaw 去掉一项配置；去不掉不算失败
async function removeSetting(env, key) {
  try {
    return (await openclaw(env, ['config', 'unset', key])) !== null
  } catch {
    return false
  }
}

// 让 OpenClaw 改一项配置，改完读回来核对。返回 'done'、'no-openclaw' 或 'failed'。不抛错：
// 调用方这时多半已经把访问密钥写下了，不能让这里的失败看起来像什么都没写
async function applySetting(env, key, value) {
  try {
    if ((await openclaw(env, ['config', 'set', key, value])) === null) return 'no-openclaw'
    return (await configValue(env, key)) === value ? 'done' : 'failed'
  } catch {
    return 'failed'
  }
}

function manual(out, settings, state) {
  out.write(
    state === 'no-openclaw'
      ? '没有找到 openclaw 命令，这几项要自己运行：\n'
      : 'OpenClaw 的配置没有改成，这几项要自己运行：\n',
  )
  for (const [key, value] of settings) out.write(`  openclaw config set ${key} ${value}\n`)
}

async function undo({ dryRun }, { env, out }) {
  const profile = profileFile('openclaw', env)
  const state = await pluginState(env)
  // 只在记忆槽位现在选的是 kioku 时改回去：之后换成了别的插件的话，不去动它
  const ours = Boolean(state && state.slot)
  out.write(`${profile}：删掉\n`)
  if (state === null) out.write('没有找到 openclaw 命令，OpenClaw 的配置没有动\n')
  else {
    out.write(`OpenClaw 的配置\n  ${ACCESS}：去掉\n`)
    if (ours) out.write(`  ${SLOT} → ${BUILTIN}\n`)
    else if (state === undefined) out.write(`  ${SLOT}：没有查出来现在选的是什么\n`)
    else out.write(`  ${SLOT}：现在选的不是 kioku，不动\n`)
  }
  if (dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (await removeProfile('openclaw', env)) out.write(`已删掉 ${profile}\n`)
  else out.write(`${profile} 本来就没有\n`)
  await removeToolCache('openclaw', env)
  if (state !== null) {
    // 不再允许插件读对话：插件还装着的话，留着这一项它照样拿得到每轮的输入与回复
    const access = await configValue(env, ACCESS)
    if (access !== '' && !(await removeSetting(env, ACCESS))) {
      out.write(
        `OpenClaw 里允许插件读对话的那一项没有去掉，要自己运行：\n  openclaw config unset ${ACCESS}\n`,
      )
    }
  }
  if (ours) {
    const result = await applySetting(env, SLOT, BUILTIN)
    if (result === 'done') out.write('OpenClaw 改回用自带的记忆，重启网关生效。\n')
    else manual(out, [[SLOT, BUILTIN]], result)
  } else if (state === undefined) {
    out.write(
      `OpenClaw 的记忆槽位没有查出来（openclaw plugins inspect 失败了）：用 openclaw config get ${SLOT} 看，还是 kioku 的话运行\n  openclaw config set ${SLOT} ${BUILTIN}\n`,
    )
  }
  out.write(`插件要另外卸载：openclaw plugins uninstall ${PLUGIN}\n`)
  return 0
}

export async function setupOpenclaw(options, io) {
  const { env, out } = io
  if (options.undo) return undo(options, io)
  const { url, key, saved } = await resolveTarget({ id: 'openclaw', name: 'OpenClaw' }, options, io)
  const profile = profileFile('openclaw', env)
  const same = Boolean(saved && saved.url === url && saved.key === key)
  if (same) out.write(`${profile} 不用改\n`)
  else out.write(`${profile}：写入服务地址与访问密钥（只给本人读写）\n`)
  out.write(`OpenClaw 的配置\n  ${ACCESS} → true\n  ${SLOT} → ${PLUGIN}（装上插件之后）\n`)
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!same) await writeProfile('openclaw', { url, key }, env)
  // 工具清单先取一份留在本机：插件第一次登记工具时就有得用。取不到不算失败，插件自己会再取
  if (options.check) {
    try {
      const tools = await listTools({ url, key })
      // 一个工具都没有的回答不留：留下的话插件会当成新取到的清单用上一小时
      if (tools.length) await writeToolCache('openclaw', { url, tools }, env)
    } catch {
      // 留给插件
    }
  }
  // 访问密钥这时已经写下了：后面改 OpenClaw 的配置不成也不算失败，把要做的列出来
  const todo = []
  let result = await applySetting(env, ACCESS, 'true')
  if (result !== 'done') todo.push([ACCESS, 'true'])
  const state = result === 'no-openclaw' ? null : await pluginState(env)
  // 槽位只在插件装上之后才选得了；装的时候 OpenClaw 自己会选上，这里只管装好之后被换走的
  if (state && !state.slot) {
    result = await applySetting(env, SLOT, PLUGIN)
    if (result !== 'done') todo.push([SLOT, PLUGIN])
  }
  if (todo.length) {
    out.write('地址与访问密钥已经写下。\n')
    manual(out, todo, result)
  } else if (state) {
    out.write('OpenClaw 已配好，重启网关（openclaw gateway restart）后生效。\n')
  } else {
    out.write('地址与访问密钥已经写下。\n')
  }
  if (state === undefined) {
    out.write(
      '插件装了没有、记忆槽位选的是什么没有查出来（openclaw plugins inspect 失败了）：用 kioku doctor openclaw 再看一次\n',
    )
  } else if (!state) {
    out.write(`接下来装上插件：openclaw plugins install ${SOURCE}\n`)
    if (todo.length) out.write('装好之后再运行一次 kioku setup openclaw。\n')
  }
  out.write(
    '只在本机入口的对话里生效；外部渠道来的消息里没有长期记忆（自带的记忆工具也随槽位停用）。\n',
  )
  return 0
}

export async function inspectOpenclaw({ env }, { ok, warn, note }) {
  const profile = await readProfile('openclaw', env).catch(() => null)
  if (!profile) {
    warn('没有 kioku setup openclaw 写下的地址与访问密钥，插件不会生效：运行 kioku setup openclaw')
  }
  const state = await pluginState(env)
  if (state === null) {
    note('没有找到 openclaw 命令，查不了它的配置：用 openclaw plugins inspect kioku 看')
    return
  }
  if (state === undefined) {
    warn(
      'OpenClaw 里的插件状态没有查出来（openclaw plugins inspect 失败了）：用 openclaw plugins inspect kioku 看',
    )
    return
  }
  if (!state) {
    warn(`OpenClaw 里没有装 kioku 的插件：openclaw plugins install ${SOURCE}`)
    return
  }
  if (state.enabled && state.loaded) ok('OpenClaw 里装了 kioku 的插件')
  else
    warn('OpenClaw 里的 kioku 插件没有启用或没有加载成功：用 openclaw plugins inspect kioku 看原因')
  if (state.slot) ok('OpenClaw 的记忆槽位选的是 kioku，自带的记忆工具已停用')
  else warn('OpenClaw 的记忆槽位选的不是 kioku：运行 kioku setup openclaw')
  const access = await configValue(env, ACCESS)
  if (access === 'true') ok('OpenClaw 允许 kioku 读对话（召回与会话摘要要用）')
  else if (access === undefined)
    warn('OpenClaw 允不允许 kioku 读对话没有查出来（openclaw config get 失败了）')
  else warn('OpenClaw 没有允许 kioku 读对话，召回与会话摘要不会生效：运行 kioku setup openclaw')
  note('只在本机入口的对话里生效；外部渠道来的消息里不注入、不上报、不给工具')
  note(
    '工作区里的 MEMORY.md 有内容时 OpenClaw 仍会放进提示：用 kioku import --from openclaw 迁走后清空它',
  )
}
