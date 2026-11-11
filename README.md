# kioku-plugins

Kioku 的客户端插件：Claude Code、Codex、pi 与 AstrBot（群聊机器人），以及 `kioku` 命令

## 做什么

[Kioku](https://github.com/lonelyman0108/kioku) 是多账号、多人格的长期记忆服务。本仓库放它的客户端插件与命令行：

- [Claude Code 插件](plugins/claude-code/README.md)：会话开始注入启动加载，每轮注入召回候选，每轮回复后写会话摘要，并提供读写记忆的 MCP 工具，以及把凭据经环境变量交给命令的 `kioku run`。
- [Codex 插件](plugins/codex/README.md)：会话开始注入启动加载，每轮注入召回候选，每轮回复后写会话摘要；地址、访问密钥与 MCP 工具由 `kioku setup codex` 配好。
- [pi 扩展](plugins/pi/README.md)：第一次输入前注入启动加载，每次输入注入召回候选，每轮结束后写会话摘要，并注册读写记忆的 MCP 服务。
- [`kioku` 命令](packages/cli/README.md)（npm 包 `@kioku-memory/cli`）：`kioku setup` 停用平台自带的长期记忆、写下配置，`kioku doctor` 检查配置，`kioku run` 把凭据交给命令。
- [AstrBot 插件](plugins/astrbot_plugin_kioku/README.md)：让群聊机器人用 Kioku 的人格、召回与对话抽取。

插件只做转发，不含记忆逻辑与提示词；接口与规则以 Kioku 为准。

## 本地运行

```bash
scripts/bootstrap.sh      # 克隆后执行一次：启用提交钩子、检查工具
scripts/check.sh          # 门禁：与 CI 完全一致
```

需要 Node 22、pnpm 与 uv。`pnpm install` 装 JS 这几个包的测试依赖；AstrBot 插件在自己的目录里用 `uv run pytest`。

## 部署或安装

- Claude Code：`/plugin install kioku --marketplace lonelyman0108/kioku-plugins`。之前从 kioku 仓库添加过插件市场的，先 `/plugin marketplace remove kioku` 再添加本仓库。
- Codex：`npx @kioku-memory/cli setup codex --server-url <地址>`，再 `codex plugin marketplace add lonelyman0108/kioku-plugins`、`codex plugin add kioku@kioku`，最后在 `/hooks` 里信任钩子。
- pi：`npx @kioku-memory/cli setup pi --server-url <地址>`，再 `pi install git:github.com/lonelyman0108/kioku-plugins`。
- AstrBot：`cp -R plugins/astrbot_plugin_kioku <AstrBot 的数据目录>/plugins/`，在管理面板里重载插件。

各插件的配置见各自的 README。AstrBot 插件带着从 Kioku 复制来的 Python 客户端，Kioku 的接口变了要同步，见 [AstrBot 插件 · 同步客户端](plugins/astrbot_plugin_kioku/README.md#同步客户端)。

## 配置项

各插件的配置见它们的 README。

## 许可证

[Apache-2.0](LICENSE)，第三方声明见 [NOTICE](NOTICE)

## 文档

- 贡献规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- agent 工作约定：[AGENTS.md](AGENTS.md)
- 文档索引：[docs/README.md](docs/README.md)
- 更新日志：[CHANGELOG.md](CHANGELOG.md)
