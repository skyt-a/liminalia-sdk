import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 人数による立ち位置の読み替え（autoLayout の byCount）で、人数が変わったときの動き。前の文のときに見えていた立ち絵は
 * 読み替え先へ滑り、同じ文の前でいっしょに出てきた立ち絵は滑らずに読み替え先から出る。
 */

/** 二人がいっしょに出る（一人目は二人目が出た時点でまだ見えていない）。 */
const together = `@bg hill_dusk.webp
@window show
はじまり。
@chara アカリ at=left time=600ms
@chara ソウ at=right time=600ms
二人。
`;

/** 一人目が見えたあと、次の文の前で二人目が出る。 */
const later = `@bg hill_dusk.webp
@window show
@chara アカリ at=left time=0ms
一人。
@chara ソウ at=right time=600ms
二人。
`;

/** 一人目が見えたあと、文を挟まずに @wait で待ってから二人目が出る（待つ間、一人目は見えている）。 */
const waited = `@bg hill_dusk.webp
@window show
はじまり。
@chara アカリ at=left time=0ms
@wait 1500ms
@chara ソウ at=right time=600ms
二人。
`;

/** 一人目がすぐ（time=0ms）出て、待たずに二人目が出る（一人目を見る間は無い）。 */
const instant = `@bg hill_dusk.webp
@window show
はじまり。
@chara アカリ at=left time=0ms
@chara ソウ at=right time=600ms
二人。
`;

/** 最後の文のあとに一人目が出て、選択肢の間ずっと見えている。選んだあとに二人目が出る。 */
const chosen = `@bg hill_dusk.webp
@window show
はじまり。
@chara アカリ at=left time=0ms
@choice
- 進む -> #go
@end
# go
@chara ソウ at=right time=600ms
二人。
`;

/** 文のあとに二人が出て、待ったあとに一人が消え（消え終わるまで待つ）、残った一人の読み替えが外れる。 */
const hidden = `@bg hill_dusk.webp
@window show
はじまり。
@chara アカリ at=left time=0ms
@chara ソウ at=right time=0ms
@wait 1500ms
@chara-hide ソウ time=600ms wait=true
一人。
`;

/** 一人目が出たあと、文を挟まずに、終わるまで待つ背景の切り替え（@bg の既定）のあとで二人目が出る。 */
const afterBg = `@bg hill_dusk.webp
@window show
はじまり。
@chara アカリ at=left time=0ms
@bg hill_night.webp time=1500ms
@chara ソウ at=right time=600ms
二人。
`;

/** キャストに無い人物（立ち絵は出ない）と二人。状態の人数は二人なので、制作画面のシーンの情報と同じく読み替える。 */
const missing = `@bg hill_dusk.webp
@window show
@chara 謎 at=right time=0ms
@chara アカリ at=left time=0ms
二人。
`;

/** その人物の立ち絵の左端と、left を動かすアニメーションがあるか。 */
const state = (p: Page, who: string) =>
  p.evaluate((who) => {
    const el = document.querySelector<HTMLElement>(`.sprite[data-who="${who}"]`)!;
    return {
      left: parseFloat(el.style.left),
      sliding: el.getAnimations().some((a) => (a.effect as KeyframeEffect).getKeyframes().some((f) => f.left !== undefined)),
    };
  }, who);

