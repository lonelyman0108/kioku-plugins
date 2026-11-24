// 一站式管理命令：connect（多平台一键授权+装插件+MCP 握手）、disconnect（干净断开并清理托管插件）、
// upgrade（升级插件与刷新缓存）、open（打开管理界面）、local（Docker 本机服务子命令）

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { assertServerSupported, SUPPORTED_API, upgradePageOf } from '../api.ts'
import { ensureNoConflicts } from '../conflicts.ts'
import { connectPlatforms, pluginSteps, resultsText } from '../connect.ts'
import {
  KiokuFailure,
  UsageError,
  capture,
  failureText,
  listTools,
  plain,
  serverUrlProblem,
  shownUrl,
  writeToolCache,
} from '../core.ts'
import { rememberServerUrl } from '../identity.ts'
import { confirm } from '../import.ts'
import {
  formatHandshakeLines,
  installPlugin,
  removeManagedAgyPlugin,
  verifyConnectionHandshake,
} from '../installer.ts'
import {
  composeState,
  composeUp,
  defaultLocalDir,
  expandDir,
  hasCompose,
  latestRelease,
  LOCAL_PORT,
  LOCAL_URL,
  portBusy,
  prepareDir,
  probeLocalHealth,
  setupCodeIn,
  setupDone,
  waitUntil,
} from '../local.ts'
import { openBrowser } from '../login.ts'
import { defaultServerUrl, scanPlatform } from '../panel.ts'
import { platformNames, PLATFORMS } from '../platforms.ts'
import { isCancel, loadPrompts } from '../prompts.ts'
import { setup } from '../setup.ts'
import { resolveServerUrl } from '../target.ts'
import type { Env, Reader, Writer } from '../types.ts'
import { osc8Link } from '../ui/clipboard.ts'
import { createTheme, renderBox } from '../ui/theme.ts'

export const CONNECT_USAGE = `用法：kioku connect [平台…] [--server-url <地址>] [--no-browser] [--no-install] [--remove-conflicts]

一站式把平台接入 Kioku：浏览器授权签发访问密钥、写入本机配置与停用自带长期记忆、
自动尝试安装对应平台插件，并完成 whoami 与 MCP 工具清单握手验证。

  [平台…]             ${platformNames()}；在终端里不写时交互式多选已安装的平台
  --server-url <地址>  Kioku 的服务地址（也可以用 KIOKU_SERVER_URL；配过的沿用上次的）
  --no-browser         不自动打开浏览器，只显示确认码与地址
  --no-install         跳过自动安装插件步骤，仅写入配置与停用自带记忆
  --remove-conflicts   先卸载平台上已有的冲突记忆工具（Lore 及常见记忆 MCP）再继续
`

