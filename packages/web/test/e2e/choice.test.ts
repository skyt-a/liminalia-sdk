import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { translationKey } from "@liminalia/lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 前の選択肢・次の選択肢へ（system.perform("prev-choice" / "next-choice")）を、実際のブラウザで確かめる。
 * - 次へは未読でも選択肢まで飛ぶ
 * - 前へは確かめてから戻り、選んでいる最中ならその一つ前へ
 * - 戻れる選択肢はセーブに残り、ロードしたあとも戻れる
 */

const SCENARIO = `@window show
一つ目の前。
二つ目の前。
@choice
- 甲 -> #one
- 乙 -> #one
@end
# one
選んだ一。
@choice
- 丙 -> #two
- 丁 -> #two
@end
# two
選んだ二。
最後。
`;

const choosing = (p: Page) => p.evaluate("window.__liminalia.host.choosing") as Promise<boolean>;
const labels = (p: Page) => p.evaluate(`[...document.querySelectorAll(".choices button")].map((b) => b.textContent)`) as Promise<string[]>;
const perform = async (p: Page, action: string) => {
  await p.evaluate(`void window.__liminalia.system.perform(${JSON.stringify(action)})`);
  await p.waitForTimeout(500);
};
/** 確かめのダイアログで「はい」を押す。 */
const yes = async (p: Page) => {
  await p.click(".lm-dialog .lm-primary");
  await p.waitForTimeout(600);
};
const pick = async (p: Page, index: number) => {
  await p.locator(".choices button").nth(index).click();
  await p.waitForTimeout(500);
};
/** 選択肢が出るまで、クリックで一ページずつ読み進める。 */
const readToChoice = async (p: Page) => {
  for (let i = 0; i < 20 && !(await choosing(p)); i++) {
    await p.evaluate("window.__liminalia.host.advance()");
    await p.waitForTimeout(400);
  }
  expect(await choosing(p)).toBe(true);
};
/** バックログの各行の本文。 */
const logTexts = async (p: Page) => {
  await perform(p, "backlog");
  return (await p.evaluate(`[...document.querySelectorAll(".lm-log-entry .lm-log-text")].map((e) => e.textContent)`)) as string[];
};
interface StageAndUnlocks {
  sprites: Record<string, { variant: string; autoLayout: boolean | null; autoSlot: unknown }>;
  left: Record<string, number>;
  chapter: string | null;
  cg: unknown;
  chapters: unknown;
  sprites_seen: unknown;
  movies: unknown;
}
/** 舞台と、全セーブ共通の変数のうち、飛んでも読み進めても同じになるはずのもの。 */
const stageAndUnlocks = (p: Page) =>
  p.evaluate(`(() => {
    const L = window.__liminalia;
    const state = L.runtime().state;
    const v = L.system.systemVariables;
    return {
      sprites: Object.fromEntries(Object.entries(state.stage.sprites).map(([who, s]) => [who, { variant: s.variant, autoLayout: s.autoLayout ?? null, autoSlot: s.autoSlot ?? null }])),
      left: Object.fromEntries([...document.querySelectorAll(".sprite")].map((e) => [e.dataset.who, Math.round(parseFloat(e.style.left))])),
      chapter: state.stage.extra["lm.chapter"] ?? null,
      cg: v.cg_unlocked ?? null,
      chapters: v.chapters_unlocked ?? null,
      sprites_seen: v.sprites_seen ?? null,
      movies: v.movies_seen ?? null,
    };
  })()`) as Promise<StageAndUnlocks>;

