# Kioku 的 OpenClaw 插件

占用 OpenClaw 的记忆槽位，用 Kioku 做长期记忆：每一轮把启动加载（通用的规则、人格、本应用的记忆与本人的偏好）放在系统提示前面，把召回候选放在这一轮输入前面；每轮结束后把输入与回复交给 Kioku，攒批后写成会话摘要；并提供读写记忆的 `kioku_*` 工具。

插件只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装。

## 只在本机入口生效

第一版只在 OpenClaw 自己的入口里生效：`openclaw agent`（本机运行或经网关）与过了网关鉴权的 HTTP 接口，这两种实测过；终端界面、控制界面走同一个内部通道，没有逐一实测。从 Telegram、Discord 这类外部渠道来的消息里不注入、不上报、不给工具，心跳、定时任务与子 agent 的运行也一样；认不出来的一律不生效。

原因：外部渠道里说话的不一定是应用所有者本人，而访问密钥读得到所有者的记忆。

占用槽位之后 OpenClaw 自带的记忆工具（`memory_search` 等）在所有会话里都停用，所以外部渠道来的会话里暂时没有长期记忆。主要在外部渠道里用 OpenClaw 的话，先不要装。

## 安装

要 OpenClaw 2026.6.35 或更新的版本（更早的没有核对过；核对过 2026.6.35 与 2026.11.3）。

先在 Kioku 管理界面的「应用」页建一个运行时是 OpenClaw 的应用，签发访问密钥。然后：

```bash
# 1. 写下服务地址与访问密钥，允许插件读对话
npx @kioku-memory/cli setup openclaw --server-url https://kioku.example.com

# 2. 装上插件（记忆槽位随之换成 kioku）
openclaw plugins install npm:@kioku-memory/openclaw

# 3. 重启网关
openclaw gateway restart
```

新一些的 OpenClaw（2026.11.3 上是这样）装第三方插件前要确认它声明的能力：第 2 步提示 `requires capability consent` 时，看过插件要用的能力（记忆槽位、每轮的输入与回复、工具）之后加上 `--accept-capabilities` 再运行一次。

第 1 步会提示输入访问密钥（不回显）；也可以放在 `KIOKU_API_KEY` 里，或者从标准输入给。提示时直接回车就改用浏览器授权（也可以直接运行 `npx @kioku-memory/cli login openclaw --server-url <地址>`）：终端显示一个确认码，在管理界面的确认页输入它、选好空间与权限后确认。

用 `npx @kioku-memory/cli doctor openclaw` 检查：地址与访问密钥、访问密钥的权限、插件装了没有、记忆槽位选的是不是 kioku、允不允许插件读对话。

换访问密钥或地址时重新运行第 1 步；开着的网关一分钟之内认到新的，不用重启。更新插件用 `openclaw plugins update kioku`。

## setup 改了什么

- `~/.config/kioku/openclaw.json`（权限 600，位置可以用 `KIOKU_CONFIG_DIR` 改）：服务地址与访问密钥。不放进 OpenClaw 的配置，访问密钥也不出现在命令的参数里。旁边的 `openclaw-tools.json` 是工具清单的一份副本，插件登记工具时先用它，每小时向 Kioku 重新取一次。
- 经 `openclaw config set` 改 OpenClaw 的两项，改完读回来核对：
  - `plugins.entries.kioku.hooks.allowConversationAccess` 设为 `true`：第三方插件默认拿不到每轮的输入与回复，召回与会话摘要都要它。
  - `plugins.slots.memory` 设为 `kioku`：装插件时 OpenClaw 自己会选上，`setup` 只在它被换走之后选回来。

`--dry-run` 只看要改什么，`--no-check` 不连 Kioku 核对。`--undo` 删掉那两个文件、去掉允许读对话的那一项，记忆槽位选的还是 kioku 时改回 `memory-core`；插件用 `openclaw plugins uninstall kioku` 卸载。

没有 `openclaw` 命令，或者它的配置没改成时，地址与访问密钥照样写下，并列出要自己运行的命令。插件的状态没查出来（`openclaw plugins inspect` 失败）时不当成没装，会说明没查出来。

## 工作区里的记忆文件

OpenClaw 把工作区的 `MEMORY.md`（有内容时）和 `USER.md` 直接放进提示，这不归记忆槽位管，换了槽位照样在。要让长期记忆只在 Kioku 里：

```bash
npx @kioku-memory/cli import --from openclaw --platform openclaw --dry-run
```

看过计划后去掉 `--dry-run` 写入，再自己清空 `MEMORY.md`。`memory/` 里按日期的笔记不会自动进提示，迁不迁都行。工作区不在默认位置（`~/.openclaw/workspace`）时用 `--path` 指明。

## 和别的平台的差别

- 启动加载不存进会话：OpenClaw 每一轮重建系统提示，插件按会话记着取到的启动加载、每一轮都放进去，每小时重新取一次。网关重启后第一轮会再取。
- 工具由插件登记成 OpenClaw 自己的工具，调用转给 Kioku 的 MCP 端点，不用另配 MCP 服务。名字要在插件的清单里声明，服务端新加的工具要等插件更新才有。
- 工具只在用户从本机入口发起的那一轮里调得动：同一个会话接着跑心跳这类运行时，模型看得到工具，调用会被拒绝。
- 上报的是这一轮的输入（含运行中排进来的）与助手正常说完的文字；思考、工具调用、出错或被中止的那一段不上报，没成功的一轮不上报。
- 没有 `kioku run`。要用凭据，另外装 `npm install -g @kioku-memory/cli`，并设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`。

## 排查

插件出错时不挡这一轮，也不往对话里写错误，原因写在网关的日志里（以「Kioku」开头，同一个原因只写一次）。还没配置、配置读不懂、服务地址返回跳转时，日志里会说怎么改；插件不跟着跳转走，访问密钥只发给配置的地址。取启动加载或召回失败之后一分钟内，输入前不再向 Kioku 发请求，免得服务端挂住时每一轮都等满时限。

`openclaw plugins inspect kioku` 能看到插件的状态、登记的钩子与工具。装好之后没有生效，多半是网关没有重启。
