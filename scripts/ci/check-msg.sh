#!/usr/bin/env bash
# 受管文件，来自 ci-workflows@v2.0.0 的 scripts/check-msg.sh：不在本仓直接改，见 CONTRIBUTING.md「受管文件」
# CI 复核提交信息，规则全部在 commit-msg 钩子里，这里只负责取出要查的信息：
#   PR 事件（PR_TITLE 非空）：查 PR 标题，它就是 squash 后 main 上的提交标题；
#   push 事件：逐条查 BEFORE..HEAD 之间新进入的提交（不含合并提交），取不到 BEFORE 时只查 HEAD。
# 环境变量：PR_TITLE、BEFORE 由 workflow 经 env 传入；COMMIT_MSG_HOOK 可改钩子路径（默认 .githooks/commit-msg）。
set -euo pipefail
hook=${COMMIT_MSG_HOOK:-.githooks/commit-msg}
[ -x "$hook" ] || { echo "找不到可执行的 $hook" >&2; exit 2; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

if [ -n "${PR_TITLE:-}" ]; then
  title=$PR_TITLE
  # WIP 前缀表示还没做完（Gitea 据此阻止合并），不属于最终标题
  case "$title" in
    WIP:*) title=${title#WIP:} ;;
    '[WIP]'*) title=${title#\[WIP\]} ;;
  esac
  title=${title# }
  printf '%s\n' "$title" > "$tmp"
  "$hook" "$tmp"
  echo "PR 标题检查通过"
  exit 0
fi

before=${BEFORE:-}
if [ -z "$before" ] || [[ "$before" =~ ^0+$ ]] || ! git cat-file -e "$before^{commit}" 2>/dev/null; then
  commits=$(git rev-parse HEAD)
else
  commits=$(git rev-list --no-merges "$before..HEAD")
fi
fail=0
n=0
for c in $commits; do
  n=$((n + 1))
  git log -1 --format=%B "$c" > "$tmp"
  "$hook" "$tmp" || { echo "  ↑ 提交 ${c:0:7}" >&2; fail=1; }
done
[ "$fail" -ne 0 ] || echo "提交信息检查通过（$n 条）"
exit "$fail"