describe.skipIf(!e2e)("前の選択肢・次の選択肢へ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    // 未読も飛ばす設定（既定の「既読のみ」では未読で止まる。下の別のテストで確かめる）
    project = await startProject({ scenario: { a: SCENARIO }, config: { ui: { defaults: { skipUnread: true } } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("次へは選択肢まで飛び、前へは戻る。戻れる選択肢はセーブに残る", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await perform(p, "next-choice");
      expect([await choosing(p), await labels(p)], name).toEqual([true, ["甲", "乙"]]);
      await pick(p, 1);
      await perform(p, "next-choice");
      expect(await labels(p), name).toEqual(["丙", "丁"]);
      await pick(p, 0);
      expect(await choosing(p), name).toBe(false);
      expect(await p.evaluate("window.__liminalia.system.saveTo(1)"), name).toBe(true);

      // 読み込み直してロードし（同じページで。新しいページは保存先が別になる）、前の選択肢へ（二つ目）→ 選んでいる最中にもう一度（一つ目）
      await p.reload();
      await p.waitForSelector(".message .text .ch");
      const q = p;
      await q.evaluate("window.__liminalia.system.loadFrom(1)");
      await q.waitForTimeout(800);
      await perform(q, "prev-choice");
      await yes(q);
      expect(await labels(q), name).toEqual(["丙", "丁"]);
      await perform(q, "prev-choice");
      await yes(q);
      expect(await labels(q), name).toEqual(["甲", "乙"]);
      // それより前は無い（知らせるだけで、ダイアログは出ない）
      await perform(q, "prev-choice");
      expect(await q.evaluate(`!!document.querySelector(".lm-dialog")`), name).toBe(false);
      await q.close();
    }
  });

  it("次へは文字送りをせずに飛び、飛ばした本文はバックログに入れ、変数を引き継ぐ", async () => {
    const jump = await startProject({
      config: { ui: { defaults: { skipUnread: true } } },
      scenario: {
        b: `@window show
はじめ。
@set temp.t = 1
@set system.s = 2
飛ばす一。
飛ばす二。
@choice
- 戊 -> #end
@end
# end
終わり。
`,
      },
    });
    try {
      for (const { name, browser } of list) {
        const p = await openPlayer(browser, jump.url, "b");
        await p.waitForTimeout(300);
        // 飛ぶ間に一度でもスキップに入ったら印を付ける
        await p.evaluate(`window.__skipped = false; (function watch() { if (window.__liminalia.host.skipping) window.__skipped = true; requestAnimationFrame(watch); })()`);
        await perform(p, "next-choice");
        expect([await choosing(p), await labels(p)], name).toEqual([true, ["戊"]]);
        expect(await p.evaluate("window.__skipped"), name).toBe(false);
        expect(await p.evaluate("[window.__liminalia.runtime().state.temp.t, window.__liminalia.system.systemVariables.s]"), name).toEqual([1, 2]);
        // 押したときのページ（はじめ。）は一度だけ
        expect(await logTexts(p), name).toEqual(["はじめ。", "飛ばす一。", "飛ばす二。"]);
        await p.close();
      }
    } finally {
      await jump.close();
    }
  });

  it("スキップが既読のみなら未読のページで止まり、readOnly なら未読があるときは飛ばない", async () => {
    const scenario = `@window show
はじめ。
二ページ目。
三ページ目。
@choice
- 己 -> #end
@end
# end
終わり。
`;
    const stop = await startProject({ scenario: { c: scenario } });
    const only = await startProject({ scenario: { c: scenario }, config: { ui: { nextChoice: { readOnly: true } } } });
    try {
      for (const { name, browser } of list) {
        // 既読のみ（既定）: 最初の未読の「二ページ目。」で止まる
        const p = await openPlayer(browser, stop.url, "c");
        await p.waitForTimeout(300);
        await perform(p, "next-choice");
        expect(await choosing(p), name).toBe(false);
        expect(await p.evaluate(`document.querySelector(".message .text").textContent`), name).toContain("二ページ目。");
        await p.close();
        // readOnly: 動かない
        const q = await openPlayer(browser, only.url, "c");
        await q.waitForTimeout(300);
        await perform(q, "next-choice");
        expect(await choosing(q), name).toBe(false);
        expect(await q.evaluate(`document.querySelector(".message .text").textContent`), name).toContain("はじめ。");
        await q.close();
      }
    } finally {
      await stop.close();
      await only.close();
    }
  });

  it("次へで飛んだ先の舞台と解放は、クリックで読み進めたときと同じ（作品の既定値の自動配置、CG、章、立ち絵とムービーの鑑賞）", async () => {
    const MOVIE = join(import.meta.dirname, "fixtures/test-movie.webm");
    const same = await startProject({
      files: { "assets/video/m.webm": MOVIE },
      config: {
        entry: "d",
        // 作品全体で自動配置にする（飛ばした所の @chara にも効かなければならない）
        commandDefaults: { chara: { "auto-layout": true } },
        autoLayout: { enter: "start" },
        extra: {
          cg: [{ id: "n", images: ["hill_night.webp"] }],
          characters: [{ who: "ソウ" }],
          movies: [{ id: "m0", file: "m0.webm" }, { id: "m", file: "m.webm" }],
          chapters: [
            { id: "c1", title: "一章", target: "d#first" },
            { id: "c2", title: "二章", target: "d#second" },
          ],
        },
        ui: { defaults: { skipUnread: true } },
      },
      scenario: {
        d: `@bg hill_dusk.webp time=0ms
@window show
# first
はじめ。
@chara アカリ time=0ms
@chara ソウ smile time=0ms
二人。
@movie m.webm skip=true
# second
@bg hill_night.webp time=0ms
三ページ目。
@choice
- 甲 -> #end
@end
# end
終わり。
`,
      },
    });
    try {
      for (const { name, browser } of list) {
        // 前にほかのムービーを見ていた（movies_seen がある）作品で確かめる
        const seenBefore = `window.__liminalia.system.systemVariables.movies_seen = { "m0.webm": true }`;
        const read = await openPlayer(browser, same.url, "d");
        await read.evaluate(seenBefore);
        await read.waitForTimeout(300);
        await readToChoice(read);
        await read.waitForTimeout(500);
        const byReading = await stageAndUnlocks(read);
        await read.close();

        const jump = await openPlayer(browser, same.url, "d");
        await jump.evaluate(seenBefore);
        await jump.waitForTimeout(300);
        await perform(jump, "next-choice");
        expect(await choosing(jump), name).toBe(true);
        await jump.waitForTimeout(500);
        const byJump = await stageAndUnlocks(jump);
        expect(byJump, name).toEqual(byReading);
        // 読み進めたときの値そのものも確かめる（両方が同じに壊れていないか）
        expect(byJump, name).toMatchObject({
          chapter: "二章",
          cg: { "hill_night.webp": true },
          chapters: { c1: true, c2: true },
          sprites_seen: { ソウ: { default: { smile: true } } },
          movies: { "m0.webm": true, "m.webm": true },
        });
        expect(Object.values(byJump.sprites).map((s) => s.autoLayout), name).toEqual([true, true]);
        // そこでセーブして読み込み直しても、同じ並び
        expect(await jump.evaluate("window.__liminalia.system.saveTo(1)"), name).toBe(true);
        await jump.reload();
        await jump.waitForSelector(".message .text .ch");
        await jump.evaluate("window.__liminalia.system.loadFrom(1)");
        await jump.waitForTimeout(1000);
        expect((await stageAndUnlocks(jump)).left, name).toEqual(byReading.left);
        await jump.close();
      }
    } finally {
      await same.close();
    }
  });

  it("次へは、遊んでいる言語で先を流す（lang() の分かれ道と訳）。押したときのページはバックログに二度入れない", async () => {
    const lang = await startProject({
      config: { entry: "e", languages: ["ja", "en"], ui: { defaults: { skipUnread: true } } },
      scenario: {
        e: `@window show
はじめ。
飛ばす。
@if lang() == "en"
英語の道。
@else
日本語の道。
@end
@choice
- 甲 -> #end
@end
# end
終わり。
`,
      },
      before: (dir) => {
        const line = (source: string, text: string) => [translationKey("e", "line", source), { source, text }];
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(
          join(dir, "lang/en.json"),
          JSON.stringify({ language: "en", lines: Object.fromEntries([line("はじめ。", "Start."), line("飛ばす。", "Skip."), line("英語の道。", "English path."), line("日本語の道。", "Japanese path."), line("終わり。", "End.")]) }),
        );
      },
    });
    try {
      for (const { name, browser } of list) {
        for (const [code, expected] of [
          ["en", ["Start.", "Skip.", "English path."]],
          ["ja", ["はじめ。", "飛ばす。", "日本語の道。"]],
        ] as const) {
          const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
          await p.goto(`${lang.url}?autostart=1&start=e&lang=${code}`);
          await p.waitForSelector(".message .text .ch", { timeout: 60_000 });
          await p.waitForTimeout(500);
          await perform(p, "next-choice");
          expect(await choosing(p), `${name} ${code}`).toBe(true);
          expect(await logTexts(p), `${name} ${code}`).toEqual(expected);
          await p.close();
        }
      }
    } finally {
      await lang.close();
    }
  });

  it("未読のページで次の未読へを押すと、次の未読のページまで進む（スキップの印だけが残らない）", async () => {
    const unread = await startProject({
      config: { entry: "f" },
      scenario: { f: "@window show\n一。\n二。\n三。\n四。\n五。\n六。\n@choice\n- 甲 -> #end\n@end\n# end\n終わり。\n" },
    });
    const message = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent`) as Promise<string>;
    const flags = (p: Page) => p.evaluate("[window.__liminalia.system.status.skip, window.__liminalia.host.skipping]") as Promise<[boolean, boolean]>;
    try {
      for (const { name, browser } of list) {
        const p = await openPlayer(browser, unread.url, "f");
        await p.waitForTimeout(300);
        // 一。から三。まで読み、一。へ巻き戻す
        for (let i = 0; i < 2; i++) {
          await p.evaluate("window.__liminalia.host.advance()");
          await p.waitForTimeout(400);
        }
        expect(await message(p), name).toContain("三。");
        await perform(p, "rollback");
        await perform(p, "rollback");
        expect(await message(p), name).toContain("一。");
        // 既読の二。三。を飛ばして、未読の四。で止まる
        await perform(p, "next-unread");
        await p.waitForTimeout(500);
        expect(await message(p), name).toContain("四。");
        expect(await flags(p), name).toEqual([false, false]);
        // 未読の四。で押すと、次の未読の五。まで進む
        await perform(p, "next-unread");
        await p.waitForTimeout(500);
        expect(await message(p), name).toContain("五。");
        expect(await flags(p), name).toEqual([false, false]);
        await p.close();
      }
    } finally {
      await unread.close();
    }
  });
});
