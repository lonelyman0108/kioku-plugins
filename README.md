<p align="center"><img src="https://raw.githubusercontent.com/lonelyman0108/kioku/main/apps/web/public/favicon.svg" width="72" alt="Kioku"></p>

<h1 align="center">kioku-plugins</h1>

<p align="center">
<b>一处记忆，各处想起。</b><br>
<a href="https://github.com/lonelyman0108/kioku">Kioku</a> 的客户端插件与 <code>kioku</code> 命令行
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@kioku-memory/cli"><img src="https://img.shields.io/npm/v/@kioku-memory/cli?style=flat-square&label=%40kioku-memory%2Fcli&color=2A2B26" alt="@kioku-memory/cli"></a>
<a href="https://www.npmjs.com/package/@kioku-memory/openclaw"><img src="https://img.shields.io/npm/v/@kioku-memory/openclaw?style=flat-square&label=%40kioku-memory%2Fopenclaw&color=2A2B26" alt="@kioku-memory/openclaw"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2A2B26?style=flat-square" alt="Apache-2.0"></a>
</p>

## 一条命令接入

```bash
npx @kioku-memory/cli
```

在终端里不带参数运行打开交互式控制台面板：先扫描服务器与本机已安装客户端的接入现状（折叠未安装的客户端，支持一键接入全部已检出客户端），几个平台一起接入时浏览器里只确认一次，确认后自动写入配置、停用自带长期记忆、尝试自动安装对应插件并执行 `whoami` + MCP 工具清单握手验证，本地记忆可顺带迁入。尚未部署服务端时可直接在本机用 Docker 启动一套实例（`kioku local up`）。需要 Node 20.12 以上（命令行内置界面完全零外部依赖）。

只接特定平台、或非交互使用：

```bash
npx @kioku-memory/cli connect claude-code codex --server-url https://kioku.example.com
npx @kioku-memory/cli login codex --server-url https://kioku.example.com
KIOKU_API_KEY_CODEX=… KIOKU_API_KEY_PI=… npx @kioku-memory/cli install --platforms codex,pi --server-url https://kioku.example.com -y
```

`connect` 与 `login` 覆盖全部客户端：`claude-code`、`codex`、`gemini`、`agy`、`opencode`、`pi`、`hermes`、`openclaw`、`dsh`。其中 Claude Code 支持在终端通过 `kioku connect claude-code` 自动写入 `~/.config/kioku/claude-code.json`，也可直接在 `/plugin` 选项中填写（`/plugin` 选项优先，留空时钩子与 `mcp-stdio.mjs` 自动回退读取本机配置文件）。

## 平台

| 平台 | 形态 | 启动加载 | 每轮召回 | 会话摘要 | 记忆工具 |
|---|---|:-:|:-:|:-:|:-:|
| [Claude Code](plugins/claude-code/README.md) | 插件市场 | ● | ● | ● | MCP |
| [Codex](plugins/codex/README.md) | 插件市场 | ● | ● | ● | MCP |
| [Gemini CLI](plugins/gemini/README.md) | 扩展 | ● | ● | ● | MCP |
| [Antigravity](plugins/agy/README.md) | 插件 | ● | ● | ● | MCP |
| [OpenCode](plugins/opencode/README.md) | npm 插件 | ● | ● | ● | MCP |
| [pi](plugins/pi/README.md) | 扩展 | ● | ● | ● | MCP |
| [Hermes](plugins/hermes/README.md) | 记忆 provider | ● | ● | ● | ● |
| [OpenClaw](plugins/openclaw/README.md) | 记忆槽位 | ● | ● | ● | ● |
| [DeepSeek Harness](plugins/dsh/README.md) | 生命周期插件 | ● | ● | ● | MCP |
| [AstrBot](plugins/astrbot_plugin_kioku/README.md) | 群聊机器人 | 人格 | ● | 对话抽取 | — |

Hermes 与 OpenClaw 只在本机入口的会话里生效。各插件的配置见各自的 README。

<details>
<summary>各平台的安装步骤</summary>

