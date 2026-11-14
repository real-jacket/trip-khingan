# 大兴安岭南线追秋

历史路书（2026.09.25—10.03 的计划，已归档），不证明这趟旅行实际完成。发布为独立站点 `https://real-jacket.github.io/trip-khingan/`，在[旅行首页](https://real-jacket.github.io/travel-journal/)收录。

路书含 hero 原图、九张 `xhs-spots/opt2/` 参考图与本地 GSAP 动画脚本；清单读取带存储容错；“纯南线”与“追加额尔古纳”两种路线。

- `site/`：发布内容（`index.html`、`trip.json`、`cover.webp`、`vendor/map/`、`map/`），Pages 原样发布
- `map.json`、`scripts/`：地图数据制作（`pnpm map:build`）与本地预览（`pnpm preview`）
- `tests/`：零依赖检查（`pnpm check`）
- `docs/`：[文档索引](docs/README.md)，流程见 [制作一份旅行路书](docs/add-a-trip.md)
- `skills/travel-journal/`：给 Claude Code / Codex 用的技能；协作约定见 `AGENTS.md`

本仓库由 `real-jacket/trip-template` 派生，工具链文件（`scripts/`、`site/vendor/`、工作流、通用测试）与模板一致。
