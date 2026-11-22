import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 左右反転（@chara の flip）で、立ち絵の枠に裏返す軸（cast.json の frame の flipAxis。画像の px）があれば、その軸で絵を裏返す
 * （2026-11-19 の S7。頭の大きさを揃えると、反転しても差分ごとに顎が横へずれないよう、差分ごとに軸を書く）。
 * 軸の無い差分は今までどおり枠の中央で裏返す。漫符も同じ軸で鏡に映す。
 */

const flipped = `@bg hill_dusk.webp
@window show
@chara アカリ at=center flip=true time=0ms
@chara ソウ at=left flip=true time=0ms
@emote アカリ surprise at=head
反転。
`;

const plain = `@bg hill_dusk.webp
@window show
@chara アカリ at=center time=0ms
@chara ソウ at=left time=0ms
@emote アカリ surprise at=head
そのまま。
`;

/** アカリの normal の、裏返す軸（画像の左端からの px）。 */
const AXIS = 150;

/** 立ち絵の枠と、中の絵（直下の img）の画面の範囲、絵の実寸の幅、漫符の横の置き場所（枠に対する %）。 */
const measure = (p: Page, who: string) =>
  p.evaluate((who) => {
    const el = document.querySelector<HTMLElement>(`.sprite[data-who="${who}"]`)!;
    const img = el.querySelector<HTMLImageElement>(":scope > img")!;
    const box = el.getBoundingClientRect();
    const pic = img.getBoundingClientRect();
    const emote = el.querySelector<HTMLElement>(":scope > .lim-emote");
    return {
      box: { left: box.left, width: box.width },
      pic: { left: pic.left, width: pic.width },
      natural: img.naturalWidth,
      origin: img.style.transformOrigin,
      emote: emote ? Number.parseFloat(/calc\(([-\d.]+)%/.exec(emote.style.left)?.[1] ?? "NaN") : null,
    };
  }, who);

describe.skipIf(!e2e)("立ち絵の反転の軸（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { flipped, plain },
      config: { entry: "flipped" },
      before(dir) {
        const path = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(path, "utf8"));
        cast.cast["アカリ"].appearances.default.variants.normal.frame.flipAxis = AXIS;
        writeFileSync(path, JSON.stringify(cast));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const open = async (browser: Browser, start: string, text: string) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${project.url}?autostart=1&start=${start}`);
    await p.waitForFunction((t) => document.querySelector(".message .text")?.textContent?.includes(t), text);
    await p.waitForSelector('.sprite[data-who="アカリ"] > .lim-emote');
    await p.waitForTimeout(300);
    return p;
  };

  it("軸のある差分は軸で裏返し、軸の無い差分は前と同じく枠の中央で裏返す。反転しなければ軸は効かない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, "flipped", "反転");
      const akari = await measure(p, "アカリ");
      // 軸で裏返した絵は、枠から「2 × 軸 − 幅」だけ横にずれる
      const axis = (AXIS / akari.natural) * akari.box.width;
      expect(akari.natural, name).toBeGreaterThan(0);
      expect(akari.pic.left, name).toBeCloseTo(akari.box.left + 2 * axis - akari.box.width, 0);
      expect(akari.pic.width, name).toBeCloseTo(akari.box.width, 0);
      // 軸の無い差分は、枠と同じ所（前と同じ見え方）
      const sou = await measure(p, "ソウ");
      expect(sou.origin, name).toBe("");
      expect(sou.pic.left, name).toBeCloseTo(sou.box.left, 0);
      await p.close();

      const q = await open(browser, "plain", "そのまま");
      for (const who of ["アカリ", "ソウ"]) {
        const m = await measure(q, who);
        expect(m.origin, `${name} ${who}`).toBe("");
        expect(m.pic.left, `${name} ${who}`).toBeCloseTo(m.box.left, 0);
      }
      await q.close();
    }
  });

  it("配置の編集の見本（制作画面のゲームの設定と、位置調整の「ゲーム画面を重ねる」）は立ち絵を反転せず、重ねる枠は絵と同じ所（軸のある差分も）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // 見本は配置の知らせ（liminalia:layout-report）を親の窓へ送る。上の窓では自分に届く
      await p.addInitScript(() => {
        (window as unknown as { __reports: unknown[] }).__reports = [];
        window.addEventListener("message", (e) => {
          if ((e.data as { type?: string })?.type === "liminalia:layout-report") (window as unknown as { __reports: unknown[] }).__reports.push(e.data);
        });
      });
      const sprites = encodeURIComponent(JSON.stringify([["アカリ", "center"]]));
      await p.goto(`${project.url}?ui-preview=page&layout=1&sprites=${sprites}`);
      await p.waitForFunction(() => (window as unknown as { __reports: unknown[] }).__reports.length > 0);
      const got = await p.evaluate(() => {
        const reports = (window as unknown as { __reports: { items: { id: string; rect: { x: number; width: number } }[] }[] }).__reports;
        const item = reports.at(-1)!.items.find((i) => i.id === "sprite:アカリ")!;
        const img = document.querySelector<HTMLImageElement>('.sprite[data-who="アカリ"] > img')!;
        const pic = img.getBoundingClientRect();
        return { transform: img.style.transform, rect: item.rect, pic: { x: pic.left, width: pic.width } };
      });
      expect(got.transform, name).toBe("");
      expect(got.rect.x, name).toBeCloseTo(got.pic.x, 0);
      expect(got.rect.width, name).toBeCloseTo(got.pic.width, 0);
      await p.close();
    }
  });

  it("反転した立ち絵の漫符は、絵を裏返す軸で鏡に映した所に出る", async () => {
    for (const { name, browser } of list) {
      const q = await open(browser, "plain", "そのまま");
      const straight = await measure(q, "アカリ");
      await q.close();
      const p = await open(browser, "flipped", "反転");
      const turned = await measure(p, "アカリ");
      await p.close();
      // 枠に対する割合: 反転しないとき x、軸 a で裏返すと 2a − x
      const a = AXIS / turned.natural;
      expect(straight.emote, name).not.toBeNull();
      expect(turned.emote! + straight.emote!, name).toBeCloseTo(200 * a, 1);
    }
  });
});
