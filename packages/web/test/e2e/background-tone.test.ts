import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findTone, toneMatrix } from "@liminalia/lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 背景の色調（@bg の tone= と ui.backgroundTones）を、実際のブラウザで確かめる。
 * - 色調の付いた背景が出ている間は立ち絵に掛かり、色調の無い背景に替えると外れる。@bg の tone= が ui.backgroundTones より先
 * - @tone で決めた色調が先。@tone none で背景の色調に戻り、@tone plain は背景の色調も掛けない
 * - セーブとロード、一ページ戻る、履歴（ログ）から読み直すで、その時の色調に戻る
 * 色調は立ち絵の SVG の色の行列（feColorMatrix）と、画面写真の一点の色で見る。
 * LIMINALIA_E2E_OUT を指定すると、ひな形の人物と背景で撮った画面をそこに残す（目で見るため）。
 */

const OUT = process.env.LIMINALIA_E2E_OUT;
const BODY = resolve(import.meta.dirname, "fixtures/layer-body.png"); // 100×200 の赤

const cast = {
  speakers: ["ユイ"],
  cast: { ユイ: { appearances: { default: { variants: { normal: { image: "yui.png", frame: { width: 100, height: 200, positions: { left: { left: 100, top: 100 } } } } } } } } },
};

/** ページの本文 → そのとき立ち絵に掛かっている色調（null は掛けない）。 */
const PAGES: [text: string, tone: string | null][] = [
  ["朝。", null],
  ["夜。", "night"],
  ["白黒の背景。", "mono"],
  ["朝に戻る。", null],
  ["夕方。", "evening"],
  ["決めた色調。", "sepia"],
  ["背景を替えても決めたまま。", "sepia"],
  ["背景の色調に戻る。", "night"],
  ["この人だけ掛けない。", null],
  ["この背景では掛けない。", null],
  ["最後。", "night"],
];

const SCENARIO = `@window show
@bg hill_morning.webp
@chara ユイ normal at=left
朝。
@bg hill_night.webp time=400ms
夜。
@bg hill_dusk.webp tone=mono
白黒の背景。
@bg hill_morning.webp time=300ms
朝に戻る。
@bg hill_dusk.webp
夕方。
@tone sepia
決めた色調。
@bg hill_night.webp
背景を替えても決めたまま。
@tone none
背景の色調に戻る。
@tone plain who=ユイ
この人だけ掛けない。
@tone none
@bg hill_night.webp tone=none
この背景では掛けない。
@bg hill_night.webp
最後。
`;

const BACKGROUND_TONES = { "hill_night.webp": "night", "hill_dusk.webp": "evening" };

/** 色調の行列（描画側が feColorMatrix の values に書く形）。掛けないなら null。 */
const matrixOf = (tone: string | null) => (tone === null ? null : toneMatrix(findTone(tone)).map((v) => v.toFixed(4)).join(" "));

/** 立ち絵に掛かっている色の行列（掛かっていなければ null）。 */
const spriteMatrix = (p: Page, who: string) =>
  p.evaluate(`(() => {
    const el = document.querySelector('.sprite[data-who="${who}"]');
    const f = el && el.style.getPropertyValue("--tone-filter");
    const id = f && /#([^)]+)/.exec(f)?.[1];
    return id ? document.getElementById(id).querySelector("feColorMatrix").getAttribute("values") : null;
  })()`) as Promise<string | null>;

