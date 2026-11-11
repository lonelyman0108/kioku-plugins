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
| `kioku setup <平台>` | 停用平台自带的长期记忆，由 Kioku 接管 |
| `kioku doctor [平台]` | 检查地址、访问密钥与平台的配置 |
| `kioku run -e 变量=<标识>#<字段> -- <命令>` | 向 Kioku 取凭据的值，放进环境变量交给命令 |

每个子命令的完整说明：`kioku <子命令> --help`。现在认得的平台：`claude-code`。

## setup

```bash
kioku setup claude-code --dry-run   # 只看要改什么
kioku setup claude-code             # 停用 Claude Code 的自动记忆
kioku setup claude-code --undo      # 改回去
```

只改平台的用户设置里和自带记忆有关的几项（Claude Code 是 `~/.claude/settings.json` 的 `autoMemoryEnabled`），设置里的其他内容不动。改之前把原来的文件备份成同目录下的 `settings.json.kioku-backup`，改完新开会话生效。本地已有的记忆文件不会被删掉。

不停用的话，平台自带的记忆和 Kioku 会各记一份，两边的内容迟早对不上。

## doctor

```bash
kioku doctor claude-code
```

每项一行：`✓` 正常，`!` 要留意，`✗` 有问题（这时退出码为 1）。查的是：地址连不连得上、访问密钥是否有效、它属于哪个应用、能读写哪些归属、最高敏感级与凭据能力，以及平台这一边插件是否启用、自带的长期记忆是否已停用。不写平台时按当前所在的会话认。

## 地址与访问密钥

`doctor` 与 `run` 从环境变量读：

- `KIOKU_SERVER_URL`：例如 `https://kioku.example.com`，不带 `/v1`
- `KIOKU_API_KEY`：在 Kioku 管理界面的「应用」页签发的访问密钥；或者用 `KIOKU_API_KEY_FILE` 指向只含访问密钥的文件

在 Claude Code 里，插件在会话开始时已经配好这两项。`setup` 只改本机的设置文件，用不到它们。

`kioku run` 的用法与打码的限度见 [Claude Code 插件的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/claude-code#kioku-run)。
