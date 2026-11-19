import { hostname } from 'node:os'

import { describe, expect, it } from 'vitest'

import { deviceKeyOf } from '../lifecycle.mjs'

describe('deviceKeyOf', () => {
  it('优先读取 KIOKU_DEVICE_KEY，去掉控制字符并截断到 128 个字符', () => {
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: '  work\u0000-mac\n\t  ' })).toBe('work-mac')
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: 'a'.repeat(150) })).toHaveLength(128)
  })

  it('未设置或只有空白与控制字符时退回本机主机名', () => {
    const expected = hostname().trim().slice(0, 128) || undefined
    expect(deviceKeyOf({})).toBe(expected)
    expect(deviceKeyOf({ KIOKU_DEVICE_KEY: ' \u0007\n ' })).toBe(expected)
  })
})