describe.skipIf(!e2e)("人数による立ち位置の読み替え（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { together, later, waited, instant, chosen, hidden, missing, afterBg },
      config: { entry: "together", autoLayout: { byCount: { "2": { left: "left-wide" } } } },
      // 立ち絵の枠に読み替え先（left から 100px 左）を足す
      before(dir) {
        const path = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(path, "utf8"));
        for (const entry of Object.values<{ appearances: Record<string, { variants: Record<string, { frame?: { positions?: Record<string, { left: number; top: number }> } }> }> }>(cast.cast)) {
          for (const appearance of Object.values(entry.appearances)) {
            for (const variant of Object.values(appearance.variants)) {
              const positions = variant.frame?.positions;
              if (positions?.left) positions["left-wide"] = { left: positions.left.left - 100, top: positions.left.top };
            }
          }
        }
        writeFileSync(path, JSON.stringify(cast));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("同じ文の前でいっしょに出た立ち絵は、滑らずに読み替え先から出る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=together`);
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("はじまり")');
      await p.waitForTimeout(300);
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      const during = await state(p, "アカリ");
      expect(during.sliding, name).toBe(false);
      await p.waitForTimeout(900);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(during.left, 0);
      await p.close();
    }
  });

  it("前の文のときに見えていた立ち絵は、読み替え先へ滑る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=later`);
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("一人")');
      await p.waitForTimeout(300);
      const before = await state(p, "アカリ");
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      expect((await state(p, "アカリ")).sliding, name).toBe(true);
      await p.waitForTimeout(900);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(before.left - 100, 0);
      await p.close();
    }
  });

  /** start から始め、text の文でクリックして、その人物の立ち絵が付くまで待つ。 */
  const openAt = async (browser: Browser, start: string, text: string) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${project.url}?autostart=1&start=${start}`);
    await p.waitForFunction((t) => document.querySelector(".message .text")?.textContent?.includes(t), text);
    await p.waitForTimeout(300);
    return p;
  };

  it("立ち絵を出せない人物（キャストに無い）も、人数には状態のとおりに数える", async () => {
    for (const { name, browser } of list) {
      // 一人のときの left の位置
      const one = await openAt(browser, "later", "一人");
      const left = (await state(one, "アカリ")).left;
      await one.close();
      const p = await openAt(browser, "missing", "二人");
      expect(await p.evaluate(() => Object.keys(window.__liminalia!.runtime()!.state.stage.sprites).sort()), name).toEqual(["アカリ", "謎"]);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(left - 100, 0);
      await p.close();
    }
  });

  it("文を挟まずに @wait で待つ間に見えていた立ち絵は、読み替え先へ滑る", async () => {
    for (const { name, browser } of list) {
      const p = await openAt(browser, "waited", "はじまり");
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="アカリ"]', { state: "attached" });
      await p.waitForTimeout(500);
      const before = await state(p, "アカリ");
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached", timeout: 5000 });
      expect((await state(p, "アカリ")).sliding, name).toBe(true);
      await p.waitForTimeout(900);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(before.left - 100, 0);
      await p.close();
    }
  });

  it("終わるまで待つ命令（背景の切り替え）の間に見えていた立ち絵は、読み替え先へ滑る", async () => {
    for (const { name, browser } of list) {
      const p = await openAt(browser, "afterBg", "はじまり");
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="アカリ"]', { state: "attached" });
      await p.waitForTimeout(500);
      const before = await state(p, "アカリ");
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached", timeout: 5000 });
      expect((await state(p, "アカリ")).sliding, name).toBe(true);
      await p.waitForTimeout(900);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(before.left - 100, 0);
      await p.close();
    }
  });

  it("すぐに出て見る間の無かった立ち絵（time=0ms の直後に次の人物）は、滑らずに読み替え先に置く", async () => {
    for (const { name, browser } of list) {
      const p = await openAt(browser, "instant", "はじまり");
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      expect((await state(p, "アカリ")).sliding, name).toBe(false);
      await p.close();
    }
  });

  it("選択肢の間に見えていた立ち絵は、選んだあとに並べ方が変わると読み替え先へ滑る", async () => {
    for (const { name, browser } of list) {
      const p = await openAt(browser, "chosen", "はじまり");
      await p.mouse.click(640, 80);
      await p.waitForSelector(".choices button");
      await p.waitForTimeout(300);
      const before = await state(p, "アカリ");
      await p.locator(".choices button").first().click();
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      expect((await state(p, "アカリ")).sliding, name).toBe(true);
      await p.waitForTimeout(900);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(before.left - 100, 0);
      await p.close();
    }
  });

  it("@wait の間に見えていた立ち絵は、ほかの人物が消えて読み替えが外れると元の位置へ滑る", async () => {
    for (const { name, browser } of list) {
      const p = await openAt(browser, "hidden", "はじまり");
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      await p.waitForTimeout(500);
      const before = await state(p, "アカリ");
      // 一度でも滑らせたら印を付ける（消えていく間に滑り終える）
      await p.evaluate(`window.__slid = false; (function watch() {
        const el = document.querySelector('.sprite[data-who="アカリ"]');
        if (el && el.getAnimations().some((a) => a.effect.getKeyframes().some((f) => f.left !== undefined))) window.__slid = true;
        requestAnimationFrame(watch);
      })()`);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "detached", timeout: 5000 });
      await p.waitForTimeout(300);
      expect(await p.evaluate("window.__slid"), name).toBe(true);
      expect((await state(p, "アカリ")).left, name).toBeCloseTo(before.left + 100, 0);
      await p.close();
    }
  });
});
