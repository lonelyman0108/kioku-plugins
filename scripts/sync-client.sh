#!/usr/bin/env bash
# 把 Kioku 仓库里生成的 Python 客户端复制进 AstrBot 插件，并记下来源提交。
# Kioku 改了应用调用的接口、重新生成 sdks/python 之后，在这里跑一次：
#   scripts/sync-client.sh <Kioku 仓库的路径>
set -euo pipefail
cd "$(dirname "$0")/.."
src=${1:?用法：scripts/sync-client.sh <Kioku 仓库的路径>}
client=$src/sdks/python/kioku_client
[ -d "$client" ] || { echo "找不到 $client" >&2; exit 1; }
# 只从提交过的状态同步：来源提交才对得上复制过来的内容
if [ -n "$(git -C "$src" status --porcelain -- sdks/python)" ]; then
  echo "Kioku 的 sdks/python 有未提交的改动，先提交再同步" >&2
  exit 1
fi
rev=$(git -C "$src" rev-parse HEAD)
dest=plugins/astrbot_plugin_kioku/kioku_client
rm -rf "$dest"
cp -R "$client" "$dest"
find "$dest" -name __pycache__ -type d -prune -exec rm -rf {} +
printf 'Kioku %s\n' "$rev" > "$dest/SOURCE"
echo "已同步 kioku_client（Kioku ${rev}）"
