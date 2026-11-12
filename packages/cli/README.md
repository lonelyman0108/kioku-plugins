# Kioku 的命令行

[Kioku](https://github.com/lonelyman0108/kioku) 是自托管的长期记忆服务。这个包提供 `kioku` 命令，要 Node 18 或更新的版本：

```bash
npx @kioku-memory/cli doctor
# 或者装到全局
npm install -g @kioku-memory/cli
```

Claude Code 的 kioku 插件自带同一个命令，启用插件后在它的 Bash 工具里直接用 `kioku`，不用另装（插件里的那份没有向导）。

## 向导

在终端里不带参数运行 `kioku`，要 Node 20.12 或更新的版本。先扫描一遍现状：

- 服务器：地址（取各平台已有的配置或 `KIOKU_SERVER_URL`，都没有就问）、连不连得上、版本、初始化了没有。
- 每个平台一行：本机装没装（命令或配置目录在不在）、接到哪个应用和空间、访问密钥是否有效、插件装没装、自带的长期记忆停没停、本地有几条记忆。查不了的写「无法判断」。

下面按缺什么列出动作，例如「接入 Codex、pi（2 个未接入）」「重新授权 Hermes（访问密钥已失效）」「接入 Claude Code」「迁移 Claude Code 的本地记忆（12 条）」「停用某个平台」「本机起一个 Kioku」「检查（doctor）」。每个动作先列计划、确认后才做，做完回到面板。

- **接入几个平台只确认一次**：一次申请勾选的几个平台（最多 8 个，多了分批，每批确认一次），确认页上为每个平台选应用与权限；拿到的访问密钥照 `kioku setup` 写下。确认页上没勾的平台跳过；确认之后、取走之前不再符合签发规则的（例如确认人已停用、应用被删）列出原因。服务端版本较旧、不认这种申请时，逐个平台申请，每个确认一次。签发了却没能写下的，提示去管理界面吊销。
- **迁移本地记忆**：面板上只数本地有几条；选了迁移才和 Kioku 逐条比对、列出计划，比出来的未迁移条数在这次向导里显示，写入之后重新算。比对失败的写「未迁移 无法判断」。
- **插件不替你装**：做完列出每个平台要自己运行的安装命令与之后要做的事，装好之后再运行 `kioku`，面板上就是「已安装」。
- **Claude Code**：访问密钥只认它的 `/plugin` 里填的，浏览器授权不给它发。「接入 Claude Code」停用自动记忆，再列出 `/plugin` 的安装命令与要填的服务地址；迁移本地记忆时问一次访问密钥。项目的 `.claude/settings.json` 又启用了自动记忆时，面板写明是哪份文件，不再提供停用（要在那里改）。
- **本机起一个 Kioku**：没有服务器时可选。取 Kioku 最新的正式版，在一个目录（默认 `~/kioku`）里下载这个版本的 `compose.yaml` 与 `.env.example`，生成 `.env`（数据库密码、主密钥、初始化码随机生成，镜像固定在这个版本，只给本人读写，端口只开在本机，已有的 `.env` 不覆盖），`docker compose up -d`，等服务就绪后显示初始化码并打开管理界面，建好管理员就接着接入平台。取不到正式版时用 main 上的文件与 `edge` 镜像，并明说。主密钥在 `.env` 里，另外保存一份。目录里已经起过（上次中断、重跑）的接着启动或等它就绪；端口 18920 被别的程序占着时只说明，不动它。

## 子命令

| 子命令 | 作用 |
|---|---|
| `kioku install --platforms <平台,…>` | 几个平台一起接入，访问密钥从环境变量读（给脚本用） |
| `kioku setup <平台>` | 把平台交给 Kioku 接管：停用平台自带的长期记忆；Codex、pi、Hermes、OpenClaw、DeepSeek Harness 再写下服务地址与访问密钥，Codex 还配好 MCP 服务 |
| `kioku login <平台>` | 用浏览器授权签发访问密钥并配好这个平台，不用手动复制 |
| `kioku doctor [平台]` | 检查地址、访问密钥与平台的配置 |
| `kioku import --from <来源>` | 把平台自带的本地长期记忆迁进 Kioku |
| `kioku run -e 变量=<标识>#<字段> -- <命令>` | 向 Kioku 取凭据的值，放进环境变量交给命令 |

每个子命令的完整说明：`kioku <子命令> --help`。现在认得的平台：`claude-code`、`codex`、`pi`、`hermes`、`openclaw`、`dsh`。

## login

```bash
kioku login codex --server-url https://kioku.example.com
```

终端显示一个确认码并打开 Kioku 管理界面的确认页（`--no-browser` 时只显示地址）。登录后在页面上输入确认码，选空间、应用与权限范围，点确认；命令行取到访问密钥后接着做 `kioku setup` 的事：核对、写下配置。访问密钥全程不显示。认得 `codex`、`pi`、`hermes`、`openclaw`、`dsh`；Claude Code 的访问密钥在它的 `/plugin` 里填。

- 确认码不在打开的地址里，要照着终端输入：只在自己刚运行了这条命令时确认。别人发来一个确认码让你去确认的，不要确认，那样对方的机器会拿到能读写你的记忆的访问密钥。
- 申请 10 分钟内有效。被拒绝、过期，或者确认之后确认人的角色变了，都拿不到访问密钥，重新运行即可。
- 不用在本机开端口，远程登录的机器上也能用：在任何一台登录了管理界面的浏览器里确认都行。
- 要 Kioku 服务端支持浏览器授权；旧的服务端会提示改用 `kioku setup` 手动填访问密钥。

`kioku setup codex`、`kioku setup pi` 第一次配置时，在终端里提示输入访问密钥的地方直接回车，走的是同一个流程。已经配过的再运行 `setup`，直接回车是沿用上次的访问密钥；要换一个就运行 `kioku login`。

- 确认之后如果这台机器没能把访问密钥写下（配置文件写不进去、中途断网），命令会提示去管理界面的应用页吊销刚签发的那个，再重新运行：访问密钥只在签发时给一次。

## install

```bash
export KIOKU_API_KEY_CODEX=… KIOKU_API_KEY_PI=…
kioku install --platforms codex,pi --server-url https://kioku.example.com -y
```

每个平台的访问密钥放在 `KIOKU_API_KEY_<平台>` 里（平台名大写、连字符换成下划线：`KIOKU_API_KEY_CLAUDE_CODE`、`KIOKU_API_KEY_CODEX`、`KIOKU_API_KEY_PI`、`KIOKU_API_KEY_HERMES`、`KIOKU_API_KEY_OPENCLAW`、`KIOKU_API_KEY_DSH`），没给的平台跳过并在结果里列出。各平台照 `kioku setup` 核对、写下配置、停用自带的长期记忆；Claude Code 只核对访问密钥、停用自动记忆，地址与访问密钥要在它的 `/plugin` 里填。

- 在终端里运行、没带 `-y` 时先列计划再确认；`--dry-run` 只列计划。
- 最后列出要自己运行的插件安装命令。有平台失败时退出码为 1。

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

## doctor

```bash
kioku doctor claude-code
```

每项一行：`✓` 正常，`!` 要留意，`✗` 有问题（这时退出码为 1）。查的是：地址连不连得上、访问密钥是否有效、它属于哪个应用、能读写哪些归属、最高敏感级与凭据能力，以及平台这一边插件是否启用、自带的长期记忆是否已停用。不写平台时按当前所在的会话认。

## import

```bash
kioku import --from claude-code --dry-run   # 只看计划
kioku import --from claude-code             # 列出计划，确认后写入
```

先读本地的记忆文件，列出每条会放到哪个坐标、Kioku 里有没有，确认之后才写。本地的文件不删、不改。

| 来源 | 读什么 | 放到哪 |
|---|---|---|
| `claude-code` | `~/.claude/projects/*/memory/*.md`（`MEMORY.md` 是索引，不读） | 按文件头里的类型：`user` → `user://about/<项目>/<名字>`；`project` → `user://projects/<项目>/<名字>`；`reference` → `user://reference/<项目>/<名字>`；`feedback` → `app://<应用>/feedback/<项目>/<名字>` |
| `hermes` | `~/.hermes/memories/` 的 `MEMORY.md`、`USER.md` | `MEMORY.md` → `app://<应用>/hermes/notes/…`；`USER.md` → `user://about/hermes/…` |
| `openclaw` | `~/.openclaw/workspace/` 的 `MEMORY.md`、`USER.md` 与 `memory/` 里按日期的笔记（`<日期>.md`、`<日期>-<名字>.md`） | `MEMORY.md` → `app://<应用>/openclaw/notes/…`；`USER.md` → `user://about/openclaw/…`；按日期的笔记 → `app://<应用>/openclaw/journal/<文件名>`，一个文件一条 |

- `<应用>` 是访问密钥所属的应用的标识。偏「这个 agent 该怎么干活」的放在应用下，别的 agent 用不上；关于用户本人和项目的放在本人下，各个 agent 都读得到。
- `<项目>` 取自 Claude Code 的项目目录名，去掉主目录与 `Documents`、`code` 这类常见的上级目录。分不清的两个项目（例如 `~/code/dev-proxy` 与 `~/code/proxy`）会得到同一个名字，同名的记忆会在计划里标出来，不会悄悄顶掉。
- Hermes、OpenClaw 的一个文件拆成几条：有只写着 `§` 的分隔行就按它拆，否则按二级标题拆，都没有就是一整条。有标题的用标题做标识；没有标题的用内容的摘要，所以文件里插一条、删一条不影响别的条，但改了某一段的内容会新建一条、旧的留着。Hermes 的位置与分隔符已经对着它的源码核对过（0.19.0），OpenClaw 的位置与文件名对着真实的安装核对过（2026.6.35）。OpenClaw 的 `USER.md` 是它生成的模板，没填过的话计划里会列出模板本身，不想要就先别迁。
- 标题与触发场景取文件头里的说明。写进去的记忆优先级是默认的，不进启动加载；要进的在管理界面里改。
- **重复运行不重复写**：坐标由来源决定，已经有、内容一样的跳过；已经有、内容不一样的默认也跳过（可能在 Kioku 里改过），`--overwrite` 才覆盖。
- **疑似明文凭据的不写**：列出是哪个文件、正文第几行、哪一类，不带值。先把值存成凭据、正文里写占位符，或者从文件里去掉，再运行一次。
- 不迁的会列出原因：正文超过 2 万字、没有内容、名字规整之后和别的一条撞了、文件头没有结尾。
- 只读普通的文本文件：符号链接不跟（它可以指到记忆目录之外的文件），太大的、不是文本的不读。
- 写到一半连不上时停下来，说明写了多少、还剩多少；重新运行会接着写。
- 不在终端里运行时要带 `--yes` 才写。`--path` 指明不在默认位置的目录。
- 地址与访问密钥读环境变量（Claude Code 的会话里已经配好）；`--platform codex`、`--platform pi`、`--platform hermes`、`--platform openclaw` 或 `--platform dsh` 改用 `kioku setup` 给那个平台写下的。记忆迁进这个访问密钥所属的应用。
- 指令文件（`AGENTS.md`、`CLAUDE.md`）不是记忆，不迁。Codex 自带的 Memories 存在它自己的数据库里、格式没有公开，迁不了。

迁完之后用 `kioku setup <平台>` 停用平台自带的记忆，免得两边接着各记一份。

## 各系统

macOS 与 Linux 上各平台都用真实的模型实测过。Windows 上跑过单元用例，也在 CI 的 Windows 机器上装真实的平台走过一遍（pi、Codex、OpenClaw、Hermes、DeepSeek Harness；模型是假的，核对的是装插件、注入、上报与工具登记），交互界面没有看过：

- 配置文件在 `%USERPROFILE%\.config\kioku\`（和别的系统一样的相对位置，可以用 `KIOKU_CONFIG_DIR` 改）。Windows 没有 600 这种权限位，文件靠用户目录自己的访问控制保护。
- npm 装的命令是 `.cmd`：`kioku setup openclaw`、`kioku run -- npm …` 会经 `cmd.exe` 起它们，参数里的 `&`、`|`、`%` 这类字符照原样交给命令。
- `kioku run` 转发信号（Ctrl-C、终止）的行为只在 macOS、Linux 上核对过。

## 地址与访问密钥

`kioku doctor codex`、`kioku doctor pi`、`kioku doctor hermes`、`kioku doctor openclaw`、`kioku doctor dsh` 读 `kioku setup` 写下的配置。别的情况下 `doctor` 与 `run` 从环境变量读：

- `KIOKU_SERVER_URL`：例如 `https://kioku.example.com`，不带 `/v1`
- `KIOKU_API_KEY`：在 Kioku 管理界面的「应用」页签发的访问密钥；或者用 `KIOKU_API_KEY_FILE` 指向只含访问密钥的文件

在 Claude Code 里，插件在会话开始时已经配好这两项。`setup` 只改本机的设置文件，用不到它们。

`kioku run` 的用法与打码的限度见 [Claude Code 插件的说明](https://github.com/lonelyman0108/kioku-plugins/tree/main/plugins/claude-code#kioku-run)。
