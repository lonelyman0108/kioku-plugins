# 贡献规范

本仓的提交、分支、PR 与发布规则都写在这里；钩子 `.githooks/commit-msg` 与 CI 按同一份规则校验。

## 初始化

克隆后执行一次 `scripts/bootstrap.sh`，它会启用 `.githooks`（`git config core.hooksPath` 应输出 `.githooks`）并检查工具。

## 分支与 PR

- `main` 受保护，所有改动走 PR，只允许 squash 合并，合并后删除分支。
- 分支名 `<type>/<slug>`，例如 `feat/export-csv`；slug 只用小写字母、数字、连字符。
- 用 `scripts/pr.sh` 开 PR 并预约自动合并；门禁相关改动用 `scripts/pr.sh --no-merge`。
- PR 标题就是 main 上的提交标题；描述分三节：变更 / 验证 / 未覆盖。

## 提交规范

格式：`<emoji> <type>(<scope>): <中文主题>`

- 首行 ≤ 72 个字符（中文算 1 个），主题动词开头、末尾不加句号。
- scope 可省，只用小写字母、数字和 `._/-`。不兼容改动在冒号前加 `!`，正文写 `BREAKING CHANGE:`。
- **禁止任何署名或评审 trailer**（`Co-authored-by`、`Signed-off-by`、`Reviewed-on`、`Reviewed-by` 等）。
- 首行不写需求号、阶段号这类流程编号。
- 提交信息和仓库文件里不写私有部署信息（内网地址、自建服务的域名、账号、邮箱）：仓库可能公开，或镜像到公开平台。

| emoji | type | 用途 |
|---|---|---|
| ✨ | feat | 使用者能感知的新功能 |
| 🐛 | fix | 修 bug |
| ⚡️ | perf | 性能优化 |
| ♻️ | refactor | 重构，行为不变 |
| 💄 | style | 不改行为的样式或格式化 |
| ✅ | test | 测试 |
| 📝 | docs | 文档、注释 |
| 📦️ | build | 构建系统、依赖 |
| 👷 | ci | workflow、CI 脚本、钩子 |
| 🔧 | chore | 工程配置、杂项 |
| ⏪️ | revert | 回滚 |
| 🔖 | release | 发布提交 |

扩展类型 🌐 i18n、🎨 design 默认关闭，启用时改 `.githooks/commit.conf` 的 `EXTRA_TYPES`。本仓启用：无

常用 scope：`claude-code`、`astrbot`、`docs`、`ci`

钩子是本地第一道检查，CI 会用同一份规则复核 PR 标题和合并进 main 的提交。

## 受管文件

第二行写着「受管文件，来自 ci-workflows@…」的文件（提交钩子、`scripts/ci/` 下的脚本、`scripts/pr.sh` 等）由维护者从共享的规范仓同步过来，各项目保持一致。不要在本仓直接改：要改的话开 Issue，或在 PR 里说明，由维护者改上游后再同步过来。

## 门禁

`scripts/check.sh`（纯文档改动可用 `--quick`）：注释流程编号、shellcheck、actionlint，以及本仓技术栈的检查。

提交时 pre-commit 还会做两道秒级检查：维护者本机装了私有词表时，拦下暂存内容里的自建服务域名、内网地址等私有信息（词表不在仓库里，没有时跳过）；装了 gitleaks 时检查疑似密钥。

## 发布

<!-- 填写：谁发起发版、release.yml 做什么、怎么部署和回滚 -->
发版由维护者发起并决定版本号；发起后 agent 可以运行改号脚本、提交发布 PR、推送版本 tag，时机按本节的流程，不做维护者没发起的发版，不删除、不移动 tag。CHANGELOG 定稿放在发布 PR（`🔖 release: vX.Y.Z`）里。
