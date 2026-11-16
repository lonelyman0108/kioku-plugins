# Kioku 的 OpenCode 插件

为 OpenCode 接入 Kioku 长期记忆：

- 会话启动时通过 `experimental.chat.system.transform` 注入启动加载内容（并在上下文压缩后重新注入）；
- 用户提交消息时通过 `chat.message` 注入当前上下文的召回候选；
- 一轮对话空闲时（`session.idle`）将本轮输入与回复上报 Kioku 写会话摘要；
- 在插件的 `config` 钩子里自动注册 `mcp.kioku` 远程 MCP 服务，访问密钥只留在 `~/.config/kioku/opencode.json`（权限 600）。

## 安装与配置

先在 Kioku 管理界面的「应用」页建一个运行时是 `OpenCode`（`opencode`）的应用，然后运行：

```bash
npx @kioku-memory/cli setup opencode --server-url https://kioku.example.com
```

或使用浏览器授权：

```bash
npx @kioku-memory/cli login opencode --server-url https://kioku.example.com
```

`setup opencode` 会：
1. 将服务地址与访问密钥写入 `~/.config/kioku/opencode.json`（权限 `600`）；
2. 在 `~/.config/opencode/opencode.json` 的 `plugin` 列表中加入 `@kioku-memory/plugin-opencode`（原配置备份为 `opencode.json.kioku-backup`）。

检查配置：

```bash
npx @kioku-memory/cli doctor opencode
```
