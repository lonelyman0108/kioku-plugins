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

## 更新

在 `/plugin` 里更新插件市场与插件，然后新开一个会话：`kioku` 命令和它用的地址、访问密钥都在会话开始时配好。服务地址与访问密钥沿用原来的配置，不用重新填写；原来的访问密钥没有凭据能力时，按上一节重新签发一个，在 `/plugin` 里换上。

## kioku run

插件启用期间，Claude Code 的 Bash 工具里可以直接用 `kioku` 命令（插件的 `bin/` 在 `PATH` 里）。`kioku run` 向 Kioku 取凭据的值，放进环境变量交给要跑的命令；命令行、对话记录与发给模型的内容里只有变量名：

```bash
kioku run -e PGPASSWORD=pg-main#password -- psql -h db.example.com -U app
kioku run -e TOKEN=github#token --purpose 查看 issue -- sh -c 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/issues'
```

- `-e 变量=<标识>#<字段>` 可以写多个，一次请求取全部值。任何一个取不到都不启动命令，Kioku 给的原因打到标准错误，退出码 2。`--purpose` 写这次取用的用途，记进凭据的访问记录。
- 命令不经过 shell 直接执行，标准输入照常交给它，退出码与它相同（被信号结束时为 128 + 信号编号）。参数里要用到变量，或者要用管道、重定向时，写成 `sh -c '…'`、整段用单引号：写在外面的 `$变量` 会被 Bash 工具的 shell 提前展开成空值。
- 交给命令的环境里去掉了 `KIOKU_API_KEY` 与 `KIOKU_API_KEY_FILE`，命令用不到访问密钥。
- 完整用法见 `kioku run --help`。

**打码的限度**：命令的标准输出与标准错误里原样出现的值换成 `***`，被拆在两块输出里的也换。这只防值顺手出现在输出里，不是安全边界：值被编码、拆开或改了大小写再打印，就认不出来。少于 4 个字符的值不打码（会误伤太多），标准错误里会提示是哪个变量。输出要经过打码，命令的标准输出与标准错误不再是终端，有的程序因此不显示颜色或进度；一块输出的结尾恰好像某个值的开头时，这一段等到下一块输出或命令结束才写出。

**地址与访问密钥从哪来**：会话开始时，插件的钩子把访问密钥写进插件数据目录里权限 600 的文件，再把服务地址和这个文件的位置（`KIOKU_SERVER_URL`、`KIOKU_API_KEY_FILE`）交给之后的 Bash 命令。访问密钥本身不放进环境变量，`env` 打印出来也带不出它。这一步靠 Claude Code 给 SessionStart 钩子的 `CLAUDE_ENV_FILE`；拿不到时 `kioku run` 报缺少配置，这时自己设置 `KIOKU_SERVER_URL` 与 `KIOKU_API_KEY`（例如写进 shell 的配置文件）。在 Claude Code 之外用也设这两个变量，命令在插件目录的 `bin/kioku`。

## 从 Lore 切换

先按 [从 Lore 迁移](../../docs/migrate-from-lore.md) 导入并做对照检查（在管理界面的「测试台」里按这个访问密钥模拟，不用真的接上客户端），再停用 Lore 的插件，避免两份启动加载同时注入。

## 排查

钩子失败时不会挡住输入，也不注入任何内容。原因写在标准错误里，用 `claude --debug` 启动可以看到以「Kioku」开头的那一行。服务地址或访问密钥没有配置时，会话开始会提示一次。

`kioku run` 是 agent 主动执行的命令，失败时不静默：原因写在它的标准错误里。报缺少配置时先新开一个会话；还不行，就在 `claude --debug` 的输出里找「Kioku kioku 命令的配置未写入」那一行。
