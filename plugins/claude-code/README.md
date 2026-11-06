# Kioku 的 Claude Code 插件

会话开始时注入 Kioku 的启动加载：通用的规则、人格、本应用的记忆与本人的偏好，以及同一会话最近的会话摘要、近期更新的记忆和与当前项目相关的召回。每轮输入时注入召回候选。每轮回复后把这一轮的输入与回复交给 Kioku，攒批后写成会话摘要：摘要归访问密钥所属的成员、私密，只给这个成员不带会话上下文的访问密钥，30 天后清除。另外提供 `kioku_*` MCP 工具读写记忆。

插件只做转发，提示词和输出格式都由服务端决定，服务端更新后不用重装插件。

## 安装

钩子用 Node.js 运行，需要 Node 18 或更新的版本在 `PATH` 里（`node -v` 能看到版本号）。用原生安装包装的 Claude Code 不带 Node，要另外安装。

```text
/plugin install kioku --marketplace lonelyman0108/kioku-plugins
```

较早的 Claude Code 分两步：先 `/plugin marketplace add lonelyman0108/kioku-plugins`，再 `/plugin install kioku@kioku`。

启用时填写两项配置，之后可以在 `/plugin` 里修改：

- **Kioku 服务地址**：例如 `https://kioku.example.com`，不带 `/v1`，末尾不要斜杠
- **访问密钥**：在管理界面的「应用」页为运行时是 claudecode 的应用签发。它存在系统的凭据存储里，不写进 `settings.json`

要让 agent 显式读取机密级记忆（例如导入时标为机密的凭据），签发访问密钥时把最高敏感级设为机密；召回和启动加载永远不含机密内容。

会话摘要要求实例配好抽取模型，访问密钥能写会话摘要、最高敏感级不低于私密；不满足时每轮的内容不留在服务端。

## 从 Lore 切换

先按 [从 Lore 迁移](../../docs/migrate-from-lore.md) 导入并做对照检查（在管理界面的「测试台」里按这个访问密钥模拟，不用真的接上客户端），再停用 Lore 的插件，避免两份启动加载同时注入。

## 排查

钩子失败时不会挡住输入，也不注入任何内容。原因写在标准错误里，用 `claude --debug` 启动可以看到以「Kioku」开头的那一行。服务地址或访问密钥没有配置时，会话开始会提示一次。
