#!/usr/bin/env node
// 在这台机器上装一个真实的平台，照安装说明走一遍：kioku setup → 装插件 → 跑一轮 → kioku doctor，
// 核对三个事件到了假的 Kioku、注入的内容与工具到了模型手上。模型与 Kioku 都是假的（fakes.mjs），不用任何密钥。
// 用法：node scripts/e2e/run.mjs <平台>      平台：pi（别的陆续加）
// 主目录换成临时目录，不碰这台机器上的配置。给 CI 在几种系统上跑，本机也能跑。

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const ctx = { root, home, work, env, kioku, model, sh }
  try {
    log(`== ${platform}，${process.platform} ${process.arch}，Node ${process.version}`)
    writeFileSync(join(tools, 'package.json'), '{"private":true}')
    await must(
      run('npm', ['install', '--no-audit', '--no-fund', ...spec.packages], {
        env: npmEnv,
        cwd: tools,
        timeout: 900_000,
        quiet: true,
      }),
      `装上 ${spec.packages.join('、')}`,
    )
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
