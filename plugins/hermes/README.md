# Kioku 的 Hermes 记忆提供方

把 Hermes 的长期记忆换成 Kioku：会话开始时把 Kioku 的启动加载放进系统提示（常驻记忆、近期会话摘要、当前项目相关记忆与使用指引），每轮输入前注入召回候选，每轮结束后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要。另外提供读写记忆与查询可用凭据标识的 `kioku_*` 工具。

记忆提供方只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装。它只用 Python 的标准库，没有要装的依赖。

## 只在本机的会话里生效

只在本机的入口里启用：命令行、终端界面、桌面、编辑器（Hermes 报的入口是 `cli`、`tui`、`gui`、`acp`、`desktop`）。**别的入口一律不注入、不上报、不给工具**，包括消息平台（Telegram、Slack 这类）、Hermes 的 API 服务器、定时任务，以及以后新出的、这里还不认得的入口：这些入口背后可能是群聊、别人的私聊或远程的调用方，而 Kioku 的工具不带会话上下文，按访问密钥的全部权限读写，放进去的话别人能借它读到不属于当前对话的记忆。子 agent、定时任务的会话里可以召回，不写会话摘要。

## 安装

要 Hermes 0.19 或更新的版本（更早的没有核对过）。

先在 Kioku 管理界面的「设置 → 连接与终端」为 hermes 签发访问密钥（或者用下面的浏览器授权，不用先建）。然后：

```bash
# 1. 写下服务地址与访问密钥，选 Kioku 做记忆提供方，关掉内置的 MEMORY.md 与 USER.md
npx @kioku-memory/cli setup hermes --server-url https://kioku.example.com

# 2. 装上记忆提供方
hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes --enable
```

第 1 步会提示输入访问密钥（不回显）；也可以放在 `KIOKU_API_KEY` 里，或者从标准输入给。提示时直接回车就改用浏览器授权（也可以直接运行 `npx @kioku-memory/cli login hermes --server-url <地址>`）：终端显示一个确认码，在管理界面的确认页输入它、选好环境、场域与权限后确认。它先连一次 Kioku 核对，再写；`--dry-run` 只看要改什么。

装好之后新开会话。用 `hermes memory status` 看记忆提供方是否可用，用 `npx @kioku-memory/cli doctor hermes` 检查地址与访问密钥、访问密钥的权限、记忆提供方装了没有、内置的记忆关了没有。

不想用 `kioku` 命令的话，`hermes memory setup` 里选 kioku 也能填这两项；内置的记忆要自己关：`hermes config set memory.memory_enabled false`、`hermes config set memory.user_profile_enabled false`。

## setup 改了什么

- `~/.hermes/.env`（跟着 `HERMES_HOME`）：加上 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY` 两行，别的行不动。这个文件里都是密钥，不留备份。
- Hermes 的配置（经 `hermes config set`，不直接改它的 YAML；改完读回来核对）：
  - `memory.provider` 设为 `kioku`
  - `memory.memory_enabled`、`memory.user_profile_enabled` 设为 `false`：不关的话内置的 `MEMORY.md`、`USER.md` 和 Kioku 各记一份。两个文件还在，只是不再读写。
- 找不到 `hermes` 命令、它失败了、或者改了没生效（托管的安装）时，照常写 `.env`，把这三条命令列出来供手动执行。
- `.env` 里同名的行写了几处时收拾成一处：Hermes 读的是最后一行，留着旧的那行会让换访问密钥不生效。

`kioku setup hermes --undo` 去掉那两行；现在选的记忆提供方还是 kioku 时把它改回内置的、两个开关打开（之前自己关过的要再关一次），已经换成别的记忆提供方的话不动它的配置。记忆提供方要另外 `hermes plugins remove kioku`。

内置记忆里已经记下的内容可以迁进 Kioku：`npx @kioku-memory/cli import --from hermes --platform hermes --dry-run` 先看每条会放到哪，去掉 `--dry-run` 再确认写入。

## 和别的平台的差别

- 工具不走 MCP 配置，由记忆提供方直接提供：名字和 Kioku 的 MCP 工具一样（`kioku_get`、`kioku_search`、`kioku_create` 等），清单在启动时向 Kioku 取一次，调用转给 Kioku。所以不用在 Hermes 里另配 MCP 服务，也不要配：配了的话消息网关的会话里也有这些工具。
- 工具清单只在 Hermes 加载记忆提供方时取一次（它那时就登记工具的归属）。那一刻 Kioku 连不上的话，这次运行里没有 `kioku_*` 工具，日志里有一行说明；启动加载、召回与上报不受影响。
- 每轮结束的上报放在后台、按顺序一条一条发，不拖住下一次输入；退出时等它们发完。
- 请求不走环境变量里的代理（`http_proxy` 这类）：访问密钥只发给配置的地址。Kioku 只能经代理访问的话，这个记忆提供方无法连接。
- 召回在每轮输入之后、请求模型之前同步取（最多等 4 秒，Hermes 另有自己的时限）；「好」「继续」这类没有内容的输入不召回。
- 启动加载在会话开始时取一次，放进系统提示；会话中途换了会话标识（`/resume`、`/new`）之后上报跟着新的标识走。
- 没有 `kioku run`。要在 Hermes 里用凭据，另外装 `npm install -g @kioku-memory/cli`，并设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`。

## 排查

记忆提供方出错时不挡输入，也不往对话里写错误，原因记在 Hermes 的日志里（`~/.hermes/logs/agent.log`，以「Kioku」开头），不带访问密钥。地址或访问密钥没配、格式不对时 `hermes memory status` 会显示不可用和原因。请求不跟着跳转走，访问密钥只发给配置的地址。

## 开发

```bash
cd plugins/hermes
uv run pytest          # Hermes 的基类用 tests/stubs 里的替身
uv run ruff check .
```

`kioku_bridge.py` 是不依赖 Hermes 的那一层（请求、会话状态），`__init__.py` 只把 Hermes 的回调接过去。
