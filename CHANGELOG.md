# 更新日志

## [未发布]

## [0.2.0] - 2026-11-12

### 新功能

- **`kioku` 向导**：在终端里不带参数运行 `kioku`，先看到服务器与本机每个平台的状态（装没装、接没接、访问密钥是否有效、插件、自带记忆、本地还有多少条没迁），再按缺什么选动作：接入、重新授权、迁移本地记忆、停用平台、检查、本机起一个 Kioku。每个动作先列计划，确认后才做。要 Node 20.12 以上
- **一次接入几个平台**：几个平台一起申请，浏览器里只确认一次（要 Kioku 0.2.0 以上；旧的服务端自动退回逐个确认）
- **本机起一个 Kioku**：从最新正式版下载 `compose.yaml`、生成 `.env`（密码与主密钥随机生成）、启动并等就绪，显示初始化码、打开初始化页，建好管理员后接着接入平台
- **`kioku install --platforms … [-y]`**：给脚本用，访问密钥从 `KIOKU_API_KEY_<平台>` 读，没给的平台跳过并列出
- 向导与 `install` 不替你装插件，做完列出可以直接复制的安装命令

### 问题修复

- AstrBot 插件带的 Kioku 客户端同步到最新（whoami 的空间名与显示名）

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
