// kioku setup 与 kioku doctor 认得的平台：自带的长期记忆在哪个配置文件里、怎么停用、怎么看现在的状态。
// 这里只描述配置，读写文件由 setup.mjs 做

import { homedir } from 'node:os'
import { join } from 'node:path'

// 真值的环境变量写法
const TRUTHY = /^(1|true|yes|on)$/i

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
      if (TRUTHY.test(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '')) {
        return '环境变量 CLAUDE_CODE_DISABLE_AUTO_MEMORY'
      }
      return settings?.autoMemoryEnabled === false ? '用户设置' : null
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

export const PLATFORMS = { 'claude-code': claudeCode }

export function platformNames() {
  return Object.keys(PLATFORMS).join('、')
}

// 不写平台时按环境变量认；认不出为 null
export function detectPlatform(env) {
  return Object.keys(PLATFORMS).find((id) => PLATFORMS[id].detect(env)) ?? null
}
