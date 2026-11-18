# 更新日志

## [未发布]

## [0.4.1] - 2026-11-18

### 问题修复

- 补齐 `@kioku-memory/plugin-opencode` 清单中的 `repository` 字段，修复 npm 受信发布（Sigstore 来源证明）校验失败的问题

## [0.4.0] - 2026-11-18

`@kioku-memory/cli` 重构为零外部运行依赖的单文件包，带来全新的终端地层界面（Strata UI）、插件自动安装与日常记忆读写子命令（要求 Node 22.12 以上）。

### 新功能

- **地层风格终端界面与交互控制台**：全面采用 Kioku 地层视觉语言（细线直角卡片、归属色彩配文字标签、纯字符敏感级纹理、非全屏原地局部重绘，兼容 `NO_COLOR` / `FORCE_COLOR`）；默认控制台自动折叠本机未安装的客户端；浏览器授权等待框新增确认码自动复制、10 分钟倒计时及 `[o]` 打开浏览器 / `[c]` 复制链接 / `[Esc]` 取消快捷键
- **一站式接入管理与插件自动安装**：新增 `kioku connect`、`kioku status [--json]`、`kioku disconnect`、`kioku upgrade`、`kioku open`、`kioku local [up|down|status|logs]`，以及 `kioku doctor --all / --json`；接入完成后自动尝试安装或更新对应客户端插件（Antigravity 目录带托管标记安全管理），并执行 `whoami` 与 MCP 工具清单连通性握手验证
- **Claude Code 统一授权支持**：`kioku connect claude-code`、`kioku login claude-code` 与 `kioku setup claude-code` 现支持浏览器授权并写入 `~/.config/kioku/claude-code.json`；当 `/plugin` 选项留空时，插件钩子与 MCP 包装脚本自动回退读取该配置
- **零配置日常记忆读写命令**：新增 `kioku search`（检索并在交互终端回车展开正文）、`kioku get`（按坐标读取完整属性与多行正文）、`kioku ls`（按本人、应用、人格、通用地层顺序或前缀浏览目录）与 `kioku add`（支持参数、标准输入管道与编辑器写入，遇疑似明文凭据拦阻时不回显原值并支持确认或 `--plaintext-ok` 放行）；支持自动识别本机客户端身份并记住默认选择；`kioku import` 新增 `-y` 与 `--select` 交互勾选子集

## [0.3.0] - 2026-11-17

本版起 `@kioku-memory/plugin-opencode` 一并随 `kioku` 命令行与 OpenClaw 插件发到 npm。

### 新功能

- **新增 OpenCode、Gemini CLI 与 Antigravity 支持**：`kioku` 向导、`kioku login`、`kioku setup` 与 `kioku doctor` 现已覆盖 `opencode`、`gemini` 与 `agy`；三个插件均支持会话启动加载、每轮召回、对话结束写会话摘要并接上 Kioku MCP 记忆工具
- **新增 `kioku clean` 与冲突记忆工具检测**：支持检测并安全卸载 9 个平台上的 Lore 及常见记忆 MCP（Mem0、Supermemory、MCP Memory、Cipher、Claude-Mem）；`setup`、`login`、`install`、`doctor` 与向导会在接入前提示冲突，可通过 `--remove-conflicts` 或向导确认后先清理再接入

### 同步

- AstrBot 插件自带的 Kioku Python 客户端同步到最新（补齐明文检测敏感类别枚举）

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
