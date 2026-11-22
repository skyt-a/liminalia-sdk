import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * プラグインが内部の DOM に触らずに済む口（RenderContext の world・mask・window・systemLayer・setBackground・toStage・scope・on）と、
 * 画面の切り替えの幕（WebPlugin.transitions）・書体の口（host.fonts）・スクロールバーの部品（ui.scrollbar）を、実際のブラウザで確かめる。
 */

const PLUGIN = `
import { defineWebPlugin, ui } from "@liminalia/web";
const log = (window.__t = { events: [], curtain: [] });
export default defineWebPlugin({
  name: "t",
  setup(host) {
    const ctx = host.context;
    for (const type of ["page", "speaker", "sprites", "restore", "load-end", "menu-close"]) {
      ctx.on(type, (e) => log.events.push(type + ":" + (e.speaker ?? e.from ?? (e.sprites ? Object.keys(e.sprites).join(",") : ""))));
    }
  },
  transitions: {
    load: {
      async cover(ctx, info) {
        log.curtain.push("cover:" + info.from);
        const el = document.createElement("div");
        el.className = "t-curtain";
        ctx.systemLayer.append(el);
        await new Promise((r) => setTimeout(r, 50));
      },
      reveal(ctx, info) {
        log.curtain.push("reveal:" + info.from);
        ctx.systemLayer.querySelector(".t-curtain")?.remove();
      },
    },
    screen(ctx, info) {
      log.curtain.push("screen:" + info.name + ":" + info.open);
    },
  },
});
window.__ui = ui;
`;

const SCENARIO = `@bg hill_dusk.webp
@window show
@chara アカリ normal
アカリ「はじめ」
地の文。
@chara-hide アカリ
ソウ「おわり」
`;

const events = (p: Page) => p.evaluate("window.__t.events.splice(0)") as Promise<string[]>;

