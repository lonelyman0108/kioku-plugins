// 在终端里不带参数运行 kioku 时的向导：一个渐进披露的状态面板，先扫描服务器与本机各平台的现状，
// 再按缺什么列出动作；接入后自动尝试安装对应平台插件并完成 MCP 握手验证，做完回到面板刷新。

import { upgradePageOf } from './api.ts'
import { migrateCommand, planMigration, type MigrationPlan } from './commands/migrate.ts'
import { conflictToolsText, formatConflicts, removeConflicts } from './conflicts.ts'
import { connectPlatforms, pluginSteps, resultsText } from './connect.ts'
import {
  KiokuFailure,
  keyFormatError,
  loadConfig,
  plain,
  serverUrlProblem,
  shownUrl,
} from './core.ts'
import { doctor } from './doctor.ts'
import { rememberServerUrl } from './identity.ts'
import { pendingOf, planImport, writeImport } from './import.ts'
import {
  formatHandshakeLines,
  installPlugin,
  removeManagedAgyPlugin,
  verifyConnectionHandshake,
} from './installer.ts'
import {
  composeState,
  composeUp,
  defaultLocalDir,
  expandDir,
  hasCompose,
  healthy,
  latestRelease,
  LOCAL_PORT,
  LOCAL_URL,
  manualDownload,
  portBusy,
  prepareDir,
  setupCodeIn,
  setupDone,
  waitUntil,
} from './local.ts'
import { openBrowser } from './login.ts'
import {
  actionsFor,
  canDisable,
  connectCandidates,
  defaultServerUrl,
  effectivePresence,
  migrationCandidates,
  renderPanel,
  scan,
  serverHealth,
  type PanelState,
  type PlatformRow,
} from './panel.ts'
import { PLATFORMS } from './platforms.ts'
import type { PromptsUi } from './prompts.ts'
import { setup } from './setup.ts'
import type { Env, TargetConfig, Writer } from './types.ts'

// 收下一段输出，给计划预览用
export function bufferOut(): Writer & { text: () => string } {
  let text = ''
  return {
    write(chunk: string | Uint8Array) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
    text: () => text.replace(/\n+$/, ''),
  }
}

// 接在向导的竖线下面写：每行前面加「│  」，和交互框排版对齐
export function barOut(stream: Writer): Writer {
  let atLineStart = true
  return {
    write(chunk: string | Uint8Array) {
      let text = ''
      for (const char of String(chunk)) {
        if (atLineStart) text += char === '\n' ? '│' : '│  '
        text += char
        atLineStart = char === '\n'
      }
      return stream.write(text)
    },
  }
}

// 每个动作的默认依赖，用例里换成假的
const DEPS = {
  scan,
  serverHealth,
  defaultServerUrl,
  connectPlatforms,
  pluginSteps,
  installPlugin,
  verifyConnectionHandshake,
  removeManagedAgyPlugin,
  planMigration,
  setup,
  doctor,
  planImport,
  writeImport,
  removeConflicts,
  loadConfig,
  open: openBrowser,
  local: {
    composeState,
    composeUp,
    hasCompose,
    healthy,
    latestRelease,
    portBusy,
    prepareDir,
    setupCodeIn,
    setupDone,
    waitUntil,
  },
}

export type WizardDeps = typeof DEPS

interface WizardContext {
  ui: PromptsUi
  env: Env
  cwd: string
  out: Writer
  deps: WizardDeps
  url: string | null
  pending: Map<string, { pending: number | null; reason?: string }>
}

const cancelled = (ui: PromptsUi, value: unknown): value is symbol => ui.isCancel(value)

async function chooseServer(ctx: WizardContext): Promise<void> {
  const { ui, deps } = ctx
  const value = await ui.text({
    message: 'Kioku 的服务地址',
    placeholder: 'https://kioku.example.com',
    ...(ctx.url ? { initialValue: ctx.url } : {}),
    validate: (text) => serverUrlProblem((text ?? '').trim().replace(/\/+$/, '')) ?? undefined,
  })
  if (cancelled(ui, value)) return
  const url = String(value).trim().replace(/\/+$/, '')
  const health = await deps.serverHealth(url)
  if (!health.reachable) {
    const keep = await ui.confirm({
      message: `${shownUrl(url)} 无法连接（${health.problem}），仍然用这个地址？`,
      initialValue: false,
    })
    if (cancelled(ui, keep) || !keep) return
  }
  ctx.url = url
  await rememberServerUrl(url, ctx.env).catch(() => {})
}

