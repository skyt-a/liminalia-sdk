import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { encodePng } from "../../pwa-icons.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 公式のプラグインの Live2D と Spine の立ち絵（plugins/live2d、plugins/spine）を、実際のブラウザで確かめる。
 * 本物の Cubism Core と Spine のランタイムは同梱できないので、同じ口を持つ偽のもの（各プラグインの test/fixtures）を作品の others に置く。
 * 偽のモデルは四角形で描くので、キャンバスの画素の色で、差分の表情と動き、口パク、まばたき、マスク、セーブとロード、スキップを確かめる。
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const LIVE2D = join(ROOT, "plugins/live2d");
const SPINE = join(ROOT, "plugins/spine");

/** 左上が赤、右上が緑、左下が青、右下が白の 64×64 の絵。 */
function quadrants(): Buffer {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const right = x >= size / 2;
      const bottom = y >= size / 2;
      const c = !bottom ? (right ? [0, 255, 0] : [255, 0, 0]) : right ? [255, 255, 255] : [0, 0, 255];
      data.set([...c, 255], (y * size + x) * 4);
    }
  }
  return encodePng({ width: size, height: size, data });
}

function copyInto(dir: string, from: string, to: string): void {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  cpSync(from, join(dir, to), { recursive: true });
}

const SCENARIO = `@window show
@chara アカリ at=left
@chara ソウ at=right
いち。
@chara アカリ smile
@chara ソウ smile
アカリ「に。」
アカリ「くちをうごかすための、ながいながい台詞です。もじがでているあいだ、くちがひらいたりとじたりします。まだつづきます。」
@chara アカリ normal
@chara ソウ normal
さん。
@choice
- つぎへ -> #next
@end
# next
@chara アカリ surprised
よん。
`;

/** 反転して出す（2026-11-19 の rest-q。アカリの normal には裏返す軸を書く）。 */
const FLIPPED = `@window show
@chara アカリ at=left flip=true time=0ms
@chara ソウ at=right flip=true time=0ms
はんてん。
`;

/** アカリの normal の、裏返す軸（画像の左端からの px）。 */
const FLIP_AXIS = 150;

/** 立ち絵の枠、中の絵（直下の img）、部品のキャンバスの画面の範囲の真ん中と、キャンバスの横の倍率（裏返っていれば負）。 */
const flipOf = (p: Page, who: string, kind: "live2d" | "spine") =>
  p.evaluate(
    ({ who, kind }) => {
      const el = document.querySelector<HTMLElement>(`.sprite[data-who="${who}"]`)!;
      const center = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      const canvas = el.querySelector<HTMLCanvasElement>(`:scope > canvas.sprite-${kind}`)!;
      const t = getComputedStyle(canvas).transform;
      return { box: center(el), pic: center(el.querySelector(":scope > img")!), canvas: center(canvas), scaleX: t === "none" ? 1 : new DOMMatrixReadOnly(t).a };
    },
    { who, kind },
  );

type Rgba = [number, number, number, number];

/**
 * 立ち絵のキャンバスの、モデルの座標の点の色。Live2D の偽のモデルはキャンバスが 400×600、1 単位が 300px（原点は真ん中）、
 * Spine の偽の骨格は (-200, 0) から幅 400、高さ 600（上が正）。どちらも枠（467×700）いっぱいに収まり、キャンバスは枠の上下左右に 15% ずつ大きい。
 */
function pixel(p: Page, who: string, kind: "live2d" | "spine", ux: number, uy: number): Promise<Rgba | null> {
  return p.evaluate(
    ({ who, kind, ux, uy }) => {
      const c = document.querySelector<HTMLCanvasElement>(`.sprite[data-who="${who}"] canvas.sprite-${kind}`);
      if (!c || c.width < 2) return null;
      const pad = 0.15;
      const bw = c.width / (1 + 2 * pad);
      const bh = c.height / (1 + 2 * pad);
      const bx = c.width * pad / (1 + 2 * pad);
      const by = c.height * pad / (1 + 2 * pad);
      // 偽のモデルの座標 → 400×600 のキャンバスの px（上が 0）
      const [cx, cy] = kind === "live2d" ? [200 + ux * 300, 300 - uy * 300] : [ux + 200, 600 - uy];
      const x = Math.round(bx + (cx / 400) * bw);
      const y = Math.round(by + (cy / 600) * bh);
      const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]!] as [number, number, number, number];
    },
    { who, kind, ux, uy },
  );
}

