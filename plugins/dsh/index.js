// DeepSeek Harness 装载的入口：把三个扩展点接到 kioku.js 上

import { createKioku } from './kioku.js'

export const name = 'kioku'

export function apply(ctx) {
  const kioku = createKioku({ warn: (text) => ctx.logger?.warn?.(text) })
  ctx.on('agent/created', (payload) => kioku.created(payload))
  ctx.on('agent/pre-step', (payload, next) => kioku.preStep(payload, next))
  ctx.on('agent/turn-stopping', (payload) => kioku.turnStopping(payload))
}
