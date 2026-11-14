import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const site = path.join(root, "site");
const HUB_URL = "https://real-jacket.github.io/travel-journal/";
const exists = (file) => access(file).then(() => true, () => false);
const nonempty = async (file) => assert.ok((await stat(file)).size > 0, file);
const inside = (file) => file === site || file.startsWith(site + path.sep);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  }));
  return groups.flat();
}

const manifest = JSON.parse(await readFile(path.join(site, "trip.json"), "utf8"));
const html = await readFile(path.join(site, "index.html"), "utf8");

test("trip.json 满足旅行首页读取的清单约定，封面存在且格式与扩展名一致", async () => {
  for (const field of ["id", "title", "subtitle", "region", "status", "statusLabel", "date", "dateNote", "duration", "transport", "description", "image", "imageAlt", "imageCredit", "highlights"]) {
    assert.equal(typeof manifest[field], "string", field);
    assert.ok(manifest[field].trim(), `${field} is required`);
  }
  assert.match(manifest.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(["planned", "archived"].includes(manifest.status));
  assert.equal(manifest.statusLabel, { planned: "计划中", archived: "历史路书" }[manifest.status]);
  assert.match(manifest.date, /^\d{4}[.年-]/);
  for (const [field, minimum] of [["route", 2], ["tags", 1]]) {
    assert.ok(Array.isArray(manifest[field]) && manifest[field].length >= minimum, field);
    assert.ok(manifest[field].every((value) => typeof value === "string" && value.trim()), field);
  }
  assert.equal(typeof manifest.imageSource, "string");
  if (manifest.imageSource) assert.equal(new URL(manifest.imageSource).protocol, "https:");
  assert.equal("path" in manifest, false, "trip.json 不含 path，由旅行首页按网址推导");

  assert.match(manifest.image, /^[A-Za-z0-9_./-]+\.(webp|png|jpe?g|avif)$/i);
  const cover = path.resolve(site, manifest.image);
  assert.ok(inside(cover) && !manifest.image.startsWith("/"), "封面必须在 site/ 内且为相对路径");
  const bytes = await readFile(cover);
  const ext = path.extname(cover).toLowerCase();
  const magic = {
    ".webp": () => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
    ".png": () => bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ".jpg": () => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    ".jpeg": () => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    ".avif": () => bytes.subarray(4, 12).toString("latin1") === "ftypavif",
  }[ext];
  assert.ok(magic(), `封面内容与扩展名 ${ext} 不符`);
});

test("index.html 的相对资源都在 site/ 内存在，且有可见的返回旅行首页链接", async () => {
  assert.match(html, /<!doctype html>/i);
  const missing = [];
  for (const [, , , raw] of html.matchAll(/\b(src|href)\s*=\s*(["'])(.*?)\2/gis)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw) || raw.includes("${")) continue;
    const target = decodeURIComponent(raw.split("#")[0].split("?")[0]);
    if (!target) continue;
    assert.ok(!target.startsWith("/"), `${raw} 不应使用站点根绝对路径`);
    const resolved = path.resolve(site, target);
    assert.ok(inside(resolved), `${raw} 越出 site/`);
    if (!(await exists(resolved))) missing.push(raw);
  }
  assert.deepEqual(missing, []);
  assert.match(html, new RegExp(`<a\\b[^>]*href=["']${HUB_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'][^>]*>\\s*回旅行首页`), "应有指向旅行首页的可见链接");
});

test("公开文件与文件名排除缓存签名、私有地图配置、绝对本地路径和密钥", async () => {
  const forbidden = /xsec_(?:token|source)|\.amap\.local|\/Users\//i;
  const secrets = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{25,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/;
  const localUrl = /https?:\/\/(?:127\.0\.0\.1|localhost)\b/i;
  for (const file of await filesIn(site)) {
    const relative = path.relative(site, file);
    assert.doesNotMatch(relative, forbidden);
    if (![".html", ".js", ".mjs", ".json", ".geojson", ".css", ".txt", ".md", ".svg"].includes(path.extname(file).toLowerCase())) continue;
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, forbidden, relative);
    assert.doesNotMatch(text, secrets, relative);
    // vendored libraries are third-party code; local-server URLs are only checked in the roadbook's own files
    if (!relative.startsWith(`vendor${path.sep}`)) assert.doesNotMatch(text, localUrl, relative);
  }
});

// A page that has not been given map data yet declares `const MAP_READY = false;` and shows a visitor-facing note instead.
const tiles = [...html.matchAll(/['"]((?:\.\/)?map\/[\w./-]+\.pmtiles)['"]/g)].map((match) => match[1]);
const usesMap = tiles.length > 0 && !/\bMAP_READY\s*=\s*false\b/.test(html);

test("使用地图的路书：三份 PMTiles、routes.geojson 与共享模块都存在，site/map 不超过 40 MB", { skip: !usesMap && "地图尚未启用（MAP_READY=false）" }, async () => {
  for (const name of ["base", "terrain", "landcover"]) await nonempty(path.join(site, `map/${name}.pmtiles`));
  await nonempty(path.join(site, "map/routes.geojson"));
  JSON.parse(await readFile(path.join(site, "map/routes.geojson"), "utf8"));
  let total = 0;
  for (const file of await filesIn(path.join(site, "map"))) total += (await stat(file)).size;
  assert.ok(total <= 40 * 1024 * 1024, `site/map 合计 ${total} 字节超出 40 MB`);
  const assets = [...html.matchAll(/(?:src|href)="(vendor\/map\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith("trip-map.js")), "应加载共享 trip-map.js");
  for (const asset of assets) await nonempty(path.join(site, asset));
  assert.doesNotMatch(html, /leaflet/i, "不应再引用 Leaflet");
});

test("共享地图样式含街道名、旅行 POI 与建筑图层，且大缩放级别不再整片留白", { skip: !usesMap && "地图尚未启用（MAP_READY=false）" }, async () => {
  const code = await readFile(path.join(site, "vendor/map/trip-map.js"), "utf8");
  for (const id of ["label-road-major", "label-road-minor", "poi-service", "poi-scenic", "buildings"]) assert.ok(code.includes(`'${id}'`), `trip-map.js 缺少图层 ${id}`);
  // 详细瓦片只沿路线存在：缺失的矢量瓦片会画成空白，所以页面必须声明整幅数据的最高缩放级别，其余图层从它过放大
  assert.match(html, /baseFullZoom\s*:\s*\d+/, "TripMap.create 需要 baseFullZoom");
});

test("高缩放细节层：页面启用在线细节，模块含离线回退，且边界层不画国界/争议/海上线", { skip: !usesMap && "地图尚未启用（MAP_READY=false）" }, async () => {
  const code = await readFile(path.join(site, "vendor/map/trip-map.js"), "utf8");
  assert.match(html, /detail\s*:\s*'https:\/\/tiles\.openfreemap\.org\/planet'/, "TripMap.create 需要传入 detail");
  for (const part of ["stopDetail", "detailReady", "AbortError"]) assert.ok(code.includes(part), `trip-map.js 缺少回退路径 ${part}`);
  // 合规：细节边界层只取省/地/县级（OSM admin_level 4/5/6/8），并显式排除国界、争议线与海上线
  const start = code.lastIndexOf("// admin boundaries"), boundary = code.slice(start, code.indexOf("// labels", start));
  assert.match(boundary, /\['>',\s*\['get',\s*'admin_level'\],\s*2\]/, "边界层需排除 admin_level <= 2");
  assert.ok(boundary.includes("'disputed'") && boundary.includes("'maritime'"), "边界层需排除 disputed 与 maritime");
});

async function loadTripMap() {
  const code = await readFile(path.join(site, "vendor/map/trip-map.js"), "utf8");
  const sandbox = { URLSearchParams, Number, Math, RangeError, Array, Object, Set, document: {}, location: { href: "http://x/" } };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.TripMap;
}

test("共享地图模块的高德分段导航：URL、GCJ-02 偏移与分段数", async () => {
  const { amapRoute, navSegments } = await loadTripMap();
  const stop = (name, lng, lat) => ({ name, lngLat: [lng, lat] });
  const stops = [stop("乌兰浩特", 122.0, 46.1), stop("阿尔山市", 119.94, 47.17), stop("柴河", 121.3, 47.55), stop("牙克石", 120.73, 49.29)];

  assert.equal(navSegments(stops).length, 2);
  assert.equal(navSegments(stops).map((s) => s.stops.length).join(), "3,2");
  assert.equal(navSegments(stops.slice(0, 3)).length, 1);

  const url = new URL(amapRoute(stops.slice(0, 3), "t"));
  assert.equal(url.origin + url.pathname, "https://uri.amap.com/navigation");
  assert.equal([...url.searchParams.keys()].join(), "from,to,mode,policy,callnative,src,via");
  assert.equal(url.searchParams.get("mode"), "car");
  assert.equal(url.searchParams.get("policy"), "0");
  assert.equal(url.searchParams.get("callnative"), "1");
  assert.match(url.searchParams.get("from"), /^\d+\.\d{6},\d+\.\d{6},乌兰浩特$/);
  assert.match(url.searchParams.get("via"), /,阿尔山市$/);
  assert.match(url.searchParams.get("to"), /,柴河$/);
  assert.equal(new URL(amapRoute(stops.slice(0, 2), "t")).searchParams.has("via"), false);
  assert.throws(() => amapRoute(stops, "t"), RangeError);
});

test("页面保留高德分段路线清单，并在地图可用时放置图例", () => {
  assert.match(html, /TripMap\.navSegments/);
  assert.match(html, /TripMap\.amapRoute/);
  if (usesMap) assert.match(html, /TripMap\.renderLegend/);
});

test("预览服务器按 /<目录名>/ 提供 site/，支持 Range（206/416）并拒绝越界路径", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(root, "scripts/serve.mjs"), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`serve.mjs exited ${code}`)));
    child.stdout.once("data", resolve);
  });
  const base = `http://127.0.0.1:${port}/${path.basename(root)}/`;
  const file = `${base}vendor/map/trip-map.js`;
  const size = (await stat(path.join(site, "vendor/map/trip-map.js"))).size;

  const head = await fetch(base);
  assert.equal(head.status, 200);
  assert.match(head.headers.get("content-type"), /text\/html/);
  assert.equal((await fetch(file)).headers.get("accept-ranges"), "bytes");
  const partial = await fetch(file, { headers: { range: "bytes=0-9" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-9/${size}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 10);
  const tail = await fetch(file, { headers: { range: "bytes=-5" } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), `bytes ${size - 5}-${size - 1}/${size}`);
  assert.equal((await fetch(file, { headers: { range: `bytes=${size + 10}-` } })).status, 416);
  assert.equal((await fetch(`${base}..%2f..%2fpackage.json`)).status >= 400, true);
  assert.equal((await fetch(`${base}missing.txt`)).status, 404);
});
