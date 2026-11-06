# 文档索引

| 文档 | 说明 |
|---|---|
| [SETUP.md](SETUP.md) | 仓库与平台设置、secrets 名字、runner label、部署位置、重建步骤 |
| [plans/PLAN.md](plans/PLAN.md) | 计划模板：新主题复制一份改名，全生命周期持续勾选 |
| [adr/0000-template.md](adr/0000-template.md) | ADR 模板：长期决策，每篇一屏以内 |

## 哪个问题以哪份为准

| 问题 | 以哪份为准 |
|---|---|
| 这个项目是什么、怎么跑、怎么部署 | `README.md` |
| 人怎么提交、开 PR、发版 | `CONTRIBUTING.md` |
| agent 怎么干活、有哪些禁区和坑 | `AGENTS.md`（`CLAUDE.md` 只引用它） |
| 平台和机器怎么设置、怎么重建 | `docs/SETUP.md` |
| 为什么这样设计 | `docs/adr/NNNN-*.md` |
| 正在推进的计划和进度 | `docs/plans/<主题>.md` |
| 每个版本改了什么 | `CHANGELOG.md`，以及 `docs/release/vX.Y.Z.md`（App 与对外服务） |

已完成或被取代的文档用 `git mv` 移到 `docs/archive/`，第一行注明归档日期和原因。
