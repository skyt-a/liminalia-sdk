import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

/**
 * 制作画面の機能の残り（三回目の洗い出しの S-F1、S-F3、S-F4、S-F5）を、lim studio を立てて Chromium で確かめる。
 * - キャラクターの画面で、Live2D と Spine の差分ごとの表情、モーション、動き、スキン、繰り返しを、モデルから読んだ名前から選べる（S-F1）
 * - ブロック表示の検索に、全体の検索と同じ条件（本文だけ、ひらがなとカタカナ、大文字と小文字、正規表現）があり、全体の検索と共有する（S-F3）
 * - 同じ名前のマクロが二つのファイルにあるとき、名前の変更でどちらを変えるかを選べ、その @define に当たる呼び出しだけを書き換える（S-F4）
 * - 指で使う端末では、配置の編集のハンドルを 44px で押せる（S-F5）
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const TEMPLATE = join(ROOT, "templates/default");
const LIM = join(ROOT, "packages/cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("制作画面の機能の残り（lim studio）", { timeout: 300_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let url: string;
  let page: Page;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];

  const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
  const showView = (id: string) => page.evaluate((v) => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView(v), id);
  const scenario = (file: string) => readFileSync(join(dir, "scenario", `${file}.lim`), "utf8");
  type Cast = { cast: Record<string, { appearances: Record<string, { variants: Record<string, { model?: Record<string, unknown> }> }> }> };
  const castJson = () => JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as Cast;
  const openQuick = async (text: string) => {
    await page.locator(".topbar-search").click();
    await page.locator(".quick-input").fill(text);
  };
  const quickItem = (text: string) => page.locator(".quick-list li", { hasText: text });

  async function open(o: { touch?: boolean } = {}): Promise<Page> {
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 }, ...(o.touch ? { hasTouch: true } : {}) });
    contexts.push(context);
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "1")');
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url);
    await p.waitForSelector(".cm-content", { state: "attached" });
    await p.waitForTimeout(1500);
    return p;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-studio-gaps-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    // ブロック表示の検索の確かめ
    writeFileSync(join(dir, "scenario/find.lim"), "# find\nアカリ「ネコがいる。」\n　ねこの話。\n// ネコのメモ\n　ToggleProbe\n　toggleprobe\n@stop\n");
    // 同じ名前のマクロを二つのファイルに置き、それぞれを呼ぶファイル
    writeFileSync(join(dir, "scenario/parts-a.lim"), "@define mark()\n@wait 1s\n@end\n");
    writeFileSync(join(dir, "scenario/parts-b.lim"), "@define mark()\n@wait 2s\n@end\n");
    writeFileSync(join(dir, "scenario/use-a.lim"), "@use parts-a\n# ua\n@mark\n@stop\n");
    writeFileSync(join(dir, "scenario/use-b.lim"), "@use parts-b\n# ub\n@mark\n@stop\n");
    // Live2D と Spine のモデル（プラグインのテストの作り物）を人物の立ち絵の動きにする
    cpSync(join(ROOT, "plugins/live2d/test/fixtures/model"), join(dir, "assets/fgimage/akari/model"), { recursive: true });
    mkdirSync(join(dir, "assets/fgimage/sou/spine"), { recursive: true });
    cpSync(join(ROOT, "plugins/spine/test/fixtures/model"), join(dir, "assets/fgimage/sou/spine"), { recursive: true });
    const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, { model?: unknown }> };
    cast.cast["アカリ"]!.model = { type: "live2d", src: "akari/model/fake.model3.json" };
    cast.cast["ソウ"]!.model = { type: "spine", src: "sou/spine/fake.json" };
    writeFileSync(join(dir, "cast.json"), `${JSON.stringify(cast, null, 2)}\n`);
    server = spawn(process.execPath, [LIM, "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /Studio: (\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio が終わりました（${code}）\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    page = await open();
  }, 120_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("ブロック表示の検索で、全体の検索と同じ条件を切り替え、全体の検索と共有する（S-F3）", async () => {
    await showView("desk");
    await app(`await s.open("find", 2); s.debug.setBlockMode(true)`);
    await openQuick("このファイル");
    await quickItem("このファイルの中を検索").click();
    const find = page.locator(".blk-find:not([hidden])");
    await find.waitFor();
    const count = find.locator(".blk-find-count");
    await find.locator(".blk-find-input").first().fill("ねこ");
    await expect.poll(() => count.textContent()).toBe("1 / 1");
    const opt = (flag: string) => find.locator(`.blk-find-opt[data-flag="${flag}"]`);
    await opt("kana").click();
    await expect.poll(() => count.textContent()).toMatch(/^\d \/ 3$/);
    expect(await opt("kana").getAttribute("aria-pressed")).toBe("true");
    // 本文だけ: コメントの行を除く
    await opt("body").click();
    await expect.poll(() => count.textContent()).toMatch(/^\d \/ 2$/);
    // 全体の検索の条件にも同じものが入る
    expect(await page.locator('.toc-search-opt[data-flag="kana"]').getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('.toc-search-opt[data-flag="body"]').getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("liminalia.studio.searchOptions"))) ?? "{}")).toEqual({ body: true, kana: true });
    // 正規表現。読めないときは数の欄で知らせる
    await opt("body").click();
    await opt("kana").click();
    await opt("regex").click();
    await find.locator(".blk-find-input").first().fill("ネ(コ|ズミ)");
    await expect.poll(() => count.textContent()).toMatch(/^\d \/ 2$/);
    await find.locator(".blk-find-input").first().fill("ネ(");
    await expect.poll(() => count.textContent()).toBe("正規表現として読めません");
    // 大文字と小文字
    await opt("regex").click();
    await page.keyboard.press("Escape");
    await app(`await s.open("find", 2)`);
    // 全体の検索で切り替えると、ブロック表示の検索にも入る
    await page.locator(".toc-search-open, .toc-search").first().isVisible();
    await page.evaluate(() => (document.querySelector('.toc-search-opt[data-flag="caseSensitive"]') as HTMLButtonElement).click());
    await openQuick("このファイル");
    await quickItem("このファイルの中を検索").click();
    await find.waitFor();
    expect(await opt("caseSensitive").getAttribute("aria-pressed")).toBe("true");
    await opt("caseSensitive").click();
    await page.keyboard.press("Escape");
  });

  it("検索条件の切り替え一回につき、開いている検索欄がそれぞれ一度だけ探し直す", async () => {
    await app('await s.open("find", 2); s.debug.setBlockMode(true); s.findAll(); s.find()');
    const query = "ToggleProbe";
    const projectSearch = page.locator(".toc-search");
    const projectHits = page.locator(".toc-hit");
    const blockSearch = page.locator(".blk-find:not([hidden]) .blk-find-input").first();
    const blockCount = page.locator(".blk-find-count");
    const projectFlag = page.locator('.toc-search-opt[data-flag="caseSensitive"]');
    const blockFlag = page.locator('.blk-find-opt[data-flag="caseSensitive"]');
    await projectSearch.fill(query);
    await blockSearch.fill(query);
    await expect.poll(() => projectHits.count()).toBe(2);
    await expect.poll(() => blockCount.textContent()).toMatch(/^\d \/ 2$/);

    const requests: unknown[] = [];
    const captureSearch = (req: Request) => {
      if (req.method() === "POST" && new URL(req.url()).pathname.endsWith("/search")) requests.push(req.postDataJSON());
    };
    // ブロック表示は通信せず、探すたびに件数を書き直す。
    const countWrites = await blockCount.evaluateHandle((el) => {
      let writes = 0;
      const observer = new MutationObserver((records) => (writes += records.length));
      observer.observe(el, { childList: true });
      return {
        observer,
        get writes() { return writes; },
      };
    });
    page.on("request", captureSearch);
    try {
      await projectFlag.click();
      await expect.poll(() => projectHits.count()).toBe(1);
      expect(await projectHits.first().locator("mark").textContent()).toBe(query);
      expect(await blockCount.textContent()).toBe("1 / 1");
      expect(await blockFlag.getAttribute("aria-pressed")).toBe("true");
      const projectRequests = requests.splice(0);
      const projectCountWrites = await countWrites.evaluate((state) => state.writes);

      await blockFlag.click();
      await expect.poll(() => projectHits.count()).toBe(2);
      expect(await blockCount.textContent()).toMatch(/^\d \/ 2$/);
      expect(await projectFlag.getAttribute("aria-pressed")).toBe("false");
      const blockCountWrites = (await countWrites.evaluate((state) => state.writes)) - projectCountWrites;
      expect({ projectRequests, projectCountWrites, blockRequests: requests, blockCountWrites }).toEqual({
        projectRequests: [{ query, caseSensitive: true }],
        projectCountWrites: 1,
        blockRequests: [{ query }],
        blockCountWrites: 1,
      });
    } finally {
      page.off("request", captureSearch);
      await countWrites.evaluate((state) => state.observer.disconnect());
      await countWrites.dispose();
      await blockSearch.press("Escape");
      await projectSearch.fill("");
      await projectSearch.press("Escape");
    }
  });

  it("同じ名前のマクロが二つあると、名前の変更でどちらの @define かを選び、それを呼ぶファイルだけを書き換える（S-F4）", async () => {
    await showView("desk");
    await app(`await s.open("use-a", 3); s.debug.setBlockMode(false); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(3).from } })`);
    await openQuick("マクロの名前");
    await quickItem("マクロの名前を変更").click();
    const dialog = page.locator("dialog.ask-text");
    await dialog.waitFor();
    const pick = dialog.locator("select");
    // 開いているファイルから呼んだときに当たるもの（@use parts-a）を選んでいる
    expect(await pick.inputValue()).toBe("parts-a");
    expect(await pick.locator("option").allTextContents()).toEqual(["parts-a.lim", "parts-b.lim"]);
    await dialog.locator("input").fill("stamp");
    await dialog.locator("button.primary").click();
    await expect.poll(() => scenario("parts-a"), { timeout: 10_000 }).toContain("@define stamp()");
    expect(scenario("use-a")).toBe("@use parts-a\n# ua\n@stamp\n@stop\n");
    expect(scenario("parts-b")).toContain("@define mark()");
    expect(scenario("use-b")).toBe("@use parts-b\n# ub\n@mark\n@stop\n");
  });

  it("キャラクターの画面で、Live2D と Spine の差分の表情、モーション、動き、スキンをモデルの名前から選べる（S-F1）", async () => {
    await showView("cast");
    const cast = page.locator('.view-surface[data-view="cast"]');
    await cast.locator(".chars-list").getByText("アカリ", { exact: true }).first().click();
    await cast.locator(".chars-variant", { hasText: "smile" }).first().click();
    const model = cast.locator(".chars-model");
    await model.waitFor();
    const expression = model.locator('select[data-key="expression"]');
    await expect.poll(() => expression.locator("option").allTextContents()).toEqual(["差分と同じ名前", "なし", "smile"]);
    const motion = model.locator('select[data-key="motion"]');
    expect(await motion.locator("option").allTextContents()).toEqual(["差分と同じ名前", "なし", "Idle", "surprised"]);
    await expression.selectOption("smile");
    await expect.poll(() => castJson().cast["アカリ"]!.appearances.default!.variants.smile!.model).toEqual({ type: "live2d", expression: "smile" });
    await cast.locator(".chars-model select[data-key='motion']").selectOption({ label: "なし" });
    await expect.poll(() => castJson().cast["アカリ"]!.appearances.default!.variants.smile!.model).toEqual({ type: "live2d", expression: "smile", motion: "" });
    // 差分と同じ名前に戻すと、項目を外す（type だけになれば model ごと外す）
    await cast.locator(".chars-model select[data-key='expression']").selectOption({ label: "差分と同じ名前" });
    await expect.poll(() => castJson().cast["アカリ"]!.appearances.default!.variants.smile!.model).toEqual({ type: "live2d", motion: "" });
    await cast.locator(".chars-model select[data-key='motion']").selectOption({ label: "差分と同じ名前" });
    await expect.poll(() => castJson().cast["アカリ"]!.appearances.default!.variants.smile!.model).toBeUndefined();

    await cast.locator(".chars-list").getByText("ソウ", { exact: true }).first().click();
    await cast.locator(".chars-variant", { hasText: "surprised" }).first().click();
    await model.waitFor();
    const animation = model.locator('select[data-key="animation"]');
    await expect.poll(() => animation.locator("option").allTextContents()).toEqual(["差分と同じ名前", "なし", "idle", "smile", "mouth", "blink"]);
    expect(await model.locator('select[data-key="skin"] option').allTextContents()).toEqual(["差分と同じ名前", "default", "winter"]);
    await animation.selectOption("smile");
    await expect.poll(() => castJson().cast["ソウ"]!.appearances.default!.variants.surprised!.model).toEqual({ type: "spine", animation: "smile" });
    await cast.locator(".chars-model select[data-key='skin']").selectOption("winter");
    await cast.locator(".chars-model input[data-key='loop']").uncheck();
    await expect.poll(() => castJson().cast["ソウ"]!.appearances.default!.variants.surprised!.model).toEqual({ type: "spine", animation: "smile", skin: "winter", loop: false });
  });

  it("指で使う端末では、配置の編集のハンドルの押せる所が 44px ある（S-F5）", async () => {
    const touch = await open({ touch: true });
    expect(await touch.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await touch.evaluate(() => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView("game"));
    await touch.locator(".game-layout-toggle").click();
    const box = touch.locator('.layout-box[data-id="message"]');
    await box.waitFor({ timeout: 30_000 });
    await box.focus();
    const handle = touch.locator(".layout-handles .layout-handle.is-se");
    await handle.waitFor();
    const b = (await handle.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    // マウスの端末では今までどおり（20px）
    await showView("game");
    await page.locator(".game-layout-toggle").click();
    await page.locator('.layout-box[data-id="message"]').waitFor({ timeout: 30_000 });
    await page.locator('.layout-box[data-id="message"]').focus();
    expect((await page.locator(".layout-handles .layout-handle.is-se").boundingBox())!.width).toBe(20);
    await page.locator(".game-layout-toggle").click();
  });

  it("ページの例外が出ていない", () => {
    expect(errors).toEqual([]);
  });
});
