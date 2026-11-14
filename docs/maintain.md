# 维护这份路书

这是「大兴安岭南线追秋」的维护指南。路书是历史路书（2026.09.25—10.03 的计划，已归档），不证明这趟旅行实际完成。以下路径均相对仓库根目录；草稿和研究资料放被 Git 忽略的 `work/`，访客只看到路书内容。

## 执行分工

协调者负责需求与路线、设计决策、计划与任务拆解，以及独立最终验收。协调者同时负责分析与审核；实际执行交给用户指定的 Sonnet 5.5 子代理（high effort），分派时明确目标文件、预期行为与验收证据。执行者提交实际产物和检查结果，不能以自报成功代替协调者验收。发布仍遵守用户当前授权。

## 修改内容

- 页面内容和交互在 `site/index.html`；参考图在 `site/xhs-spots/`，封面是 `site/cover.webp`（扩展名必须符合实际格式）。页面只用相对路径，不引用 `site/` 之外。
- 保留桌面与手机都可见的“回旅行首页”链接，保留照片署名、全部交互（两种路线方案、按天行程与清单、地图点位侧栏、高德分段清单）和存储容错。
- 更新机位或资料时，按 [调研手册](../skills/travel-journal/references/research.md) 调研和落盘；日期没有证据就写“未标”，旧实拍不代表当季叶量。
- 公开文件不含 `xsec_token`/`xsec_source`、私有地图配置、本地路径和密钥；小红书链接用 `https://www.xiaohongshu.com/explore/<note-id>` 形式。
- `site/trip.json` 是旅行首页读取的清单，改日期、路线或封面时同步更新；字段由 `tests/trip.test.mjs` 检查，约定见 [trip-spec](https://github.com/real-jacket/travel-journal/blob/main/docs/trip-spec.md)。本路书保持 `status: archived`、`statusLabel: 历史路书`。

## 重建地图数据

地图方案与依据见 [地图选型](map-selection.md)（第 0 节为准）。编辑根目录 `map.json`（bbox、分层抽取范围、路线途经点，坐标均为 WGS-84），然后：

```sh
pnpm map:build --routes             # OSRM 生成 site/map/routes.geojson（≤1 请求/秒，非商用）
pnpm map:build --extract --dry-run  # 先看底图/地形体积
pnpm map:build --extract            # 生成 base.pmtiles 与 terrain.pmtiles（需要 pmtiles CLI）
pnpm map:build --landcover          # 由 ESA WorldCover 生成 landcover.pmtiles（需要 uv）
pnpm map:build --validate           # 复用旧路线时，只检查回头路
```

低缩放层用大范围、高缩放层只覆盖路线走廊和点位；页面 `maxBounds` 不超出已制作范围。`site/map/` 合计不超过 40 MB（测试强制）；重生成的二进制会永久留在 Git 历史里，定稿后别反复重建。

底图保持土地覆盖地形图，上面叠分级道路（含 G/S 编号）和省/市/县界与地名，国界与争议线不画，页面用 `TripMap.renderLegend` 放中文图例。地图下方保留“用高德查看路线”分段清单：`TripMap.navSegments` 与 `TripMap.amapRoute`，坐标转 GCJ-02。画出的路线用来看，分段导航用来走，两者都要有。

## 检查与预览

```sh
pnpm check
pnpm preview            # http://127.0.0.1:4190/trip-khingan/，支持 Range，与 Pages 同一子路径
```

`check` 运行零依赖测试：清单契约、相对资源、公开文件安全、地图数据与体积、高德分段、预览服务、文档链接。测试通过不是地图或视觉验证。

- 在真实浏览器按 1280px 桌面与 390px 手机检查：标题、图片、控件可读，无横向溢出，无控制台错误，“回旅行首页”可见可点。
- 地图渲染出土地覆盖、分级道路、境界与地名、按天路线和图例；高德分段链接数量与方案/天一致。
- 照片加载、放大/关闭、方案与日期选择、地图缩放与点位侧栏、清单勾选等核心交互实际可用。

第三方地图/平台链接受网络影响；页面内容是历史计划，不要把它改写成已完成的行程。

## 发布

仅当用户本次明确要求推送或上线时执行，授权范围以本次请求为准。

1. 提交并推送 `main`；`.github/workflows/pages.yml` 会先运行 `pnpm check` 同样的测试，再发布 `site/`。
2. 等待对应 commit 的工作流完成，打开 `https://real-jacket.github.io/trip-khingan/` 与 `.../trip.json`，核对图片、地图（PMTiles Range 请求返回 206）与返回首页链接。

部署成功与网站可用分别确认；返回网站 URL 和验证边界。本流程不提供空白发布授权。
