# Kioku 的 Codex 插件

会话开始时注入 Kioku 的启动加载：通用的规则、人格、本应用的记忆与本人的偏好，以及同一会话最近的会话摘要、近期更新的记忆和与当前项目相关的召回。每轮输入时注入召回候选。每轮回复后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要。读写记忆的 `kioku_*` MCP 工具由 `kioku setup codex` 配进 Codex。

插件只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装插件。

## 安装

要 Node 18 或更新的版本在 `PATH` 里，Codex 命令行 0.167 或更新（更早的版本没有核对过）。

先在 Kioku 管理界面的「应用」页建一个运行时是 codex 的应用，签发访问密钥。然后：

```bash
# 1. 写下服务地址与访问密钥，把 Kioku 的 MCP 服务配进 Codex，关掉 Codex 自带的 Memories
npx @kioku-memory/cli setup codex --server-url https://kioku.example.com

# 2. 把本仓库加为插件市场，装上插件
codex plugin marketplace add lonelyman0108/kioku-plugins
codex plugin add kioku@kioku
```

3. 打开 `codex`，在 `/hooks` 里信任 kioku 的三个钩子。Codex 不运行没有信任过的钩子；插件更新后钩子变了要再信任一次。

第 1 步会提示输入访问密钥（不回显）；也可以放在 `KIOKU_API_KEY` 里，或者从标准输入给。访问密钥不写在命令行上。它先连一次 Kioku 核对地址与访问密钥，再写文件；`--dry-run` 只看要改什么，`--no-check` 不核对。

装好之后用 `npx @kioku-memory/cli doctor codex` 检查：地址与访问密钥、访问密钥的权限、MCP 服务、插件是否启用、Memories 是否关着。钩子信任过没有它查不到。

## setup 改了什么

- `~/.config/kioku/codex.json`（权限 600，目录 700）：服务地址与访问密钥，钩子读它。Codex 的插件没有自己的配置项，所以放在这里；位置可以用 `KIOKU_CONFIG_DIR` 改。
- `~/.codex/config.toml`（跟着 `CODEX_HOME`）：
  - 加上 `[mcp_servers.kioku]` 与它的请求头。这个服务整个归 `kioku setup` 管：原来有手写的同名服务时换成它的写法，改动里会写出原来的地址。访问密钥以明文写在这个文件里，和 Codex 里别的带请求头的 MCP 服务一样。
  - `[features]` 里的 `memories = true` 改成 `false`。Codex 自带的 Memories 默认就是关的，开着时会和 Kioku 各记一份。
  - 别的内容不动。第一次改之前把原来的文件备份成 `config.toml.kioku-backup`。

`kioku setup codex --undo` 去掉 MCP 服务那一段、删掉 `codex.json`；Memories 不会重新打开，插件要另外 `codex plugin remove kioku@kioku`。

换访问密钥或地址时重新运行第 1 步。

## 和 Claude Code 插件的差别

- Codex 的 Stop 钩子只给助手最后的回复，不给用户的输入：输入在提交时记在插件的数据目录里（权限 600），这一轮结束时取走并删掉；没等到结束的（会话被强行结束）一天后在会话开始时删掉。
- 启动加载比 Codex 默认放进上下文的长度（约 2,500 token）长，超过的会被存成文件、只给模型看头尾。插件在钩子上把这个上限调到了 12,000 token（`additionalContextLimit`），对应服务端给 Codex 的 9,500 字上限。
- 没有 `kioku run`：Codex 不会把插件的命令加进 `PATH`。要在 Codex 里用凭据，另外装 `npm install -g @kioku-memory/cli`，并设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`。

## 排查

钩子失败时不会挡住输入，也不注入任何内容，原因写在标准错误里（以「Kioku」开头）。没有配置、配置读不懂、访问密钥格式不对、服务地址返回跳转时，会话开始会提示一次怎么改；钩子不跟着跳转走，访问密钥只发给配置的地址。

钩子没有运行时，先看 `/hooks` 里是不是还没信任；再用 `kioku doctor codex` 看别的配置。
