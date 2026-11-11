// OpenClaw 装载的入口。OpenClaw 会重复装载插件（每次运行、每次重建注册表），状态挂在进程上只建一次：
// 按会话记着的启动加载、取到的工具清单才不会每一轮都重来

import { createKioku } from './kioku.js'

const STATE = Symbol.for('kioku.openclaw')
const kioku = (globalThis[STATE] ??= createKioku())

export default {
  id: 'kioku',
  name: 'Kioku',
  description: 'Kioku 长期记忆：启动加载、每轮召回、会话摘要与记忆工具',
  kind: 'memory',
  register(api) {
    kioku.register(api)
  },
}
