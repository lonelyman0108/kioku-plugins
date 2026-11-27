// kioku setup 与 kioku doctor 认得的平台：命令行位置、配置目录、状态读取、接入与巡检。

import { homedir } from 'node:os'
import { join } from 'node:path'

import { agyHome, inspectAgy, preflightAgy, setupAgy, statusAgy } from './agy.ts'
import {
  claudeHome,
  inspectClaudeCode,
  preflightClaudeCode,
  setupClaudeCode,
  statusClaudeCode,
} from './claudeCode.ts'
import { codexHome, inspectCodex, preflightCodex, setupCodex, statusCodex } from './codex.ts'
import { readProfile } from './core.ts'
import { dshHome, inspectDsh, setupDsh, statusDsh } from './dsh.ts'
import { geminiHome, inspectGemini, preflightGemini, setupGemini, statusGemini } from './gemini.ts'
import {
  hermesHome,
  inspectHermes,
  preflightHermes,
  readHermesConfig,
  setupHermes,
  statusHermes,
} from './hermes.ts'
import { inspectOpenclaw, setupOpenclaw, statusOpenclaw } from './openclaw.ts'
import {
  inspectOpenCode,
  opencodeHome,
  preflightOpenCode,
  setupOpenCode,
  statusOpenCode,
} from './opencode.ts'
import { inspectPi, piHome, setupPi, statusPi } from './pi.ts'
import type { Env, PlatformDescriptor } from './types.ts'
import { inspectZcode, setupZcode, statusZcode, zcodeHome } from './zcode.ts'

const claudeCode: PlatformDescriptor = {
  name: 'Claude Code',
  runtimeFamily: 'claudecode',
  command: () => 'claude',
  home: claudeHome,
  status: statusClaudeCode,
  install: {
    where: '在 Claude Code 里',
    commands: ['/plugin install kioku --marketplace lonelyman0108/kioku-plugins'],
    after:
      '地址与访问密钥已写入 ~/.config/kioku/claude-code.json（也可在 /plugin 里另填），新开会话生效',
  },
  source: 'claude-code',
  detect: (env: Env) => env.CLAUDECODE === '1',
  readConfig: (env: Env) => readProfile('claude-code', env),
  preflight: preflightClaudeCode,
  setup: setupClaudeCode,
  inspect: inspectClaudeCode,
}

const codex: PlatformDescriptor = {
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
  detect: () => false,
  readConfig: (env: Env) => readProfile('codex', env),
  setup: setupCodex,
  preflight: preflightCodex,
  inspect: inspectCodex,
}

const pi: PlatformDescriptor = {
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
  readConfig: (env: Env) => readProfile('pi', env),
  setup: setupPi,
  inspect: inspectPi,
}

const hermes: PlatformDescriptor = {
  name: 'Hermes',
  runtimeFamily: 'hermes',
  command: (env: Env) => env.KIOKU_HERMES_BIN || 'hermes',
  home: hermesHome,
  status: statusHermes,
  install: {
    commands: ['hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes --enable'],
    after: '新开 Hermes 会话生效',
  },
  source: 'hermes',
  detect: () => false,
  readConfig: readHermesConfig,
  setup: setupHermes,
  preflight: preflightHermes,
  inspect: inspectHermes,
}

const openclaw: PlatformDescriptor = {
  name: 'OpenClaw',
  runtimeFamily: 'openclaw',
  command: (env: Env) => env.KIOKU_OPENCLAW_BIN || 'openclaw',
  home: (env: Env) => join(env.OPENCLAW_HOME || homedir(), '.openclaw'),
  status: statusOpenclaw,
  install: {
    commands: ['openclaw plugins install npm:@kioku-memory/openclaw', 'openclaw gateway restart'],
    after: '重启网关之后生效',
  },
  source: 'openclaw',
  detect: () => false,
  readConfig: (env: Env) => readProfile('openclaw', env),
  setup: setupOpenclaw,
  inspect: inspectOpenclaw,
}

const dsh: PlatformDescriptor = {
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
  readConfig: (env: Env) => readProfile('dsh', env),
  setup: setupDsh,
  inspect: inspectDsh,
}

