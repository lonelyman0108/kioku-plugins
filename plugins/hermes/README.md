# Kioku 的 Hermes 记忆 provider

把 Hermes 的长期记忆换成 Kioku：会话开始时把 Kioku 的启动加载放进系统提示（通用的规则、人格、本应用的记忆与本人的偏好），每轮输入前注入召回候选，每轮结束后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要。另外提供读写记忆的 `kioku_*` 工具。

provider 只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装。它只用 Python 的标准库，没有要装的依赖。

## 只在本机的会话里生效

命令行、桌面、编辑器这类本机的会话里启用。**消息网关来的会话（Telegram、Slack 这类）里不注入、不上报、不给工具**：这些会话可能是群聊或别人的私聊，而 Kioku 的工具不带会话上下文，按访问密钥的全部权限读写，放进去的话别人能借它读到你的记忆。子 agent、定时任务的会话里可以召回，不写会话摘要。

## 安装

要 Hermes 0.19 或更新的版本（更早的没有核对过）。

先在 Kioku 管理界面的「应用」页建一个运行时是 hermes 的应用，签发访问密钥（或者用下面的浏览器授权，不用先建）。然后：

```bash
# 1. 写下服务地址与访问密钥，选 Kioku 做记忆 provider，关掉内置的 MEMORY.md 与 USER.md
npx @kioku-memory/cli setup hermes --server-url https://kioku.example.com

# 2. 装上 provider
hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes --enable
```

第 1 步会提示输入访问密钥（不回显）；也可以放在 `KIOKU_API_KEY` 里，或者从标准输入给。提示时直接回车就改用浏览器授权（也可以直接运行 `npx @kioku-memory/cli login hermes --server-url <地址>`）：终端显示一个确认码，在管理界面的确认页输入它、选好空间与权限后确认。它先连一次 Kioku 核对，再写；`--dry-run` 只看要改什么。

装好之后新开会话。用 `hermes memory status` 看 provider 是否可用，用 `npx @kioku-memory/cli doctor hermes` 检查地址与访问密钥、访问密钥的权限、provider 装了没有、内置的记忆关了没有。

不想用 `kioku` 命令的话，`hermes memory setup` 里选 kioku 也能填这两项；内置的记忆要自己关：`hermes config set memory.memory_enabled false`、`hermes config set memory.user_profile_enabled false`。

## setup 改了什么

- `~/.hermes/.env`（跟着 `HERMES_HOME`）：加上 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY` 两行，别的行不动。这个文件里都是密钥，不留备份。
- Hermes 的配置（经 `hermes config set`，不直接改它的 YAML）：
  - `memory.provider` 设为 `kioku`
  - `memory.memory_enabled`、`memory.user_profile_enabled` 设为 `false`：不关的话内置的 `MEMORY.md`、`USER.md` 和 Kioku 各记一份。两个文件还在，只是不再读写。
- 找不到 `hermes` 命令时照常写 `.env`，把这三条命令列出来由你运行。

`kioku setup hermes --undo` 去掉那两行、改回内置的记忆；provider 要另外 `hermes plugins remove kioku`。

内置记忆里已经记下的内容可以迁进 Kioku：`npx @kioku-memory/cli import --from hermes --platform hermes --dry-run` 先看每条会放到哪，去掉 `--dry-run` 再确认写入。

## 和别的平台的差别

- 工具不走 MCP 配置，由 provider 直接提供：名字和 Kioku 的 MCP 工具一样（`kioku_get`、`kioku_search`、`kioku_create` 等），清单在启动时向 Kioku 取一次，调用转给 Kioku。所以不用在 Hermes 里另配 MCP 服务，也不要配：配了的话消息网关的会话里也有这些工具。
- 召回在每轮输入之后、请求模型之前同步取（最多等 4 秒，Hermes 另有自己的时限）；「好」「继续」这类没有内容的输入不召回。
- 启动加载在会话开始时取一次，放进系统提示；会话中途换了会话标识（`/resume`、`/new`）之后上报跟着新的标识走。
- 没有 `kioku run`。要在 Hermes 里用凭据，另外装 `npm install -g @kioku-memory/cli`，并设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`。

## 排查

provider 出错时不挡输入，也不往对话里写错误，原因记在 Hermes 的日志里（`~/.hermes/logs/agent.log`，以「Kioku」开头），不带访问密钥。地址或访问密钥没配、格式不对时 `hermes memory status` 会显示不可用和原因。provider 不跟着跳转走，访问密钥只发给配置的地址。

## 开发

```bash
cd plugins/hermes
uv run pytest          # Hermes 的基类用 tests/stubs 里的替身
uv run ruff check .
```

`kioku_bridge.py` 是不依赖 Hermes 的那一层（请求、会话状态），`__init__.py` 只把 Hermes 的回调接过去。
