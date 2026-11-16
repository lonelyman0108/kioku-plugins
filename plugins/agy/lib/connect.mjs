// 把几个平台接到 Kioku：拿到访问密钥之后交给各平台的 kioku setup 写下（核对、写文件都照它的规矩）。
// 向导走浏览器授权，几个平台一起申请、只确认一次；服务端不认这种写法时逐个平台申请。
// kioku install 的访问密钥从环境变量来，直接写下。插件不替用户装，只列出要运行的命令

import { KiokuFailure } from './http.mjs'
import { deviceLogin, deviceLoginMany, LegacyServer, MAX_PLATFORMS } from './login.mjs'
import { PLATFORMS } from './platforms.mjs'
import { plain } from './text.mjs'

// 访问密钥已经签发、却没有写下来：说清楚，别让它悄悄留着。kioku login 也用它
export function orphanHint(app) {
  const name = app?.name ? `（应用 ${plain(app.name)}）` : ''
  return `访问密钥已经签发、但没有写下：到管理界面的应用页吊销它${name}，解决上面的问题后重新运行`
}

// 用给定的地址与访问密钥配好一个平台。setup 的输出写到 out；hints 为假时不打印「接下来装上」，
// 由调用方统一列出（向导与 kioku install），kioku login 只配一个平台，照旧打印
export function configure(id, { url, key }, { env, out, cwd }, { hints = false } = {}) {
  return PLATFORMS[id].setup(
    { serverUrl: url, dryRun: false, undo: false, check: true },
    { env, out, cwd, readKey: async () => key, plain, login: null, hints },
  )
}

// 签发好的访问密钥写下；写不下时提醒去吊销
async function settle(id, key, app, io) {
  io.out.write(`\n${PLATFORMS[id].name}\n`)
  try {
    await configure(id, { url: io.url, key }, io)
    return { id, status: 'connected', app }
  } catch (err) {
    // 别的错误照旧抛出（由入口报内部错误），不当成一个平台的失败吞掉
    if (!(err instanceof KiokuFailure)) throw err
    return { id, status: 'failed', reason: `${err.message}。${orphanHint(app)}` }
  }
}

// 用浏览器授权把这几个平台接到 url。返回每个平台的结果（按 ids 的顺序）：
// { id, status: 'connected' | 'skipped' | 'denied' | 'failed', reason?, app? }
export async function connectPlatforms(
  { url, ids },
  { env, out, cwd, open, browser = true, clientName, sleep, now },
) {
  const io = { env, out, cwd, url }
  const login = { out, open, browser, sleep, now, ...(clientName ? { clientName } : {}) }
  const results = new Map()
  // 申请之前先看各平台的配置写不写得进去：访问密钥只在签发时给一次
  const ready = []
  for (const id of ids) {
    try {
      await PLATFORMS[id].preflight?.({ env, cwd })
      ready.push(id)
    } catch (err) {
      if (!(err instanceof KiokuFailure)) throw err
      results.set(id, { id, status: 'failed', reason: err.message })
    }
  }
  // 一次最多 MAX_PLATFORMS 个：多了分批，每批确认一次，前一批签发的先写下再申请下一批
  const batches = []
  for (let i = 0; i < ready.length; i += MAX_PLATFORMS) {
    batches.push(ready.slice(i, i + MAX_PLATFORMS))
  }
  if (batches.length > 1) {
    out.write(`一次最多申请 ${MAX_PLATFORMS} 个平台：分 ${batches.length} 批，每批确认一次\n`)
  }
  let legacy = false
  for (const batch of batches) {
    out.write(
      `这次申请 ${batch.length} 个平台：${batch.map((id) => PLATFORMS[id].name).join('、')}\n`,
    )
    let answers
    try {
      answers = await deviceLoginMany(
        { url, runtimeFamilies: batch.map((id) => PLATFORMS[id].runtimeFamily) },
        login,
      )
    } catch (err) {
      if (err instanceof LegacyServer) {
        legacy = true
        out.write(`${err.message}\n`)
        break
      }
      if (!(err instanceof KiokuFailure)) throw err
      for (const id of batch) results.set(id, { id, status: 'failed', reason: err.message })
      continue
    }
    for (const id of batch) {
      const answer = answers.find((item) => item.runtimeFamily === PLATFORMS[id].runtimeFamily)
      if (answer?.status === 'issued') results.set(id, await settle(id, answer.key, answer.app, io))
      else if (answer?.status === 'denied') {
        results.set(id, { id, status: 'denied', reason: answer.reason || '没有签发' })
      } else results.set(id, { id, status: 'skipped', reason: '确认页上没有勾选' })
    }
  }
  if (legacy) {
    // 旧的服务端：还没有结果的平台逐个申请，每个确认一次；一个不成不影响下一个
    for (const id of ready.filter((item) => !results.has(item))) {
      out.write(`\n${PLATFORMS[id].name}：浏览器授权\n`)
      let key
      try {
        key = await deviceLogin({ url, runtimeFamily: PLATFORMS[id].runtimeFamily }, login)
      } catch (err) {
        if (!(err instanceof KiokuFailure)) throw err
        results.set(id, { id, status: 'failed', reason: err.message })
        continue
      }
      results.set(id, await settle(id, key, null, io))
    }
  }
  return ids.map((id) => results.get(id))
}

const STATUS_NAMES = {
  connected: '已接入',
  manual: '待完成',
  skipped: '跳过',
  denied: '被拒绝',
  failed: '失败',
}

// 结果的文字：按状态分组，一组一行，原因跟在平台名后面
export function resultsText(results) {
  const lines = []
  for (const status of Object.keys(STATUS_NAMES)) {
    const group = results.filter((item) => item.status === status)
    if (!group.length) continue
    const names = group.map((item) => {
      const detail = item.reason ?? (item.app?.name ? `应用 ${plain(item.app.name)}` : '')
      return detail ? `${PLATFORMS[item.id].name}（${detail}）` : PLATFORMS[item.id].name
    })
    lines.push(`${STATUS_NAMES[status]}：${names.join('、')}`)
  }
  return lines.join('\n')
}

// 这几个平台里还要自己装插件的（查得到装好了的不列），每个平台一段：在哪里运行、可以直接复制的命令、之后要做的事。
// 访问密钥在插件配置里填的平台（Claude Code），给了 url 时写明要填的服务地址
export async function pluginSteps(ids, { env, cwd, url }) {
  const blocks = []
  for (const id of ids) {
    const platform = PLATFORMS[id]
    const status = await platform.status({ env, cwd }).catch(() => ({ plugin: null }))
    if (status.plugin === true) continue
    const { where = '在终端里', commands, after } = platform.install
    const lines = [`${platform.name}（${where}运行）`, ...commands.map((line) => `  ${line}`)]
    if (!platform.setup && url) lines.push(`  服务地址填：${url}`)
    lines.push(`  然后：${after}`)
    blocks.push(lines.join('\n'))
  }
  if (!blocks.length) return ''
  return `接下来自己装插件，装好之后再运行 kioku 看状态：\n\n${blocks.join('\n\n')}`
}
