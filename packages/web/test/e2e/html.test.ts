import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** JS なしの HTML（@html / @html-hide）を、実際のブラウザで確かめる。 */

const ICON = resolve(import.meta.dirname, "fixtures/layer-top.png");

const SCENARIO = `@window show
@set game.day = 3
@html card x=100 y=80 width=500 wait=true
<div class="card" style="color: rgb(255, 0, 0)">今日は <b>{= game.day}</b> 日目 {= "<i>x</i>"}</div>
<img src="icons/sun.png" alt="晴れ">
<button data-jump="#market">市場へ</button>
<button data-jump="#home">家へ</button>
@end
通り過ぎた。
# market
@html-hide card
市場に着いた。
# home
家に着いた。
`;

// 検査を通らない台本でも、描画側が同じ一覧で掃除し直すので JS は動かない
const UNSAFE = `@html bad
<script>window.__bad = 1</script>
<p onclick="window.__bad = 2" style="background: url(https://example.com/a.png)" id="x">ok</p>
<img src="https://example.com/a.png" onerror="window.__bad = 3">
<iframe src="https://example.com"></iframe>
@end
終わり。
`;

describe.skipIf(!e2e)("JS なしの HTML（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO, b: UNSAFE }, config: { entry: "a" }, files: { "assets/image/icons/sun.png": ICON } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("式を埋めて置き、ロードで同じ表示に戻し、押した data-jump へ飛び、@html-hide で消す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".lim-html[data-waiting] button");
      const look = () =>
        p.evaluate(`(() => {
          const el = document.querySelector(".lim-html");
          return { text: el.querySelector(".card").textContent, color: getComputedStyle(el.querySelector(".card")).color, img: el.querySelector("img").getAttribute("src"), left: el.style.left, count: document.querySelectorAll(".lim-html").length };
        })()`);
      const before = (await look()) as { text: string; color: string; img: string; left: string; count: number };
      expect(before.text, name).toBe("今日は 3 日目 <i>x</i>");
      expect(before.color, name).toBe("rgb(255, 0, 0)");
      expect(before.img, name).toContain("icons/sun.png");
      expect([before.left, before.count], name).toEqual(["100px", 1]);
      // 待っている間にセーブしてロードすると、同じ表示に戻ってまた押すのを待つ
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForTimeout(800);
      await p.waitForSelector(".lim-html[data-waiting] button");
      expect(await look(), name).toEqual(before);
      // 舞台をクリックしても進まない（押すものを待つ）
      await p.mouse.click(1000, 600);
      await p.waitForTimeout(300);
      expect(await p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`), name).not.toContain("通り過ぎた");
      await p.locator('.lim-html button[data-jump="#market"]').click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("市場に着いた")`);
      expect(await p.evaluate(`document.querySelectorAll(".lim-html").length`), name).toBe(0);
      await p.close();
    }
  });

  it("使えないタグ・属性・外の URL は置く前に捨てる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=b`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("終わり")`);
      expect(await p.evaluate(`document.querySelector(".lim-html").innerHTML.trim()`), name).toBe("<p>ok</p>\n<img>");
      expect(await p.evaluate("window.__bad ?? null"), name).toBe(null);
      await p.close();
    }
  });
});
