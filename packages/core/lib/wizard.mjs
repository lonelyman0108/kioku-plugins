// 在终端里不带参数运行 kioku 时的向导：一个状态面板，不是一条直线。先扫描服务器与本机各平台的现状，
// 再按缺什么列出动作；每个动作先列计划、确认后执行，做完回到面板刷新。
// 交互（选择、确认、输入）经 ui 这一层，接口照 @clack/prompts，用例里换成假的；
// 各动作的实际步骤都是别的子命令已有的那一套（setup、login、import、doctor）

import { loadConfig } from './config.mjs'
import { connectPlatforms, pluginSteps, resultsText } from './connect.mjs'
import { doctor } from './doctor.mjs'
import { keyFormatError, KiokuFailure } from './http.mjs'
import { planImport, writeImport } from './import.mjs'
import {
  composeUp,
  defaultLocalDir,
  expandDir,
  hasCompose,
  healthy,
  LOCAL_PORT,
  LOCAL_URL,
  manualDownload,
  portBusy,
  prepareDir,
  setupDone,
  waitUntil,
} from './local.mjs'
import { openBrowser } from './login.mjs'
import {
  actionsFor,
  connectCandidates,
  defaultServerUrl,
  renderPanel,
  scan,
  serverHealth,
} from './panel.mjs'
import { PLATFORMS } from './platforms.mjs'
import { serverUrlProblem } from './profile.mjs'
import { setup } from './setup.mjs'
import { shownUrl } from './text.mjs'

// 收下一段输出，给计划预览用
export function bufferOut() {
  let text = ''
  return {
    write(chunk) {
      text += chunk
      return true
    },
    text: () => text.replace(/\n+$/, ''),
  }
}

