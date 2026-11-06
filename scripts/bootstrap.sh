#!/usr/bin/env bash
# 每次克隆后运行一次：启用 .githooks、检查工具。
# 新项目首次运行时加 --stack 选技术栈（只做一次，完成后删除 templates/）：
#   scripts/bootstrap.sh --stack go              栈：generic / go / node / java / docker / swift（ios、ios-macos 同 swift）
#   scripts/bootstrap.sh --stack go,node         多个栈用逗号分隔，第一个栈决定 runner label
#   --platform gitea|github                      托管平台，默认 gitea；github 时 workflow、工单与 PR 模板放进 .github/
#   --license mit|apache-2.0|none                许可证；--platform github 时必填，apache-2.0 同时生成 NOTICE
#   --holder <名字>                              许可证里的版权人；默认取 GitHub 登录名，取不到时用 git 的 user.name
#   --name <名称>                                填进 README 等文件的项目名，默认取目录名
#   --description <一句话>                        填进 README 的简介
#   --release / --no-release                     覆盖栈的默认值，决定是否启用 release.yml
#   --nightly                                    同时启用 nightly.yml
# 以后再运行（不带 --stack）只做启用钩子与工具检查。每一步都可重复执行。
set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf '%s\n' "$*" >&2; exit 1; }
stacks=
release=
nightly=0
platform=
license=
holder=
name=
description=
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) stacks=${2:?--stack 需要参数}; shift 2 ;;
    --platform) platform=${2:?--platform 需要参数}; shift 2 ;;
    --license) license=${2:?--license 需要参数}; shift 2 ;;
    --holder) holder=${2:?--holder 需要参数}; shift 2 ;;
    --name) name=${2:?--name 需要参数}; shift 2 ;;
    --description) description=${2:?--description 需要参数}; shift 2 ;;
    --release) release=yes; shift ;;
    --no-release) release=no; shift ;;
    --nightly) nightly=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done
if [ -z "$stacks" ] && [ -n "$platform$license$holder$name$description" ]; then
  die "--platform、--license、--holder、--name、--description 只在首次初始化（带 --stack）时用"
fi

# 在 check.sh 的「# <<< 标记」前插入片段；片段首行（# ---- 栈 ----）已存在时跳过
insert_part() {
  local part=$1 marker=$2 head
  [ -s "$part" ] || return 0
  head=$(sed -n 1p "$part")
  grep -qxF -- "$head" scripts/check.sh && return 0
  awk -v f="$part" -v m="# <<< $marker" '$0 == m { while ((getline l < f) > 0) print l; close(f) } { print }' \
    scripts/check.sh > scripts/check.sh.tmp
  cat scripts/check.sh.tmp > scripts/check.sh
  rm -f scripts/check.sh.tmp
}

# 把工作流模板放到位并替换 runner label（超时沿用模板里的值）
render_workflow() {
  local src=$1 dst=$2
  sed -e "s/__RUNS_ON__/$runs_on/" "$src" > "$dst.tmp"
  mv "$dst.tmp" "$dst"
}

# 把文件里的占位文字原样换成给定内容；占位和内容都不当正则处理，内容里的 & / \ 也不会被转义
replace_text() {
  local file=$1
  K=$2 V=$3 awk '{
    out = ""; rest = $0
    while ((i = index(rest, ENVIRON["K"])) > 0) {
      out = out substr(rest, 1, i - 1) ENVIRON["V"]
      rest = substr(rest, i + length(ENVIRON["K"]))
    }
    print out rest
  }' "$file" > "$file.tmp"
  cat "$file.tmp" > "$file"
  rm -f "$file.tmp"
}

# docs/SETUP.md 的「平台设置」两行标记之间是 Gitea 的版本：给出文件时换成该文件的内容；标记行随后删掉
render_setup() {
  local repl=$1
  [ -f docs/SETUP.md ] || return 0
  awk -v f="$repl" '
    /^<!-- >>> 平台设置/ { if (f != "") { while ((getline l < f) > 0) print l; close(f); skip = 1 } next }
    /^<!-- <<< 平台设置/ { skip = 0; next }
    !skip { print }
  ' docs/SETUP.md > docs/SETUP.md.tmp
  cat docs/SETUP.md.tmp > docs/SETUP.md
  rm -f docs/SETUP.md.tmp
}

