import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { mainActivity } from "../../../cli/src/mobile/android.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 遊ぶ側の操作の足し分（既定のキー、ホイールを押す、数字のキーで選ぶ、クイックセーブの枠など）を、実際のブラウザで確かめる。
 */

const SCENARIO = `@window show
いちページめ。
にページめ。
さんページめ。
@choice
- 甲を選ぶ -> #a
- 乙を選ぶ -> #b
@end
# a
甲のページ。
よんページめ。
# b
乙のページ。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`) as Promise<string>;
const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 15_000 });
const sys = (p: Page, expr: string) => p.evaluate(`(() => { const s = window.__liminalia.system; return ${expr}; })()`);

describe.skipIf(!e2e)("遊ぶ側の操作の足し分（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  async function open(browser: Browser): Promise<Page> {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${project.url}?autostart=1&start=a`);
    await waitText(p, "いちページめ");
    return p;
  }

  it("既定のキー: Tab でスキップ、A でオート、H でウィンドウを消す、ホイールを押して戻す、数字のキーで選択肢を選ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.keyboard.press("a");
      expect(await sys(p, "s.toggles.auto"), name).toBe(true);
      await p.keyboard.press("a");
      expect(await sys(p, "s.toggles.auto"), name).toBe(false);
      await p.keyboard.press("h");
      expect(await sys(p, "s.toggles.hidden"), name).toBe(true);
      // WebKit の Playwright は、ポインタを動かしておかないと押した先が文書になる
      await p.mouse.move(640, 300);
      await p.mouse.click(640, 300, { button: "middle" });
      expect(await sys(p, "s.toggles.hidden"), name).toBe(false);
      await p.mouse.click(640, 300, { button: "middle" });
      expect(await sys(p, "s.toggles.hidden"), name).toBe(true);
      await p.keyboard.press("Delete");
      expect(await sys(p, "s.toggles.hidden"), name).toBe(false);
      // Tab のスキップは未読で止まるので、選択肢までは送りで進める
      await p.keyboard.press("Tab");
      expect(await sys(p, "s.toggles.skip"), name).toBe(true);
      await p.keyboard.press("Tab");
      expect(await sys(p, "s.toggles.skip"), name).toBe(false);
      await p.keyboard.press("Enter");
      await waitText(p, "にページめ");
      await p.keyboard.press("Enter");
      await waitText(p, "さんページめ");
      await p.keyboard.press("Enter");
      await p.waitForSelector(".choices button");
      await p.keyboard.press("2");
      await waitText(p, "乙のページ");
      await p.close();
    }
  });

  it("ゲームパッド: RT でオート、L3 でスキップ、十字キーの右でクイックセーブ、左でクイックロード（確認してから）。表記を PlayStation にできる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __pad: boolean[] };
        w.__pad = Array(16).fill(false);
        navigator.getGamepads = () => [{ id: "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)", buttons: w.__pad.map((pressed) => ({ pressed, value: pressed ? 1 : 0 })), axes: [0, 0] } as unknown as Gamepad];
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いちページめ");
      await p.evaluate("window.__liminalia.saves.clear()");
      // ボタンを押したまま、遊ぶ側が受け取るまで待ってから離す（CI の重い WebKit では 120ms 押しただけだと読み逃すことがあった）
      const pad = async (i: number, until?: string) => {
        await p.evaluate(`window.__pad[${i}] = true`);
        if (until) await p.waitForFunction(`(() => { const s = window.__liminalia.system; return ${until}; })()`, undefined, { polling: 30, timeout: 5000 }).catch(() => undefined);
        else await p.waitForTimeout(120);
        await p.evaluate(`window.__pad[${i}] = false`);
        // 離したことを遊ぶ側が読むまで待つ（読み取りは描画ごと。CI の WebKit は描画の間が長く、150ms では次の押下が押しっぱなしに見えた）
        await p.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))))");
        await p.waitForTimeout(50);
      };
      await pad(7, "s.toggles.auto");
      expect(await sys(p, "s.toggles.auto"), name).toBe(true);
      await pad(7, "!s.toggles.auto");
      expect(await sys(p, "s.toggles.auto"), name).toBe(false);
      await pad(10, "s.toggles.skip");
      expect(await sys(p, "s.toggles.skip"), name).toBe(true);
      await pad(10, "!s.toggles.skip");
      expect(await sys(p, "s.toggles.skip"), name).toBe(false);
      await pad(15, "s.quickSlots().some((x) => !x.empty)");
      expect(await sys(p, "s.quickSlots().filter((x) => !x.empty).length"), name).toBe(1);
      await p.keyboard.press("Enter");
      await waitText(p, "にページめ");
      await pad(14);
      await p.waitForSelector(".lm-dialog");
      await p.locator(".lm-dialog .lm-primary").click();
      await waitText(p, "いちページめ");
      // 操作説明は PlayStation の表記（つないだゲームパッドから決める）
      await sys(p, 's.perform("help")');
      const help = await p.locator(".lm-help").textContent();
      expect(help, name).toContain("R2");
      expect(help, name).toContain("L3");
      await p.close();
    }
  });

  it("⌘+C（Ctrl+C）で、文字を選んでいなければ今のページの本文をコピーし、バックログの本文は選べる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __copied: string[] };
        w.__copied = [];
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void w.__copied.push(t) }, configurable: true });
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いちページめ");
      await p.keyboard.press("Meta+c");
      await p.waitForFunction("window.__copied.length === 1");
      expect(await p.evaluate("window.__copied[0]"), name).toBe("いちページめ。");
      await sys(p, 's.perform("backlog")');
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".lm-log-text")).userSelect`), name).toBe("text");
      await p.close();
    }
  });

  it("コンフィグを開いたまま M キーでミュートすると、コンフィグの「ミュート」も変わる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await sys(p, 's.perform("config")');
      await p.locator(".lm-tab", { hasText: "サウンド" }).click();
      const row = p.locator(".lm-config-row").filter({ has: p.locator(".lm-config-label", { hasText: /^ミュート$/ }) });
      const pressed = () => row.locator('.lm-toggle[aria-pressed="true"]').textContent();
      expect(await pressed(), name).toBe("オフ");
      await p.keyboard.press("m");
      expect(await pressed(), name).toBe("オン");
      await p.keyboard.press("m");
      expect(await pressed(), name).toBe("オフ");
      await p.close();
    }
  });

  it("コンフィグの「選択肢のあとのオート」が「続ける」なら、選んだあともオートを続ける（既定は止めたまま）", async () => {
    for (const { name, browser } of list) {
      for (const keep of [false, true]) {
        const p = await open(browser);
        await sys(p, `s.updateSettings({ autoWait: 500, autoAfterChoice: ${keep} })`);
        await sys(p, 's.perform("auto")');
        await p.waitForSelector(".choices button", { timeout: 15_000 });
        expect(await sys(p, "s.toggles.auto"), name).toBe(false);
        await p.locator(".choices button", { hasText: "甲を選ぶ" }).click();
        await waitText(p, "甲のページ");
        expect(await sys(p, "s.toggles.auto"), `${name} ${keep}`).toBe(keep);
        if (keep) await waitText(p, "よんページめ");
        await p.close();
      }
    }
  });

  it("タブを裏へ回すとオートと音を止め、戻ったら続ける", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate(`(() => { const c = window.__liminalia.host.audio.context; window.__ctx = []; const s = c.suspend.bind(c), r = c.resume.bind(c); c.suspend = () => (window.__ctx.push("suspend"), s()); c.resume = () => (window.__ctx.push("resume"), r()); })()`);
      const visibility = (state: string) => p.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
      await sys(p, "s.updateSettings({ autoWait: 500 })");
      await sys(p, 's.perform("auto")');
      await visibility("hidden");
      await p.waitForTimeout(1800);
      expect(await text(p), name).toContain("いちページめ");
      await visibility("visible");
      await waitText(p, "にページめ");
      expect(await p.evaluate("window.__ctx"), name).toEqual(["suspend", "resume"]);
      await sys(p, 's.perform("auto")');
      await p.close();
    }
  });

  it("スマホ版のアプリの口があれば、スクリーンショットとセーブデータのエクスポートを中身ごと渡す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __saved: [string, string, string][]; LiminaliaFiles: unknown };
        w.__saved = [];
        w.LiminaliaFiles = { save: (n: string, m: string, b: string) => (w.__saved.push([n, m, b]), true) };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いちページめ");
      await sys(p, 's.perform("screenshot")');
      await p.waitForFunction("window.__saved.length === 1");
      const [shot, mime, data] = (await p.evaluate("window.__saved[0]")) as [string, string, string];
      expect(shot, name).toMatch(/\.png$/);
      expect(mime, name).toBe("image/png");
      expect(Buffer.from(data, "base64").subarray(1, 4).toString(), name).toBe("PNG");
      // コンフィグの「セーブデータをエクスポート」
      await sys(p, 's.perform("config")');
      await p.locator(".lm-button", { hasText: "セーブデータをエクスポート" }).click();
      await p.waitForFunction("window.__saved.length === 2");
      const [file, type, json] = (await p.evaluate("window.__saved[1]")) as [string, string, string];
      expect(file, name).toMatch(/-saves-\d{8}\.json$/);
      expect(type, name).toBe("application/json");
      expect(JSON.parse(Buffer.from(json, "base64").toString()).format, name).toBe("liminalia-saves");
      await p.close();
    }
  });

  it("クイックセーブは枠を回し、クイックロードはいちばん新しい枠から読む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate("window.__liminalia.saves.clear()");
      await p.keyboard.press("s");
      await p.keyboard.press("Enter");
      await waitText(p, "にページめ");
      await p.keyboard.press("s");
      expect(await sys(p, "s.quickSlots().filter((x) => !x.empty).map((x) => x.slot)"), name).toEqual(["quick:1", "quick"]);
      await p.keyboard.press("Enter");
      await waitText(p, "さんページめ");
      await p.keyboard.press("l");
      await waitText(p, "にページめ");
      expect(await text(p), name).toContain("にページめ");
      // ロード画面の「Q」のタブに新しい順に並ぶ
      await sys(p, 's.perform("load")');
      await p.locator(".lm-tab", { hasText: "Q" }).click();
      const names = await p.locator(".lm-slot-name").allTextContents();
      expect(names, name).toEqual(["クイック 2", "クイック", "クイック 3"]);
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("今のページのボイスをもう一度鳴らす（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const voice = resolve(import.meta.dirname, "../fixtures/loop-opus.ogg");
    project = await startProject({
      scenario: { a: "@window show\n@voice v1.ogg\nゆい「ボイスのあるページ。」\nボイスのないページ。\n" },
      config: { entry: "a", ui: { menuBar: { items: ["replay-voice", "backlog"] } } },
      files: { "assets/voice/v1.ogg": voice },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("V キーとクイックメニューで鳴らし直し、ボイスの無いページではボタンを押せない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "ボイスのあるページ");
      await p.evaluate(`(() => { const a = window.__liminalia.host.audio; window.__played = []; const play = a.playVoice.bind(a); a.playVoice = (k, f, ...r) => { window.__played.push(f); return play(k, f, ...r); }; })()`);
      await p.keyboard.press("v");
      expect(await p.evaluate("window.__played.splice(0)"), name).toEqual(["v1.ogg"]);
      const button = p.locator('.lm-menubar button[data-action="replay-voice"]');
      expect(await button.isDisabled(), name).toBe(false);
      await button.click();
      expect(await p.evaluate("window.__played.splice(0)"), name).toEqual(["v1.ogg"]);
      await p.keyboard.press("Enter");
      await waitText(p, "ボイスのないページ");
      expect(await button.isDisabled(), name).toBe(true);
      await p.keyboard.press("v");
      expect(await p.evaluate("window.__played.splice(0)"), name).toEqual([]);
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("言語を切り替えると <html lang> も替える（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "@window show\nいち。\n" }, config: { entry: "a", languages: ["ja", "en"] } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("コンフィグで英語にすると en、日本語に戻すと ja", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いち");
      expect(await p.evaluate("document.documentElement.lang"), name).toBe("ja");
      await sys(p, 's.updateSettings({ language: "en" })');
      expect(await p.evaluate("document.documentElement.lang"), name).toBe("en");
      await sys(p, 's.updateSettings({ language: "ja" })');
      expect(await p.evaluate("document.documentElement.lang"), name).toBe("ja");
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("コマンドの文字と作品の設定の文字の訳（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const { projectTextKey, translationKey } = await import("@liminalia/lang");
    project = await startProject({
      scenario: { a: '@window show\n@layer-text "第一章" name=t\n@achieve star\nいち。\n' },
      config: { entry: "a", languages: ["ja", "en"], extra: { achievements: [{ id: "star", title: "流れ星" }] }, ui: { text: { size: 30 }, languages: { en: { text: { size: 22 } } } } },
      before: (dir) => {
        mkdirSync(join(dir, "lang"), { recursive: true });
        const lines = {
          [translationKey("a", "arg", "第一章")]: { source: "第一章", text: "Chapter One" },
          [projectTextKey("流れ星")]: { source: "流れ星", text: "Shooting Star" },
          [translationKey("a", "line", "いち。")]: { source: "いち。", text: "One." },
        };
        writeFileSync(join(dir, "lang", "en.json"), JSON.stringify({ language: "en", lines }));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("英語で遊ぶと、@layer-text の文字と実績の題が訳に替わり、本文の大きさが英語のものになる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "One.");
      expect(await p.evaluate("document.querySelector('.stage').textContent.includes('Chapter One')"), name).toBe(true);
      expect(await p.evaluate("document.querySelector('.stage').textContent.includes('第一章')"), name).toBe(false);
      expect(await p.evaluate("[...document.querySelectorAll('.lm-toast')].map((e) => e.textContent).join(' ')"), name).toContain("Shooting Star");
      // コンプリート率（実績は 1 / 1、既読は台本から作ったフローチャートで数える）
      expect(await sys(p, "s.completion().then((c) => [c.achievements, c.read && c.read.total > 0, c.rate])"), name).toEqual([{ done: 1, total: 1 }, true, expect.any(Number)]);
      // 言語ごとの見た目（ui.languages）: 英語では本文の大きさが 22px、日本語に戻すと 30px
      expect(await p.evaluate("document.querySelector('.stage').style.getPropertyValue('--text-size')"), name).toBe("22px");
      await sys(p, 's.updateSettings({ language: "ja" })');
      expect(await p.evaluate("document.querySelector('.stage').style.getPropertyValue('--text-size')"), name).toBe("30px");
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("テキスト読み上げ（ブラウザ。端末の声は真似る）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "@window show\n{r 黄昏|たそがれ}の声と{r 本気|・・}の話。\nつぎのページ。\n" }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("ルビの読みで読み、オートは読み終えてから送る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __spoken: string[]; __utter: EventTarget | null; __finish(): void; SpeechSynthesisUtterance?: unknown };
        w.__spoken = [];
        w.__utter = null;
        if (typeof w.SpeechSynthesisUtterance !== "function") {
          w.SpeechSynthesisUtterance = class extends EventTarget {
            lang = "";
            constructor(readonly text: string) {
              super();
            }
          };
        }
        const fake = {
          speaking: false,
          pending: false,
          speak(u: EventTarget & { text: string }) {
            fake.speaking = true;
            w.__spoken.push(u.text);
            w.__utter = u;
          },
          cancel() {
            fake.speaking = false;
          },
          pause() {},
          resume() {},
        };
        w.__finish = () => {
          fake.speaking = false;
          (w.__utter as unknown as { onend?: () => void } | null)?.onend?.();
        };
        Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "黄昏");
      await sys(p, "s.updateSettings({ selfVoicing: true, autoWait: 500 })");
      // 設定より前に出し終えたページは、読み直させる
      await sys(p, "(s.waitingChanged(true), 0)");
      expect(await p.evaluate("window.__spoken.at(-1)"), name).toBe("たそがれの声と本気の話。");
      await sys(p, 's.perform("auto")');
      await p.waitForTimeout(1800);
      expect(await text(p), name).toContain("黄昏");
      await p.evaluate("window.__finish()");
      await waitText(p, "つぎのページ");
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("セーブスロットの章の名前とプレイ時間（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: "@window show\nいち。\n# two\nに。\nさん。\n" },
      config: { entry: "a", ui: { chapterNames: { "a#two": "第二章 星を待つ丘" } } },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("ラベルかファイルの名前から章の名前を決め、プレイ時間はロードしたセーブから続ける", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いち");
      await sys(p, "s.saveTo(0)");
      await p.keyboard.press("Enter");
      await waitText(p, "に");
      await p.waitForTimeout(400);
      await sys(p, "s.saveTo(1)");
      const [a, b] = (await sys(p, "[s.slot(0), s.slot(1)]")) as { chapter?: string; playTime?: number }[];
      expect(a!.chapter, name).toBe("a");
      expect(b!.chapter, name).toBe("第二章 星を待つ丘");
      expect(b!.playTime!, name).toBeGreaterThanOrEqual(a!.playTime! + 300);
      // ロードしたら、そのセーブのプレイ時間から続ける
      await p.evaluate("(() => { const saves = window.__liminalia.saves; const [k, v] = Object.entries(saves.entries()).find(([k]) => k.endsWith(':slot:1')); const r = JSON.parse(v); r.playTime = 3 * 3600000 + 5 * 60000; saves.set(k, JSON.stringify(r)); })()");
      await sys(p, "s.loadFrom(1)");
      await waitText(p, "に");
      await sys(p, "s.saveTo(2)");
      expect(((await sys(p, "s.slot(2)")) as { playTime: number }).playTime, name).toBeGreaterThanOrEqual(3 * 3600000 + 5 * 60000);
      await sys(p, 's.perform("save")');
      expect(await p.locator(".lm-slot-chapter").allTextContents(), name).toEqual(["a", "第二章 星を待つ丘", "第二章 星を待つ丘"]);
      expect(await p.locator(".lm-slot-time").nth(2).textContent(), name).toBe("プレイ時間 3時間5分");
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("セーブの縮小画像に立ち絵の反転と色調を写す（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: "@window show\n@chara アカリ at=center\nいち。\n@chara アカリ flip=true\nに。\n@chara アカリ flip=false\n@tone mono\nさん。\n" },
      config: { entry: "a" },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("反転した立ち絵は縮小画像でも左右が逆になり、白黒の色調は彩度が落ちる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いち");
      await p.waitForTimeout(300);
      await sys(p, "s.saveTo(0)");
      await p.keyboard.press("Enter");
      await waitText(p, "に");
      await p.waitForTimeout(300);
      await sys(p, "s.saveTo(1)");
      await p.keyboard.press("Enter");
      await waitText(p, "さん");
      await p.waitForTimeout(300);
      await sys(p, "s.saveTo(2)");
      const r = (await p.evaluate(`(async () => {
        const s = window.__liminalia.system;
        const pixels = async (url) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = 256; c.height = 144;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0, 256, 144);
          return g.getImageData(0, 0, 256, 144).data;
        };
        const [a, b, c] = await Promise.all([0, 1, 2].map((n) => pixels(s.slot(n).thumb)));
        let same = 0, mirror = 0, satA = 0, satC = 0;
        for (let y = 0; y < 144; y++) for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4, j = (y * 256 + (255 - x)) * 4;
          for (let k = 0; k < 3; k++) { same += Math.abs(b[i + k] - a[i + k]); mirror += Math.abs(b[i + k] - a[j + k]); }
          satA += Math.max(a[i], a[i + 1], a[i + 2]) - Math.min(a[i], a[i + 1], a[i + 2]);
          satC += Math.max(c[i], c[i + 1], c[i + 2]) - Math.min(c[i], c[i + 1], c[i + 2]);
        }
        return { same, mirror, satA, satC };
      })()`)) as { same: number; mirror: number; satA: number; satC: number };
      expect(r.same, name).toBeGreaterThan(0);
      expect(r.mirror, name).toBeLessThan(r.same * 0.5);
      expect(r.satC, name).toBeLessThan(r.satA * 0.3);
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("Android 版のアプリのセーブ（ブラウザで包みの口を真似る）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("セーブはアプリの口へ書き、裏へ回ったとき（onPause の JS）はオートセーブを書き終えてから left() を呼ぶ", async () => {
    const java = mainActivity("com.example.game");
    const m = /protected void onPause\(\) \{[\s\S]*?web\.evaluateJavascript\("((?:[^"\\]|\\.)*)", null\)/.exec(java);
    const leave = JSON.parse(`"${m![1]}"`) as string;
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __prefs: Record<string, string>; __calls: string[]; LiminaliaSaves: unknown };
        w.__prefs = {};
        w.__calls = [];
        w.LiminaliaSaves = {
          load: () => JSON.stringify(w.__prefs),
          set: (k: string, v: string) => {
            w.__calls.push(`set ${k.replace(/^liminalia:[^:]+:/, "")}`);
            w.__prefs[k] = v;
          },
          remove: (k: string) => delete w.__prefs[k],
          left: () => w.__calls.push("left"),
        };
      });
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "いちページめ");
      await p.evaluate("window.__calls.length = 0");
      await p.evaluate(leave);
      const calls = (await p.evaluate("window.__calls")) as string[];
      expect(calls.at(-1), name).toBe("left");
      expect(calls, name).toContain("set slot:auto:0");
      expect(calls.indexOf("set slot:auto:0"), name).toBeLessThan(calls.indexOf("left"));
      // localStorage には書かない
      expect(await p.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('liminalia:')).length"), name).toBe(0);
      await p.close();
    }
  });
});