// 接在向导的竖线下面写：每行前面加「│  」，和 @clack/prompts 的排版对齐
export function barOut(stream) {
  let atLineStart = true
  return {
    write(chunk) {
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
  setup,
  doctor,
  planImport,
  writeImport,
  loadConfig,
  open: openBrowser,
  local: { composeUp, hasCompose, healthy, portBusy, prepareDir, setupDone, waitUntil },
}

const cancelled = (ui, value) => ui.isCancel(value)

async function chooseServer(ctx) {
  const { ui, deps } = ctx
  const value = await ui.text({
    message: 'Kioku 的服务地址',
    placeholder: 'https://kioku.example.com',
    ...(ctx.url ? { initialValue: ctx.url } : {}),
    validate: (text) => serverUrlProblem((text ?? '').trim().replace(/\/+$/, '')) ?? undefined,
  })
  if (cancelled(ui, value)) return
  const url = value.trim().replace(/\/+$/, '')
  const health = await deps.serverHealth(url)
  if (!health.reachable) {
    const keep = await ui.confirm({
      message: `${shownUrl(url)} 无法连接（${health.problem}），仍然用这个地址？`,
      initialValue: false,
    })
    if (cancelled(ui, keep) || !keep) return
  }
  ctx.url = url
}

// 接入（或重新授权）几个平台：浏览器确认一次，签发的访问密钥照 kioku setup 写下
async function connect(ctx, rows, { reauth = false } = {}) {
  const { ui, deps, env, cwd, out } = ctx
  if (!rows.length) return
  const picked = await ui.multiselect({
    message: reauth ? '重新授权哪些平台' : '接入哪些平台',
    options: rows.map((row) => ({
      value: row.id,
      label: row.name,
      ...(row.present ? {} : { hint: '本机没发现' }),
    })),
    initialValues: rows.filter((row) => reauth || row.present).map((row) => row.id),
  })
  if (cancelled(ui, picked) || !picked.length) return
  const plan = picked.map((id) => {
    const row = rows.find((item) => item.id === id)
    const memory = row.memory === 'none' ? '' : '，停用自带的长期记忆'
    const moved = row.otherServer ? `；原来接到 ${shownUrl(row.url)}` : ''
    return `${PLATFORMS[id].name}：签发访问密钥，写下配置${memory}${moved}`
  })
  ui.note(
    [`服务器 ${shownUrl(ctx.url)}`, ...plan, '', '浏览器里确认一次，访问密钥不显示'].join('\n'),
    '计划',
  )
  const ok = await ui.confirm({ message: '开始？' })
  if (cancelled(ui, ok) || !ok) return
  const results = await deps.connectPlatforms({ url: ctx.url, ids: picked }, { env, out, cwd })
  ui.note(resultsText(results), '结果')
  const done = results.filter((item) => item.status === 'connected').map((item) => item.id)
  const steps = await deps.pluginSteps(done, { env, cwd })
  if (steps) ui.note(steps, '装插件')
}

// 先用 --dry-run 看要改什么，确认后再做
async function previewThenRun(ctx, args, question) {
  const { ui, deps, env, cwd } = ctx
  const preview = bufferOut()
  await deps.setup([...args, '--dry-run'], { env, out: preview, cwd, login: null })
  ui.note(preview.text().replace(/\n?没有写入（--dry-run）$/, ''), '计划')
  const ok = await ui.confirm({ message: question })
  if (cancelled(ui, ok) || !ok) return
  await deps.setup(args, { env, out: ctx.out, cwd, login: null })
}

// 迁移一个平台的本地记忆：照 kioku import 列计划、确认后写入
async function migrate(ctx, id) {
  const { ui, deps, env, out } = ctx
  const platform = PLATFORMS[id]
  let config
  if (platform.readConfig) config = await platform.readConfig(env)
  else {
    // Claude Code 的访问密钥在它的 /plugin 里，读不到：Claude Code 的会话里有环境变量，否则请用户输入
    config = await deps.loadConfig(env).catch(() => null)
    if (!config || config.url !== ctx.url) {
      const key = await ui.password({
        message: `${platform.name} 用的访问密钥（记忆迁进它所属的应用）`,
        validate: (text) => keyFormatError((text ?? '').trim()) ?? undefined,
      })
      if (cancelled(ui, key)) return
      config = { url: ctx.url, key: key.trim() }
    }
  }
  if (!config) throw new KiokuFailure(`还没有给 ${platform.name} 配过：先接入`)
  const plan = await deps.planImport(config, { from: platform.source }, { env, out })
  if (plan.empty) return
  if (!plan.todo.length) {
    ui.log.info('没有要写的')
    return
  }
  const ok = await ui.confirm({ message: `写入这 ${plan.todo.length} 条？` })
  if (cancelled(ui, ok) || !ok) return
  await deps.writeImport(config, plan, { out })
}

async function disable(ctx, state) {
  const { ui } = ctx
  const rows = state.platforms.filter(
    (row) =>
      ['ok', 'invalid', 'unknown', 'broken'].includes(row.connection) ||
      (row.connection === 'manual' && row.memory === 'off'),
  )
  const id = await ui.select({
    message: '停用哪个平台（恢复自带记忆、清掉配置）',
    options: rows.map((row) => ({ value: row.id, label: row.name })),
  })
  if (cancelled(ui, id)) return
  await previewThenRun(ctx, [id, '--undo'], `停用 ${PLATFORMS[id].name}？`)
}

async function check(ctx) {
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
async function awaitSetup(ctx, url, code) {
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

// 本机起一个 Kioku：放好 compose.yaml 与 .env，docker compose up -d，等它就绪、等用户建好管理员
async function startLocal(ctx) {
  const { ui, deps, env } = ctx
  const local = deps.local
  if (await local.healthy(LOCAL_URL)) {
    ui.log.info(`本机 ${LOCAL_PORT} 端口上已经有 Kioku 在运行，直接用它`)
    ctx.url = LOCAL_URL
    return
  }
  if (!(await local.hasCompose(env))) {
    throw new KiokuFailure('没有找到 docker compose：先装好 Docker（含 compose 插件）再来')
  }
  if (await local.portBusy(LOCAL_PORT)) {
    throw new KiokuFailure(
      `端口 ${LOCAL_PORT} 被别的程序占着：先停掉它（lsof -i :${LOCAL_PORT} 看是哪个），或者改 compose.yaml 里的端口后自己启动`,
    )
  }
  const answer = await ui.text({
    message: '放在哪个目录',
    initialValue: defaultLocalDir(env),
    validate: (text) => ((text ?? '').trim() ? undefined : '要写目录'),
  })
  if (cancelled(ui, answer)) return
  const dir = expandDir(answer.trim(), env)
  ui.note(
    [
      `目录 ${dir}`,
      '下载 compose.yaml、.env.example（已有的不覆盖）',
      '生成 .env：数据库密码、主密钥、初始化码随机生成，只给本人读写（已有的不覆盖）',
      `docker compose up -d，端口只开在 127.0.0.1:${LOCAL_PORT}`,
    ].join('\n'),
    '计划',
  )
  const ok = await ui.confirm({ message: '开始？' })
  if (cancelled(ui, ok) || !ok) return

  let prepared
  try {
    prepared = await local.prepareDir(dir)
  } catch (err) {
    if (!(err instanceof KiokuFailure)) throw err
    ui.note(manualDownload(dir), '手动下载')
    throw err
  }
  if (prepared.env.written) {
    ui.log.warn(
      `主密钥在 ${prepared.env.file} 的 KIOKU_MASTER_KEY：另外保存一份，和数据库备份分开放；丢了机密记忆与托管凭据解不开`,
    )
  } else ui.log.info(`${prepared.env.file} 已经有了，沿用`)

  const spin = ui.spinner()
  spin.start('docker compose up -d（第一次要拉镜像，可能要几分钟）')
  try {
    await local.composeUp(dir, env)
  } catch (err) {
    spin.stop('没有起来')
    throw err
  }
  spin.message?.('等待 Kioku 就绪')
  const up = await local.waitUntil(() => local.healthy(LOCAL_URL), { timeoutMs: 180_000 })
  spin.stop(up ? 'Kioku 已就绪' : 'Kioku 没有就绪')
  if (!up) {
    throw new KiokuFailure(
      `Kioku 在 3 分钟内没有就绪：运行 cd ${dir} && docker compose logs kioku 看原因`,
    )
  }
  ctx.url = LOCAL_URL
  const code = prepared.env.setupCode
  if (!code) ui.log.info(`初始化码看日志：cd ${dir} && docker compose logs kioku`)
  if (await awaitSetup(ctx, LOCAL_URL, code)) return 'connect'
}

async function perform(ctx, choice, state) {
  if (choice === 'server') return chooseServer(ctx)
  if (choice === 'local') {
    if ((await startLocal(ctx)) === 'connect') {
      const next = await ctx.deps.scan({ env: ctx.env, cwd: ctx.cwd, url: ctx.url })
      return connect(ctx, connectCandidates(next))
    }
    return
  }
  if (choice === 'open') {
    await awaitSetup(ctx, ctx.url, null)
    return
  }
  if (choice === 'connect') return connect(ctx, connectCandidates(state))
  if (choice === 'reauth') {
    return connect(
      ctx,
      state.platforms.filter((row) => row.connection === 'invalid'),
      { reauth: true },
    )
  }
  if (choice === 'claude-memory') {
    return previewThenRun(ctx, ['claude-code'], '停用 Claude Code 的自动记忆？')
  }
  if (choice.startsWith('import:')) return migrate(ctx, choice.slice('import:'.length))
  if (choice === 'disable') return disable(ctx, state)
  if (choice === 'doctor') return check(ctx)
}

// 向导的主循环，返回退出码
export async function wizard({ ui, env, cwd, out, deps = {} }) {
  const ctx = { ui, env, cwd, out, deps: { ...DEPS, ...deps }, url: null }
  ctx.url = await ctx.deps.defaultServerUrl(env)
  ui.intro('Kioku')
  for (;;) {
    const spin = ui.spinner()
    spin.start('读取现状')
    const state = await ctx.deps.scan({ env, cwd, url: ctx.url })
    spin.stop('现状')
    ui.note(renderPanel(state), '面板')
    const choice = await ui.select({ message: '要做什么', options: actionsFor(state) })
    if (cancelled(ui, choice) || choice === 'exit') {
      ui.outro('再运行 kioku 回到这里')
      return 0
    }
    if (choice === 'refresh') continue
    try {
      await perform(ctx, choice, state)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      ui.log.error(err.message)
    }
  }
}
