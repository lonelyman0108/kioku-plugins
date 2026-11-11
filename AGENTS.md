# kioku-plugins

Kioku 的客户端插件：Claude Code 插件（Node 的钩子脚本，vitest 测试）与 AstrBot 插件（Python，uv 与 pytest），以及各 JS 插件共用的实现（`packages/core`）。服务端、接口与规则在 [Kioku 仓库](https://github.com/lonelyman0108/kioku)。

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
- 测试：`pnpm test`（Claude Code 插件）；`cd plugins/astrbot_plugin_kioku && uv run pytest`
- 同步客户端：`scripts/sync-client.sh <Kioku 仓库的路径>`
- 同步共用实现：`node scripts/sync-core.mjs`（`--check` 只比对）

## 目录与约定

| 路径 | 内容 |
|---|---|
| `scripts/check.sh` | 唯一门禁入口，本地与 CI 行为一致 |
| `scripts/ci/` | 只被 CI 调用的小脚本 |
| `docs/plans/` | 计划文档，一个主题一份，持续勾选 |
| `docs/adr/` | 长期决策记录 |

| `plugins/claude-code` | Claude Code 插件；根目录的 `.claude-plugin/marketplace.json` 把本仓库作为插件市场 |
| `packages/core` | 各 JS 插件共用的实现：`lib/` 里是 `kioku` 命令（`kioku.mjs`）、访问密钥检查与报错（`http.mjs`）、打码（`redact.mjs`）、生命周期转发（`lifecycle.mjs`），`bin/kioku` 是命令的入口；测试也在这里 |
| `plugins/claude-code/bin`、`plugins/claude-code/lib` | `packages/core` 的副本，由 `scripts/sync-core.mjs` 生成，不手改。插件启用期间 `bin/` 在 Bash 工具的 `PATH` 里 |
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
- `plugins/claude-code/package.json` 不写 `"type": "module"`：没有扩展名的 `bin/kioku` 因此在各个 Node 版本上都按 CommonJS 执行，早一些的 Node 18、20 不认 `"type": "module"` 下没有扩展名的文件。`bin/kioku` 本身只用动态 `import`，按两种模块执行都能跑；实现都写在 `.mjs` 里。