/** 画面の (x, y) の色（画面写真から）。 */
async function rgbAt(p: Page, x: number, y: number): Promise<number[]> {
  const png = await p.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return p.evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${png.toString("base64")}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  })()`) as Promise<number[]>;
}

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text")?.textContent.replace("▼", "") ?? ""`) as Promise<string>;
const waitText = async (p: Page, t: string) => {
  await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`, undefined, { timeout: 30_000 });
  // 背景と色調の切り替え（fade）を終える
  await p.waitForTimeout(700);
};
/** 次のページへ（今のページは waitText で出し切っている）。 */
const advance = (p: Page) => p.evaluate("window.__liminalia.host.advance()");

describe.skipIf(!e2e)("背景の色調（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let looks: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", ui: { backgroundTones: BACKGROUND_TONES } },
      files: { "assets/fgimage/yui.png": BODY },
      before: (dir) => writeFileSync(join(dir, "cast.json"), JSON.stringify(cast)),
    });
    // 目で見る画面（ひな形の人物と背景）
    looks = await startProject({
      scenario: { a: "@window show\n@bg hill_morning.webp\n@chara アカリ normal at=left\n@chara ソウ normal at=right\n朝の丘。\n@bg hill_night.webp time=400ms\n夜の丘。\n@bg hill_dusk.webp time=400ms\n夕方の丘。\n@tone plain who=ソウ\n一人だけ掛けない。\n" },
      config: { entry: "a", ui: { backgroundTones: BACKGROUND_TONES } },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await looks?.close();
  });

  it("背景が出ている間は立ち絵に掛け、別の背景で外す。@tone が先で、none で背景の色調に戻る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      for (const [i, [t, tone]] of PAGES.entries()) {
        if (i > 0) await advance(p);
        await waitText(p, t);
        expect(await spriteMatrix(p, "ユイ"), `${name} ${t}`).toBe(matrixOf(tone));
        // 実際の画面でも、色調の無いときは赤のまま、夜は暗くなる
        const [r, g, b] = await rgbAt(p, 150, 200);
        if (tone === null) expect(r! > 180 && g! < 60 && b! < 60, `${name} ${t} ${r},${g},${b}`).toBe(true);
        if (tone === "night") expect(r! < 140, `${name} ${t} ${r},${g},${b}`).toBe(true);
        if (tone === "mono") expect(Math.abs(r! - g!) < 24 && Math.abs(g! - b!) < 24, `${name} ${t} ${r},${g},${b}`).toBe(true);
      }
      await p.close();
    }
  });

  it("セーブとロード、一ページ戻る、ログから読み直すで、その時の色調に戻る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "朝。");
      await advance(p);
      await waitText(p, "夜。");
      const saved = await p.evaluate("JSON.stringify(window.__liminalia.system.runtime.save())");
      await advance(p);
      await waitText(p, "白黒の背景。");
      await advance(p);
      await waitText(p, "朝に戻る。");
      expect(await spriteMatrix(p, "ユイ"), `${name} 朝に戻る`).toBeNull();
      // 一ページ戻る（色調の付いた背景のページへ）
      await p.evaluate(`void window.__liminalia.system.perform("rollback")`);
      await p.waitForTimeout(600);
      expect([await text(p), await spriteMatrix(p, "ユイ")], `${name} 戻る`).toEqual(["白黒の背景。", matrixOf("mono")]);
      // 進め直して、色調の無い背景のページへ
      await p.evaluate(`void window.__liminalia.system.perform("rollforward")`);
      await p.waitForTimeout(600);
      expect([await text(p), await spriteMatrix(p, "ユイ")], `${name} 進め直す`).toEqual(["朝に戻る。", null]);
      // ログ（履歴）から「夜。」を読み直す
      const index = (await p.evaluate(`window.__liminalia.system.backlog.findIndex((e) => e.parts.map((x) => x.text ?? "").join("").includes("夜。"))`)) as number;
      expect(index, name).toBeGreaterThanOrEqual(0);
      await p.evaluate(`void window.__liminalia.system.jumpToBacklog(${index})`);
      // 読み直すかの確かめに「はい」
      await p.click(".lm-dialog .lm-primary");
      await waitText(p, "夜。");
      expect(await spriteMatrix(p, "ユイ"), `${name} ログから`).toBe(matrixOf("night"));
      // 先へ進めて色調を外してから、セーブしたところをロードする
      await advance(p);
      await waitText(p, "白黒の背景。");
      await advance(p);
      await waitText(p, "朝に戻る。");
      expect(await spriteMatrix(p, "ユイ"), `${name} ロードの前`).toBeNull();
      await p.evaluate(`window.__liminalia.system.loadSave(JSON.parse(${JSON.stringify(saved)}))`);
      await waitText(p, "夜。");
      expect(await spriteMatrix(p, "ユイ"), `${name} ロード`).toBe(matrixOf("night"));
      await p.close();
    }
  });

  it("ひな形の人物と背景で撮る（目で見る）", async () => {
    if (!OUT) return;
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${looks.url}?autostart=1&start=a`);
      for (const [i, [t, file]] of ([["朝の丘。", "morning"], ["夜の丘。", "night"], ["夕方の丘。", "dusk"], ["一人だけ掛けない。", "plain"]] as const).entries()) {
        if (i > 0) await advance(p);
        await waitText(p, t);
        await p.screenshot({ path: `${OUT}/background-tone-${file}-${name}.png` });
      }
      await p.close();
    }
    expect(readFileSync(`${OUT}/background-tone-night-${list[0]!.name}.png`).length).toBeGreaterThan(0);
  });
});
