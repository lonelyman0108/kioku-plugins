// OpenClaw 这个平台的 kioku setup 与 kioku doctor。
// 插件读本机文件里的服务地址与访问密钥（不放进 OpenClaw 的配置：那份配置会被 openclaw config get 打印出来）；
// OpenClaw 自己的两项（记忆槽位、允许插件读对话）交给它的 openclaw config set 去改，不自己动它的配置文件

import { execFile } from 'node:child_process'

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

// 调 openclaw 命令。找不到这个命令时返回 null；失败时抛 KiokuFailure（不带输出：里面可能有别的配置）
function openclaw(env, args) {
  const bin = env.KIOKU_OPENCLAW_BIN || 'openclaw'
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err?.code === 'ENOENT') resolve(null)
      else if (err) reject(new KiokuFailure(`openclaw ${args.slice(0, 3).join(' ')} 没有成功`))
      else resolve(stdout)
    })
  })
}

// 读 OpenClaw 的一项配置：null 是没有 openclaw 命令，undefined 是没读出来，否则是值（没设时是空字符串）
async function configValue(env, key) {
  let out
  try {
    out = await openclaw(env, ['config', 'get', key, '--json'])
  } catch {
    // 没设过的项它以失败退出
    return ''
  }
  if (out === null) return null
  const last = out.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
  try {
    const value = JSON.parse(last)
    return typeof value === 'string' || typeof value === 'boolean' ? String(value) : undefined
  } catch {
    // 没设过的项它也可能打印一句说明
    return ''
  }
}

// 插件在 OpenClaw 里的状态：null 是没有 openclaw 命令，false 是没装，否则是 { enabled, loaded, slot }
async function pluginState(env) {
  let out
  try {
    out = await openclaw(env, ['plugins', 'inspect', PLUGIN, '--json'])
  } catch {
    return false
  }
  if (out === null) return null
  try {
    const { plugin } = JSON.parse(out.slice(out.indexOf('{')))
    if (plugin?.id !== PLUGIN) return false
    return {
      enabled: plugin.enabled === true,
      loaded: plugin.status === 'loaded',
      slot: plugin.memorySlotSelected === true,
    }
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
  if (ours) out.write(`OpenClaw 的配置\n  ${SLOT} → ${BUILTIN}\n`)
  else if (state === null) out.write('没有找到 openclaw 命令，OpenClaw 的配置没有动\n')
  else out.write('OpenClaw 的记忆槽位现在选的不是 kioku，它的配置没有动\n')
  if (dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (await removeProfile('openclaw', env)) out.write(`已删掉 ${profile}\n`)
  else out.write(`${profile} 本来就没有\n`)
  await removeToolCache('openclaw', env)
  if (ours) {
    const result = await applySetting(env, SLOT, BUILTIN)
    if (result === 'done') out.write('OpenClaw 改回用自带的记忆，重启网关生效。\n')
    else manual(out, [[SLOT, BUILTIN]], result)
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
      await writeToolCache('openclaw', { url, tools: await listTools({ url, key }) }, env)
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
  if (!state) out.write(`接下来装上插件：openclaw plugins install ${SOURCE}\n`)
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
  else warn('OpenClaw 没有允许 kioku 读对话，召回与会话摘要不会生效：运行 kioku setup openclaw')
  note('只在本机入口的对话里生效；外部渠道来的消息里不注入、不上报、不给工具')
  note(
    '工作区里的 MEMORY.md 有内容时 OpenClaw 仍会放进提示：用 kioku import --from openclaw 迁走后清空它',
  )
}
