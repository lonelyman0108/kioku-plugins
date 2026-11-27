# Kioku 的 ZCode 插件

把 Kioku 接到 ZCode：会话开始时注入启动加载，每轮输入时注入召回候选，每轮结束后把该轮对话提交给 Kioku 提炼会话摘要，并通过内置 stdio MCP 桥接提供 Kioku 记忆工具。

## 接入

### 方式一：一条命令接入（推荐）

```bash
npx @kioku-memory/cli connect zcode --server-url https://kioku.example.com
```

浏览器授权后自动写入 `~/.config/kioku/zcode.json`，并自动把内置插件目录注册到 ZCode 插件市场并启用 `kioku@kioku`。

### 方式二：手动安装

1. 写入地址与访问密钥：

```bash
npx @kioku-memory/cli login zcode --server-url https://kioku.example.com
```

（不想走浏览器授权时改用 `npx @kioku-memory/cli setup zcode --server-url https://kioku.example.com`。）

2. 在终端注册并启用插件：

```bash
git clone https://github.com/lonelyman0108/kioku-plugins
zcode plugins marketplace add /path/to/kioku-plugins/plugins/zcode
zcode plugins install kioku@kioku
zcode plugins enable kioku@kioku
```

3. 检查接入状态：

```bash
npx @kioku-memory/cli doctor zcode
```

## 工作方式

- **配置来源**：地址与访问密钥保存在 `~/.config/kioku/zcode.json`（仅当前用户可读），不写入插件清单或命令行参数。
- **生命周期钩子（`hooks/hooks.json`）**：
  - `SessionStart`（`startup|resume|clear`）：向 Kioku 请求启动加载并以 `hookSpecificOutput.additionalContext` 注入。
  - `UserPromptSubmit`：每轮输入按混合检索召回候选记忆，同时缓存本轮用户输入。
  - `Stop`：将本轮用户输入与助手回复提交给 `turn.end` 提炼会话摘要（优先使用 `last_assistant_message`，缺失时回退读取 `transcript_path` 末尾 JSONL）。
  - 任意服务或解析错误均静默放行（退出码 `0`、空标准输出），不阻塞正常对话。
- **MCP 记忆工具（`.mcp.json`）**：声明 `kioku` stdio 服务，由 `hooks/mcp-stdio.mjs` 转发 JSON-RPC 2.0 请求到 Kioku 的 `/v1/mcp` Streamable HTTP 端点。
