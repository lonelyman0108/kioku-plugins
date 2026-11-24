# Kioku 的 Gemini CLI 插件

为 Gemini CLI 接入 Kioku 长期记忆：

- `SessionStart` 注入启动加载内容；
- `BeforeAgent` 根据当前输入注入召回候选；
- `AfterAgent` 在本轮结束后将对话提交 Kioku 生成会话摘要；
- 在 `~/.gemini/settings.json` 中自动写入 `mcpServers.kioku`（`httpUrl`）并把自带的 `save_memory` 工具加入 `excludeTools`。

## 安装与配置

先在 Kioku 管理界面的「客户端」页建一个运行时是 `Gemini CLI`（`gemini`）的客户端，然后：

```bash
# 1. 配好服务地址、访问密钥、MCP 服务并停用自带 save_memory
npx @kioku-memory/cli setup gemini --server-url https://kioku.example.com

# 2. 链接此扩展启用生命周期钩子
git clone https://github.com/lonelyman0108/kioku-plugins
gemini extensions link kioku-plugins/plugins/gemini
```

或使用浏览器授权：

```bash
npx @kioku-memory/cli login gemini --server-url https://kioku.example.com
```

检查配置：

```bash
npx @kioku-memory/cli doctor gemini
```
