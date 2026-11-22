import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * おまけの CG の鑑賞（一つの画面にしてフォーカスを閉じ込める、キーとパッドで前後と差分、拡大と移動、まとまりのタブと割合、説明）と、
 * エンディングの一覧のタブ（extra.endings）を、実際のブラウザで確かめる。
 */

const SCENARIO = `@window show
はじまり。
@choice
- 甲 -> #a
- 乙 -> #b
@end
# a
甲の道。
@title-screen ending="GOOD END"
# b
乙の道。
@title-screen ending="BAD END"
`;

const CG = [
  { id: "dusk", title: "夕暮れ", description: "丘の上で", chapter: "c1", images: ["hill_dusk.webp", "hill_morning.webp"] },
  { id: "night", title: "夜", chapter: "c1", images: ["hill_night.webp"] },
  { id: "omake", title: "番外", group: "番外編", images: ["hill_morning.webp"] },
];

const viewer = (p: Page) =>
  p.evaluate(() => {
    const v = document.querySelector(".lm-extra-viewer");
    if (!v) return null;
    const src = decodeURIComponent(v.querySelector("img")?.getAttribute("src") ?? "");
    return { image: src.replace(/^.*\//, "").replace(/\?.*$/, ""), page: v.querySelector(".lm-extra-page")?.textContent ?? "", title: v.querySelector(".lm-extra-caption-title")?.textContent ?? "", focused: document.activeElement === v };
  });

/** ゲームパッドのボタンを押したことにする（bindPlayerInput の受け口）。 */
const pad = async (p: Page, button: string) => {
  await p.evaluate((b) => {
    const root = document.querySelector(".lm-extra-viewer") ?? document.body;
    root.dispatchEvent(new CustomEvent("lm-pad", { bubbles: true, cancelable: true, detail: { button: b } }));
  }, button);
  await p.waitForTimeout(80);
};

describe.skipIf(!e2e)("おまけの CG の鑑賞とエンディングの一覧（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", chapters: [{ id: "c1", number: "第一章", title: "丘", files: ["a"] }], extra: { cg: CG, endings: true } },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("まとまりのタブと割合、キーとパッドで前後と差分、裏のタブは押せない、拡大と移動、Esc で閉じて開いたタイルへ戻る", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate(`Object.assign(window.__liminalia.system.systemVariables.cg_unlocked ??= {}, { "hill_dusk.webp": true, "hill_morning.webp": true, "hill_night.webp": true })`);
      await p.evaluate("window.__liminalia.system.openExtra('cg')");
      await p.waitForSelector(".lm-extra-groups");
      // 章（chapter）と group でタブを分け、まとまりの解放の数と割合を出す
      expect(await p.locator(".lm-extra-groups .lm-tab").allTextContents(), name).toEqual(["第一章", "番外編"]);
      expect(await p.locator(".lm-extra-cg .lm-extra-progress").textContent(), name).toBe("3 / 3（100%）");
      expect(await p.locator(".lm-extra-cg .lm-extra-title").allTextContents(), name).toEqual(["夕暮れ", "夜"]);
      expect(await p.locator(".lm-extra-tile").first().getAttribute("title"), name).toBe("丘の上で");
      // 縮小画像を書いていない CG の一覧は、その場で縮めた画像を出す（元の 1280×720 を並べない。2026-11-20 の P4）
      await expect.poll(() => p.evaluate(`[...document.querySelectorAll(".lm-extra-cg .lm-extra-thumb img")].map((i) => i.src.startsWith("blob:") && i.complete && i.naturalWidth > 0 && i.naturalWidth <= 640)`), { timeout: 15_000 }).toEqual([true, true]);

      // 開くと一つの画面になり、フォーカスはその中。裏のタブと一覧は inert
      await p.locator(".lm-extra-tile").first().click();
      expect(await viewer(p), name).toMatchObject({ image: "hill_dusk.webp", page: "1 / 2", title: "夕暮れ", focused: true });
      expect(await p.evaluate(`[...document.querySelector(".lm-extra").children].filter((c) => !c.classList.contains("lm-extra-viewer")).every((c) => c.inert)`), name).toBe(true);
      expect(await p.evaluate(`document.querySelector(".lm-extra-viewer").getAttribute("role")`), name).toBe("dialog");
      // ↓ で差分、→ で次の CG、← で戻る。Enter で次の差分
      await p.keyboard.press("ArrowDown");
      expect(await viewer(p), name).toMatchObject({ image: "hill_morning.webp", page: "2 / 2" });
      await p.keyboard.press("ArrowRight");
      expect(await viewer(p), name).toMatchObject({ image: "hill_night.webp", title: "夜", page: "" });
      await p.keyboard.press("ArrowLeft");
      await p.keyboard.press("Enter");
      expect(await viewer(p), name).toMatchObject({ image: "hill_morning.webp", page: "2 / 2" });
      // パッド: 上で差分を戻る、右で次の CG、RT で拡大、X で元に戻す
      await pad(p, "up");
      expect(await viewer(p), name).toMatchObject({ image: "hill_dusk.webp" });
      await pad(p, "rt");
      expect(await p.evaluate(`document.querySelector(".lm-extra-viewer").classList.contains("is-zoomed")`), name).toBe(true);
      await pad(p, "x");
      expect(await p.evaluate(`document.querySelector(".lm-extra-viewer").classList.contains("is-zoomed")`), name).toBe(false);
      // 矢印キーは裏のタブへは移らない（左右は CG の前後）
      await p.keyboard.press("ArrowRight");
      expect(await viewer(p), name).toMatchObject({ image: "hill_night.webp", focused: true });
      // Ctrl を押しながらホイールで拡大し、ドラッグで動かす（拡大している間のクリックは送らない）
      await p.mouse.move(640, 360);
      await p.keyboard.down("Control");
      await p.mouse.wheel(0, -400);
      await p.keyboard.up("Control");
      await p.waitForTimeout(80);
      const zoomed = (await p.evaluate(`document.querySelector(".lm-extra-viewer img").style.transform`)) as string;
      expect(zoomed, name).toMatch(/scale\(/);
      await p.mouse.down();
      await p.mouse.move(540, 300, { steps: 4 });
      await p.mouse.up();
      expect(await p.evaluate(`document.querySelector(".lm-extra-viewer img").style.transform`), name).not.toBe(zoomed);
      expect(await viewer(p), name).toMatchObject({ image: "hill_night.webp" });
      // 0 で戻し、Esc で閉じると開いたタイルにフォーカスが戻る
      await p.keyboard.press("0");
      await p.keyboard.press("Escape");
      await p.waitForTimeout(100);
      expect(await viewer(p), name).toBeNull();
      expect(await p.evaluate(`document.activeElement === document.querySelector(".lm-extra-tile")`), name).toBe(true);
      // まとまりのタブを替える
      await p.locator(".lm-extra-groups .lm-tab", { hasText: "番外編" }).click();
      expect(await p.locator(".lm-extra-cg .lm-extra-title").allTextContents(), name).toEqual(["番外"]);
      await p.close();
    }
  });

  it("ゲームパッドの右スティックで開いている画面を送り、標準の配置でないゲームパッドは知らせる", async () => {
    const many = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", extra: { cg: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, title: `CG ${i}`, images: ["hill_dusk.webp"] })) } },
    });
    try {
      for (const { name, browser } of list) {
        const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        // ボタンの配置の分からないゲームパッド（mapping が空）
        await p.addInitScript(() => {
          const pad = { id: "Test pad", index: 0, connected: true, mapping: "", timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] };
          (window as unknown as { __pad: typeof pad }).__pad = pad;
          Object.defineProperty(navigator, "getGamepads", { value: () => [pad], configurable: true });
        });
        await p.goto(`${many.url}?autostart=1&start=a`);
        await p.waitForSelector(".message .text .ch", { timeout: 60_000 });
        await p.evaluate(`Object.assign(window.__liminalia.system.systemVariables.cg_unlocked ??= {}, { "hill_dusk.webp": true })`);
        await p.evaluate("window.__liminalia.system.openExtra('cg')");
        await p.waitForSelector(".lm-extra-tile");
        expect(await p.evaluate(`document.querySelector(".lm-extra-body").scrollTop`), name).toBe(0);
        await p.evaluate(`window.__pad.axes[3] = 0.9; window.dispatchEvent(new Event("gamepadconnected"))`);
        await p.waitForTimeout(400);
        await p.evaluate(`window.__pad.axes[3] = 0`);
        expect(await p.evaluate(`document.querySelector(".lm-extra-body").scrollTop`), name).toBeGreaterThan(50);
        expect(await p.evaluate(`document.querySelector(".lm-toast")?.textContent ?? ""`), name).toContain("ボタンの配置");
        await p.close();
      }
    } finally {
      await many.close();
    }
  });

  it("extra.endings でエンディングの一覧をおまけのタブに出す（着いたものだけ名前）", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(80);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".choices button");
      await p.locator(".choices button").first().click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("甲の道")`);
      await p.evaluate("window.__liminalia.system.openExtra('endings')");
      await p.waitForSelector(".lm-flow-ending");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-flow-ending .lm-extra-name")].map((e) => e.textContent)`), name).toEqual(["GOOD END", "？？？"]);
      expect(await p.locator(".lm-extra .lm-tab", { hasText: "エンディング" }).getAttribute("aria-pressed"), name).toBe("true");
      await p.close();
    }
  });
});
