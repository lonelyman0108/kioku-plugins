# kioku-plugins 平台与环境设置

平台设置一改，就在同一个 PR 里更新本文。这里只写密钥的**名字**和用途，不写值；仓库地址、内网地址这类私有信息也不写（仓库可能公开）。

## 仓库设置

| 项 | 值 |
|---|---|
| 托管 | GitHub，公开；许可证见 `LICENSE` |
| 合并方式 | 只允许 squash，默认标题取 PR 标题、正文取 PR 描述；合并后自动删除分支 |
| Auto-merge | 开启（`scripts/pr.sh` 用 `gh pr merge --auto`） |
| Actions 令牌权限 | 默认只读；发布用的 workflow 自己声明 `contents: write`（推 GHCR 另加 `packages: write`） |
| 提交邮箱 | 用 GitHub 的 noreply 地址（本仓 `git config user.email`），账号设置里勾选「Keep my email addresses private」 |

合并选项（一次设好）：

```bash
gh api -X PATCH repos/{owner}/{repo} -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

`main` 的规则集（`gate` 是 `ci.yml` 里唯一 job 的检查名）：

```bash
gh api repos/{owner}/{repo}/rulesets -X POST --input - <<'JSON'
{"name":"main","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,
   "require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false,
   "allowed_merge_methods":["squash"]}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,
   "required_status_checks":[{"context":"gate"}]}}]}
JSON
```

还没有 CI 时先去掉 `required_status_checks` 一条，第一次 PR 跑出检查后再加。私有仓库的规则集需要 GitHub Pro 才生效；不生效时 `scripts/pr.sh` 会检测到没有必需检查，不预约自动合并。

受保护标签：规则集 `release-tags`，匹配 `refs/tags/v*`，禁止创建、更新、删除和强推，仓库管理员可以绕过，也就是只有维护者能打版本 tag：

```bash
gh api repos/{owner}/{repo}/rulesets -X POST --input - <<'JSON'
{"name":"release-tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"},{"type":"non_fast_forward"}]}
JSON
```

## Secrets 与 Variables

| 名字 | 级别 | 用途 | 使用位置 |
|---|---|---|---|
| — | — | 目前不需要额外 secret：发布用 `github.token`，推 GHCR 也用它 | — |

<!-- 推 Docker Hub 时加仓库 secret `REGISTRY_USER`、`REGISTRY_TOKEN`，并在 release.yml 里设 `IMAGE` -->

## Runner

| workflow | runs-on | 说明 |
|---|---|---|
| `ci.yml` | `ubuntu-24.04` | 必需检查 `gate` |

## 本机凭据

| 来源 | 用途 |
|---|---|
| `gh auth login` 的登录状态 | `scripts/pr.sh` 开 PR、预约合并 |

## 部署位置

<!-- 主机、商店或镜像名；版本号写死的位置 -->

## 外部依赖到期

<!-- 令牌、证书、域名、商店证书等的到期日和续期方式；没有就写「无」 -->

## 重建步骤

1. 从备份或任意 clone 恢复仓库，推到新的远端。
2. 按上文设置仓库、保护规则和 secrets。
3. 克隆后运行 `scripts/bootstrap.sh`，再跑 `scripts/check.sh`。

## 演练记录

| 日期 | 内容 | 结果 |
|---|---|---|

## npm

| 项 | 值 |
|---|---|
| 组织 | `kioku-memory`（scope `@kioku-memory`），公开包 |
| 包 | `@kioku-memory/cli`（目录 `packages/cli`） |
| 认证 | 受信发布（OIDC），没有 npm 令牌，仓库里也没有对应的 secret |

每个包在 npmjs.com 的 Settings › Trusted Publisher 里配一个 GitHub Actions 发布者：

| 字段 | 值 |
|---|---|
| Organization or user | 本仓库的所有者 |
| Repository | 本仓库的名字 |
| Workflow filename | `release.yml` |
| Environment name | 留空 |
| Allowed actions | 勾上 `npm publish`（只留默认的 `npm stage publish` 时 workflow 发不出去） |

包要先存在才能配，所以新包的第一个版本由维护者在本机发一个占位版本（仓库里新包的版本写 `0.0.0`）：

```bash
node scripts/sync-core.mjs --check
cd packages/<包目录> && npm publish --access public
```

配好受信发布之后的版本都由 `release.yml` 发。受信发布要 npm 11.5.1、Node 22.14 以上，只认 GitHub 托管的 runner；`scripts/ci/publish-npm.sh` 在 npm 版本不够时装一个固定的版本。