// 接入（或重新授权）几个平台：浏览器确认一次，签发的访问密钥照 kioku setup 写下；默认尝试自动安装插件并握手测试
async function connect(
  ctx: WizardContext,
  rows: PlatformRow[],
  { reauth = false }: { reauth?: boolean } = {},
): Promise<void> {
  const { ui, deps, env, cwd, out } = ctx
  if (!rows.length || !ctx.url) return
  const picked = await ui.multiselect({
    message: reauth ? '重新授权哪些客户端' : '接入哪些客户端',
    options: rows.map((row) => ({
      value: row.id,
      label: row.name,
      ...(effectivePresence(row) === 'installed' ? {} : { hint: '本机未检测到' }),
    })),
    initialValues: rows
      .filter((row) => reauth || effectivePresence(row) === 'installed')
      .map((row) => row.id),
  })
  if (cancelled(ui, picked) || !picked.length) return
  const plan = picked.map((id) => {
    const row = rows.find((item) => item.id === id)!
    const memory = row.memory === 'none' ? '' : '，停用自带的长期记忆'
    const conflicts = row.conflicts?.filter((c) => c.removable) ?? []
    const clean = conflicts.length ? `，先清理 ${conflictToolsText(conflicts)}` : ''
    const moved = row.otherServer && row.url ? `；原来接到 ${shownUrl(row.url)}` : ''
    return `${PLATFORMS[id].name}：签发访问密钥，写下配置${memory}${clean}${moved}`
  })
  ui.note(
    [`服务器 ${shownUrl(ctx.url)}`, ...plan, '', '浏览器里确认一次，访问密钥不显示'].join('\n'),
    '计划',
  )
  const ok = await ui.confirm({ message: '开始？' })
  if (cancelled(ui, ok) || !ok) return

  const readyIds: string[] = []
  const preFailed: Array<{ id: string; status: 'failed'; reason: string }> = []
  for (const id of picked) {
    const row = rows.find((item) => item.id === id)!
    const conflicts = row.conflicts?.filter((c) => c.removable) ?? []
    if (!conflicts.length) {
      readyIds.push(id)
      continue
    }
    const cleanRes = await deps.removeConflicts(conflicts, { env, cwd, out })
    if (cleanRes.some((r) => !r.ok)) {
      preFailed.push({ id, status: 'failed', reason: '清理冲突没有全部成功' })
    } else {
      readyIds.push(id)
    }
  }
  const results = readyIds.length
    ? await deps.connectPlatforms({ url: ctx.url, ids: readyIds }, { env, out, cwd })
    : []
  const allResults = [...preFailed, ...results]
  const done = allResults.filter((item) => item.status === 'connected').map((item) => item.id)
  ui.note(
    done.length ? resultsText(allResults) : `一个平台都没有接上\n${resultsText(allResults)}`,
    '结果',
  )

  if (!done.length) return

  // 非 mock 环境下自动尝试安装插件与 MCP 握手检查；测试里自定义 pluginSteps 时尊重旧契约
  const isCustomMock =
    deps.pluginSteps !== DEPS.pluginSteps || deps.connectPlatforms !== DEPS.connectPlatforms
  if (!isCustomMock) {
    const manualIds: string[] = []
    const summary: string[] = []
    for (const id of done) {
      const res = await deps.installPlugin(id, { env, cwd })
      summary.push(`${PLATFORMS[id].name}：${res.message}`)
      if (res.status === 'manual') manualIds.push(id)
      const cfg = await PLATFORMS[id].readConfig?.(env).catch(() => null)
      if (cfg) {
        const handshake = await deps.verifyConnectionHandshake(id, cfg, { env })
        summary.push(...formatHandshakeLines(handshake).map((l) => `  ${l}`))
      }
    }
    if (summary.length) ui.note(summary.join('\n'), '插件与连通性')
    const steps = manualIds.length ? await deps.pluginSteps(manualIds, { env, cwd }) : ''
    if (steps) ui.note(steps, '装插件')
    return
  }

  const steps = await deps.pluginSteps(done, { env, cwd })
  if (steps) ui.note(steps, '装插件')
}

