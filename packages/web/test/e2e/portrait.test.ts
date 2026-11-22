import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { UI_THEMES, applyUiTheme } from "@liminalia/lang";
import { copyUiThemeAssets } from "@liminalia/project";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 舞台が作品の screen の大きさになることと、縦長の作品の並べ方を、ブラウザで測る。
 * - 舞台の大きさ・立ち絵の位置・吹き出し・NVL・縦書き・縮小画像・背景の焦点・カメラ
 * - 全テーマで、本文・選択肢・システム画面が舞台からはみ出さず、文字と部品が重ならない
 * - 基準の大きさと違う作品（1920×1080・1024×768・1080×1920）は文字と枠が同じ割合で拡大・縮小される
 * - 1280×720 の作品の舞台には何も書かない（横長の見た目は変わらない）
 */

const SCENARIO = `@bg hill_dusk.webp
@chara アカリ normal at=left
@chara ソウ normal at=right
@window show
ソウ「今夜は百年に一度の流星群が来るらしい。ラジオは朝から同じことばかり言っていて、町の人はみな丘の上の天文台を見上げているのだけれど、あそこにはもうだれもいないはずだ」
本文の二ページ目。
@choice
- 望遠鏡をのぞく、というとても長い選択肢の文章を、舞台の幅に収まるかどうか確かめるために書いておく -> #a
- ラジオをつける -> #a
- 外で空を見上げる -> #a
@end
# a
終わり。
`;

const PORTRAIT = { width: 720, height: 1280 };

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** 舞台の座標で測った要素の箱（舞台の外へはみ出した量も分かる）。 */
const rects = (p: Page, selector: string) =>
  p.evaluate(`(() => {
    const s = document.querySelector(".stage").getBoundingClientRect();
    return [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[hidden]");
    }).map((e) => { const b = e.getBoundingClientRect(); return { left: b.left - s.left, top: b.top - s.top, right: b.right - s.left, bottom: b.bottom - s.top, width: b.width, height: b.height, text: (e.textContent || "").slice(0, 16) }; });
  })()`) as Promise<(Rect & { text: string })[]>;

const expectInside = (list: (Rect & { text?: string })[], stage: { width: number; height: number }, what: string) => {
  expect(list.length, `${what} が出ていない`).toBeGreaterThan(0);
  for (const r of list) {
    const where = `${what}「${r.text ?? ""}」 ${JSON.stringify(r)}`;
    expect(r.left, where).toBeGreaterThanOrEqual(-0.5);
    expect(r.top, where).toBeGreaterThanOrEqual(-0.5);
    expect(r.right, where).toBeLessThanOrEqual(stage.width + 0.5);
    expect(r.bottom, where).toBeLessThanOrEqual(stage.height + 0.5);
  }
};

/** 重なっている組（入れ子を除く）。 */
const overlaps = (p: Page, selector: string) =>
  p.evaluate(`(() => {
    const list = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).opacity !== "0";
    });
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.contains(b) || b.contains(a)) continue;
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
        if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1) out.push([(a.textContent || a.className).slice(0, 16), (b.textContent || b.className).slice(0, 16)]);
      }
    }
    return out;
  })()`) as Promise<[string, string][]>;

/** 中身が枠の横からはみ出している（切れている）要素。 */
const clipped = (p: Page, selector: string) =>
  p.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth + 1).map((e) => (e.textContent || e.className).slice(0, 16))`) as Promise<string[]>;

const settle = (p: Page) =>
  p.evaluate(`document.fonts.ready.then(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { a.pause(); } } })`);

const waitPage = (p: Page, n: number) => p.waitForFunction((target) => { const l = (window as unknown as { __liminalia?: { pages(): number; host: { waiting: boolean } } }).__liminalia; return !!l && l.pages() >= target && l.host.waiting; }, n, { timeout: 60_000 });

async function openAt(browser: Browser, url: string, viewport: { width: number; height: number }, skip = 1): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${url}?autostart=1&start=a&skip=${skip}`);
  await waitPage(page, skip);
  await settle(page);
  return page;
}

const openScreen = async (p: Page, screen: string) => {
  await p.evaluate((s) => void (window as unknown as { __liminalia: { system: { request(r: unknown): unknown } } }).__liminalia.system.request({ name: "open-screen", args: { screen: s } }), screen);
  await p.waitForSelector(".lm-screen", { timeout: 10_000 });
  await p.waitForTimeout(150);
  await settle(p);
};

