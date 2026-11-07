import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { fetchFailure, parseRunArgs, UsageError } from '../kioku.mjs'

const bin = fileURLToPath(new URL('../../bin/kioku', import.meta.url))
const KEY = 'kioku_test_key'
const VALUES = {
  'pg-main#password': 'pg-secret-1',
  'pg-main#username': 'app-user',
  'pin#code': 'abc',
}

// 一个假的 Kioku：记下收到的请求，按 reply 返回；默认按 VALUES 给值
let server
let base
let requests = []
let reply
const defaultReply = (body) => ({
  status: 200,
  body: {
    values: body.refs.map((r) => ({ ...r, value: VALUES[`${r.identifier}#${r.field}`] })),
  },
})

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const { status, body: out } = reply(body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

let dir
beforeEach(() => {
  requests = []
  reply = defaultReply
  dir = mkdtempSync(join(tmpdir(), 'kioku-run-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// 跑 bin/kioku。默认用 KIOKU_SERVER_URL 与 KIOKU_API_KEY 指向假的 Kioku；env 里值为 null 的变量去掉
function kioku(args, { env = {}, input = '', configured = true, onStdout } = {}) {
  const childEnv = { ...process.env }
  for (const name of ['KIOKU_SERVER_URL', 'KIOKU_API_KEY', 'KIOKU_API_KEY_FILE']) {
    delete childEnv[name]
  }
  if (configured) Object.assign(childEnv, { KIOKU_SERVER_URL: `${base}/`, KIOKU_API_KEY: KEY })
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete childEnv[name]
    else childEnv[name] = value
  }
  const child = spawn(process.execPath, [bin, ...args], { env: childEnv })
  const done = new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
      onStdout?.(stdout, child)
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  child.stdin.end(input)
  return done
}

// kioku run 后面跟一段 node 脚本作为要跑的命令
const node = (code) => ['--', process.execPath, '-e', code]

describe('kioku run 的参数', () => {
  const usage = (argv) => {
    try {
      parseRunArgs(argv)
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError)
      return err.message
    }
    throw new Error(`应当报错：${argv.join(' ')}`)
  }

  it('解析变量、用途与命令；同一个标识与字段只取一次', () => {
    expect(
      parseRunArgs([
        '-e',
        'PGPASSWORD=pg-main#password',
        '-e',
        'DB_PASS=pg-main#password',
        '-e',
        '_user2=pg-main#username',
        '--purpose',
        '  备份数据库  ',
        '--',
        'psql',
        '-e',
        '--',
      ]),
    ).toEqual({
      refs: [
        { identifier: 'pg-main', field: 'password' },
        { identifier: 'pg-main', field: 'username' },
      ],
      variables: [
        ['PGPASSWORD', 0],
        ['DB_PASS', 0],
        ['_user2', 1],
      ],
      purpose: '备份数据库',
      command: 'psql',
      args: ['-e', '--'],
    })
    expect(parseRunArgs(['-e', 'X=a#b', '--purpose=   ', '--', 'true']).purpose).toBeUndefined()
    expect(parseRunArgs(['-e', 'X=a#b', '--help'])).toEqual({ help: true })
  })

  it('各种写错的参数都报出来', () => {
    expect(usage([])).toContain('--')
    expect(usage(['-e', 'X=a#b'])).toContain('--')
    expect(usage(['-e', 'X=a#b', 'echo'])).toContain('--')
    expect(usage(['-e', 'X=a#b', '--'])).toContain('命令')
    expect(usage(['-e', 'X=a#b', '--', ''])).toContain('命令')
    expect(usage(['--', 'echo'])).toContain('-e')
    expect(usage(['-e'])).toContain('-e')
    for (const spec of ['X', '=a#b', 'X=', 'X=a', 'X=a#', 'X=#b', 'X=a#b#c', 'X=A#b', 'X=a#B']) {
      usage(['-e', spec, '--', 'echo'])
    }
    for (const spec of ['X=-a#b', 'X=a#_b', `X=${'a'.repeat(65)}#b`, 'X=a b#c']) {
      usage(['-e', spec, '--', 'echo'])
    }
    // 等号后面可能误填了值本身，报错里不复述
    expect(usage(['-e', 'PGPASSWORD=Hunter2!', '--', 'psql'])).not.toContain('Hunter2')
    expect(usage(['-e', '1X=a#b', '--', 'echo'])).toContain('1X')
    expect(usage(['-e', 'MY-VAR=a#b', '--', 'echo'])).toContain('MY-VAR')
    expect(usage(['-e', 'X=a#b', '-e', 'X=c#d', '--', 'echo'])).toContain('两次')
    expect(usage(['-e', 'X=a#b', '--purpose', '一\n二', '--', 'echo'])).toContain('控制字符')
    expect(usage(['-e', 'X=a#b', '--purpose', '字'.repeat(201), '--', 'echo'])).toContain('200')
    expect(usage(['-e', 'X=a#b', '--purpose', 'a', '--purpose', 'b', '--', 'echo'])).toContain(
      '一次',
    )
    expect(usage(['-e', 'X=a#b', '--purpose'])).toContain('用途')
    expect(usage(['-e', 'X=a#b', '--bogus', '--', 'echo'])).toContain('--bogus')
    const many = Array.from({ length: 33 }, (_, i) => ['-e', `V${i}=c${i}#password`]).flat()
    expect(usage([...many, '--', 'echo'])).toContain('32')
  })

  it('写错时打印用法，退出码 2；--help 打印用法，退出码 0', async () => {
    for (const args of [
      ['run'],
      ['run', '-e', 'X=a#b', 'echo'],
      ['run', '-e', 'X=a', '--', 'echo'],
      ['run', '-e', 'X=a#b', '--'],
      [],
      ['nope'],
    ]) {
      const result = await kioku(args)
      expect(result.code, args.join(' ')).toBe(2)
      expect(result.stderr).toContain('用法：kioku run')
      expect(result.stdout).toBe('')
    }
    expect(requests).toHaveLength(0)
    for (const args of [['--help'], ['-h'], ['run', '--help']]) {
      const result = await kioku(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('用法：kioku run')
    }
  })

  it('bin/kioku 可以直接执行', async () => {
    expect(statSync(bin).mode & 0o111).toBe(0o111)
    const result = await new Promise((resolve) => {
      const child = spawn(bin, ['--help'])
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.on('close', (code) => resolve({ code, stdout }))
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('用法：kioku run')
  })
})

describe('kioku run', () => {
  it('一次取全部值交给命令，输出里原样出现的值打码', async () => {
    const result = await kioku([
      'run',
      '-e',
      'PASS=pg-main#password',
      '-e',
      'AGAIN=pg-main#password',
      '-e',
      'DB_USER=pg-main#username',
      '--purpose',
      '备份数据库',
      ...node(`
        const { PASS, AGAIN, DB_USER } = process.env
        console.log('密码：' + PASS + ' 用户：' + DB_USER)
        console.error('又一次 ' + AGAIN)
        console.log(Buffer.from(PASS).toString('hex'))
      `),
    ])
    expect(result).toMatchObject({ code: 0, stderr: '又一次 ***\n' })
    // 换个形式打印就认不出来：子进程拿到的是真的值
    expect(result.stdout).toBe(
      `密码：*** 用户：***\n${Buffer.from('pg-secret-1').toString('hex')}\n`,
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/credentials/resolve',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    })
    expect(requests[0].body).toEqual({
      refs: [
        { identifier: 'pg-main', field: 'password' },
        { identifier: 'pg-main', field: 'username' },
      ],
      purpose: '备份数据库',
    })
  })

  it('退出码与命令相同，被信号结束时为 128 + 信号编号', async () => {
    const exited = await kioku(['run', '-e', 'X=pg-main#password', ...node('process.exit(3)')])
    expect(exited.code).toBe(3)
    const killed = await kioku([
      'run',
      '-e',
      'X=pg-main#password',
      ...node("process.kill(process.pid, 'SIGKILL')"),
    ])
    expect(killed.code).toBe(128 + 9)
    const missing = await kioku(['run', '-e', 'X=pg-main#password', '--', 'kioku-no-such-command'])
    expect(missing.code).toBe(127)
    expect(missing.stderr).toContain('找不到命令 kioku-no-such-command')
  })

  it('取不到值时不启动命令，服务端的错误文字原样打到标准错误，退出码 2', async () => {
    reply = () => ({ status: 403, body: { error: 'pg-main#password：访问密钥没有凭据能力' } })
    const marker = join(dir, 'ran')
    const result = await kioku([
      'run',
      '-e',
      'X=pg-main#password',
      ...node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`),
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('kioku：pg-main#password：访问密钥没有凭据能力\n')
    expect(result.stdout).toBe('')
    expect(existsSync(marker)).toBe(false)

    // 没有错误文字时说状态码；响应对不上时不给值
    reply = () => ({ status: 502, body: {} })
    expect((await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'])).stderr).toBe(
      'kioku：Kioku 返回 HTTP 502\n',
    )
    reply = () => ({ status: 200, body: { values: [] } })
    const malformed = await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'])
    expect(malformed).toMatchObject({ code: 2, stderr: 'kioku：Kioku 的响应格式不对\n' })
  })

  it('子进程的环境里没有访问密钥；KIOKU_API_KEY_FILE 优先于 KIOKU_API_KEY', async () => {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'kioku_file_key\n')
    const result = await kioku(
      [
        'run',
        '-e',
        'X=pg-main#password',
        ...node(`
          const names = ['KIOKU_API_KEY', 'KIOKU_API_KEY_FILE', 'KIOKU_SERVER_URL']
          console.log(JSON.stringify(names.filter((n) => n in process.env)))
        `),
      ],
      { env: { KIOKU_API_KEY_FILE: keyFile } },
    )
    expect(result).toMatchObject({ code: 0, stdout: '["KIOKU_SERVER_URL"]\n' })
    expect(requests[0].headers.authorization).toBe('Bearer kioku_file_key')
  })

  it('标准输入交给命令', async () => {
    const result = await kioku(
      [
        'run',
        '-e',
        'X=pg-main#password',
        ...node(`
          let input = ''
          process.stdin.on('data', (d) => (input += d))
          process.stdin.on('end', () => process.stdout.write(input.toUpperCase()))
        `),
      ],
      { input: 'hello\n' },
    )
    expect(result).toMatchObject({ code: 0, stdout: 'HELLO\n' })
  })

  it('值少于 4 个字符时照样交给命令，提示一句不打码，不带值', async () => {
    const result = await kioku([
      'run',
      '-e',
      'PIN=pin#code',
      ...node('console.log(process.env.PIN)'),
    ])
    expect(result).toMatchObject({ code: 0, stdout: 'abc\n' })
    expect(result.stderr).toBe('kioku：PIN 的值太短，输出里不打码\n')
  })

  it('收到 SIGTERM 时转给命令', async () => {
    const result = await kioku(
      [
        'run',
        '-e',
        'X=pg-main#password',
        ...node(`
          process.on('SIGTERM', () => { console.log('收到 SIGTERM'); process.exit(7) })
          console.log('就绪')
          setInterval(() => {}, 1000)
        `),
      ],
      {
        onStdout: (stdout, child) => {
          if (stdout === '就绪\n') child.kill('SIGTERM')
        },
      },
    )
    expect(result).toMatchObject({ code: 7, stdout: '就绪\n收到 SIGTERM\n' })
  })

  it('命令已经结束、留下的后台进程还占着输出时，收到信号就不再等', async () => {
    const result = await kioku(
      [
        'run',
        '-e',
        'X=pg-main#password',
        '--',
        'sh',
        '-c',
        '(sleep 0.3; echo 后台; sleep 3) & echo 就绪',
      ],
      {
        onStdout: (stdout, child) => {
          if (stdout.endsWith('后台\n')) child.kill('SIGTERM')
        },
      },
    )
    expect(result).toMatchObject({ code: null, signal: 'SIGTERM', stdout: '就绪\n后台\n' })
  })

  it('下游提前关闭时命令收到 SIGPIPE，不会卡住', async () => {
    const result = await kioku(['run', '-e', 'X=pg-main#password', '--', 'yes'], {
      onStdout: (_stdout, child) => child.stdout.destroy(),
    })
    expect(result.code).toBe(128 + 13)
  })

  it('没有配置时说明怎么配，退出码 2', async () => {
    const result = await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'], {
      configured: false,
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('KIOKU_SERVER_URL')
    expect(result.stderr).toContain('KIOKU_API_KEY')
    expect(requests).toHaveLength(0)

    const missingFile = await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'], {
      env: { KIOKU_API_KEY_FILE: join(dir, 'missing') },
    })
    expect(missingFile.code).toBe(2)
    expect(missingFile.stderr).toContain('ENOENT')
  })

  it('报错里不带访问密钥', async () => {
    // 连不上：只说错误类别
    const closed = createNetServer()
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = closed.address().port
    await new Promise((resolve) => closed.close(resolve))
    const refused = await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'], {
      env: { KIOKU_SERVER_URL: `http://127.0.0.1:${port}` },
    })
    expect(refused).toMatchObject({ code: 2, stderr: 'kioku：无法连接 Kioku（ECONNREFUSED）\n' })

    // 放不进请求头的访问密钥不发出去，也不复述
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, 'kioku_first_half\nkioku_second_half')
    const malformed = await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'], {
      env: { KIOKU_API_KEY_FILE: keyFile },
    })
    expect(malformed.code).toBe(2)
    expect(malformed.stderr).toContain('访问密钥的格式不对')
    expect(malformed.stderr).not.toContain('half')
    expect(requests).toHaveLength(0)

    // 服务端的错误文字里万一带着访问密钥，也盖掉
    reply = () => ({ status: 401, body: { error: `访问密钥 ${KEY} 无效` } })
    const echoed = await kioku(['run', '-e', 'X=pg-main#password', '--', 'true'])
    expect(echoed.stderr).toBe('kioku：访问密钥 *** 无效\n')
  })

  it('fetch 的错误只取类别', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    })
    expect(fetchFailure(timeout)).toBe('连接 Kioku 超时（15 秒）')
    const header = new TypeError(`Headers.append: "Bearer ${KEY}\nx" is an invalid header value.`)
    expect(fetchFailure(header)).toBe('无法连接 Kioku')
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    expect(fetchFailure(refused)).toBe('无法连接 Kioku（ECONNREFUSED）')
    const odd = new TypeError('fetch failed', { cause: { code: `Bearer ${KEY}` } })
    expect(fetchFailure(odd)).toBe('无法连接 Kioku')
  })
})
