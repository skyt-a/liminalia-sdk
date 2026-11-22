import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { decodePng } from "../../../cli/src/mobile/icon.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 名前欄は、メッセージ枠と同じ重なりにいる。枠より上の層（@flash、@movie、overlay に置いた絵）が枠を覆うときは、名前欄も一緒に覆う
 * （名前欄の z-index が枠の外へ漏れて、光や動画の上に名前だけが浮いていた）。名前欄の箱の画素がすべて上の層の色になるかで確かめる。
 */

const MOVIE = resolve(import.meta.dirname, "fixtures/test-movie.webm");

const SCENARIO = `@window show
アカリ「はじまり」
@movie m.webm skip=true
アカリ「動画のあと」
@flash type=color color=#ff0000 time=60000 fade=0ms wait=false
アカリ「光の中」
`;

/** 名前欄の箱（少し内側）の画素のうち、色 rgb に近いものの割合。 */
async function nameCovered(p: Page, rgb: [number, number, number]): Promise<number> {
  const box = (await p.evaluate(`(() => { const r = document.querySelector(".message .name").getBoundingClientRect(); return { x: Math.ceil(r.left) + 2, y: Math.ceil(r.top) + 2, width: Math.floor(r.width) - 4, height: Math.floor(r.height) - 4 }; })()`)) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const img = decodePng(await p.screenshot({ clip: box }))!;
  let near = 0;
  for (let i = 0; i < img.data.length; i += 4) if (Math.abs(img.data[i]! - rgb[0]) + Math.abs(img.data[i + 1]! - rgb[1]) + Math.abs(img.data[i + 2]! - rgb[2]) < 30) near++;
  return near / (img.data.length / 4);
}

const waitPage = (p: Page, text: string) =>
  p.waitForFunction(`window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`, null, { timeout: 60_000 });

describe.skipIf(!e2e)("名前欄と枠の上の層（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    // 送ったページの名前と本文は、次の命令（ここでは @movie）で消えるのが既定（ui.message.keepText。after-page.test.ts）。
    // 名前欄が出たまま上の層に覆われるかを見るので、前のページの名前を残す
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { message: { keepText: true } } }, files: { "assets/video/m.webm": MOVIE } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("@movie と @flash が枠を覆う間は、名前欄も覆う", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitPage(p, "はじまり");
      const advance = () => p.evaluate("window.__liminalia.host.advance()");
      // 動画の間: 流れ始めた動画を止め、絵を白一色にして（明るさ 0 を反転）、名前欄の上が白いかを見る
      await advance();
      expect(await p.evaluate(`document.querySelector(".message .name").textContent`), name).toBe("アカリ");
      await p.waitForFunction(`(() => { const v = document.querySelector("video.lim-movie"); return !!v && getComputedStyle(v).display !== "none" && getComputedStyle(v).opacity === "1" && !v.paused && v.currentTime > 0; })()`, null, { timeout: 60_000 });
      await p.evaluate(`(() => { const v = document.querySelector("video.lim-movie"); v.pause(); v.style.filter = "brightness(0) invert(1)"; })()`);
      expect(await nameCovered(p, [255, 255, 255]), name).toBe(1);
      // 飛ばせる動画なので、送りで終える（止めた動画を流し直すと、WebKit は時刻が進まないことがある）
      await advance();
      await waitPage(p, "動画のあと");
      expect(await nameCovered(p, [255, 0, 0]), name).toBe(0);
      // 光（ここでは赤）の間: 名前欄の上も光の色
      await advance();
      await waitPage(p, "光の中");
      await p.waitForFunction(`getComputedStyle(document.querySelector(".lim-flash")).opacity === "1"`, null, { timeout: 60_000 });
      expect(await nameCovered(p, [255, 0, 0]), name).toBe(1);
      await p.close();
    }
  });
});