// 先用 --dry-run 看要改什么，确认后再做
async function previewThenRun(
  ctx: WizardContext,
  args: string[],
  question: string,
): Promise<boolean> {
  const { ui, deps, env, cwd } = ctx
  const preview = bufferOut()
  await deps.setup([...args, '--dry-run'], {
    env,
    out: preview,
    cwd,
    login: null,
    skipConflicts: true,
  })
  ui.note(preview.text().replace(/\n?没有写入（--dry-run）$/, ''), '计划')
  const ok = await ui.confirm({ message: question })
  if (cancelled(ui, ok) || !ok) return false
  await deps.setup(args, { env, out: ctx.out, cwd, login: null, skipConflicts: true })
  return true
}

// 迁移一个平台的本地记忆：照 kioku import 列计划（这时才和 Kioku 逐条比对）、确认后写入。
// 比出来的未迁移条数记在这次向导里，面板上显示；写入之后作废
async function migrate(ctx: WizardContext, id: string): Promise<void> {
  const { ui, deps, env, out } = ctx
  const platform = PLATFORMS[id]
  let config: TargetConfig | null = platform.readConfig ? await platform.readConfig(env) : null
  if (!config) {
    // Claude Code 仅在 /plugin 模式下可能没有 profile 文件：尝试环境变量或提示用户输入
    config = await deps.loadConfig(env).catch(() => null)
    if ((!config || (ctx.url && config.url !== ctx.url)) && ctx.url) {
      const key = await ui.password({
        message: `${platform.name} 用的访问密钥（记忆迁进它所属的记忆圈）`,
        validate: (text) => keyFormatError((text ?? '').trim()) ?? undefined,
      })
      if (cancelled(ui, key)) return
      config = { url: ctx.url, key: String(key).trim() }
    }
  }
  if (!config) throw new KiokuFailure(`尚未为 ${platform.name} 配置访问密钥：请先接入`)
  const plan = await deps.planImport(config, { from: platform.source! }, { env, out })
  if (plan.empty) {
    ctx.pending.set(id, { pending: 0 })
    return
  }
  ctx.pending.set(id, pendingOf(plan))
  if (!plan.todo.length) {
    ui.log.info('没有要写的')
    return
  }
  const ok = await ui.confirm({ message: `写入这 ${plan.todo.length} 条？` })
  if (cancelled(ui, ok) || !ok) return
  ctx.pending.delete(id)
  await deps.writeImport(config, plan, { out })
}

async function cleanConflictsAction(ctx: WizardContext, state: PanelState): Promise<void> {
  const { ui, deps, env, cwd, out } = ctx
  const rows = state.platforms.filter((row) => row.conflicts?.some((c) => c.removable))
  if (!rows.length) return
  let ids = rows.map((row) => row.id)
  if (rows.length > 1) {
    const picked = await ui.multiselect({
      message: '清理哪些平台上的冲突记忆工具',
      options: rows.map((row) => ({
        value: row.id,
        label: row.name,
        hint: conflictToolsText(row.conflicts!.filter((c) => c.removable)),
      })),
      initialValues: ids,
    })
    if (cancelled(ui, picked) || !picked.length) return
    ids = picked
  }
  const items = rows
    .filter((row) => ids.includes(row.id))
    .flatMap((row) => row.conflicts!.filter((c) => c.removable))
  ui.note(formatConflicts(items, PLATFORMS).join('\n'), '计划')
  const ok = await ui.confirm({ message: `清理这 ${items.length} 项冲突？` })
  if (cancelled(ui, ok) || !ok) return
  const results = await deps.removeConflicts(items, { env, cwd, out })
  if (results.some((r) => !r.ok)) {
    throw new KiokuFailure('部分冲突没有清理成功，请查看上面的输出')
  }
  ui.log.success('冲突已清理，重启对应平台后生效')
}

