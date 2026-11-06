#!/usr/bin/env bash
# 受管文件，来自 ci-workflows@v2.0.0 的 scripts/pr.sh：不在本仓直接改，见 CONTRIBUTING.md「受管文件」
# 开 PR、预约 squash 自动合并、更新落后于 main 的 PR。origin 指向 github.com 时用 gh，否则直接调 Gitea API（不依赖 tea）。
#
# 用法：
#   scripts/pr.sh [--no-merge] [--title <标题>] [--body-file <文件>] [--base <分支>] [--dry-run]
#       推送当前分支并开 PR；默认同时预约「检查通过后 squash 合并并删除分支」
#   scripts/pr.sh --update <N>    用 rebase 方式把 PR #N 更新到最新的目标分支
#   scripts/pr.sh --release       标题与正文取自最近一条 🔖 release 提交，正文原样进入 main
#
#   --no-merge    只开 PR，不预约合并（门禁改动、无人值守任务、还没配必需检查的仓库都用它）
#   --title       多提交的 PR 用它给概括性标题；单提交时默认取那条提交的标题
#   --body-file   PR 描述文件；不给时用 .gitea/ 或 .github/ 下的 PULL_REQUEST_TEMPLATE.md，交互式终端下打开编辑器
#   --dry-run     只打印将要执行的推送与 API、gh 调用，不联网
#
# GitHub：认证沿用 gh auth login 的登录状态，脚本不读取令牌。依赖 git、gh。
# Gitea：令牌放在 ~/.config/gitea/token（权限 600），可用 GITEA_TOKEN_FILE 改路径；脚本从不打印令牌。
#   实例地址从 origin 的 https 地址推出；origin 是 ssh 地址时用 GITEA_URL 指定（例如 https://git.example.com）。依赖 git、curl、jq。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

usage() { awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

mode=open
merge=1
dry=0
title=
body_file=
base=main
number=
while [ $# -gt 0 ]; do
  case "$1" in
    --no-merge) merge=0; shift ;;
    --title) title=${2:?--title 需要参数}; shift 2 ;;
    --body-file) body_file=${2:?--body-file 需要参数}; shift 2 ;;
    --base) base=${2:?--base 需要参数}; shift 2 ;;
    --update) mode=update; number=${2:?--update 需要 PR 编号}; shift 2 ;;
    --release) mode=release; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

