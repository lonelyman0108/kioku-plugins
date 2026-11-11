# Kioku 的 pi 扩展

会话开始后的第一次输入前注入 Kioku 的启动加载：通用的规则、人格、本应用的记忆与本人的偏好，以及同一会话最近的会话摘要、近期更新的记忆和与当前项目相关的召回。每次输入前注入召回候选。每轮结束后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要。扩展还注册 Kioku 的 MCP 服务，提供读写记忆的 `kioku_*` 工具。

扩展只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装。

## 安装

要 pi 1.5 或更新的版本（更早的没有核对过；包名已经从 `@mariozechner/pi-coding-agent` 换成 `@earendil-works/pi-coding-agent`）。

先在 Kioku 管理界面的「应用」页建一个运行时是 pi 的应用，签发访问密钥。然后：

```bash
# 1. 写下服务地址与访问密钥
npx @kioku-memory/cli setup pi --server-url https://kioku.example.com

# 2. 装上扩展
pi install git:github.com/lonelyman0108/kioku-plugins
```

第 1 步会提示输入访问密钥（不回显）；也可以放在 `KIOKU_API_KEY` 里，或者从标准输入给。提示时直接回车就改用浏览器授权（也可以直接运行 `npx @kioku-memory/cli login pi --server-url <地址>`）：终端显示一个确认码，在管理界面的确认页输入它、选好空间与权限后确认，不用先在管理界面建应用、复制访问密钥。它先连一次 Kioku 核对，再把地址与访问密钥写进 `~/.config/kioku/pi.json`（权限 600，位置可以用 `KIOKU_CONFIG_DIR` 改）。`--dry-run` 只看要改什么，`--no-check` 不核对，`--undo` 删掉这个文件。

装好之后新开会话，或者在 pi 里 `/reload`。用 `npx @kioku-memory/cli doctor pi` 检查：地址与访问密钥、访问密钥的权限、扩展装了没有、`mcp.json` 里有没有同名的服务。

换访问密钥或地址时重新运行第 1 步，再 `/reload`。更新扩展用 `pi update --extensions`。

## 和别的平台的差别

- pi 没有自带的长期记忆，`setup` 不改 pi 的任何设置；`AGENTS.md` 这类指令文件照常使用。
- MCP 服务由扩展在加载时注册（名字是 `kioku`），不写进 `mcp.json`。`mcp.json` 里有同名的服务时以它为准，`doctor` 会提醒。
- 注入的内容作为一条不显示的消息存进会话（类型 `kioku`），随会话一起保留；压缩之后的下一次输入会再注入一次启动加载。
- 一次输入可能跑好几段（重试、压缩后重试、排队的消息），上报的回复是这几段里助手说的文字，在 pi 不再接着跑时发一次；思考与工具调用不上报。
- 没有 `kioku run`。要在 pi 里用凭据，另外装 `npm install -g @kioku-memory/cli`，并设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`。

## 排查

扩展出错时不挡输入，也不往对话里写错误，原因写在标准错误里（以「Kioku」开头）。还没配置、配置读不懂、访问密钥格式不对、服务地址返回跳转时，会话开始会提示一次怎么改（没有界面的模式下写到标准错误）；扩展不跟着跳转走，访问密钥只发给配置的地址。

`/mcp` 里能看到 `kioku` 这个服务和它的连接状态。
