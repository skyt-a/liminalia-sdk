import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { openGameSection } from "./game-section.ts";

/**
 * 制作画面の使い勝手（三回目の洗い出しの残り）を、lim studio を立てて Chromium で確かめる。
 * - 初めて開いたとき: 「はじめから」の最初のページにカーソルを置き、頭のコメントの行は一つにまとめる（S-U5）
 * - ⌘K とファイルのメニューから、ブロック表示のファイルの中の検索と置換を開く（S-U3）。見つからないときは全体の検索へ渡す（S-U9）
 * - F6 で欄を移り、シーン一覧は一つの Tab で入って矢印で動く（S-U4）
 * - シーンの印などの共有するデータを Git に入る置き場に書き、前の .gitignore なら直すかを尋ねる（S-U1）
 * - 衝突の合わせ直しで、手で書いた中身にできる（S-U8）
 * - 翻訳のタブの数を、シナリオとシステム画面で分ける（S-U10）
 * - 「この種類を出さない」を、お知らせの「元に戻す」で戻せる（S-U11）
 * - ゲームの設定の文字の影、縁、字間を、色、太さ、ずれの欄で直せる（R2-7）
 * - 長い作品のシーン一覧で、ファイル名を区別の付く所で切る（R2-6）
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("制作画面の使い勝手（lim studio）", { timeout: 300_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
  const showView = (id: string) => page.evaluate((v) => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView(v), id);
  const view = (id: string): Locator => page.locator(`.view-surface[data-view="${id}"]`);
  const readJson = (path: string) => JSON.parse(readFileSync(join(dir, path), "utf8")) as Record<string, unknown>;
  const readText = (path: string) => {
    try {
      return readFileSync(join(dir, path), "utf8");
    } catch {
      // 無ければ空
      return "";
    }
  };
  /** 「はじめから」の最初のページ（ひな形の start.lim の最初の地の文の行）。 */
  const firstPage = () => readFileSync(join(TEMPLATE, "scenario/start.lim"), "utf8").split("\n").findIndex((l) => l.startsWith("　")) + 1;
  /** 今の入力のある欄（.toc、.script、.right、.film、.topbar）。 */
  const focusedPane = () => page.evaluate(() => document.activeElement?.closest(".toc, .script, .right, .film, .topbar")?.className.split(" ")[0] ?? null);
  const openQuick = async (text: string) => {
    await page.locator(".topbar-search").click();
    await page.locator(".quick-input").fill(text);
  };
  const quickItem = (text: string) => page.locator(".quick-list li", { hasText: text });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-studio-ux-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    // 前の版のひな形の .gitignore（.liminalia/ をフォルダごと外す）
    rmSync(join(dir, "gitignore"));
    writeFileSync(join(dir, ".gitignore"), ".liminalia/\nexports/\ndist/\nnode_modules/\n");
    // 警告の出る行（「この種類を出さない」の確かめ）と、頭の同じファイルの並び（ファイル名の切り方の確かめ）
    writeFileSync(join(dir, "scenario/warn.lim"), "# warn\nナゾ「こんにちは」\n@stop\n");
    for (const name of ["episode1_1", "episode1_2", "episode10_1", "episode2_2"]) writeFileSync(join(dir, `scenario/${name}.lim`), `# ${name}\n　${name} の本文。\n@stop\n`);
    const background = readFileSync(join(dir, "assets/bgimage/hill_morning.webp"));
    for (let i = 0; i < 81; i++) writeFileSync(join(dir, `assets/bgimage/filter-probe-${i}.webp`), background);
    // 訳す言語（翻訳のタブ。韓国語はシステム画面の文言も並ぶ）
    const cfg = readJson("liminalia.json");
    cfg.languages = ["ja", "ko"];
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    // 訳す欄のある作品のデータ（図鑑。翻訳のタブにデータの文も並ぶ）
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "codex.json"), JSON.stringify({ categories: [{ id: "people", label: "人物" }], entries: [{ id: "a", category: "people", title: "アカリ", summary: "丘の上に住む。" }] }));
    server = spawn(process.execPath, [LIM, "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /Studio: (\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio が終わりました（${code}）\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "1")');
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(1500);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("コメントの読み込み中に解決済みに切り替えても、未解決のスレッドは出ない", async () => {
    await app('await s.reviewAct({ kind: "create", file: "warn", line: 2, text: "ナゾ「こんにちは」", body: "読み込み待ちのコメント" })');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const pattern = "**/file?file=warn";
    await page.route(pattern, async (route) => {
      started();
      await pending;
      await route.continue();
    });
    const reviews = view("reviews");
    try {
      await showView("reviews");
      await requested;
      await reviews.getByRole("button", { name: "解決済み0", exact: true }).click();
      expect(await reviews.locator(".reviews-empty").textContent()).toBe("当てはまるコメントはありません");
      const response = page.waitForResponse((r) => r.url().endsWith("/file?file=warn"));
      release();
      await (await response).finished();
      await expect.poll(() => app<boolean>('return s.reviewTexts.has("warn")')).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await reviews.locator(".review-thread").count()).toBe(0);
      expect(await reviews.locator(".reviews-empty").textContent()).toBe("当てはまるコメントはありません");
      await reviews.getByRole("button", { name: "未解決1", exact: true }).click();
      await expect.poll(() => reviews.locator(".review-thread").count()).toBe(1);
      expect(await reviews.locator(".review-thread").textContent()).toContain("読み込み待ちのコメント");
    } finally {
      release();
      await page.unroute(pattern);
      await app('const t = s.reviewList.threads.find(t => t.file === "warn"); if (t) await s.reviewAct({ kind: "delete", id: t.id, comment: t.comments[0].id })');
      await showView("desk");
    }
  });

  it("初めて開いたとき、カーソルは「はじめから」の最初のページにあり、プレビューに絵が出て、頭のコメントの行は一つにまとまる", async () => {
    await expect.poll(() => app<number>("return ed.cursorLine()"), { timeout: 10_000 }).toBe(firstPage());
    await expect.poll(() => page.locator(".stage-empty").isHidden(), { timeout: 30_000 }).toBe(true);
    // 頭のコメント（ひな形は 13 行）は一つの札。押すと広がる
    const head = page.locator('.blk-line-row.blk-comment[data-from="1"]');
    await head.waitFor();
    expect(await head.getAttribute("data-to")).toBe("13");
    expect(await page.locator('.blk-line-row.blk-comment[data-from="2"]').count()).toBe(0);
    await head.locator(".blk-comment-more").click();
    await expect.poll(() => head.textContent()).toContain("コマンドリファレンス");
  });

  it("ファイルのタブは矢印で選び、閉じられないときは元のタブに留まる", async () => {
    await app(`
      const Tabs = s.fileTabs.constructor;
      let files = ["a", "b", "c"], current = "a";
      const state = window.tabTest = { blocked: false, opened: [], closed: [] };
      const tabs = new Tabs({
        open: async (file) => {
          state.opened.push(file);
          if (state.blocked) return;
          current = file;
          tabs.render(files, current);
        },
        close: async (file) => {
          state.closed.push(file);
          if (state.blocked) return;
          const at = files.indexOf(file);
          files = files.filter(f => f !== file);
          current = files[at] ?? files[at - 1] ?? null;
          tabs.render(files, current);
        },
        menu: () => {},
        error: () => {},
        focus: () => ed.view.focus(),
      });
      tabs.el.id = "tab-test";
      document.body.append(tabs.el);
      tabs.render([], null);
      state.empty = tabs.el.hidden && tabs.el.childElementCount === 0;
      tabs.render(files, current);
    `);
    const tabs = page.locator("#tab-test");
    const selected = () => tabs.locator('[aria-selected="true"]');
    const check = async (file: string) => {
      await expect.poll(() => selected().getAttribute("data-file")).toBe(file);
      expect(await selected().getAttribute("tabindex")).toBe("0");
      expect(await tabs.locator('[tabindex="0"]').count()).toBe(1);
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-file"))).toBe(file);
    };
    try {
      expect(await app<boolean>("return window.tabTest.empty")).toBe(true);
      expect(await tabs.getAttribute("role")).toBe("tablist");
      await selected().focus();
      for (const [key, file] of [["ArrowLeft", "c"], ["ArrowRight", "a"], ["End", "c"], ["Home", "a"], ["ArrowRight", "b"], ["Enter", "b"], ["Space", "b"]]) {
        await page.keyboard.press(key!);
        await check(file!);
      }
      await page.keyboard.press("Control+ArrowRight");
      await check("b");
      await app("window.tabTest.blocked = true");
      await page.keyboard.press("ArrowRight");
      await check("b");
      await page.keyboard.press("Delete");
      await check("b");
      expect(await tabs.locator('[role="tab"]').count()).toBe(3);
      await app("window.tabTest.blocked = false");
      await page.keyboard.press("Delete");
      await check("c");
      expect(await tabs.locator('[role="tab"]').count()).toBe(2);
      await page.keyboard.press("Delete");
      await expect.poll(() => tabs.isHidden()).toBe(true);
      expect(await tabs.locator('[role="tab"]').count()).toBe(0);
      expect(await app<string[]>("return window.tabTest.closed")).toEqual(["b", "b", "c"]);
      const opened = await app<string[]>("return window.tabTest.opened");
      await page.locator(".cm-content").focus();
      await page.keyboard.press("ArrowRight");
      expect(await app<string[]>("return window.tabTest.opened")).toEqual(opened);
    } finally {
      await tabs.evaluate((el) => el.remove());
    }
  });

  it.each(["open", "close", "hidden"])("ファイルのタブの失敗と非表示でも入力先を失わない（%s）", async (mode) => {
    const pageErrors: string[] = [];
    const onError = (e: Error) => pageErrors.push(e.message);
    page.on("pageerror", onError);
    await app(`
      const Tabs = s.fileTabs.constructor;
      const state = window.tabFailureTest = { errors: [], unhandled: [], calls: 0 };
      state.listener = e => state.unhandled.push(String(e.reason));
      window.addEventListener("unhandledrejection", state.listener);
      const fallback = document.createElement("textarea");
      fallback.id = "tab-fallback";
      document.body.append(fallback);
      const run = async () => {
        state.calls++;
        tabs.render(${JSON.stringify(mode)} === "hidden" ? ["a"] : ["a", "b"], "a");
        if (${JSON.stringify(mode)} !== "hidden") throw new Error("tab action failed");
      };
      const tabs = new Tabs({
        open: run,
        close: run,
        error: e => state.errors.push(e.message),
        focus: () => fallback.focus(),
        menu: () => {},
      });
      tabs.el.id = "tab-failure-test";
      document.body.append(tabs.el);
      tabs.render(["a", "b"], "a");
    `);
    try {
      await page.locator('#tab-failure-test [data-file="b"]').focus();
      await page.keyboard.press(mode === "open" ? "ArrowLeft" : "Delete");
      await expect.poll(() => app<number>("return window.tabFailureTest.calls")).toBe(1);
      if (mode === "hidden") {
        await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("tab-fallback");
        expect(await page.locator("#tab-failure-test").isHidden()).toBe(true);
      } else {
        await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-file"))).toBe("a");
        expect(await app<string[]>("return window.tabFailureTest.errors")).toEqual(["tab action failed"]);
      }
      expect(await app<string[]>("return window.tabFailureTest.unhandled")).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      page.off("pageerror", onError);
      await app(`
        window.removeEventListener("unhandledrejection", window.tabFailureTest.listener);
        document.getElementById("tab-failure-test").remove();
        document.getElementById("tab-fallback").remove();
      `);
    }
  });

  it("1024px の台本の見出しで短い名前が見え、長い名前は省略される", async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const sidebar = await page.locator(".desk > .splitter-left").boundingBox();
    await page.mouse.move(sidebar!.x + sidebar!.width / 2, sidebar!.y + 30);
    await page.mouse.down();
    await page.mouse.move(264, sidebar!.y + 30);
    await page.mouse.up();
    const original = await page.locator(".ed-title").evaluate((title) => {
      const scene = title.querySelector(".ed-scene")!;
      const where = title.querySelector(".ed-where")!;
      const texts = [scene.textContent, where.textContent];
      scene.textContent = "#start";
      where.textContent = "start.lim 21 行目";
      return texts;
    });
    try {
      const fits = () => page.locator(".ed-title").evaluate((title) => {
        const scene = title.querySelector(".ed-scene")!;
        const where = title.querySelector(".ed-where")!;
        const file = document.createRange();
        file.setStart(where.firstChild!, 0);
        file.setEnd(where.firstChild!, "start.lim".length);
        return scene.scrollWidth <= scene.clientWidth && file.getBoundingClientRect().width <= where.clientWidth;
      });
      await expect.poll(fits).toBe(true);
      expect(await page.locator(".script-tools .seg").first().evaluate((button) => parseFloat(getComputedStyle(button).paddingInlineStart))).toBeGreaterThanOrEqual(8);
      expect(await page.locator(".ed-status").evaluate((status) => {
        const problems = status.querySelector(".ed-problems")!.getBoundingClientRect();
        const save = status.querySelector(".save-status")!.getBoundingClientRect();
        return problems.bottom <= save.top && Math.abs(problems.right - save.right) < 1;
      })).toBe(true);
      await page.locator(".ed-title").evaluate((title) => {
        title.querySelector(".ed-scene")!.textContent = `#${"long_scene_name_".repeat(12)}`;
        title.querySelector(".ed-where")!.textContent = `${"long_file_name_".repeat(12)}.lim 21 行目`;
      });
      await expect.poll(() => page.locator(".ed-scene").evaluate((scene) => scene.scrollWidth > scene.clientWidth && getComputedStyle(scene).textOverflow === "ellipsis")).toBe(true);
      expect(await page.locator(".script-tools").evaluate((tools) => tools.scrollWidth <= tools.clientWidth)).toBe(true);
    } finally {
      await page.locator(".ed-title").evaluate((title, texts) => {
        title.querySelector(".ed-scene")!.textContent = texts[0]!;
        title.querySelector(".ed-where")!.textContent = texts[1]!;
      }, original);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator(".desk > .splitter-left").dblclick();
    }
  });

  it("⌘K とファイルのメニューから、ブロック表示のファイルの中の検索と置換を開ける", async () => {
    await showView("desk");
    await openQuick("このファイル");
    await quickItem("このファイルの中を検索").click();
    await page.locator(".blk-find:not([hidden])").waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".blk-find").isHidden()).toBe(true);
    await openQuick("このファイル");
    await quickItem("このファイルの中を置換").click();
    await page.locator(".blk-find:not([hidden]) .blk-find-row:not([hidden]) .blk-find-action").first().waitFor();
    await page.keyboard.press("Escape");
    // シナリオの見出しのメニュー（指で使う端末でも届く）
    await page.locator(".ed-title").click();
    await page.locator(".ctx-menu .ctx-item", { hasText: "このファイルの中を検索" }).click();
    await page.locator(".blk-find:not([hidden])").waitFor();
    await page.keyboard.press("Escape");
  });

  it("⌘K で見つからないときは、すべてのファイルの検索へ渡せる", async () => {
    await openQuick("百年に一度");
    const all = quickItem("すべてのファイルで検索");
    await all.waitFor();
    expect(await all.textContent()).toContain("百年に一度");
    await all.click();
    await expect.poll(() => page.locator("input.toc-search").inputValue()).toBe("百年に一度");
    await page.locator(".toc-results").getByText("百年に一度").first().waitFor({ timeout: 15_000 });
    // 検索の言葉を消して、シーン一覧に戻す
    await page.locator("input.toc-search").fill("");
    await page.locator(".toc-list").waitFor();
  });

  it("F6 で欄を移り、シーン一覧は一つの Tab で入って矢印で動く", async () => {
    await showView("desk");
    await app(`await s.open("start", ${firstPage()})`);
    await page.locator(".blk-list").click({ position: { x: 5, y: 5 } });
    expect(await focusedPane()).toBe("script");
    await page.keyboard.press("F6");
    await expect.poll(focusedPane).toBe("right");
    await page.keyboard.press("Shift+F6");
    await expect.poll(focusedPane).toBe("script");
    await page.keyboard.press("Shift+F6");
    await expect.poll(focusedPane).toBe("toc");
    // シーン一覧の中で Tab に止まるのは一つだけ
    const stops = await page.locator(".toc-list").evaluate((list) => [...list.querySelectorAll<HTMLElement>("button, [tabindex]")].filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && e.offsetParent !== null).length);
    expect(stops).toBe(1);
    const at = () => page.evaluate(() => (document.activeElement?.closest(".toc-list") ? (document.activeElement as HTMLElement).textContent : null));
    const first = await at();
    expect(first).not.toBeNull();
    await page.keyboard.press("ArrowDown");
    await expect.poll(at).not.toBe(first);
    expect(await at()).not.toBeNull();
    // Tab で一覧を出る
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".toc-list"))).toBe(false);
  });

  it("シーンの印は共有するデータに書き、外で変えた印は画面に出す。前の .gitignore なら記録の対象にするかを尋ねる", async () => {
    await showView("desk");
    // start.lim のシーンを並べる
    const fold = page.locator('.toc-file[data-file="start"] .toc-file-fold');
    if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
    const row = page.locator('.scene-row[data-file="start"]').first();
    await row.click({ button: "right" });
    await page.locator(".ctx-menu .ctx-item", { hasText: "タグと状態を編集" }).click();
    await page.locator('dialog.scene-marks .scene-mark-status .seg[data-value="review"]').click();
    await page.locator("dialog.scene-marks button.primary").click();
    await expect.poll(() => readText(".liminalia/shared.json"), { timeout: 10_000 }).toContain("review");
    expect(readText(".liminalia/studio.json")).not.toContain("sceneMarks");
    // 共同作者の変更を取り込んだときと同じに、外で書き換える
    const shared = readJson(".liminalia/shared.json") as { sceneMarks: Record<string, unknown> };
    shared.sceneMarks["start#night"] = { color: "red" };
    writeFileSync(join(dir, ".liminalia/shared.json"), `${JSON.stringify(shared, null, 2)}\n`);
    await expect.poll(() => page.locator('.scene-row[data-file="start"] .scene-dot.is-mark-red').count(), { timeout: 15_000 }).toBe(1);
  });

  it("翻訳のタブで、シナリオとシステム画面の数を分けて数え、並びも同じ数え方で絞る", async () => {
    await showView("project");
    const project = view("project");
    await project.locator(".segmented button", { hasText: "翻訳" }).click();
    const lang = project.locator(".proj-lang button").first();
    await lang.waitFor();
    const counts = (await lang.textContent()) ?? "";
    const scenario = /シナリオ\s*(\d+)\s*\/\s*(\d+)/.exec(counts);
    const system = /システム画面\s*(\d+)\s*\/\s*(\d+)/.exec(counts);
    expect(scenario, counts).not.toBeNull();
    expect(system, counts).not.toBeNull();
    const pager = () => project.locator(".proj-pager .proj-soft").first().textContent();
    // 未翻訳を、シナリオとシステム画面に分けて並べる
    await project.locator(".proj-kinds .seg", { hasText: "シナリオ" }).click();
    await expect.poll(pager).toMatch(new RegExp(`/ ${Number(scenario![2]) - Number(scenario![1])}$`));
    await project.locator(".proj-kinds .seg", { hasText: "システム画面" }).click();
    await expect.poll(pager).toMatch(new RegExp(`/ ${Number(system![2]) - Number(system![1])}$`));
  });

  it("翻訳のタブに作品のデータの文を、データのファイルと場所を添えて並べ、訳を書ける", async () => {
    await showView("project");
    const project = view("project");
    await project.locator(".segmented button", { hasText: /^翻訳$/ }).click();
    await project.locator(".proj-lang button").first().click();
    await project.locator(".proj-kinds .seg", { hasText: "シナリオ" }).click();
    const search = project.locator(".proj-search");
    await search.fill("丘の上に住む");
    await search.dispatchEvent("input");
    const row = project.locator(".proj-line", { hasText: "丘の上に住む。" });
    await row.waitFor({ timeout: 20_000 });
    expect(await row.locator(".proj-line-head").textContent()).toBe("data/codex.json/entries/0/summary");
    await row.locator("textarea.proj-translation").fill("언덕 위에 산다.");
    const ko = () => {
      const path = join(dir, "lang", "ko.json");
      if (!existsSync(path)) return undefined;
      const lines = (JSON.parse(readFileSync(path, "utf8")) as { lines?: Record<string, { source: string; text: string }> }).lines ?? {};
      return Object.entries(lines).find(([k]) => k.startsWith("data/codex.json:") && lines[k]!.source === "丘の上に住む。")?.[1].text;
    };
    await expect.poll(ko, { timeout: 20_000 }).toBe("언덕 위에 산다.");
  });

  it("「この種類を出さない」のあと、お知らせの「元に戻す」で戻せる", async () => {
    await showView("check");
    const row = page.locator(".check-surface li", { hasText: "ナゾ" }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.click({ button: "right" });
    await page.locator(".ctx-menu .ctx-item", { hasText: "この種類を出さない" }).click();
    const severity = () => (readJson("liminalia.json").check as { severity?: Record<string, string> } | undefined)?.severity?.["unknown-speaker"];
    await expect.poll(severity, { timeout: 10_000 }).toBe("off");
    await page.locator(".notice .notice-action", { hasText: "元に戻す" }).click();
    await expect.poll(severity, { timeout: 10_000 }).toBeUndefined();
  });

  it("ゲームの設定の文字の影、縁、字間を、色、太さ、ずれの欄で直せる", async () => {
    await showView("game");
    const game = view("game");
    await openGameSection(game, "text");
    const shadow = game.locator('[data-field="text.shadow"]');
    await shadow.waitFor();
    const set = async (field: Locator, part: string, value: string) => {
      const input = field.locator(`[data-part="${part}"]`);
      await input.fill(value);
      await input.evaluate((e) => (e as HTMLElement).dispatchEvent(new Event("change", { bubbles: true })));
    };
    const text = () => (readJson("liminalia.json").ui as { text?: Record<string, unknown> } | undefined)?.text ?? {};
    await set(shadow, "x", "1");
    await set(shadow, "y", "2");
    await set(shadow, "blur", "3");
    await set(shadow, "color", "#112233");
    await expect.poll(() => text().shadow, { timeout: 10_000 }).toBe("1px 2px 3px #112233");
    const stroke = game.locator('[data-field="text.stroke"]');
    await set(stroke, "width", "0.5");
    await set(stroke, "color", "#000000");
    await expect.poll(() => text().stroke, { timeout: 10_000 }).toBe("0.5px #000000");
    await set(game.locator('[data-field="text.letterSpacing"]'), "size", "0.05");
    await expect.poll(() => text().letterSpacing, { timeout: 10_000 }).toBe("0.05em");
  });

  it("長い作品のシーン一覧で、ファイル名を区別の付く所で切る", async () => {
    await showView("desk");
    const tail = (file: string) => page.locator(`.toc-file[data-file="${file}"] .trunc-tail`).textContent();
    await page.locator('.toc-file[data-file="episode1_2"]').waitFor();
    expect(await tail("episode1_2")).toBe("1_2.lim");
    expect(await tail("episode10_1")).toBe("10_1.lim");
  });

  it("素材を素早く絞って該当なしになると、外れた一覧は次のフレームを予約しない", async () => {
    await showView("assets");
    await view("assets").locator('[data-path="filter-probe-0.webp"]').waitFor();
    const result = await view("assets").locator(".assets-search").evaluate((search: HTMLInputElement) => {
      const filter = (query: string) => {
        search.value = query;
        search.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const requestFrame = window.requestAnimationFrame;
      const frames: FrameRequestCallback[] = [];
      window.requestAnimationFrame = (callback) => frames.push(callback);
      try {
        filter("filter-probe");
        const sentinel = search.closest(".assets-view")?.querySelector(".lazy-more");
        const pending = frames.splice(0);
        filter("no-such-asset");
        for (const callback of pending) callback(performance.now());
        return { detached: sentinel?.isConnected === false, pending: pending.length, rescheduled: frames.length };
      } finally {
        window.requestAnimationFrame = requestFrame;
      }
    });
    expect(result).toEqual({ detached: true, pending: 1, rescheduled: 0 });
  });

  it("ページの例外が出ていない", () => {
    expect(errors).toEqual([]);
  });
});
