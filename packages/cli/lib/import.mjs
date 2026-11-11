// kioku import：把平台自带的本地长期记忆迁进 Kioku。先读本地文件出一份计划（每条放到哪个坐标），
// 和 Kioku 里已有的比过之后列出来，确认了才写。坐标由来源决定，所以重复运行不会重复写：
// 已经有、内容一样的跳过；已经有、内容不一样的不覆盖（可能在 Kioku 里改过），要覆盖得明说。
// 本地的文件不删、不改

import { whoami } from './api.mjs'
import { loadConfig } from './config.mjs'
import { fetchFailure, isRedirect, KiokuFailure, redirectError } from './http.mjs'
import { PLATFORMS } from './platforms.mjs'
import { readProfile } from './profile.mjs'
import { sourceNames, SOURCES, UNSUPPORTED_SOURCES } from './sources.mjs'
import { plain, shownUrl } from './text.mjs'
import { UsageError } from './usage.mjs'

export const IMPORT_USAGE = `用法：kioku import --from <来源> [--path <目录>] [--dry-run] [--yes] [--overwrite]

把平台自带的本地长期记忆迁进 Kioku：先列出每条会放到哪个坐标，确认之后才写。

  --from <来源>  ${sourceNames()}
  --path <目录>  不用默认的位置时指明（Claude Code 是 projects 目录或某个项目的 memory 目录）
  --dry-run      只列出计划，不写
  --yes          不问，直接写（不在终端里运行时要带上）
  --overwrite    Kioku 里同一个坐标已经有、内容不一样的也覆盖（默认跳过）

本地的文件不删、不改。重复运行不会重复写：已经迁过、内容没变的会跳过。
疑似明文凭据的不写，列出是哪个文件的哪一行：先把值存成凭据，或者从文件里去掉再迁。
访问密钥用这个来源对应的平台配好的那个；没有时读 KIOKU_SERVER_URL 与 KIOKU_API_KEY。
指令文件（AGENTS.md、CLAUDE.md）不是记忆，不迁。
`

const TIMEOUT = 15_000

export function parseImportArgs(argv) {
  const options = { from: undefined, path: undefined, dryRun: false, yes: false, overwrite: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--overwrite') options.overwrite = true
    else if (arg === '--from' || arg === '--path') {
      const value = argv[++i]
      if (!value) throw new UsageError(`${arg} 后面要写值`)
      options[arg.slice(2)] = value
    } else throw new UsageError(`不认识的参数 ${arg}`)
  }
  if (!options.from) throw new UsageError('要写来源：--from <来源>')
  if (Object.hasOwn(UNSUPPORTED_SOURCES, options.from)) {
    throw new KiokuFailure(UNSUPPORTED_SOURCES[options.from])
  }
  if (!Object.hasOwn(SOURCES, options.from)) {
    throw new UsageError(`不认识的来源 ${options.from}，可以用的：${sourceNames()}`)
  }
  return options
}

async function request({ url, key }, method, path, body) {
  let res
  let data
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // 不跟着跳转走：访问密钥只发给配置的地址
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT),
    })
    data = await res.json().catch(() => null)
  } catch (err) {
    throw new KiokuFailure(fetchFailure(err, TIMEOUT))
  }
  if (isRedirect(res.status)) {
    throw new KiokuFailure(redirectError(res.status, res.headers.get('location'), url))
  }
  return { status: res.status, data }
}

// 服务端的错误文字压成一行；万一带着访问密钥也盖掉
function serverText(data, status, key) {
  const text = typeof data?.error === 'string' ? data.error.split(key).join('***') : ''
  return plain(text) || `HTTP ${status}`
}

// 和 Kioku 里现有的比：new 没有，same 有且正文一样，differs 有但不一样（含读不到正文的机密）
async function compare(config, item) {
  const { status, data } = await request(
    config,
    'GET',
    `/v1/memories?uri=${encodeURIComponent(item.uri)}`,
  )
  if (status === 404) return { ...item, state: 'new' }
  if (status !== 200)
    return { ...item, state: 'failed', reason: serverText(data, status, config.key) }
  const same = typeof data?.content === 'string' && data.content.trim() === item.content
  return { ...item, state: same ? 'same' : 'differs', version: data?.version, id: data?.id }
}

// 写一条：新建，或者覆盖已有的。返回 { ok } 或 { ok: false, reason, plaintext }
async function write(config, item) {
  const fields = {
    uri: item.uri,
    title: item.title,
    content: item.content,
    ...(item.disclosure ? { disclosure: item.disclosure } : {}),
  }
  const { status, data } =
    item.state === 'differs'
      ? await request(config, 'PATCH', '/v1/memories', {
          ...fields,
          ...(Number.isInteger(item.version) ? { expectedVersion: item.version } : {}),
          ...(item.id ? { expectedId: item.id } : {}),
        })
      : await request(config, 'POST', '/v1/memories', fields)
  if (status === 200 || status === 201) return { ok: true }
  const plaintext = Array.isArray(data?.plaintext) ? data.plaintext : null
  return { ok: false, reason: serverText(data, status, config.key), plaintext }
}

