import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 揺れる立ち絵（cast.json の model.type "sway"。WebGL で描くキャンバス）も、@chara の flip=true で普通の立ち絵と同じく裏返し、
 * 差分の枠に裏返す軸（frame の flipAxis）があれば、その軸で裏返す（2026-11-19 の rest-q。前は img だけを裏返し、キャンバスはそのままだった）。
 * プラグインの立ち絵（Live2D と Spine）は model-plugins.test.ts で同じことを確かめる。
 */

const flipped = `@bg hill_dusk.webp
@window show
@chara アカリ smile at=center flip=true time=0ms
@chara ソウ at=left flip=true time=0ms
反転。
`;

const plain = `@bg hill_dusk.webp
@window show
@chara アカリ smile at=center time=0ms
@chara ソウ at=left time=0ms
そのまま。
`;

// 反転したまま、揺れない差分から揺れる差分へ同じ枠で替える（枠を当てたあとに部品のキャンバスを作る順になる）
const swap = `@bg hill_dusk.webp
@window show
@chara アカリ normal at=center flip=true time=0ms
いち。
@chara アカリ smile time=0ms
に。
`;

/** アカリの smile の、裏返す軸（画像の左端からの px）。 */
const AXIS = 150;

/** 立ち絵の枠、中の絵（直下の img）、揺れる立ち絵のキャンバスの画面の範囲と、キャンバスの横の倍率（裏返っていれば負）。 */
const measureParts = (p: Page, who: string, canvasClass: string) =>
  p.evaluate(
    ({ who, canvasClass }) => {
      const el = document.querySelector<HTMLElement>(`.sprite[data-who="${who}"]`)!;
      const img = el.querySelector<HTMLImageElement>(":scope > img")!;
      const canvas = el.querySelector<HTMLCanvasElement>(`:scope > canvas.${canvasClass}`);
      const rect = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, width: r.width, center: r.left + r.width / 2 };
      };
      const t = canvas ? getComputedStyle(canvas).transform : "none";
      return { box: rect(el), pic: rect(img), natural: img.naturalWidth, canvas: canvas ? rect(canvas) : null, scaleX: t === "none" ? 1 : new DOMMatrixReadOnly(t).a };
    },
    { who, canvasClass },
  );

describe.skipIf(!e2e)("揺れる立ち絵の反転（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { flipped, plain, swap },
      config: { entry: "flipped" },
      before(dir) {
        const path = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(path, "utf8"));
        // 動きで範囲が揺れないよう止める
        const still = { type: "sway", strength: 0, hair: 0 };
        const akari = cast.cast["アカリ"].appearances.default.variants;
        akari.smile.model = still;
        akari.smile.frame.flipAxis = AXIS;
        cast.cast["ソウ"].model = still;
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
    await p.waitForTimeout(300);
    return p;
  };

  it("揺れる立ち絵のキャンバスを、軸のある差分は軸で、軸の無い差分は枠の中央で裏返す。反転しなければ裏返さない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, "flipped", "反転");
      const akari = await measureParts(p, "アカリ", "sprite-sway");
      expect(akari.canvas, `${name} 揺れる立ち絵のキャンバス`).not.toBeNull();
      // 絵は軸で裏返る（sprite-flip-axis.test.ts と同じ）
      const axis = (AXIS / akari.natural) * akari.box.width;
      expect(akari.pic.left, name).toBeCloseTo(akari.box.left + 2 * axis - akari.box.width, 0);
      // キャンバスも裏返り、絵と同じ軸で裏返る（キャンバスは枠より左右に同じだけ大きいので、真ん中が絵の真ん中と重なる）。大きさは変わらない
      expect(akari.scaleX, name).toBeLessThan(0);
      expect(akari.canvas!.center, name).toBeCloseTo(akari.pic.center, 0);
      expect(akari.canvas!.width, name).toBeGreaterThan(akari.box.width);
      // 軸の無い差分は枠の中央で裏返す（範囲は変わらない）
      const sou = await measureParts(p, "ソウ", "sprite-sway");
      expect(sou.scaleX, name).toBeLessThan(0);
      expect(sou.canvas!.center, name).toBeCloseTo(sou.box.center, 0);
      await p.close();

      const q = await open(browser, "plain", "そのまま");
      for (const who of ["アカリ", "ソウ"]) {
        const m = await measureParts(q, who, "sprite-sway");
        expect(m.scaleX, `${name} ${who}`).toBe(1);
        expect(m.canvas!.center, `${name} ${who}`).toBeCloseTo(m.box.center, 0);
      }
      await q.close();
    }
  });

  it("反転したまま揺れる差分に替えても、新しく作ったキャンバスを軸で裏返す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, "swap", "いち");
      await p.waitForFunction(() => window.__liminalia!.host.waiting);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("に"));
      await p.waitForFunction(() => !!document.querySelector('.sprite[data-who="アカリ"] > canvas.sprite-sway'));
      const m = await measureParts(p, "アカリ", "sprite-sway");
      expect(m.scaleX, name).toBeLessThan(0);
      expect(m.canvas!.center, name).toBeCloseTo(m.pic.center, 0);
      expect(m.pic.center, name).not.toBeCloseTo(m.box.center, 0);
      await p.close();
    }
  });
});

/**
 * 読み込みを待ってからキャンバスを足す部品（見本のプラグイン。作ってから 300ms 後に、枠より左右に 10% ずつ大きいキャンバスを足す）も、
 * 足したときに反転と軸を当てる（前は次に枠を当てるまで裏返らなかった。2026-11-19 の rest-q の残り）。
 */
const LATE_PLUGIN = `export default {
  name: "late-part",
  extensions: {
    spriteParts: {
      late: (ctx) => {
        let canvas = null;
        const timer = setTimeout(() => {
          canvas = document.createElement("canvas");
          canvas.className = "sprite-late";
          Object.assign(canvas.style, { position: "absolute", left: "-10%", top: "0", width: "120%", height: "100%", pointerEvents: "none" });
          ctx.el.append(canvas);
        }, 300);
        return { update() {}, dispose() { clearTimeout(timer); canvas?.remove(); } };
      },
    },
  },
};
`;

const late = `@bg hill_dusk.webp
@window show
@chara アカリ at=center flip=true time=0ms
@chara ソウ at=left flip=true time=0ms
あとから。
`;

describe.skipIf(!e2e)("あとからキャンバスを足す部品の反転（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { late },
      config: { entry: "late" },
      plugin: LATE_PLUGIN,
      before(dir) {
        const path = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(path, "utf8"));
        cast.cast["アカリ"].model = { type: "late" };
        cast.cast["アカリ"].appearances.default.variants.normal.frame.flipAxis = AXIS;
        cast.cast["ソウ"].model = { type: "late" };
        writeFileSync(path, JSON.stringify(cast));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("あとから足したキャンバスも、軸のある差分は軸で、軸の無い差分は枠の中央で裏返す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=late`);
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("あとから"));
      await p.waitForFunction(() => document.querySelectorAll(".sprite > canvas.sprite-late").length === 2);
      await p.waitForTimeout(100);
      const akari = await measureParts(p, "アカリ", "sprite-late");
      expect(akari.scaleX, name).toBeLessThan(0);
      expect(akari.pic.center, name).not.toBeCloseTo(akari.box.center, 0);
      expect(akari.canvas!.center, name).toBeCloseTo(akari.pic.center, 0);
      const sou = await measureParts(p, "ソウ", "sprite-late");
      expect(sou.scaleX, name).toBeLessThan(0);
      expect(sou.canvas!.center, name).toBeCloseTo(sou.box.center, 0);
      await p.close();
    }
  });
});
