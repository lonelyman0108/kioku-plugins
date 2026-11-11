import { describe, expect, it } from 'vitest'

import { sync } from '../../../../scripts/sync-core.mjs'

describe('插件目录里的副本', () => {
  it('和核心一致', () => {
    expect(sync({ write: false })).toEqual([])
  })
})
