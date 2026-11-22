import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 選択肢の置き方（ui.choice.position）を、実際のブラウザで測る。
 * - 既定は avoid-faces。顔に重ならない高さへずらす（顔の範囲は cast.json の face と、無ければ絵から推し量ったもの）。顔に重ならなければ動かさない
 * - center と書けば前の既定のとおり縦の中央で、大きく出した立ち絵の顔に重なっても動かさない。y だけを書いた作品も y のまま
 * - top は上、bottom はメッセージ枠のすぐ上
 * - 縦長で基準より大きい作品（1080×1920。層が zoom で拡大される）でも、顔を避けて舞台に収まる
 * LIMINALIA_CHOICE_SHOTS にフォルダを書くと、それぞれの画面を撮る（目で確かめるため）。
 */

/** 顔の範囲（立ち絵の絵の px。どちらの絵も 600×900）。アカリは cast.json の face にも書く。ソウは絵から推し量らせ、肌の範囲で確かめる。 */
const FACE = { アカリ: { x: 215, y: 80, width: 165, height: 160 }, ソウ: { x: 255, y: 95, width: 100, height: 78 } } as const;
const IMAGE = { width: 600, height: 900 };

/** 顔が舞台の縦の真ん中あたりに来るよう、大きく出した立ち絵の場面。 */
const scene = (who: string, chara: string) => `@bg hill_dusk.webp
@chara ${who} normal ${chara}
@window show
${who}「どうする？」
@choice
- 丘を登る -> #a
- ここで待つ -> #a
- 町へ戻る -> #a
@end
# a
終わり。
`;

const SHOTS = process.env.LIMINALIA_CHOICE_SHOTS;

type Rect = { left: number; top: number; right: number; bottom: number };

interface Measured {
  /** 舞台の座標（舞台の px）。 */
  buttons: Rect[];
  sprite: Rect | null;
  message: Rect;
  place: string | null;
  translate: string;
}

/** 舞台の座標で測る（画面の px を舞台の px に直す）。 */
const measure = (p: Page, who: string, width: number) =>
  p.evaluate(
    ({ who, width }) => {
      const s = document.querySelector(".stage")!.getBoundingClientRect();
      const k = s.width / width;
      const box = (r: DOMRect) => ({ left: (r.left - s.left) / k, top: (r.top - s.top) / k, right: (r.right - s.left) / k, bottom: (r.bottom - s.top) / k });
      const sprite = document.querySelector(`.sprite[data-who="${who}"]`);
      const choices = document.querySelector<HTMLElement>(".choices")!;
      return {
        buttons: [...document.querySelectorAll(".choices button")].map((b) => box(b.getBoundingClientRect())),
        sprite: sprite ? box(sprite.getBoundingClientRect()) : null,
        message: box(document.querySelector(".message")!.getBoundingClientRect()),
        place: choices.dataset.lmChoicePlace ?? null,
        translate: getComputedStyle(choices).translate,
      };
    },
    { who, width },
  ) as Promise<Measured>;

/** 立ち絵の箱の中の顔の範囲（舞台の座標）。 */
const faceIn = (sprite: Rect, face: { x: number; y: number; width: number; height: number }): Rect => {
  const sx = (sprite.right - sprite.left) / IMAGE.width;
  const sy = (sprite.bottom - sprite.top) / IMAGE.height;
  return { left: sprite.left + face.x * sx, top: sprite.top + face.y * sy, right: sprite.left + (face.x + face.width) * sx, bottom: sprite.top + (face.y + face.height) * sy };
};
const overlaps = (a: Rect, b: Rect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;

/** 最初のページを開き、見た目の設定を替えてから選択肢まで進める。 */
async function openChoice(browser: Browser, url: string, start: string, ui: object, viewport = { width: 1280, height: 720 }): Promise<Page> {
  const p = await browser.newPage({ viewport });
  await p.goto(`${url}?autostart=1&start=${encodeURIComponent(start)}`);
  await p.waitForSelector(".message .text .ch", { timeout: 60_000 });
  await p.evaluate("document.fonts.ready.then(() => undefined)");
  await p.evaluate((u) => (window as unknown as { __liminalia: { host: { setUi(u: unknown): void } } }).__liminalia.host.setUi(u), ui);
  // 選択肢が出るまで送る（出たあとに押すと、上に置いた選択肢を押してしまうので、出ているかを見てから押す）
  for (let i = 0; i < 20 && !(await p.$(".choices button")); i++) {
    await p.mouse.click(viewport.width / 2, viewport.height * 0.2);
    await p.waitForTimeout(400);
  }
  await p.waitForSelector(".choices button", { timeout: 30_000 });
  await p.evaluate(`document.fonts.ready.then(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { a.pause(); } } })`);
  await p.waitForTimeout(200);
  return p;
}

const shoot = async (p: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: join(SHOTS, `${name}.png`) });
};

