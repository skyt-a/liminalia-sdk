import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 描画側からシステムへの口（RenderContext.system）と、名前で開ける作品の画面（system.defineScreen）を、実際のブラウザで確かめる。
 * - @open-screen <名前>・クイックメニューの "screen:<名前>"・メニュー（defineScreen の menu）・ctx.system.openScreen("<名前>") で開ける
 * - ctx.system の status・perform・systemVariables
 * - 遊びはじめる前（ready の時点）の system.chapters・system.chapterOf（liminalia.json の chapters）
 */

const PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({
  name: "t",
  ready({ system }) {
    // 遊びはじめる前でも、作品の章の情報を読める
    window.__ready = {
      runtime: system.runtime,
      chapters: system.chapters.map((c) => c.id + ":" + (c.number ?? "") + ":" + c.title),
      ofA: system.chapterOf("a")?.id ?? null,
      ofB: system.chapterOf("b_2")?.id ?? null,
      ofNone: system.chapterOf("nothing"),
    };
    system.defineScreen("t.notebook", (h) => {
      const el = document.createElement("div");
      el.className = "t-notebook";
      const close = document.createElement("button");
      close.className = "t-close";
      close.textContent = "とじる";
      close.addEventListener("click", () => h.close("done"));
      el.append("手帳の中身", close);
      return el;
    }, { label: { ja: "手帳", en: "Notebook" }, menu: true, closeOnBack: true });
  },
});
`;

const SCENARIO = `@window show
はじまり。
@open-screen t.notebook
手帳を閉じた。
@open-screen nothing
知らない画面は飛ばす。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`) as Promise<string>;
const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 10_000 });

describe.skipIf(!e2e)("描画側からシステムへの口と作品の画面（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: {
        entry: "a",
        ui: { menuBar: { items: ["save", "screen:t.notebook", "config"] } },
        chapters: [
          { id: "c1", number: "第一章", title: "はじまり", files: ["a"] },
          { id: "c2", title: "つづき", files: ["b_*"] },
        ],
      }, plugin: PLUGIN });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("遊びはじめる前（ready の時点）でも、system.chapters と system.chapterOf で作品の章を読める", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(project.url);
      await p.waitForFunction(() => (window as unknown as { __ready?: unknown }).__ready !== undefined);
      expect(await p.evaluate("window.__ready"), name).toEqual({ runtime: null, chapters: ["c1:第一章:はじまり", "c2::つづき"], ofA: "c1", ofB: "c2", ofNone: null });
      await p.close();
    }
  });

  it("@open-screen で作品の画面を開いて閉じるまで待ち、知らない名前は知らせて進む", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const warnings: string[] = [];
      p.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForSelector(".t-notebook");
      expect(await p.evaluate(() => window.__liminalia!.system.screen), name).toBe("t.notebook");
      // 閉じるまで台本は進まない（送った「はじまり」は、送ったあとの最初の命令の @open-screen で消える。after-page.test.ts）
      await p.waitForTimeout(300);
      expect(await text(p), name).not.toContain("手帳を閉じた");
      expect(await p.evaluate(() => window.__liminalia!.system.screen), name).toBe("t.notebook");
      await p.locator(".t-close").click();
      await waitText(p, "手帳を閉じた");
      await p.evaluate(() => window.__liminalia!.host.advance());
      await waitText(p, "知らない画面は飛ばす");
      expect(warnings.some((w) => w.includes("unknown-screen")), name).toBe(true);
      await p.close();
    }
  });

  it("クイックメニューの screen:<名前> とメニューに並び、RenderContext.system から開ける・様子と操作と system 変数を使える", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "はじまり");
      // クイックメニュー: defineScreen の label
      const bar = p.locator(".lm-menubar-button");
      expect(await bar.allTextContents(), name).toEqual(["セーブ", "手帳", "コンフィグ"]);
      await bar.nth(1).click();
      await p.waitForSelector(".t-notebook");
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.querySelector(".t-notebook"));
      // メニュー: タイトルへの前に並ぶ
      await p.evaluate("window.__liminalia.system.openMenu()");
      const items = await p.locator(".lm-menu-button").allTextContents();
      expect(items.slice(-2), name).toEqual(["手帳", "タイトルへ"]);
      await p.locator(".lm-menu-button", { hasText: "手帳" }).click();
      await p.waitForSelector(".t-notebook");
      await p.locator(".t-close").click();
      // RenderContext.system（命令の描画や restorer が受け取る ctx と同じもの）
      const result = await p.evaluate(async () => {
        const sys = window.__liminalia!.host.context.system!;
        const status = { mode: sys.status?.mode, auto: sys.status?.auto };
        const opened = sys.openScreen("t.notebook");
        await new Promise((r) => setTimeout(r, 100));
        const screen = sys.status?.screen;
        (document.querySelector(".t-close") as HTMLButtonElement).click();
        const closed = await opened;
        const unknown = await sys.openScreen("nothing");
        await sys.perform("auto");
        const auto = sys.status?.auto;
        await sys.perform("auto");
        sys.systemVariables.t_seen = true;
        sys.saveSystemVariables();
        const handle = sys.openScreen((h) => {
          const el = document.createElement("div");
          el.className = "t-direct";
          setTimeout(() => h.close(), 50);
          return el;
        }, { name: "t.direct" });
        const direct = await handle.result;
        return { status, screen, closed, unknown, auto, direct };
      });
      expect(result, name).toEqual({ status: { mode: "game", auto: false }, screen: "t.notebook", closed: true, unknown: false, auto: true, direct: null });
      expect(await p.evaluate(() => Object.entries(window.__liminalia!.saves!.entries()).some(([k, v]) => k.endsWith(":system") && v.includes("t_seen"))), name).toBe(true);
      await p.close();
    }
  });
});
