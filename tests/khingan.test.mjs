import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const site = path.join(fileURLToPath(new URL("../", import.meta.url)), "site");
const nonempty = async (file) => assert.ok((await stat(file)).size > 0, file);

test("大兴安岭九张动态参考图、hero与动画脚本均可在同目录解析", async () => {
  const html = await readFile(path.join(site, "index.html"), "utf8");
  const images = new Set([...html.matchAll(/image:\s*['"](xhs-spots\/[^'"]+)['"]/g)].map((match) => match[1]));
  assert.equal(images.size, 9);
  for (const image of images) await nonempty(path.join(site, image.replace("xhs-spots/", "xhs-spots/opt2/")));
  await nonempty(path.join(site, "xhs-spots/haraha-river.webp"));
  for (const script of ["gsap.min.js", "ScrollTrigger.min.js"]) {
    assert.ok(html.includes(`src="${script}"`));
    await nonempty(path.join(site, script));
  }
});