export function parseConnectArgs(argv: string[]): {
  platforms: string[]
  serverUrl?: string
  browser: boolean
  install: boolean
  removeConflicts: boolean
} {
  const options: {
    platforms: string[]
    serverUrl?: string
    browser: boolean
    install: boolean
    removeConflicts: boolean
  } = {
    platforms: [],
    browser: true,
    install: true,
    removeConflicts: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-browser') options.browser = false
    else if (arg === '--no-install') options.install = false
    else if (arg === '--remove-conflicts') options.removeConflicts = true
    else if (arg === '--server-url') {
      const value = argv[++i]
      if (!value) throw new UsageError('--server-url 后面要写地址')
      options.serverUrl = value
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else {
      if (!Object.hasOwn(PLATFORMS, arg)) {
        throw new UsageError(`不认识的平台 ${arg}，可以用的：${platformNames()}`)
      }
      if (!options.platforms.includes(arg)) options.platforms.push(arg)
    }
  }
  return options
}

export async function connectCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    stdin = process.stdin,
    open = openBrowser,
    sleep,
    now,
    clientName,
    installFn = installPlugin,
  }: {
    env?: Env
    out?: Writer & { isTTY?: boolean; columns?: number }
    cwd?: string
    stdin?: Reader
    open?: (url: string) => void
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    clientName?: string
    installFn?: typeof installPlugin
  } = {},
): Promise<number> {
  const options = parseConnectArgs(argv)
  const interactive = Boolean(stdin?.isTTY && out?.isTTY)

  let ids = options.platforms
  let url: string | null = options.serverUrl
    ? resolveServerUrl(options, env, null)
    : (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '') || (await defaultServerUrl(env))

  if (!ids.length) {
    if (!interactive) {
      throw new UsageError(`要指定要接入的客户端（${platformNames()}），或在终端里运行以交互选择`)
    }
    const ui = await loadPrompts({ input: stdin, output: out, env })
    if (!ui) throw new KiokuFailure('交互式向导不可用')
    if (!url) {
      const entered = await ui.text({
        message: 'Kioku 的服务地址',
        placeholder: 'https://kioku.example.com',
        validate: (v) => serverUrlProblem((v ?? '').trim().replace(/\/+$/, '')) ?? undefined,
      })
      if (isCancel(entered)) return 0
      url = String(entered).trim().replace(/\/+$/, '')
    }
    const rows = await Promise.all(
      Object.keys(PLATFORMS).map((id) => scanPlatform(id, { env, cwd, url })),
    )
    const candidates = rows.filter((r) => !(r.connection === 'ok' && !r.otherServer))
    const picked = await ui.multiselect({
      message: '接入哪些平台',
      options: (candidates.length ? candidates : rows).map((r) => ({
        value: r.id,
        label: r.name,
        hint: r.present ? undefined : '本机未检测到',
      })),
      initialValues: rows.filter((r) => r.present && r.connection !== 'ok').map((r) => r.id),
      required: true,
    })
    if (isCancel(picked) || !picked.length) return 0
    ids = picked
  }

  if (!url) {
    throw new UsageError('要给服务地址：--server-url https://kioku.example.com')
  }
  const urlProblem = serverUrlProblem(url)
  if (urlProblem) throw new KiokuFailure(urlProblem)
  await assertServerSupported(url)
  await rememberServerUrl(url, env).catch(() => {})

  const readyIds: string[] = []
  const preFailed: Array<{ id: string; status: 'failed'; reason: string }> = []
  for (const id of ids) {
    try {
      const conflictStatus = await ensureNoConflicts(id, PLATFORMS[id].name, {
        env,
        cwd,
        out,
        stdin,
        remove: options.removeConflicts,
      })
      if (conflictStatus === 'cancelled') return 0
      readyIds.push(id)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      preFailed.push({ id, status: 'failed', reason: err.message })
    }
  }

  const results = readyIds.length
    ? await connectPlatforms(
        { url, ids: readyIds },
        {
          env,
          out,
          cwd,
          open,
          browser: options.browser,
          clientName,
          sleep,
          now,
        },
      )
    : []
  const allResults = [...preFailed, ...results]
  out.write(`\n${resultsText(allResults)}\n`)

  const connected = allResults.filter((r) => r.status === 'connected').map((r) => r.id)
  const manualIds: string[] = []
  let postFailed = false

  if (options.install && connected.length) {
    out.write('\n插件与连通性验证：\n')
    for (const id of connected) {
      const installRes = await installFn(id, { env, cwd })
      out.write(`  [${PLATFORMS[id].name}] ${installRes.message}\n`)
      if (installRes.status === 'manual') manualIds.push(id)
      else if (installRes.status === 'failed') postFailed = true
      const config = await PLATFORMS[id].readConfig?.(env).catch(() => null)
      if (config) {
        const handshake = await verifyConnectionHandshake(id, config, { env })
        if (!handshake.ok) postFailed = true
        for (const line of formatHandshakeLines(handshake)) {
          out.write(`  ${line}\n`)
        }
      }
    }
  } else if (connected.length) {
    manualIds.push(...connected)
  }

  if (manualIds.length) {
    const steps = await pluginSteps(manualIds, { env, cwd, url })
    if (steps) out.write(`\n${steps}\n`)
  }

  return allResults.some((r) => r.status === 'failed') || postFailed ? 1 : 0
}

export const DISCONNECT_USAGE = `用法：kioku disconnect <平台> [--dry-run] [-y|--yes]

断开平台与 Kioku 的接入：恢复平台自带长期记忆设置、删除本机凭据配置文件，
并安全清理由 kioku 托管安装的插件文件。

  <平台>     ${platformNames()}
  --dry-run  只预览要清理的配置，不修改文件
  -y, --yes  跳过交互确认直接执行
`

