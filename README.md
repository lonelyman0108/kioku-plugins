# kioku-plugins

Kioku 的客户端插件：Claude Code 与 AstrBot（群聊机器人）

## 做什么

[Kioku](https://github.com/lonelyman0108/kioku) 是多账号、多人格的长期记忆服务。本仓库放它的两个客户端插件：

- [Claude Code 插件](plugins/claude-code/README.md)：会话开始注入启动加载，每轮注入召回候选，每轮回复后写会话摘要，并提供读写记忆的 MCP 工具。
- [AstrBot 插件](plugins/astrbot_plugin_kioku/README.md)：让群聊机器人用 Kioku 的人格、召回与对话抽取。

插件只做转发，不含记忆逻辑与提示词；接口与规则以 Kioku 为准。

## 本地运行

```bash
scripts/bootstrap.sh      # 克隆后执行一次：启用提交钩子、检查工具
scripts/check.sh          # 门禁：与 CI 完全一致
```

需要 Node 22、pnpm 与 uv。`pnpm install` 装 Claude Code 插件的测试依赖；AstrBot 插件在自己的目录里用 `uv run pytest`。

## 部署或安装

- Claude Code：`/plugin install kioku --marketplace lonelyman0108/kioku-plugins`。之前从 kioku 仓库添加过插件市场的，先 `/plugin marketplace remove kioku` 再添加本仓库。
- AstrBot：`cp -R plugins/astrbot_plugin_kioku <AstrBot 的数据目录>/plugins/`，在管理面板里重载插件。

两个插件的配置见各自的 README。AstrBot 插件带着从 Kioku 复制来的 Python 客户端，Kioku 的接口变了要同步，见 [AstrBot 插件 · 同步客户端](plugins/astrbot_plugin_kioku/README.md#同步客户端)。

## 配置项

各插件的配置见它们的 README。

## 许可证

[Apache-2.0](LICENSE)，第三方声明见 [NOTICE](NOTICE)

## 文档

- 贡献规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- agent 工作约定：[AGENTS.md](AGENTS.md)
- 文档索引：[docs/README.md](docs/README.md)
- 更新日志：[CHANGELOG.md](CHANGELOG.md)