describe.skipIf(!e2e)("作品の screen の大きさの舞台（ブラウザ）", { timeout: 600_000 }, () => {
  let list: { name: string; browser: Browser }[] = [];
  const projects: TestProject[] = [];
  beforeAll(async () => {
    list = await browsers();
  });
  // テストごとに開発サーバーを止める（テーマごとに立てるので、溜めない）
  const closeProjects = async () => {
    for (const p of projects.splice(0)) await p.close();
  };
  afterEach(closeProjects);
  afterAll(async () => {
    for (const b of list) await b.browser.close();
  });

  const start = async (screen: { width: number; height: number } | undefined, ui: object = {}, theme?: string, scenario = SCENARIO) => {
    const project = await startProject({
      scenario: { a: scenario },
      config: { ...(screen ? { screen } : {}), ui },
      before: (dir) => {
        if (theme) copyUiThemeAssets(dir, UI_THEMES.find((t) => t.id === theme)!);
      },
    });
    projects.push(project);
    return project;
  };

  it("1280×720 の作品の舞台には何も書かない", async () => {
    const project = await start(undefined);
    for (const { browser } of list) {
      const p = await openAt(browser, project.url, { width: 1280, height: 720 });
      const s = await p.evaluate(`(() => { const e = document.querySelector(".stage"); return { cls: e.className, w: e.style.getPropertyValue("--stage-w"), zoom: getComputedStyle(document.querySelector(".message")).zoom, box: [e.offsetWidth, e.offsetHeight] }; })()`) as { cls: string; w: string; zoom: string; box: number[] };
      expect(s.cls).not.toContain("lm-portrait");
      expect(s.cls).not.toContain("lm-ui-scaled");
      expect(s.w).toBe("");
      expect(s.zoom).toBe("1");
      expect(s.box).toEqual([1280, 720]);
      await p.close();
    }
  });

  it("縦長: 舞台が screen の大きさで、黒い帯が出ない", async () => {
    const project = await start(PORTRAIT);
    for (const { browser } of list) {
      const p = await openAt(browser, project.url, PORTRAIT);
      const box = (await p.evaluate(`(() => { const r = document.querySelector(".stage").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cls: document.querySelector(".stage").className }; })()`)) as { x: number; y: number; w: number; h: number; cls: string };
      expect(box).toMatchObject({ x: 0, y: 0, w: 720, h: 1280 });
      expect(box.cls).toContain("lm-portrait");
      await p.close();
    }
  });

  it("全テーマ: 本文・選択肢・システム画面が舞台に収まり、部品と文字が重ならない", { timeout: 900_000 }, async () => {
    for (const [{ name, browser }, theme] of list.flatMap((b) => UI_THEMES.map((t) => [b, t] as const))) {
      const project = await start(PORTRAIT, applyUiTheme({}, theme), theme.id);
      const label = (what: string) => `${name} ${theme.id}: ${what}`;
      const p = await openAt(browser, project.url, PORTRAIT);

      // 本文: 枠は舞台の中、文字は枠の中で、互いに重ならない（吹き出しのテーマは吹き出しが枠）
      const dialogue = theme.ui.chat?.dialogue === true;
      const body = dialogue ? ".lim-chat-bubble" : ".message";
      const text = `${dialogue ? ".lim-chat-bubble" : ".message .text"} .ch`;
      const [message] = await rects(p, body);
      expectInside([message!], PORTRAIT, label("枠"));
      if (!dialogue) expectInside(await rects(p, ".message .name"), PORTRAIT, label("名前"));
      const chars = await rects(p, text);
      expectInside(chars, PORTRAIT, label("文字"));
      for (const c of chars) expect(c.right, label("文字が枠の右に収まる")).toBeLessThanOrEqual(message!.right);
      for (const c of chars) expect(c.bottom, label("文字が枠の下に収まる")).toBeLessThanOrEqual(message!.bottom);
      expect(await overlaps(p, text), label("文字の重なり")).toEqual([]);
      expectInside(await rects(p, ".lm-menubar"), PORTRAIT, label("操作の帯"));
      expect(await overlaps(p, ".lm-menubar-button"), label("帯のボタンの重なり")).toEqual([]);

      // システム画面
      for (const screen of ["menu", "save", "load", "config", "log"]) {
        await openScreen(p, screen);
        const what = label(screen);
        expectInside(await rects(p, ".lm-screen, .lm-screen button, .lm-screen input, .lm-screen h2"), PORTRAIT, what);
        expect(await overlaps(p, ".lm-screen button:not(.lm-log-jump), .lm-screen h2, .lm-screen input, .lm-config-label"), `${what} の重なり`).toEqual([]);
        expect(await clipped(p, ".lm-screen button"), `${what} の文字が切れている`).toEqual([]);
        if (screen === "config") {
          // 設定のほかのタブ（行が多く、中で送る）
          const tabs = p.locator(".lm-tab");
          for (let i = 1; i < (await tabs.count()); i++) {
            await tabs.nth(i).click();
            await p.waitForTimeout(60);
            expect(await overlaps(p, ".lm-config-rows button, .lm-config-rows input, .lm-config-label, .lm-config-value, .lm-config-end"), `${what} のタブ ${i} の重なり`).toEqual([]);
            expect(await clipped(p, ".lm-screen button"), `${what} のタブ ${i} の文字が切れている`).toEqual([]);
          }
        }
        await p.keyboard.press("Escape");
        await p.waitForTimeout(100);
        await p.waitForFunction(() => !document.querySelector(".lm-screen"), null, { timeout: 5000 }).catch(() => undefined);
      }
      await p.close();

      // 選択肢
      const c = await browser.newPage({ viewport: PORTRAIT });
      await c.goto(`${project.url}?autostart=1&start=a&skip=2`);
      await waitPage(c, 2);
      await c.click(".stage");
      await c.waitForSelector(".choices button", { timeout: 10_000 });
      await settle(c);
      expectInside(await rects(c, ".choices button"), PORTRAIT, label("選択肢"));
      expect(await overlaps(c, ".choices button"), label("選択肢の重なり")).toEqual([]);
      await c.close();

      // タイトル
      const t = await browser.newPage({ viewport: PORTRAIT });
      await t.goto(`${project.url}?autostart=1`);
      await t.waitForFunction(() => (window as unknown as { __liminalia?: { screen(): { mode: string } } }).__liminalia?.screen().mode === "title", null, { timeout: 60_000 });
      await settle(t);
      expectInside(await rects(t, ".lm-title-name, .lm-title-button"), PORTRAIT, label("タイトル"));
      expect(await overlaps(t, ".lm-title-name, .lm-title-button"), label("タイトルの重なり")).toEqual([]);
      await t.close();
      await closeProjects();
    }
  });

  it("縦長: 立ち絵は舞台の座標で並び、枠に名前が無い立ち位置は画面の下に置く", async () => {
    const project = await start(PORTRAIT, {}, undefined, `@window show
@chara アカリ normal at=center
本文。
`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const file = `${project.dir}/cast.json`;
    const json = JSON.parse(readFileSync(file, "utf8")) as { cast: Record<string, { appearances: Record<string, { variants: Record<string, { frame?: { width: number; height: number; positions?: unknown } }> }> }> };
    for (const v of Object.values(json.cast["アカリ"]!.appearances.default!.variants)) v.frame = { width: 400, height: 800 };
    writeFileSync(file, JSON.stringify(json));
    const browser = list[0]!.browser;
    const p = await openAt(browser, project.url, PORTRAIT);
    const [sprite] = await rects(p, ".sprite");
    expect(sprite).toMatchObject({ left: 160, top: 480, width: 400, height: 800 });
    await p.close();
  });

  it("縦長: NVL・縦書き・吹き出しも舞台に収まる", async () => {
    const browser = list[0]!.browser;
    const nvl = await start(PORTRAIT, {}, undefined, `@nvl on
画面全体に文章を積むサウンドノベルの本文。とても長い文章が折り返しても舞台の幅に収まるかどうかを確かめる。
`);
    let p = await openAt(browser, nvl.url, PORTRAIT);
    expectInside(await rects(p, ".message .text .ch"), PORTRAIT, "NVL の文字");
    let [box] = await rects(p, ".message");
    expect(box).toMatchObject({ left: 0, top: 0, width: 720, height: 1280 });
    await p.close();

    const vertical = await start(PORTRAIT, { message: { vertical: true } }, undefined, `@window show
縦書きの本文。
`);
    p = await openAt(browser, vertical.url, PORTRAIT);
    [box] = await rects(p, ".message");
    expectInside([box!], PORTRAIT, "縦書きの枠");
    expect(box!.right).toBe(720 - 24);
    await p.close();

    const balloon = await start(PORTRAIT, {}, undefined, `@chara アカリ normal at=right
@window show
@balloon on
アカリ「吹き出しの台詞。とても長い台詞が折り返しても舞台の幅に収まるかどうかを確かめる。」
`);
    p = await openAt(browser, balloon.url, PORTRAIT);
    [box] = await rects(p, ".message");
    expectInside([box!], PORTRAIT, "吹き出し");
    await p.close();
  });

  it("ui.message に位置を書くと、縦長の既定の置き方に足りない値を足す", async () => {
    const project = await start(PORTRAIT, { message: { height: 300 } });
    const p = await openAt(list[0]!.browser, project.url, PORTRAIT);
    const [box] = await rects(p, ".message");
    expect(box).toMatchObject({ left: 24, right: 720 - 24, height: 300, bottom: 1280 - 64 });
    await p.close();
  });

  it("ui.menuBar の x・y でクイックメニューを置く（縦長も、基準と違う大きさでは文字と枠の座標で）", async () => {
    for (const { browser } of list) {
      const wide = await start(undefined, { menuBar: { position: "bottom-center", x: 100, y: 50 } });
      const p1 = await openAt(browser, wide.url, { width: 1280, height: 720 });
      expect((await rects(p1, ".lm-menubar"))[0]).toMatchObject({ left: 100, top: 50 });
      await p1.close();
      // 書かなかった軸は position の置き方のまま
      const tall = await start(PORTRAIT, { menuBar: { x: 40 } });
      const p2 = await openAt(browser, tall.url, PORTRAIT);
      const [bar] = await rects(p2, ".lm-menubar");
      expect(bar).toMatchObject({ left: 40 });
      expect(bar!.bottom).toBeGreaterThan(1280 - 80);
      await p2.close();
      const hd = await start({ width: 1920, height: 1080 }, { menuBar: { x: 100, y: 50 } });
      const p3 = await openAt(browser, hd.url, { width: 1920, height: 1080 });
      expect((await rects(p3, ".lm-menubar"))[0]).toMatchObject({ left: 150, top: 75 });
      await p3.close();
      await closeProjects();
    }
  });

  it("背景の焦点（ui.backgroundFocus）が切り抜きと縮小画像の両方に効く", async () => {
    const project = await start(PORTRAIT, { backgroundFocus: { "hill_dusk.webp": "100% 50%", "*": "0% 50%" } });
    const p = await openAt(list[0]!.browser, project.url, PORTRAIT);
    const at = await p.evaluate(`getComputedStyle(document.querySelector(".background img")).objectPosition`);
    expect(at).toBe("100% 50%");
    // セーブの縮小画像は舞台の縦横比（256×144 ではない）
    const thumb = (await p.evaluate(`import("/src/system/thumbnail.ts").then(async (m) => {
      const url = m.captureThumbnail(document.querySelector(".stage"));
      const img = new Image(); img.src = url; await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    })`)) as { w: number; h: number };
    expect(thumb).toEqual({ w: 144, h: 256 });
    await p.close();
  });

  it("縦長のカメラは背景の端が見えない範囲に収まる", async () => {
    const project = await start(PORTRAIT, {}, undefined, `@bg hill_dusk.webp
@window show
@camera zoom=1.5 x=400 y=0 time=0ms
本文。
`);
    const p = await openAt(list[0]!.browser, project.url, PORTRAIT);
    const box = (await p.evaluate(`(() => { const b = document.querySelector(".background").getBoundingClientRect(); return { left: b.left, right: b.right }; })()`)) as { left: number; right: number };
    expect(box.left).toBeLessThanOrEqual(0.5);
    expect(box.right).toBeGreaterThanOrEqual(719.5);
    await p.close();
  });

  it("基準と違う大きさ: 文字と枠は同じ割合で拡大・縮小し、舞台の座標は screen のまま", async () => {
    const browser = list[0]!.browser;
    const base = await start({ width: 1280, height: 720 });
    const hd = await start({ width: 1920, height: 1080 });
    const p1 = await openAt(browser, base.url, { width: 1280, height: 720 });
    const p2 = await openAt(browser, hd.url, { width: 1280, height: 720 });
    const [a] = await rects(p1, ".message");
    const [b] = await rects(p2, ".message");
    // 同じ大きさのウィンドウで同じ見え方（1920×1080 の舞台は 2/3 に縮めて出す）
    for (const k of ["left", "top", "width", "height"] as const) expect(Math.abs(a![k] - b![k]), k).toBeLessThan(1);
    const screen = await p2.evaluate(`(() => { const e = document.querySelector(".stage"); return [e.offsetWidth, e.offsetHeight]; })()`);
    expect(screen).toEqual([1920, 1080]);
    await p1.close();
    await p2.close();

    const four = await start({ width: 1024, height: 768 });
    const p3 = await openAt(browser, four.url, { width: 1024, height: 768 });
    expectInside(await rects(p3, ".message, .message .text .ch"), { width: 1024, height: 768 }, "4:3 の本文");
    await openScreen(p3, "save");
    expectInside(await rects(p3, ".lm-screen, .lm-screen button"), { width: 1024, height: 768 }, "4:3 のセーブ");
    await p3.close();

    const tall = await start({ width: 1080, height: 1920 });
    const p4 = await openAt(browser, tall.url, { width: 1080, height: 1920 });
    const [m] = await rects(p4, ".message");
    expect(m).toMatchObject({ left: 36, right: 1080 - 36, bottom: 1920 - 96 });
    await openScreen(p4, "config");
    expectInside(await rects(p4, ".lm-screen, .lm-screen button"), { width: 1080, height: 1920 }, "1080×1920 の設定");
    await p4.close();
  });
});
