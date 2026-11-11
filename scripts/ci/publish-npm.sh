#!/usr/bin/env bash
# 把 packages/ 与 plugins/ 下公开的 npm 包（package.json 里没有 "private": true）发到 npm。只被 release.yml 调用，本地用 --dry-run 核对。
# 用法：publish-npm.sh [--dry-run] <tag>
#   <tag>      版本 tag（vX.Y.Z）：每个要发的包的版本都要等于它，否则不发
#   --dry-run  不上传，只打印每个包会带哪些文件；不要求 npm 的版本
# 认证用 npm 的受信发布（OIDC），不读任何令牌：要 npm 11.5.1 以上，不够时装下面固定的版本。
# 某个版本已经在 npm 上时跳过它，所以发到一半失败后可以重跑。
set -euo pipefail
cd "$(dirname "$0")/../.."

npm_version=11.6.2
dry=0
if [ "${1:-}" = --dry-run ]; then dry=1; shift; fi
tag=${1:?用法：publish-npm.sh [--dry-run] <tag>}
case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) version=${tag#v} ;;
  *) echo "tag 要是 vX.Y.Z 的样子：${tag}" >&2; exit 2 ;;
esac

# 副本要和 packages/core 一致：发出去的就是这些副本
node scripts/sync-core.mjs --check

# 要发的包的目录：有 package.json、不是 private
dirs=()
for manifest in packages/*/package.json plugins/*/package.json; do
  [ -f "$manifest" ] || continue
  if [ "$(node -p 'require(process.argv[1]).private === true' "./$manifest")" = false ]; then
    dirs+=("$(dirname "$manifest")")
  fi
done
[ "${#dirs[@]}" -gt 0 ] || { echo "没有要发的包" >&2; exit 1; }

# 先全部核对版本，再开始发：不出现只发了一半的版本
for dir in "${dirs[@]}"; do
  found=$(node -p 'require(process.argv[1]).version' "./$dir/package.json")
  if [ "$found" != "$version" ]; then
    echo "${dir} 的版本是 ${found}，和 tag ${tag} 对不上" >&2
    exit 1
  fi
done

if [ "$dry" -eq 0 ]; then
  have=$(npm --version)
  if [ "$(printf '%s\n' 11.5.1 "$have" | sort -V | head -n 1)" != 11.5.1 ]; then
    npm install --global "npm@$npm_version"
  fi
fi

for dir in "${dirs[@]}"; do
  name=$(node -p 'require(process.argv[1]).name' "./$dir/package.json")
  # 许可证与声明跟着包走
  cp LICENSE NOTICE "$dir/"
  if [ "$dry" -eq 1 ]; then
    (cd "$dir" && npm publish --dry-run --access public)
    continue
  fi
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "${name}@${version} 已经在 npm 上，跳过"
    continue
  fi
  (cd "$dir" && npm publish --access public)
done
