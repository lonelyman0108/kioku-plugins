# Kioku 的命令行

[Kioku](https://github.com/lonelyman0108/kioku) 是自托管的长期记忆服务。这个包提供 `kioku` 命令，要 Node 18 或更新的版本：

```bash
npx @kioku-memory/cli doctor
# 或者装到全局
npm install -g @kioku-memory/cli
```

Claude Code 的 kioku 插件自带同一个命令，启用插件后在它的 Bash 工具里直接用 `kioku`，不用另装。

## 子命令

| 子命令 | 作用 |
|---|---|
| `kioku setup <平台>` | 把平台交给 Kioku 接管：停用平台自带的长期记忆；Codex、pi 再写下服务地址与访问密钥，Codex 还配好 MCP 服务 |
| `kioku login <平台>` | 用浏览器授权签发访问密钥并配好这个平台，不用手动复制 |
| `kioku doctor [平台]` | 检查地址、访问密钥与平台的配置 |
| `kioku run -e 变量=<标识>#<字段> -- <命令>` | 向 Kioku 取凭据的值，放进环境变量交给命令 |

每个子命令的完整说明：`kioku <子命令> --help`。现在认得的平台：`claude-code`、`codex`、`pi`。

## login

```bash
kioku login codex --server-url https://kioku.example.com
```

终端显示一个确认码并打开 Kioku 管理界面的确认页（`--no-browser` 时只显示地址）。登录后在页面上输入确认码，选空间、应用与权限范围，点确认；命令行取到访问密钥后接着做 `kioku setup` 的事：核对、写下配置。访问密钥全程不显示。认得 `codex`、`pi`；Claude Code 的访问密钥在它的 `/plugin` 里填。

- 确认码不在打开的地址里，要照着终端输入：只在自己刚运行了这条命令时确认。别人发来一个确认码让你去确认的，不要确认，那样对方的机器会拿到能读写你的记忆的访问密钥。
- 申请 10 分钟内有效。被拒绝、过期，或者确认之后确认人的角色变了，都拿不到访问密钥，重新运行即可。
- 不用在本机开端口，远程登录的机器上也能用：在任何一台登录了管理界面的浏览器里确认都行。
- 要 Kioku 服务端支持浏览器授权；旧的服务端会提示改用 `kioku setup` 手动填访问密钥。

`kioku setup codex`、`kioku setup pi` 在终端里提示输入访问密钥时直接回车，走的是同一个流程。

## setup

```bash
kioku setup claude-code --dry-run   # 只看要改什么
kioku setup claude-code             # 停用 Claude Code 的自动记忆
kioku setup claude-code --undo      # 改回去
```

只改平台的用户设置里和自带记忆有关的几项（Claude Code 是 `~/.claude/settings.json` 的 `autoMemoryEnabled`），设置里的其他内容不动。第一次改之前把原来的文件备份成同目录下的 `settings.json.kioku-backup`（已有备份时不覆盖），改完新开会话生效。本地已有的记忆文件不会被删掉。

- 设置文件是符号链接时改它指向的文件；文件会按 JSON 重新排版（缩进、换行符沿用原来的）。
- 只看用户设置：当前项目的 `.claude/settings.json`、`.claude/settings.local.json` 里又启用了的话会提醒，要在那里一起改；托管的设置查不到。

不停用的话，平台自带的记忆和 Kioku 会各记一份，两边的内容迟早对不上。

### Codex

```bash
kioku setup codex --server-url https://kioku.example.com
```

提示输入访问密钥（不回显；也可以放在 `KIOKU_API_KEY` 里或从标准输入给），核对后写下 `~/.config/kioku/codex.json`，在 `~/.codex/config.toml` 里加上 Kioku 的 MCP 服务并关掉 Memories，再列出在 Codex 这一边要做的三步。改了什么、怎么撤销见 [Codex 插件的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/codex#setup-改了什么)。

### pi

```bash
kioku setup pi --server-url https://kioku.example.com
```

核对后写下 `~/.config/kioku/pi.json`，不改 pi 的设置（pi 没有自带的长期记忆，MCP 服务由扩展注册）。扩展用 `pi install git:github.com/lonelyman0108/kioku-plugins` 装。

## doctor

```bash
kioku doctor claude-code
```

每项一行：`✓` 正常，`!` 要留意，`✗` 有问题（这时退出码为 1）。查的是：地址连不连得上、访问密钥是否有效、它属于哪个应用、能读写哪些归属、最高敏感级与凭据能力，以及平台这一边插件是否启用、自带的长期记忆是否已停用。不写平台时按当前所在的会话认。

## 地址与访问密钥

`kioku doctor codex`、`kioku doctor pi` 读 `kioku setup` 写下的文件。别的情况下 `doctor` 与 `run` 从环境变量读：

- `KIOKU_SERVER_URL`：例如 `https://kioku.example.com`，不带 `/v1`
- `KIOKU_API_KEY`：在 Kioku 管理界面的「应用」页签发的访问密钥；或者用 `KIOKU_API_KEY_FILE` 指向只含访问密钥的文件

在 Claude Code 里，插件在会话开始时已经配好这两项。`setup` 只改本机的设置文件，用不到它们。

`kioku run` 的用法与打码的限度见 [Claude Code 插件的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/claude-code#kioku-run)。
