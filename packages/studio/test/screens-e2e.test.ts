import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { openGameSection } from "./game-section.ts";

/**
 * 制作画面の操作を、lim studio を立てて Chromium で確かめる（三回目の洗い出しの不具合を止めるもの）。
 * - ブロック表示: その場の編集の Home と End、検索の欄の Esc、置換して次へ
 * - ゲームの設定: 配置の編集の数の欄と画面の外、エンディングの名前の欄と見本、差し替えた画面の札
 * - キャラクター: プラグインの無い Live2D を選んでも cast.json に書かない
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

/** 選択肢を差し替えるだけのプラグイン（差し替えた画面の札を確かめる）。 */
const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "look",
  screens: {
    choice: (api) => {
      const el = document.createElement("div");
      for (const o of api.options) {
        const b = document.createElement("button");
        b.textContent = o.text;
        b.onclick = () => api.choose(o.index);
        el.append(b);
      }
      return el;
    },
  },
});
`;

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("制作画面の操作（lim studio）", { timeout: 240_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
  const showView = (id: string) => page.evaluate((v) => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView(v), id);
  const view = (id: string): Locator => page.locator(`.view-surface[data-view="${id}"]`);
  const readJson = (path: string) => JSON.parse(readFileSync(join(dir, path), "utf8")) as Record<string, unknown>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-studio-screens-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    const plugin = join(dir, "plugins", "look");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "look", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(plugin, "src", "web.ts"), PLUGIN);
    const cfg = readJson("liminalia.json");
    cfg.plugins = ["./plugins/look"];
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify(cfg, null, 2)}\n`);
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

  describe("ブロック表示", () => {
    /** 地の文の行を押してその場の編集を始める。 */
    const startEditing = async (line: number) => {
      await showView("desk");
      await app(`await s.open("start", ${line}); s.debug.setBlockMode(true)`);
      const target = page.locator(`.blk-text[data-edit-line="${line}"]`);
      await target.waitFor();
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await page.waitForTimeout(200);
      await target.click();
      await page.waitForFunction(() => document.querySelector(".blk-list")?.getAttribute("contenteditable") === "plaintext-only");
    };
    const caret = () =>
      page.evaluate(() => {
        const sel = getSelection()!;
        const list = document.querySelector(".blk-list")!;
        return { off: sel.focusOffset, len: sel.focusNode?.textContent?.length ?? -1, scroll: list.parentElement!.scrollTop };
      });

    it("その場の編集で Home と End は、一覧を動かさずにカーソルを行の頭と終わりへ動かす", async () => {
      await startEditing(39);
      const start = await caret();
      await page.keyboard.press("End");
      const end = await caret();
      expect(end.off).toBe(end.len);
      expect(Math.abs(end.scroll - start.scroll)).toBeLessThan(40);
      await page.keyboard.press("Home");
      const home = await caret();
      expect(home.off).toBe(0);
      expect(Math.abs(home.scroll - start.scroll)).toBeLessThan(40);
      // 打った字はカーソルの所に入る
      await page.keyboard.type("前");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Z").catch(() => undefined);
    });

    it("検索の欄でボタンに入力があっても、Esc で閉じる", async () => {
      await showView("desk");
      await app(`await s.open("start", 1); s.debug.setBlockMode(true)`);
      await page.locator(".blk-list").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+f");
      await page.locator(".blk-find:not([hidden])").waitFor();
      await page.locator(".blk-find-toggle").click();
      await page.locator(".blk-find-action").first().focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(".blk-find").isHidden()).toBe(true);
    });

    it("置き換える文字に探す文字が入っていても、置換して次へで同じ所を繰り返さない", async () => {
      await showView("desk");
      await app(`await s.open("start", 1); s.debug.setBlockMode(true)`);
      const before = await app<string>("return ed.text()");
      await page.locator(".blk-list").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+f");
      await page.locator(".blk-find-input").first().fill("天文台");
      await expect.poll(() => page.locator(".blk-find-count").textContent()).toMatch(/^1 \/ \d+$/);
      const total = Number(((await page.locator(".blk-find-count").textContent()) ?? "").split("/")[1]);
      await page.locator(".blk-find-row:not([hidden]) .blk-find-input").nth(1).fill("天文台の跡");
      for (let i = 0; i < 3; i++) {
        await page.locator(".blk-find-action").first().click();
        await expect.poll(() => page.locator(".blk-find-count").textContent()).toBe(`${i + 2} / ${total}`);
      }
      const text = await app<string>("return ed.text()");
      expect(text).not.toContain("の跡の跡");
      expect(text.split("天文台の跡").length - 1).toBe(3);
      await page.keyboard.press("Escape");
      // 元に戻す
      await app(`ed.replaceAll(${JSON.stringify(before)})`);
    });
  });

  describe("ゲームの設定", () => {
    const game = () => view("game");
    const frameBox = async () => (await game().locator(".game-frame").boundingBox())!;

    it("配置の編集を始めても、選んでも、プレビューの大きさは変わらず、選ぶまで空の数の欄を出さない", async () => {
      await showView("game");
      await game().locator(".game-layout-toggle").waitFor();
      await page.waitForTimeout(800);
      const before = await frameBox();
      await game().locator(".game-layout-toggle").click();
      await game().locator('.layout-box[data-kind="message"]').waitFor({ timeout: 30_000 });
      expect(await frameBox()).toEqual(before);
      expect(await game().locator(".game-layout-fields").isVisible()).toBe(false);
      await game().locator('.layout-box[data-kind="message"]').click();
      await game().locator(".game-layout-name").waitFor();
      expect(await frameBox()).toEqual(before);
    });

    it("配置の編集でメッセージウィンドウを画面の外まで引けない。数を入れて外へ出したら知らせる", async () => {
      const box = game().locator('.layout-box[data-kind="message"]');
      const b = (await box.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 100, { steps: 5 });
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 500, { steps: 5 });
      await page.mouse.up();
      await expect.poll(() => (readJson("liminalia.json").ui as { message?: { y?: number } } | undefined)?.message?.y, { timeout: 10_000 }).toBeTypeOf("number");
      const message = (readJson("liminalia.json").ui as { message: { y: number; height: number } }).message;
      expect(message.y + message.height).toBeLessThanOrEqual(720);
      expect(await box.evaluate((e) => e.classList.contains("is-outside"))).toBe(false);
      // 数の欄で画面の外へ出したら、枠を赤くして知らせる
      const y = game().locator('.game-layout-fields input[data-key="y"]');
      await y.fill("821");
      await y.press("Enter");
      await expect.poll(() => box.evaluate((e) => e.classList.contains("is-outside")), { timeout: 10_000 }).toBe(true);
      expect(await game().locator(".game-layout-outside").textContent()).toBe("画面の外です");
      await game().locator(".game-layout-toggle").click();
    });

    it("エンディングの名前の欄があり、エンディングの見本に効く", async () => {
      await showView("game");
      const section = await openGameSection(game(), "ending");
      await game().locator(".game-bar .seg", { hasText: "エンディング" }).click();
      const frame = page.frameLocator('.view-surface[data-view="game"] .game-frame');
      await frame.locator(".lm-ending").waitFor({ timeout: 30_000 });
      const size = section.locator('[data-field="ending.size"] input');
      await size.fill("64");
      await size.evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(() => (readJson("liminalia.json").ui as { ending?: { size?: number } }).ending?.size, { timeout: 20_000 }).toBe(64);
      await expect.poll(() => frame.locator(".lm-ending-name").evaluate((e) => getComputedStyle(e).fontSize), { timeout: 20_000 }).toBe("64px");
    });

    it("章の扉と章末の欄があり、章の扉の見本に効く", async () => {
      await showView("game");
      const section = await openGameSection(game(), "chapter");
      await game().locator(".game-bar .seg", { hasText: "章の扉" }).click();
      const frame = page.frameLocator('.view-surface[data-view="game"] .game-frame');
      await frame.locator(".lim-chapter-title").waitFor({ timeout: 30_000 });
      const size = section.locator('[data-field="chapter.size"] input');
      await size.fill("61");
      await size.evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(() => (readJson("liminalia.json").ui as { chapter?: { size?: number } }).chapter?.size, { timeout: 20_000 }).toBe(61);
      await expect.poll(() => frame.locator(".lim-chapter-title").evaluate((e) => getComputedStyle(e).fontSize), { timeout: 20_000 }).toBe("61px");
    });

    it("NVL の欄があり、NVL の見本に効く。名前を付けた見た目の行に入ると、その見た目の見本を出す", async () => {
      await showView("game");
      const section = await openGameSection(game(), "nvl");
      await game().locator(".game-bar .seg", { hasText: "NVL" }).click();
      const frame = page.frameLocator('.view-surface[data-view="game"] .game-frame');
      await frame.locator(".message.nvl").waitFor({ timeout: 30_000 });
      // 段落を二つ並べる
      await expect.poll(() => frame.locator(".message.nvl .nvl-page").count(), { timeout: 20_000 }).toBe(2);
      const size = section.locator('[data-field="nvl.size"] input');
      await size.fill("33");
      await size.evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(() => (readJson("liminalia.json").ui as { nvl?: { size?: number } }).nvl?.size, { timeout: 20_000 }).toBe(33);
      await expect.poll(() => frame.locator(".message.nvl").evaluate((e) => getComputedStyle(e).fontSize), { timeout: 20_000 }).toBe("33px");
      // 名前を付けた見た目を足し、その行の欄に入ると見本がその見た目になる
      const styles = section.locator('[data-field="nvlStyles"]');
      await styles.locator(".game-list-add").click();
      const row = styles.locator(".game-list-row").last();
      const name = row.locator(".game-sub-field input").first();
      await name.fill("letter");
      await name.press("Tab");
      const color = row.getByLabel("文字色", { exact: true });
      await color.fill("rgb(40, 30, 20)");
      await color.evaluate((e) => (e as HTMLElement).blur());
      await row.getByLabel("段落の頭の話者の名前", { exact: true }).selectOption("false");
      await expect.poll(() => (readJson("liminalia.json").ui as { nvlStyles?: Record<string, unknown> }).nvlStyles?.letter, { timeout: 20_000 }).toEqual({ color: "rgb(40, 30, 20)", names: false });
      await expect.poll(() => frame.locator(".message.nvl").getAttribute("data-nvl-style"), { timeout: 20_000 }).toBe("letter");
      await expect.poll(() => frame.locator(".message.nvl .text").evaluate((e) => getComputedStyle(e).color), { timeout: 20_000 }).toBe("rgb(40, 30, 20)");
      // ふだんの NVL の欄に戻ると、ui.nvl の見た目に戻す
      await size.focus();
      await expect.poll(() => frame.locator(".message.nvl").getAttribute("data-nvl-style"), { timeout: 20_000 }).toBeNull();
    });

    it("プラグインが差し替えた選択肢は、選択肢のまとまりに札を出す", async () => {
      await showView("game");
      await game().locator(".game-bar .seg", { hasText: "選択肢" }).click();
      await expect.poll(() => game().locator('[data-section="choice"] .game-flag').textContent(), { timeout: 30_000 }).toContain("look");
    });
  });

  it("キャラクター: プラグインの無い Live2D を選んでも cast.json に書かず、選びを戻す", async () => {
    await showView("cast");
    const select = view("cast").getByLabel("立ち絵の動き").first();
    await select.waitFor();
    const before = readFileSync(join(dir, "cast.json"), "utf8");
    await select.selectOption("live2d");
    await expect.poll(() => page.locator(".notice").textContent()).toContain("プラグインが入っていません");
    await page.waitForTimeout(800);
    expect(readFileSync(join(dir, "cast.json"), "utf8")).toBe(before);
    expect(await select.inputValue()).toBe("");
  });

  it("キャラクター: 二つの欄を続けて素早く変えても、あとの変更を落とさずに順に書く", async () => {
    await showView("cast");
    const font = view("cast").getByLabel("台詞のフォント", { exact: true }).first();
    const italic = view("cast").getByLabel("台詞を斜体にする", { exact: true }).first();
    await font.waitFor();
    const before = readFileSync(join(dir, "cast.json"), "utf8");
    // 前の保存の終わりを待たずに、二つ目の欄を変える
    const box = await italic.elementHandle();
    await font.evaluate(async (e, b) => {
      const input = e as HTMLInputElement;
      input.value = "serif";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // 一つ目の保存が始まってから（cast.json を書き終える前に）
      await new Promise((r) => setTimeout(r, 0));
      (b as HTMLInputElement).checked = true;
      b!.dispatchEvent(new Event("change", { bubbles: true }));
    }, box);
    const texts = () => Object.values((JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, { text?: { font?: string; italic?: boolean } }> }).cast).map((c) => c.text ?? {});
    await expect.poll(() => texts().some((t) => t.font === "serif" && t.italic === true), { timeout: 20_000 }).toBe(true);
    writeFileSync(join(dir, "cast.json"), before);
  });

  it("ページの例外が出ていない", () => {
    expect(errors).toEqual([]);
  });
});