const KINDS = { new: '新建', same: '已有，内容一样', differs: '已有，内容不一样' }

// 问一句是或否；只认 y 开头的回答
async function confirm(question, { stdin, out }) {
  out.write(question)
  for await (const chunk of stdin) {
    return /^\s*y/i.test(chunk.toString('utf8'))
  }
  return false
}

export async function importMemories(
  argv,
  { env = process.env, out = process.stdout, stdin = process.stdin } = {},
) {
  const options = parseImportArgs(argv)
  const source = SOURCES[options.from]
  // 访问密钥：这个来源对应的平台配过就用它的，否则读环境变量
  const profile = PLATFORMS[options.from]?.profile
    ? await readProfile(options.from, env).catch(() => null)
    : null
  const config = profile ?? (await loadConfig(env))
  const who = await whoami(config)
  out.write(
    `Kioku：${shownUrl(config.url)}，应用 ${plain(who.app.name)}（${plain(who.app.slug)}）\n`,
  )

  const { root, found, entries } = await source.read({
    env,
    path: options.path,
    app: who.app.slug,
  })
  if (!found) throw new KiokuFailure(`没有找到${source.name}：${root} 不是目录，用 --path 指明位置`)
  out.write(`来源：${source.name}（${root}）\n`)
  if (!entries.length) {
    out.write('没有可以迁的记忆\n')
    return 0
  }

  // 两条落到同一个坐标的（名字规整之后撞了）只留第一条
  const seen = new Set()
  const usable = []
  const skipped = []
  for (const item of entries) {
    if (item.skipped) skipped.push(item)
    else if (seen.has(item.uri))
      skipped.push({ ...item, skipped: `和前面的一条落到同一个坐标 ${item.uri}` })
    else {
      seen.add(item.uri)
      usable.push(item)
    }
  }
  const compared = []
  for (const item of usable) compared.push(await compare(config, item))

  out.write('\n')
  for (const item of compared) {
    const kind = item.state === 'failed' ? `读取失败（${item.reason}）` : KINDS[item.state]
    out.write(`${kind}  ${item.uri}\n    ${plain(item.title)}\n    ← ${item.source}\n`)
  }
  for (const item of skipped) out.write(`不迁  ${item.source}\n    ${item.skipped}\n`)

  const count = (state) => compared.filter((item) => item.state === state).length
  const todo = compared.filter(
    (item) => item.state === 'new' || (item.state === 'differs' && options.overwrite),
  )
  out.write(
    `\n新建 ${count('new')} 条，已有且一样 ${count('same')} 条，已有但不一样 ${count('differs')} 条` +
      `（${options.overwrite ? '覆盖' : '跳过，要覆盖加 --overwrite'}），不迁 ${skipped.length} 条\n`,
  )
  if (options.dryRun) {
    out.write('没有写入（--dry-run）\n')
    return 0
  }
  if (!todo.length) {
    out.write('没有要写的\n')
    return compared.some((item) => item.state === 'failed') ? 1 : 0
  }
  if (!options.yes) {
    if (!stdin.isTTY)
      throw new KiokuFailure('不在终端里运行时要带 --yes 才写；先用 --dry-run 看计划')
    if (!(await confirm(`写入这 ${todo.length} 条？[y/N] `, { stdin, out }))) {
      out.write('没有写入\n')
      return 0
    }
  }

  let written = 0
  const failed = []
  for (const item of todo) {
    const result = await write(config, item)
    if (result.ok) written++
    else failed.push({ item, ...result })
  }
  out.write(`\n写入 ${written} 条\n`)
  for (const { item, reason, plaintext } of failed) {
    out.write(`没有写入  ${item.uri}\n    ← ${item.source}\n    ${reason}\n`)
    // 只说第几行、哪一类，不带值；行号按正文算（文件头之后）
    for (const spot of plaintext ?? []) {
      out.write(`    正文第 ${Number(spot.line) || '?'} 行：${plain(spot.kind)}\n`)
    }
  }
  if (failed.some((entry) => entry.plaintext)) {
    out.write('疑似明文凭据的没有写：把值存成凭据、正文里写占位符，或者从文件里去掉，再运行一次\n')
  }
  out.write('本地的文件没有动。\n')
  return failed.length || compared.some((item) => item.state === 'failed') ? 1 : 0
}
