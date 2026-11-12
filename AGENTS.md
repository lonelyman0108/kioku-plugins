# kioku-plugins

Kioku 的客户端插件：Claude Code 与 Codex 的插件（Node 的钩子脚本，vitest 测试）、pi 的扩展（在 pi 进程里跑的 JS）、OpenClaw 的记忆插件（在网关进程里跑的 JS，发 npm）、DeepSeek Harness 的插件（Cordis 插件，按仓库装）、Hermes 的记忆 provider（Python，只用标准库）、AstrBot 插件（Python，uv 与 pytest），以及各 JS 插件共用的实现（`packages/core`）与发到 npm 的 `kioku` 命令（`packages/cli`）。服务端、接口与规则在 [Kioku 仓库](https://github.com/lonelyman0108/kioku)。

提交、PR、发版的完整规范见 [CONTRIBUTING.md](CONTRIBUTING.md)；本文件只写 agent 需要、又无法从代码推出来的内容，每条约定都附原因。超过 300 行时拆到子目录的 AGENTS.md。

## 工作方式

- 只在分支或 worktree 上工作，分支名 `<type>/<slug>`；用 `scripts/pr.sh` 开 PR，**不直接提交或推送 main**。原因：main 受保护，PR 是唯一经过门禁的入口。
- 提交与 PR 标题：`<emoji> <type>(<scope>): <中文主题>`，首行 ≤ 72 字符；类型表和本仓扩展见 CONTRIBUTING.md「提交规范」。钩子会拦下不合规的提交。
- **不加任何署名 trailer**（Co-authored-by 等）。原因：规范禁止，钩子与 CI 两道都拦。
- 注释只讲代码本身，不写需求号、阶段号、验收号这类流程编号；这些编号只留在 `docs/` 的过程文档。`scripts/lint/comments.sh` 会检查。
- 提交前跑 `scripts/check.sh`（纯文档改动可用 `--quick`），结果写进 PR 的「验证」节。
- 一次性的进度写进 `docs/plans/` 的计划文档，不写进本文件。
- 仓库文件和提交信息里不写私有部署信息（内网地址、自建服务的域名、账号、邮箱）。原因：仓库可能公开，或镜像到公开平台。示例一律用 `example.com`、`127.0.0.1`。
- 模块结构由维护者先建好，agent 在已有结构内实现；要新增顶层包或目录时先在 PR 里说明。原因：维护者习惯自己定模块边界。
- 复用第三方代码时，在 PR 里写明来源和许可证；仓库用 Apache-2.0 时还要登记进 NOTICE。原因：许可证要求保留原作者的声明。

## 禁区

原因：这些操作影响发布、平台或门禁本身，必须由维护者本人执行或发起。

- 不发起维护者没要求的发版。维护者发起发版后，可以运行不带 `--dry-run` 的发布脚本改号、提交发布 PR、推送版本 tag，时机按 CONTRIBUTING.md「发布」一节；不删除、不移动 tag。
- 不上传、不部署（tag 推送后由 release.yml 自动完成的构建与推送除外）。
- 不改 Gitea、GitHub 等平台设置（secrets、分支保护、镜像），不读取或打印密钥文件（`~/.config/*/token`、`.env`、钥匙串）。
- 不用 `--no-verify`、`push --force`。
- 改 `.githooks/`、workflow（`.gitea/workflows/` 或 `.github/workflows/`）、`scripts/check.sh`、`scripts/ci/`、发布脚本时，只开 PR（`scripts/pr.sh --no-merge`），由维护者审阅后合并。
- 无人值守任务一律 `scripts/pr.sh --no-merge`。
- 第二行写着「受管文件」的文件（`.githooks/commit-msg`、`.githooks/pre-commit`、`scripts/ci/*`、`scripts/lint/comments.sh`、`scripts/pr.sh` 等）不在本仓直接改。原因：它们在各项目间保持一致，下次同步会覆盖本地改动；做法见 CONTRIBUTING.md「受管文件」。

## 命令

- 门禁：`scripts/check.sh`（`--quick` 只跑通用检查）
- 初始化：`scripts/bootstrap.sh`
- 开 PR：`scripts/pr.sh`（`--no-merge` 只开不合并）
- 测试：`pnpm test`（JS 的几个包）；`cd plugins/astrbot_plugin_kioku && uv run pytest`；`cd plugins/hermes && uv run pytest`
- 同步客户端：`scripts/sync-client.sh <Kioku 仓库的路径>`
- 改版本号：`scripts/bump-version.sh <X.Y.Z>`（发版时用，流程见 CONTRIBUTING.md「发布」）；核对会发出哪些文件：`scripts/ci/publish-npm.sh --dry-run v<X.Y.Z>`
- 同步共用实现：`node scripts/sync-core.mjs`（`--check` 只比对）

## 目录与约定

| 路径 | 内容 |
|---|---|
| `scripts/check.sh` | 唯一门禁入口，本地与 CI 行为一致 |
| `scripts/ci/` | 只被 CI 调用的小脚本 |
| `docs/plans/` | 计划文档，一个主题一份，持续勾选 |
| `docs/adr/` | 长期决策记录 |

| `plugins/claude-code` | Claude Code 插件；根目录的 `.claude-plugin/marketplace.json` 把本仓库作为插件市场 |
| `packages/core` | 各 JS 插件共用的实现：`lib/` 里是 `kioku` 命令（`kioku.mjs` 分发子命令并实现 `run`，`setup.mjs`、`doctor.mjs`，各平台在 `platforms.mjs` 登记，Codex 的那一套在 `codex.mjs`，pi 的在 `pi.mjs`，Hermes 的在 `hermes.mjs`，OpenClaw 的在 `openclaw.mjs`，DeepSeek Harness 的在 `dsh.mjs`，向 Kioku 的 MCP 端点取工具清单、调用工具与本机留的那份清单在 `mcp.mjs`，定地址与访问密钥的共用步骤在 `target.mjs`，浏览器授权在 `login.mjs`，本地记忆的迁移在 `import.mjs`（各来源的位置、格式与去处在 `sources.mjs`），读写平台设置文件的共用部分在 `files.mjs`，没有密钥存储的平台放地址与访问密钥的文件在 `profile.mjs`）、访问密钥检查与报错（`http.mjs`）、打码（`redact.mjs`）、生命周期转发（`lifecycle.mjs`），`bin/kioku` 是命令的入口；测试也在这里 |
| `plugins/claude-code/bin`、`plugins/claude-code/lib` | `packages/core` 的副本，由 `scripts/sync-core.mjs` 生成，不手改。插件启用期间 `bin/` 在 Bash 工具的 `PATH` 里 |
| `plugins/codex` | Codex 插件：清单在 `.codex-plugin/plugin.json`，钩子在 `hooks/`，`bin/`、`lib/` 同样是副本；根目录的 `.agents/plugins/marketplace.json` 把本仓库作为 Codex 的插件市场 |
| `plugins/pi` | pi 的扩展：入口 `index.js`（`createKioku` 是可以单测的那一层），`lib/` 同样是副本；根 `package.json` 的 `pi` 键把本仓库作为 pi 的包 |
| `plugins/hermes` | Hermes 的记忆 provider：`kioku_bridge.py` 是不依赖 Hermes 的那一层（请求、会话状态），`__init__.py` 把 Hermes 的回调接过去；`plugin.yaml` 里的 `name` 就是装好之后的目录名与 `memory.provider` 的值。不收核心的副本（Python） |
| `plugins/openclaw` | OpenClaw 的记忆插件，发到 npm 的 `@kioku-memory/openclaw`：清单 `openclaw.plugin.json`（`kind: "memory"`，工具名要在 `contracts.tools` 里声明），入口 `index.js` 只把状态挂到进程上，`kioku.js` 的 `createKioku` 是可以单测的那一层；`lib/` 同样是副本 |
| `plugins/dsh` | DeepSeek Harness 的插件：`cordis.patch.yml` 是补丁（装上插件、挂 MCP 客户端），根 `package.json` 的 `dsh` 键把本仓库登记成它的 bundle；入口 `index.js`，`kioku.js` 的 `createKioku` 是可以单测的那一层；`lib/` 同样是副本 |
| `packages/cli` | 发到 npm 的 `@kioku-memory/cli`：只有 `package.json` 与说明，`bin/`、`lib/` 同样是 `packages/core` 的副本 |
| `plugins/astrbot_plugin_kioku` | AstrBot 插件；目录名就是 AstrBot 认的插件名 |
| `plugins/astrbot_plugin_kioku/kioku_client` | 从 Kioku 的 `sdks/python` 复制来的生成客户端，来源提交记在 `SOURCE`；不手改 |

- 插件放在 `plugins/` 下：门禁按 `plugins/*/pyproject.toml` 找 Python 项目，pnpm 工作区按 `packages/*`、`plugins/*` 找包。
- 共用的实现只改 `packages/core`，改完跑 `node scripts/sync-core.mjs` 把副本一起提交。原因：Claude Code 这类平台按插件目录复制安装，装好之后引用不到目录之外的文件，所以每个插件目录里要有一份；`packages/core` 的用例 `vendored.test.mjs` 核对副本与核心一致，手改的副本过不了门禁。新加要收副本的插件时加进脚本的 `TARGETS`。

## 已知的坑

- `kioku_client` 不手改：Kioku 改了应用调用的接口、重新生成 SDK 后，用 `scripts/sync-client.sh` 整个替换。原因：手改的地方下次同步会被覆盖，和服务端对不上也要到运行时才报错。
- 插件失败时静默：Kioku 不可用、超时或拒绝时只记日志，不向 agent 或聊天里注入错误。原因：记忆服务出问题不能打断对话。`kioku run` 例外：它是 agent 主动执行的命令，失败时在标准错误里说明原因、退出码 2，不启动要跑的命令。
- 钩子与 `kioku run` 的报错不带值和访问密钥：`spawn` 的参数错误会把环境变量的值写进错误文字，`fetch` 的错误会带上整个 Authorization 请求头，响应解析失败的文字带着响应的开头。所以格式不对的访问密钥不发请求，报错只打插件自己写的文字（`KiokuFailure`）或错误类别，不打印 `err.message` 或整个错误对象；检查与报错只在 `packages/core/lib/http.mjs` 写一份，钩子和命令都用它。
- `kioku run` 有终端时（标准输入、输出或错误是 TTY）收到 SIGINT 不转给命令，只接住它、等命令结束：终端的 Ctrl-C 发给整个前台进程组，命令已经收到，再转一次就成了两次；没有终端时（Claude Code 的 Bash 工具）SIGINT 是单独发来的，照样转发。命令被信号结束时，`kioku` 等自己的输出写完，再以同一个信号结束，不按 128 + n 正常退出：外层的 shell 看到子进程被 SIGINT 结束才会停下循环。会转储的信号（SIGSEGV、SIGQUIT 等）不发给自己，免得 Node 自己转储，退回 128 + n。退出之前一律先等输出写完（`flushed`）再去掉信号的处理：Node 还在往外写时被信号结束，排着队的输出就丢了。
- 访问密钥文件每个会话一份（`api-key.<session_id>`），会话结束时删，会话开始时清掉超过 30 天没用过的和写到一半留下的临时文件。原因：只有一份时，每次会话开始都覆盖它，配置清空时删掉它，正在跑的别的会话跟着受影响。临时文件只删一分钟以前的：更新的可能是同时开始的别的会话正在写。
- 钩子往 `CLAUDE_ENV_FILE` 写的每一行都要是纯赋值：值用单引号括起来，值里的单引号写成 `'"'"'`，不用反斜杠，含控制字符的值不写。原因：Claude Code 把这个文件原样拼进之后每一条 Bash 命令，引号没配对会让整个会话的 Bash 命令都跑不起来；另有一处按行解析它，只认引号串拼成的纯赋值，有一行不认得就整份不用。
- `kioku setup` 只改平台设置里 `platforms.mjs` 列出的那几项：读不懂的设置文件（不是 JSON 对象）不动它；符号链接改它指向的文件；先写临时文件，改名之前再读一次，和开始时读到的不一样就不写；备份只留第一份；`--undo` 只把这几项改回去，不用备份覆盖。原因：设置文件是用户的，里面还有别的工具写的内容，平台自己也随时在改它，有人用符号链接把它放在别处管理。
- `kioku doctor` 打印不是自己写的文字（服务端给的应用名、环境变量里的地址）之前一律经 `plain`：控制字符、行与段落分隔符、改变显示方向的字符换成空格。它可能在 agent 的 Bash 工具里跑，输出会进上下文，名字里的换行能伪造一行结果。地址只打印协议、主机与路径，写在地址里的账号密码不打印。
- 两份市场清单要都在：Codex 没有 `.agents/plugins/marketplace.json` 时会退回去读 `.claude-plugin/marketplace.json`，把 Claude Code 插件当成可装的（它的钩子读的是 Claude Code 的配置，装上只会一直提示没有配置）。
- Codex 的 `config.toml` 只按行改（`codex.mjs`），不引 TOML 库（插件目录里的副本不能带依赖）。名叫 kioku 的 MCP 服务按段名认（`[mcp_servers.kioku]` 与它的子段），整个归 `kioku setup` 管；不要用注释当标记圈范围：Codex 自己会重写这个文件，注释会被它挪到别的段后面，圈进去的就成了别人的配置。段名先规整再比（带引号的、点两边有空白的是同一个名字）；用行内表或带点的键定义的 kioku 服务按行认不出范围，这时不写，否则再加一段就成了重复定义，整份配置 Codex 都读不了。访问密钥与地址先过格式检查再写、再发请求：带换行的值写进去同样是坏的 TOML。`config.toml` 里已经写着访问密钥时改它不留备份（`safeWrite` 的 `backup: false`）。
- Codex 的钩子要注意三点（都在真实的 Codex 上核对过，版本 0.167.1）：Stop 不带用户的输入，要在 UserPromptSubmit 时按会话与轮次记下、结束时取走；注入的上下文默认超过约 2,500 token 就被存成文件、只给模型看头尾，`hooks.json` 里的 `additionalContextLimit` 要比服务端给 Codex 的字数上限（`HOST_CONTEXT_LIMIT`，9,500 字约 7,400 token）宽；插件带的钩子要用户在 `/hooks` 里信任过才运行，自动化的测试用 `--dangerously-bypass-hook-trust`。
- pi 的扩展在 pi 的进程里跑（核对过 pi 1.5.2）：标准输出属于 pi（`--print`、JSON 模式都用它），原因只写标准错误；`before_agent_start` 在用户按下回车之后等着，启动加载与召回一起发、各有时限；`agent_end` 不是最后一次（重试、排队的消息还会再跑），回复攒到 `agent_settled` 再上报；上报不等它完成，但 `session_shutdown` 要等，否则 `--print` 跑完进程先退出就丢了。服务端对没有专门输出格式的运行时回 `return_value`，文本在 `value.context`（`contextOf`）。`forward` 用空字符串表示「没有内容」、`undefined` 表示失败：启动加载失败时下一次输入再试，空的不重取。
- 浏览器授权（`login.mjs`，服务端在 Kioku 的 `routes/device.ts`）：确认码不放进打开的地址，要用户照着终端输入，别人发来的链接带不了它；访问密钥、设备码不写进输出，拿到之后直接交给这个平台的 `setup`（核对、写文件都照它的规矩）；服务端给的确认码、应用名与自报的机器名都经 `plain` 再显示或上报；确认页的路径只收以 `/` 开头的，接在配置的服务地址后面，不让服务端把人带到别的站点。服务端的回答不全信：确认页的路径只收一种写法（`VERIFICATION_PATH`，不带查询参数与符号），时限与间隔收在范围里（`seconds`），打开浏览器不经过 shell（Windows 上用 rundll32，不用 `cmd /c start`）。访问密钥只在签发时给一次：申请之前先做平台的预检（`preflight`、`beforeLogin`），取走之后写不下、或者有过没得到回答的轮询之后申请不在了，报错里都要提醒去吊销那个没人拿着的访问密钥。`kioku setup` 只在终端里运行时（`process.stdin.isTTY`）才回落到它：agent 的 Bash 工具里没有人去确认。
- `kioku import`：坐标由来源算出（`sources.mjs`），这就是去重的依据，不另外记「迁过没有」：改某个来源的坐标规则等于让已经迁过的再迁一遍到新位置，要改得同时想好旧的怎么办。已经有、内容不一样的默认不覆盖（可能在 Kioku 里改过）。写入走访问密钥的记忆接口，不带 `plaintextOk`：疑似明文的照常被服务端拦下，输出里只写第几行、哪一类，不带值。本地的文件一律不删、不改。Hermes 的位置与分隔符对着它的源码核对过（`tools/memory_tool.py` 的 `ENTRY_DELIMITER`），OpenClaw 的还没有在真实的安装上核对。读文件只收普通的文本文件（`readable`）：符号链接不跟、项目的 memory 目录是符号链接时不进去，否则记忆目录之外的文件（`.env` 这类）会被读出来发给服务端。没有标题的段用内容的摘要做标识，不按顺序编号：文件里插一条之后别的条的坐标不能变。文件头只认单独一行的 `---` 结尾，像文件头却没写完的不迁，不把它当正文发出去。输出里的路径、目录名也经 `plain`。流程编号检查会把分节号当成编号：代码与用例里写成转义（`\\u00a7`），注释里写「分节号」。
- Hermes 的 provider（核对过 Hermes 0.19.0 与真实的 Kioku）：
  - **只用发布版里有的东西**：GitHub 主干比 PyPI 的发布版新，主干的 `agent/memory_provider.py` 里有 `is_trivial_prompt`、`spawn_context_thread`，0.19.0 没有，直接导入的话 provider 加载失败、Hermes 只说「没有装」。这类新东西一律 `try` 导入、带退路。写之前对着装出来的版本看，不对着主干的文档。
  - **工具清单要在初始化之前就拿得出来**：Hermes 在 `add_provider` 时就调 `get_tool_schemas()` 登记「哪个工具归谁」，早于 `initialize()`。那时返回空的话，模型看得到工具（之后又问了一次清单），调用时却报 `Unknown tool`。所以第一次被问到就向 Kioku 取（只取一次）；开始之后，不启用的会话里返回空的，调用时再拒绝一次。
  - **只在本机的入口里启用，按白名单认**（`LOCAL_PLATFORMS`：cli、tui、gui、acp、desktop），认不出的一律不启用。不能只看有没有网关的标识（`gateway_session_key`、`chat_id`）：Hermes 的 API 服务器在调用方不带会话头时两个都没有，那样远程的 HTTP 客户端就拿得到注入、用得上工具。工具转给 Kioku 的 MCP 端点，不带会话上下文，按访问密钥的全部权限读写；要放开别的入口得先有带会话上下文的工具接口。
  - **工具清单取不到就不补取**：归属只在注册时登记一次，之后再让模型看到这些工具也调不通。取的过程拿着锁，同时来问的等它取完。
  - **上报按顺序发**：每轮一个后台线程，等上一轮的发完再发，服务端收到的顺序才和对话一致。
  - **不走环境变量里的代理**（`ProxyHandler({})`），不跟跳转；`urllib` 这一层除了 `OSError`、`HTTPException` 还要接 `ValueError`（地址或请求头里有编不进去的字符，文字里可能带着整个 Authorization）。访问密钥的格式用 `fullmatch`：`$` 会放过结尾的换行。
  - provider 的状态都在实例上，不放在模块里（一个网关进程会给几个 profile 各建一个实例）；后台线程用 `spawn_context_thread`（有的话），带着调用方的上下文。
  - `ruff` 不让捕获笼统的 `Exception`：网络这一层接 `OSError` 与 `http.client.HTTPException`。
  - `kioku setup hermes` 不自己改 Hermes 的 `config.yaml`，经 `hermes config set`（用例里用 `KIOKU_HERMES_BIN` 换成假的），改完读回来核对：托管的安装里它不生效却照样成功退出。访问密钥只写进 `.env`，不出现在命令的参数里；`.env` 里都是密钥，改它不留备份。访问密钥写下之后的步骤（改 Hermes 的配置）不成也不抛错，只把要做的列出来：抛了的话 `kioku login` 会让用户去吊销一个其实已经在用的访问密钥。`.env` 里同名的行收拾成一处（Hermes 读最后一行），没有要改的时候原样不动。`--undo` 只在现在选的还是 kioku 时才改 Hermes 的配置。
  - 本地实测 Hermes 时，自定义的模型端点要把密钥写在 `config.yaml` 的 `model.api_key`（或用具名的 `providers:` 加 `key_env`）：`OPENAI_API_KEY` 只发给 openai.com 的地址。
- OpenClaw 的插件（核对过 OpenClaw 2026.6.35 与真实的 Kioku）：
  - **只在本机入口里启用，按白名单认**（`kioku.js` 的 `localRun`、`localTools`）：钩子上下文里通道的几个字段（`messageProvider`、`channel`、`channelId`、`chatId`）要么没有、要么是内部通道 `webchat`，没有发送者，`trigger` 是 `user`，会话不是子 agent、定时任务这类；认不出的一律不启用。不能按会话键认：外部渠道的私聊默认并进主会话（`agent:main:main`），网关的 HTTP 接口还能用请求头指定会话键。经网关时命令行与 HTTP 接口的通道都是 `webchat`，分不开，也不用分：到得了这里的都过了网关鉴权，OpenClaw 自己把它当操作者。
  - **`register` 是同步的，而且会被调很多次**（每次运行、每次重建注册表，`openclaw` 的每个命令也装载一次）：状态挂在 `globalThis` 上只建一次（`index.js`），`register` 里只挂钩子，不发请求、不等东西。入口导出普通对象就行，不用引 `openclaw/plugin-sdk`，包因此没有依赖。
  - **工具工厂也是同步的**，等不了取清单的请求：先用本机留的那一份（`openclaw-tools.json`，`kioku setup openclaw` 写下第一份，记着是哪个地址的、什么时候取的），后台每小时重新取。OpenClaw 按通道缓存工厂给出的工具描述，调用时会带着当时的上下文再问一次工厂，所以「给不给」只能看工具上下文里进了缓存键的那几项（`messageChannel`、`deliveryContext`、`requesterSenderId`）加会话键。
  - **工具上下文里没有触发方式**，心跳在主会话上跑时通道、会话键和本机的一轮一样：给不给工具按通道定，调得动调不动另看这个会话现在跑的是不是过了 `localRun` 的一轮（`approved`，输入钩子里记、一轮结束或接着跑别的运行时收回）。新加的工具路径也要过它。
  - **配置每分钟重读一次**（`ready`），换了地址或访问密钥时清掉按会话记着的启动加载与退避；服务地址返回跳转只当一次失败，不把插件停到重启为止。上报（`turn.end`）失败不设退避：它拦的是输入前的召回。
  - 工具清单取回来是空的不当真（手上的接着用、不写回本机），`kioku setup openclaw` 也不留空的。
  - **工具名要和清单文件一致**：`TOOL_NAMES` 与 `openclaw.plugin.json` 的 `contracts.tools` 是同一份名单，用例核对；Kioku 加了新工具要两处一起加，否则 OpenClaw 不认。
  - **启动加载每一轮都要给**：`prependSystemContext` 不存进会话，系统提示每轮重建。按会话 id 记着取到的文本，隔一小时重新取；`session.start` 不是每轮都发。
  - **一次性的运行里上报要等发完**：`openclaw agent --local` 跑完进程就退出，`agent_end` 里不等的话 `turn.end` 发不出去。
  - `kioku setup openclaw` 不自己改 OpenClaw 的配置文件，经 `openclaw config set`（用例里用 `KIOKU_OPENCLAW_BIN` 换成假的），改完读回来核对。记忆槽位只在插件装上之后才选得了（选没装的插件校验不过），装的时候 OpenClaw 自己会选上、卸载时自己改回去；访问密钥写下之后的步骤失败了不抛错，列出要自己运行的命令。`openclaw plugins inspect` 失败、输出读不懂是「没查出来」（`pluginState` 返回 undefined），和「没装」（它明说 Plugin not found）分开：当成没装的话 `--undo` 会删了配置却留着槽位。
  - 本地实测要把 `HOME` 也换掉：只设 `OPENCLAW_STATE_DIR` 时它照样在真实的 `~/.openclaw` 下建工作区。`OPENCLAW_HOME` 换的是主目录（工作区在它下面的 `.openclaw/workspace`），不是 `.openclaw` 本身。要 Node 24.16 以上。停实验用的网关按端口找进程（进程名只是 `openclaw`），没停掉的旧网关会接着用旧的插件注册表应答。
- DeepSeek Harness 的插件（核对过 dsh 0.2.2-rc.1 与真实的 Kioku；它还在预览阶段，升级时复查）：
  - **不用它兼容 Codex、Claude Code 钩子的那两个桥**：桥的 Stop 不带助手的回复、SessionStart 不等结果就开始第一轮。直接写 Cordis 插件：`agent/created`（记下要注入启动加载）、`agent/pre-step`（把启动加载与召回接在这一步的消息后面）、`agent/turn-stopping`（上报）。
  - **钩子里抛出去的错会让这一轮整个失败**（实测：处理函数里一个 TypeError，dsh 以 `UNKNOWN` 退出）：三个入口都自己接住。`agent/pre-step` 是瀑布式的，一定要把 `next()` 的结果交回去，自己的请求出什么错都不能影响它。
  - **消息的来源不能叫 `plugin`**：会话格式不收（报错里说 message requires a producer-owned source kind），用自己的名字（`kioku`），附带的字段（`part`）会原样留在会话里，靠它认出会话里有没有注入过启动加载。消息对象自己拼（`role`、`id`、`content`、`source`），不引 `@deepseek-ai/dsh-llm`：按仓库装的包引用不到 dsh 自己的依赖。
  - **会话记录用 `session.snapshotEvents()` 读**（`session.events` 在这个版本里不能遍历）。一轮的范围是 `turn/start` 到下一个 `turn/start`；用户说的是 `user/message` 里来源为 `user` 的，运行时的说明、别的插件加的消息来源不同。
  - **接着之前的会话（`resume`）时不重复注入启动加载**：注入的消息存在会话里，每次恢复都注入会越攒越多。只看最后一次压缩（`compaction/end`）之后有没有。取到了启动加载、这一步却被别的插件拒绝时不算注入过（`booted` 在消息真的接上去之后才清）。
  - **子 agent 按会话头的 `origin`、`delegationDepth` 认**，不看 `parentSession`：用户分出来的会话也可能带着它。
  - 上报不听这一轮的取消信号（被打断的一轮也要记），和输入前的请求各有各的退避。
  - **MCP 的地址与访问密钥在补丁的表达式里读本机的文件**（`!!js`，用 `process.getBuiltinModule` 取 `node:fs`）：表达式引用不到插件的代码，找文件的规则在补丁里又写了一遍，`plugins/dsh/__tests__/patch.test.mjs` 拿 `profile.mjs` 写出来的文件核对。改 `profileDir` 的规则要同步改补丁；地址与访问密钥的规整（去空白、去结尾的斜杠、只收可见的 ASCII）也照着 `readProfile` 写了一遍，手改的文件两边读出来要一样。正则里用 `[/]` 不用反斜杠（YAML 的双引号里反斜杠要转义）。表达式里只用单引号（用例按双引号截取）。
  - 插件行用补丁旁边的相对路径（`./index.js`），根 `package.json` 不用加 `exports`。
  - 本地实测：`HOME` 与 `DSH_HOME` 都换掉（维护者的机器上有真实的 `~/.dsh`）；`dsh plugin` 要 PATH 里有能用的 pnpm（fnm 带的 corepack 太旧，取到的 pnpm 12 跑不起来）；自定义的模型端点配在 profile 的 `cordis.patch.yml` 里（`llm-pi-ai` 加一个 `openai-completions` 的服务商，`agent-default-model` 指过去），密钥放环境变量、用 `apiKeyEnv` 引用；一次性的运行用 `dsh headless "<任务>"`。
- 端到端实测（`scripts/e2e/`，workflow `E2E`）：`node scripts/e2e/run.mjs <平台>` 在这台机器上装真实的平台，照安装说明走一遍（`kioku setup` → 装插件 → `kioku doctor` → 跑一轮），模型与 Kioku 都是假的（`fakes.mjs`），不用密钥。CI 在 Linux 与 Windows 上各跑五个平台，不是必需检查，每周一也跑一次：平台自己发新版本会让它变红，红了先看是平台变了还是这边坏了。要守住的几条：
  - 假的 Kioku 照服务端的格式回答（`hostOutput` 按运行时分、MCP 的握手与工具清单），服务端的接口变了要跟着改，否则它测的是旧格式。
  - 假的模型不生成内容，只把「请求里有没有注入的两个标记、有没有 Kioku 的工具」写成一句回答；上报里带着这句回答，就同时说明注入到了模型手上、回复被上报了。
  - **断言要在该失败的时候失败**（第一版太松，审查指出来的）：只算这一轮开始之后的请求（`kioku setup`、`kioku doctor` 自己也会取工具清单）；假的 Kioku 照契约校验事件，不合格的回 400；三个事件各要正好一次；`kioku doctor` 有提醒（`!`）也算没过；访问密钥只在 `kioku setup` 时给，平台只能从 setup 写下的地方读到。改断言之后故意改坏插件跑一次，确认抓得到。
  - 工具怎么核对按平台分（`tools`）：Codex、dsh、Hermes 直接把工具放进模型的请求；pi 按需才给，看它这一轮向 Kioku 取过清单；新一些的 OpenClaw（2026.11.3）把插件的工具放在 `tool_search` 后面，假的模型会搜一次 kioku，看搜索结果。`openclaw plugins inspect` 不装载插件，看不出运行时登记了什么，不能拿它核对。
  - 主目录、各平台的配置目录都换成临时目录，起命令经 `command.mjs` 的 `launch`（平台装在 `node_modules/.bin`，Windows 上是 `.cmd`）。
  - 改了插件的加载、注入或安装方式，本机跑一遍对应的平台；本机到 npm 慢，装 Codex、dsh 这类大包可能要十几分钟，CI 上快得多。
  - Hermes 的 `hermes plugins install` 只从 GitHub 装，装不了没合并的改动，脚本里是把目录复制到 `$HERMES_HOME/plugins/kioku`。
- 跨系统（CI 里 `test-windows` 在真的 Windows 上跑 JS 的用例；五个平台在 Linux 容器里用真实的模型各实测过一遍）：
  - **起 npm 装的那类命令（`openclaw`、`hermes`、`kioku run` 要跑的命令）经 `command.mjs`**（`launch` 算怎么起，`capture` 跑到结束并收输出，`killTree` 结束）：Windows 上它们是 `.cmd`，直接 `execFile`、`spawn` 起不来，经 `cmd.exe` 时参数要转义（规则改写自 cross-spawn，登记在 `NOTICE`）。`git`、`rundll32` 这类本来就是 `.exe` 的照旧直接起。要守住的几条：
    - 只在 Windows 上介入，别的系统原样交给系统（自己在 PATH 里找的话，会选中前面目录里不能执行的同名文件）。
    - 名字没写扩展名时不找原样的名字：npm 在 `.cmd` 旁边放着一个同名、没有扩展名的 sh 脚本。
    - 隔着 `cmd.exe` 时结束命令要连它下面的进程一起（`taskkill /T`）：只结束 `cmd.exe` 的话真正的命令还活着、还占着输出的管道，`kioku run` 会留下带着值的进程，`kioku setup` 会一直等。
    - 参数里有换行就不起（`cmd.exe` 把换行之后的悄悄丢掉）。环境变量名不分大小写，同名的取排序后的第一个，和 Node 交给子进程的一致。
    - Windows 上「没有这个命令」靠自己在 PATH 里找不到来判断，不靠 `ENOENT`。
  - 用例里的假命令用 `__tests__/fakeCommand.mjs` 的 `fakeCommand` 造（Windows 上照 npm 放 `.cmd`、脚本与一个无扩展名的 sh 脚本），不手写 shebang 加 `chmod`。
  - 用例不按 `/` 切路径（用 `basename`、`join`、`sep`）；权限位的断言经 `mode(0o600)`（Windows 上文件一律是 666）；只在 POSIX 上有意义的（信号、直接执行带 shebang 的脚本、文件名里的控制字符、靠目录权限让写入失败）用 `posixOnly`，在 Windows 上跳过。这两个也从 `fakeCommand.mjs` 导出；插件目录里的用例引用不到，各留了一份 `mode`。
  - `bin/kioku` 在输出被提前关掉（`| head`）时不抛堆栈，但不提前退出：手上的事做完、按它的结果退出（中途以 0 退出的话，写了一半的导入会被当成成功）。`run` 自己处理这种情况。
  - 本机起 Linux 容器实测：非交互的会话里 docker 会去找钥匙串，换 `DOCKER_CONFIG` 还不够，要把 `docker-credential-osxkeychain` 所在的目录也从 PATH 里去掉；容器里用普通用户跑，经 `host.docker.internal` 连本机的 Kioku（转发要听 `0.0.0.0`）。
- 用例里假的服务端收请求体时要 `req.setEncoding('utf8')`：不设的话分块到达的多字节字符按块拼成字符串，切开的字变成替换字符，长度对不上（按上限截断的用例会偶尔失败）。
- 用真实的 Codex 核对时不用官方的地址与登录：独立的 `CODEX_HOME` 里配一个自定义的 `model_providers`（`requires_openai_auth = false`，`env_key` 指向放密钥的环境变量），`codex exec` 要 `< /dev/null`，否则它等标准输入。
- `packages/cli/package.json`、`plugins/claude-code/package.json` 不写 `"type": "module"`：没有扩展名的 `bin/kioku` 因此在各个 Node 版本上都按 CommonJS 执行，早一些的 Node 18、20 不认 `"type": "module"` 下没有扩展名的文件。`bin/kioku` 本身只用动态 `import`，按两种模块执行都能跑；实现都写在 `.mjs` 里。
