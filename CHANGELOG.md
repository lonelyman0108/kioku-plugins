# 更新日志

## [未发布]

## [0.1.0] - 2026-11-12

第一个发到 npm 的版本：`@kioku-memory/cli`（`kioku` 命令）与 `@kioku-memory/openclaw`（OpenClaw 的记忆插件）。Claude Code、Codex、pi、Hermes、DeepSeek Harness 的插件按仓库安装，不经过发版。

### 新功能

- `kioku setup <平台>`：把平台交给 Kioku 接管。停用平台自带的长期记忆，写下服务地址与访问密钥；认得 `claude-code`、`codex`、`pi`、`hermes`、`openclaw`、`dsh`
- `kioku doctor [平台]`：检查地址、访问密钥的权限、插件装了没有、自带的记忆停了没有
- `kioku login <平台>`：浏览器授权。终端显示确认码，在管理界面确认后拿到访问密钥，不用手动复制
- `kioku import --from <来源>`：把 Claude Code、Hermes、OpenClaw 自带的本地记忆迁进 Kioku，先出计划、确认后才写，重复运行不重复写
- `kioku run`：把凭据经环境变量交给命令，命令的输出里出现凭据的值时打码；提示已到期的凭据
- OpenClaw 的记忆插件：占用记忆槽位，每一轮注入启动加载与召回候选，每轮结束后写会话摘要，并提供读写记忆的工具。只在本机入口的对话里生效
- Codex 插件、pi 扩展、Hermes 的记忆 provider、DeepSeek Harness 的插件：会话开始注入启动加载，每轮注入召回候选，每轮结束后写会话摘要，并接上读写记忆的工具

### 各系统

- macOS、Linux：各平台都实测过
- Windows：`kioku` 命令能起 npm 装的命令（`.cmd`）；五个平台在 Windows 上装插件、注入、上报都核对过，交互界面与 `kioku run` 的信号转发还没有核对
