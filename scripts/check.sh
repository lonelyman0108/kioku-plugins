#!/usr/bin/env bash
# 仓库唯一门禁入口：本地、钩子、CI、发布脚本都调用它，各处行为一致。
# 用法：scripts/check.sh [--quick|--full]   --quick 只跑通用检查与 lint；默认 --full
# 每一段都是「step 名称」加命令，任何一步失败立即退出；CI 专有的差异只能是环境变量。
set -euo pipefail
cd "$(dirname "$0")/.."
mode=${1:---full}
case "$mode" in
  --quick|--full) ;;
  *) echo "用法：scripts/check.sh [--quick|--full]" >&2; exit 2 ;;
esac

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1，安装：$2" >&2; exit 1; }; }
# 把 git 跟踪的、匹配给定 pathspec 的文件读进数组 files
tracked() {
  files=()
  while IFS= read -r -d '' f; do files+=("$f"); done < <(git ls-files -z -- "$@")
}

# ---- 通用检查（所有仓都跑） ----
step 注释中的流程编号
scripts/lint/comments.sh

step shellcheck
need shellcheck "brew install shellcheck / apt-get install shellcheck"
tracked '*.sh' '.githooks/*' ':!:*.conf'
[ "${#files[@]}" -eq 0 ] || shellcheck "${files[@]}"

# Gitea 仓的 workflow 在 .gitea/，GitHub 仓的在 .github/；actionlint 只自动发现后者，所以两边都显式传文件和配置
for dir in .gitea .github; do
  tracked "$dir/workflows/*.yml" "$dir/workflows/*.yaml"
  [ "${#files[@]}" -gt 0 ] || continue
  step "actionlint（${dir}）"
  need actionlint "brew install actionlint"
  actionlint -config-file "$dir/actionlint.yaml" "${files[@]}"
done

# >>> 按栈的快速检查：bootstrap --stack 在这里插入，也可以手写
# ---- node ----
# 有 pnpm-lock.yaml 用 pnpm，否则用 npm；typecheck、lint、format:check 三个脚本在 package.json 里定义。
# 还没有 package.json 时跳过整段，只跑上面的通用检查
pm=
if [ -f package.json ]; then
  step 按锁文件安装依赖
  if [ -f pnpm-lock.yaml ]; then
    pm=pnpm
    pnpm install --frozen-lockfile
  else
    pm=npm
    npm ci
  fi
  step 类型检查
  "$pm" run --if-present typecheck
  step lint
  "$pm" run --if-present lint
  step 格式
  "$pm" run --if-present format:check
fi
# <<< 按栈的快速检查

# ---- python ----
# plugins/ 下一层带 pyproject.toml 的目录各是一个 uv 项目：按锁文件装依赖（锁文件过期时失败），
# 跑 ruff 与 pytest。开发工具放在各项目的 dev 依赖组里，lint 只装这一组，不构建项目本身
tracked ':(glob)plugins/*/pyproject.toml'
py_projects=()
if [ "${#files[@]}" -gt 0 ]; then
  for f in "${files[@]}"; do py_projects+=("$(dirname "$f")"); done
  need uv "brew install uv，或见 https://docs.astral.sh/uv/"
  for p in "${py_projects[@]}"; do
    step "Python lint 与格式：$p"
    (cd "$p" && uv run --locked --only-group dev ruff check . &&
      uv run --locked --only-group dev ruff format --check .)
  done
fi

if [ "$mode" = --quick ]; then
  printf '\n快速检查通过\n'
  exit 0
fi

# >>> 按栈的完整检查：bootstrap --stack 在这里插入，也可以手写
# ---- node ----
if [ -n "$pm" ]; then
  step 测试
  "$pm" run --if-present test
fi
# ---- python ----
if [ "${#py_projects[@]}" -gt 0 ]; then
  for p in "${py_projects[@]}"; do
    step "Python 测试：$p"
    (cd "$p" && uv run --locked pytest)
  done
fi
# <<< 按栈的完整检查

printf '\n完整检查通过\n'
