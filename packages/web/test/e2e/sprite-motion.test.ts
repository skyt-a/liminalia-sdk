import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 立ち絵の出方と消え方（@chara の enter、@chara-hide の exit）、立ち位置を滑らせる指定（slide）、重なり順（z）、
 * 一人ずつ出す指定（solo）を実際のブラウザで確かめる。
 */

const scenario = `@bg hill_dusk.webp
@window show
@chara アカリ at=center enter=left distance=200 time=800ms
はじまり。
@chara ソウ solo=true time=300ms z=3
入れ替わり。
@chara アカリ at=left z=1
重なり。
@chara アカリ at=right slide=true time=800ms
滑る。
@chara-hide アカリ exit=bottom distance=200 time=800ms
消える。
`;

const concurrent = `@window show
@chara アカリ at=center time=0ms
動く前。
@chara アカリ at=left time=900ms slide=false wait=false
@chara ソウ at=right time=900ms
二人。
`;

const original = `@window show
@chara アカリ at=center time=0ms
動く前。
@chara-hide-all time=300ms
@chara アカリ at=left time=900ms
@chara ソウ at=right time=900ms
二人。
`;
const cleared = original.replace("@chara-hide-all time=300ms\n@chara アカリ at=left time=900ms", "@chara アカリ at=left clear=300ms time=900ms");

const sprite = (p: Page, who: string) =>
  p.evaluate(`(() => {
    const el = document.querySelector('.sprite[data-who="${who}"]');
    if (!el) return null;
    const s = getComputedStyle(el);
    return { translate: s.translate, left: parseFloat(el.style.left), z: el.style.zIndex, opacity: Number(s.opacity) };
  })()`) as Promise<{ translate: string; left: number; z: string; opacity: number } | null>;

describe.skipIf(!e2e)("立ち絵の出方と消え方、滑らせる指定、重なり順、一人ずつ出す指定（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: scenario, concurrent, original, cleared }, config: { entry: "a" } });
  });

  it("全消しのあとは左右それぞれの位置から同時にフェードインする", async () => {
    for (const { name, browser } of list) for (const start of ["original", "cleared"]) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=${start}`);
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("動く前")');
      await p.waitForTimeout(500);
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      const during = await p.evaluate(() => ["アカリ", "ソウ"].map((who) => {
        const el = [...document.querySelectorAll<HTMLElement>(`.sprite[data-who="${who}"]`)].at(-1)!;
        return { left: parseFloat(getComputedStyle(el).left), moving: el.getAnimations().some((a) => (a.effect as KeyframeEffect).getKeyframes().some((f) => f.left !== undefined)) };
      }));
      expect(during[0]!.left, name).toBeLessThan(during[1]!.left);
      expect(during.map((s) => s.moving), name).toEqual([false, false]);
      await p.waitForTimeout(1000);
      const after = await Promise.all([sprite(p, "アカリ"), sprite(p, "ソウ")]);
      expect(during[0]!.left, name).toBeCloseTo(after[0]!.left, 0);
      expect(during[1]!.left, name).toBeCloseTo(after[1]!.left, 0);
      await p.close();
    }
  });

  it("切り替え中に別の人物を出しても slide=false の人物を滑らせない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=concurrent`);
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("動く前")');
      await p.waitForTimeout(500);
      await p.mouse.click(640, 80);
      await p.waitForSelector('.sprite[data-who="ソウ"]', { state: "attached" });
      const moving = await p.evaluate(() => {
        const el = document.querySelector('.sprite[data-who="アカリ"]')!;
        return el.getAnimations().some((animation) =>
          (animation.effect as KeyframeEffect).getKeyframes().some((frame) => frame.left !== undefined),
        );
      });
      expect(moving, name).toBe(false);
      await p.close();
    }
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("横から滑って出て、ほかの人物を消して入れ替わり、重なり順を保ち、滑って動き、下へ消える", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const text = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`);
      // 出ている途中は左にずれていて、出し終えるとずれは無い
      await p.waitForSelector('.sprite[data-who="アカリ"]');
      await p.waitForTimeout(150);
      const entering = await sprite(p, "アカリ");
      expect(parseFloat(entering!.translate), name).toBeLessThan(-20);
      await text("はじまり");
      await p.waitForTimeout(900);
      expect((await sprite(p, "アカリ"))!.translate, name).toMatch(/^(none|0px( 0px)?)$/);
      // solo: アカリは消え、ソウは手前の重なり順
      await p.mouse.click(640, 80);
      await text("入れ替わり");
      await p.waitForTimeout(400);
      expect(await sprite(p, "アカリ"), name).toBeNull();
      expect((await sprite(p, "ソウ"))!.z, name).toBe("3");
      await p.mouse.click(640, 80);
      await text("重なり");
      await p.waitForTimeout(300);
      const left = (await sprite(p, "アカリ"))!;
      expect(left.z, name).toBe("1");
      // slide: 消えずに、左から右へ滑っていく
      await p.waitForTimeout(300);
      await p.mouse.click(640, 80);
      await p.waitForTimeout(300);
      const moving = (await sprite(p, "アカリ"))!;
      expect(moving.opacity, name).toBe(1);
      await text("滑る");
      await p.waitForTimeout(900);
      const right = (await sprite(p, "アカリ"))!;
      expect(right.left, name).toBeGreaterThan(left.left);
      // exit=bottom: 消えていく途中は下にずれている
      await p.mouse.click(640, 80);
      await p.waitForTimeout(300);
      const leaving = await sprite(p, "アカリ");
      expect(parseFloat(leaving!.translate.split(" ")[1] ?? "0"), name).toBeGreaterThan(20);
      await text("消える");
      await p.waitForTimeout(700);
      expect(await sprite(p, "アカリ"), name).toBeNull();
      await p.close();
    }
  });
});
