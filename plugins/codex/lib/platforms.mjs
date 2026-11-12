// kioku setup 与 kioku doctor 认得的平台：自带的长期记忆在哪个配置文件里、怎么停用、怎么看现在的状态。
// 这里只描述配置，读写文件由 setup.mjs 做

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { codexHome, inspectCodex, preflightCodex, setupCodex, statusCodex } from './codex.mjs'
import { dshHome, inspectDsh, setupDsh, statusDsh } from './dsh.mjs'
import {
  hermesHome,
  inspectHermes,
  preflightHermes,
  readHermesConfig,
  setupHermes,
  statusHermes,
} from './hermes.mjs'
import { inspectOpenclaw, setupOpenclaw, statusOpenclaw } from './openclaw.mjs'
import { inspectPi, piHome, setupPi, statusPi } from './pi.mjs'
import { readProfile } from './profile.mjs'

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

function claudeHome(env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

// 向导的面板里各平台共有的几项：
// - command、home：本机装没装这个平台，看命令在不在 PATH 里、配置目录在不在
// - status：插件装没装（plugin：true、false，null 是查不了）与自带的长期记忆停没停（memory：'off'、'on'，
//   'none' 是没有自带的，null 是查不了）
// - install：插件要用户自己装：在哪里运行（where，默认终端）、可以直接复制的命令与之后要做的事；向导不替用户装
// - source：kioku import 认得的本地记忆的来源
const claudeCode = {
  name: 'Claude Code',
  command: () => 'claude',
  home: claudeHome,
  status: async ({ env, cwd }) => {
    let settings
    try {
      settings = JSON.parse(
        (await readFile(claudeCode.settingsFile(env), 'utf8')).replace(/^\uFEFF/, ''),
      )
    } catch (err) {
      if (err?.code !== 'ENOENT') return { plugin: null, memory: null }
      settings = {}
    }
    const plugin = Object.entries(settings?.enabledPlugins ?? {}).some(
      ([id, on]) => id.startsWith('kioku@') && on === true,
    )
    const off =
      claudeCode.memory.disabledBy(settings, env) && !(await claudeCode.memory.enabledBy(env, cwd))
    return { plugin, memory: off ? 'off' : 'on' }
  },
  install: {
    where: '在 Claude Code 里',
    commands: ['/plugin install kioku --marketplace lonelyman0108/kioku-plugins'],
    after: '启用时填 Kioku 的地址与访问密钥（管理界面的应用页签发），新开会话生效',
  },
  source: 'claude-code',
  // 应用的运行时要是这个，服务端才按这个平台给注入
  runtimeFamily: 'claudecode',
  // 这个平台的会话里有的环境变量，不写平台时靠它认出来
  detect: (env) => env.CLAUDECODE === '1',
  // 用户级的设置文件
  settingsFile: (env) => join(claudeHome(env), 'settings.json'),
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
  command: () => 'codex',
  home: codexHome,
  status: statusCodex,
  install: {
    commands: [
      'codex plugin marketplace add lonelyman0108/kioku-plugins',
      'codex plugin add kioku@kioku',
    ],
    after: '打开 codex，在 /hooks 里信任 kioku 的三个钩子，新开会话生效',
  },
  // Codex 的会话里没有可靠的标记，要写明平台
  detect: () => false,
  // 地址与访问密钥放在本机的文件里（profile.mjs）；readConfig 读出来给 doctor、login、import 用
  readConfig: (env) => readProfile('codex', env),
  setup: setupCodex,
  // kioku login 申请之前先做的检查
  preflight: preflightCodex,
  inspect: inspectCodex,
}

const pi = {
  name: 'pi',
  runtimeFamily: 'pi',
  command: () => 'pi',
  home: piHome,
  status: statusPi,
  install: {
    commands: ['pi install git:github.com/lonelyman0108/kioku-plugins'],
    after: '新开 pi 会话（或 /reload）生效',
  },
  detect: () => false,
  readConfig: (env) => readProfile('pi', env),
  setup: setupPi,
  inspect: inspectPi,
}

const hermes = {
  name: 'Hermes',
  runtimeFamily: 'hermes',
  command: (env) => env.KIOKU_HERMES_BIN || 'hermes',
  home: hermesHome,
  status: statusHermes,
  install: {
    commands: ['hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes --enable'],
    after: '新开 Hermes 会话生效',
  },
  source: 'hermes',
  detect: () => false,
  // 地址与访问密钥在 Hermes 自己的 .env 里
  readConfig: readHermesConfig,
  setup: setupHermes,
  preflight: preflightHermes,
  inspect: inspectHermes,
}

const openclaw = {
  name: 'OpenClaw',
  runtimeFamily: 'openclaw',
  command: (env) => env.KIOKU_OPENCLAW_BIN || 'openclaw',
  home: (env) => join(env.OPENCLAW_HOME || homedir(), '.openclaw'),
  status: statusOpenclaw,
  install: {
    commands: ['openclaw plugins install npm:@kioku-memory/openclaw', 'openclaw gateway restart'],
    after: '重启网关之后生效',
  },
  source: 'openclaw',
  detect: () => false,
  readConfig: (env) => readProfile('openclaw', env),
  setup: setupOpenclaw,
  inspect: inspectOpenclaw,
}

const dsh = {
  name: 'DeepSeek Harness',
  runtimeFamily: 'dsh',
  command: () => 'dsh',
  home: dshHome,
  status: statusDsh,
  install: {
    commands: ['dsh plugin --profile <profile> add github:lonelyman0108/kioku-plugins'],
    after: '<profile> 换成要用的 profile（web、tui 这些各装一次），重启 dsh 生效',
  },
  detect: () => false,
  readConfig: (env) => readProfile('dsh', env),
  setup: setupDsh,
  inspect: inspectDsh,
}

export const PLATFORMS = { 'claude-code': claudeCode, codex, pi, hermes, openclaw, dsh }

export function platformNames() {
  return Object.keys(PLATFORMS).join('、')
}

// 不写平台时按环境变量认；认不出为 null
export function detectPlatform(env) {
  return Object.keys(PLATFORMS).find((id) => PLATFORMS[id].detect(env)) ?? null
}