if [ -n "$stacks" ]; then
  [ -d templates/stacks ] || die "templates/ 已不存在：栈初始化只在新项目首次运行时做一次"
  platform=${platform:-gitea}
  case "$platform" in gitea|github) ;; *) die "未知平台：${platform}（可选：gitea、github）" ;; esac
  case "$license" in ''|mit|apache-2.0|none) ;; *) die "未知许可证：${license}（可选：mit、apache-2.0、none）" ;; esac
  [ "$platform" != github ] || [ -n "$license" ] || die "--platform github 时要用 --license 选许可证，不公开写 none"
  license=${license:-none}

  # gh 已登录时取 GitHub 登录名与 noreply 地址：版权人默认用登录名，公开仓的提交邮箱建议用 noreply
  gh_login=
  gh_noreply=
  if { [ "$platform" = github ] || [ "$license" != none ]; } && command -v gh >/dev/null 2>&1; then
    if user=$(gh api user --jq '"\(.login) \(.id)"' 2>/dev/null) && [ -n "$user" ]; then
      gh_login=${user% *}
      gh_noreply="${user#* }+${gh_login}@users.noreply.github.com"
    fi
  fi
  if [ "$license" != none ]; then
    holder=${holder:-${gh_login:-$(git config user.name 2>/dev/null || true)}}
    [ -n "$holder" ] || die "取不到许可证的版权人：用 --holder 指定"
  fi
  name=${name:-$(basename "$(pwd -P)")}

  # 变量替换：Gitea 网页「使用此模板」时已经替换过的不会再变，本地克隆或在 GitHub 建仓时由这里补上
  if [ -f .gitea/template ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ -f "$f" ] || continue
      # shellcheck disable=SC2016  # 单引号里是模板占位的字面量
      replace_text "$f" '$REPO_NAME' "$name"
      # shellcheck disable=SC2016
      replace_text "$f" '$REPO_DESCRIPTION' "${description:-<!-- 一句话：这个项目做什么 -->}"
    done < .gitea/template
  fi

  # 模板按 Gitea 的目录布局放文件；GitHub 时把工单与 PR 模板挪进 .github/，换上 GitHub 的 workflow 与设置说明
  pdir=.gitea
  if [ "$platform" = github ]; then
    pdir=.github
    mkdir -p .github/workflows
    for f in ISSUE_TEMPLATE PULL_REQUEST_TEMPLATE.md; do
      [ ! -e ".gitea/$f" ] || mv ".gitea/$f" ".github/$f"
    done
    cp templates/platforms/github/actionlint.yaml .github/actionlint.yaml
    cp templates/platforms/github/workflows/ci.yml .github/workflows/ci.yml
    render_setup templates/platforms/github/setup.md
    rm -rf .gitea
  else
    render_setup ''
  fi
  echo "平台：${platform}（workflow 在 $pdir/workflows）"

  runs_on=
  timeout=
  stack_release=no
  release_workflow=release.yml
  IFS=, read -r -a list <<< "$stacks"
  for s in "${list[@]}"; do
    case "$s" in ios|ios-macos|macos) s=swift ;; esac
    dir=templates/stacks/$s
    [ -d "$dir" ] || die "未知栈：${s}（可选：$(cd templates/stacks && echo *)）"
    RUNS_ON=''
    RUNS_ON_GITHUB=''
    TIMEOUT=''
    RELEASE=no
    RELEASE_WORKFLOW=
    # shellcheck source=/dev/null
    . "$dir/stack.conf"
    if [ "$platform" = github ] && [ -n "$RUNS_ON_GITHUB" ]; then RUNS_ON=$RUNS_ON_GITHUB; fi
    [ -n "$runs_on" ] || { runs_on=$RUNS_ON; timeout=$TIMEOUT; }
    [ "$RELEASE" = yes ] && stack_release=yes
    # 栈自带的发布 workflow（例如 docker 的构建推送）优先于通用的 release.yml
    [ -z "$RELEASE_WORKFLOW" ] || release_workflow=$RELEASE_WORKFLOW
    # 栈附带的脚本（例如 scripts/ci/docker-release.sh）按相对路径放进仓库
    if [ -d "$dir/files" ]; then
      cp -R "$dir/files/." .
    fi
    insert_part "$dir/check-quick.part" 按栈的快速检查
    insert_part "$dir/check-full.part" 按栈的完整检查
    if [ -s "$dir/gitignore.part" ] && ! grep -qxF -- "$(sed -n 1p "$dir/gitignore.part")" .gitignore; then
      { echo; cat "$dir/gitignore.part"; } >> .gitignore
    fi
    echo "已应用栈 $s"
  done
  release=${release:-$stack_release}

  sed -e "s/__RUNS_ON__/$runs_on/" -e "s/^\(    timeout-minutes: \)[0-9][0-9]*/\1$timeout/" \
    "$pdir/workflows/ci.yml" > "$pdir/workflows/ci.yml.tmp"
  mv "$pdir/workflows/ci.yml.tmp" "$pdir/workflows/ci.yml"
  echo "ci.yml：runs-on ${runs_on}，timeout-minutes $timeout"
  [ ! -f docs/SETUP.md ] || replace_text docs/SETUP.md '<!-- label -->' "\`$runs_on\`"
  if [ "$release" = yes ]; then
    render_workflow "templates/platforms/$platform/workflows/$release_workflow" "$pdir/workflows/release.yml"
    echo "已启用 release.yml（取自 ${release_workflow}）"
  fi
  if [ "$nightly" -eq 1 ]; then
    render_workflow "templates/platforms/$platform/workflows/nightly.yml" "$pdir/workflows/nightly.yml"
    echo "已启用 nightly.yml"
  fi

  if [ "$license" != none ]; then
    if [ "$license" = mit ]; then
      cp templates/licenses/MIT LICENSE
      license_line='[MIT](LICENSE)'
    else
      cp templates/licenses/Apache-2.0 LICENSE
      cp templates/licenses/NOTICE NOTICE
      # shellcheck disable=SC2016
      replace_text NOTICE '$REPO_NAME' "$name"
      license_line='[Apache-2.0](LICENSE)，第三方声明见 [NOTICE](NOTICE)'
    fi
    for f in LICENSE NOTICE; do
      [ -f "$f" ] || continue
      # shellcheck disable=SC2016
      replace_text "$f" '$YEAR' "$(date +%Y)"
      # shellcheck disable=SC2016
      replace_text "$f" '$HOLDER' "$holder"
    done
    [ ! -f README.md ] || replace_text README.md '<!-- 许可证：bootstrap.sh --license 会填在这里；不公开的项目可以删掉本节 -->' "$license_line"
    echo "许可证：${license}（版权人 ${holder}）"
  fi

  # 模板专用文件：生成的新仓不再需要
  rm -rf templates
  rm -f .gitea/template

  if [ -n "$gh_noreply" ] && [ "$(git config user.email 2>/dev/null || true)" != "$gh_noreply" ]; then
    echo "提示：公开仓的提交邮箱建议用 GitHub noreply：git config user.email $gh_noreply"
  elif [ "$platform" = github ] && [ -z "$gh_noreply" ]; then
    echo "提示：公开仓的提交邮箱建议用 GitHub noreply（<id>+<用户名>@users.noreply.github.com），用 git config user.email 设置"
  fi
fi

if grep -qs '__RUNS_ON__' .gitea/workflows/*.yml .github/workflows/*.yml; then
  echo "提示：workflow 的 runs-on 还是占位 __RUNS_ON__，运行 scripts/bootstrap.sh --stack <栈> 或手工改成 runner label" >&2
fi

chmod +x .githooks/commit-msg .githooks/pre-commit
git config core.hooksPath .githooks
echo "core.hooksPath = $(git config core.hooksPath)"

echo "工具检查："
for t in shellcheck actionlint jq curl gh gitleaks git-cliff; do
  case "$t" in
    shellcheck|actionlint) level=必需 ;;
    jq|curl) level='Gitea 仓的 pr.sh 与发布' ;;
    gh) level='GitHub 仓的 pr.sh' ;;
    *) level=可选 ;;
  esac
  if command -v "$t" >/dev/null 2>&1; then
    printf '  有  %-11s（%s）\n' "$t" "$level"
  else
    printf '  缺  %-11s（%s，brew install %s）\n' "$t" "$level" "$t"
  fi
done
echo "初始化完成"
