# Kioku 的 DeepSeek Harness 插件

会话开始后的第一次输入注入 Kioku 的启动加载：通用的规则、人格、本应用的记忆与本人的偏好，以及同一会话最近的会话摘要、近期更新的记忆和与当前项目相关的召回。每次输入注入召回候选。每轮结束后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要。同一个补丁还挂上一个连 Kioku 的 MCP 客户端，提供读写记忆的工具（`mcp__kioku__kioku_get` 这类名字）。

插件只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装。

## 安装

要 DeepSeek Harness（`dsh`）0.2.2 或更新的版本（更早的没有核对过；它还在预览阶段，接口可能变）。Kioku 服务端要有 `dsh` 这个运行时。

先在 Kioku 管理界面的「应用」页建一个运行时是 dsh 的应用，签发访问密钥。然后：

```bash
# 1. 写下服务地址与访问密钥
npx @kioku-memory/cli setup dsh --server-url https://kioku.example.com

# 2. 给要用的 profile 装上插件（web、tui 这些各装一次）
dsh plugin --profile web add github:lonelyman0108/kioku-plugins
```

第 1 步会提示输入访问密钥（不回显）；也可以放在 `KIOKU_API_KEY` 里，或者从标准输入给。提示时直接回车就改用浏览器授权（也可以直接运行 `npx @kioku-memory/cli login dsh --server-url <地址>`）。它先连一次 Kioku 核对，再把地址与访问密钥写进 `~/.config/kioku/dsh.json`（权限 600，位置可以用 `KIOKU_CONFIG_DIR` 改）。`--dry-run` 只看要改什么，`--no-check` 不核对，`--undo` 删掉这个文件。

装好之后重启 dsh。用 `npx @kioku-memory/cli doctor dsh` 检查：地址与访问密钥、访问密钥的权限、哪些 profile 装了插件。

换访问密钥或地址时重新运行第 1 步：注入与上报一分钟之内认到新的，读写记忆的工具要重启 dsh 才换。卸载用 `dsh plugin --profile <profile> remove kioku-plugins`。

## 和别的平台的差别

- dsh 没有自带的长期记忆，`setup` 不改它的任何设置；`AGENTS.md` 这类指令文件照常使用。
- 插件按 profile 装：没装的 profile 里没有长期记忆。
- 地址与访问密钥不写进 profile：补丁里的 MCP 客户端在启动时从 `dsh.json` 读，没有这个文件时这一行不启用。
- 注入的内容作为来源是 `kioku` 的消息存进会话，随会话一起保留。接着之前的会话时不重复注入启动加载；清空、压缩之后的下一次输入会再注入一次。
- 上报的是这一轮里用户说的（含运行中排进来的）与助手说的文字；工具调用与结果不上报。
- 子 agent 的会话不注入、不上报（用户自己分出来的会话照常）；工具在同一个 profile 的所有 agent 里都有。
- 没有 `kioku run`。要用凭据，另外装 `npm install -g @kioku-memory/cli`，并设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`。

## 排查

插件出错时不挡输入，也不往对话里写错误，原因写在 dsh 的日志里（以「Kioku」开头，同一个原因只写一次）。取启动加载或召回失败之后一分钟内，输入前不再向 Kioku 发请求，上报失败之后一分钟内也不再上报，免得服务端挂住时每次都等满时限。用户中途打断的一轮，已经说出来的照样上报。插件不跟着跳转走，访问密钥只发给配置的地址。

`dsh --profile <profile> --dump-config` 能看到组合出来的配置：有 `kioku` 与 `kioku-mcp` 两行就是装上了。