export function parseDisconnectArgs(argv: string[]): {
  platform: string
  dryRun: boolean
  yes: boolean
} {
  let platform: string | null = null
  let dryRun = false
  let yes = false
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '-y' || arg === '--yes') yes = true
    else if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    else if (platform !== null) throw new UsageError('每次只写一个平台')
    else {
      if (!Object.hasOwn(PLATFORMS, arg)) {
        throw new UsageError(`不认识的平台 ${arg}，可以用的：${platformNames()}`)
      }
      platform = arg
    }
  }
  if (!platform) throw new UsageError(`要写一个平台（${platformNames()}）`)
  return { platform, dryRun, yes }
}

export async function disconnectCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    stdin = process.stdin,
  }: { env?: Env; out?: Writer; cwd?: string; stdin?: Reader } = {},
): Promise<number> {
  const { platform, dryRun, yes } = parseDisconnectArgs(argv)
  if (!dryRun && !yes) {
    if (!stdin.isTTY) {
      throw new KiokuFailure('不在终端里运行时要带 --yes 才断开；先用 --dry-run 预览')
    }
    const ok = await confirm(`确认断开 ${PLATFORMS[platform].name} 与 Kioku 的连接？[y/N] `, {
      stdin,
      out,
    })
    if (!ok) {
      out.write('没有改动\n')
      return 0
    }
  }
  const code = await setup([platform, '--undo', ...(dryRun ? ['--dry-run'] : [])], {
    env,
    out,
    cwd,
    stdin,
    skipConflicts: true,
    login: null,
  })
  if (!dryRun && platform === 'agy') {
    if (await removeManagedAgyPlugin({ env })) {
      out.write('已移除托管安装的 Antigravity 插件目录\n')
    }
  }
  return code
}

export const UPGRADE_USAGE = `用法：kioku upgrade [平台…]

更新已接入平台的 Kioku 插件（如同步内置 Antigravity / Gemini 插件、调用客户端插件更新命令），
并刷新本机 MCP 工具清单缓存。

  [平台…]  ${platformNames()}；不写时检查并更新所有已接入或已安装插件的平台
`

export function parseUpgradeArgs(argv: string[]): { platforms: string[] } {
  const platforms: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) throw new UsageError(`不认识的选项 ${arg}`)
    if (!Object.hasOwn(PLATFORMS, arg)) {
      throw new UsageError(`不认识的平台 ${arg}，可以用的：${platformNames()}`)
    }
    if (!platforms.includes(arg)) platforms.push(arg)
  }
  return { platforms }
}

export async function upgradeCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    cwd = process.cwd(),
    installFn = installPlugin,
  }: { env?: Env; out?: Writer; cwd?: string; installFn?: typeof installPlugin } = {},
): Promise<number> {
  const { platforms: explicit } = parseUpgradeArgs(argv)
  let targets = explicit
  if (!targets.length) {
    targets = []
    for (const id of Object.keys(PLATFORMS)) {
      const cfg = await PLATFORMS[id].readConfig?.(env).catch(() => null)
      const st = await PLATFORMS[id].status({ env, cwd }).catch(() => ({ plugin: false }))
      if (cfg || st.plugin) targets.push(id)
    }
  }
  if (!targets.length) {
    out.write('没有找到已接入或已安装 Kioku 插件的平台\n')
    return 0
  }

  let failed = false
  for (const id of targets) {
    const res = await installFn(id, { env, cwd, upgrade: true })
    if (res.status === 'failed') failed = true
    out.write(`[${PLATFORMS[id].name}] ${res.message}\n`)
    if (res.commands?.length && res.status === 'manual') {
      for (const cmd of res.commands) out.write(`  ${cmd}\n`)
    }
    const cfg = await PLATFORMS[id].readConfig?.(env).catch(() => null)
    if (cfg) {
      try {
        const tools = await listTools(cfg)
        if (Array.isArray(tools) && tools.length) {
          if (id === 'openclaw') {
            await writeToolCache('openclaw', { url: cfg.url, tools }, env).catch(() => {})
            out.write(`  ✓ 已刷新 MCP 工具清单（${tools.length} 个工具）\n`)
          } else {
            out.write(`  ✓ MCP 握手正常（${tools.length} 个工具）\n`)
          }
        } else {
          out.write('  ! 未获取到任何 MCP 工具\n')
        }
      } catch (err) {
        out.write(`  ! 无法获取 MCP 工具清单（${failureText(err)}）\n`)
      }
    }
  }
  return failed ? 1 : 0
}

