#!/usr/bin/env bash
# 受管文件，来自 ci-workflows@v2.0.0 的 scripts/release-page.sh：不在本仓直接改，见 CONTRIBUTING.md「受管文件」
# 为 tag 建立或更新 Release：标题 = tag，正文 = CHANGELOG.md 里对应版本的一节，
# 可再追加一段产物清单（镜像地址、二进制文件名等）。同名 Release 已存在时改为更新。
# GITHUB_SERVER_URL 是 https://github.com 时用 gh，否则调 Gitea API。
#
# 用法：release-page.sh [--dry-run] [--notes <文件>] <tag>
#   --dry-run      只打印将要提交的正文，不调 API（本地核对 CHANGELOG 一节用）
#   --notes <文件>  追加到正文末尾的产物清单
# 环境变量（Actions 里自动提供）：GITHUB_SERVER_URL、GITHUB_REPOSITORY；令牌由 workflow 用 ${{ github.token }} 经 env 传入：
#   GitHub：GH_TOKEN（workflow 要有 contents: write）。依赖 gh。
#   Gitea：TOKEN 或 GITEA_TOKEN（要有 releases 写权限）。依赖 curl、jq。
set -euo pipefail

dry=0
notes=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --notes) notes=${2:?--notes 需要文件路径}; shift 2 ;;
    -h|--help) awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) break ;;
  esac
done
tag=${1:?用法：release-page.sh [--dry-run] [--notes <文件>] <tag>}
version=${tag#v}
changelog=${CHANGELOG:-CHANGELOG.md}

[ -f "$changelog" ] || { echo "找不到 $changelog" >&2; exit 1; }
# 截取「## [X.Y.Z]」到下一个「## 」之间的内容，去掉首尾空行
section=$(awk -v v="$version" '
  index($0, "## [" v "]") == 1 { on = 1; next }
  on && /^## / { exit }
  on { print }
' "$changelog" | sed -e '/./,$!d' | awk '{ a[NR] = $0 } END { n = NR; while (n > 0 && a[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print a[i] }')
if [ -z "$section" ]; then
  echo "$changelog 里没有「## [$version]」一节，先把本版 CHANGELOG 定稿再打 tag" >&2
  exit 1
fi

body=$section
if [ -n "$notes" ]; then
  [ -f "$notes" ] || { echo "找不到 $notes" >&2; exit 1; }
  body=$(printf '%s\n\n%s\n' "$body" "$(cat "$notes")")
fi

prerelease=false
case "$version" in *-*) prerelease=true ;; esac

if [ "$dry" -eq 1 ]; then
  printf '标题：%s（预发布：%s）\n----\n%s\n' "$tag" "$prerelease" "$body"
  exit 0
fi

server=${GITHUB_SERVER_URL:?缺少 GITHUB_SERVER_URL}
repo=${GITHUB_REPOSITORY:?缺少 GITHUB_REPOSITORY}

if [ "${server%/}" = https://github.com ]; then
  command -v gh >/dev/null 2>&1 || { echo "缺少 gh" >&2; exit 2; }
  [ -n "${GH_TOKEN:-}" ] || { echo "缺少 GH_TOKEN" >&2; exit 2; }
  notes_file=$(mktemp)
  trap 'rm -f "$notes_file"' EXIT
  printf '%s\n' "$body" > "$notes_file"
  pre=()
  [ "$prerelease" = false ] || pre=(--prerelease)
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    gh release edit "$tag" --repo "$repo" --title "$tag" --notes-file "$notes_file" ${pre[@]+"${pre[@]}"}
    echo "已更新 Release $tag"
  else
    gh release create "$tag" --repo "$repo" --title "$tag" --notes-file "$notes_file" --verify-tag ${pre[@]+"${pre[@]}"}
    echo "已创建 Release $tag"
  fi
  exit 0
fi

for t in curl jq; do
  command -v "$t" >/dev/null 2>&1 || { echo "缺少 $t" >&2; exit 2; }
done
token=${TOKEN:-${GITEA_TOKEN:-}}
[ -n "$token" ] || { echo "缺少 TOKEN（或 GITEA_TOKEN）" >&2; exit 2; }
api="$server/api/v1/repos/$repo"
auth=(-H "Authorization: token $token" -H "Content-Type: application/json")

payload=$(jq -n --arg tag "$tag" --arg body "$body" --argjson pre "$prerelease" \
  '{tag_name: $tag, name: $tag, body: $body, draft: false, prerelease: $pre}')

resp=$(mktemp)
trap 'rm -f "$resp"' EXIT
code=$(curl -sS -o "$resp" -w '%{http_code}' "${auth[@]}" "$api/releases/tags/$tag")
if [ "$code" = 200 ]; then
  id=$(jq -r .id "$resp")
  curl -fsS -o /dev/null -X PATCH "${auth[@]}" -d "$payload" "$api/releases/$id"
  echo "已更新 Release ${tag}（id ${id}）"
elif [ "$code" = 404 ]; then
  curl -fsS -o /dev/null -X POST "${auth[@]}" -d "$payload" "$api/releases"
  echo "已创建 Release $tag"
else
  echo "查询 Release 失败：HTTP $code" >&2
  cat "$resp" >&2 || true
  exit 1
fi
