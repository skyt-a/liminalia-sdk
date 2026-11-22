import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 作品の画面（system.openScreen）と見た目を持たない UI 部品、標準の画面の差し替えを、実際のブラウザで確かめる。
 * - 入力が下へ漏れない・開いている間シナリオが進まない・セーブ→ロードで同じ状態に戻る
 */

const PLUGIN = `import { defineWebPlugin, ui } from "@liminalia/web";
const build = (h) => {
  const root = document.createElement("div");
  root.style.cssText = "position:absolute;inset:0;background:rgba(0,0,40,.85);color:#fff";
  const count = document.createElement("div"); count.id = "count"; count.textContent = String(h.state.count);
  const plus = document.createElement("div"); plus.id = "plus"; plus.style.cssText = "position:absolute;left:100px;top:100px;width:120px;height:60px;background:#446";
  ui.button(plus, { onPress: () => { h.setState({ count: h.state.count + 1 }); count.textContent = String(h.state.count); } });
  const track = document.createElement("div"); track.id = "track"; track.style.cssText = "position:absolute;left:100px;top:300px;width:400px;height:20px;background:#888";
  ui.slider(track, { min: 0, max: 100, step: 5, setting: { system: window.__sys, key: "bgm" } });
  const sw = document.createElement("div"); sw.id = "sw"; sw.style.cssText = "position:absolute;left:100px;top:400px;width:80px;height:40px;background:#644";
  ui.toggle(sw, { setting: { system: window.__sys, key: "custom.effects" } });
  const close = document.createElement("div"); close.id = "close"; close.style.cssText = "position:absolute;left:600px;top:100px;width:120px;height:60px;background:#464";
  ui.button(close, { onPress: () => h.close("done") });
  root.append(count, plus, track, sw, close);
  return root;
};
export default defineWebPlugin({ name: "t",
  ready: ({ system }) => {
    window.__sys = system;
    system.defineScreen("t.inv", build);
    window.__open = () => { window.__h = system.openScreen(build, { key: "t.inv", state: { count: 0 } }); window.__h.result.then((r) => (window.__result = r)); };
  },
  screens: {
    backlog: (api) => { const root = document.createElement("div"); root.id = "mylog"; root.textContent = api.entries.length + " 件"; return root; },
  },
});`;

describe.skipIf(!e2e)("作品の画面と UI 部品（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    // @wait は skip=false（念のために二度押す送りで、待ちを飛ばさないように）
    project = await startProject({ scenario: { a: "@window show\n一ページ目。\n@wait 600ms skip=false\n二ページ目。\n三ページ目。\n" }, plugin: PLUGIN });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("入力が下へ漏れず、開いている間シナリオが進まず、セーブ→ロードで同じ状態に戻る", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const pages = () => p.evaluate("window.__liminalia.pages()") as Promise<number>;
      const screen = () => p.evaluate("window.__liminalia.screen().screen") as Promise<string | null>;
      await p.waitForTimeout(400);
      // 一ページ目を送り、@wait 600ms の間に開く
      await p.mouse.click(640, 360);
      await p.waitForTimeout(80);
      await p.mouse.click(640, 360);
      await p.waitForTimeout(30);
      await p.evaluate("window.__open()");
      await p.waitForTimeout(1200);
      expect(await pages(), name).toBe(1);
      await p.mouse.click(900, 600);
      await p.mouse.wheel(0, -300);
      await p.mouse.click(900, 600, { button: "right" });
      await p.keyboard.press("Escape");
      await p.waitForTimeout(300);
      expect([await pages(), await screen()], name).toEqual([1, "t.inv"]);
      // ボタン・つまみ・切り替え
      await p.mouse.click(160, 130);
      await p.mouse.click(160, 130);
      expect(await p.evaluate("window.__h.state"), name).toEqual({ count: 2 });
      await p.mouse.move(110, 310);
      await p.mouse.down();
      await p.mouse.move(400, 310, { steps: 5 });
      await p.mouse.up();
      await p.mouse.click(140, 420);
      expect(await p.evaluate("({ bgm: window.__sys.settings.bgm, effects: window.__sys.settings.custom.effects })"), name).toEqual({ bgm: 75, effects: true });
      // セーブ → 閉じる（シナリオが進む）→ ロードで開き直る
      expect(await p.evaluate("window.__sys.saveTo(3)"), name).toBe(true);
      await p.mouse.click(660, 130);
      await p.waitForTimeout(400);
      expect([await screen(), await p.evaluate("window.__result"), await pages()], name).toEqual([null, "done", 2]);
      await p.evaluate("window.__sys.loadFrom(3)");
      await p.waitForTimeout(800);
      expect([await screen(), await p.evaluate("document.getElementById('count').textContent")], name).toEqual(["t.inv", "2"]);
      await p.close();
    }
  });

  it("ui.screen.pauseScenario: 標準の画面を開いている間はシナリオが進まない（既定。false なら進む）", async () => {
    const scenario = { a: "@window show\n一ページ目。\n@wait 600ms skip=false\n二ページ目。\n" };
    const paused = await startProject({ scenario });
    const free = await startProject({ scenario, config: { ui: { screen: { pauseScenario: false } } } });
    try {
      for (const { name, browser } of list) {
        for (const [project, expected] of [[paused, 1], [free, 2]] as const) {
          const p = await openPlayer(browser, project.url, "a");
          await p.waitForTimeout(400);
          await p.mouse.click(640, 360);
          await p.waitForTimeout(80);
          await p.mouse.click(640, 360);
          await p.waitForTimeout(30);
          await p.evaluate('void window.__liminalia.system.perform("config")');
          await p.waitForTimeout(1200);
          const label = `${name} ${expected === 1 ? "既定" : "止めない"}`;
          expect([await p.evaluate("window.__liminalia.pages()"), await p.evaluate("window.__liminalia.screen().screen")], label).toEqual([expected, "config"]);
          await p.mouse.click(100, 100, { button: "right" });
          await p.waitForTimeout(1000);
          expect(await p.evaluate("window.__liminalia.pages()"), label).toBe(2);
          await p.close();
        }
      }
    } finally {
      await paused.close();
      await free.close();
    }
  });

  it("標準の画面の見た目を差し替えられる（履歴）", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await p.evaluate('void window.__sys.perform("backlog")');
      await p.waitForTimeout(300);
      expect(await p.evaluate("(document.getElementById('mylog') || {}).textContent"), name).toBe("1 件");
      await p.mouse.click(100, 100, { button: "right" });
      await p.waitForTimeout(200);
      expect(await p.evaluate("window.__liminalia.screen().screen"), name).toBeNull();
      await p.close();
    }
  });
});
