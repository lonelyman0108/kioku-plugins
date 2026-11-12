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
npx @kioku-memory/cli login <平台> --server-url https://kioku.example.com
```

终端给出确认码，在 Kioku 的确认页输入、选好权限，访问密钥直接写进本机配置，全程不显示。平台自带的长期记忆一并停用，免得两边各记一份。认得 `codex`、`pi`、`hermes`、`openclaw`、`dsh`；Claude Code 的访问密钥在它的 `/plugin` 里填。

## 平台

| 平台 | 形态 | 启动加载 | 每轮召回 | 会话摘要 | 记忆工具 |
|---|---|:-:|:-:|:-:|:-:|
| [Claude Code](plugins/claude-code/README.md) | 插件市场 | ● | ● | ● | MCP |
| [Codex](plugins/codex/README.md) | 插件市场 | ● | ● | ● | MCP |
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
| `kioku login <平台>` | 浏览器授权，签发访问密钥并写好配置 |
| `kioku setup <平台>` | 停用平台自带的记忆，手动填地址与访问密钥 |
| `kioku doctor [平台]` | 检查地址、访问密钥与平台配置 |
| `kioku import --from <来源>` | 把平台本地的记忆迁进 Kioku |
| `kioku run -e 变量=<标识>#<字段> -- <命令>` | 取凭据的值放进环境变量交给命令，agent 看不到明文 |

完整说明见 [命令行](packages/cli/README.md)。Claude Code 插件自带同一个命令，启用插件后在它的 Bash 工具里直接用。

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