export const OPEN_USAGE = `用法：kioku open [--server-url <地址>]

在默认浏览器中打开 Kioku 管理界面（地址取自 --server-url、KIOKU_SERVER_URL 或已接入平台配置）。

  --server-url <地址>  指定要打开的 Kioku 地址
`

export async function openCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
    open = openBrowser,
  }: { env?: Env; out?: Writer & { isTTY?: boolean }; open?: (url: string) => void } = {},
): Promise<number> {
  let explicit: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--server-url') {
      explicit = argv[++i]
      if (!explicit) throw new UsageError('--server-url 后面要写地址')
    } else throw new UsageError(`不认识的选项 ${arg}`)
  }
  const url =
    explicit?.trim().replace(/\/+$/, '') ??
    (env.KIOKU_SERVER_URL ?? '').trim().replace(/\/+$/, '') ??
    undefined
  const resolved = (url || (await defaultServerUrl(env))) ?? ''
  if (!resolved) {
    throw new KiokuFailure('没有找到 Kioku 服务地址：用 --server-url 指定，或先运行 kioku connect')
  }
  const problem = serverUrlProblem(resolved)
  if (problem) throw new KiokuFailure(problem)
  const shown = shownUrl(resolved)
  out.write(`正在浏览器打开 ${osc8Link(shown, shown, { stream: out, env })}\n`)
  open(shown)
  return 0
}

export const LOCAL_USAGE = `用法：kioku local [up|down|status|logs] [--dir <目录>]

使用 Docker Compose 在本机运行与管理 Kioku 服务端（只监听 127.0.0.1:${LOCAL_PORT}）。

  up      准备 compose.yaml / .env 并后台启动服务，等待健康检查通过（不带子命令时默认为 up）
  down    停止本机 Docker Compose 服务
  status  查看容器运行、健康检查与管理员初始化状态
  logs    查看 kioku 容器最近 50 行日志
  --dir   指定部署目录（默认为 ~/kioku）
`

export function parseLocalArgs(argv: string[]): {
  action: 'up' | 'down' | 'status' | 'logs'
  dir?: string
} {
  let action: 'up' | 'down' | 'status' | 'logs' | undefined
  let dir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') {
      const value = argv[++i]
      if (!value) throw new UsageError('--dir 后面要写目录')
      dir = value
    } else if (arg.startsWith('-')) {
      throw new UsageError(`不认识的选项 ${arg}`)
    } else if (arg === 'up' || arg === 'down' || arg === 'status' || arg === 'logs') {
      if (action) throw new UsageError('最多写一个动作')
      action = arg
    } else {
      throw new UsageError(`不认识的动作 ${arg}（支持 up、down、status、logs）`)
    }
  }
  return { action: action ?? 'up', dir }
}