async function disable(ctx: WizardContext, state: PanelState): Promise<void> {
  const { ui } = ctx
  const rows = state.platforms.filter(canDisable)
  const id = await ui.select({
    message: '停用哪个客户端（恢复自带记忆、清掉配置）',
    options: rows.map((row) => ({ value: row.id, label: row.name })),
  })
  if (cancelled(ui, id)) return
  const ran = await previewThenRun(ctx, [id, '--undo'], `停用 ${PLATFORMS[id].name}？`)
  if (ran && id === 'agy' && (await ctx.deps.removeManagedAgyPlugin({ env: ctx.env }))) {
    ui.log.info('已清理 Antigravity 托管插件目录')
  }
}

async function check(ctx: WizardContext): Promise<void> {
  const { ui, deps, env, cwd, out } = ctx
  const id = await ui.select({
    message: '检查哪个平台',
    options: Object.entries(PLATFORMS).map(([value, platform]) => ({
      value,
      label: platform.name,
    })),
  })
  if (cancelled(ui, id)) return
  await deps.doctor([id], { env, out, cwd })
}

// 打开管理界面，等第一个管理员建好
async function awaitSetup(ctx: WizardContext, url: string, code: string | null): Promise<boolean> {
  const { ui, deps } = ctx
  if (code) ui.note(`初始化码：${code}\n在 ${url} 输入它，建第一个管理员`, '初始化')
  deps.open(url)
  const spin = ui.spinner()
  spin.start(`等待在 ${url} 建好管理员（Ctrl-C 退出）`)
  const done = await deps.local.waitUntil(() => deps.local.setupDone(url), {
    timeoutMs: 60 * 60_000,
    intervalMs: 3000,
  })
  spin.stop(done ? '管理员已建好' : '没有等到初始化完成')
  return done
}

// 等这个目录里的 Kioku 就绪
async function waitHealthy(
  ctx: WizardContext,
  dir: string,
  spin: ReturnType<PromptsUi['spinner']>,
): Promise<void> {
  spin.message?.('等待 Kioku 就绪')
  const up = await ctx.deps.local.waitUntil(() => ctx.deps.local.healthy(LOCAL_URL), {
    timeoutMs: 180_000,
  })
  spin.stop(up ? 'Kioku 已就绪' : 'Kioku 没有就绪')
  if (!up) {
    throw new KiokuFailure(
      `Kioku 在 3 分钟内没有就绪：运行 cd ${dir} && docker compose logs kioku 查看日志`,
    )
  }
}

// docker compose up -d，等它就绪
async function bringUp(ctx: WizardContext, dir: string): Promise<void> {
  const spin = ctx.ui.spinner()
  spin.start('docker compose up -d（第一次要拉镜像，可能要几分钟）')
  try {
    await ctx.deps.local.composeUp(dir, ctx.env)
  } catch (err) {
    spin.stop('启动失败')
    throw err
  }
  await waitHealthy(ctx, dir, spin)
}

