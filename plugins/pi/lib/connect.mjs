// 把几个平台接到 Kioku：拿到访问密钥之后交给各平台的 kioku setup 写下（核对、写文件都照它的规矩）。
// 向导走浏览器授权，几个平台一起申请、只确认一次；服务端不认这种写法时逐个平台申请。
// kioku install 的访问密钥从环境变量来，直接写下。插件不替用户装，只列出要运行的命令

import { failureText, KiokuFailure } from './http.mjs'
import { deviceLogin, deviceLoginMany, LegacyServer } from './login.mjs'
import { PLATFORMS } from './platforms.mjs'
import { plain } from './text.mjs'

// 访问密钥已经签发、却没有写下来：说清楚，别让它悄悄留着
function orphanHint(app) {
  const name = app?.name ? `（应用 ${plain(app.name)}）` : ''
  return `访问密钥已经签发、但没有写下：到管理界面的应用页吊销它${name}，解决上面的问题后重新运行`
}

// 用给定的地址与访问密钥配好一个平台。setup 的输出写到 out，接下来装插件的提示由调用方统一列出
export function configure(id, { url, key }, { env, out, cwd }) {
  return PLATFORMS[id].setup(
    { serverUrl: url, dryRun: false, undo: false, check: true },
    { env, out, cwd, readKey: async () => key, plain, login: null, hints: false },
  )
}

// 签发好的访问密钥写下；写不下时提醒去吊销
async function settle(id, key, app, io) {
  io.out.write(`\n${PLATFORMS[id].name}\n`)
  try {
    await configure(id, { url: io.url, key }, io)
    return { id, status: 'connected', app }
  } catch (err) {
    return { id, status: 'failed', reason: `${failureText(err)}。${orphanHint(app)}` }
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
  if (ready.length) {
    const families = ready.map((id) => PLATFORMS[id].runtimeFamily)
    let answers = null
    let legacy = false
    try {
      out.write(
        `这次申请 ${ready.length} 个平台：${ready.map((id) => PLATFORMS[id].name).join('、')}\n`,
      )
      answers = await deviceLoginMany({ url, runtimeFamilies: families }, login)
    } catch (err) {
      if (err instanceof LegacyServer) {
        legacy = true
        out.write(`${err.message}\n`)
      } else if (err instanceof KiokuFailure) {
        for (const id of ready) results.set(id, { id, status: 'failed', reason: err.message })
      } else throw err
    }
    if (answers) {
      for (const [index, answer] of answers.entries()) {
        const id = ready[index]
        if (answer.status === 'issued')
          results.set(id, await settle(id, answer.key, answer.app, io))
        else if (answer.status === 'denied') {
          results.set(id, { id, status: 'denied', reason: answer.reason || '没有签发' })
        } else results.set(id, { id, status: 'skipped' })
      }
    } else if (legacy) {
      // 旧的服务端：逐个平台申请，每个确认一次；一个不成不影响下一个
      for (const id of ready) {
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

// 这几个平台里还要自己装插件的（查得到装好了的不列），每个平台一段：在哪里运行、可以直接复制的命令、之后要做的事
export async function pluginSteps(ids, { env, cwd }) {
  const blocks = []
  for (const id of ids) {
    const platform = PLATFORMS[id]
    const status = await platform.status({ env, cwd }).catch(() => ({ plugin: null }))
    if (status.plugin === true) continue
    const { where = '在终端里', commands, after } = platform.install
    blocks.push(
      [
        `${platform.name}（${where}运行）`,
        ...commands.map((line) => `  ${line}`),
        `  然后：${after}`,
      ].join('\n'),
    )
  }
  if (!blocks.length) return ''
  return `接下来自己装插件，装好之后再运行 kioku 看状态：\n\n${blocks.join('\n\n')}`
}