const opencode: PlatformDescriptor = {
  name: 'OpenCode',
  runtimeFamily: 'opencode',
  command: () => 'opencode',
  home: opencodeHome,
  status: statusOpenCode,
  install: {
    commands: ['opencode'],
    after:
      '确认 opencode.json 的 plugin 已包含 @kioku-memory/plugin-opencode（kioku setup opencode 会写入），新开会话生效',
  },
  detect: (env: Env) => Boolean(env.OPENCODE),
  readConfig: (env: Env) => readProfile('opencode', env),
  preflight: preflightOpenCode,
  setup: setupOpenCode,
  inspect: inspectOpenCode,
}

const gemini: PlatformDescriptor = {
  name: 'Gemini CLI',
  runtimeFamily: 'gemini',
  command: () => 'gemini',
  home: geminiHome,
  status: statusGemini,
  install: {
    commands: [
      'git clone https://github.com/lonelyman0108/kioku-plugins',
      'gemini extensions link kioku-plugins/plugins/gemini',
    ],
    after: '重启 Gemini CLI 生效（MCP 与停用 save_memory 已由 kioku setup gemini 配好）',
  },
  detect: (env: Env) => Boolean(env.GEMINI_CLI),
  readConfig: (env: Env) => readProfile('gemini', env),
  preflight: preflightGemini,
  setup: setupGemini,
  inspect: inspectGemini,
}

const agy: PlatformDescriptor = {
  name: 'Antigravity',
  runtimeFamily: 'agy',
  command: () => 'agy',
  home: agyHome,
  status: statusAgy,
  install: {
    commands:
      process.platform === 'win32'
        ? [
            'git clone https://github.com/lonelyman0108/kioku-plugins',
            'New-Item -ItemType Directory -Force "$HOME\\.gemini\\config\\plugins" | Out-Null; Copy-Item -Recurse -Force kioku-plugins\\plugins\\agy "$HOME\\.gemini\\config\\plugins\\kioku"',
          ]
        : [
            'git clone https://github.com/lonelyman0108/kioku-plugins',
            'mkdir -p ~/.gemini/config/plugins && cp -r kioku-plugins/plugins/agy ~/.gemini/config/plugins/kioku',
          ],
    after: '新开会话生效（MCP 服务已由 kioku setup agy 写进 mcp_config.json）',
  },
  detect: (env: Env) => Boolean(env.ANTIGRAVITY_AGENT || env.AGY_SESSION_ID),
  readConfig: (env: Env) => readProfile('agy', env),
  preflight: preflightAgy,
  setup: setupAgy,
  inspect: inspectAgy,
}

const zcode: PlatformDescriptor = {
  name: 'ZCode',
  runtimeFamily: 'zcode',
  command: () => 'zcode',
  home: zcodeHome,
  status: statusZcode,
  install: {
    commands: [
      'git clone https://github.com/lonelyman0108/kioku-plugins',
      'zcode plugins marketplace add ./kioku-plugins/plugins/zcode',
      'zcode plugins install kioku@kioku',
      'zcode plugins enable kioku@kioku',
    ],
    after: '重启 ZCode 或新开会话生效（MCP 桥接已随插件内置，地址与访问密钥保存在本机配置）',
  },
  detect: (env: Env) => Boolean(env.ZCODE_SESSION_ID || env.ZCODE_PLUGIN_ROOT),
  readConfig: (env: Env) => readProfile('zcode', env),
  setup: setupZcode,
  inspect: inspectZcode,
}

export const PLATFORMS: Record<string, PlatformDescriptor> = {
  'claude-code': claudeCode,
  codex,
  pi,
  hermes,
  openclaw,
  dsh,
  opencode,
  gemini,
  agy,
  zcode,
}

export function platformNames(): string {
  return Object.keys(PLATFORMS).join('、')
}

// 不写平台时按环境变量认；认不出为 null
export function detectPlatform(env: Env): string | null {
  return Object.keys(PLATFORMS).find((id) => PLATFORMS[id].detect(env)) ?? null
}
