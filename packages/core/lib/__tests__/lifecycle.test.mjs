import { createServer } from 'node:http'
import { hostname } from 'node:os'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KeyRejected } from '../http.mjs'
import { deviceKeyOf, postEvent } from '../lifecycle.mjs'

let server
let base
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '未登录或凭据无效' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

describe('deviceKeyOf', () => {
  it('优先读取 KIOKU_DEVICE_KEY，去掉控制字符并截断到 128 个字符', () => {
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: '  work\u0000-mac\n\t  ' })).toBe('work-mac')
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: 'a'.repeat(150) })).toHaveLength(128)
  })

  it('截断到 128 个 UTF-16 码元时不切开代理对', () => {
    const val = deviceKeyOf({ KIOKU_DEVICE_KEY: `${'a'.repeat(127)}🚀tail` })
    expect(val).toBe('a'.repeat(127))
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: `${'a'.repeat(126)}🚀` })).toBe(`${'a'.repeat(126)}🚀`)
  })

  it('未设置或只有空白与控制字符时退回本机主机名', () => {
    const expected = hostname().trim().slice(0, 128) || undefined
    expect(deviceKeyOf({})).toBe(expected)
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: ' \u0007\n ' })).toBe(expected)
  })
})

describe('postEvent', () => {
  it('普通 401 抛出 KeyRejected（非 legacy），而不是泛化的 HTTP 401', async () => {
    const err = await postEvent(base, 'kioku_test_key', { event: 'session.start' }, 2000).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(KeyRejected)
    expect(err.legacy).toBe(false)
    expect(err.message).toBe('访问密钥无效或已吊销')
  })
})