// 本机起一个 Kioku：放好 compose.yaml 与 .env，docker compose up -d，等它就绪、等用户建好管理员。
async function startLocal(ctx: WizardContext): Promise<'connect' | undefined> {
  const { ui, deps, env } = ctx
  const local = deps.local
  if (await local.healthy(LOCAL_URL)) {
    ui.log.info(`本机 ${LOCAL_PORT} 端口上已经有 Kioku 在运行，直接用它`)
    ctx.url = LOCAL_URL
    await rememberServerUrl(LOCAL_URL, env).catch(() => {})
    return
  }
  if (!(await local.hasCompose(env))) {
    throw new KiokuFailure('未找到 docker compose：请安装 Docker（含 compose 插件）后重试')
  }
  const answer = await ui.text({
    message: '放在哪个目录',
    initialValue: defaultLocalDir(env),
    validate: (text) => ((text ?? '').trim() ? undefined : '目录不能为空'),
  })
  if (cancelled(ui, answer)) return
  const dir = expandDir(String(answer).trim(), env)

  const existing = await local.composeState(dir, env)
  let code: string | null
  if (existing === 'running') {
    ui.log.info(`${dir} 里的 Kioku 已经在运行，等它就绪`)
    const spin = ui.spinner()
    spin.start('等待 Kioku 就绪')
    await waitHealthy(ctx, dir, spin)
    code = await local.setupCodeIn(dir)
  } else if (existing === 'stopped') {
    ui.note(`目录 ${dir}\n这里的 Kioku 建过、没在运行：docker compose up -d`, '计划')
    const ok = await ui.confirm({ message: '启动？' })
    if (cancelled(ui, ok) || !ok) return
    await bringUp(ctx, dir)
    code = await local.setupCodeIn(dir)
  } else {
    if (await local.portBusy(LOCAL_PORT)) {
      const busyCmd =
        process.platform === 'win32'
          ? `netstat -ano | findstr :${LOCAL_PORT}`
          : `lsof -i :${LOCAL_PORT}`
      throw new KiokuFailure(
        `端口 ${LOCAL_PORT} 已被其他进程占用：请先停止对应进程（${busyCmd}），或修改 compose.yaml 中的端口后启动`,
      )
    }
    const release = await local.latestRelease()
    if (!release.release) {
      ui.log.warn(
        `未能获取最新正式版（${release.problem}）：用 main 上的 compose.yaml 与 edge 镜像（main 上最新的提交，不保证稳定）`,
      )
    }
    ui.note(
      [
        `目录 ${dir}`,
        `版本 ${release.imageTag}${release.release ? '（最新的正式版）' : ''}`,
        `下载 ${release.ref} 的 compose.yaml、.env.example（已有的不覆盖）`,
        `生成 .env：数据库密码、主密钥、初始化码随机生成，镜像固定在 ${release.imageTag}，权限仅限当前用户读写（已有文件不覆盖）`,
        `docker compose up -d，端口仅绑定在 127.0.0.1:${LOCAL_PORT}`,
      ].join('\n'),
      '计划',
    )
    const ok = await ui.confirm({ message: '开始？' })
    if (cancelled(ui, ok) || !ok) return

    let prepared
    try {
      prepared = await local.prepareDir(dir, release)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      ui.note(manualDownload(dir, release.ref), '手动下载')
      throw err
    }
    if (prepared.env.written) {
      ui.log.warn(
        `主密钥在 ${prepared.env.file} 的 KIOKU_MASTER_KEY：另外保存一份，和数据库备份分开放；丢失将无法解开机密记忆与托管凭据`,
      )
    } else ui.log.info(`${prepared.env.file} 已经有了，沿用`)
    await bringUp(ctx, dir)
    code = prepared.env.setupCode
  }
  ctx.url = LOCAL_URL
  await rememberServerUrl(LOCAL_URL, env).catch(() => {})
  if (await local.setupDone(LOCAL_URL)) return 'connect'
  if (!code) ui.log.info(`初始化码看日志：cd ${dir} && docker compose logs kioku`)
  if (await awaitSetup(ctx, LOCAL_URL, code)) return 'connect'
}

function formatWizardMigrationLines(plan: MigrationPlan): string[] {
  const lines = [
    `目标服务器：${shownUrl(plan.url)}`,
    `待迁移 ${plan.items.length} 个客户端：${plan.items.map((item) => item.name).join('、')}`,
    '',
  ]
  for (const item of plan.items) {
    const steps: string[] = []
    if (item.removeLegacySource) steps.push('卸载旧插件来源')
    if (item.clearCache) steps.push('清理工具清单缓存')
    if (item.pluginAction === 'reinstall') steps.push('重新安装新版插件')
    else if (item.pluginAction === 'upgrade') steps.push('更新新版插件')
    if (item.reauth) steps.push('浏览器批量重新授权')
    if (item.findings.manualInstallDir) {
      steps.push(`手动替换目录 ${plain(item.findings.manualInstallDir)}`)
    }
    lines.push(`${item.name}：${item.reasons.join(' · ')}`)
    lines.push(`  步骤：${steps.join(' → ')}`)
  }
  return lines
}

