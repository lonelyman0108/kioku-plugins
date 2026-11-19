# Kioku 的 Antigravity (agy) 插件

为 Antigravity 接入 Kioku 长期记忆：

- `SessionStart` 注入启动加载内容（`injectSteps.systemMessage`）；
- `PreInvocation` 在每轮新用户输入时注入召回候选（同一轮内的工具调用自动去重）；
- `Stop` 从对话记录读取本轮最终回复并上报 Kioku 生成会话摘要；
- 在 `~/.gemini/config/mcp_config.json` 中自动写入 `mcpServers.kioku`（Streamable HTTP）。

## 安装与配置

先在 Kioku 管理界面的「接入实例」页建一个运行时是 `Antigravity`（`agy`）的接入实例，然后：

```bash
# 1. 配好服务地址、访问密钥与全局 mcp_config.json
npx @kioku-memory/cli setup agy --server-url https://kioku.example.com

# 2. 复制（或软链）插件到 Antigravity 插件目录
git clone https://github.com/lonelyman0108/kioku-plugins
mkdir -p ~/.gemini/config/plugins
cp -r kioku-plugins/plugins/agy ~/.gemini/config/plugins/kioku
```

也可按项目放置于 `<workspace>/.agents/plugins/kioku/`，或使用浏览器授权：

```bash
npx @kioku-memory/cli login agy --server-url https://kioku.example.com
```

检查配置：

```bash
npx @kioku-memory/cli doctor agy
```
