# Kioku 的 Claude Code 插件

会话开始时注入 Kioku 的启动加载：通用的规则、人格、本应用的记忆与本人的偏好，以及同一会话最近的会话摘要、近期更新的记忆和与当前项目相关的召回。每轮输入时注入召回候选。每轮回复后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要：摘要归访问密钥所属的成员、私密，只给这个成员不带会话上下文的访问密钥，30 天后清除。另外提供 `kioku_*` MCP 工具读写记忆，以及 [`kioku run`](#kioku-run)：把凭据的值经环境变量交给要跑的命令，值不进对话记录，也不发给模型。

插件只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装插件。

## 安装

钩子和 `kioku` 命令用 Node.js 运行，需要 Node 18 或更新的版本在 `PATH` 里（`node -v` 能看到版本号）。用原生安装包装的 Claude Code 不带 Node，要另外安装。

```text
/plugin install kioku --marketplace lonelyman0108/kioku-plugins
```

较早的 Claude Code 分两步：先 `/plugin marketplace add lonelyman0108/kioku-plugins`，再 `/plugin install kioku@kioku`。

启用时填写两项配置，之后可以在 `/plugin` 里修改：

- **Kioku 服务地址**：例如 `https://kioku.example.com`，不带 `/v1`，末尾不要斜杠
- **访问密钥**：在管理界面的「应用」页为运行时是 claudecode 的应用签发。它存在系统的凭据存储里，不写进 `settings.json`

要让 agent 显式读取机密级记忆，签发访问密钥时把最高敏感级设为机密；召回和启动加载永远不含机密内容。要让 agent 用凭据（`kioku run`、`kioku_credential`），签发时把凭据能力选为「取用」，最高敏感级不低于私密。

会话摘要要求实例配好抽取模型，访问密钥能写会话摘要、最高敏感级不低于私密；不满足时每轮的内容不留在服务端。

## 停用自带的自动记忆

Claude Code 自带的自动记忆（auto memory）不停用的话，会和 Kioku 各记一份。插件改不了用户设置，要运行一次：

```bash
kioku setup claude-code
```

它把 `~/.claude/settings.json` 的 `autoMemoryEnabled` 设为 `false`，别的设置不动，第一次改之前把原来的文件备份成 `settings.json.kioku-backup`；`--dry-run` 只看要改什么，`--undo` 改回去。已有的记忆文件不会被删掉。新开会话生效。

自动记忆里已经记下的内容可以迁进 Kioku：`kioku import --from claude-code --dry-run` 先看每条会放到哪，去掉 `--dry-run` 再确认写入（本地的文件不动，重复运行不重复写）。

装好之后可以用 `kioku doctor` 检查：地址与访问密钥能不能用、访问密钥的权限、插件是否启用、自动记忆是否已停用。

## 更新

在 `/plugin` 里更新插件市场与插件，然后新开一个会话：`kioku` 命令和它用的地址、访问密钥都在会话开始时配好。服务地址与访问密钥沿用原来的配置，不用重新填写；原来的访问密钥没有凭据能力时，按上一节重新签发一个，在 `/plugin` 里换上。

## kioku run

插件启用期间，Claude Code 的 Bash 工具里可以直接用 `kioku` 命令（插件的 `bin/` 在 `PATH` 里）。`kioku run` 向 Kioku 取凭据的值，放进环境变量交给要跑的命令；命令行、对话记录与发给模型的内容里只有变量名：

```bash
kioku run -e PGPASSWORD=pg-main#password -- psql -h db.example.com -U app
kioku run -e TOKEN=github#token --purpose '查看 issue' -- sh -c 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/issues'
```

- `-e 变量=<标识>#<字段>` 可以写多个，一次请求取全部值；几个变量用同一个标识与字段时只取一次。任何一个取不到都不启动命令，Kioku 给的原因打到标准错误，退出码 2。`--purpose` 写这次取用的用途，记进凭据的访问记录，用途里有空格时要加引号。
- 命令不经过 shell 直接执行，标准输入照常交给它，退出码与它相同；命令被信号结束时，`kioku` 等输出写完，也以同一个信号结束，外层的 shell 据此停下（例如循环里按了 Ctrl-C）。SIGSEGV、SIGQUIT 这类会转储的信号除外：`kioku` 不发给自己，退出码为 128 + 信号编号。参数里要用到变量，或者要用管道、重定向时，写成 `sh -c '…'`、整段用单引号：写在外面的 `$变量` 会被 Bash 工具的 shell 提前展开成空值。
- 信号：有终端时（标准输入、输出或错误是终端），Ctrl-C 发给整个前台进程组，命令和 `kioku` 在同一个组里，已经收到了，`kioku` 不再转发 SIGINT，只等命令处理完；没有终端时（例如 Claude Code 的 Bash 工具），SIGINT 是单独发来的，和 SIGTERM、SIGHUP 一样转给命令。命令已经结束、输出还没写完时收到信号，`kioku` 先把输出写完再以这个信号结束；再收到一次就不等了（例如命令留下的后台进程一直占着输出）。已知的限制：在终端里单独对 `kioku` 发 SIGINT，不会转给命令；发给整个进程组的 SIGTERM、SIGHUP（没有终端时还有 SIGINT），命令会收到两次。
- 凭据已到期时照常取值、交给命令，标准错误里提示一句「凭据 … 已于 … 到期，值可能已失效」：命令失败时先想到值可能已经换过。
- 交给命令的环境里去掉了 `KIOKU_API_KEY` 与 `KIOKU_API_KEY_FILE`，免得命令把访问密钥或它的位置顺手打印出来。这不是隔离：访问密钥文件和 agent、命令属于同一个用户，它们照样读得到。
- Kioku 返回跳转时不跟着走（访问密钥只发给配置的地址），报错说明要把地址改成跳转之后的地址。
- 完整用法见 `kioku run --help`。

**打码的限度**：命令的标准输出与标准错误里原样出现的值换成 `***`，被拆在两块输出里的也换。这只防值顺手出现在输出里，不是安全边界：值被编码、拆开或改了大小写再打印，就认不出来。少于 4 个字符的值不打码（会误伤太多），标准错误里会提示是哪个变量。输出要经过打码，命令的标准输出与标准错误不再是终端，有的程序因此不显示颜色或进度；一块输出的结尾恰好像某个值的开头时，这一段等到下一块输出或命令结束才写出。

**地址与访问密钥从哪来**：会话开始时，插件的钩子把访问密钥写进插件数据目录里权限 600 的文件（每个会话一份，`api-key.<会话>`），再把服务地址和这个文件的位置（`KIOKU_SERVER_URL`、`KIOKU_API_KEY_FILE`）交给之后的 Bash 命令。访问密钥本身不放进环境变量，只是防 `env` 之类把它顺手打印出来；同一个用户的进程照样读得到这个文件。会话结束时删掉这个会话的文件，这个会话留在后台的命令从此取不到值：会话结束了，它启动的命令不该再拿得到凭据，这是有意的。没赶上删的（例如 Claude Code 被强行结束），在之后某个会话开始时，超过 30 天没用过就删掉（`kioku run` 每次读都会更新它的修改时间，会话恢复、压缩时钩子也会重写它）。

这一步靠 Claude Code 给 SessionStart 钩子的 `CLAUDE_ENV_FILE`。拿不到时，或者访问密钥文件读不到时，`kioku run` 改用 `KIOKU_API_KEY`；也没有就报缺少配置，这时自己设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`（例如写进 shell 的配置文件）。在 Claude Code 之外用也设这两个变量，命令在插件目录的 `bin/kioku`。

## 从 Lore 切换

先按 [从 Lore 迁移](../../docs/migrate-from-lore.md) 导入并做对照检查（在管理界面的「测试台」里按这个访问密钥模拟，不用真的接上客户端），再停用 Lore 的插件，避免两份启动加载同时注入。

## 排查

钩子失败时不会挡住输入，也不注入任何内容。原因写在标准错误里，用 `claude --debug` 启动可以看到以「Kioku」开头的那一行。服务地址或访问密钥没有配置、访问密钥格式不对、服务地址返回跳转时，会话开始会提示一次；钩子和 `kioku run` 一样不跟着跳转走。

`kioku run` 是 agent 主动执行的命令，失败时不静默：原因写在它的标准错误里。报缺少配置或者读不到访问密钥文件时，先新开一个会话；还不行，就在 `claude --debug` 的输出里找「Kioku kioku 命令的配置未写入」那一行，它写着缺的是什么（例如没有 `CLAUDE_ENV_FILE`）。

macOS 15 起，地址没错却报「无法连接 Kioku（EHOSTUNREACH）」时，多半是跑命令的 App（终端，或者 Claude Code 所在的终端、编辑器）没有「本地网络」权限，连不了局域网里的地址：在「系统设置 › 隐私与安全性 › 本地网络」里打开它，再重新运行。钩子遇到同样的问题时也一样，`claude --debug` 里能看到这个错误码。