const near = (c: Rgba | null, want: Rgba) => !!c && c.every((v, i) => Math.abs(v - want[i]!) < 40);
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

async function waitPixel(p: Page, who: string, kind: "live2d" | "spine", ux: number, uy: number, want: Rgba, timeout = 5000): Promise<Rgba | null> {
  const end = Date.now() + timeout;
  let last: Rgba | null = null;
  while (Date.now() < end) {
    last = await pixel(p, who, kind, ux, uy);
    if (near(last, want)) return last;
    await p.waitForTimeout(50);
  }
  return last;
}

const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s), s, { timeout: 15_000 });
const advance = async (p: Page, s: string) => {
  // ロードの直後などは一度目の送りが効かないことがあるので、本文が替わるまで送り直す
  for (let i = 0; i < 5; i++) {
    await p.waitForFunction(() => window.__liminalia!.host.waiting, undefined, { timeout: 15_000 });
    await p.keyboard.press("Enter");
    const ok = await p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s), s, { timeout: 3000 }).then(() => true, () => false);
    if (ok) return;
  }
  await waitText(p, s);
};

describe.skipIf(!e2e)("Live2D と Spine の立ち絵（公式のプラグイン、偽のランタイムで。ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO, f: FLIPPED },
      config: { entry: "a", plugins: ["./plugins/live2d", "./plugins/spine"] },
      before: (dir) => {
        copyInto(dir, join(LIVE2D, "package.json"), "plugins/live2d/package.json");
        copyInto(dir, join(LIVE2D, "src"), "plugins/live2d/src");
        copyInto(dir, join(SPINE, "package.json"), "plugins/spine/package.json");
        copyInto(dir, join(SPINE, "src"), "plugins/spine/src");
        copyInto(dir, join(LIVE2D, "test/fixtures/fake-cubism-core.js"), "assets/others/live2d/live2dcubismcore.min.js");
        copyInto(dir, join(SPINE, "test/fixtures/fake-spine-webgl.js"), "assets/others/spine/spine-webgl.min.js");
        copyInto(dir, join(LIVE2D, "test/fixtures/model"), "assets/fgimage/l2d");
        copyInto(dir, join(SPINE, "test/fixtures/model"), "assets/fgimage/sp");
        mkdirSync(join(dir, "assets/fgimage/l2d/fake.64"), { recursive: true });
        writeFileSync(join(dir, "assets/fgimage/l2d/fake.64/texture_00.png"), quadrants());
        writeFileSync(join(dir, "assets/fgimage/sp/fake.png"), quadrants());
        const path = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(path, "utf8")) as { cast: Record<string, { model?: Record<string, unknown> }> };
        // 動きで画素がずれないよう、待機の動きと呼吸とまばたきは止める
        cast.cast["アカリ"]!.model = { type: "live2d", src: "l2d/fake.model3.json", idle: "", breath: false, blink: false };
        // 差分の model は人物の model に重なる（surprised は同じモデルで smile の表情。モーションは同じ名前のグループ）
        const akari = cast.cast["アカリ"] as unknown as { appearances: Record<string, { variants: Record<string, Record<string, unknown>> }> };
        akari.appearances.default!.variants.surprised!.model = { type: "live2d", expression: "smile" };
        (akari.appearances.default!.variants.normal!.frame as Record<string, unknown>).flipAxis = FLIP_AXIS;
        cast.cast["ソウ"]!.model = { type: "spine", src: "sp/fake.json", blink: "" };
        writeFileSync(path, JSON.stringify(cast));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("差分の名前で表情と動きを替え、口パク、マスク、セーブとロード、スキップに合わせて描く", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const warnings: string[] = [];
      p.on("console", (m) => {
        if (m.type() === "warning" || m.type() === "error") warnings.push(m.text());
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いち");
      // 読み終えて描いたら静止画を隠し、撮影を待たせない
      await p.waitForFunction(() => document.querySelectorAll(".sprite.sprite-covered").length === 2, undefined, { timeout: 20_000 });
      expect(await p.evaluate("window.__liminalia.shotReady()"), name).toBe(true);
      expect(await p.evaluate(`getComputedStyle(document.querySelector('.sprite[data-who="アカリ"] > img')).visibility`), name).toBe("hidden");
      // Live2D: 体は赤（基準の差分）、帽子はマスクの内側だけ白、外は描かない
      await waitPixel(p, "アカリ", "live2d", 0, -0.6, RED);
      expect(near(await pixel(p, "アカリ", "live2d", 0, -0.6), RED), `${name} Live2D の体`).toBe(true);
      expect(near(await pixel(p, "アカリ", "live2d", 0, 0.8), WHITE), `${name} マスクの内側`).toBe(true);
      expect(near(await pixel(p, "アカリ", "live2d", 0.4, 0.8), CLEAR), `${name} マスクの外側`).toBe(true);
      expect(near(await pixel(p, "アカリ", "live2d", 0, 0.28), WHITE), `${name} 目`).toBe(true);
      // Spine: 体は待機の動きの赤、目は白
      expect(near(await waitPixel(p, "ソウ", "spine", 0, 100, RED), RED), `${name} Spine の体`).toBe(true);
      expect(near(await pixel(p, "ソウ", "spine", 0, 0.73 * 600), WHITE), `${name} Spine の目`).toBe(true);

      // 差分 smile: Live2D は同じ名前の表情（1 秒で重なる）、Spine は同じ名前の動き
      await advance(p, "に。");
      expect(near(await waitPixel(p, "アカリ", "live2d", 0, -0.6, GREEN), GREEN), `${name} Live2D の表情`).toBe(true);
      expect(near(await waitPixel(p, "ソウ", "spine", 0, 100, GREEN), GREEN), `${name} Spine の差分の動き`).toBe(true);

      // ボイスに合わせた口パク（ボイスの大きさを 1 にする）。止めると閉じる
      await p.evaluate("window.__liminalia.host.audio.speakerLevel = (names) => (names.includes('アカリ') || names.includes('ソウ') ? 1 : undefined)");
      expect(near(await waitPixel(p, "アカリ", "live2d", 0, -0.1, BLUE), BLUE), `${name} Live2D の口`).toBe(true);
      expect(near(await waitPixel(p, "ソウ", "spine", 0, 0.5 * 600, BLACK), BLACK), `${name} Spine の口`).toBe(true);
      await p.evaluate("window.__liminalia.host.audio.speakerLevel = () => 0");
      expect(near(await waitPixel(p, "アカリ", "live2d", 0, -0.1, GREEN), GREEN), `${name} Live2D の口を閉じる`).toBe(true);
      await p.evaluate("delete window.__liminalia.host.audio.speakerLevel");

      // セーブして別の差分へ進み、ロードすると、表情をつながずに戻す
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await advance(p, "くちを");
      // ボイスの無い台詞は、文字を出している間だけ口を開け閉めする
      let opened = false;
      for (let i = 0; i < 40 && !opened; i++) {
        opened = near(await pixel(p, "アカリ", "live2d", 0, -0.1), BLUE);
        await p.waitForTimeout(30);
      }
      expect(opened, `${name} 文字を出している間の口パク`).toBe(true);
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await waitText(p, "に。");
      await p.waitForFunction(() => document.querySelectorAll(".sprite.sprite-covered").length === 2, undefined, { timeout: 20_000 });
      expect(near(await pixel(p, "アカリ", "live2d", 0, -0.6), GREEN), `${name} ロードした表情`).toBe(true);
      expect(near(await waitPixel(p, "ソウ", "spine", 0, 100, GREEN, 1000), GREEN), `${name} ロードした動き`).toBe(true);

      // スキップ中の差分の切り替えは一気に（表情のフェード 1 秒を待たない）
      await advance(p, "くちを");
      await p.evaluate("window.__liminalia.host.skipping = true");
      await advance(p, "さん。");
      await p.waitForTimeout(150);
      expect(near(await pixel(p, "アカリ", "live2d", 0, -0.6), RED), `${name} スキップ中の表情`).toBe(true);
      expect(near(await pixel(p, "ソウ", "spine", 0, 100), RED), `${name} スキップ中の動き`).toBe(true);
      await p.evaluate("window.__liminalia.host.skipping = false");

      // 差分の model を重ねた表情と、差分と同じ名前のモーション（体が右へ 0.3 動く）
      const next = p.locator(".choices button", { hasText: "つぎへ" });
      for (let i = 0; i < 5 && !(await next.isVisible()); i++) {
        await p.waitForFunction(() => window.__liminalia!.host.waiting || window.__liminalia!.host.choosing, undefined, { timeout: 15_000 });
        if (!(await p.evaluate("window.__liminalia.host.choosing"))) await p.keyboard.press("Enter");
        await next.waitFor({ timeout: 3000 }).catch(() => undefined);
      }
      await next.click();
      await waitText(p, "よん。");
      expect(near(await waitPixel(p, "アカリ", "live2d", 0.7, -0.6, GREEN), GREEN), `${name} 差分の model と動き`).toBe(true);
      expect(near(await pixel(p, "アカリ", "live2d", -0.45, -0.6), CLEAR), `${name} 動いた後の左端`).toBe(true);

      expect(warnings.filter((w) => /Live2D|Spine|立ち絵/.test(w)), name).toEqual([]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/model-plugins-${name}.png` }).catch(() => undefined);
      await p.close();
    }
  });

  it("@chara の flip=true で、部品のキャンバスも普通の立ち絵と同じく裏返し、差分の枠の flipAxis があればその軸で裏返す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=f`);
      await waitText(p, "はんてん");
      await p.waitForFunction(() => document.querySelectorAll(".sprite.sprite-covered").length === 2, undefined, { timeout: 20_000 });
      // Live2D（軸あり）: 絵と同じ軸で裏返る（キャンバスは枠より左右に同じだけ大きいので、真ん中が絵の真ん中と重なる）
      const live2d = await flipOf(p, "アカリ", "live2d");
      expect(live2d.scaleX, `${name} Live2D`).toBeLessThan(0);
      expect(live2d.pic, `${name} Live2D の絵は軸で裏返る`).not.toBeCloseTo(live2d.box, 0);
      expect(live2d.canvas, `${name} Live2D`).toBeCloseTo(live2d.pic, 0);
      // Spine（軸なし）: 枠の中央で裏返る
      const spine = await flipOf(p, "ソウ", "spine");
      expect(spine.scaleX, `${name} Spine`).toBeLessThan(0);
      expect(spine.canvas, `${name} Spine`).toBeCloseTo(spine.box, 0);
      await p.close();
    }
  });

  it("モデルを読み終えるまで撮影を待たせ、ランタイムが無ければ静止画のまま知らせる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const warnings: string[] = [];
      p.on("console", (m) => {
        if (m.type() === "warning") warnings.push(m.text());
      });
      // Live2D の .moc3 を遅らせ、Spine のランタイムを無くす
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      await p.route("**/fake.moc3*", async (route) => {
        await gate;
        await route.continue();
      });
      await p.route("**/spine-webgl.min.js*", (route) => route.fulfill({ status: 404, body: "" }));
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いち");
      await p.waitForTimeout(300);
      expect(await p.evaluate("window.__liminalia.shotReady()"), name).toBe(false);
      release();
      await p.waitForFunction(() => window.__liminalia!.shotReady(), undefined, { timeout: 20_000 });
      await p.waitForFunction(() => document.querySelector('.sprite[data-who="アカリ"]')?.classList.contains("sprite-covered"), undefined, { timeout: 20_000 });
      // Spine は静止画のまま
      expect(await p.evaluate(`document.querySelector('.sprite[data-who="ソウ"]').classList.contains("sprite-covered")`), name).toBe(false);
      expect(warnings.some((w) => w.includes("Spine のランタイム")), name).toBe(true);
      await p.close();
    }
  });
});