describe.skipIf(!e2e)("プラグインの口（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, plugin: PLUGIN });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("ページ・話者・立ち絵の出来事と、組み立て直し・ロードの終わり・ロードの幕・メニューが閉じたこと", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(200);
      const first = await events(p);
      expect(first.filter((e) => !e.startsWith("restore")), name).toEqual(["sprites:アカリ", "page:アカリ", "speaker:アカリ"]);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(200);
      // 地の文: 話者が変わった（null）
      expect(await events(p), name).toEqual(["page:", "speaker:"]);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("おわり") && window.__liminalia!.host.waiting);
      expect(await events(p), name).toEqual(["sprites:", "page:ソウ", "speaker:ソウ"]);
      // セーブしてロードすると、幕を下ろし（待って）、組み立て直して load-end と幕を上げる
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForFunction(() => (window as unknown as { __t: { curtain: string[] } }).__t.curtain.includes("reveal:slot"), undefined, { timeout: 10_000 });
      expect(await p.evaluate("window.__t.curtain.filter((c) => !c.startsWith('screen'))"), name).toEqual(["cover:slot", "reveal:slot"]);
      expect(await p.evaluate("document.querySelector('.t-curtain')"), name).toBeNull();
      const after = await events(p);
      expect(after.indexOf("restore:"), name).toBeLessThan(after.indexOf("load-end:slot"));
      // メニュー（右クリック）を開いて閉じる
      await p.mouse.click(640, 300, { button: "right" });
      await p.waitForFunction(() => window.__liminalia!.system.screen === "menu");
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => window.__liminalia!.system.screen === null);
      expect((await events(p)).includes("menu-close:"), name).toBe(true);
      expect(await p.evaluate("window.__t.curtain.filter((c) => c.startsWith('screen'))"), name).toEqual(["screen:menu:true", "screen:menu:false"]);
      await p.close();
    }
  });

  it("world・mask・window・systemLayer・setBackground・toStage", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const r = (await p.evaluate(`(async () => {
        const ctx = window.__liminalia.host.context;
        const out = {};
        out.world = ctx.world === document.querySelector(".camera").parentElement;
        out.systemLayer = ctx.systemLayer.classList.contains("lm-sys");
        ctx.mask.cover("#123456");
        const mask = document.querySelector(".layer.mask");
        out.masked = [getComputedStyle(mask).opacity, mask.style.background];
        ctx.mask.uncover();
        out.unmasked = getComputedStyle(mask).opacity;
        const message = document.querySelector(".message");
        let during;
        await ctx.window.hideWhile(async () => { during = message.classList.contains("lm-window-held"); });
        out.window = [during, message.classList.contains("lm-window-held"), message.classList.contains("visible")];
        const release = ctx.window.hide();
        const release2 = ctx.window.hide();
        release();
        out.nested = message.classList.contains("lm-window-held");
        release2();
        out.released = message.classList.contains("lm-window-held");
        await ctx.setBackground("hill_night.webp");
        out.background = [...document.querySelectorAll(".background img")].map((i) => i.dataset.bg);
        const rect = ctx.stage.getBoundingClientRect();
        out.toStage = ctx.toStage(rect.left + rect.width / 2, rect.top + rect.height / 4);
        return out;
      })()`)) as Record<string, unknown>;
      expect(r.world, name).toBe(true);
      expect(r.systemLayer, name).toBe(true);
      expect(r.masked, name).toEqual(["1", "rgb(18, 52, 86)"]);
      expect(r.unmasked, name).toBe("0");
      expect(r.window, name).toEqual([true, false, true]);
      expect([r.nested, r.released], name).toEqual([true, false]);
      expect(r.background, name).toEqual(["hill_night.webp"]);
      const at = r.toStage as { x: number; y: number };
      expect([Math.round(at.x), Math.round(at.y)], name).toEqual([640, 180]);
      // ロードで背景は状態どおりに戻る
      await p.evaluate("window.__liminalia.system.loadSave(window.__liminalia.system.runtime.save())");
      await p.waitForTimeout(500);
      expect(await p.evaluate(`[...document.querySelectorAll(".background img")].map((i) => i.dataset.bg)`), name).toEqual(["hill_dusk.webp"]);
      await p.close();
    }
  });

  it("scope はロードとスキップの始まりに片付け、sleep は早送り・スキップ・控えめに従う", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const r = (await p.evaluate(`(async () => {
        const host = window.__liminalia.host;
        const ctx = host.context;
        const out = {};
        const a = ctx.scope();
        const el = a.add(document.createElement("div"));
        ctx.layers.fx.append(el);
        let fired = false;
        a.setTimeout(() => (fired = true), 5000);
        let undone = false;
        a.defer(() => (undone = true));
        const slept = a.sleep(60000);
        // 組み立て直し（ロードと同じ）で片付く
        await window.__liminalia.system.loadSave(window.__liminalia.system.runtime.save());
        await slept;
        await new Promise((r) => setTimeout(r, 60));
        out.load = [a.disposed, el.isConnected, fired, undone];
        // スキップの始まりで片付く（keepOnSkip は残る）
        const b = ctx.scope();
        const keep = ctx.scope({ keepOnSkip: true });
        host.skipping = true;
        out.skip = [b.disposed, keep.disposed];
        // スキップ中の sleep は待たない
        let t0 = performance.now();
        await keep.sleep(5000);
        out.skipSleep = performance.now() - t0 < 100;
        host.skipping = false;
        // ふつうの待ちは待つ
        t0 = performance.now();
        await keep.sleep(80);
        out.plainSleep = performance.now() - t0 >= 70;
        keep.dispose();
        out.disposed = keep.disposed;
        return out;
      })()`)) as Record<string, unknown>;
      expect(r.load, name).toEqual([true, false, false, true]);
      expect(r.skip, name).toEqual([true, false]);
      expect([r.skipSleep, r.plainSleep, r.disposed], name).toEqual([true, true, true]);
      await p.close();
    }
  });

  it("host.fonts と ui.scrollbar", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const r = (await p.evaluate(`(async () => {
        const host = window.__liminalia.host;
        const out = {};
        let t0 = performance.now();
        out.missing = await host.fonts.add("T Missing", "/no-such-font.ttf");
        await host.fonts.ready(500);
        out.readyQuick = performance.now() - t0 < 2000;
        const box = document.createElement("div");
        box.style.cssText = "position:absolute;left:0;top:0;width:200px;height:100px;overflow:auto;scrollbar-width:none";
        box.innerHTML = '<div style="height:400px"></div>';
        const track = document.createElement("div");
        track.style.cssText = "position:absolute;left:210px;top:0;width:10px;height:100px";
        const thumb = document.createElement("div");
        thumb.style.cssText = "position:absolute;left:0;width:10px";
        track.append(thumb);
        const back = document.createElement("button");
        const forward = document.createElement("button");
        host.context.layers.overlay.append(box, track, back, forward);
        const bar = window.__ui.scrollbar(box, { track, thumb, back, forward });
        out.start = [thumb.style.height, thumb.style.top, track.hasAttribute("data-lm-scrollable"), back.disabled, forward.disabled];
        box.scrollTop = 300;
        bar.update();
        out.end = [thumb.style.top, box.style.getPropertyValue("--lm-value"), back.disabled, forward.disabled];
        bar.dispose();
        return out;
      })()`)) as Record<string, unknown>;
      expect(r.missing, name).toBe(false);
      expect(r.readyQuick, name).toBe(true);
      expect(r.start, name).toEqual(["25px", "0px", true, true, false]);
      expect(r.end, name).toEqual(["75px", "1", false, true]);
      await p.close();
    }
  });
});