export async function localCommand(
  argv: string[],
  {
    env = process.env,
    out = process.stdout,
  }: { env?: Env; out?: Writer & { isTTY?: boolean } } = {},
): Promise<number> {
  const { action, dir: rawDir } = parseLocalArgs(argv)
  const dir = expandDir(rawDir ?? defaultLocalDir(env), env)
  const theme = createTheme({ stream: out, env })

  if (action === 'status') {
    const state = await composeState(dir, env)
    const probe = state === 'running' ? await probeLocalHealth(LOCAL_URL) : null
    const olderGen = Boolean(probe && probe.generation !== null && probe.generation < SUPPORTED_API)
    const isUp = probe?.state === 'ok' && !olderGen
    const inited = isUp ? await setupDone(LOCAL_URL) : false
    const healthLine =
      probe?.state === 'legacy'
        ? `待迁移旧数据（打开 ${upgradePageOf(LOCAL_URL)}）`
        : olderGen
          ? `旧版服务端（${plain(probe?.version) || '版本未知'}），需要先升级服务端镜像`
          : probe?.state === 'unavailable'
            ? '数据库暂时无法连接'
            : isUp
              ? `${LOCAL_URL}（就绪）`
              : '未就绪'
    const box = renderBox({
      title: '本机 Kioku 服务',
      theme,
      sections: [
        {
          lines: [
            `目录：${plain(dir)}`,
            `容器：${state === 'running' ? '运行中' : state === 'stopped' ? '已停止' : '未创建'}`,
            `健康：${healthLine}`,
            ...(isUp ? [`初始化：${inited ? '已完成' : '待建立第一个管理员'}`] : []),
          ],
        },
      ],
    })
    out.write(`${box}\n`)
    return 0
  }

  if (action === 'down') {
    if (!(await hasCompose(env))) throw new KiokuFailure('没有找到 docker compose')
    const composePath = join(dir, 'compose.yaml')
    if (!(await stat(composePath).catch(() => null))) {
      throw new KiokuFailure(`${plain(dir)} 里没有 compose.yaml`)
    }
    const res = await capture(
      'docker',
      ['compose', '-f', composePath, '--project-directory', dir, 'down'],
      env,
      { timeout: 120_000 },
    )
    if (!res.ok) throw new KiokuFailure('docker compose down 没有成功')
    out.write(`✓ 已停止 ${plain(dir)} 中的 Kioku\n`)
    return 0
  }

  if (action === 'logs') {
    if (!(await hasCompose(env))) throw new KiokuFailure('没有找到 docker compose')
    const composePath = join(dir, 'compose.yaml')
    if (!(await stat(composePath).catch(() => null))) {
      throw new KiokuFailure(`${plain(dir)} 里没有 compose.yaml`)
    }
    const res = await capture(
      'docker',
      ['compose', '-f', composePath, '--project-directory', dir, 'logs', '--tail', '50', 'kioku'],
      env,
      { timeout: 30_000 },
    )
    if (!res.ok) throw new KiokuFailure('读取 logs 失败')
    out.write(res.output || res.stdout)
    return 0
  }

  // up
  const initialProbe = await probeLocalHealth(LOCAL_URL)
  if (initialProbe.state === 'ok') {
    await rememberServerUrl(LOCAL_URL, env).catch(() => {})
    out.write(`✓ 本机 ${LOCAL_PORT} 端口上已经有 Kioku 在运行：${LOCAL_URL}\n`)
    return 0
  }
  if (initialProbe.state === 'legacy') {
    throw new KiokuFailure(
      `本机 Kioku 正在等待旧数据迁移：打开 ${upgradePageOf(LOCAL_URL)} 完成升级`,
    )
  }
  if (!(await hasCompose(env))) {
    throw new KiokuFailure('没有找到 docker compose：先装好 Docker（含 compose 插件）再来')
  }
  const existing = await composeState(dir, env)
  let code: string | null
  if (existing === 'none') {
    if (await portBusy(LOCAL_PORT)) {
      throw new KiokuFailure(
        `端口 ${LOCAL_PORT} 被别的程序占用：先停掉它，或者改 compose.yaml 里的端口后启动`,
      )
    }
    const release = await latestRelease()
    const prepared = await prepareDir(dir, release)
    code = prepared.env.setupCode
    out.write(`✓ 已准备目录 ${plain(dir)}（版本 ${release.imageTag}）\n`)
  } else {
    code = await setupCodeIn(dir)
  }

  out.write('正在运行 docker compose up -d…\n')
  await composeUp(dir, env)
  let legacyDetected = false
  const up = await waitUntil(
    async () => {
      const probe = await probeLocalHealth(LOCAL_URL)
      if (probe.state === 'legacy') {
        legacyDetected = true
        return true
      }
      return probe.state === 'ok'
    },
    { timeoutMs: 180_000 },
  )
  if (legacyDetected) {
    throw new KiokuFailure(
      `本机 Kioku 正在等待旧数据迁移：打开 ${upgradePageOf(LOCAL_URL)} 完成升级`,
    )
  }
  if (!up) {
    throw new KiokuFailure(
      `Kioku 在 3 分钟内没有就绪：运行 kioku local logs --dir ${plain(dir)} 查看原因`,
    )
  }
  out.write(`✓ Kioku 已就绪：${LOCAL_URL}\n`)
  await rememberServerUrl(LOCAL_URL, env).catch(() => {})
  if (!(await setupDone(LOCAL_URL))) {
    const codeLines = code
      ? [`初始化码：${code}`, `在浏览器中打开 ${LOCAL_URL} 完成初始化`]
      : [`查看初始化码日志：kioku local logs --dir ${plain(dir)}`]
    out.write(`${renderBox({ title: '待完成初始化', theme, sections: [{ lines: codeLines }] })}\n`)
  }
  return 0
}
