import { describe, expect, it } from 'vitest'

import { errorKind, failureText, fetchFailure, keyFormatError, KiokuFailure } from '../http.mjs'

const KEY = 'kioku_test_key'

describe('访问密钥检查与报错', () => {
  it('访问密钥只能是可见的 ASCII 字符', () => {
    expect(keyFormatError(KEY)).toBeNull()
    for (const key of ['kioku_a\nb', 'kioku a', 'kioku_键', 'kioku_\u0000', '']) {
      expect(keyFormatError(key)).toContain('访问密钥的格式不对')
    }
  })

  it('fetch 的错误只取类别', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    })
    expect(fetchFailure(timeout, 15_000)).toBe('连接 Kioku 超时（15 秒）')
    const header = new TypeError(`Headers.append: "Bearer ${KEY}\nx" is an invalid header value.`)
    expect(fetchFailure(header, 5000)).toBe('无法连接 Kioku')
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    expect(fetchFailure(refused, 5000)).toBe('无法连接 Kioku（ECONNREFUSED）')
    for (const code of [`Bearer ${KEY}`, KEY]) {
      expect(fetchFailure(new TypeError('fetch failed', { cause: { code } }), 5000)).toBe(
        '无法连接 Kioku',
      )
    }
  })

  it('打印的原因：插件自己写的原样给出，别的只给类别', () => {
    expect(failureText(new KiokuFailure('HTTP 500'))).toBe('HTTP 500')
    const header = new TypeError(`Headers.append: "Bearer ${KEY}\nx" is an invalid header value.`)
    expect(failureText(header)).toBe('TypeError')
    const parse = new SyntaxError(`Unexpected token 'B', "Bearer ${KEY}" is not valid JSON`)
    expect(failureText(parse)).toBe('SyntaxError')
    expect(failureText(Object.assign(new Error(`open ${KEY}`), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorKind(Object.assign(new Error('x'), { code: KEY, name: KEY }))).toBe('未知错误')
    expect(errorKind('不是错误对象')).toBe('未知错误')
  })
})
