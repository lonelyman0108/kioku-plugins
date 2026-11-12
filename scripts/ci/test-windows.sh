#!/usr/bin/env bash
# 在 Windows 的 runner 上跑 JS 的用例。只被 ci.yml 的 test-windows 调用；别的系统上跑它等于 pnpm test。
# 平台有关的行为（起 .cmd 命令、路径、权限）要在真的 Windows 上核对；门禁的其余部分和系统无关，由 gate 跑。
set -euo pipefail
cd "$(dirname "$0")/../.."

pnpm install --frozen-lockfile
# 一个包挂了也把别的包跑完：一次看全不对的地方
pnpm -r --no-bail test
