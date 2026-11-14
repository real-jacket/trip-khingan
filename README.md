# 大兴安岭南线追秋

内蒙古阿尔山与呼伦贝尔的 9 天 8 晚自驾追秋路书：乌兰浩特进、海拉尔出，沿蘑阿公路穿过森林，收集河谷、湖泊和秋色。

在线阅读：<https://real-jacket.github.io/trip-khingan/>

![阿尔山哈拉哈河秋日实景，金色枝叶、河谷与桥梁在晨雾中相遇。](site/cover.webp)

封面：哈拉哈河，原路书摄影笔记，[原笔记](https://www.xiaohongshu.com/explore/6a979c380000000026021067)。

## 状态

历史路书，已归档。计划日期 2026.09.25 — 10.03，武汉往返、落地租车。归档指这是一份保存下来的行程计划，不证明这趟旅行实际完成；日期已过也不代表完成。

## 这份路书里有什么

- 路线：乌兰浩特、阿尔山、蘑阿公路、柴河、牙克石、莫尔格勒河、海拉尔。
- 两种方案，可在页面里切换：
  - 纯南线：约 880 公里，4 个住宿基地，D8 莫尔格勒河后返回海拉尔，D9 还车。
  - 追加额尔古纳：约 1070 公里，5 个住宿基地。页面建议按北部叶色决定，出发前 7 天再定。
- 逐日行程：D1 至 D9，每天有路线说明和当天清单（可勾选，进度保存在浏览器本地存储里，存储不可用时页面仍能使用）。
- 地图：土地覆盖地形底图（森林、植被、农田、城镇、水体等不同颜色，叠山体阴影）、分级道路和行政区划、画出的驾车路线、编号点位与图例；地图下方有按天分段的“用高德查看路线”清单。
- 拍摄位置与参考图：每个参考图标注来源笔记名并链接到小红书原笔记；页面里的机位坐标多处写明“待核实”。
- 取车后清单：车辆验收、合同与保险、导航与通信、加油与补给，另有路况施工、低温穿衣、防火停车、失联救援提示。
- 住宿基地：阿尔山市区、伊尔施、柴河镇、海拉尔，以及可选的额尔古纳。
- 可打印或存为 PDF。

页面里的个人笔记反映具体日期的体验，不等于官方通行公告；出发当天以现场开放情况和高德搜索结果为准。

## 本地查看与检查

需要 Node 24 或更高版本和 pnpm。仓库没有需要安装的依赖，不用 `pnpm install`。

```sh
pnpm preview   # http://127.0.0.1:4190/trip-khingan/
pnpm check
```

预览服务按 `/<仓库目录名>/` 提供 `site/`，支持 Range 请求（地图 PMTiles 需要），与 GitHub Pages 的子路径一致，所以本地目录名需保持 `trip-khingan`。`pnpm check` 运行 `tests/` 下的零依赖测试：清单、相对资源、公开文件安全、地图数据与体积、高德分段、文档链接。

## 修改这份路书

- 内容和交互都在 `site/index.html`，图片在 `site/xhs-spots/`，封面是 `site/cover.webp`。页面只用相对路径，不引用 `site/` 之外。
- 地图数据由根目录 `map.json` 生成：`pnpm map:build --routes|--extract [--dry-run]|--landcover|--validate`，输出在 `site/map/`，合计不超过 40 MB（测试强制）。`--extract` 需要 pmtiles 命令行工具，`--landcover` 需要 uv，`--routes` 需要联网。
- 维护步骤、检查和发布规则见 [docs/maintain.md](docs/maintain.md)，协作约定见 [AGENTS.md](AGENTS.md)。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `site/` | 发布内容，GitHub Pages 原样发布：`index.html`、`trip.json`、`cover.webp`、`xhs-spots/`、`map/`、`vendor/`、GSAP 脚本 |
| `map.json` | 地图范围、分层抽取与路线途经点（WGS-84） |
| `scripts/` | 地图数据生成（`pnpm map:build`）和本地预览（`pnpm preview`） |
| `tests/` | 零依赖检查（`pnpm check`） |
| `docs/` | [文档索引](docs/README.md)：维护指南、地图选型、迁移记录 |
| `skills/travel-journal/` | 给 Claude Code / Codex 用的维护技能（`.claude/skills/travel-journal` 指向它） |
| `.github/workflows/pages.yml` | 推送 `main` 时检查并发布 `site/` |

仓库最初由 `real-jacket/trip-template` 创建，路书从旅行首页仓库迁入，核对记录见 [docs/records/khingan-migration.md](docs/records/khingan-migration.md)。

## 照片与数据来源

- 照片归各自的摄影师所有，在页面里标注了来源并链接原笔记，本仓库不对它们重新授权。
- `site/` 里带有第三方代码：GSAP 3.12.5 与 ScrollTrigger 3.12.5（文件头写明受 [gsap.com/standard-license](https://gsap.com/standard-license) 条款约束）、MapLibre GL JS 与 PMTiles（目录内各带 `LICENSE.txt`）。
- 地图署名：© OpenStreetMap · Protomaps · Mapterhorn · ESA WorldCover。其中 Protomaps 底图是 OpenStreetMap（ODbL）数据的成品，ESA WorldCover 为 CC-BY 4.0。选型与来源说明见 [docs/map-selection.md](docs/map-selection.md)。
- 驾车路线由 OSRM 公共 demo 在作者本机一次性生成（见 `scripts/build-trip-map.mjs`，仅限非商用）。
- 本仓库目前没有 LICENSE 文件，未声明开源许可。

## 被旅行首页收录

[旅行首页](https://real-jacket.github.io/travel-journal/)读取 `site/trip.json` 来生成这份路书的卡片，字段约定见 [trip-spec](https://github.com/real-jacket/travel-journal/blob/main/docs/trip-spec.md)。没有旅行首页，这份路书照常独立使用。
