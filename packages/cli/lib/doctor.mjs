// kioku doctor：检查地址与访问密钥能不能用、访问密钥的权限，以及平台这一边配好没有。
// 每项一行：✓ 正常，! 要留意，✗ 有问题；有 ✗ 时退出码为 1

import { loadConfig } from './config.mjs'
import { whoami } from './api.mjs'
import { failureText } from './http.mjs'
import { detectPlatform, platformNames, PLATFORMS } from './platforms.mjs'
import { readSettings } from './files.mjs'
import { readProfile } from './profile.mjs'
import { plain, shownUrl } from './text.mjs'
import { UsageError } from './usage.mjs'

export const DOCTOR_USAGE = `用法：kioku doctor [平台]

检查 Kioku 的地址与访问密钥、访问密钥的权限，以及平台的配置（插件是否启用、自带的长期记忆是否已停用）。

  [平台]  ${platformNames()}；不写时按当前所在的会话认，认不出就只查地址与访问密钥

有问题的项以 ✗ 开头，这时退出码为 1。
`

// 与管理界面的用词一致
const LAYERS = {
  core: '通用',
  persona: '人格',
  app: '应用',
  user: '本人',
  subject: '联系人',
  episode: '会话',
}
const SENSITIVITIES = { public: '公开', internal: '内部', private: '私密', secret: '机密' }
const CAPABILITIES = { none: '不可用', use: '取用', manage: '管理' }

function named(names, value) {
  return Object.hasOwn(names, value) ? names[value] : plain(value)
}

function layersText(layers) {
  if (!Array.isArray(layers) || !layers.length) return '无'
  return layers.map((layer) => named(LAYERS, layer)).join('、')
}

export function parseDoctorArgs(argv) {
  const names = []
  for (const arg of argv) {
    if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    names.push(arg)
  }
  if (names.length > 1) throw new UsageError('最多写一个平台')
  if (names.length && !Object.hasOwn(PLATFORMS, names[0])) {
    throw new UsageError(`不认识的平台 ${names[0]}，可以用的：${platformNames()}`)
  }
  return { platform: names[0] ?? null }
}

export async function doctor(
  argv,
  { env = process.env, out = process.stdout, cwd = process.cwd() } = {},
) {
  const id = parseDoctorArgs(argv).platform ?? detectPlatform(env)
  const platform = id ? PLATFORMS[id] : null
  let failed = false
  const ok = (text) => out.write(`✓ ${text}\n`)
  const warn = (text) => out.write(`! ${text}\n`)
  const bad = (text) => {
    failed = true
    out.write(`✗ ${text}\n`)
  }

  let who = null
  try {
    // 平台把地址与访问密钥放在自己的文件里时先读它，没有再看环境变量
    const profile = platform?.profile ? await readProfile(id, env) : null
    const config = profile ?? (await loadConfig(env))
    ok(`地址 ${shownUrl(config.url)}${profile ? `（${profile.file}）` : ''}`)
    who = await whoami(config)
  } catch (err) {
    bad(failureText(err))
  }
  if (who) {
    const { app, scopes } = who
    ok(
      `访问密钥可用：应用 ${plain(app.name)}（${plain(app.slug)}），运行时 ${plain(app.runtimeFamily)}`,
    )
    out.write(`  读：${layersText(scopes.readLayers)}\n`)
    out.write(`  写：${layersText(scopes.writeLayers)}\n`)
    out.write(`  最高敏感级：${named(SENSITIVITIES, scopes.maxSensitivity)}\n`)
    out.write(`  凭据：${named(CAPABILITIES, scopes.credentials ?? 'none')}\n`)
    if (platform && app.runtimeFamily !== platform.runtimeFamily) {
      warn(
        `这个应用的运行时不是 ${platform.runtimeFamily}，注入的内容不按 ${platform.name} 的格式：在管理界面为 ${platform.name} 另建一个应用`,
      )
    }
  }

  if (!platform) {
    out.write(`没有认出平台，只查了地址与访问密钥；要查平台的配置，写上平台：${platformNames()}\n`)
    return failed ? 1 : 0
  }
  if (platform.inspect) {
    try {
      await platform.inspect(
        { env, cwd },
        { ok, warn, bad, note: (text) => out.write(`  ${text}\n`) },
      )
    } catch (err) {
      bad(failureText(err))
    }
    return failed ? 1 : 0
  }
  let settings = null
  try {
    settings = (await readSettings(platform.settingsFile(env))).settings
  } catch (err) {
    bad(failureText(err))
  }
  if (settings) {
    if (platform.pluginActive(settings, env)) ok(`${platform.name} 的 kioku 插件已启用`)
    else warn(`用户设置里没有启用 ${platform.name} 的 kioku 插件：${platform.pluginHint}`)
    const by = platform.memory.disabledBy(settings, env)
    const again = by ? await platform.memory.enabledBy(env, cwd) : null
    if (again) {
      warn(
        `${platform.name} 的${platform.memory.name}在${by}里停用了，${again}又启用了它：要在那里一起改`,
      )
    } else if (by) ok(`${platform.name} 的${platform.memory.name}已停用（${by}）`)
    else {
      warn(
        `${platform.name} 的${platform.memory.name}还开着，会和 Kioku 各记一份：运行 kioku setup ${id} 停用它`,
      )
    }
  }
  return failed ? 1 : 0
}
