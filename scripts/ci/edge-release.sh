#!/usr/bin/env bash
# 将滚动预发布标签（edge）与 GitHub Pre-release 页面同步到指定提交。
# 只被 edge.yml 在 npm edge 预览包发布成功后调用；本地可用 --dry-run 核对正文。
#
# 用法：edge-release.sh [--dry-run]
#   --dry-run  只打印将要提交的标题、标签指向与正文，不调 GitHub API，不要求 GH_TOKEN
# 环境变量：
#   COMMIT             40 位十六进制提交 SHA（必需）
#   EDGE_VERSION       已发布的 npm edge 预览版本号（必需）
#   PACKAGES           已发布的 npm 包名列表，空格分隔（可选；缺省时扫描仓库公开包）
#   GITHUB_REPOSITORY  owner/repo（Actions 自动提供，必需）
#   GITHUB_SERVER_URL  默认 https://github.com
#   RUN_URL            本次 workflow 运行链接（可选）
#   GH_TOKEN           GitHub 令牌，需要 contents: write（非 --dry-run 时必需）
set -euo pipefail

dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry=1
      shift
      ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
done

tag=edge
commit=${COMMIT:?缺少 COMMIT}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || {
  echo "COMMIT 必须是 40 位小写十六进制提交 SHA：${commit}" >&2
  exit 2
}

edge_version=${EDGE_VERSION:?缺少 EDGE_VERSION}
[[ $edge_version =~ ^[0-9]+\.[0-9]+\.[0-9]+-edge\.[0-9]{14}\.g[0-9a-f]{7,}$ ]] || {
  echo "EDGE_VERSION 格式不正确：${edge_version}" >&2
  exit 2
}

repo=${GITHUB_REPOSITORY:?缺少 GITHUB_REPOSITORY}
server=${GITHUB_SERVER_URL:-https://github.com}
server=${server%/}
run_url=${RUN_URL:-}
short=${commit:0:7}
updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

pkg_names=()
if [ -n "${PACKAGES:-}" ]; then
  read -r -a pkg_names <<< "$PACKAGES"
elif command -v node >/dev/null 2>&1; then
  repo_root=$(cd "$(dirname "$0")/../.." && pwd)
  for manifest in "$repo_root"/packages/*/package.json "$repo_root"/plugins/*/package.json; do
    [ -f "$manifest" ] || continue
    if [ "$(node -p 'require(process.argv[1]).private === true' "$manifest")" = false ]; then
      pkg_names+=("$(node -p 'require(process.argv[1]).name' "$manifest")")
    fi
  done
fi

commit_subject=
prev_tag=
prev_sha=
if git rev-parse --git-dir >/dev/null 2>&1 && git cat-file -e "${commit}^{commit}" 2>/dev/null; then
  commit_subject=$(git show -s --format=%s "$commit" 2>/dev/null || true)
  prev_tag=$(
    git tag -l 'v[0-9]*' --sort=-version:refname --merged "$commit" 2>/dev/null \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
      | head -n 1 || true
  )
  if [ -n "$prev_tag" ]; then
    prev_sha=$(git rev-parse "${prev_tag}^{commit}" 2>/dev/null || true)
  fi
fi

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT

{
  printf "%s\n\n" "主干 \`main\` 通过 CI 且 npm \`edge\` 预览包发布完成后自动更新的滚动预发布构建，供体验未发布改动，不代表正式版。"
  printf -- "- 提交：\`%s\`（\`%s\`）\n" "$commit" "$short"
  if [ -n "$commit_subject" ]; then
    printf -- "- 提交主题：%s\n" "$commit_subject"
  fi
  printf -- "- npm 预览版本：\`%s\`（dist-tag：\`edge\`）\n" "$edge_version"
  printf -- "- 更新时间（UTC）：\`%s\`\n" "$updated_at"
  if [ -n "$run_url" ]; then
    printf -- "- 构建记录：%s\n" "$run_url"
  fi
  if [ -n "$prev_tag" ]; then
    if [ "$prev_sha" = "$commit" ]; then
      printf -- "- 相对 \`%s\`：同一提交\n" "$prev_tag"
    else
      printf -- "- 相对 \`%s\` 的变更：%s/%s/compare/%s...%s\n" "$prev_tag" "$server" "$repo" "$prev_tag" "$short"
    fi
  fi
  printf "\n### npm 预览包\n\n"
  printf "%s\n\n" "快速体验：\`npx @kioku-memory/cli@edge\`"
  if [ "${#pkg_names[@]}" -gt 0 ]; then
    for name in "${pkg_names[@]}"; do
      printf -- "- \`%s@%s\`（安装：\`npm install %s@edge\`）\n" "$name" "$edge_version" "$name"
    done
  fi
} > "$notes_file"

if [ "$dry" -eq 1 ]; then
  printf '仓库：%s\n标签：refs/tags/%s -> %s\n标题：%s（预发布：true，Latest：false）\n----\n' \
    "$repo" "$tag" "$commit" "$tag"
  cat "$notes_file"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "缺少 gh" >&2; exit 2; }
[ -n "${GH_TOKEN:-}" ] || { echo "缺少 GH_TOKEN" >&2; exit 2; }

# 先通过 Git Data Refs API 移动或创建 refs/tags/edge：
# GitHub Release API 在同名 tag 已存在时会忽略 target_commitish，不能只靠 gh release edit --target 改指向。
existing_ref=$(
  gh api "repos/${repo}/git/ref/tags/${tag}" \
    --jq 'if type == "object" then (.ref // "") else "" end' 2>/dev/null || true
)
if [ "$existing_ref" = "refs/tags/${tag}" ]; then
  gh api --method PATCH "repos/${repo}/git/refs/tags/${tag}" \
    -f sha="$commit" \
    -F force=true >/dev/null
else
  gh api --method POST "repos/${repo}/git/refs" \
    -f ref="refs/tags/${tag}" \
    -f sha="$commit" >/dev/null
fi

if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release edit "$tag" --repo "$repo" \
    --title "$tag" \
    --notes-file "$notes_file" \
    --prerelease \
    --latest=false
  echo "已更新滚动预发布 ${tag} -> ${short}（${edge_version}）"
else
  gh release create "$tag" --repo "$repo" \
    --verify-tag \
    --title "$tag" \
    --notes-file "$notes_file" \
    --prerelease \
    --latest=false
  echo "已创建滚动预发布 ${tag} -> ${short}（${edge_version}）"
fi
