#!/usr/bin/env bash
# 把 packages/ 与 plugins/ 下公开的 npm 包（package.json 里没有 "private": true）发到 npm。
# 只被 release.yml 与 edge.yml 调用，本地用 --dry-run 核对。
# 用法：publish-npm.sh [--dry-run] <tag>
#       publish-npm.sh [--dry-run] --edge <提交>
#   <tag>            版本 tag（vX.Y.Z）：每个要发的包的版本都要等于它，否则不发
#   --edge <提交>    基于该提交生成 <主>.<次>.<修订+1>-edge.<UTC时间>.g<短提交> 并发到 npm edge 标签
#   --dry-run        不上传，只打印每个包会带哪些文件；不要求 npm 的版本
# 认证用 npm 的受信发布（OIDC），不读任何令牌：要 npm 11.5.1 以上，不够时装下面固定的版本。
# 某个版本已经在 npm 上时跳过它，所以发到一半失败后可以重跑。
set -euo pipefail
cd "$(dirname "$0")/../.."

npm_version=11.6.2
dry=0
mode=release
target=

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry=1
      shift
      ;;
    --edge)
      mode=edge
      shift
      if [ $# -eq 0 ] || [[ $1 == -* ]]; then
        echo "用法：publish-npm.sh [--dry-run] <tag> | --edge <提交>" >&2
        exit 2
      fi
      target=$1
      shift
      ;;
    -h|--help)
      awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"
      exit 0
      ;;
    -*)
      echo "未知参数：$1" >&2
      exit 2
      ;;
    *)
      if [ -n "$target" ]; then
        echo "多余的参数：$1" >&2
        exit 2
      fi
      target=$1
      shift
      ;;
  esac
done

[ -n "$target" ] || {
  echo "用法：publish-npm.sh [--dry-run] <tag> | --edge <提交>" >&2
  exit 2
}

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

if [ "$mode" = release ]; then
  case "$target" in
    v[0-9]*.[0-9]*.[0-9]*) version=${target#v} ;;
    *) echo "tag 要是 vX.Y.Z 的样子：${target}" >&2; exit 2 ;;
  esac
  # 先全部核对版本，再开始发：不出现只发了一半的版本
  for dir in "${dirs[@]}"; do
    found=$(node -p 'require(process.argv[1]).version' "./$dir/package.json")
    if [ "$found" != "$version" ]; then
      echo "${dir} 的版本是 ${found}，和 tag ${target} 对不上" >&2
      exit 1
    fi
  done
else
  full_sha=$(git rev-parse --verify "${target}^{commit}")
  short=${full_sha:0:7}
  epoch=$(git show -s --format=%ct "$full_sha")
  stamp=$(node -e '
    const d = new Date(Number(process.argv[1]) * 1000)
    console.log(d.toISOString().replace(/[-:T]/g, "").slice(0, 14))
  ' "$epoch")
  base=
  for dir in "${dirs[@]}"; do
    found=$(node -p 'require(process.argv[1]).version' "./$dir/package.json")
    if ! [[ $found =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "${dir} 的版本是 ${found}，--edge 需要 X.Y.Z 基础版本" >&2
      exit 1
    fi
    if [ -z "$base" ]; then
      base=$found
    elif [ "$found" != "$base" ]; then
      echo "${dir} 的版本是 ${found}，与其他包（${base}）不一致" >&2
      exit 1
    fi
  done
  IFS=. read -r major minor patch <<< "$base"
  version="${major}.${minor}.$((patch + 1))-edge.${stamp}.g${short}"
fi

backup_dir=$(mktemp -d)
copied_files=()
restored_files=()
backup_idx=0

cleanup() {
  local entry src dest
  for entry in "${restored_files[@]+"${restored_files[@]}"}"; do
    src=${entry%%:*}
    dest=${entry#*:}
    cp "$src" "$dest"
  done
  for entry in "${copied_files[@]+"${copied_files[@]}"}"; do
    rm -f "$entry"
  done
  rm -rf "$backup_dir"
}
trap cleanup EXIT

preserve_file() {
  local file=$1
  if [ -e "$file" ]; then
    local snap="${backup_dir}/${backup_idx}.bak"
    backup_idx=$((backup_idx + 1))
    cp "$file" "$snap"
    restored_files+=("${snap}:${file}")
  else
    copied_files+=("$file")
  fi
}

if [ "$mode" = edge ]; then
  for dir in "${dirs[@]}"; do
    manifest="${dir}/package.json"
    preserve_file "$manifest"
    node -e '
      const fs = require("node:fs")
      const file = process.argv[1]
      const ver = process.argv[2]
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
      pkg.version = ver
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
    ' "$manifest" "$version"
  done
fi

if [ "$dry" -eq 0 ]; then
  have=$(npm --version)
  if [ "$(printf '%s\n' 11.5.1 "$have" | sort -V | head -n 1)" != 11.5.1 ]; then
    npm install --global "npm@$npm_version"
  fi
fi

pub_args=(--access public)
[ "$mode" != edge ] || pub_args+=(--tag edge)

for dir in "${dirs[@]}"; do
  name=$(node -p 'require(process.argv[1]).name' "./$dir/package.json")
  # 许可证与声明跟着包走；原本已跟踪的文件在退出时恢复原样
  for doc in LICENSE NOTICE; do
    preserve_file "$dir/$doc"
    cp "$doc" "$dir/$doc"
  done
  if [ "$dry" -eq 1 ]; then
    (cd "$dir" && npm publish --dry-run "${pub_args[@]}")
    continue
  fi
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "${name}@${version} 已经在 npm 上，跳过"
    continue
  fi
  (cd "$dir" && npm publish "${pub_args[@]}")
done

if [ "$dry" -eq 0 ] && [ "$mode" = edge ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## npm edge 预览包"
    echo ""
    echo "- 提交：\`${full_sha}\`"
    echo "- 版本：\`${version}\`"
    echo "- 体验命令：\`npx @kioku-memory/cli@edge\`"
    echo ""
    for dir in "${dirs[@]}"; do
      name=$(node -p 'require(process.argv[1]).name' "./$dir/package.json")
      echo "- \`${name}@${version}\`（dist-tag：\`edge\`）"
    done
  } >> "$GITHUB_STEP_SUMMARY"
fi