/** 本物のランタイムとモデル（手元にあるときだけ。docs/live2d-spine.md）。 */
const REAL = {
  core: process.env.LIMINALIA_LIVE2D_CORE ?? "",
  model: process.env.LIMINALIA_LIVE2D_MODEL ?? "",
  runtime: process.env.LIMINALIA_SPINE_RUNTIME ?? "",
  skeleton: process.env.LIMINALIA_SPINE_SKELETON ?? "",
};
const realLive2d = !!REAL.core && !!REAL.model;
const realSpine = !!REAL.runtime && !!REAL.skeleton;

describe.skipIf(!e2e || !(realLive2d || realSpine))("本物の Cubism Core と Spine のランタイムで描く（手元にあるときだけ。ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: "@window show\n@chara アカリ at=left\n@chara ソウ at=right\nいち。\n@chara アカリ smile\n@chara ソウ smile\nに。\n" },
      config: { entry: "a", plugins: ["./plugins/live2d", "./plugins/spine"] },
      before: (dir) => {
        copyInto(dir, join(LIVE2D, "package.json"), "plugins/live2d/package.json");
        copyInto(dir, join(LIVE2D, "src"), "plugins/live2d/src");
        copyInto(dir, join(SPINE, "package.json"), "plugins/spine/package.json");
        copyInto(dir, join(SPINE, "src"), "plugins/spine/src");
        const path = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(path, "utf8")) as { cast: Record<string, { model?: Record<string, unknown> }> };
        if (realLive2d) {
          copyInto(dir, REAL.core, "assets/others/live2d/live2dcubismcore.min.js");
          copyInto(dir, dirname(REAL.model), "assets/fgimage/real-l2d");
          cast.cast["アカリ"]!.model = { type: "live2d", src: `real-l2d/${REAL.model.slice(dirname(REAL.model).length + 1)}` };
        }
        if (realSpine) {
          copyInto(dir, REAL.runtime, "assets/others/spine/spine-webgl.min.js");
          copyInto(dir, dirname(REAL.skeleton), "assets/fgimage/real-spine");
          cast.cast["ソウ"]!.model = { type: "spine", src: `real-spine/${REAL.skeleton.slice(dirname(REAL.skeleton).length + 1)}` };
        }
        writeFileSync(path, JSON.stringify(cast));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("読み込んで描き、差分を替えても止まらない", async () => {
    const painted = (p: Page, kind: string) =>
      p.evaluate((kind) => {
        const c = document.querySelector<HTMLCanvasElement>(`canvas.sprite-${kind}`);
        if (!c || c.width < 2) return 0;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
        return n / (c.width * c.height);
      }, kind);
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const warnings: string[] = [];
      p.on("console", (m) => {
        if (m.type() === "warning" || m.type() === "error") warnings.push(m.text());
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いち");
      const kinds = [...(realLive2d ? ["live2d"] : []), ...(realSpine ? ["spine"] : [])];
      await p.waitForFunction((n) => document.querySelectorAll(".sprite.sprite-covered").length === n, kinds.length, { timeout: 30_000 });
      for (const kind of kinds) expect(await painted(p, kind), `${name} ${kind}`).toBeGreaterThan(0.01);
      await advance(p, "に。");
      await p.waitForTimeout(1500);
      for (const kind of kinds) expect(await painted(p, kind), `${name} ${kind}`).toBeGreaterThan(0.01);
      expect(warnings.filter((w) => /Live2D|Spine|立ち絵|WebGL/.test(w)), name).toEqual([]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/model-plugins-real-${name}.png` }).catch(() => undefined);
      await p.close();
    }
  });
});
