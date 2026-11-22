import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 遊ぶ側の演出の命令（2026-11 に足したもの）を、実際のブラウザ（Chromium と WebKit）で確かめる。
 * - 単色の背景（@bg color=、@scene-change bg-color=）は色の板を出し、セーブとロード、巻き戻し、スキップで同じ色に戻る
 * - 文字の出し方（ui.text.reveal、revealTime）は公開の CSS 変数で .ch に効き、TextTheme.char の動きはクリックで終わりの姿になる
 */

const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 15_000 });
const advance = (p: Page) => p.evaluate("window.__liminalia.host.advance()");
const perform = async (p: Page, action: string, wait = 500) => {
  await p.evaluate(`void window.__liminalia.system.perform(${JSON.stringify(action)})`);
  await p.waitForTimeout(wait);
};
const reload = async (p: Page) => {
  await p.evaluate("window.__liminalia.system.loadSave(window.__liminalia.system.runtime.save())");
  await p.waitForTimeout(500);
};
const bgColor = (p: Page) => p.evaluate(`(() => { const el = document.querySelector(".layer.background .lm-bg-color"); return el ? getComputedStyle(el).backgroundColor : null; })()`) as Promise<string | null>;
const bgImages = (p: Page) => p.evaluate(`document.querySelectorAll(".layer.background img[data-bg]").length`) as Promise<number>;

const BG = `@bg hill_dusk.webp
@window show
はじまり。
@bg color=#123456 time=200ms
単色の背景。
@bg hill_night.webp
絵の背景。
@scene-change bg-color=#ffffff time=100ms
白い背景。
`;

const FX = `@bg hill_dusk.webp
@window show
はじまり。
@filter grayscale=100 time=800ms wait=true
白黒。
@filter-off time=200ms
外した。
@filter sepia=100 blur=3 mask="radial 640 360 400 300 40" time=300ms
範囲。
@effect vignette strength=80 fade=1500ms
効果。
@effect-off vignette fade=600ms
効果を外した。
@effect mosaic strength=20 mask="radial 640 360 300 300"
モザイク。
`;

const FIXTURES = resolve(import.meta.dirname, "fixtures");

const CUTIN = `@bg hill_dusk.webp
@window show
はじまり。
@cutin key.png stay=true name=key max-width=300 max-height=300 padding=10 from=left in=300ms hide-window=true
残した。
次のページ。
@cutin-hide key time=300ms
引いた。
`;

const HUD = `@window show
@set game.day = 1
@set game.memo = 0
@hud-text day text="{= game.day} 日目" x=40 y=24 size=28
@hud-button memo label=メモ x=1100 y=20 call=#memo show-if=(game.day >= 2)
一日目。
@set game.day = 2
二日目。
三ページ目。
@choice
- 進む -> #go
- 残る -> #go
@end

# go
@hud-button-off memo
@hud-text-off
外した。
@stop

# memo
メモを開いた。
@set game.memo = game.memo + 1
@return
`;

const CHAPTER = `@bg hill_dusk.webp
@window show
はじまり。
@chapter-card time=900ms fade=200ms
扉のあと。
@chapter-end time=900ms fade=200ms
章末のあと。
@mask-off time=100ms
明けた。
`;

const MANGA = `@bg hill_dusk.webp
@chara アカリ normal at=center
@window show
はじまり。
@emote アカリ sweat
汗。
@chara アカリ smile
表情を替えた。
@speedlines focus time=600ms wait=true
集中線のあと。
@burst text=ドン！ time=300ms wait=true
ギザギザのあと。
@flash white time=60ms hitstop=300ms zoom=1.05
ヒットストップのあと。
@camera zoom=1.3 x=60 yoyo=true time=600ms
行って戻った。
@chara-hide アカリ
消した。
@chara アカリ normal
出し直した。
`;

const LOOK = `@window show
アカリ「台詞の文字。」
地の文。
`;

const REVEAL = `@window show
一ページ目の文字。
二ページ目の……文字。
`;

