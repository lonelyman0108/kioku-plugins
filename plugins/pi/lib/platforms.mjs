// kioku setup 与 kioku doctor 认得的平台：自带的长期记忆在哪个配置文件里、怎么停用、怎么看现在的状态。
// 这里只描述配置，读写文件由 setup.mjs 做

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { inspectCodex, setupCodex } from './codex.mjs'
import { inspectPi, setupPi } from './pi.mjs'

// 真值的环境变量写法
const TRUTHY = /^(1|true|yes|on)$/i

// 项目里优先于用户设置的两份设置文件
const PROJECT_SETTINGS = ['.claude/settings.local.json', '.claude/settings.json']

// 读一份 JSON 设置里的某一项；文件没有或读不懂时为 undefined
async function settingOf(file, key) {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))?.[key]
  } catch {
    return undefined
  }
}

const claudeCode = {
  name: 'Claude Code',
  // 应用的运行时要是这个，服务端才按这个平台给注入
  runtimeFamily: 'claudecode',
  // 这个平台的会话里有的环境变量，不写平台时靠它认出来
  detect: (env) => env.CLAUDECODE === '1',
  // 用户级的设置文件
  settingsFile: (env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
  memory: {
    name: '自动记忆（auto memory）',
    // 停用：用户设置里把 autoMemoryEnabled 设为 false
    disable: (settings) => ({ ...settings, autoMemoryEnabled: false }),
    // 还原：去掉这一项，回到默认（开着）
    restore: (settings) => {
      const rest = { ...settings }
      delete rest.autoMemoryEnabled
      return rest
    },
    changed: ['autoMemoryEnabled'],
    // 现在是不是停用的，以及是哪里停用的
    disabledBy: (settings, env) => {
      if (TRUTHY.test((env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim())) {
        return '环境变量 CLAUDE_CODE_DISABLE_AUTO_MEMORY'
      }
      return settings?.autoMemoryEnabled === false ? '用户设置' : null
    },
    // 又在哪里启用了：当前项目的设置优先于用户设置。别处（托管的设置）查不到
    enabledBy: async (env, cwd) => {
      // 环境变量停用着时，设置里写什么都不生效
      if (TRUTHY.test((env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim())) return null
      for (const name of PROJECT_SETTINGS) {
        if ((await settingOf(join(cwd, name), 'autoMemoryEnabled')) === true)
          return `项目的 ${name} `
      }
      return null
    },
  },
  // 插件是否在用：这个会话里钩子已经配好了访问密钥文件，或者用户设置的 enabledPlugins 里有以「kioku@」开头、
  // 值为 true 的一项。项目级的设置里启用的认不出来，所以认不出时只提醒、不算有问题
  pluginActive: (settings, env) =>
    Boolean(env.KIOKU_API_KEY_FILE) ||
    Object.entries(settings?.enabledPlugins ?? {}).some(
      ([id, on]) => id.startsWith('kioku@') && on === true,
    ),
  pluginHint: '在 Claude Code 里用 /plugin 安装并启用 kioku',
}

const codex = {
  name: 'Codex',
  runtimeFamily: 'codex',
  // Codex 的会话里没有可靠的标记，要写明平台
  detect: () => false,
  // 地址与访问密钥放在本机的文件里（profile.mjs）
  profile: true,
  setup: setupCodex,
  inspect: inspectCodex,
}

const pi = {
  name: 'pi',
  runtimeFamily: 'pi',
  detect: () => false,
  profile: true,
  setup: setupPi,
  inspect: inspectPi,
}

export const PLATFORMS = { 'claude-code': claudeCode, codex, pi }

export function platformNames() {
  return Object.keys(PLATFORMS).join('、')
}

// 不写平台时按环境变量认；认不出为 null
export function detectPlatform(env) {
  return Object.keys(PLATFORMS).find((id) => PLATFORMS[id].detect(env)) ?? null
}
