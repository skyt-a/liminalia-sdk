import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import type { ScreenInfo } from "../src/protocol.ts";

/**
 * 制作画面の「ゲームの画面」（client/screens-view.ts）と、その見本のプレイヤー（@liminalia/web の screen-preview/）を、lim studio を立てて Chromium で確かめる。
 * - 開ける画面はどれも、用意した状態ごとに作り物の中身で開き、エラーを出さない（下の CONTENT に画面ごとの中身の確かめ方を書く。書き忘れたら落ちる）
 * - 見本は遊ぶ人のセーブ、既読、設定（IndexedDB と localStorage）を読まず、書かない
 * - タブ: 一覧、開けない画面の理由、プラグインが差し替えた画面の札、状態、向き、英語、テーマの切り替え
 * - liminalia.json とプラグインの CSS を保存すると、開いている画面が読み込み直さずにその場で直る
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

/**
 * 操作説明を差し替え、CSS を足すプラグイン（差し替えた画面の札と、CSS の保存でその場で直ることを確かめる）。
 * ロードの幕（transitions.load）も持ち、reveal から 8 秒は幕を残す（見本は作り物の状態をロードで入れるが、幕は下ろさないことを確かめる）。
 */
const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
import "./look.css";
export default defineWebPlugin({ name: "look",
  transitions: {
    load: {
      cover: (ctx) => {
        const el = document.createElement("div");
        el.className = "slow-curtain";
        el.style.cssText = "position:absolute;inset:0;z-index:9999;background:#204060;pointer-events:none";
        ctx.systemLayer.append(el);
      },
      reveal: () => {
        setTimeout(() => document.querySelectorAll(".slow-curtain").forEach((el) => el.remove()), 8000);
      },
    },
  },
  screens: {
    help: (api) => {
      const el = document.createElement("div");
      el.className = "look-help";
      for (const r of api.rows) {
        const row = document.createElement("p");
        row.textContent = r.label;
        el.append(row);
      }
      return el;
    },
  },
});
`;
const CSS = (color: string) => `.lm-saveload .lm-slot-name { color: ${color}; }\n`;

type Check = (f: Frame, state: string) => Promise<void>;
const count = (f: Frame, selector: string) => f.locator(selector).count();
const text = async (f: Frame, selector: string) => (await f.locator(selector).allTextContents()).join("\n");
const has = (selector: string, words?: string): Check => async (f) => {
  expect(await count(f, selector), selector).toBeGreaterThan(0);
  if (words) expect(await text(f, selector)).toContain(words);
};

/** 画面ごとの作り物の中身の確かめ方（状態は filled、empty、long）。 */
const CONTENT: Record<string, Check> = {
  splash: has(".lm-splash", "起動の演出の見本"),
  warning: async (f, s) => has(".lm-warning-text", s === "long" ? "長い文のとき" : "見本の注意書き")(f, s),
  title: async (f, s) => {
    expect(await count(f, ".lm-title-button")).toBeGreaterThan(1);
    if (s === "long") expect(await text(f, ".lm-title")).toContain("長い、見本の作品の題名");
    // セーブが無ければ「つづきから」は押せない
    const go = f.locator(".lm-title-button", { hasText: "つづきから" });
    if (await go.count()) expect(await go.isDisabled()).toBe(s === "empty");
  },
  message: async (f, s) => has(".message .text", s === "long" ? "長い台詞" : "見本の台詞")(f, s),
  name: async (f, s) => has(".message .name", s === "long" ? "とても長い肩書き" : "案内人")(f, s),
  glyph: has(".message .glyph"),
  choice: async (f, s) => {
    expect(await count(f, ".choices button")).toBe(3);
    expect(await text(f, ".choices")).toContain(s === "long" ? "階段を上り" : "灯台へ行く");
  },
  menuBar: has(".lm-menubar"),
  indicator: has(".lm-indicator:not([hidden])"),
  menu: has(".lm-menu"),
  saveload: async (f, s) => {
    const filled = await count(f, ".lm-slot:not(.lm-empty)");
    if (s === "empty") return expect(filled).toBe(0);
    expect(filled).toBeGreaterThanOrEqual(5);
    expect(await count(f, ".lm-slot-thumb img")).toBeGreaterThan(0);
    expect(await count(f, ".lm-slot-memo")).toBeGreaterThan(0);
    expect(await count(f, ".lm-slot.is-locked")).toBeGreaterThan(0);
    expect(await text(f, ".lm-slot-chapter")).toContain(s === "long" ? "長い坂道" : "灯台へ");
  },
  config: has(".lm-config"),
  backlog: async (f, s) => {
    const body = await text(f, ".lm-backlog");
    if (s === "empty") return expect(body).not.toContain("灯台");
    // ボイスあり、二人が同時に話したページ、選んだ選択肢
    expect(body).toContain("案内人、");
    expect(body).toContain("灯台へ行く");
    expect(await count(f, ".lm-backlog button[aria-label]")).toBeGreaterThan(2);
    if (s === "long") expect(body).toContain("手すりにつかまり");
  },
  confirm: has(".lm-dialog", "タイトル"),
  ending: async (f, s) => has(".lm-ending-name", s === "long" ? "長い旅の終わり" : "灯台の明かり")(f, s),
  extra: async (f, s) => {
    expect(await count(f, ".lm-extra")).toBe(1);
    // 解放した CG の絵（空なら一つも解放しない）
    if (s === "empty") expect(await count(f, ".lm-extra img")).toBe(0);
    else expect(await count(f, ".lm-extra img")).toBeGreaterThan(0);
    if (s === "long") expect(await text(f, ".lm-extra")).toContain("長い坂道");
  },
  flowchart: async (f, s) => {
    const body = await text(f, ".lm-flow");
    // 空ならどの場面にも着いていない
    if (s === "empty") expect(body).not.toContain("港に着く");
    else expect(body).toContain(s === "long" ? "船で港に着き" : "港に着く");
  },
  // プラグイン look が差し替えた画面
  help: has(".look-help"),
  items: async (f, s) => {
    const body = await text(f, ".lm-items");
    if (s === "empty") expect(body).not.toContain("ランプ");
    else expect(body).toContain(s === "long" ? "手提げのランプ" : "ランプ");
  },
  dialog: async (f, s) => has(".lm-panel", s === "long" ? "長い文のとき" : "見本の確認")(f, s),
  notice: async (f) => expect(await count(f, ".lm-notice")).toBe(3),
  toast: has(".lm-toast", "セーブしました"),
  term: async (f, s) => has(".lm-term-pop", s === "long" ? "霧の日" : "灯台の明かりを守る人")(f, s),
  captions: async (f, s) => has(".lm-caption", s === "long" ? "波の音" : "汽笛")(f, s),
  codex: async (f, s) => {
    const body = await text(f, ".lm-codex");
    if (s === "empty") expect(body).not.toContain("案内人");
    else expect(body).toContain(s === "long" ? "とても長い肩書き" : "案内人");
  },
  investigate: async (f) => expect(await count(f, ".lm-investigate-spot")).toBe(3),
  "map-choice": async (f, s) => {
    expect(await count(f, ".lm-map-choice-spot")).toBeGreaterThan(1);
    if (s === "long") expect(await text(f, ".lm-map-choice")).toContain("朝から開く市場");
  },
  chapter: async (f, s) => has(".lim-chapter", s === "long" ? "長い坂道" : "灯台へ")(f, s),
  cutin: has(".lim-cutin-frame img"),
  hud: async (f, s) => has(".lim-hud", s === "long" ? "夕方" : "三日目")(f, s),
  chat: async (f, s) => {
    expect(await count(f, ".lim-chat-bubble")).toBe(s === "empty" ? 1 : 4);
    if (s === "long") expect(await text(f, ".lim-chat")).toContain("古い門");
  },
};

/** プラグイン look が差し替えた画面（部品の表の部品は出ない）。 */
const REPLACED = new Set(["help"]);
/** 作品の設定が無いと出ない部品と、その設定（見本の作品は書いていない）。 */
const NEEDS_SETTING: Record<string, string> = {
  ".lm-title-logo": "ui.title.logo",
  ".lm-splash-logo-image": "ui.splash.logos",
  // 地の文の行は、ふだんの台詞を吹き出しにする作品（ui.chat.dialogue）だけが出す
  ".lim-chat-note": "ui.chat.dialogue",
};

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("ゲームの画面（lim studio）", { timeout: 600_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let base: string;
  let screens: ScreenInfo[];
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on("pageerror", (e) => errors.push(`${p.url()} ${e.message}`));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(`${p.url()} ${m.text()}`);
    });
  };
  const view = (): Locator => page.locator('.view-surface[data-view="screens"]');
  const frame = () => view().locator(".screens-frame");
  /** プレビューが開き終えるまで（data-preview を消してから操作して待つ）。 */
  const settled = async (act: () => Promise<unknown>) => {
    await view().evaluate((e) => delete (e as HTMLElement).dataset.preview);
    await act();
    await expect.poll(() => view().getAttribute("data-preview"), { timeout: 30_000 }).toBe("ready");
  };
  const frameUrl = async () => new URL((await frame().getAttribute("src"))!, base).searchParams;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-screen-preview-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    const plugin = join(dir, "plugins", "look");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "look", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(plugin, "src", "web.ts"), PLUGIN);
    writeFileSync(join(plugin, "src", "look.css"), CSS("rgb(1, 2, 3)"));
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
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
    base = new URL(url).origin;
    screens = (await (await fetch(`${base}/__liminalia/studio/api/screens`)).json()) as ScreenInfo[];
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
    page = await context.newPage();
    watch(page);
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(1000);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("開ける画面はどれも中身の確かめ方を書いてある", () => {
    expect(screens.length).toBeGreaterThan(20);
    expect(Object.keys(CONTENT).sort()).toEqual(screens.filter((s) => s.opens).map((s) => s.id).sort());
  });

  it("開ける画面はどれも、用意した状態ごとに作り物の中身で開き、エラーを出さない", async () => {
    const p = await context.newPage();
    watch(p);
    for (const s of screens.filter((x) => x.opens)) {
      for (const state of ["filled", ...s.states]) {
        const before = errors.length;
        await p.goto(`${base}/?ui-preview=screen&screen=${s.id}&state=${state}&still=1`);
        await p.waitForFunction(() => ["ready", "failed"].includes(document.documentElement.dataset.lmScreenPreview ?? ""), null, { timeout: 30_000 });
        const report = await p.evaluate(() => window.__liminaliaScreenPreview);
        expect(report?.status, `${s.id} ${state} ${JSON.stringify(report?.problems)}`).toBe("ready");
        expect(report?.problems, `${s.id} ${state}`).toEqual([]);
        await CONTENT[s.id]!(p.mainFrame(), state);
        // 部品の表の部品は、入った状態の画面に出る（プラグインが差し替えた画面と、作品の設定が要る部品は除く）
        if (state === "filled" && !REPLACED.has(s.id)) {
          for (const part of s.parts) if (!NEEDS_SETTING[part.selector]) expect(await count(p.mainFrame(), part.selector), `${s.id} の部品 ${part.selector}`).toBeGreaterThan(0);
        }
        expect(errors.slice(before), `${s.id} ${state}`).toEqual([]);
      }
    }
    // 英語: 標準の画面の文言も作り物の中身も英語
    await p.goto(`${base}/?ui-preview=screen&screen=saveload&lang=en&still=1`);
    await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready");
    expect(await text(p.mainFrame(), ".lm-saveload")).toContain("Load");
    expect(await text(p.mainFrame(), ".lm-slot-chapter")).toContain("Chapter");
    // 開けない画面は理由を知らせる
    await p.goto(`${base}/?ui-preview=screen&screen=gate`);
    await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "failed");
    await p.close();
  });

  it("標準の画面の部品が重ならない（セーブスロットのメモとボタン、持ち物の絵と説明）", async () => {
    const p = await context.newPage();
    watch(p);
    type Box = { x: number; y: number; width: number; height: number };
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
    for (const orientation of ["", "&orientation=portrait"]) {
      for (const state of ["filled", "long"]) {
        // セーブスロット: メモの文は、同じスロットのメモと保護のボタンに重ならない
        await p.goto(`${base}/?ui-preview=screen&screen=saveload&state=${state}${orientation}&still=1`);
        await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready", null, { timeout: 30_000 });
        const slots = await p.evaluate(() =>
          [...document.querySelectorAll(".lm-slot-wrap")].flatMap((w) => {
            const memo = w.querySelector(".lm-slot-memo");
            if (!memo) return [];
            const rect = (e: Element) => e.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number };
            return [{ memo: rect(memo), tools: [...w.querySelectorAll(".lm-slot-tool")].map(rect), text: [...w.querySelectorAll(".lm-slot-text, .lm-slot-sub")].map(rect) }];
          }),
        );
        expect(slots.length, `saveload ${state}${orientation}`).toBeGreaterThan(0);
        for (const s of slots) {
          for (const t of s.tools) expect(overlap(s.memo, t), `saveload ${state}${orientation} のメモとボタン ${JSON.stringify(s)}`).toBe(false);
          for (const t of s.text) expect(overlap(s.memo, t), `saveload ${state}${orientation} のメモと本文 ${JSON.stringify(s)}`).toBe(false);
        }
        // 持ち物: 選んだものの絵は、名前と説明に重ならず、詳しい欄からはみ出さない
        await p.goto(`${base}/?ui-preview=screen&screen=items&state=${state}${orientation}&still=1`);
        await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready", null, { timeout: 30_000 });
        const detail = await p.evaluate(() => {
          const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number };
          return { picture: rect(".lm-items-picture img"), box: rect(".lm-items-picture"), name: rect(".lm-items-name"), desc: rect(".lm-items-desc") };
        });
        expect(overlap(detail.picture, detail.name) || overlap(detail.picture, detail.desc), `items ${state}${orientation} ${JSON.stringify(detail)}`).toBe(false);
        expect(detail.picture.y + detail.picture.height, `items ${state}${orientation} の絵が枠からはみ出す`).toBeLessThanOrEqual(detail.box.y + detail.box.height + 0.5);
      }
    }
    await p.close();
  });

  it("見本は遊ぶ人のセーブ、既読、設定を読まず、書かない", async () => {
    const id = (JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { id: string }).id;
    const p = await context.newPage();
    watch(p);
    // 同じオリジンのページで、遊ぶ人のセーブ（IndexedDB）と前の版の置き場所（localStorage）を置く
    await p.goto(`${base}/manifest.webmanifest`);
    const seed = await p.evaluate(async (prefix) => {
      const record = JSON.stringify({ version: 1, save: { version: 1, position: { unit: "start", index: 0 }, locals: {}, callStack: [], game: {}, stage: {}, seed: 1 }, date: "2026-01-01T00:00:00.000Z", title: "遊ぶ人のセーブ" });
      const db = await new Promise<IDBDatabase>((ok, ng) => {
        const r = indexedDB.open("liminalia", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("saves");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ng(r.error);
      });
      await new Promise<void>((ok, ng) => {
        const tx = db.transaction("saves", "readwrite");
        tx.objectStore("saves").put(record, `${prefix}slot:0`);
        tx.objectStore("saves").put(JSON.stringify({ textSpeed: 99 }), `${prefix}config`);
        tx.oncomplete = () => ok();
        tx.onerror = () => ng(tx.error);
      });
      db.close();
      localStorage.setItem(`${prefix}system`, JSON.stringify({ cg_unlocked: { "player.png": true } }));
      return { record };
    }, `liminalia:${id}:`);
    /** 遊ぶ人の置き場所の中身（IndexedDB の鍵と値、localStorage の liminalia: の鍵と値）。 */
    const dump = () =>
      p.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((ok, ng) => {
          const r = indexedDB.open("liminalia", 1);
          r.onsuccess = () => ok(r.result);
          r.onerror = () => ng(r.error);
        });
        const rows = await new Promise<[string, unknown][]>((ok) => {
          const out: [string, unknown][] = [];
          const c = db.transaction("saves", "readonly").objectStore("saves").openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur) return ok(out);
            out.push([String(cur.key), cur.value]);
            cur.continue();
          };
        });
        db.close();
        const local = Object.keys(localStorage).filter((k) => k.startsWith("liminalia:")).sort().map((k) => [k, localStorage.getItem(k)]);
        return JSON.stringify({ rows: rows.sort(([a], [b]) => a.localeCompare(b)), local });
      });
    const before = await dump();
    expect(before).toContain("遊ぶ人のセーブ");
    // 空のセーブの画面に、遊ぶ人のセーブは出ない（読まない）
    await p.goto(`${base}/?ui-preview=screen&screen=saveload&state=empty&still=1`);
    await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready");
    expect(await count(p.mainFrame(), ".lm-slot:not(.lm-empty)")).toBe(0);
    expect(await text(p.mainFrame(), ".lm-saveload")).not.toContain("遊ぶ人のセーブ");
    // 見本の中で書く操作（セーブスロットを保護する、コンフィグを変える、クイックセーブ）をしても、遊ぶ人の置き場所は変わらない
    await p.goto(`${base}/?ui-preview=screen&screen=saveload&still=1`);
    await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready");
    await p.locator(".lm-slot-tools button", { hasText: "保護" }).first().click();
    await p.goto(`${base}/?ui-preview=screen&screen=message&still=1`);
    await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready");
    await p.keyboard.press("s");
    await p.waitForTimeout(500);
    await p.goto(`${base}/?ui-preview=screen&screen=config&still=1`);
    await p.waitForFunction(() => document.documentElement.dataset.lmScreenPreview === "ready");
    await p.locator(".lm-config button", { hasText: "すべて" }).first().click();
    await p.waitForTimeout(500);
    // ゲームの設定の見本（?ui-preview=save など）も、遊ぶ人のセーブを読まず、本文を読んで既読を付けたりクイックセーブしたりしても書かない
    await p.goto(`${base}/?ui-preview=save`);
    await p.waitForSelector(".lm-saveload", { timeout: 30_000 });
    await p.waitForTimeout(500);
    expect(await text(p.mainFrame(), ".lm-saveload")).not.toContain("遊ぶ人のセーブ");
    for (const preview of ["config", "log"]) {
      await p.goto(`${base}/?ui-preview=${preview}`);
      await p.waitForSelector(".lm-screen", { timeout: 30_000 });
    }
    await p.goto(`${base}/?ui-preview=page`);
    await p.waitForSelector(".message .text", { timeout: 30_000 });
    await p.waitForTimeout(800);
    await p.keyboard.press("s");
    await p.mouse.click(640, 400);
    await p.waitForTimeout(800);
    await p.goto(`${base}/manifest.webmanifest`);
    expect(await dump()).toBe(before);
    expect(seed.record).toContain("遊ぶ人のセーブ");
    await p.close();
  });

  describe("タブ", () => {
    it("一覧に画面を並べ、開けない画面は理由を添えて押せず、プラグインが差し替えた画面に札を出す", async () => {
      await page.evaluate(() => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView("screens"));
      await expect.poll(() => view().getAttribute("data-preview"), { timeout: 30_000 }).toBe("ready");
      expect(await view().locator(".screens-item").count()).toBe(screens.length);
      const gate = view().locator('.screens-item[data-screen="gate"]');
      expect(await gate.getAttribute("aria-disabled")).toBe("true");
      expect(await gate.locator(".screens-why").textContent()).toContain("作品の設定を読む前");
      await expect.poll(() => view().locator('.screens-item[data-screen="help"] .game-flag').textContent()).toContain("look");
      // 開けない画面を押しても、プレビューは変わらない
      const src = await frame().getAttribute("src");
      await gate.dispatchEvent("click");
      expect(await frame().getAttribute("src")).toBe(src);
    });

    it("画面、中身、向き、英語、テーマを切り替えると、その見本を開き直す", async () => {
      await settled(() => view().locator('.screens-item[data-screen="saveload"]').click());
      expect((await frameUrl()).get("screen")).toBe("saveload");
      const inner = frame().contentFrame();
      expect(await inner.locator(".lm-slot:not(.lm-empty)").count()).toBeGreaterThan(0);
      // 作り物の状態を入れるロードで、プラグインのロードの幕を下ろさない（幕でなく画面が見える）
      expect(await inner.locator(".slow-curtain").count()).toBe(0);
      await settled(() => view().locator('.screens-item[data-screen="ending"]').click());
      expect(await inner.locator(".lm-ending").count()).toBe(1);
      expect(await inner.locator(".slow-curtain").count()).toBe(0);
      await settled(() => view().locator('.screens-item[data-screen="saveload"]').click());
      await settled(() => view().locator(".screens-bar .seg", { hasText: "空" }).click());
      expect((await frameUrl()).get("state")).toBe("empty");
      expect(await inner.locator(".lm-slot:not(.lm-empty)").count()).toBe(0);
      // 用意していない状態は押せない
      await settled(() => view().locator('.screens-item[data-screen="config"]').click());
      expect(await view().locator(".screens-bar .seg", { hasText: "空" }).isDisabled()).toBe(true);
      expect((await frameUrl()).get("state")).toBeNull();
      await settled(() => view().locator('.screens-item[data-screen="saveload"]').click());
      await settled(() => view().locator(".screens-bar .seg", { hasText: "中身あり" }).click());
      // 縦長: プレビューの縦横比も変わる
      await settled(() => view().locator(".screens-turn").click());
      expect((await frameUrl()).get("orientation")).toBe("portrait");
      const box = (await frame().boundingBox())!;
      expect(box.height).toBeGreaterThan(box.width);
      expect(await inner.locator(".stage").evaluate((e) => e.classList.contains("lm-portrait"))).toBe(true);
      await settled(() => view().locator(".screens-turn").click());
      // 英語
      await settled(() => view().locator(".screens-english").click());
      expect((await frameUrl()).get("lang")).toBe("en");
      expect(await inner.locator(".lm-saveload").textContent()).toContain("Load");
      await settled(() => view().locator(".screens-english").click());
      // 明るいテーマ（和紙）と暗いテーマ（夜）
      await settled(() => view().locator(".screens-theme").selectOption("washi"));
      expect((await frameUrl()).get("theme")).toBe("washi");
      const light = await inner.locator(".stage").evaluate((e) => getComputedStyle(e).getPropertyValue("--lm-screen-bg"));
      await settled(() => view().locator(".screens-theme").selectOption("night"));
      expect(await inner.locator(".stage").evaluate((e) => getComputedStyle(e).getPropertyValue("--lm-screen-bg"))).not.toBe(light);
      await settled(() => view().locator(".screens-theme").selectOption(""));
      expect((await frameUrl()).get("theme")).toBeNull();
      // テーマの見本は作品の liminalia.json を書き換えない
      expect((JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: unknown }).ui).toBeUndefined();
    });

    it("liminalia.json とプラグインの CSS を保存すると、開いている画面が読み込み直さずにその場で直る", async () => {
      const inner = frame().contentFrame();
      const pages = () => inner.locator(".lm-saveload button").filter({ hasText: /^[0-9]+$/ }).count();
      await expect.poll(pages, { timeout: 30_000 }).toBe(6);
      // 読み込み直したら消える印
      await inner.locator("body").evaluate(() => ((window as unknown as { __kept?: number }).__kept = 1));
      const file = join(dir, "liminalia.json");
      const cfg = JSON.parse(readFileSync(file, "utf8")) as { ui?: Record<string, unknown> };
      cfg.ui = { ...cfg.ui, saveSlots: 16 };
      writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      await expect.poll(pages, { timeout: 30_000 }).toBe(2);
      const name = inner.locator(".lm-slot-name").first();
      expect(await name.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(1, 2, 3)");
      writeFileSync(join(dir, "plugins/look/src/look.css"), CSS("rgb(4, 5, 6)"));
      await expect.poll(() => name.evaluate((e) => getComputedStyle(e).color), { timeout: 30_000 }).toBe("rgb(4, 5, 6)");
      expect(await inner.locator("body").evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
    });
  });

  describe("部品を選ぶ", () => {
    const panel = () => view().locator(".screens-panel");
    const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: { system?: { radius?: number; accent?: string } } };
    const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
    /** 見本の中の要素の真ん中を、プレビューの上に重ねた層の上から押す。 */
    const pickAt = async (selector: string) => {
      const box = (await frame().contentFrame().locator(selector).first().boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };

    it("見本の部品を押すと、その部品を枠で示し、効くテーマの値の欄と、同じ値が効くほかの部品と画面を出す", async () => {
      await settled(() => view().locator('.screens-item[data-screen="title"]').click());
      expect(await panel().locator(".screens-empty").textContent()).toContain("部品を押してください");
      await pickAt(".lm-title-button");
      await expect.poll(() => view().locator(".screens-pick").getAttribute("data-picked")).toBe(".lm-title-button");
      expect(await panel().locator(".screens-part-select").inputValue()).toBe(".lm-title-button");
      // 枠は押した部品に重なる（枠は選んだあとに描くので、描き終えるまで待つ。全体を並べて流すと、描く前に読んで null になっていた）
      const gap = async () => {
        const picked = await view().locator(".screens-box.is-picked").boundingBox();
        const button = await frame().contentFrame().locator(".lm-title-button").first().boundingBox();
        return picked && button ? Math.abs(picked.x - button.x) + Math.abs(picked.y - button.y) + Math.abs(picked.width - button.width) : Number.POSITIVE_INFINITY;
      };
      await expect.poll(gap, { timeout: 10_000 }).toBeLessThan(3);
      // 色は色の欄、大きさは数の欄（CSS の生の値を並べない）
      expect(await panel().locator('[data-field="system.titleButtonBg"] input[type="color"]').count()).toBe(1);
      expect(await panel().locator('[data-field="system.radius"] input[type="number"]').count()).toBe(1);
      // ui.system の値は、ほかのシステム画面にも効く
      expect(await panel().locator('[data-field="system.radius"] .screens-also').textContent()).toContain("メニュー");
      // 押した所の部品を選ぶ（題名）
      await pickAt(".lm-title-name");
      await expect.poll(() => panel().locator(".screens-part-select").inputValue()).toBe(".lm-title-name");
      await pickAt(".lm-title-button");
      await expect.poll(() => panel().locator(".screens-part-select").inputValue()).toBe(".lm-title-button");
    });

    it("欄を変えると保存する前に見本が変わり、決めると liminalia.json の ui に書き、⌘Z で元に戻る", async () => {
      const before = config().ui?.system?.radius;
      expect(before).toBeUndefined();
      const radius = panel().locator('[data-field="system.radius"] input.game-number');
      const inner = frame().contentFrame().locator(".lm-title-button").first();
      // 打っている間（input）は見本だけが変わる
      await radius.fill("15");
      await expect.poll(() => inner.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe("15px");
      expect(config().ui?.system?.radius).toBeUndefined();
      // 決める（change）と書く
      await radius.evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(() => config().ui?.system?.radius, { timeout: 10_000 }).toBe(15);
      // 色の欄（色を選び終えたとき）
      await panel().locator('[data-field="system.titleButtonBg"] input.game-color-text').fill("#224466");
      await panel().locator('[data-field="system.titleButtonBg"] input.game-color-text').evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(() => (config().ui?.system as Record<string, unknown> | undefined)?.titleButtonBg, { timeout: 10_000 }).toBe("#224466");
      await expect.poll(() => inner.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(34, 68, 102)");
      // このタブの ⌘Z で、新しいものから一つずつ元に戻る
      await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(undoKey);
      await expect.poll(() => (config().ui?.system as Record<string, unknown> | undefined)?.titleButtonBg, { timeout: 10_000 }).toBeUndefined();
      expect(config().ui?.system?.radius).toBe(15);
      await page.keyboard.press(undoKey);
      await expect.poll(() => config().ui?.system?.radius, { timeout: 10_000 }).toBeUndefined();
      // 欄も見本も戻る
      await expect.poll(() => panel().locator('[data-field="system.radius"] input.game-number').inputValue()).toBe("");
      await expect.poll(() => inner.evaluate((e) => getComputedStyle(e).borderTopLeftRadius), { timeout: 10_000 }).not.toBe("15px");
    });

    it("テーマの値が無い部品は、セレクタと書く先の CSS のファイルを一行で出し、CSS の欄を出す", async () => {
      await settled(() => view().locator('.screens-item[data-screen="menu"]').click());
      // 画面を替えると、選んでいた部品は外れる
      expect(await panel().locator(".screens-part-select").inputValue()).toBe("");
      await panel().locator(".screens-part-select").selectOption(".lm-menu");
      const note = panel().locator(".screens-novalues");
      expect(await note.count()).toBe(1);
      expect(await note.textContent()).toContain(".lm-menu");
      expect(await note.textContent()).toContain("ui/screens.css");
      expect(await note.textContent()).not.toContain("0.4.0");
      // CSS を知らなくても選べる欄（色は色の欄、長さは数の欄）
      expect(await panel().locator('[data-field="css:background-color"] input[type="color"]').count()).toBe(1);
      expect(await panel().locator('[data-field="css:padding"] input[type="number"]').count()).toBe(1);
      expect(await panel().locator('[data-field="css:border-radius"] input[type="number"]').count()).toBe(1);
    });

    it("CSS の欄を変えると保存する前に見本が変わり、決めると作品の CSS に一行を書き、同じ行は書き換え、⌘Z で元に戻る", async () => {
      const css = join(dir, "ui", "screens.css");
      const read = () => (existsSync(css) ? readFileSync(css, "utf8") : null);
      const listed = () => (JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: { css?: string[] } }).ui?.css;
      expect(read()).toBeNull();
      const padding = panel().locator('[data-field="css:padding"] input.game-number');
      const menu = frame().contentFrame().locator(".lm-menu").first();
      const before = await menu.evaluate((e) => getComputedStyle(e).paddingTop);
      // 打っている間（input）は見本だけが変わる
      await padding.fill("17");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop)).toBe("17px");
      expect(read()).toBeNull();
      // 決めると ui/screens.css を作って一行を書き、ui.css に足す
      await padding.evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 17px; }\n");
      expect(listed()).toEqual(["ui/screens.css"]);
      // 同じセレクタと性質の行は書き換える
      await panel().locator('[data-field="css:padding"] input.game-number').fill("21");
      await panel().locator('[data-field="css:padding"] input.game-number').evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 21px; }\n");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop), { timeout: 10_000 }).toBe("21px");
      // 色の欄（背景色）は二行目
      await panel().locator('[data-field="css:background-color"] input.game-color-text').fill("#224466");
      await panel().locator('[data-field="css:background-color"] input.game-color-text').evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 21px; }\n.lm-menu { background-color: #224466; }\n");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).backgroundColor), { timeout: 10_000 }).toBe("rgb(34, 68, 102)");
      // このタブの ⌘Z で、新しいものから一つずつ元に戻る（作ったファイルと ui.css も）
      await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(undoKey);
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 21px; }\n");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).backgroundColor), { timeout: 10_000 }).not.toBe("rgb(34, 68, 102)");
      await page.keyboard.press(undoKey);
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 17px; }\n");
      await page.keyboard.press(undoKey);
      await expect.poll(read, { timeout: 10_000 }).toBeNull();
      expect(listed()).toBeUndefined();
      // 欄も見本も戻る
      await expect.poll(() => panel().locator('[data-field="css:padding"] input.game-number').inputValue(), { timeout: 10_000 }).toBe("");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop), { timeout: 10_000 }).toBe(before);
    });

    it("「部品を選ぶ」を切ると、見本の中を押して操作できる", async () => {
      await view().locator(".screens-pick-toggle").click();
      expect(await view().locator(".screens-pick").evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("none");
      await view().locator(".screens-pick-toggle").click();
      expect(await view().locator(".screens-pick").evaluate((e) => getComputedStyle(e).pointerEvents)).not.toBe("none");
    });
  });

  describe("CSS の欄", () => {
    const panel = () => view().locator(".screens-panel");
    const editor = () => panel().locator(".screens-css-editor .cm-content");
    const cssPath = () => join(dir, "ui", "screens.css");
    const read = () => (existsSync(cssPath()) ? readFileSync(cssPath(), "utf8") : null);
    const listed = () => (JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: { css?: string[] } }).ui?.css;
    const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
    const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
    const doc = () => editor().evaluate((e) => [...e.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
    /** 欄の中身を置き換える（打った文字として。括弧を閉じる補いは働かない）。 */
    const replace = async (text: string) => {
      await editor().click();
      await page.keyboard.press(selectAll);
      await page.keyboard.press("Backspace");
      if (text) await page.keyboard.insertText(text);
    };
    /** 見本の要素の中の、左上から少し入った所を押す。 */
    const pickCorner = async (selector: string) => {
      const box = (await frame().contentFrame().locator(selector).first().boundingBox())!;
      await page.mouse.click(box.x + 6, box.y + 6);
    };

    it("部品の欄と CSS の欄を切り替えられ、CSS の欄は空のファイルから書ける", async () => {
      await settled(() => view().locator('.screens-item[data-screen="menu"]').click());
      expect(read()).toBeNull();
      await panel().locator('.screens-modes .seg[data-mode="css"]').click();
      expect(await panel().getAttribute("data-mode")).toBe("css");
      expect(await panel().locator(".screens-part-body").isHidden()).toBe(true);
      expect(await editor().isVisible()).toBe(true);
      expect(await panel().locator(".screens-css-head").first().textContent()).toContain("ui/screens.css");
      expect(await doc()).toBe("");
    });

    it("書くと保存する前に見本が変わり、少し待って ui.css のファイルに書き、⌘Z で戻る", async () => {
      // 保存の頼み（PUT /ui/css）をページの中で止めておき、保存する前に見本が変わることを確かめる
      await page.evaluate(() => {
        const w = window as unknown as { __release?: () => void; __fetch?: typeof fetch };
        const gate = new Promise<void>((r) => (w.__release = r));
        w.__fetch = window.fetch;
        window.fetch = async (input, init) => {
          if (init?.method === "PUT" && String(input).endsWith("/ui/css")) await gate;
          return w.__fetch!(input, init);
        };
      });
      const menu = frame().contentFrame().locator(".lm-menu").first();
      const before = await menu.evaluate((e) => getComputedStyle(e).paddingTop);
      await replace(".lm-menu { padding: 23px; }\n");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop), { timeout: 10_000 }).toBe("23px");
      expect(read()).toBeNull();
      await page.evaluate(() => {
        const w = window as unknown as { __release?: () => void; __fetch?: typeof fetch };
        w.__release!();
        window.fetch = w.__fetch!;
      });
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 23px; }\n");
      expect(listed()).toEqual(["ui/screens.css"]);
      // 欄の中の ⌘Z は書いた文字を戻し（CodeMirror の履歴）、戻したものも保存する
      for (let i = 0; i < 5 && (await doc()) !== ""; i++) await page.keyboard.press(undoKey);
      expect(await doc()).toBe("");
      await expect.poll(read, { timeout: 10_000 }).toBe("");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop), { timeout: 10_000 }).toBe(before);
      // 欄の外の ⌘Z（このタブの元に戻す）は、保存したものを一つずつ戻す（作ったファイルと ui.css も）
      await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(undoKey);
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 23px; }\n");
      await expect.poll(doc, { timeout: 10_000 }).toBe(".lm-menu { padding: 23px; }\n");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop), { timeout: 10_000 }).toBe("23px");
      await page.keyboard.press(undoKey);
      await expect.poll(read, { timeout: 10_000 }).toBeNull();
      expect(listed()).toBeUndefined();
      await expect.poll(doc, { timeout: 10_000 }).toBe("");
      await expect.poll(() => menu.evaluate((e) => getComputedStyle(e).paddingTop), { timeout: 10_000 }).toBe(before);
    });

    it("部品の欄が書いた一行も CSS の欄で読める", async () => {
      await panel().locator('.screens-modes .seg[data-mode="part"]').click();
      await pickCorner(".lm-menu");
      await expect.poll(() => panel().locator(".screens-part-select").inputValue()).toBe(".lm-menu");
      await panel().locator('[data-field="css:padding"] input.game-number').fill("19");
      await panel().locator('[data-field="css:padding"] input.game-number').evaluate((e) => (e as HTMLElement).blur());
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 19px; }\n");
      await panel().locator('.screens-modes .seg[data-mode="css"]').click();
      await expect.poll(doc, { timeout: 10_000 }).toBe(".lm-menu { padding: 19px; }\n");
      // 選んでいた部品の規則を示す
      expect(await panel().locator(".cm-line.screens-css-hit").first().textContent()).toContain(".lm-menu");
    });

    it("補完に部品のクラス名（部品の名前を添えて）、--lm-* の変数、状態の属性が出る", async () => {
      const menuScreen = screens.find((s) => s.id === "menu")!;
      const panelPart = menuScreen.parts.find((p) => p.selector === ".lm-menu-panel")!;
      const options = () => page.locator(".cm-tooltip-autocomplete li");
      const labels = async () => (await options().locator(".cm-completionLabel").allTextContents());
      await replace("");
      await page.keyboard.type(".lm-menu-p");
      await expect.poll(labels, { timeout: 10_000 }).toContain(".lm-menu-panel");
      const item = options().filter({ hasText: ".lm-menu-panel" }).first();
      expect(await item.locator(".cm-completionDetail").textContent()).toBe(panelPart.name.ja);
      // 開いている画面のものを先に（ほかの画面のクラス名も出る）
      await page.keyboard.press("Escape");
      await replace("");
      await page.keyboard.type(".lm-s");
      await expect.poll(labels, { timeout: 10_000 }).toContain(".lm-slot-name");
      await page.keyboard.press("Escape");
      // 変数（システム画面の共通の変数と、テーマの値が入る変数）
      await replace(".lm-menu { color: var(");
      await page.keyboard.type("--lm-ac");
      await expect.poll(labels, { timeout: 10_000 }).toContain("--lm-accent");
      await page.keyboard.press("Escape");
      await replace(".lm-menu { background: var(");
      await page.keyboard.type("--lm-control-h");
      await expect.poll(labels, { timeout: 10_000 }).toContain("--lm-control-hover");
      await page.keyboard.press("Escape");
      // エンジンが書く状態の属性
      await replace(".lm-button[");
      await page.keyboard.type("data-lm-h");
      await expect.poll(labels, { timeout: 10_000 }).toContain("data-lm-hover");
      await page.keyboard.press("Escape");
      // CSS の性質（@codemirror/lang-css の補完）
      await replace(".lm-menu {\n  ");
      await page.keyboard.type("backgro");
      await expect.poll(labels, { timeout: 10_000 }).toContain("background-color");
      await page.keyboard.press("Escape");
      await replace(".lm-menu { padding: 19px; }\n");
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 19px; }\n");
    });

    it("見本で部品を押すとその規則へ移り（無ければ足す場所を示し）、規則にカーソルを置くと見本で枠を示す", async () => {
      await replace(".lm-menu {\n  padding: 19px;\n}\n\n.lm-button {\n  letter-spacing: 1px;\n}\n");
      await expect.poll(read, { timeout: 10_000 }).toContain(".lm-button {");
      await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      // 規則のある部品
      const button = frame().contentFrame().locator(".lm-button").first();
      const b = (await button.boundingBox())!;
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await expect.poll(() => panel().locator(".cm-line.screens-css-hit").first().textContent(), { timeout: 10_000 }).toBe(".lm-button {");
      // 規則の無い部品は、終わりに足す場所を示し、押すと足す
      await pickCorner(".lm-menu-panel");
      const add = panel().locator('.screens-css-add[data-selector=".lm-menu-panel"]');
      await expect.poll(() => add.count(), { timeout: 10_000 }).toBe(1);
      await add.click();
      await expect.poll(doc).toContain(".lm-menu-panel {");
      await expect.poll(read, { timeout: 10_000 }).toContain(".lm-menu-panel {");
      // 規則の中にカーソルを置くと、見本でその部品を枠で示す
      await panel().locator(".cm-line", { hasText: "letter-spacing" }).click();
      const box = view().locator(".screens-box.is-css").first();
      const gap = async () => {
        const shown = await box.boundingBox();
        return shown ? Math.abs(shown.x - b.x) + Math.abs(shown.y - b.y) + Math.abs(shown.width - b.width) : Infinity;
      };
      await expect.poll(gap, { timeout: 10_000 }).toBeLessThan(3);
      expect(await view().locator(".screens-box.is-css").count()).toBe(await frame().contentFrame().locator(".lm-button").count());
    });

    it("読めない CSS と、作品の外を指す url() に波線を出す", async () => {
      await replace(".lm-menu { background-image: url(https://example.com/a.png); }\n");
      await expect.poll(() => panel().locator(".cm-lintRange-error").count(), { timeout: 10_000 }).toBe(1);
      expect(await panel().locator(".cm-lintRange-error").first().textContent()).toContain("url(https://example.com/a.png)");
      await replace(".lm-menu { padding: 19px;\n");
      await expect.poll(() => panel().locator(".cm-lintRange-error").count(), { timeout: 10_000 }).toBe(1);
      // 直すと消える
      await replace(".lm-menu { padding: 19px; }\n");
      await expect.poll(() => panel().locator(".cm-lintRange-error").count(), { timeout: 10_000 }).toBe(0);
      await expect.poll(read, { timeout: 10_000 }).toBe(".lm-menu { padding: 19px; }\n");
      await panel().locator('.screens-modes .seg[data-mode="part"]').click();
    });
  });

  it("ページの例外とエラーが出ていない", () => {
    expect(errors).toEqual([]);
  });
});
