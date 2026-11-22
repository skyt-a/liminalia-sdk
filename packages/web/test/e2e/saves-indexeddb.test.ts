import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * ブラウザ版のセーブの置き場所（IndexedDB。system/idb-store.ts）を、実際のブラウザで確かめる。
 * 前の版の localStorage のセーブを移すこと、localStorage に入りきらない大きさも書けること、書き終わらなかった分（JOURNAL）を戻すこと、
 * はじめてセーブしたときに消さないよう頼むこと、エクスポートしたものを読み込めること。
 */

const ID = "hoshi_wo_matsu_oka";
const KEY = `liminalia:${ID}:slot:5`;

/** IndexedDB に入っている値（プレイヤーの写しではなく、IndexedDB を直に読む）。 */
const stored = (p: Page, key: string) =>
  p.evaluate(
    (k) =>
      new Promise<string | null>((resolve, reject) => {
        const r = indexedDB.open("liminalia");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const get = r.result.transaction("saves").objectStore("saves").get(k);
          get.onsuccess = () => {
            resolve((get.result as string | undefined) ?? null);
            r.result.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    key,
  );

describe.skipIf(!e2e)("セーブの置き場所（IndexedDB。ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "@window show\n一。\n二。\n三。\n" }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("前の版が localStorage に置いたセーブを IndexedDB へ移し、localStorage からは消す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("window.__liminalia.system.saveTo(5)");
      await p.evaluate("window.__liminalia.flushSaves()");
      const record = (await p.evaluate(`window.__liminalia.saves.entries()[${JSON.stringify(KEY)}]`)) as string;
      expect(record, name).toContain('"version":1');
      expect(await stored(p, KEY), name).toBe(record);
      // 前の版の形にする（IndexedDB から消して localStorage に置く）
      await p.evaluate(`(() => { window.__liminalia.saves.clear(); return window.__liminalia.flushSaves(); })()`);
      expect(await stored(p, KEY), name).toBeNull();
      await p.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, record] as const);
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      expect(await p.evaluate(`window.__liminalia.saves.entries()[${JSON.stringify(KEY)}]`), name).toBe(record);
      expect(await p.evaluate((k) => localStorage.getItem(k), KEY), name).toBeNull();
      expect(await stored(p, KEY), name).toBe(record);
      expect(((await p.evaluate("window.__liminalia.system.slot(5)")) as { title?: string } | null)?.title, name).toBe("一。");
      await p.close();
    }
  });

  it("localStorage に入りきらない大きさ（800 万字）も書け、開き直しても残る", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      // 比べるために、localStorage に入る文字数を測る（10 万字ずつ）
      const lsChars = (await p.evaluate(() => {
        const chunk = "x".repeat(100_000);
        let n = 0;
        try {
          for (; n < 200; n++) localStorage.setItem(`fill:${n}`, chunk);
        } catch {
          // 入りきらない
        }
        for (let i = 0; i < n; i++) localStorage.removeItem(`fill:${i}`);
        return n * chunk.length;
      })) as number;
      await p.evaluate((id) => {
        const saves = window.__liminalia!.saves!;
        const chunk = "y".repeat(100_000);
        for (let n = 0; n < 80; n++) saves.set(`liminalia:${id}:big:${n}`, chunk);
        return window.__liminalia!.flushSaves!();
      }, ID);
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      const kept = (await p.evaluate((id) => Object.values(window.__liminalia!.saves!.entries(`liminalia:${id}:big:`)).reduce((n, v) => n + v.length, 0), ID)) as number;
      console.info(`${name}: localStorage に入った文字数 ${(lsChars / 1e6).toFixed(1)}M 字、IndexedDB に書いて残った文字数 ${(kept / 1e6).toFixed(1)}M 字`);
      expect(kept, name).toBe(80 * 100_000);
      expect(kept, name).toBeGreaterThan(lsChars);
      await p.close();
    }
  });

  it("書き終わらずに閉じた分（JOURNAL）は、次に開いたときに入れる", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const first = await context.newPage();
      await first.goto(`${project.url}?autostart=1&start=a`);
      await first.waitForSelector(".message .text .ch");
      await first.close();
      // 閉じたプレイヤーが残したもの、とする（プレイヤーの無いページで置く。プレイヤーは閉じるときに自分の分を書き直すため）
      const p = await context.newPage();
      await p.goto(`${project.url}manifest.webmanifest`);
      const key = `liminalia:${ID}:system`;
      await p.evaluate((k) => localStorage.setItem("liminalia-journal", JSON.stringify({ [k]: '{"from_journal":true}', "liminalia:other_game:system": "{}" })), key);
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      expect(await p.evaluate("window.__liminalia.system.systemVariables.from_journal"), name).toBe(true);
      // ほかの作品の分は残す
      expect(await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("liminalia-journal") ?? "{}"))), name).toEqual(["liminalia:other_game:system"]);
      await context.close();
    }
  });

  it("裏へ回ったときのオートセーブは JOURNAL にも置き、書き終えたら JOURNAL から消す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("一。") && window.__liminalia!.host.waiting);
      // 裏へ回ったことにし、書いた直後（IndexedDB に入る前）の JOURNAL を見る
      const seen = (await p.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        return localStorage.getItem("liminalia-journal") ?? "";
      })) as string;
      expect(Object.keys(JSON.parse(seen || "{}")).some((k) => k.endsWith(":slot:auto:0")), name).toBe(true);
      await p.evaluate("window.__liminalia.flushSaves()");
      expect(await p.evaluate(() => localStorage.getItem("liminalia-journal")), name).toBeNull();
      expect(await stored(p, `liminalia:${ID}:slot:auto:0`), name).not.toBeNull();
      await p.close();
    }
  });

  it("はじめてセーブしたときに、データを消さないよう一度だけ頼む", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __persist: number };
        w.__persist = 0;
        Object.defineProperty(navigator, "storage", {
          value: { persisted: async () => false, persist: async () => (w.__persist++, true), estimate: async () => ({}) },
          configurable: true,
        });
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      expect(await p.evaluate("window.__persist"), name).toBe(0);
      await p.evaluate("window.__liminalia.system.saveTo(0)");
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.waitForTimeout(100);
      expect(await p.evaluate("window.__persist"), name).toBe(1);
      await p.close();
    }
  });

  it("エクスポートしたセーブ・既読・全セーブ共通の変数を、消したあとにインポートして戻す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // エクスポートしたファイルを受け取る口（スマホ版のアプリと同じ形）
      await p.addInitScript(() => {
        const w = window as unknown as { __saved: string[]; LiminaliaFiles: unknown };
        w.__saved = [];
        w.LiminaliaFiles = { save: (_n: string, _m: string, b: string) => (w.__saved.push(b), true) };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      await p.evaluate(`(() => { const s = window.__liminalia.system; s.saveTo(3); s.systemVariables.exported = 7; return window.__liminalia.leave(); })()`);
      await p.evaluate(`window.__liminalia.system.perform("config")`);
      await p.locator(".lm-button", { hasText: "セーブデータをエクスポート" }).click();
      await p.waitForFunction("window.__saved.length === 1");
      const json = Buffer.from((await p.evaluate("window.__saved[0]")) as string, "base64").toString();
      const data = JSON.parse(json) as { entries: Record<string, string> };
      expect(Object.keys(data.entries), name).toEqual(expect.arrayContaining(["slot:3", "system", "read"]));
      // 消してから、インポートする（確かめてから読み込み、開き直す）
      await p.evaluate(`(() => { window.__liminalia.saves.clear(); return window.__liminalia.flushSaves(); })()`);
      expect(await stored(p, `liminalia:${ID}:slot:3`), name).toBeNull();
      const chooser = p.waitForEvent("filechooser");
      await p.locator(".lm-button", { hasText: "セーブデータをインポート" }).click();
      await (await chooser).setFiles({ name: "saves.json", mimeType: "application/json", buffer: Buffer.from(json) });
      await p.waitForSelector(".lm-dialog");
      const reloaded = p.waitForEvent("load");
      await p.click(".lm-dialog .lm-primary");
      await reloaded;
      await p.waitForSelector(".message .text .ch");
      expect(await stored(p, `liminalia:${ID}:slot:3`), name).not.toBeNull();
      expect(await p.evaluate("window.__liminalia.system.systemVariables.exported"), name).toBe(7);
      await p.close();
    }
  });
});
