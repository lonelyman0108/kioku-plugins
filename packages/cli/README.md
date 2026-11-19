# Kioku 的命令行

[Kioku](https://github.com/lonelyman0108/kioku) 是自托管的长期记忆服务。`@kioku-memory/cli` 以零运行时依赖单文件包分发（仅依赖 Node 22 / Node 20.12 以上交互能力），提供终端地层视觉界面（Strata UI）、客户端一站式接入与日常记忆读写：

```bash
npx @kioku-memory/cli
# 检查本机与服务端接入现状，或装到全局
npx @kioku-memory/cli status
npx @kioku-memory/cli doctor --all
npm install -g @kioku-memory/cli
```

Claude Code、Codex 等插件目录内部保留精简的 `packages/core` 运行时副本以执行 `kioku run` 与钩子转发；全功能交互控制台与管理命令由本包（`@kioku-memory/cli`）统一提供。

## 交互式控制台

在终端里不带参数运行 `kioku`（需要 Node 20.12 以上版本），默认进入全屏双栏客户端管理工作台（`TERM=dumb` 时自动回退到流式问答向导）。界面遵循 Kioku 地层设计规范：1px 直角细线框、归属色彩与文字标签并重、敏感级纯字符纹理（`[ ] 公开` / `[·] 内部` / `[╱] 私密` / `[■] 机密`）、砖红仅用于错误与高风险确认，并遵守 `NO_COLOR`、`FORCE_COLOR` 与 Alternate Screen 局部 diff 重绘（不启用鼠标捕获，保留终端原生框选复制）：

- **职责分工**：本控制台专注于本机各 AI 客户端的插件接入、配置文件、冲突清理、连通性诊断与本地记忆迁移；记忆目录编排、人格继承、访问密钥签发与凭据管理等服务端功能可在控制台内按 `o` 打开 Kioku 网页管理界面。
- **顶栏服务器状态**：自动读取已配置的服务器地址或 `KIOKU_SERVER_URL`，异步检查连接、版本与管理员初始化状态；按 `s` 更换地址，未配置或连不上本机时按 `l` 通过 Docker 启动本机实例。
- **左列表 + 右详情与渐进加载**：立即渲染本机检出的客户端并折叠未检出项（`Tab` 展开/折叠），后台并发校验各客户端访问密钥并在右侧实时更新接入实例、主场/客场记忆圈、读写物种、敏感级上限、插件状态、冲突与本地记忆统计。

底栏按当前选中客户端状态提供单键快捷操作（`Enter` 接入或重授权、`a` 批量接入、`p` 安装/更新插件、`d` 诊断、`i` 迁移本地记忆、`x` 清理冲突工具、`u` 断开并恢复自带记忆、`y` 复制安装命令、`?` 查看全部快捷键）。执行修改类动作前先弹出确认框，浏览器授权确认框与进度等待同样在工作台弹出层内完成：

- **多平台联合授权**：一次申请勾选的几个平台（最多 8 个），终端弹出宽松确认码框并自动尝试复制确认码，附带 `[o]` 打开浏览器 / `[c]` 复制链接 / `[Esc]` 取消快捷键与 10 分钟实时倒计时。浏览器确认页只输入一次确认码即可完成全部选定平台的配置写入、自带记忆停用，并自动尝试安装对应插件与执行 `whoami` + MCP `tools/list` 连通性握手测试。
- **插件自动安装与托管更新**：支持调用 Claude Code、Codex、Gemini CLI、pi、Hermes、OpenClaw 的官方安装/更新命令，或同步内置 Antigravity / Gemini 扩展（Antigravity 目录带 `.kioku-managed.json` 托管标记，更新或 `kioku disconnect` 清理时绝不误删用户自己放置的目录）；未检测到客户端 CLI 时自动降级为可复制的手动命令。
- **Claude Code 统一鉴权**：`kioku connect claude-code` 与 `kioku login claude-code` 直接走浏览器授权写入 `~/.config/kioku/claude-code.json` 并配好 `autoMemoryEnabled: false`；在 `/plugin` 里填入的配置优先，`/plugin` 留空时插件钩子与 `mcp-stdio.mjs` 自动回退读取 `~/.config/kioku/claude-code.json`。
- **迁移本地记忆**：控制台仅统计本地条数；选定迁移后与服务端逐条比对并列出计划，支持 `--select` 勾选子集写入。
- **本机起一个 Kioku**：没有服务器时可在 `~/kioku` 生成 `compose.yaml` 与仅本人可读写的随机密钥 `.env`，`docker compose up -d` 等健康检查通过后展示初始化码并在浏览器打开管理界面。

## 子命令

| 子命令 | 作用 |
|---|---|
| `kioku search <查询>` | 召回相关记忆（语义、全文与关键词），交互终端回车查看正文，支持 `--json` |
| `kioku get <短ID或标题>` | 按短 ID（`m-xxxxxx`）、旧坐标或精确标题读取单条记忆属性、切面变体与双链，支持 `--json` |
| `kioku ls [分组维度]` | 按主题、场域、环境、记忆圈或物种动态分组浏览记忆目录 |
| `kioku add [标题]` | 写入新记忆，支持 `--circle`、`--when`、`--topic`、标准输入与明文拦阻确认 |
| `kioku status [--json]` | 只读输出服务端与本机各客户端接入概况 |
| `kioku connect [平台…]` | 一站式授权、停用自带记忆、自动装插件与 MCP 握手验证 |
| `kioku disconnect <平台>` | 恢复自带记忆、删除凭据配置并安全清理托管插件 |
| `kioku upgrade [平台…]` | 升级已接入插件并刷新本机 MCP 工具清单缓存 |
| `kioku migrate [平台…]` | 识别服务端换代并迁移旧插件来源、工具清单缓存与失效访问密钥 |
| `kioku doctor [平台] [--all] [--json]` | 诊断服务地址、访问密钥权限、客户端配置与冲突工具 |
| `kioku clean [平台]` | 检测并卸载冲突的记忆工具（Lore 及常见记忆 MCP） |
| `kioku import --from <来源>` | 把平台自带的本地长期记忆迁进 Kioku |
| `kioku local [up\|down\|status\|logs]` | 使用 Docker Compose 管理本机 Kioku 服务 |
| `kioku open` | 在默认浏览器中打开 Kioku 管理界面 |
| `kioku login <平台>` | 用浏览器授权签发访问密钥并配好单个平台 |
| `kioku setup <平台>` | 停用平台自带记忆并手动填写服务地址与访问密钥 |
| `kioku install --platforms <平台,…>` | 多个平台批量接入，访问密钥从环境变量读（给脚本用） |
| `kioku run -e 变量=<标识>#<字段> -- <命令>` | 向 Kioku 取凭据的值，放进环境变量交给命令 |

每个子命令的完整说明：`kioku <子命令> --help`。支持的平台：`claude-code`、`codex`、`gemini`、`agy`、`opencode`、`pi`、`hermes`、`openclaw`、`dsh`。

## 从旧版升级

服务端升级到记忆圈架构之后，旧访问密钥会失效且需要更新各客户端插件：

1. 若服务端尚未完成数据结构升级，打开管理界面 `/legacy-upgrade` 用原管理员账号一键就地迁移。
2. 在终端执行 `npx @kioku-memory/cli migrate`（支持 `--dry-run` 预览、`-y` 跳过确认）：自动识别旧插件市场来源、过旧插件与旧版 MCP 工具清单缓存，卸载旧来源、安装/更新新版插件、在浏览器一次批量重新签发访问密钥，并运行 `kioku doctor` 完成验证。
3. 在全屏交互控制台（`kioku`）里，遇到待迁移服务端按 `o` 可直接打开升级页，检测到需迁移客户端按 `M` 可一键迁移。

## login

```bash
kioku login codex --server-url https://kioku.example.com
```

终端显示确认码框并打开 Kioku 管理界面的确认页（`--no-browser` 时只显示地址）。登录后在页面上输入确认码，选记忆圈、接入实例与权限范围，点确认；命令行取到访问密钥后接着做 `kioku setup` 的事：核对、写下配置。访问密钥全程不显示。支持全部客户端：`claude-code`、`codex`、`gemini`、`agy`、`opencode`、`pi`、`hermes`、`openclaw`、`dsh`。

- 确认码不在打开的地址里，要照着终端输入：只在自己刚运行了这条命令时确认。别人发来一个确认码让你去确认的，不要确认，那样对方的机器会拿到能读写你的记忆的访问密钥。
- 申请 10 分钟内有效。被拒绝、过期，或者确认之后确认人的角色变了，都拿不到访问密钥，重新运行即可。
- 不用在本机开端口，远程登录的机器上也能用：在任何一台登录了管理界面的浏览器里确认都行。
- 要 Kioku 服务端支持浏览器授权；旧的服务端会提示改用 `kioku setup` 手动填访问密钥。

`kioku setup codex`、`kioku setup pi` 第一次配置时，在终端里提示输入访问密钥的地方直接回车，走的是同一个流程。已经配过的再运行 `setup`，直接回车是沿用上次的访问密钥；要换一个就运行 `kioku login`。

- 确认之后如果这台机器没能把访问密钥写下（配置文件写不进去、中途断网），命令会提示去管理界面的接入实例页吊销刚签发的那个，再重新运行：访问密钥只在签发时给一次。

## install

```bash
export KIOKU_API_KEY_CODEX=… KIOKU_API_KEY_PI=…
kioku install --platforms codex,pi --server-url https://kioku.example.com -y
```

每个平台的访问密钥放在 `KIOKU_API_KEY_<平台>` 里（平台名大写、连字符换成下划线：`KIOKU_API_KEY_CLAUDE_CODE`、`KIOKU_API_KEY_CODEX`、`KIOKU_API_KEY_GEMINI`、`KIOKU_API_KEY_AGY`、`KIOKU_API_KEY_OPENCODE`、`KIOKU_API_KEY_PI`、`KIOKU_API_KEY_HERMES`、`KIOKU_API_KEY_OPENCLAW`、`KIOKU_API_KEY_DSH`），没给的平台跳过并在结果里列出。各平台照 `kioku setup` 核对、写下本机配置并停用自带长期记忆。

- 在终端里运行、没带 `-y` 时先列计划再确认；`--dry-run` 只列计划。
- 最后列出要自己运行的插件安装命令。有平台失败时退出码为 1。

## setup

```bash
kioku setup claude-code --dry-run   # 只看要改什么
kioku setup claude-code             # 停用 Claude Code 的自动记忆
kioku setup claude-code --undo      # 改回去
```

`kioku setup claude-code` 核对并写下 `~/.config/kioku/claude-code.json`（当 `/plugin` 选项留空时由钩子与 `mcp-stdio.mjs` 自动回退读取；若 `/plugin` 已填则优先采用 `/plugin` 配置），同时把 `~/.claude/settings.json` 的 `autoMemoryEnabled` 设为 `false`，设置里的其他内容不动。第一次改之前把原来的文件备份成同目录下的 `settings.json.kioku-backup`（已有备份时不覆盖），改完新开会话生效。本地已有的记忆文件不会被删掉。

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

### Hermes

```bash
kioku setup hermes --server-url https://kioku.example.com
```

核对后把地址与访问密钥写进 `~/.hermes/.env`，再经 `hermes config set` 选 Kioku 做记忆 provider、关掉内置的 `MEMORY.md` 与 `USER.md`。provider 用 `hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes --enable` 装。细节见 [Hermes provider 的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/hermes#setup-改了什么)。

### OpenClaw

```bash
kioku setup openclaw --server-url https://kioku.example.com
```

核对后写下 `~/.config/kioku/openclaw.json`，再经 `openclaw config set` 允许插件读对话（`plugins.entries.kioku.hooks.allowConversationAccess`）；记忆槽位在装插件时由 OpenClaw 选上，被换走了才由 `setup` 选回来。插件用 `openclaw plugins install npm:@kioku-memory/openclaw` 装，装完重启网关。细节见 [OpenClaw 插件的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/openclaw#setup-改了什么)。

### DeepSeek Harness

```bash
kioku setup dsh --server-url https://kioku.example.com
```

核对后写下 `~/.config/kioku/dsh.json`，不改 dsh 的设置（它没有自带的长期记忆）。插件按 profile 装：`dsh plugin --profile <profile> add github:lonelyman0108/kioku-plugins`，装完重启 dsh。

### Gemini CLI

```bash
kioku setup gemini --server-url https://kioku.example.com
```

核对后写下 `~/.config/kioku/gemini.json`，在 `~/.gemini/settings.json` 里加上 `mcpServers.kioku` 并把自带的 `save_memory` 加入 `excludeTools`。扩展按源码链接：`git clone https://github.com/lonelyman0108/kioku-plugins` 后 `gemini extensions link kioku-plugins/plugins/gemini`。

### Antigravity

```bash
kioku setup agy --server-url https://kioku.example.com
```

核对后写下 `~/.config/kioku/agy.json`，并在 `~/.gemini/config/mcp_config.json` 里加上 `mcpServers.kioku`（Antigravity 没有自带的长期记忆）。插件放到 `~/.gemini/config/plugins/kioku` 后新开会话生效。

### OpenCode

```bash
kioku setup opencode --server-url https://kioku.example.com
```

核对后写下 `~/.config/kioku/opencode.json`，并在 `~/.config/opencode/opencode.json` 的 `plugin` 列表里加上 `@kioku-memory/plugin-opencode`（原文件备份成 `opencode.json.kioku-backup`；OpenCode 没有自带的长期记忆，MCP 由插件在 `config` 钩子里注册）。

## 日常记忆读写（search / get / ls / add）

四个记忆读写命令共用零配置身份解析链：优先读 `--platform <平台>`，其次读 `KIOKU_SERVER_URL` + `KIOKU_API_KEY`（或 `KIOKU_API_KEY_FILE`），再读 `~/.config/kioku/cli.json` 记住的默认身份；本机若仅配置了一个客户端则直接选用，存在多个客户端时在交互式终端让你选择并记住默认项（非终端环境下提示传入 `--platform`）。

```bash
kioku search "发布流程" --limit 5
kioku get m-234567
kioku ls                         # 按主题（topic）分组列出可见词条
kioku ls realm --circle personal --json
echo "优先使用 pnpm" | kioku add "包管理工具" --topic tooling --when realm=work
```

- **`add` 的明文拦阻检查**：正文若触发服务端疑似明文凭据检查（HTTP 400），命令行只显示「第几行、哪一类」而不回显值；交互式终端可选择取消或确认为非凭据后写入，非终端环境可带 `--plaintext-ok` 放行。
- 四个命令均支持 `--json` 结构化输出与 `--platform <平台>`。

## status / connect / disconnect / upgrade / local / open

```bash
kioku status --json                # 只读检查服务端与本机各客户端状态（不含访问密钥）
kioku connect codex gemini         # 批量授权、写入配置、停用自带记忆、装插件并测试 MCP 握手
kioku disconnect codex             # 恢复自带记忆、删去凭据配置并清理托管安装的插件
kioku upgrade                      # 升级所有已安装插件并刷新 MCP 工具清单缓存
kioku local up                     # 用 Docker Compose 启动本机 127.0.0.1:18920 服务
kioku open                         # 在浏览器中打开 Kioku 管理界面
```

## doctor

```bash
kioku doctor claude-code
kioku doctor --all --json
```

每项一行：`✓` 正常，`!` 要留意，`✗` 有问题（这时退出码为 1）。不写平台时优先按当前所在会话识别，否则自动巡检全部已安装或已配置客户端（`--all` 覆盖全部受支持平台，`--json` 输出不含访问密钥的结构化报告）。

## clean

```bash
kioku clean --dry-run          # 扫描全部平台，只列发现的冲突
kioku clean agy                # 清理 Antigravity 上的冲突（交互确认）
kioku clean agy --tool lore -y # 非交互下只清理 Lore
```

检测并卸载与 Kioku 冲突的记忆工具（完整覆盖 Lore 的插件、MCP、钩子、环境变量与兼容状态，以及 Mem0、Supermemory、MCP 官方 Memory Server、Cipher、Claude-Mem 等常见记忆 MCP）：

- **只清理目标平台侧的配置与插件挂载**：不会跨平台清理，也不会删除 `~/.lore/docker`、`~/.lore/config.json` 等服务端或用户本地数据。
- **接入前自动检查**：`kioku setup`、`kioku login`、`kioku install` 与交互向导在发现冲突时都会先提示。交互模式下询问是否先卸载；非交互模式下默认阻断，传入 `--remove-conflicts` 后先卸载再继续接入。
- **保守处理非托管文件**：非符号链接或缺少托管标记的插件目录、泛用名称 `memory` 但特征不明的 MCP 条目、`CLAUDE.md` 里的手写指引只告警提示、不自动删改（仅精确移除 Lore 托管的 `@~/.claude/lore-guidance.md` 导入行与 `lore-guidance.md`）。

## import

```bash
kioku import --from claude-code --dry-run   # 只看计划
kioku import --from claude-code             # 列出计划，确认后写入
kioku import --from claude-code --select    # 交互勾选本次要迁入的条目子集
kioku import --from claude-code -y          # 免确认直接写入
```

先读本地的记忆文件，列出每条将写入的标题、切面与目标记忆圈（默认写入访问密钥所属接入实例的主场记忆圈，也可用 `--circle <记忆圈>` 指定），确认之后才写。本地的文件不删、不改。

| 来源 | 读什么 | 写入什么切面与主题 |
|---|---|---|
| `claude-code` | `~/.claude/projects/*/memory/*.md`（`MEMORY.md` 是索引，不读） | 默认带 `project=<项目>`（`feedback` 类型额外带 `runtime=claudecode`），主题标 `claude-code` 与类型；重名跨项目自动按项目后缀消歧 |
| `hermes` | `~/.hermes/memories/` 的 `MEMORY.md`、`USER.md` | `MEMORY.md` 带 `runtime=hermes`、主题 `hermes` / `notes`；`USER.md` 不限运行时、主题 `hermes` / `about` |
| `openclaw` | `~/.openclaw/workspace/` 的 `MEMORY.md`、`USER.md` 与 `memory/` 里按日期的笔记（`<日期>.md`、`<日期>-<名字>.md`） | `MEMORY.md` 与按日期笔记带 `runtime=openclaw`（主题 `openclaw` / `notes`、`journal`）；`USER.md` 不限运行时、主题 `openclaw` / `about` |

- 关于用户本人和项目的记忆不绑运行时切面，其他接入实例也可以直接按记忆圈与主题召回；偏某个运行时习惯的条目会带上对应 `runtime` 切面。同时为每个来源保留 `legacyUri` 兼容标识，已从旧版迁入或曾按旧 URI 导入过的条目会自动匹配。
- `<项目>` 取自 Claude Code 的项目目录名，去掉主目录与 `Documents`、`code` 这类常见的上级目录。两个项目如果撞了同一个描述标题，后一条会自动附上 `（<项目名>）` 后缀，不会悄悄顶掉。
- Hermes、OpenClaw 的一个文件拆成几条：有只写着 `§` 的分隔行就按它拆，否则按二级标题拆，都没有就是一整条。有标题的保留小节标题；没有标题或重名的小节自动附上内容摘要后缀（超长标题会先截短前缀再拼后缀），所以文件里插一条、删一条不影响别的条。Hermes 的位置与分隔符已经对着它的源码核对过（0.19.0），OpenClaw 的位置与文件名对着真实的安装核对过（2026.6.35）。OpenClaw 的 `USER.md` 是它生成的模板，没填过的话计划里会列出模板本身，不想要就先别迁。
- 标题与触发场景取文件头里的说明。写进去的记忆优先级是默认的，不进启动加载；要进的在管理界面里改。
- **重复运行不重复写**：优先按来源对应的兼容 `legacyUri` 精确匹配，未命中再按标题匹配目标记忆圈里同切面变体。已有且内容一样的跳过；内容不一样的默认也跳过（可能在 Kioku 里改过），`--overwrite` 才带着版本号覆盖（若原词条仅有通用 `{}` 切片而本地带有切面条件，会一并替换通用切片）。
- **疑似明文凭据的不写**：列出是哪个文件、正文第几行、哪一类，不带值。先把值存成凭据、正文里写占位符，或者从文件里去掉，再运行一次。
- 不迁的会列出原因：正文超过 2 万字、没有内容、文件头没有结尾，或同一批里完全重名的重复项。
- 只读普通的文本文件：符号链接不跟（它可以指到记忆目录之外的文件），太大的、不是文本的不读。
- 写到一半连不上时停下来，说明写了多少、还剩多少；重新运行会接着写。
- 不在终端里运行时要带 `--yes` 才写。`--path` 指明不在默认位置的目录。
- 地址与访问密钥读环境变量（Claude Code 的会话里已经配好）；`--platform codex`、`--platform gemini`、`--platform agy`、`--platform opencode`、`--platform pi`、`--platform hermes`、`--platform openclaw` 或 `--platform dsh` 改用 `kioku setup` 给那个平台写下的。记忆迁进目标记忆圈（默认为主场记忆圈）。
- 指令文件（`AGENTS.md`、`CLAUDE.md`）不是记忆，不迁。Codex 自带的 Memories 存在它自己的数据库里、格式没有公开，迁不了。

迁完之后用 `kioku setup <平台>` 停用平台自带的记忆，免得两边接着各记一份。

## 各系统

macOS 与 Linux 上各平台都用真实的模型实测过。Windows 上跑过单元用例，也在 CI 的 Windows 机器上装真实的平台走过一遍（pi、Codex、OpenClaw、Hermes、DeepSeek Harness；模型是假的，核对的是装插件、注入、上报与工具登记），交互界面没有看过：

- 配置文件在 `%USERPROFILE%\.config\kioku\`（和别的系统一样的相对位置，可以用 `KIOKU_CONFIG_DIR` 改）。Windows 没有 600 这种权限位，文件靠用户目录自己的访问控制保护。
- npm 装的命令是 `.cmd`：`kioku setup openclaw`、`kioku run -- npm …` 会经 `cmd.exe` 起它们，参数里的 `&`、`|`、`%` 这类字符照原样交给命令。
- `kioku run` 转发信号（Ctrl-C、终止）的行为只在 macOS、Linux 上核对过。

## 地址与访问密钥

`kioku doctor codex`、`kioku doctor gemini`、`kioku doctor agy`、`kioku doctor opencode`、`kioku doctor pi`、`kioku doctor hermes`、`kioku doctor openclaw`、`kioku doctor dsh` 读 `kioku setup` 写下的配置。别的情况下 `doctor` 与 `run` 从环境变量读：

- `KIOKU_SERVER_URL`：例如 `https://kioku.example.com`，不带 `/v1`
- `KIOKU_API_KEY`：在 Kioku 管理界面的「接入实例」页签发的访问密钥；或者用 `KIOKU_API_KEY_FILE` 指向只含访问密钥的文件

在 Claude Code 里，插件在会话开始时已经配好这两项。`setup` 只改本机的设置文件，用不到它们。

`kioku run` 的用法与打码的限度见 [Claude Code 插件的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/claude-code#kioku-run)。
