import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { join, resolve } from "node:path";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

const TEMPLATE_BG = resolve(import.meta.dirname, "../../../../templates/default/assets/bgimage");

/**
 * 標準のシステム画面の上で、作品が見た目と演出だけを差し替える口（作品の独自システムを使わずに済ませるためのもの）。
 * - screens.menuBar・confirm・menu、texts、splash、onEvent（start・load-start・title）、status・onStatusChange
 * - ui.input.rightClick: "hide"、ui.settings（設定の幅）、@title-screen、importData・systemVariables
 */

const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
window.__log = [];
export default defineWebPlugin({ name: "t",
  splash: async () => { window.__log.push("splash"); },
  texts: { "confirm.title": "戻りますか（作品の文言）" },
  screens: {
    menuBar: (api) => {
      const bar = document.createElement("div");
      bar.id = "mybar";
      for (const a of api.items) {
        const b = document.createElement("button");
        b.dataset.a = a;
        b.textContent = api.label(a);
        b.onclick = () => api.perform(a);
        bar.append(b);
      }
      // 作った直後に様子を読める
      bar.dataset.mode = api.status.mode;
      api.onStatusChange((s) => bar.dataset.skip = String(s.skip));
      return bar;
    },
    confirm: (api) => {
      const box = document.createElement("div");
      box.id = "myconfirm";
      box.dataset.kind = api.kind;
      box.textContent = api.message;
      const yes = document.createElement("button"); yes.id = "myyes"; yes.onclick = () => api.answer(true);
      box.append(yes);
      return box;
    },
  },
  ready: ({ system }) => {
    window.__sys = system;
    system.onEvent(async (e) => {
      window.__log.push(e.type + (e.name ? ":" + e.name : "") + (e.from && e.type === "load-start" ? ":" + e.from : ""));
      if (e.type === "start") e.runtime.state.temp.started = true;
    });
  },
});`;

const SCENARIO = `@window show
一ページ目。
二ページ目。
@title-screen ending="BAD END"
`;

describe.skipIf(!e2e)("標準のシステム画面の差し替えの口（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO, b: "@window hide\n@wait 60s\n", c: "@bg stills/one.png\n@window show\n見た。\n" },
      plugin: PLUGIN,
      files: { "assets/bgimage/stills/one.png": join(TEMPLATE_BG, "hill_night.webp") },
      config: { titleScreen: true, entry: "a", extra: { cgAuto: { folder: "stills" } }, ui: { input: { rightClick: "hide" }, settings: { textSpeedMin: 5, textSpeedMax: 100, textSpeedStep: 1, autoWaitMin: 300, autoPerChar: 30 } } },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const log = (p: Page) => p.evaluate("window.__log") as Promise<string[]>;

  it("起動の演出 → タイトル → はじめから（start で変数）→ 作品の帯 → 右クリックで枠を隠す → 作品の確かめ → @title-screen でタイトルへ", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-title-button");
      expect((await log(p)).slice(0, 2), name).toEqual(["splash", "title"]);
      await p.locator(".lm-title-button").first().click();
      await p.waitForSelector(".message .text .ch");
      expect(await p.evaluate("window.__sys.runtime.state.temp.started"), name).toBe(true);
      // 作品の帯: 標準の帯は置かず、メッセージ枠が出ていれば見せる
      expect(await p.evaluate(`[!!document.querySelector(".lm-menubar"), document.getElementById("mybar").hidden]`), name).toEqual([false, false]);
      expect(await p.evaluate("window.__sys.status.menuBar"), name).toBe(true);
      // 右クリックは枠を隠す（ui.input.rightClick: hide）。帯も隠れる
      await p.mouse.click(640, 360, { button: "right" });
      await p.waitForTimeout(150);
      expect(await p.evaluate(`[window.__sys.status.hidden, document.getElementById("mybar").hidden]`), name).toEqual([true, true]);
      await p.mouse.click(640, 360, { button: "right" });
      // 設定の幅（ui.settings）
      expect(await p.evaluate("window.__sys.updateSettings({ textSpeed: 100, autoWait: 300 })"), name).toMatchObject({ textSpeed: 100, autoWait: 300 });
      // タイトルへ: 作品の確かめに、作品の文言で
      await p.click('#mybar [data-a="title"]');
      await p.waitForSelector("#myconfirm");
      expect(await p.evaluate(`[document.getElementById("myconfirm").dataset.kind, document.getElementById("myconfirm").textContent]`), name).toEqual(["title", "戻りますか（作品の文言）"]);
      await p.click("#myyes");
      await p.waitForSelector(".lm-title-button");
      // もう一度はじめから進め、@title-screen でタイトルへ戻る（結末の名前を出したところで押す）
      await p.locator(".lm-title-button").first().click();
      await p.waitForSelector(".message .text .ch");
      for (let i = 0; i < 4 && (await p.locator(".lm-ending").count()) === 0; i++) {
        await p.mouse.click(640, 400);
        await p.waitForTimeout(250);
      }
      await p.waitForSelector(".lm-ending", { timeout: 10_000 });
      await p.mouse.click(640, 400);
      await p.waitForSelector(".lm-title-button", { timeout: 10_000 });
      await p.close();
    }
  });

  it("枠が出ていないときの右クリックは何も隠さない（次のクリックを枠の復帰に取られない）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=b`);
      await p.waitForFunction("window.__sys?.status.mode === 'game' && !window.__sys.status.window");
      await p.mouse.click(640, 360, { button: "right" });
      await p.waitForTimeout(150);
      expect(await p.evaluate("window.__sys.status.hidden"), name).toBe(false);
      await p.close();
    }
  });

  it("CG の自動の登録（extra.cgAuto）: シナリオが出すフォルダの画像が一覧に入り、@bg で解放される", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=c`);
      await p.waitForSelector(".message .text .ch");
      expect(await p.evaluate(`window.__sys.systemVariables.cg_unlocked?.["stills/one.png"]`), name).toBe(true);
      await p.close();
    }
  });

  it("引き継ぎ（importData）でスロットと共通の変数を書き、ロードで load-start が来る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      const failed = await p.evaluate(`(() => {
        const save = window.__sys.runtime.save();
        return window.__sys.importData({ slots: [{ slot: 4, save, title: "引き継いだ" }], system: { cg_unlocked: { "a.png": true } }, read: { a: [2] } });
      })()`);
      expect(failed, name).toBe(0);
      expect(await p.evaluate(`[window.__sys.slot(4).title, window.__sys.systemVariables.cg_unlocked["a.png"]]`), name).toEqual(["引き継いだ", true]);
      await p.evaluate("window.__sys.loadFrom(4)");
      await p.waitForTimeout(500);
      expect(await log(p), name).toContain("load-start:slot");
      await p.close();
    }
  });
});
