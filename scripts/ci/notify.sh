#!/usr/bin/env bash
# 受管文件，来自 ci-workflows@v2.0.0 的 scripts/notify.sh：不在本仓直接改，见 CONTRIBUTING.md「受管文件」
# 经 Bark 推送一条通知。用法：notify.sh <标题> <正文> [分组，默认 ci]
# 密钥从环境变量 BARK_KEY 读取（CI 里从 secret 传入），没有时只打印到标准输出。
# 推送失败只告警、不让调用方失败：通知是旁路，不能反过来掩盖真正的失败原因。
set -uo pipefail
title=${1:?用法：notify.sh <标题> <正文> [分组]}
body=${2:-}
group=${3:-ci}
if [ -z "${BARK_KEY:-}" ]; then
  printf '[通知，未配置 BARK_KEY] %s：%s\n' "$title" "$body"
  exit 0
fi
if ! curl -fsS --max-time 15 -o /dev/null \
    --data-urlencode "title=$title" \
    --data-urlencode "body=$body" \
    --data-urlencode "group=$group" \
    "https://api.day.app/$BARK_KEY"; then
  echo "Bark 推送失败（已忽略）" >&2
fi
exit 0
