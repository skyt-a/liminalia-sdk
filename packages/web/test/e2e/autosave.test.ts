import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** オートセーブ（@autosave・@autoload・ロード画面のページ・裏へ回ったとき）を、実際のブラウザで確かめる。 */

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`);
const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s);
const autos = (p: Page) => p.evaluate(`window.__liminalia.system.autoSlots().map((s) => s.empty ? null : s.title)`) as Promise<(string | null)[]>;

describe.skipIf(!e2e)("オートセーブ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let timed: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    timed = await startProject({
      scenario: {
        c: "@window show\n一。\n二。\n三。\n@choice\n- 甲 -> #a\n@end\n# a\n四。\n@jump d\n",
        d: "五。\n六。\n",
      },
      config: {
        entry: "c",
        chapters: [
          { id: "c1", title: "一章", files: ["c"] },
          { id: "c2", title: "二章", files: ["d"] },
        ],
        ui: { autosave: { on: { pages: 2, chapter: true } }, title: { resume: true } },
      },
    });
    project = await startProject({
      scenario: {
        a: "@window show\nいちページめ。\n@autosave\nにページめ。\nさんページめ。\n@autoload\nここへは来ない。\n",
        b: "@window show\nまつページ。\n@wait 4s\nつぎのページ。\n",
      },
      config: { entry: "a" },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await timed?.close();
  });

  it("ui.autosave.on: 選択肢を出したとき、N ページごと、章の頭で書く。ui.title.resume ならタイトルの「つづきから」でいちばん新しいものから再開する", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${timed.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "一。");
      expect(await autos(p), name).toEqual([null, null, null]);
      await p.mouse.click(640, 300);
      // 二ページ読んだ
      await waitText(p, "二。");
      expect(await autos(p), name).toEqual(["二。", null, null]);
      await p.mouse.click(640, 300);
      await waitText(p, "三。");
      await p.mouse.click(640, 300);
      // 選択肢を出した（既定でする）
      await p.waitForSelector(".choices button");
      await p.waitForTimeout(200);
      expect(await autos(p), name).toEqual(["三。", "二。", null]);
      await p.locator(".choices button").first().click();
      await waitText(p, "四。");
      await p.mouse.click(640, 300);
      // 章の頭（liminalia.json の chapters の章が替わった）
      await waitText(p, "五。");
      expect(await autos(p), name).toEqual(["五。", "三。", "二。"]);
      await p.mouse.click(640, 300);
      await waitText(p, "六。");
      // タイトルの「つづきから」は、ロード画面を開かずにいちばん新しいセーブから
      await p.evaluate("window.__liminalia.system.showTitle(true)");
      await p.locator(".lm-title-button", { hasText: "つづきから" }).click();
      await waitText(p, "五。");
      expect(await p.evaluate("window.__liminalia.screen().screen"), name).toBeNull();
      await p.close();
    }
  });

  it("@autosave で枠に書き、@autoload でいちばん新しいものから続ける。ロード画面の先頭にオートセーブのページを出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      // セーブが無ければ「つづきから」は押せない
      expect(await p.locator(".lm-title-button", { hasText: "つづきから" }).isDisabled(), name).toBe(true);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "いちページめ");
      await p.mouse.click(640, 300);
      await waitText(p, "にページめ");
      expect(await autos(p), name).toEqual(["いちページめ。", null, null]);
      await p.mouse.click(640, 300);
      await waitText(p, "さんページめ");
      await p.mouse.click(640, 300);
      // @autoload: @autosave の次（にページめ）から
      await waitText(p, "にページめ");
      expect(await text(p), name).toContain("にページめ");
      // ロード画面: オートセーブのページが先頭で、いちばん新しいものがあるので開いたときに選ばれている
      await p.evaluate("window.__liminalia.system.openSaveLoad('load')");
      const tabs = await p.locator(".lm-saveload .lm-tab").allTextContents();
      expect(tabs.slice(0, 2), name).toEqual(["A", "Q"]);
      expect(await p.locator(".lm-saveload .lm-tab").first().getAttribute("aria-pressed"), name).toBe("true");
      expect(await p.locator(".lm-slot-name").first().textContent(), name).toBe("オートセーブ");
      expect(await p.locator(".lm-slot-text").first().textContent(), name).toBe("いちページめ。");
      // オートセーブにはメモ・保護・コピー・移動を付けない（削除だけ）
      expect(await p.locator(".lm-slot-wrap").first().locator(".lm-slot-tool").allTextContents(), name).toEqual(["削除"]);
      // セーブ画面にはオートセーブのページを出さない
      await p.keyboard.press("Escape");
      await p.evaluate("window.__liminalia.system.openSaveLoad('save')");
      expect(await p.locator(".lm-saveload .lm-tab").first().textContent(), name).toBe("1");
      await p.keyboard.press("Escape");
      // タイトルの「つづきから」はオートセーブだけでも押せる
      await p.evaluate("window.__liminalia.system.showTitle(true)");
      expect(await p.locator(".lm-title-button", { hasText: "つづきから" }).isDisabled(), name).toBe(false);
      await p.close();
    }
  });

  it("裏へ回ったとき・閉じるときにオートセーブする（同じページなら同じ枠に書き直す）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "いちページめ");
      // タイトルでは書かない
      await p.mouse.click(640, 300);
      await waitText(p, "にページめ");
      expect(await autos(p), name).toEqual(["いちページめ。", null, null]);
      // 今のページ（にページめ）から再開するオートセーブ。@autosave の位置（その次の行＝このページ）と同じなので、同じ枠に書き直す
      await p.evaluate(`window.dispatchEvent(new Event("pagehide"))`);
      expect(await autos(p), name).toEqual(["にページめ。", null, null]);
      // 続けて来たもの（visibilitychange と pagehide）は一つにし、少したってから同じページで来ても同じ枠
      await p.evaluate(`window.dispatchEvent(new Event("pagehide"))`);
      await p.waitForTimeout(1100);
      await p.evaluate(`window.__liminalia.leave()`);
      expect(await autos(p), name).toEqual(["にページめ。", null, null]);
      // 別のページで裏へ回ったら、次の枠に書く
      await p.mouse.click(640, 300);
      await waitText(p, "さんページめ");
      await p.waitForTimeout(1100);
      await p.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      expect(await autos(p), name).toEqual(["にページめ。", null, null]);
      await p.evaluate(`window.dispatchEvent(new Event("pagehide"))`);
      expect(await autos(p), name).toEqual(["さんページめ。", "にページめ。", null]);
      // オートセーブから再開すると、そのページから
      const slot = await p.evaluate(`window.__liminalia.system.autoSlots()[1].slot`);
      await p.evaluate(`window.__liminalia.system.loadFrom(${JSON.stringify(slot)})`);
      await waitText(p, "にページめ");
      await p.close();
    }
  });

  it("演出の途中なら最後に出したページから再開するように書き、作品の設定（ui.autosave.leave）で外せる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      await p.evaluate(`window.__liminalia.system.startAt("b")`);
      await waitText(p, "まつページ");
      // 開発用に途中から始めたプレイ（startAt）では書かない
      await p.evaluate(`window.__liminalia.leave()`);
      expect(await autos(p), name).toEqual([null, null, null]);
      await p.evaluate(`window.__liminalia.system.stayOnEnd = false`);
      await p.mouse.click(640, 300);
      // @wait の途中（クリック待ちでない）
      await p.waitForTimeout(300);
      expect(await p.evaluate(`window.__liminalia.host.waiting`), name).toBe(false);
      await p.evaluate(`window.__liminalia.leave()`);
      expect(await autos(p), name).toEqual(["まつページ。", null, null]);
      await p.evaluate(`window.__liminalia.system.loadFrom("auto:0")`);
      await waitText(p, "まつページ");
      // 外す
      await p.waitForTimeout(1100);
      await p.evaluate(`window.__liminalia.system.env.project.ui = { autosave: { leave: false } }`);
      await p.mouse.click(640, 300);
      await p.waitForTimeout(300);
      await p.evaluate(`window.__liminalia.leave()`);
      expect(await p.evaluate(`window.__liminalia.system.autoSlots().filter((s) => !s.empty).length`), name).toBe(1);
      await p.close();
    }
  });
});
