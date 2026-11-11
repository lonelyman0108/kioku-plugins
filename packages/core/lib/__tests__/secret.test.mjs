import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { readSecret } from '../secret.mjs'

describe('读访问密钥', () => {
  it('先看 KIOKU_API_KEY，不读标准输入', async () => {
    const stdin = Readable.from(['来自标准输入'])
    expect(await readSecret({ env: { KIOKU_API_KEY: ' kioku_a ' }, stdin })).toBe('kioku_a')
  })

  it('标准输入不是终端时读它的全部内容，去掉首尾空白', async () => {
    const stdin = Readable.from([Buffer.from('kioku_'), Buffer.from('b\n')])
    expect(await readSecret({ env: {}, stdin })).toBe('kioku_b')
    expect(await readSecret({ env: {}, stdin: Readable.from([]) })).toBe('')
  })
})
