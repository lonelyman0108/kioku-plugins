#!/usr/bin/env bash
# 受管文件，来自 ci-workflows@v2.0.0 的 scripts/lint-comments.sh：不在本仓直接改，见 CONTRIBUTING.md「受管文件」
# 注释与文案里的流程编号检查。
#
# 代码注释、脚本与 AGENTS.md 只讲代码本身：需求号、验收号、章节号、阶段号、决议号、画板号、
# 迭代版本标记这类编号读者无从查证，约束应当直接写出内容。编号只允许出现在过程文档里
# （默认 docs/ 与 CHANGELOG.md），本脚本不扫它们。pnpm 锁文件里的哈希和包名会误中编号规则，默认也不扫。
#
# 用法：
#   lint-comments.sh            扫全仓受检文件
#   lint-comments.sh --staged   只查暂存区新增行（pre-commit 钩子调用）
# 命中逐条打印「文件:行号: 内容」并返回 1；没有命中返回 0。
# 确需保留的行（例如规则本身的举例）在行尾加 `lint-comments: allow` 豁免。
#
# 本仓配置：与脚本同名的 .conf（scripts/lint/comments.sh → scripts/lint/comments.conf），
# 也可用环境变量 LINT_COMMENTS_CONF 指定。可写的变量：
#   EXCLUDE        不扫的路径（shell glob，按仓库相对路径匹配，空格分隔），覆盖默认值
#   EXTRA_EXCLUDE  在默认 EXCLUDE 之外追加
#   INCLUDE        受检文件（shell glob），覆盖默认值
#   EXTRA_INCLUDE  在默认 INCLUDE 之外追加
#   EXTRA_PATTERN  本仓专有的编号写法（perl 正则，/x 模式），与通用规则取并集
set -euo pipefail

script_path=$0
self=$(cd "$(dirname "$script_path")" && pwd -P)/$(basename "$script_path")
root=$(git rev-parse --show-toplevel)
cd "$root"

mode=all
case "${1:-}" in
  --staged) mode=staged ;;
  "") ;;
  *) echo "用法：$0 [--staged]" >&2; exit 2 ;;
esac

EXCLUDE="docs/* CHANGELOG.md pnpm-lock.yaml */pnpm-lock.yaml"
EXTRA_EXCLUDE=
INCLUDE="*.sh *.bash *.zsh *.py *.rb *.go *.rs *.java *.kt *.swift *.m *.mm *.h *.c *.cc *.cpp
  *.js *.mjs *.cjs *.ts *.tsx *.jsx *.vue *.plist *.entitlements *.xcprivacy *.xcconfig
  *.yml *.yaml *.toml Makefile */Makefile Dockerfile */Dockerfile
  AGENTS.md */AGENTS.md CLAUDE.md .githooks/* hooks/*"
EXTRA_INCLUDE=
EXTRA_PATTERN=

conf=${LINT_COMMENTS_CONF:-${self%.sh}.conf}
# shellcheck source=/dev/null
[ -f "$conf" ] && . "$conf"

# 脚本自身含有全部模式串，永远排除
self_rel=${self#"$(pwd -P)"/}

is_target() {
  local f=$1 p
  [ "$f" = "$self_rel" ] && return 1
  set -f
  for p in $EXCLUDE $EXTRA_EXCLUDE; do
    # shellcheck disable=SC2254  # 模式来自配置，需要按 glob 展开
    case "$f" in $p) set +f; return 1 ;; esac
  done
  for p in $INCLUDE $EXTRA_INCLUDE; do
    # shellcheck disable=SC2254
    case "$f" in $p) set +f; return 0 ;; esac
    # 没有目录的模式也匹配子目录里的同名文件，例如 Makefile
    case "$p" in */*) continue ;; esac
    # shellcheck disable=SC2254
    case "${f##*/}" in $p) set +f; return 0 ;; esac
  done
  set +f
  return 1
}

# 输入每行「文件<TAB>行号<TAB>内容」，命中打印「文件:行号: 内容」；有命中时以 1 退出。
scan() {
  EXTRA_PATTERN=$EXTRA_PATTERN perl -CSD -Mutf8 -ne '
    BEGIN {
      $hit = 0;
      $extra = $ENV{EXTRA_PATTERN} // "";
      utf8::decode($extra);
    }
    chomp;
    my ($f, $n, $t) = split /\t/, $_, 3;
    next unless defined $t;
    next if $t =~ /lint-comments: allow/;
    my $bad = $t =~ m{
        \bP[0-9](?:-[A-Z])?\b                       # 优先级、阶段号
      | \b(?:US|AC|AR|PM|OQ|INT|QA|M|P)-[0-9A-Z]      # 需求、验收、待决项编号
      | §                                           # 章节号
      | (?:规格|计划|plan)\s?§?[A-Z]?[0-9]          # 「规格 2.1」「计划 S2」
      | \bPhase\s?[A-Z0-9]\b
      | 迭代\s?[0-9]
      | 批次\s?[0-9A-Z]
      | (?:原型|画板)\W{0,3}[0-9]{2}
      | \b[CDRSUL][0-9]{1,2}\b                      # 决议、决策、需求、切片、手动步骤编号
      | \bS-[A-Z]\b
      | \batom-[0-9a-z]
      | (?<![&\w\x27"])\#[0-9]{1,3}\b              # 审视发现号、工单号
      | \b[A-Z]-[0-9]{1,2}\b                       # 单字母编号 B-2、N-1
      | (?<![下上本当每前后同])[一二三四]期          # 「一期」「二期」
      | plan-v[0-9]
      | 审视\s?\#
      | (?<![.\w·@/])v[0-9](?:[①-⑩]|\b(?!\.))      # 迭代版本标记「v3:」（不含 v1.0.0 这类版本号）
    }x;
    $bad ||= ($extra ne "" && $t =~ m{$extra}x);
    if ($bad) { print "$f:$n: $t\n"; $hit = 1 }
    END { exit $hit }
  '
}

status=0
if [ "$mode" = staged ]; then
  # 只看暂存区新增行：解析 -U0 diff 的 hunk 头取新文件行号
  git diff --cached --no-color --no-ext-diff -U0 --diff-filter=ACMR |
    perl -CSD -ne '
      if (/^\+\+\+ b\/(.*)$/) { $f = $1; next }
      if (/^\+\+\+ /) { $f = ""; next }
      if (/^@@ -\S+ \+(\d+)/) { $n = $1; next }
      if (/^\+/ && $f ne "") { s/^\+//; chomp; print "$f\t$n\t$_\n"; $n++ }
    ' |
    while IFS=$'\t' read -r f n t; do
      if is_target "$f"; then printf '%s\t%s\t%s\n' "$f" "$n" "$t"; fi
    done | scan || status=$?
else
  git ls-files -z |
    while IFS= read -r -d '' f; do
      if is_target "$f" && [ -f "$f" ]; then
        perl -CSD -ne 'chomp; print "$ARGV\t$.\t$_\n"' "$f"
      fi
    done | scan || status=$?
fi

if [ "$status" -ne 0 ]; then
  echo "发现流程编号：注释里直接写出约束内容本身，编号只留在 docs/ 等过程文档；确需保留的行在行尾加 lint-comments: allow" >&2
  exit 1
fi
[ "$mode" = staged ] || echo "注释流程编号检查通过"