- **Claude Code**：`/plugin install kioku --marketplace lonelyman0108/kioku-plugins`，在 `/plugin` 里填地址与访问密钥。之前从 kioku 仓库添加过插件市场的，先 `/plugin marketplace remove kioku` 再添加本仓库。
- **Codex**：`kioku login codex` → `codex plugin marketplace add lonelyman0108/kioku-plugins` → `codex plugin add kioku@kioku` → 在 `/hooks` 里信任钩子。
- **Gemini CLI**：`kioku login gemini` → `git clone https://github.com/lonelyman0108/kioku-plugins` → `gemini extensions link kioku-plugins/plugins/gemini` → 重启 Gemini CLI。
- **Antigravity**：`kioku login agy` → `git clone https://github.com/lonelyman0108/kioku-plugins` → `mkdir -p ~/.gemini/config/plugins && cp -r kioku-plugins/plugins/agy ~/.gemini/config/plugins/kioku` → 新开会话。
- **OpenCode**：`kioku login opencode` → 打开 `opencode`，确认 `~/.config/opencode/opencode.json` 的 `plugin` 里已有 `@kioku-memory/plugin-opencode`。
- **pi**：`kioku login pi` → `pi install git:github.com/lonelyman0108/kioku-plugins`。
- **Hermes**：`kioku login hermes` → `hermes plugins install lonelyman0108/kioku-plugins/plugins/hermes --enable`。
- **OpenClaw**：`kioku login openclaw` → `openclaw plugins install npm:@kioku-memory/openclaw` → 重启网关。
- **DeepSeek Harness**：`kioku login dsh` → `dsh plugin --profile <profile> add github:lonelyman0108/kioku-plugins` → 重启 dsh。
- **AstrBot**：`cp -R plugins/astrbot_plugin_kioku <AstrBot 的数据目录>/plugins/`，在管理面板里重载插件。

`kioku` 即 `npx @kioku-memory/cli`，也可以 `npm install -g @kioku-memory/cli`。不想走浏览器授权时用 `kioku setup <平台>` 手动填访问密钥。

</details>

## 命令行

| 子命令 | 作用 |
|---|---|
| `kioku`（不带参数） | 交互式控制台：扫描现状、一键接入、诊断检查与本地迁移 |
| `kioku status [--json]` | 只读查看服务端状态与本机各客户端接入概况 |
| `kioku connect [平台…]` | 一站式接入：浏览器授权、停用自带记忆、自动装插件与 MCP 握手验证 |
| `kioku disconnect <平台>` | 断开接入、恢复自带记忆并安全清理托管安装的插件 |
| `kioku upgrade [平台…]` | 更新已安装插件并刷新本机 MCP 工具清单缓存 |
| `kioku doctor [平台] [--all] [--json]` | 诊断服务地址、访问密钥权限与各客户端配置 |
| `kioku search <查询>` | 日常记忆检索（召回候选并在交互终端展开详情） |
| `kioku get <坐标>` | 按坐标读取单条记忆完整属性与正文 |
| `kioku ls [坐标或归属]` | 按地层顺序（本人、应用、人格、通用）浏览记忆目录 |
| `kioku add [坐标]` | 写入新记忆（支持 `--content`、管道标准输入、编辑器与明文拦阻确认） |
| `kioku local [up\|down\|status\|logs]` | 使用 Docker Compose 管理本机 Kioku 服务 |
| `kioku open` | 在默认浏览器中打开 Kioku 管理界面 |
| `kioku login <平台>` | 浏览器授权签发访问密钥并写好本机配置 |
| `kioku setup <平台>` | 停用平台自带长期记忆，手动填写服务地址与访问密钥 |
| `kioku install --platforms <平台,…>` | 几个平台一起接入，访问密钥从环境变量读（给脚本用） |
| `kioku clean [平台]` | 检测并卸载冲突的记忆工具（Lore 及常见记忆 MCP） |
| `kioku import --from <来源>` | 把平台本地的长期记忆迁进 Kioku |
| `kioku run -e 变量=<标识>#<字段> -- <命令>` | 取凭据的值放进环境变量交给命令，agent 看不到明文 |

完整说明见 [命令行](packages/cli/README.md)。Claude Code 插件自带凭据取值与生命周期脚本；日常与全功能命令行推荐 `npx @kioku-memory/cli` 或全局安装 `@kioku-memory/cli`。

## 设计取向

插件只转发，不含记忆逻辑与提示词：召回怎么排、启动加载放什么、使用指引怎么写，都以 Kioku 为准，升级服务端就生效。

AstrBot 插件带着从 Kioku 复制来的 Python 客户端，Kioku 的接口变了要同步，见 [同步客户端](plugins/astrbot_plugin_kioku/README.md#同步客户端)。

## 开发

```bash
scripts/bootstrap.sh && pnpm install
scripts/check.sh              # 门禁，与 CI 一致
```

需要 Node 22、pnpm 与 uv。AstrBot 插件与 Hermes 的 provider 在各自目录里 `uv run pytest`。规范见 [CONTRIBUTING.md](CONTRIBUTING.md)、[AGENTS.md](AGENTS.md)，文档索引见 [docs/README.md](docs/README.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[Apache-2.0](LICENSE)，第三方声明见 [NOTICE](NOTICE)。
