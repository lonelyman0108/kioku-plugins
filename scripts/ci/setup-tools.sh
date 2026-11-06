#!/usr/bin/env bash
# 受管文件，来自 ci-workflows@v2.0.0 的 scripts/setup-tools.sh：不在本仓直接改，见 CONTRIBUTING.md「受管文件」
# 补齐门禁需要、但 runner 环境里没有的工具，把安装目录打印到标准输出，供 CI 追加进 $GITHUB_PATH。
# 已有的工具不重装，所以在装好工具的 Mac host runner 上什么也不做；Gitea 与 GitHub 的 runner 都支持 $GITHUB_PATH。日志写标准错误。
#   actionlint：有 .gitea/workflows 或 .github/workflows 时需要；固定版本，按 sha256 校验
#   go：有 go.mod 时需要；版本取 go.mod 的 go 行，校验值取自 go.dev 官方下载列表
#   pnpm：有 pnpm-lock.yaml（根目录或 web/）时需要；用 Node 自带的 corepack 启用
# 环境变量：CI_TOOLS_DIR 安装目录（默认 $RUNNER_TEMP/ci-tools）。
set -euo pipefail

actionlint_version=1.7.12
actionlint_sha256() {
  case "$1" in
    linux_amd64)  echo 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
    linux_arm64)  echo 325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
    darwin_arm64) echo aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
    darwin_amd64) echo 5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
    *) return 1 ;;
  esac
}

log() { printf '%s\n' "$*" >&2; }
die() { log "setup-tools：$*"; exit 1; }

root=${CI_TOOLS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-tools}
bin=$root/bin
mkdir -p "$bin"
export PATH="$bin:$PATH"

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "不支持的系统 $(uname -s)" ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) die "不支持的架构 $(uname -m)" ;; esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
fetch() {   # fetch <url> <文件> <期望 sha256>
  curl -fsSL --retry 3 -o "$2" "$1" || die "下载失败：$1"
  [ "$(sha256_of "$2")" = "$3" ] || die "校验失败：$1"
}

# 版本比较：$1 >= $2 时返回 0（只比较数字段，如 1.27.3）
version_ge() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

if { ls .gitea/workflows/*.y*ml || ls .github/workflows/*.y*ml; } >/dev/null 2>&1 && ! command -v actionlint >/dev/null 2>&1; then
  sum=$(actionlint_sha256 "${os}_${arch}") || die "actionlint 没有 ${os}_${arch} 的校验值"
  tgz=$root/actionlint.tar.gz
  fetch "https://github.com/rhysd/actionlint/releases/download/v${actionlint_version}/actionlint_${actionlint_version}_${os}_${arch}.tar.gz" "$tgz" "$sum"
  tar -xzf "$tgz" -C "$bin" actionlint
  rm -f "$tgz"
  log "已安装 actionlint $actionlint_version"
fi

if [ -f go.mod ]; then
  want=$(awk '$1 == "go" { print $2; exit }' go.mod)
  [ -n "$want" ] || die "go.mod 里没有 go 行"
  have=
  if command -v go >/dev/null 2>&1; then have=$(go env GOVERSION 2>/dev/null | sed 's/^go//'); fi
  if [ -z "$have" ] || ! version_ge "$have" "$want"; then
    command -v jq >/dev/null 2>&1 || die "安装 Go 需要 jq"
    file="go${want}.${os}-${arch}.tar.gz"
    sum=$(curl -fsSL --retry 3 'https://go.dev/dl/?mode=json&include=all' \
      | jq -r --arg f "$file" '.[].files[] | select(.filename == $f) | .sha256' | head -1)
    [ -n "$sum" ] || die "go.dev 上找不到 $file"
    tgz=$root/$file
    fetch "https://go.dev/dl/$file" "$tgz" "$sum"
    rm -rf "$root/go"
    tar -xzf "$tgz" -C "$root"
    rm -f "$tgz"
    ln -sf "$root/go/bin/go" "$root/go/bin/gofmt" "$bin/"
    log "已安装 Go $want（原有版本：${have:-无}）"
  fi
fi

if { [ -f pnpm-lock.yaml ] || [ -f web/pnpm-lock.yaml ]; } && ! command -v pnpm >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || die "需要 pnpm，但没有 corepack"
  corepack enable --install-directory "$bin" pnpm
  log "已通过 corepack 启用 pnpm"
fi

echo "$bin"
