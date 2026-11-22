import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * プラグインで画面を作る口（すべての画面の onClose と leave、ConfigScreenApi の defaults と reset、SaveLoadScreenApi の latestSlot・
 * pageSize・chapterId、ExtraScreenApi の onKey と chapters、BacklogScreenApi の asset、操作の fullscreen、system.theme）を、実際のブラウザで確かめる。
 */

const PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
const log = (window.__t = { closed: [], left: [], keys: [], api: {} });
const frame = (name, api, text) => {
  const el = document.createElement("div");
  el.className = "t-screen t-" + name;
  el.textContent = text;
  const close = document.createElement("button");
  close.className = "t-close";
  close.textContent = "close";
  close.onclick = () => api.close();
  el.append(close);
  api.onClose(() => log.closed.push(name));
  api.leave = (node) => {
    log.left.push(name + ":" + node.isConnected);
    return new Promise((r) => setTimeout(r, 300));
  };
  return el;
};
export default defineWebPlugin({
  name: "t",
  ready({ system }) { window.__system = system; },
  screens: {
    config(api) {
      log.api.config = { textSpeed: api.defaults.textSpeed };
      const el = frame("config", api, "config");
      const reset = document.createElement("button");
      reset.className = "t-reset";
      reset.onclick = () => (log.api.reset = api.reset().textSpeed);
      el.append(reset);
      return el;
    },
    saveload(api) {
      log.api.saveload = { latest: api.latestSlot, pageSize: api.pageSize, chapterId: api.chapterId, slot1: api.system.slot(1).chapterId ?? null };
      return frame("saveload", api, "saves");
    },
    backlog(api) {
      log.api.backlog = { asset: api.asset("image", "icon.png") };
      return frame("backlog", api, "log");
    },
    extra(api) {
      log.api.extra = { chapters: api.chapters.map((c) => c.id) };
      api.onKey((key) => {
        log.keys.push(key);
        return key === "ArrowRight";
      });
      return frame("extra", api, "extra");
    },
  },
});
`;

const SCENARIO = `@bg hill_dusk.webp
一ページ目。
二ページ目。
三ページ目。
@stop
`;

describe.skipIf(!e2e)("プラグインで画面を作る口（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO },
      plugin: PLUGIN,
      config: {
        entry: "a",
        chapters: [{ id: "c1", title: "第一章", files: ["a"] }],
        ui: { defaults: { textSpeed: 12 }, system: { preset: "night" }, menuBar: { items: ["save", "fullscreen"] } },
        extra: { cg: [] },
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const t = (p: Page) => p.evaluate("window.__t") as Promise<{ closed: string[]; left: string[]; keys: string[]; api: Record<string, Record<string, unknown>> }>;
  const perform = (p: Page, action: string) => p.evaluate(`window.__liminalia.host.context.system.perform(${JSON.stringify(action)})`);

  it("閉じる演出（leave）を待ってから外し、onClose を呼ぶ。設定の既定値と初期設定に戻す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      expect(await p.evaluate("window.__liminalia.host.context.system.theme"), name).toBe("night");
      await perform(p, "config");
      await p.waitForSelector(".t-config");
      expect((await t(p)).api.config, name).toEqual({ textSpeed: 12 });
      await p.evaluate("window.__system.updateSettings({ textSpeed: 40 })");
      await p.click(".t-reset");
      expect((await t(p)).api.reset, name).toBe(12);
      await p.click(".t-close");
      // 閉じたらすぐ onClose。要素は演出の間だけ残り、押せない
      await p.waitForTimeout(80);
      const mid = await t(p);
      expect(mid.closed, name).toEqual(["config"]);
      expect(mid.left, name).toEqual(["config:true"]);
      expect(await p.evaluate("[!!document.querySelector('.t-config'), document.querySelector('.t-config')?.inert]"), name).toEqual([true, true]);
      expect(await p.evaluate("window.__liminalia.screen().screen"), name).toBeNull();
      await p.waitForFunction(() => !document.querySelector(".t-config"), undefined, { timeout: 5000 });
      await p.close();
    }
  });

  it("セーブの画面にいちばん新しいセーブ・一ページの枠の数・章、履歴に素材の URL、おまけにキーと章を渡す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await perform(p, "save");
      await p.waitForSelector(".t-saveload");
      expect((await t(p)).api.saveload, name).toEqual({ latest: 1, pageSize: 8, chapterId: "c1", slot1: "c1" });
      await p.click(".t-saveload .t-close");
      await p.waitForFunction(() => !document.querySelector(".t-saveload"), undefined, { timeout: 5000 });
      await perform(p, "backlog");
      await p.waitForSelector(".t-backlog");
      expect(String((await t(p)).api.backlog!.asset), name).toContain("icon.png");
      await p.click(".t-backlog .t-close");
      await p.waitForFunction(() => !document.querySelector(".t-backlog"), undefined, { timeout: 5000 });
      // タイトルからおまけを開く
      await p.evaluate("window.__system.showTitle(true)");
      await p.evaluate("void window.__liminalia.system.openScreenByName('extra')");
      await p.waitForSelector(".t-extra");
      expect((await t(p)).api.extra, name).toEqual({ chapters: ["c1"] });
      await p.keyboard.press("ArrowRight");
      await p.keyboard.press("ArrowLeft");
      expect((await t(p)).keys, name).toEqual(["ArrowRight", "ArrowLeft"]);
      await p.close();
    }
  });

  it("操作の fullscreen を帯に置き、押すと全画面の設定を切り替える", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      expect(await p.locator('.lm-menubar [data-action="fullscreen"]').count(), name).toBe(1);
      const before = await p.evaluate("window.__system.settings.fullscreen");
      await perform(p, "fullscreen");
      await p.waitForTimeout(300);
      const after = await p.evaluate("window.__system.settings.fullscreen");
      // 全画面にできない環境（ヘッドレスなど）では何もしない
      const supported = await p.evaluate("document.fullscreenEnabled === true");
      if (supported) expect(after, name).toBe(!before);
      await p.close();
    }
  });
});
