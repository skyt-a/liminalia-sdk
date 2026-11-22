import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 探索パート（調べる場所のカーソルと説明・持ち物・持ち物を選ばせる）を、実際のブラウザで確かめる。 */

const ICON = resolve(import.meta.dirname, "fixtures/layer-top.png");

const scenario = `@bg hill_dusk.webp
@window show
@item-add key
@item-add coin count=3
どこを調べる？
# look
@choice
- 扉 -> #door x=100 y=100 width=200 height=300 cursor=icons/lens.png tip="古い扉"
- 窓 -> #window x=600 y=100 width=200 height=200
@end
# door
@item-select temp.used
@if (temp.used == "key")
扉が開いた。
@else
何も起きない。
@end
# window
窓だ。
`;

describe.skipIf(!e2e)("探索パートと持ち物（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a", items: { key: { name: "古い鍵", image: "icons/lens.png", description: "錆びている。" }, coin: { name: "銅貨" }, map: { name: "地図" } } },
      files: { "assets/image/icons/lens.png": ICON },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("調べる場所にカーソルと説明を出し、持ち物の画面で選んだものを変数に入れる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("どこを調べる")`);
      // 手に入れた知らせ（後のものが前のものを置き換える）
      expect(await p.locator(".lm-toast").textContent(), name).toContain("銅貨");
      // メニューの「持ち物」: 持っているものだけ、数と説明
      await p.keyboard.press("Escape");
      await p.locator('.lm-menu button[data-action="items"]').click();
      expect(await p.locator(".lm-items-tile").allTextContents(), name).toEqual(["古い鍵", "銅貨×3"]);
      expect(await p.locator(".lm-items-desc").textContent()).toBe("錆びている。");
      expect(await p.locator(".lm-items-use").count()).toBe(0);
      await p.locator(".lm-items .lm-close").click();
      await p.waitForTimeout(300);
      await p.mouse.click(640, 300);
      const door = p.locator(".choices button.choice-area").first();
      await door.waitFor();
      const look = await door.evaluate((b) => ({ cursor: getComputedStyle(b).cursor, tip: b.dataset.tip, label: b.getAttribute("aria-label") }));
      expect(look.cursor, name).toContain("icons/lens.png");
      expect(look.tip).toBe("古い扉");
      await door.hover();
      await p.waitForTimeout(200);
      expect(await door.evaluate((b) => getComputedStyle(b, "::after").opacity), name).toBe("1");
      await door.click();
      // 選ばせる画面: 「何を使う？」で銅貨を選ぶと開かない、鍵なら開く
      await p.locator(".lm-items .lm-screen-title").waitFor();
      expect(await p.locator(".lm-items .lm-screen-title").textContent()).toBe("何を使う？");
      await p.locator('.lm-items-tile[data-item="key"]').click();
      await p.locator(".lm-items-use").click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("扉が開いた")`);
      expect(await p.locator(".lm-items").count()).toBe(0);
      await p.close();
    }
  });
});
