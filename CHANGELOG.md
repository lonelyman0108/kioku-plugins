# 更新日志

## [未发布]

## [0.6.1] - 2026-11-27

同步适配 Kioku `v0.7.0` 新增能力（保持 `api: 3` 兼容），`@kioku-memory/cli`、`@kioku-memory/openclaw` 与 `@kioku-memory/plugin-opencode` 一并发布至 `0.6.1`。

### 新功能与同步

- **OpenClaw 补齐 `kioku_history` 工具**：同步接入服务端变更历史查询工具，OpenClaw 插件工具清单扩展至 9 个（#49）
- **`kioku boot` 启动预览适配三态目录与场景标签**：兼容服务端 `omittedItems` 分类展示「常驻目录」与「字数预算外 / 单条超限」，并在常驻记忆与目录项下方独立展示四维场景标签（#49）
- **明确 `--env` 主机标识用法**：更新 `kioku add` 与 `kioku edit` 的 `--env` 帮助说明，明确支持系统名及自定义主机标识用于单机环境隔离（#49）

### 工程与发布

- **自动发布 npm `edge` 预览包与滚动预发布页**：`main` 通过 CI 后自动将公开包发布至 npm `edge` 标签，并同步更新 GitHub `edge` 滚动预发布页（#44、#47）

## [0.6.0] - 2026-11-25

同步适配 Kioku `v0.6.0` 单人扁平架构（服务端接口第 3 代），`@kioku-memory/cli`、`@kioku-memory/openclaw` 与 `@kioku-memory/plugin-opencode` 一并发布至 `0.6.0`；其余按仓库安装的 7 个插件已随主干同步更新。

### 不兼容变更

- **要求 Kioku `v0.6.0` 服务端（`api: 3`）**：命令行与全部插件不再兼容旧代服务端，升级本版时需同步将 Kioku 服务端升级至 `v0.6.0`；旧代服务端会自动提示升级指引
- **移除 AstrBot 插件与相关同步脚本**：删除 `plugins/astrbot_plugin_kioku` 与 `scripts/sync-client.sh`
- **移除 `kioku transfer` 与旧概念参数**：删除 `kioku transfer` 子命令，不再支持记忆圈、变体、四级敏感级与旧版地层视觉参数；记忆读写与导入命令全面切换为扁平标签参数（`--env`、`--realm`、`--project`、`--runtime`、`--topic`、`--pinned`）

### 新功能

- **`kioku run` 支持简化凭据标识**：同时支持无字段的裸凭据标识（`-e 变量=<标识>`）与多字段写法（`-e 变量=<标识>#<字段>`），标识支持包含 `.`、`_`、`-`，并与新版凭据解析接口保持一致
- **全部 9 个插件对齐扁平协议**：OpenClaw 收敛至精确 8 个 MCP 工具（`kioku_boot`、`kioku_search`、`kioku_get`、`kioku_browse`、`kioku_create`、`kioku_update`、`kioku_delete`、`kioku_list_credentials`）并同步插件清单；Hermes（Python 记忆提供方）、OpenCode、Claude Code、Codex、pi、DeepSeek Harness、Gemini CLI、Antigravity 全部更新至最新运行时与扁平接口
- **基于 MCP 结构化协议的记忆读写与导入**：`kioku search`、`kioku get`、`kioku ls`、`kioku add`、`kioku edit`、`kioku rm` 与 `kioku import` 改经 `/v1/mcp` 的结构化响应读写扁平记忆与场景标签
- **旧版客户端迁移命令 `kioku migrate`**：自动识别升级后的失效访问密钥（401）、旧插件来源、过旧插件与旧工具清单缓存，支持 `--dry-run` 预览与批量清理、升级插件及浏览器重新授权
- **纸墨风格终端界面**：全屏客户端管理工作台与命令行输出改用统一纸墨视觉（单砖红强调色与细线框，移除旧地层色带），并统一全仓客户端与产品用语

### 问题修复

- **修复 TUI 切换服务地址与刷新时的状态竞态**：慢速初始地址探测返回空值时不再覆盖新设置的地址，且交互测试在忙碌状态收尾后稳定退出
- **修复无参 `kioku migrate` 与 `kioku local up` 边界**：无参运行 `kioku migrate` 时对已更新插件但密钥失效的平台同样安排重新授权；`kioku local up` 启动检测补充服务端接口代际校验，避免误判旧代本机实例为就绪

## [0.5.0] - 2026-11-18

### 新功能

- **全屏双栏客户端管理工作台**：终端无参运行 `kioku` 默认进入零外部依赖的全屏双栏工作台（`TERM=dumb` 时自动回退到流式问答向导），顶栏展示 `記 憶 · kioku-plugins` 与服务器连接状态，左侧客户端列表与右侧详情渐进加载，支持单键接入、批量接入、插件安装更新、连通性诊断、冲突清理与本地记忆迁移，并保留终端原生鼠标框选复制
- **服务器地址持久化**：在 `~/.config/kioku/cli.json` 中自动记住最近使用或配置的 Kioku 服务地址，后续打开工作台或执行管理命令时直接沿用

### 问题修复

- **客户端三态探测与目录消歧**：区分 `installed`（含 CLI、桌面目录与 VS Code / Cursor / Windsurf 扩展）、`config-only`（仅残余配置）与 `absent` 三种状态；未接入的仅残余配置项默认折叠到 `Tab`，已接入但找不到可执行程序的客户端在主列表保留并提示告警；隔离 Gemini CLI 与 Antigravity 共用的 `~/.gemini` 目录，避免误判已安装
- **Windows 与 Windows Terminal 适配加固**：替换 `Consolas` 字体缺失或宽窄飘移字形并补充全屏自动折行保护与 `SIGBREAK` 终端恢复；Windows 下 `clip.exe` 改用 UTF-16LE BOM 编码避免中文复制乱码；查找命令时跳过 `Microsoft\WindowsApps` 下的零字节商店空壳；补齐 PowerShell 安装与下载指引、`$EDITOR` 启动 `.cmd` 编辑器及大小写不敏感的 Claude Code 盘符项目名解析

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
