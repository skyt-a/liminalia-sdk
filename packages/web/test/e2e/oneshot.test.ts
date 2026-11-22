import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 一回きりの演出（@flipbook・@flash・@blink・@cutin・@effect time=）と通知（@notify）を、実際のブラウザで確かめる。
 * - どれも描き終えたら片付き、待つ命令は終わるまで次へ進まない。クリックの早送りで終わる
 * - 「控えめ」では点滅とコマ送りを出さない（@flash は薄い幕）
 * - 通知は上限を超えたら古いものから下げ、同じ文は一つにまとめ、全画面の演出（coverUi）の間は待たせ、ロードで消える。
 *   screens.toast で見た目を差し替えられる
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures");

const PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({
  name: "t",
  screens: {
    toast(api) {
      const el = document.createElement("div");
      el.className = "t-toast";
      el.textContent = "[" + api.kind + "] " + api.text + (api.args.title ? " / " + api.args.title : "");
      return el;
    },
  },
});
`;

const SCENARIO = `@bg hill_dusk.webp
@window show
はじまり。
@flipbook fx/f_{n}.png frames=2 durations=300,300
コマ送りのあと。
@flash invert count=2 time=200ms gap=200ms
フラッシュのあと。
@blink close=200ms hold=300ms open=200ms
瞬きのあと。
@cutin key.png from=left time=600ms hide-window=true
カットインのあと。
@effect glitch time=400ms wait=true
効果のあと。
@notify 一つ目
@notify 二つ目 kind=success
@notify 三つ目
@notify 四つ目 max=3
@notify 二つ目 kind=success
通知のあと。
`;

const LOOP_SCENARIO = `@window show
はじまり。
@flipbook fx/f_{n}.png frames=2 durations=120,120 loop=0 name=rain
回り始めた。
次のページ。
@flipbook-off rain time=200ms
止めた。
`;

const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 15_000 });
const advance = (p: Page) => p.evaluate("window.__liminalia.host.advance()");

describe.skipIf(!e2e)("一回きりの演出と通知（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO, b: "@window show\nはじまり。\n@notify 待たされる\n覆いのあと。\n", c: LOOP_SCENARIO },
      config: { entry: "a" },
      plugin: PLUGIN,
      files: { "assets/image/fx/f_1.png": `${FIXTURES}/layer-top.png`, "assets/image/fx/f_2.png": `${FIXTURES}/layer-body.png`, "assets/image/key.png": `${FIXTURES}/stripes.png` },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("演出を出して片付け、待つ命令は終わるまで進まない。通知を積み、まとめ、差し替えた見た目で出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await advance(p);
      await p.waitForSelector(".lim-flipbook");
      const frame = await p.evaluate(`document.querySelector(".lim-flipbook").getAttribute("src")`);
      expect(String(frame), name).toContain("fx/f_");
      expect(await p.evaluate(`document.querySelector(".message .text").textContent`), name).not.toContain("コマ送りのあと");
      await waitText(p, "コマ送りのあと");
      expect(await p.evaluate(`document.querySelectorAll(".lim-flipbook").length`), name).toBe(0);
      await advance(p);
      await p.waitForSelector(".lim-flash--invert");
      await waitText(p, "フラッシュのあと");
      expect(await p.evaluate(`document.querySelectorAll(".lim-flash").length`), name).toBe(0);
      await advance(p);
      await p.waitForSelector(".lim-blink");
      // クリックで早送りすると、すぐ終わる
      await p.waitForTimeout(50);
      const t0 = Date.now();
      await advance(p);
      await waitText(p, "瞬きのあと");
      expect(Date.now() - t0, name).toBeLessThan(500);
      expect(await p.evaluate(`document.querySelectorAll(".lim-blink").length`), name).toBe(0);
      await advance(p);
      await p.waitForSelector(".lim-cutin-frame img");
      expect(await p.evaluate(`document.querySelector(".message").classList.contains("lm-window-held")`), name).toBe(true);
      await waitText(p, "カットインのあと");
      expect(await p.evaluate(`[document.querySelectorAll(".lim-cutin-frame").length, document.querySelector(".message").classList.contains("lm-window-held")]`), name).toEqual([0, false]);
      await advance(p);
      await p.waitForFunction(() => [...document.querySelectorAll("[data-fx-filter]")].some((e) => (e as HTMLElement).dataset.fxFilter));
      await waitText(p, "効果のあと");
      expect(await p.evaluate(`[...document.querySelectorAll("[data-fx-filter]")].filter((e) => e.dataset.fxFilter).length`), name).toBe(0);
      // セーブに一回きりの効果は残らない
      expect(await p.evaluate(`JSON.stringify(window.__liminalia.system.runtime.state.stage.extra)`), name).toBe("{}");
      await advance(p);
      await waitText(p, "通知のあと");
      await p.waitForTimeout(100);
      const notices = (await p.evaluate(`[...document.querySelectorAll(".lm-notice")].map((e) => [e.textContent, e.dataset.lmState, e.dataset.lmCount, e.dataset.kind])`)) as string[][];
      // 一つ目は四つ目で下がり、二つ目は二度出したので一つにまとめた
      expect(notices.filter((n) => n[1] !== "out").map((n) => [n[0], n[2], n[3]]), name).toEqual([
        ["[success] 二つ目", "2", "success"],
        ["[info] 三つ目", "1", "info"],
        ["[info] 四つ目", "1", "info"],
      ]);
      // ロードで消える
      await p.evaluate("window.__liminalia.system.loadSave(window.__liminalia.system.runtime.save())");
      await p.waitForTimeout(300);
      expect(await p.evaluate(`document.querySelectorAll(".lm-notice").length`), name).toBe(0);
      await p.close();
    }
  });

  it("loop=0 は待たずに止めるまで繰り返し、ページを越えて残り、スキップで止まらず、ロードで流し直し、@flipbook-off で消える", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=c`);
      await waitText(p, "はじまり");
      await advance(p);
      // 待たずに次の本文へ
      await waitText(p, "回り始めた");
      await p.waitForSelector(".lim-flipbook");
      const frames = new Set<string>();
      for (let i = 0; i < 8; i++) {
        frames.add(String(await p.evaluate(`document.querySelector(".lim-flipbook")?.getAttribute("src")`)));
        await p.waitForTimeout(60);
      }
      expect(frames.size, name).toBe(2);
      // 状態に残る
      expect(await p.evaluate(`JSON.stringify(window.__liminalia.system.runtime.state.stage.extra["std.flipbooks"].map((l) => l.name))`), name).toBe('["rain"]');
      // スキップの始まりでも片付けない
      await p.evaluate("window.__liminalia.host.skipping = true");
      await p.waitForTimeout(100);
      expect(await p.evaluate(`document.querySelectorAll(".lim-flipbook").length`), name).toBe(1);
      await p.evaluate("window.__liminalia.host.skipping = false");
      await advance(p);
      await waitText(p, "次のページ");
      expect(await p.evaluate(`document.querySelectorAll(".lim-flipbook").length`), name).toBe(1);
      // ロードで流し直す
      await p.evaluate("window.__liminalia.system.loadSave(window.__liminalia.system.runtime.save())");
      await p.waitForTimeout(400);
      await p.waitForSelector(".lim-flipbook");
      expect(await p.evaluate(`document.querySelectorAll(".lim-flipbook").length`), name).toBe(1);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/flipbook-loop-${name}.png` }).catch(() => undefined);
      await waitText(p, "次のページ");
      await advance(p);
      await waitText(p, "止めた");
      await p.waitForTimeout(400);
      expect(await p.evaluate(`document.querySelectorAll(".lim-flipbook").length`), name).toBe(0);
      expect(await p.evaluate(`window.__liminalia.system.runtime.state.stage.extra["std.flipbooks"] ?? null`), name).toBeNull();
      await p.close();
    }
  });

  it("「光の点滅: 控えめ」ではフラッシュを薄い幕にする。全画面の演出の間は通知を待たせる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await p.evaluate("window.__liminalia.host.flashReduced = true");
      await advance(p);
      await waitText(p, "コマ送りのあと");
      await advance(p);
      await p.waitForSelector(".lim-flash--soft");
      expect(await p.evaluate(`document.querySelectorAll(".lim-flash--invert").length`), name).toBe(0);
      await p.close();
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${project.url}?autostart=1&start=b`);
      await waitText(q, "はじまり");
      await q.evaluate("window.__release = window.__liminalia.host.coverUi()");
      await advance(q);
      await waitText(q, "覆いのあと");
      await q.waitForTimeout(200);
      expect(await q.evaluate(`document.querySelectorAll(".lm-notice").length`), name).toBe(0);
      await q.evaluate("window.__release()");
      await q.waitForSelector(".lm-notice");
      expect(await q.evaluate(`document.querySelector(".lm-notice").textContent`), name).toBe("[info] 待たされる");
      await q.close();
    }
  });
});
