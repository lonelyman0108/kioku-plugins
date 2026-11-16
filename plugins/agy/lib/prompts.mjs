// 向导的交互层：@clack/prompts。它只是 npm 上的 @kioku-memory/cli 的依赖：插件目录里的那几份 kioku
// 是复制进去的，带不了依赖，所以这里按需装载，装不到时返回 null，由调用方说明怎么装。别的子命令不经过这里

// @clack/prompts 要求的 Node 版本
const MIN_NODE = [20, 12]

export function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

// 交互库自带的英文换成中文：操作说明不显示（多选的写进问题里），是与否、取消与出错的文字改掉
export function localized(clack) {
  clack.updateSettings?.({ messages: { cancel: '已取消', error: '出错了' } })
  return {
    ...clack,
    select: (options) => clack.select({ showInstructions: false, ...options }),
    multiselect: (options) =>
      clack.multiselect({
        showInstructions: false,
        required: false,
        ...options,
        message: `${options.message}（空格选中，回车确认）`,
      }),
    confirm: (options) => clack.confirm({ active: '是', inactive: '否', ...options }),
  }
}

export async function loadPrompts() {
  if (!nodeSupported()) return null
  let clack
  try {
    clack = await import('@clack/prompts')
  } catch {
    return null
  }
  return localized(clack)
}