const CHAR_PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
window.__chars = [];
export default defineWebPlugin({
  name: "t",
  extensions: {
    text: {
      char(el, info) {
        window.__chars.push([el.textContent, info.index, info.delay, info.perChar]);
        if (el.textContent === "…") el.animate([{ opacity: 0.2 }, { opacity: 0.9 }], { duration: 5000, delay: info.delay, fill: "forwards" });
      },
    },
  },
});
`;

describe.skipIf(!e2e)("遊ぶ側の演出の命令（ブラウザ）", { timeout: 300_000 }, () => {
  let bg: TestProject;
  let reveal: TestProject;
  let fx: TestProject;
  let cutin: TestProject;
  let hud: TestProject;
  let chapter: TestProject;
  let manga: TestProject;
  let look: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    bg = await startProject({ scenario: { a: BG }, config: { entry: "a" } });
    fx = await startProject({ scenario: { a: FX }, config: { entry: "a" } });
    chapter = await startProject({
      scenario: { a: CHAPTER },
      config: { entry: "a", chapters: [{ id: "ep1", number: "第一章", title: "雨の駅", subtitle: "RAINY STATION", files: ["a"] }], ui: { system: { preset: "washi", titleBg: "#f3ecdd", fg: "#2b2620", accent: "#a8402c" } } },
    });
    manga = await startProject({ scenario: { a: MANGA }, config: { entry: "a" } });
    look = await startProject({
      scenario: { a: LOOK },
      config: { entry: "a" },
      files: { "assets/image/ui/akari_name.png": `${FIXTURES}/stripes.png`, "assets/image/ui/akari_window.png": `${FIXTURES}/layer-top.png` },
      before: (dir) => {
        const file = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(file, "utf8")) as { cast: Record<string, Record<string, unknown>> };
        Object.assign(cast.cast.アカリ!, { text: { color: "#ff0000", italic: true }, nameImage: "ui/akari_name.png", windowImage: "ui/akari_window.png" });
        writeFileSync(file, JSON.stringify(cast));
      },
    });
    hud = await startProject({ scenario: { a: HUD }, config: { entry: "a" } });
    cutin = await startProject({ scenario: { a: CUTIN }, config: { entry: "a" }, files: { "assets/image/key.png": `${FIXTURES}/stripes.png` } });
    reveal = await startProject({ scenario: { a: REVEAL }, config: { entry: "a", ui: { text: { reveal: "rise", revealTime: 400 } } }, plugin: CHAR_PLUGIN });
  }, 180_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await bg?.close();
    await reveal?.close();
    await fx?.close();
    await cutin?.close();
    await hud?.close();
    await chapter?.close();
    await manga?.close();
    await look?.close();
  }, 60_000);

  it("単色の背景は色の板で出し、セーブとロード、巻き戻し、スキップで同じ色に戻る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${bg.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await advance(p);
      await waitText(p, "単色の背景");
      expect([await bgColor(p), await bgImages(p)], name).toEqual(["rgb(18, 52, 86)", 0]);
      expect(await p.evaluate("[window.__liminalia.system.runtime.state.stage.background, window.__liminalia.system.runtime.state.stage.backgroundColor]"), name).toEqual([null, "#123456"]);
      // ロードで色のまま組み立て直す
      await reload(p);
      expect([await bgColor(p), await bgImages(p)], name).toEqual(["rgb(18, 52, 86)", 0]);
      await advance(p);
      await waitText(p, "絵の背景");
      await p.waitForTimeout(300);
      expect([await bgColor(p), await bgImages(p)], name).toEqual([null, 1]);
      // 巻き戻すと単色の背景に戻り、進め直すと絵に戻る
      await perform(p, "rollback");
      expect([await bgColor(p), await bgImages(p)], name).toEqual(["rgb(18, 52, 86)", 0]);
      await perform(p, "rollforward");
      expect([await bgColor(p), await bgImages(p)], name).toEqual([null, 1]);
      await advance(p);
      await waitText(p, "白い背景");
      await p.waitForTimeout(300);
      expect([await bgColor(p), await bgImages(p)], name).toEqual(["rgb(255, 255, 255)", 0]);
      await p.close();
    }
  });

  it("スキップで通っても、単色の背景は最後の色のまま", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${bg.url}?autostart=1&start=a&skip=4`);
      await waitText(p, "白い背景");
      await p.waitForTimeout(300);
      expect([await bgColor(p), await bgImages(p)], name).toEqual(["rgb(255, 255, 255)", 0]);
      await p.close();
    }
  });

  it("backdrop-filter を描けないブラウザでは、範囲を決めた @filter を出さずに知らせる（範囲の無い @filter は出す）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // Firefox の 97〜102 のように、backdrop-filter が無いことにする
      await p.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((a: string, b?: string) => (/backdrop-filter/.test(a) ? false : b === undefined ? supports(a) : supports(a, b))) as typeof CSS.supports;
      });
      const warnings: string[] = [];
      p.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
      await p.goto(`${fx.url}?autostart=1&start=a&skip=2`);
      await waitText(p, "白黒");
      expect(await p.evaluate(`document.querySelector(".layer.background").style.filter`), name).toContain("grayscale(100%)");
      await advance(p);
      await waitText(p, "外した");
      await advance(p);
      await waitText(p, "範囲");
      await p.waitForTimeout(400);
      expect(await p.evaluate(`document.querySelectorAll(".lim-filter-mask").length`), name).toBe(0);
      expect(warnings.filter((w) => w.includes("backdrop-filter")).length, name).toBe(1);
      await p.close();
    }
  });

  it("@filter と @effect は fade= で出し入れし、mask= の範囲にかけ、ロードと巻き戻しとスキップで同じ姿に戻る", async () => {
    const maskEl = (p: Page) => p.evaluate(`(() => { const el = document.querySelector(".lim-filter-mask"); return el ? [el.dataset.filterLayer, /sepia.*blur\\(3px\\)/.test(el.style.backdropFilter || el.style.webkitBackdropFilter), (el.style.maskImage || el.style.webkitMaskImage).startsWith("radial-gradient")] : null; })()`);
    const vignette = (p: Page) => p.evaluate(`(() => { const el = document.querySelector(".lim-effect-vignette"); return el ? Number(el.style.opacity) : null; })()`) as Promise<number | null>;
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${fx.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await advance(p);
      // 移している途中（wait=true なので次の本文はまだ出ない）
      await p.waitForTimeout(250);
      expect(await p.evaluate(`document.querySelector(".layer.background").getAnimations().length`), name).toBeGreaterThan(0);
      expect(await p.evaluate(`document.querySelector(".message .text").textContent`), name).not.toContain("白黒");
      await waitText(p, "白黒");
      expect(await p.evaluate(`document.querySelector(".layer.background").style.filter`), name).toContain("grayscale(100%)");
      await advance(p);
      await waitText(p, "外した");
      await p.waitForTimeout(300);
      expect(await p.evaluate(`document.querySelector(".layer.background").style.filter`), name).toBe("");
      await advance(p);
      await waitText(p, "範囲");
      await p.waitForTimeout(400);
      expect(await maskEl(p), name).toEqual(["fg2", true, true]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/stage-extras-mask-${name}.png` }).catch(() => undefined);
      // ロードしても同じ範囲のフィルタ
      await reload(p);
      expect(await maskEl(p), name).toEqual(["fg2", true, true]);
      await advance(p);
      await waitText(p, "効果");
      // 強さを上げている途中
      await p.waitForTimeout(300);
      const mid = await vignette(p);
      expect(mid !== null && mid > 0 && mid < 1, `${name} ${mid}`).toBe(true);
      // ロードはすぐ出し終えた姿
      await reload(p);
      expect(await vignette(p), name).toBe(1);
      await advance(p);
      await waitText(p, "効果を外した");
      await p.waitForTimeout(150);
      expect(await vignette(p), name).not.toBeNull();
      await p.waitForTimeout(800);
      expect(await vignette(p), name).toBeNull();
      // WebGL の効果は、範囲の中にシェーダーの絵、外に元の絵を見せる（元の絵を隠さない）
      const gl = `(() => { const c = document.querySelector(".lim-gl-effect"); const cam = document.querySelector(".camera"); return c ? [!!(c.style.maskImage || c.style.webkitMaskImage), !!(cam.style.maskImage || cam.style.webkitMaskImage), cam.style.visibility] : null; })()`;
      await advance(p);
      await waitText(p, "モザイク");
      await p.waitForTimeout(300);
      const shown = await p.evaluate(gl);
      // WebGL が使えない環境では何もかけない
      if (shown !== null) {
        expect(shown, name).toEqual([true, true, ""]);
        await reload(p);
        expect(await p.evaluate(gl), name).toEqual([true, true, ""]);
        await p.evaluate(`window.__liminalia.system.loadSave({ ...window.__liminalia.system.runtime.save(), stage: { ...window.__liminalia.system.runtime.save().stage, extra: {} } })`);
        await p.waitForTimeout(400);
        expect(await p.evaluate(`[document.querySelectorAll(".lim-gl-effect").length, !!(document.querySelector(".camera").style.maskImage || document.querySelector(".camera").style.webkitMaskImage)]`), name).toEqual([0, false]);
      }
      await p.close();

      // ロードせずに進めてから巻き戻すと、効果がかかった姿、範囲のフィルタだけの姿、フィルタの無い姿の順に戻る
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${fx.url}?autostart=1&start=a`);
      for (const [now, next] of [["はじまり", "白黒"], ["白黒", "外した"], ["外した", "範囲"], ["範囲", "効果"], ["効果", "効果を外した"]]) {
        await waitText(q, now!);
        await advance(q);
        await waitText(q, next!);
      }
      await q.waitForTimeout(800);
      await perform(q, "rollback");
      expect(await vignette(q), name).toBe(1);
      await perform(q, "rollback");
      expect([await vignette(q), await maskEl(q)], name).toEqual([null, ["fg2", true, true]]);
      await perform(q, "rollback");
      expect(await maskEl(q), name).toBeNull();
      await q.close();
    }
  });

  it("スキップで通っても、フィルタと効果は最後の姿", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${fx.url}?autostart=1&start=a&skip=6`);
      await waitText(p, "効果を外した");
      await p.waitForTimeout(200);
      expect(await p.evaluate(`[document.querySelectorAll(".lim-filter-mask").length, document.querySelectorAll(".lim-effect-vignette").length]`), name).toEqual([1, 0]);
      await p.close();
    }
  });

  it("@cutin stay=true は @cutin-hide まで残り、上限の箱に収まり、セーブとロード、巻き戻し、スキップで同じ姿に戻る", async () => {
    const kept = (p: Page) =>
      p.evaluate(`(() => { const f = document.querySelector(".lim-cutin-frame--stay[data-cutin=key]"); if (!f) return null; const img = f.querySelector("img"); return [Math.round(f.getBoundingClientRect().width), img.getBoundingClientRect().width <= 264.5]; })()`) as Promise<[number, boolean] | null>;
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${cutin.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await advance(p);
      // 差し込むあいだはメッセージ枠を隠す
      await p.waitForSelector(".lim-cutin-frame--stay");
      expect(await p.evaluate(`document.querySelector(".message").classList.contains("lm-window-held")`), name).toBe(true);
      await waitText(p, "残した");
      const first = await kept(p);
      expect(first?.[0] ?? 0, name).toBeLessThanOrEqual(301);
      expect(first?.[1], name).toBe(true);
      expect(await p.evaluate(`document.querySelector(".message").classList.contains("lm-window-held")`), name).toBe(false);
      await advance(p);
      await waitText(p, "次のページ");
      expect(await kept(p), name).toEqual(first);
      await reload(p);
      expect(await kept(p), name).toEqual(first);
      await advance(p);
      await waitText(p, "引いた");
      await p.waitForTimeout(400);
      expect(await kept(p), name).toBeNull();
      await perform(p, "rollback");
      expect(await kept(p), name).toEqual(first);
      await p.close();
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${cutin.url}?autostart=1&start=a&skip=3`);
      await waitText(q, "次のページ");
      expect(await kept(q), name).toEqual(first);
      await q.close();
    }
  });

  it("常駐の表示は変数が変わると描き直し、ボタンは場面を呼んでページか選択肢へ戻り、セーブとロード、巻き戻し、スキップで同じに出る", async () => {
    const look = (p: Page) =>
      p.evaluate(`(() => { const t = document.querySelector(".lim-hud-text[data-hud=day]"); const b = document.querySelector(".lim-hud-button[data-hud=memo]"); return [t ? t.textContent : null, b ? !b.hidden : null]; })()`) as Promise<[string | null, boolean | null]>;
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${hud.url}?autostart=1&start=a`);
      await waitText(p, "一日目");
      expect(await look(p), name).toEqual(["1 日目", false]);
      await advance(p);
      await waitText(p, "二日目");
      expect(await look(p), name).toEqual(["2 日目", true]);
      // ボタンを押すと場面を呼び、@return でページへ戻って出し直す。本文は送らない
      await p.click(".lim-hud-button[data-hud=memo]");
      await waitText(p, "メモを開いた");
      await advance(p);
      await waitText(p, "二日目");
      expect(await p.evaluate("window.__liminalia.system.runtime.state.game.memo"), name).toBe(1);
      expect(await look(p), name).toEqual(["2 日目", true]);
      await advance(p);
      await waitText(p, "三ページ目");
      await reload(p);
      expect(await look(p), name).toEqual(["2 日目", true]);
      await perform(p, "rollback");
      expect(await look(p), name).toEqual(["2 日目", true]);
      await perform(p, "rollforward");
      // 選択肢を出しているあいだも押せ、戻ったら選択肢を出し直す（前の選択肢へは、この選択肢の前へ戻る）
      await advance(p);
      await p.waitForSelector(".choices button");
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/stage-extras-hud-choice-${name}.png` }).catch(() => undefined);
      await p.click(".lim-hud-button[data-hud=memo]");
      await waitText(p, "メモを開いた");
      expect(await p.locator(".choices button").count(), name).toBe(0);
      await advance(p);
      await p.waitForFunction(`document.querySelectorAll(".choices button").length === 2`, null, { timeout: 15_000 });
      expect(await p.evaluate("[window.__liminalia.system.runtime.state.game.memo, window.__liminalia.system.status.choosing]"), name).toEqual([2, true]);
      // 履歴は選択肢の前のページに、呼んだ場面のページが続く（ロードし直した loadSave の前の分は無い）
      expect(await p.evaluate("window.__liminalia.system.backlog.map((e) => e.parts.map((x) => x.text ?? '').join('')).slice(-2)"), name).toEqual(["三ページ目。", "メモを開いた。"]);
      await p.locator(".choices button").first().click();
      await waitText(p, "外した");
      expect(await look(p), name).toEqual([null, null]);
      await p.close();
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${hud.url}?autostart=1&start=a&skip=3`);
      await waitText(q, "三ページ目");
      expect(await look(q), name).toEqual(["2 日目", true]);
      await q.close();
    }
  });

  it("章の扉と章末は今の章から題を出し、テーマの色を使い、leave=mask の暗転をセーブとロード、巻き戻し、スキップで残す", async () => {
    const card = (p: Page) => p.evaluate(`(() => { const c = document.querySelector(".lim-chapter"); return c ? [c.className, c.textContent, getComputedStyle(c).color] : null; })()`) as Promise<[string, string, string] | null>;
    const covered = (p: Page) => p.evaluate(`[window.__liminalia.system.runtime.state.stage.mask, getComputedStyle(document.querySelector(".layer.mask")).opacity]`);
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${chapter.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await advance(p);
      await p.waitForSelector(".lim-chapter--card");
      await p.waitForTimeout(500);
      expect(await card(p), name).toEqual(["lim-chapter lim-chapter--card", "第一章雨の駅RAINY STATION", "rgb(43, 38, 32)"]);
      expect(await p.evaluate(`document.querySelector(".message").classList.contains("lm-window-held")`), name).toBe(true);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/stage-extras-chapter-${name}.png` }).catch(() => undefined);
      await waitText(p, "扉のあと");
      expect([await card(p), await covered(p)], name).toEqual([null, [null, "0"]]);
      await advance(p);
      await p.waitForSelector(".lim-chapter--end");
      expect((await card(p))?.[1], name).toBe("第一章雨の駅完");
      await waitText(p, "章末のあと");
      expect([await card(p), await covered(p)], name).toEqual([null, ["#000000", "1"]]);
      // ロードしても覆ったまま
      await reload(p);
      expect(await covered(p), name).toEqual(["#000000", "1"]);
      await advance(p);
      await waitText(p, "明けた");
      await p.waitForTimeout(200);
      expect(await covered(p), name).toEqual([null, "0"]);
      await perform(p, "rollback");
      expect(await covered(p), name).toEqual(["#000000", "1"]);
      await p.close();
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${chapter.url}?autostart=1&start=a&skip=3`);
      await waitText(q, "章末のあと");
      expect([await card(q), await covered(q)], name).toEqual([null, ["#000000", "1"]]);
      await q.close();
    }
  });

  it("漫符は立ち絵の頭に付いて表情を替えても残り、立ち絵と一緒に消える。漫画的な演出は出して片付け、行って戻るカメラは元の姿に戻る", async () => {
    const emote = (p: Page) =>
      p.evaluate(`(() => { const e = document.querySelector('.sprite[data-who="アカリ"] > .lim-emote'); if (!e) return null; const s = e.parentElement.getBoundingClientRect(); const r = e.getBoundingClientRect(); return [e.querySelector(".lim-emote-glyph").className, r.top < s.top + s.height * 0.4, r.left > s.left]; })()`) as Promise<[string, boolean, boolean] | null>;
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${manga.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await advance(p);
      await waitText(p, "汗");
      await p.waitForSelector(".lim-emote");
      const first = await emote(p);
      expect(first, name).toEqual(["lim-emote-glyph lim-emote--sweat", true, true]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/stage-extras-emote-${name}.png` }).catch(() => undefined);
      await advance(p);
      await waitText(p, "表情を替えた");
      await p.waitForTimeout(300);
      expect(await emote(p), name).toEqual(first);
      await reload(p);
      await p.waitForTimeout(300);
      expect(await emote(p), name).toEqual(first);
      await advance(p);
      await p.waitForSelector(".lim-speedlines");
      await waitText(p, "集中線のあと");
      expect(await p.evaluate(`document.querySelectorAll(".lim-speedlines").length`), name).toBe(0);
      await advance(p);
      await p.waitForSelector(".lim-burst");
      expect(await p.evaluate(`document.querySelector(".lim-burst-text").textContent`), name).toBe("ドン！");
      await waitText(p, "ギザギザのあと");
      expect(await p.evaluate(`document.querySelectorAll(".lim-burst").length`), name).toBe(0);
      await advance(p);
      // ヒットストップのあいだは寄せている
      await p.waitForTimeout(150);
      expect(await p.evaluate(`document.querySelector(".lim-flash") !== null && getComputedStyle(document.querySelector(".stage .layer")).scale`), name).toBe("1.05");
      await waitText(p, "ヒットストップのあと");
      await p.waitForTimeout(300);
      expect(await p.evaluate(`[document.querySelectorAll(".lim-flash").length, getComputedStyle(document.querySelector(".stage .layer")).scale]`), name).toEqual([0, "none"]);
      const home = await p.evaluate(`getComputedStyle(document.querySelector(".camera")).transform`);
      await advance(p);
      await p.waitForTimeout(250);
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".camera")).transform`), name).not.toBe(home);
      await waitText(p, "行って戻った");
      await p.waitForTimeout(100);
      expect(await p.evaluate(`[getComputedStyle(document.querySelector(".camera")).transform, JSON.stringify(window.__liminalia.system.runtime.state.stage.camera)]`), name).toEqual([home, JSON.stringify({ zoom: 1, x: 0, y: 0, rotate: 0 })]);
      await advance(p);
      await waitText(p, "消した");
      await advance(p);
      await waitText(p, "出し直した");
      await p.waitForTimeout(400);
      expect(await emote(p), name).toBeNull();
      // 巻き戻すと、漫符の付いた立ち絵に戻る
      await perform(p, "rollback");
      await perform(p, "rollback");
      await perform(p, "rollback");
      await p.waitForTimeout(300);
      expect(await emote(p), name).toEqual(first);
      await p.close();
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${manga.url}?autostart=1&start=a&skip=3`);
      await waitText(q, "表情を替えた");
      await q.waitForTimeout(400);
      expect(await emote(q), name).toEqual(first);
      await q.close();
    }
  });

  it("人物ごとの台詞の文字の見た目と、名前の欄と枠の画像は、その人物の台詞のときだけ効き、履歴の本文にも出る", async () => {
    const state = (p: Page) =>
      p.evaluate(`(() => {
        const ch = document.querySelector(".message .text .ch");
        const st = getComputedStyle(ch);
        return [st.color, st.fontStyle, document.querySelector(".message .name").style.getPropertyValue("--name-image").includes("akari_name"), document.querySelector(".message").style.getPropertyValue("--message-image").includes("akari_window")];
      })()`);
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${look.url}?autostart=1&start=a`);
      await waitText(p, "台詞の文字");
      expect(await state(p), name).toEqual(["rgb(255, 0, 0)", "italic", true, true]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/stage-extras-look-${name}.png` }).catch(() => undefined);
      await advance(p);
      await waitText(p, "地の文");
      const after = (await state(p)) as [string, string, boolean, boolean];
      expect([after[0] === "rgb(255, 0, 0)", after[1], after[2], after[3]], name).toEqual([false, "normal", false, false]);
      // 履歴の本文も、その人物の台詞だけ同じ見た目
      await perform(p, "backlog");
      await p.waitForSelector(".lm-backlog .lm-log-entry");
      const logs = (await p.evaluate(`[...document.querySelectorAll(".lm-backlog .lm-log-text")].map((t) => { const st = getComputedStyle(t.querySelector("span") ?? t); return [t.textContent, st.color === "rgb(255, 0, 0)", st.fontStyle]; })`)) as [string, boolean, string][];
      expect(logs, name).toEqual([
        ["「台詞の文字。」", true, "italic"],
        ["地の文。", false, "normal"],
      ]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/stage-extras-look-backlog-${name}.png` }).catch(() => undefined);
      await p.close();
    }
  });

  it("文字の出し方は公開の CSS 変数で .ch に効き、TextTheme.char の動きはクリックで終わりの姿になる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${reveal.url}?autostart=1&start=a`);
      await waitText(p, "一ページ目");
      const look = await p.evaluate(`(() => {
        // 出し切った文字は動きが外れているので、出す途中の一文字を置いて見る
        const ch = Object.assign(document.createElement("span"), { className: "ch", textContent: "字" });
        document.querySelector(".message .text").append(ch);
        const st = getComputedStyle(ch);
        const out = [getComputedStyle(document.querySelector(".stage")).getPropertyValue("--lm-reveal-animation").trim(), st.animationName, st.animationDuration];
        ch.remove();
        return out;
      })()`);
      expect(look, name).toEqual(["lim-reveal-rise", "lim-reveal-rise", "0.4s"]);
      const chars = (await p.evaluate("window.__chars")) as [string, number, number, number][];
      expect(chars.slice(0, 3).map((c) => [c[0], c[1]]), name).toEqual([["一", 0], ["ペ", 1], ["ー", 2]]);
      expect(chars[1]![2], name).toBe(chars[1]![3]);
      await advance(p);
      // 二ページ目を出し始めたらすぐクリックで出し切る（三点リーダーに付けた動きも終わりの姿になる）
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("二"));
      await advance(p);
      await waitText(p, "文字");
      const dots = await p.evaluate(`[...document.querySelectorAll(".message .text .ch")].filter((e) => e.textContent === "…").map((e) => [e.classList.contains("shown"), e.getAnimations().map((a) => a.playState).join(",")])`);
      expect(dots, name).toEqual([
        [true, "finished"],
        [true, "finished"],
      ]);
      await p.close();
    }
  });
});
