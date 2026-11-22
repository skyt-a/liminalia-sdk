import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 被写界深度（@dof）を、実際のブラウザで確かめる（ぼかしの値と、@filter と重なること）。 */

const BODY = resolve(import.meta.dirname, "fixtures/layer-body.png");

const cast = {
  speakers: ["ユイ", "ソウ"],
  cast: {
    ユイ: { appearances: { default: { variants: { normal: { image: "yui.png" } } } } },
    ソウ: { appearances: { default: { variants: { normal: { image: "yui.png" } } } } },
  },
};

const scenario = `@bg hill_dusk.webp
@chara ユイ normal at=auto
@window show
はじまり。
@dof sprites blur=8
立ち絵に。
@filter layer=base grayscale=100
フィルタと。
@chara ソウ normal at=auto
@dof who=ユイ blur=10 time=300ms
ユイに。
@dof none
戻した。
`;

const blurs = (p: Page) =>
  p.evaluate(`(() => {
    const f = (el) => getComputedStyle(el).filter;
    const sprite = (who) => f(document.querySelector('.sprite[data-who="' + who + '"]'));
    return { bg: f(document.querySelector(".layer.background")), sprites: f(document.querySelector(".layer.sprites")), yui: sprite("ユイ"), sou: document.querySelector('.sprite[data-who="ソウ"]') ? sprite("ソウ") : null };
  })()`) as Promise<{ bg: string; sprites: string; yui: string; sou: string | null }>;

describe.skipIf(!e2e)("被写界深度（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a" },
      files: { "assets/fgimage/yui.png": BODY },
      before: (dir) => writeFileSync(join(dir, "cast.json"), JSON.stringify(cast)),
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("ピントの外をぼかし、@filter と重ね、人物に合わせればほかの立ち絵を半分ぼかす", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      // fade=0 は直後の値（200ms の移り変わりが残っていたら、ここにはまだ none になっていない）。
      // fade を書いたときだけ、その終わりの値になるまで見る。
      const page = async (text: string, expected: Partial<Awaited<ReturnType<typeof blurs>>>, budgetMs: number) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        const start = Date.now();
        let got = await blurs(p);
        while (Date.now() - start < budgetMs && Object.entries(expected).some(([k, v]) => got[k as keyof typeof got] !== v)) {
          await p.waitForTimeout(30);
          got = await blurs(p);
        }
        return got;
      };
      const next = async () => {
        // 表示の途中のクリックは送りではなく、残りの文字を出すだけなので、出し切ってから進む。
        await p.waitForFunction(`![...document.querySelectorAll(".message .text .ch")].some((n) => !n.classList.contains("shown"))`);
        await p.mouse.click(640, 80);
      };
      expect(await page("はじまり", { bg: "none", sprites: "none", yui: "none" }, 100), name).toMatchObject({ bg: "none", sprites: "none", yui: "none" });
      await next();
      expect(await page("立ち絵に", { bg: "blur(8px)", sprites: "none", yui: "none" }, 100), name).toMatchObject({ bg: "blur(8px)", sprites: "none", yui: "none" });
      await next();
      expect((await page("フィルタと", { bg: "grayscale(1) blur(8px)" }, 100)).bg, name).toBe("grayscale(1) blur(8px)");
      await next();
      expect(await page("ユイに", { bg: "grayscale(1) blur(10px)", sprites: "none", yui: "none", sou: "blur(5px)" }, 1_500), name).toMatchObject({
        bg: "grayscale(1) blur(10px)",
        sprites: "none",
        yui: "none",
        sou: "blur(5px)",
      });
      await next();
      expect(await page("戻した", { bg: "grayscale(1)", sprites: "none", yui: "none", sou: "none" }, 100), name).toMatchObject({
        bg: "grayscale(1)",
        sprites: "none",
        yui: "none",
        sou: "none",
      });
      await p.close();
    }
  });
});