async function perform(ctx: WizardContext, choice: string, state: PanelState): Promise<void> {
  if (choice === 'server') return chooseServer(ctx)
  if (choice === 'local') {
    if ((await startLocal(ctx)) === 'connect') {
      const next = await ctx.deps.scan({ env: ctx.env, cwd: ctx.cwd, url: ctx.url })
      return connect(ctx, connectCandidates(next))
    }
    return
  }
  if (choice === 'open') {
    if (ctx.url) await awaitSetup(ctx, ctx.url, null)
    return
  }
  if (choice === 'open-upgrade') {
    if (ctx.url) {
      const page = upgradePageOf(ctx.url)
      ctx.deps.open(page)
      ctx.ui.log.info(`已在浏览器打开升级页 ${page}，完成就地迁移后回到控制台继续`)
    }
    return
  }
  if (choice === 'migrate') {
    if (!ctx.url) return
    const candidates = migrationCandidates(state)
    if (!candidates.length) return
    const plan = await ctx.deps.planMigration(ctx.url, {
      platforms: candidates.map((c) => c.id),
      env: ctx.env,
      cwd: ctx.cwd,
    })
    if (!plan.items.length) {
      ctx.ui.log.info('本机已接入客户端均已是最新，无需迁移')
      return
    }
    ctx.ui.note(formatWizardMigrationLines(plan).join('\n'), '旧版迁移计划')
    const ok = await ctx.ui.confirm({ message: '确认执行以上迁移计划？', initialValue: true })
    if (cancelled(ctx.ui, ok) || !ok) return
    await migrateCommand([...candidates.map((c) => c.id), '--server-url', ctx.url, '-y'], {
      env: ctx.env,
      cwd: ctx.cwd,
      out: ctx.out,
      open: ctx.deps.open,
    })
    return
  }
  if (choice === 'connect') return connect(ctx, connectCandidates(state))
  if (choice === 'reauth') {
    return connect(
      ctx,
      state.platforms.filter((row) => row.connection === 'invalid' && !row.legacyKey),
      { reauth: true },
    )
  }
  if (choice === 'claude-memory') {
    return void (await previewThenRun(ctx, ['claude-code'], '停用 Claude Code 的自动记忆？'))
  }
  if (choice.startsWith('import:')) return migrate(ctx, choice.slice('import:'.length))
  if (choice === 'clean') return cleanConflictsAction(ctx, state)
  if (choice === 'disable') return disable(ctx, state)
  if (choice === 'doctor') return check(ctx)
}

// 向导的主循环，返回退出码
export async function wizard({
  ui,
  env,
  cwd,
  out,
  deps = {},
}: {
  ui: PromptsUi
  env: Env
  cwd: string
  out: Writer
  deps?: Partial<WizardDeps>
}): Promise<number> {
  // pending：选过迁移的平台比出来的未迁移条数（平台 id → pendingOf 的结果），只在这次向导里有效
  const ctx: WizardContext = {
    ui,
    env,
    cwd,
    out,
    deps: { ...DEPS, ...deps },
    url: null,
    pending: new Map(),
  }
  ctx.url = await ctx.deps.defaultServerUrl(env)
  ui.intro('Kioku')
  for (;;) {
    const spin = ui.spinner()
    spin.start('读取现状')
    const state = await ctx.deps.scan({ env, cwd, url: ctx.url })
    for (const row of state.platforms) {
      if (ctx.pending.has(row.id)) row.pending = ctx.pending.get(row.id)
    }
    spin.stop('现状')
    ui.note(renderPanel(state, { collapseUninstalled: true }), '面板')
    const choice = await ui.select({ message: '要做什么', options: actionsFor(state) })
    if (cancelled(ui, choice) || choice === 'exit') {
      ui.outro('再运行 kioku 回到这里')
      return 0
    }
    if (choice === 'refresh') continue
    // 换了服务器、接入或停用之后，比过的未迁移条数可能对不上了
    if (!choice.startsWith('import:') && choice !== 'doctor') ctx.pending.clear()
    try {
      await perform(ctx, choice, state)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      ui.log.error(err.message)
    }
  }
}
