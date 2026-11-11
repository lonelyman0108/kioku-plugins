#!/usr/bin/env bash
# 发版时改版本号：把 packages/ 与 plugins/ 下公开的 npm 包（package.json 里没有 "private": true）的版本改成给定的版本。
# 用法：scripts/bump-version.sh [--dry-run] <X.Y.Z>
# 只改文件，不提交、不打 tag；流程见 CONTRIBUTING.md「发布」。
set -euo pipefail
cd "$(dirname "$0")/.."

dry=0
if [ "${1:-}" = --dry-run ]; then dry=1; shift; fi
version=${1:?用法：scripts/bump-version.sh [--dry-run] <X.Y.Z>}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本要是 X.Y.Z 的样子：${version}" >&2
  exit 2
fi

for manifest in packages/*/package.json plugins/*/package.json; do
  [ -f "$manifest" ] || continue
  [ "$(node -p 'require(process.argv[1]).private === true' "./$manifest")" = false ] || continue
  old=$(node -p 'require(process.argv[1]).version' "./$manifest")
  echo "${manifest}：${old} → ${version}"
  [ "$dry" -eq 1 ] || (cd "$(dirname "$manifest")" && npm pkg set "version=$version")
done
