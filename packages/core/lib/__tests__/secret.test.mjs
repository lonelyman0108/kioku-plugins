import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { applyKeys, readSecret } from '../secret.mjs'

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

  it('终端里的按键：回车结束，退格删一个字，Ctrl-U 清空，方向键与粘贴标记不算输入', () => {
    expect(applyKeys('', 'kioku_a\r')).toEqual({ value: 'kioku_a', done: 'enter' })
    expect(applyKeys('ab', '\u007fc')).toEqual({ value: 'ac', done: null })
    expect(applyKeys('a😀', '\b')).toEqual({ value: 'a', done: null })
    expect(applyKeys('错的', '\u0015kioku_b')).toEqual({ value: 'kioku_b', done: null })
    expect(applyKeys('', '\u001b[200~kioku_c\u001b[201~\u001b[A\u001bOP\t\u0001')).toEqual({
      value: 'kioku_c',
      done: null,
    })
    expect(applyKeys('半截', '\u0003')).toEqual({ value: '', done: 'cancel' })
    expect(applyKeys('半截', '\u0004')).toEqual({ value: '', done: 'cancel' })
  })

  // 假的终端：记下原始模式开关，按块发数据
  function fakeTerminal() {
    const stdin = new EventEmitter()
    Object.assign(stdin, {
      isTTY: true,
      raw: [],
      setRawMode: (on) => stdin.raw.push(on),
      resume: () => {},
      pause: () => {},
    })
    return stdin
  }
  const out = { write: () => {} }

  it('在终端里读：被切在两块里的字照样拼上，结束后改回原来的模式', async () => {
    const stdin = fakeTerminal()
    const reading = readSecret({ env: {}, stdin, out })
    const bytes = Buffer.from('kioku_字\r')
    stdin.emit('data', bytes.subarray(0, 7))
    stdin.emit('data', bytes.subarray(7))
    expect(await reading).toBe('kioku_字')
    expect(stdin.raw).toEqual([true, false])
    expect(stdin.listenerCount('data')).toBe(0)
  })

  it('取消、终端挂断、读取出错都报错，并改回原来的模式', async () => {
    for (const [emit, message] of [
      [(s) => s.emit('data', Buffer.from('ab\u0003')), '已取消'],
      [(s) => s.emit('end'), '输入中断了'],
      [(s) => s.emit('error', new Error('x')), '无法从终端读取'],
    ]) {
      const stdin = fakeTerminal()
      const reading = readSecret({ env: {}, stdin, out })
      emit(stdin)
      await expect(reading).rejects.toThrow(message)
      expect(stdin.raw).toEqual([true, false])
    }
  })
})