describe.skipIf(!e2e)("選択肢の置き方（ブラウザ）", { timeout: 600_000 }, () => {
  let list: { name: string; browser: Browser }[] = [];
  let landscape: TestProject;
  let portrait: TestProject;
  beforeAll(async () => {
    list = await browsers();
    const castWithFace = (dir: string) => {
      const path = join(dir, "cast.json");
      const cast = JSON.parse(readFileSync(path, "utf8")) as { cast: Record<string, { appearances: Record<string, { face?: unknown }> }> };
      cast.cast.アカリ!.appearances.default!.face = FACE.アカリ;
      writeFileSync(path, JSON.stringify(cast, null, 2));
    };
    landscape = await startProject({
      scenario: {
        akari: scene("アカリ", "x=290 y=170 width=700 height=1050"),
        sou: scene("ソウ", "x=290 y=70 width=700 height=1050"),
        side: scene("アカリ", "at=left"),
      },
      before: castWithFace,
    });
    portrait = await startProject({
      scenario: { akari: scene("アカリ", "x=240 y=560 width=600 height=900") },
      config: { screen: { width: 1080, height: 1920 } },
      before: castWithFace,
    });
  }, 180_000);
  afterAll(async () => {
    for (const b of list) await b.browser.close();
    await landscape?.close();
    await portrait?.close();
  });

  it("既定は顔を避ける（avoid-faces）。center と書けば縦の中央のまま（大きく出した立ち絵の顔に重なる）", async () => {
    for (const { name, browser } of list) {
      const d = await openChoice(browser, landscape.url, "akari", {});
      const dm = await measure(d, "アカリ", 1280);
      await shoot(d, `${name}-default`);
      expect(dm.place, name).toBe("avoid-faces");
      for (const b of dm.buttons) expect(overlaps(b, faceIn(dm.sprite!, FACE.アカリ)), `${name} ${JSON.stringify(b)}`).toBe(false);
      await d.close();
      const p = await openChoice(browser, landscape.url, "akari", { choice: { position: "center" } });
      const m = await measure(p, "アカリ", 1280);
      await shoot(p, `${name}-center`);
      expect(m.place, name).toBeNull();
      expect(m.translate, name).toBe("none");
      const face = faceIn(m.sprite!, FACE.アカリ);
      expect(m.buttons.some((b) => overlaps(b, face)), name).toBe(true);
      await p.close();
      // y だけを書いた作品は、前の既定と同じく y のまま
      const y = await openChoice(browser, landscape.url, "akari", { choice: { y: 300 } });
      const ym = await measure(y, "アカリ", 1280);
      expect([ym.place, Math.round(Math.min(...ym.buttons.map((x) => x.top)))], name).toEqual([null, 300]);
      await y.close();
    }
  });

  it("avoid-faces: cast.json の face の範囲に重ならない高さへずらし、舞台とメッセージ枠に収める", async () => {
    for (const { name, browser } of list) {
      const p = await openChoice(browser, landscape.url, "akari", { choice: { position: "avoid-faces" } });
      const m = await measure(p, "アカリ", 1280);
      await shoot(p, `${name}-avoid-cast-face`);
      expect(m.place, name).toBe("avoid-faces");
      const face = faceIn(m.sprite!, FACE.アカリ);
      for (const b of m.buttons) {
        expect(overlaps(b, face), `${name} ${JSON.stringify(b)} と顔 ${JSON.stringify(face)}`).toBe(false);
        expect(b.top, name).toBeGreaterThanOrEqual(0);
        expect(b.bottom, name).toBeLessThanOrEqual(m.message.top);
      }
      // 押せる（ずらした位置で選べる）
      await p.locator(".choices button").nth(1).click();
      await p.waitForSelector(".choices button", { state: "detached", timeout: 10_000 });
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".choices")).translate`), name).toBe("none");
      await p.close();
    }
  });

  it("avoid-faces: face の無い立ち絵は絵から顔を推し量って避ける", async () => {
    for (const { name, browser } of list) {
      const p = await openChoice(browser, landscape.url, "sou", { choice: { position: "avoid-faces" } });
      const m = await measure(p, "ソウ", 1280);
      await shoot(p, `${name}-avoid-estimated`);
      expect(m.place, name).toBe("avoid-faces");
      const face = faceIn(m.sprite!, FACE.ソウ);
      for (const b of m.buttons) expect(overlaps(b, face), `${name} ${JSON.stringify(b)} と顔 ${JSON.stringify(face)}`).toBe(false);
      await p.close();
    }
  });

  it("avoid-faces: 顔に重ならなければ動かさない", async () => {
    for (const { name, browser } of list) {
      const p = await openChoice(browser, landscape.url, "side", { choice: { position: "avoid-faces" } });
      const m = await measure(p, "アカリ", 1280);
      expect([m.place, m.translate], name).toEqual([null, "none"]);
      await p.close();
    }
  });

  it("top は舞台の上、bottom はメッセージ枠のすぐ上。y を書いたときは y のまま", async () => {
    for (const { name, browser } of list) {
      const top = await openChoice(browser, landscape.url, "side", { choice: { position: "top" } });
      const t = await measure(top, "アカリ", 1280);
      await shoot(top, `${name}-top`);
      expect(t.place, name).toBe("top");
      expect(Math.min(...t.buttons.map((b) => b.top)), name).toBeCloseTo(24, 0);
      await top.close();
      const bottom = await openChoice(browser, landscape.url, "side", { choice: { position: "bottom" } });
      const b = await measure(bottom, "アカリ", 1280);
      await shoot(bottom, `${name}-bottom`);
      expect(b.place, name).toBe("bottom");
      expect(Math.max(...b.buttons.map((x) => x.bottom)), name).toBeCloseTo(b.message.top - 12, 0);
      await bottom.close();
      const fixed = await openChoice(browser, landscape.url, "side", { choice: { position: "bottom", y: 100 } });
      const f = await measure(fixed, "アカリ", 1280);
      expect([f.place, Math.round(Math.min(...f.buttons.map((x) => x.top)))], name).toEqual([null, 100]);
      await fixed.close();
    }
  });

  it("縦長で基準より大きい作品（1080×1920、層を拡大する）でも、顔を避けて舞台に収まる", async () => {
    for (const { name, browser } of list) {
      const p = await openChoice(browser, portrait.url, "akari", { choice: { position: "avoid-faces" } }, { width: 540, height: 960 });
      const m = await measure(p, "アカリ", 1080);
      await shoot(p, `${name}-portrait`);
      expect(m.place, name).toBe("avoid-faces");
      const face = faceIn(m.sprite!, FACE.アカリ);
      for (const b of m.buttons) {
        expect(overlaps(b, face), `${name} ${JSON.stringify(b)} と顔 ${JSON.stringify(face)}`).toBe(false);
        expect(b.left, name).toBeGreaterThanOrEqual(0);
        expect(b.right, name).toBeLessThanOrEqual(1080);
        expect(b.top, name).toBeGreaterThanOrEqual(0);
        expect(b.bottom, name).toBeLessThanOrEqual(m.message.top);
      }
      await p.close();
    }
  });
});