# ---- 从 origin 推出平台、主机与 owner/repo ----
origin=$(git remote get-url origin 2>/dev/null) || die "没有 origin 远端"
server=
case "$origin" in
  http://*|https://*)
    scheme=${origin%%://*}
    rest=${origin#*://}
    rest=${rest#*@}                 # 去掉地址里可能带的凭据
    hostport=${rest%%/*}
    path=${rest#*/}
    host=${hostport%%:*}
    server=${GITEA_URL:-$scheme://$hostport}
    ;;
  ssh://*)
    rest=${origin#ssh://}; rest=${rest#*@}; path=${rest#*/}
    host=${rest%%/*}; host=${host%%:*}
    ;;
  *:*)
    path=${origin#*:}
    host=${origin%%:*}; host=${host#*@}
    ;;
  *) die "无法解析 origin：$origin" ;;
esac
path=${path%.git}
path=${path%/}
case "$path" in */*/*|'') die "无法从 origin 解析 owner/repo：$origin" ;; esac
platform=gitea
[ "$host" != github.com ] || platform=github

if [ "$platform" = github ]; then
  # dry-run 只打印命令，不需要真的有 gh
  [ "$dry" -eq 1 ] || command -v gh >/dev/null 2>&1 || die "缺少 gh（brew install gh，然后 gh auth login）"
else
  for t in curl jq; do
    command -v "$t" >/dev/null 2>&1 || die "缺少 $t"
  done
  [ -n "$server" ] || server=${GITEA_URL:?origin 是 ssh 地址，请用 GITEA_URL 指定实例的 https 地址}
  server=${server%/}
  api="$server/api/v1/repos/$path"
fi

token=
if [ "$platform" = gitea ] && [ "$dry" -eq 0 ]; then
  token_file=${GITEA_TOKEN_FILE:-$HOME/.config/gitea/token}
  [ -f "$token_file" ] || die "找不到令牌 ${token_file}：在 Gitea 生成有仓库读写权限的个人访问令牌，写入该文件并 chmod 600"
  # GNU stat 的 -f 表示文件系统信息，所以先试 GNU 写法，失败再用 BSD（macOS）写法
  perm=$(stat -c '%a' "$token_file" 2>/dev/null || stat -f '%Lp' "$token_file")
  [ "$perm" = 600 ] || echo "提示：$token_file 的权限是 ${perm}，建议 chmod 600" >&2
  token=$(tr -d '[:space:]' < "$token_file")
fi

resp=$(mktemp)
trap 'rm -f "$resp" "${tmp_title:-}" "${tmp_body:-}"' EXIT

# Gitea：call <方法> <路径> [JSON]；响应体写入 ${resp}，HTTP 状态码写到标准输出
call() {
  local method=$1 url="$api$2" data=${3:-}
  if [ "$dry" -eq 1 ]; then
    printf '[dry-run] %s %s\n' "$method" "$url" >&2
    [ -z "$data" ] || printf '%s\n' "$data" | jq . >&2
    echo '{}' > "$resp"
    echo 200
    return 0
  fi
  local args=(-sS -o "$resp" -w '%{http_code}' -X "$method" -H "Authorization: token $token" -H 'Accept: application/json')
  [ -z "$data" ] || args+=(-H 'Content-Type: application/json' -d "$data")
  curl "${args[@]}" "$url"
}

# GitHub：执行一条 gh 命令；dry-run 时只打印
run_gh() {
  if [ "$dry" -eq 1 ]; then
    printf '[dry-run]' >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
  else
    "$@"
  fi
}

if [ "$mode" = update ]; then
  if [ "$platform" = github ]; then
    run_gh gh pr update-branch "$number" --rebase
  else
    code=$(call POST "/pulls/$number/update?style=rebase")
    case "$code" in
      2*) ;;
      *) cat "$resp" >&2; die "更新 PR #$number 失败：HTTP $code" ;;
    esac
  fi
  echo "PR #$number 已按 rebase 更新；本地分支执行 git pull --rebase 同步"
  exit 0
fi

branch=$(git symbolic-ref --short HEAD 2>/dev/null) || die "当前不在分支上"
[ "$branch" != "$base" ] || die "当前就在 $base 上：先 git switch -c <type>/<slug> 建分支"

if [ "$dry" -eq 0 ]; then
  git fetch -q origin "$base"
fi
base_ref=origin/$base
git rev-parse -q --verify "$base_ref^{commit}" >/dev/null || base_ref=$base
count=$(git rev-list --count "$base_ref..HEAD")
[ "$count" -gt 0 ] || die "$branch 相对 $base_ref 没有新提交"

release_body=
if [ "$mode" = release ]; then
  rc=$(git log -n1 --format=%H --grep='^🔖 release' "$base_ref..HEAD")
  [ -n "$rc" ] || die "$base_ref..HEAD 里没有 🔖 release 提交"
  title=$(git log -1 --format=%s "$rc")
  release_body=$(git log -1 --format=%b "$rc")
elif [ -z "$title" ]; then
  if [ "$count" -eq 1 ]; then
    title=$(git log -1 --format=%s HEAD)
  elif [ -t 0 ]; then
    git log --format='  %s' "$base_ref..HEAD"
    printf '共 %s 条提交，输入 PR 标题（将成为 main 上的提交标题）：' "$count"
    IFS= read -r title
  else
    die "有 $count 条提交：用 --title 给出概括性的 PR 标题"
  fi
fi

# 标题按提交规范校验；WIP 前缀只表示没做完，不参与校验
tmp_title=$(mktemp)
check_title=$title
case "$check_title" in
  WIP:*) check_title=${check_title#WIP:} ;;
  '[WIP]'*) check_title=${check_title#\[WIP\]} ;;
esac
check_title=${check_title# }
printf '%s\n' "$check_title" > "$tmp_title"
[ -x .githooks/commit-msg ] || die "找不到 .githooks/commit-msg：先运行 scripts/bootstrap.sh"
.githooks/commit-msg "$tmp_title" || die "PR 标题不符合提交规范，见上方提示"

# PR 描述
tmp_body=$(mktemp)
if [ -n "$body_file" ]; then
  cat "$body_file" > "$tmp_body"
elif [ "$mode" = release ]; then
  printf '%s\n' "$release_body" > "$tmp_body"
else
  for t in .github/PULL_REQUEST_TEMPLATE.md .gitea/PULL_REQUEST_TEMPLATE.md; do
    if [ -f "$t" ]; then cat "$t" > "$tmp_body"; break; fi
  done
  if [ -t 0 ] && [ -t 1 ] && [ "$dry" -eq 0 ]; then
    ${VISUAL:-${EDITOR:-vi}} "$tmp_body" < /dev/tty > /dev/tty
  else
    echo "提示：非交互环境且未给 --body-file，PR 描述使用空模板，记得在网页上补全" >&2
  fi
fi
body=$(cat "$tmp_body")

# squash 正文：release PR 用提交正文原样；其余取「变更」一节，去掉 HTML 注释
if [ "$mode" = release ]; then
  merge_msg=$release_body
else
  merge_msg=$(awk '/^## /{ on = ($0 ~ /^## 变更/); next } on' "$tmp_body" | sed -e '/^[[:space:]]*<!--.*-->[[:space:]]*$/d' -e '/^[[:space:]]*-[[:space:]]*$/d')
fi

# ---- 推送并建 PR ----
if [ "$dry" -eq 1 ]; then
  echo "[dry-run] git push -u origin HEAD（${branch}）" >&2
else
  git push -u origin HEAD
fi

if [ "$platform" = github ]; then
  if [ "$dry" -eq 0 ] && number=$(gh pr view "$branch" --json number,state -q 'select(.state == "OPEN") | .number' 2>/dev/null) && [ -n "$number" ]; then
    echo "已有 PR #${number}，沿用"
  else
    run_gh gh pr create --base "$base" --head "$branch" --title "$title" --body-file "$tmp_body"
    if [ "$dry" -eq 0 ]; then number=$(gh pr view "$branch" --json number -q .number); else number=N; fi
  fi
else
  payload=$(jq -n --arg t "$title" --arg b "$body" --arg h "$branch" --arg base "$base" \
    '{title: $t, body: $b, head: $h, base: $base}')
  code=$(call POST /pulls "$payload")
  case "$code" in
    2*) number=$(jq -r '.number // "N"' "$resp") ;;
    409)
      code=$(call GET "/pulls/$base/$branch")
      [ "${code#2}" != "$code" ] || die "PR 已存在但查询失败：HTTP $code"
      number=$(jq -r .number "$resp")
      echo "已有 PR #${number}，沿用"
      ;;
    *) cat "$resp" >&2; die "创建 PR 失败：HTTP $code" ;;
  esac
  [ "$dry" -eq 0 ] || number=N
fi

if [ "$merge" -eq 1 ]; then
  # 没有必需检查时预约自动合并会立即合并（或被平台拒绝），所以先确认目标分支配了必需检查
  if [ "$platform" = github ]; then
    required=1
    if [ "$dry" -eq 0 ]; then
      required=$(gh api "repos/$path/rules/branches/$base" -q '[.[] | select(.type == "required_status_checks")] | length' 2>/dev/null || echo 0)
    fi
    if [ "$required" = 0 ]; then
      echo "注意：$base 没有配置必需检查（或无权读取），不预约自动合并；等 CI 通过后在网页上 squash 合并" >&2
    elif run_gh gh pr merge "$number" --auto --squash --delete-branch --subject "$title (#$number)" --body "$merge_msg"; then
      echo "已预约：检查通过后 squash 合并并删除分支"
    else
      echo "预约自动合并失败（PR 已建好，可在网页上合并）" >&2
    fi
  else
    code=$(call GET "/branch_protections/$base")
    if [ "$dry" -eq 0 ] && { [ "${code#2}" = "$code" ] || [ "$(jq -r '(.enable_status_check // false) and ((.status_check_contexts // []) | length > 0)' "$resp")" != true ]; }; then
      echo "注意：$base 的分支保护没有启用必需检查（或无权读取），不预约自动合并；等 CI 通过后在网页上 squash 合并" >&2
    else
      payload=$(jq -n --arg t "$title (#$number)" --arg m "$merge_msg" \
        '{Do: "squash", MergeTitleField: $t, MergeMessageField: $m, merge_when_checks_succeed: true, delete_branch_after_merge: true}')
      code=$(call POST "/pulls/$number/merge" "$payload")
      case "$code" in
        2*) echo "已预约：检查通过后 squash 合并并删除分支" ;;
        *) cat "$resp" >&2; echo "预约自动合并失败：HTTP ${code}（PR 已建好，可在网页上合并）" >&2 ;;
      esac
    fi
  fi
fi

if [ "$platform" = github ]; then
  if [ "$dry" -eq 0 ]; then gh pr view "$number" --json url -q '"PR：" + .url'; else echo "PR：#$number"; fi
else
  echo "PR：$server/$path/pulls/$number"
fi
