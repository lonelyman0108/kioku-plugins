#!/usr/bin/env node
// 在这台机器上装一个真实的平台，照安装说明走一遍：kioku setup → 装插件 → 跑一轮 → kioku doctor，
// 核对三个事件到了假的 Kioku、注入的内容与工具到了模型手上。模型与 Kioku 都是假的（fakes.mjs），不用任何密钥。
// 用法：node scripts/e2e/run.mjs <平台>      平台：pi、codex、openclaw、dsh、hermes（hermes 要有 uv）
// 主目录换成临时目录，不碰这台机器上的配置。给 CI 在几种系统上跑，本机也能跑。

import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { killTree, launch } from '../../packages/core/lib/command.mjs'
import {
  BOOT_MARK,
  KEY,
  MODEL,
  MODEL_KEY,
  RECALL_MARK,
  replyText,
  startFakeKioku,
  startFakeModel,
} from './fakes.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const kiokuBin = join(repo, 'packages', 'core', 'bin', 'kioku')
const PROMPT = '只回答一个字：好'

const log = (text) => process.stdout.write(`${text}\n`)

// 跑一个命令到结束：{ code, stdout, stderr }。输出照样打到日志里，出问题时看得到
function run(name, args, { env, cwd, timeout = 180_000, quiet = false } = {}) {
  return new Promise((resolve) => {
    const how = launch(name, args, env)
    if (!how) return resolve({ code: 127, stdout: '', stderr: `找不到命令 ${name}` })
    log(`$ ${name} ${args.join(' ')}`)
    const child = spawn(how.file, how.args, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...how.options,
    })
    let stdout = ''
    let stderr = ''
    const show = (chunk) => {
      if (!quiet) process.stdout.write(String(chunk).replace(/^/gm, '    '))
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      show(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      show(chunk)
    })
    const timer = setTimeout(() => {
      stderr += '\n超时'
      killTree(child, 'SIGKILL', { shell: how.shell })
    }, timeout)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 126, stdout, stderr: `${stderr}\n${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

class Failed extends Error {}
function check(ok, what) {
  log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) throw new Failed(what)
}
async function must(result, what) {
  const done = await result
  check(done.code === 0, `${what}（退出码 ${done.code}）`)
  return done
}

// 各平台怎么装、怎么配模型、怎么装插件、怎么跑一轮。ctx：{ root, home, env, kioku, model, tool, sh }
const PLATFORMS = {
  pi: {
    packages: ['@earendil-works/pi-coding-agent'],
    async prepare({ root, env, model }) {
      env.PI_CODING_AGENT_DIR = join(root, 'pi-agent')
      mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true })
      writeFileSync(
        join(env.PI_CODING_AGENT_DIR, 'models.json'),
        JSON.stringify({
          providers: {
            e2e: {
              baseUrl: `${model.url}/v1`,
              api: 'openai-completions',
              apiKey: MODEL_KEY,
              models: [{ id: MODEL }],
            },
          },
        }),
      )
    },
    install: ({ sh }) => must(sh('pi', ['install', repo]), '装上 pi 的扩展'),
    turn: ({ sh, work }) =>
      sh('pi', ['--provider', 'e2e', '--model', MODEL, '--print', PROMPT], { cwd: work }),
  },

  codex: {
    packages: ['@openai/codex'],
    async prepare({ root, env, model }) {
      env.CODEX_HOME = join(root, 'codex')
      env.E2E_MODEL_KEY = MODEL_KEY
      mkdirSync(env.CODEX_HOME, { recursive: true })
      writeFileSync(
        join(env.CODEX_HOME, 'config.toml'),
        [
          `model = "${MODEL}"`,
          'model_provider = "e2e"',
          '',
          '[model_providers.e2e]',
          'name = "e2e"',
          `base_url = "${model.url}/v1"`,
          'wire_api = "responses"',
          'requires_openai_auth = false',
          'env_key = "E2E_MODEL_KEY"',
          '',
        ].join('\n'),
      )
    },
    async install({ sh }) {
      await must(
        sh('codex', ['plugin', 'marketplace', 'add', repo]),
        '把本仓库加成 Codex 的插件市场',
      )
      await must(sh('codex', ['plugin', 'add', 'kioku@kioku']), '装上 Codex 的插件')
    },
    turn: ({ sh, work }) =>
      sh('codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', PROMPT], {
        cwd: work,
      }),
  },

  openclaw: {
    packages: ['openclaw'],
    async prepare({ home, env, model }) {
      env.OPENCLAW_HOME = home
      env.E2E_MODEL_KEY = MODEL_KEY
      mkdirSync(join(home, '.openclaw'), { recursive: true })
      writeFileSync(
        join(home, '.openclaw', 'openclaw.json'),
        JSON.stringify({
          gateway: { mode: 'local' },
          agents: { defaults: { model: { primary: `e2e/${MODEL}` } } },
          models: {
            mode: 'merge',
            providers: {
              e2e: {
                baseUrl: `${model.url}/v1`,
                apiKey: '${E2E_MODEL_KEY}',
                api: 'openai-completions',
                models: [
                  {
                    id: MODEL,
                    name: MODEL,
                    reasoning: false,
                    input: ['text'],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        }),
      )
    },
    async install({ root, sh, cli, npm }) {
      // 照发到 npm 的样子装：打成包再装（发布之前没法从 npm 装）
      await must(
        npm(['pack', '--pack-destination', root], { cwd: join(repo, 'plugins', 'openclaw') }),
        '把 OpenClaw 的插件打成包',
      )
      const tgz = readdirSync(root).find((name) => name.endsWith('.tgz'))
      await must(
        sh('openclaw', ['plugins', 'install', join(root, tgz), '--force', '--accept-capabilities']),
        '装上 OpenClaw 的插件',
      )
      // 装好之后再运行一次：核对槽位
      await must(cli(['setup', 'openclaw']), 'kioku setup openclaw（装好之后）')
    },
    turn: ({ sh, work }) =>
      sh('openclaw', ['agent', '--local', '--agent', 'main', '-m', PROMPT], { cwd: work }),
  },

  dsh: {
    // dsh 装插件要 PATH 里有 pnpm
    packages: ['@deepseek-ai/dsh', 'pnpm@11.2.2'],
    async prepare({ home, env, model, sh }) {
      env.DSH_HOME = join(home, '.dsh')
      env.E2E_MODEL_KEY = MODEL_KEY
      // 跑一次让它建出 profile，再把模型指到假的服务上
      await must(
        sh('dsh', ['headless', '--dump-default-config'], { quiet: true }),
        '建出 dsh 的 profile',
      )
      writeFileSync(
        join(env.DSH_HOME, 'profiles', 'headless', 'cordis.patch.yml'),
        [
          '- id: llm-pi-ai',
          '  config:',
          '    providers:',
          '      e2e:',
          '        displayName: E2E',
          '        apiKeyEnv: E2E_MODEL_KEY',
          '        api: openai-completions',
          `        baseURL: ${model.url}/v1`,
          '        models:',
          `          - id: ${MODEL}`,
          `            name: ${MODEL}`,
          '            contextWindow: 200000',
          '- id: agent-default-model',
          '  config:',
          '    provider: e2e',
          `    model: ${MODEL}`,
          '',
        ].join('\n'),
      )
    },
    install: ({ sh }) =>
      must(
        sh('dsh', ['plugin', '--profile', 'headless', 'add', repo]),
        '给 headless 的 profile 装上插件',
      ),
    turn: ({ sh, work }) =>
      sh('dsh', ['headless', '--approval-policy', 'never', PROMPT], { cwd: work }),
  },

  hermes: {
    // Python 的平台：用 uv 装进临时目录
    packages: [],
    async prepare({ root, env, model, sh }) {
      env.HERMES_HOME = join(root, 'hermes')
      env.UV_TOOL_DIR = join(root, 'uv-tools')
      env.UV_TOOL_BIN_DIR = join(root, 'uv-bin')
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
      env[pathKey] = `${env.UV_TOOL_BIN_DIR}${delimiter}${env[pathKey]}`
      mkdirSync(env.HERMES_HOME, { recursive: true })
      await must(
        sh('uv', ['tool', 'install', 'hermes-agent'], { timeout: 900_000, quiet: true }),
        '装上 hermes-agent',
      )
      for (const [key, value] of [
        ['model.provider', 'custom'],
        ['model.base_url', `${model.url}/v1`],
        ['model.default', MODEL],
        ['model.api_key', MODEL_KEY],
      ]) {
        await must(sh('hermes', ['config', 'set', key, value], { quiet: true }), `hermes 的 ${key}`)
      }
    },
    async install({ env }) {
      // 照 hermes plugins install 的结果放：插件目录下以 plugin.yaml 的 name 命名（它只从 GitHub 装，装不了这次的改动）
      cpSync(join(repo, 'plugins', 'hermes'), join(env.HERMES_HOME, 'plugins', 'kioku'), {
        recursive: true,
        filter: (source) =>
          !/[\\/](tests|\.venv|__pycache__|\.pytest_cache|\.ruff_cache)([\\/]|$)/.test(source),
      })
      check(true, '放好 Hermes 的 provider')
    },
    turn: ({ sh, work }) => sh('hermes', ['-z', PROMPT], { cwd: work }),
  },
}

async function main(platform) {
  const spec = PLATFORMS[platform]
  if (!spec) {
    log(`用法：node scripts/e2e/run.mjs <${Object.keys(PLATFORMS).join('|')}>`)
    return 2
  }
  const root = mkdtempSync(join(tmpdir(), `kioku-e2e-${platform}-`))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const tools = join(root, 'tools')
  for (const dir of [home, work, tools]) mkdirSync(dir, { recursive: true })
  const kioku = await startFakeKioku(platform)
  const model = await startFakeModel()
  // 主目录与配置目录都换掉；PATH 前面加上装平台的那个目录
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    KIOKU_CONFIG_DIR: join(root, 'kioku-config'),
    KIOKU_API_KEY: KEY,
    NO_COLOR: '1',
    CI: '1',
    [pathKey]: `${join(tools, 'node_modules', '.bin')}${delimiter}${process.env[pathKey] ?? ''}`,
  }
  // npm 的缓存留在原来的位置：换了主目录之后重新下载太慢
  const npmEnv = { ...process.env }
  const sh = (name, args, options = {}) => run(name, args, { env, cwd: root, ...options })
  const cli = (args) => run(process.execPath, [kiokuBin, ...args], { env, cwd: root })
  const npm = (args, options = {}) => run('npm', args, { env: npmEnv, cwd: root, ...options })
  const ctx = { root, home, work, env, kioku, model, sh, cli, npm }
  try {
    log(`== ${platform}，${process.platform} ${process.arch}，Node ${process.version}`)
    writeFileSync(join(tools, 'package.json'), '{"private":true}')
    if (spec.packages.length) {
      await must(
        npm(['install', '--no-audit', '--no-fund', ...spec.packages], {
          cwd: tools,
          timeout: 900_000,
          quiet: true,
        }),
        `装上 ${spec.packages.join('、')}`,
      )
    }
    await spec.prepare?.(ctx)
    await must(cli(['setup', platform, '--server-url', kioku.url]), `kioku setup ${platform}`)
    await spec.install(ctx)
    await must(cli(['doctor', platform]), `kioku doctor ${platform}`)

    const turn = await spec.turn(ctx)
    check(turn.code === 0, `跑一轮（退出码 ${turn.code}）`)
    const events = kioku.events()
    const names = events.map((event) => event.event)
    check(names.includes('session.start'), '假的 Kioku 收到 session.start')
    check(names.includes('prompt.submit'), '假的 Kioku 收到 prompt.submit')
    const submit = events.find((event) => event.event === 'prompt.submit')
    check(String(submit?.prompt ?? '').includes(PROMPT), 'prompt.submit 带着这一轮的输入')
    const saw = (key) => model.requests.some((request) => request[key])
    check(saw('boot'), `模型的请求里有启动加载（${BOOT_MARK}）`)
    check(saw('recall'), `模型的请求里有召回（${RECALL_MARK}）`)
    // 工具：平台向 Kioku 取过工具清单，或者模型的请求里已经带着工具（有的平台按需才把工具交给模型）
    check(kioku.mcp().includes('tools/list') || saw('tools'), 'Kioku 的工具登记上了')
    const end = events.find((event) => event.event === 'turn.end')
    check(Boolean(end), '假的 Kioku 收到 turn.end')
    check(String(end?.user ?? '').includes(PROMPT), 'turn.end 带着这一轮的输入')
    check(String(end?.reply ?? '').includes('E2E-REPLY'), 'turn.end 带着模型的回复')
    check(
      String(end?.reply ?? '').includes(replyText({ boot: true, recall: true, tools: true })) ||
        String(end?.reply ?? '').includes('boot=1 recall=1'),
      '回复说明注入到了模型手上',
    )
    check(
      kioku.requests.every((request) => request.authorized || request.path === '/v1/health'),
      '发给 Kioku 的请求都带着访问密钥',
    )
    log(`== ${platform} 通过`)
    return 0
  } catch (err) {
    if (!(err instanceof Failed)) log(`✗ 脚本出错：${err?.stack ?? err}`)
    log(
      `-- 假的 Kioku 收到的：${JSON.stringify(kioku.requests.map((r) => [r.method, r.path, r.authorized, r.body?.event ?? r.body?.method])).slice(0, 2000)}`,
    )
    log(`-- 假的模型收到的：${JSON.stringify(model.requests).slice(0, 1000)}`)
    log(`== ${platform} 没有通过`)
    return 1
  } finally {
    await kioku.close()
    await model.close()
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows 上还有进程占着文件时删不掉，留给系统清
    }
  }
}

process.exitCode = await main(process.argv[2])
// 平台可能留下后台的东西占着事件循环
setTimeout(() => process.exit(), 1000).unref()
