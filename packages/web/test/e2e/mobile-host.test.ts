import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * スマホのアプリとブラウザでの遊ぶ側の振る舞い（戻る、@quit、@open-url、スリープの抑止、@vibrate）を、実際のブラウザで確かめる。
 * アプリの口（Android の window.LiminaliaApp、iOS の window.webkit.messageHandlers.liminaliaApp）は、同じ形の差し替えを置いて確かめる。
 */

const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s);
const screen = (p: Page) => p.evaluate(`window.__liminalia.screen()`) as Promise<{ mode: string; screen: string | null }>;
const back = (p: Page) => p.evaluate(`window.__liminalia.back()`) as Promise<boolean>;

/** Android のアプリの口の差し替え（呼ばれたものを window.__calls に残す）。 */
const ANDROID_APP = `window.__calls = []; window.LiminaliaApp = { quit() { window.__calls.push("quit"); }, openUrl(u) { window.__calls.push("open " + u); }, keepAwake(on) { window.__calls.push("awake " + on); }, vibrate(p) { window.__calls.push("vibrate " + p); } };`;
/** iOS のアプリの口の差し替え。 */
const IOS_APP = `window.__calls = []; window.webkit = { messageHandlers: { liminaliaApp: { postMessage(m) { window.__calls.push("ios " + m); } } } };`;
/** ブラウザの Screen Wake Lock と Vibration API、つないだゲームパッドを控える。 */
const BROWSER_DEVICE = `window.__calls = [];
Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request(t) { window.__calls.push("lock " + t); const s = { released: false, release() { s.released = true; window.__calls.push("unlock"); return Promise.resolve(); } }; return Promise.resolve(s); } } });
navigator.vibrate = (p) => { window.__calls.push("vibrate " + JSON.stringify(p)); return true; };
const pad = { connected: true, buttons: [], axes: [], vibrationActuator: { playEffect(t, o) { window.__calls.push("pad " + t + " " + o.duration); return Promise.resolve("complete"); }, reset() { window.__calls.push("pad reset"); return Promise.resolve("complete"); } } };
navigator.getGamepads = () => [pad];`;
const MOVIE = resolve(import.meta.dirname, "fixtures/test-movie.webm");
/** ブラウザの window.open を控える。 */
const BROWSER_OPEN = `window.__calls = []; window.open = (u, t, f) => { window.__calls.push("window.open " + u + " " + t + " " + f); return null; };`;

describe.skipIf(!e2e)("スマホのアプリとブラウザの振る舞い", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: {
        a: [
          "@window show",
          "いちページめ。",
          '@dialog "よろしいですか" type=confirm target=#yes cancel-target=#no',
          "# yes",
          "はいのページ。",
          "@jump #end",
          "# no",
          "いいえのページ。",
          '@text-input game.name prompt="名前"',
          "# end",
          "おわりのページ。",
          "",
        ].join("\n"),
        q: "@window show\nやめるページ。\n@quit\nつづきのページ。\n",
        q2: "@window show\nやめるページ。\n@quit ask=false\nつづきのページ。\n",
        u: "@window show\nリンクのページ。\n@open-url https://example.com/a?b=1\nあとのページ。\n",
        m: "@window show\n動画の前。\n@movie m.webm\n動画の後。\n",
        v: "@window show\nふるえる前。\n@vibrate time=200ms count=2\nふるえた。\n@vibrate-stop\nとまった。\n",
      },
      files: { "assets/video/m.webm": MOVIE },
      config: { entry: "a", variables: { "game.name": "" } },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const open = async (browser: Browser, init?: string): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    if (init) await p.addInitScript(init);
    await p.goto(`${project.url}?autostart=1`);
    await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
    return p;
  };

  it("戻る: 入力の枠は取り消し、開いている画面は閉じ、ゲーム中はメニュー。タイトルはアプリを閉じられるときだけ終わるかを尋ねる", async () => {
    for (const { name, browser } of list) {
      // ブラウザ（閉じられない）: タイトルでは扱わない（前のページへ戻る）
      const p = await open(browser);
      expect(await back(p), name).toBe(false);
      expect(await p.locator(".lm-title-button", { hasText: "終了" }).count(), name).toBe(0);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "いちページめ");
      // ゲーム中はメニュー、もう一度で閉じる
      expect(await back(p), name).toBe(true);
      expect((await screen(p)).screen, name).toBe("menu");
      expect(await back(p), name).toBe(true);
      expect((await screen(p)).screen, name).toBe(null);
      // 確認の枠（@dialog type=confirm）は取り消し（cancel-target へ）。下のメニューは開かない
      await p.mouse.click(640, 300);
      await p.waitForSelector(".lm-panel");
      expect(await back(p), name).toBe(true);
      await waitText(p, "いいえのページ");
      expect((await screen(p)).screen, name).toBe(null);
      // 文字の入力（@text-input）は取り消せないので、戻るはゲーム中と同じくメニューを開く（もう一度で閉じ、入力の枠に戻る）
      await p.mouse.click(640, 300);
      await p.waitForSelector(".lm-panel input");
      expect(await back(p), name).toBe(true);
      await p.waitForSelector("[data-lm-screen='menu']");
      expect(await p.locator(".lm-panel input").count(), name).toBe(1);
      expect(await back(p), name).toBe(true);
      expect((await screen(p)).screen, name).toBe(null);
      expect(await p.locator(".lm-panel input").count(), name).toBe(1);
      // Esc も同じ
      await p.locator(".lm-panel input").press("Escape");
      await p.waitForSelector("[data-lm-screen='menu']");
      await p.keyboard.press("Escape");
      await p.waitForSelector("[data-lm-screen='menu']", { state: "detached" });
      expect(await p.locator(".lm-panel input").count(), name).toBe(1);
      expect((await screen(p)).screen, name).toBe(null);
      await p.locator(".lm-panel input").fill("ユイ");
      await p.locator(".lm-panel input").press("Enter");
      await waitText(p, "おわりのページ");
      await p.close();

      // Android のアプリ（閉じられる）: タイトルでは終わるかを尋ね、もう一度の戻るで取り消す。「はい」で閉じる
      const a = await open(browser, ANDROID_APP);
      expect(await a.locator(".lm-title-button", { hasText: "終了" }).count(), name).toBe(1);
      expect(await back(a), name).toBe(true);
      expect((await screen(a)).screen, name).toBe("confirm");
      expect(await back(a), name).toBe(true);
      expect((await screen(a)).screen, name).toBe(null);
      expect(await back(a), name).toBe(true);
      await a.locator(".lm-dialog button", { hasText: "はい" }).click();
      await a.waitForFunction(`window.__calls.includes("quit")`);
      await a.close();
    }
  });

  it("スマホのブラウザは、戻るでゲームから出ていかない（履歴に一つ積む）。タイトルでは前のページへ戻る", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36" });
      const p = await context.newPage();
      // 前のページ（Chrome は押されなかったページを戻るで飛ばすので、一度押しておく）
      await p.goto(`${project.url}?from=before`);
      await p.mouse.click(5, 5);
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "いちページめ");
      const game = p.url();
      await p.goBack();
      await p.waitForFunction(`window.__liminalia.screen().screen === "menu"`);
      expect(p.url(), name).toBe(game);
      await p.goBack();
      await p.waitForFunction(`window.__liminalia.screen().screen === null`);
      expect(p.url(), name).toBe(game);
      // タイトルでは前のページへ
      await p.evaluate(`window.__liminalia.system.showTitle(true)`);
      await p.goBack();
      await p.waitForURL((u) => u.search === "?from=before", { timeout: 10_000 });
      await context.close();
    }
  });

  it("@quit: 閉じられない（ブラウザと iOS のアプリ）なら知らせてタイトルへ。Android のアプリは閉じる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate(`window.__liminalia.system.startAt("q")`);
      await waitText(p, "やめるページ");
      await p.mouse.click(640, 300);
      await p.waitForSelector(".lm-dialog");
      expect(await p.locator(".lm-dialog").textContent(), name).toContain("ここではゲームを終了できません");
      await p.locator(".lm-dialog button", { hasText: "はい" }).click();
      await p.waitForFunction(`window.__liminalia.screen().mode === "title"`);
      // ask=false は尋ねずに知らせて戻る
      await p.evaluate(`window.__liminalia.system.startAt("q2")`);
      await waitText(p, "やめるページ");
      await p.mouse.click(640, 300);
      await p.waitForFunction(`window.__liminalia.screen().mode === "title"`);
      expect(await p.locator(".lm-toast").last().textContent(), name).toContain("タイトル画面に戻りました");
      await p.close();

      const a = await open(browser, ANDROID_APP);
      await a.evaluate(`window.__liminalia.system.startAt("q2")`);
      await waitText(a, "やめるページ");
      await a.mouse.click(640, 300);
      await a.waitForFunction(`window.__calls.includes("quit")`);
      await a.close();
    }
  });

  it("@open-url: スマホのアプリは端末のブラウザへ渡し、ブラウザは新しいタブで開く", async () => {
    for (const { name, browser } of list) {
      for (const [init, want] of [
        [ANDROID_APP, "open https://example.com/a?b=1"],
        [IOS_APP, 'ios {"method":"open-url","url":"https://example.com/a?b=1"}'],
        [BROWSER_OPEN, "window.open https://example.com/a?b=1 _blank noopener"],
      ] as const) {
        const p = await open(browser, init);
        await p.evaluate(`window.__liminalia.system.startAt("u")`);
        await waitText(p, "リンクのページ");
        await p.mouse.click(640, 300);
        await waitText(p, "あとのページ");
        expect(await p.evaluate(`window.__calls`), name).toEqual([want]);
        await p.close();
      }
    }
  });

  it("描画のプロセスが落ちて読み直したら（?resume=1）、裏へ回したときのオートセーブから続ける。戻ってきたあとや、ふつうの起動では続けない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "いちページめ");
      // 裏へ回した（スマホのアプリは onPause・sceneWillResignActive で leave を呼ぶ）まま、読み直した
      await p.evaluate(`window.__liminalia.leave()`);
      await p.goto(`${project.url}?resume=1`);
      // 裏にいる間に読み直したページが前へ戻ってきても（visibilitychange）、前のページの印は消さない
      await p.waitForSelector(".layer.start");
      await p.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      await p.locator(".layer.start").click();
      await waitText(p, "いちページめ");
      expect((await screen(p)).mode, name).toBe("game");
      // 裏へ回したあと戻ってきたら、印を消す（続けない）
      const marked = () => p.evaluate(`Object.keys(window.__liminalia.saves.entries()).some((k) => k.endsWith(":resume"))`);
      await p.waitForTimeout(1100);
      await p.evaluate(`window.__liminalia.leave()`);
      expect(await marked(), name).toBe(true);
      await p.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
      expect(await marked(), name).toBe(false);
      // タイトルで裏へ回したなら（閉じたときも）印は無く、読み直してもふつうに起動する
      await p.evaluate(`window.__liminalia.system.showTitle(true)`);
      await p.goto(`${project.url}?resume=1`);
      await p.locator(".layer.start").click();
      await p.waitForFunction(`window.__liminalia.screen().mode === "title"`);
      await p.close();
    }
  });

  it("iOS のアプリ: セーブはアプリの置き場所（LiminaliaSaves）に書き、前の版の IndexedDB のセーブは、はじめて起動したときに一度だけ移す", async () => {
    // アプリの置き場所の差し替え（中身はページをまたいで残すため sessionStorage に置く。previous は iOS のアプリと同じ）
    const IOS_SAVES = `(() => {
      const read = () => JSON.parse(sessionStorage.getItem("native") || "{}");
      const write = (m) => sessionStorage.setItem("native", JSON.stringify(m));
      window.LiminaliaSaves = { previous: "indexeddb", load: () => JSON.stringify(read()), set: (k, v) => { const m = read(); m[k] = v; write(m); }, remove: (k) => { const m = read(); delete m[k]; write(m); } };
    })();`;
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      // 前の版（ブラウザと同じ IndexedDB）でセーブした
      const before = await context.newPage();
      await before.goto(`${project.url}?autostart=1`);
      await before.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      await before.evaluate(`window.__liminalia.system.startAt("a")`);
      await waitText(before, "いちページめ");
      expect(await before.evaluate(`window.__liminalia.system.saveTo(2)`), name).toBe(true);
      await before.evaluate(`window.__liminalia.flushSaves()`);
      await before.close();
      // 新しい版のアプリ: アプリの置き場所に移し、そこから読む
      const p = await context.newPage();
      await p.addInitScript(IOS_SAVES);
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      const native = () => p.evaluate(`JSON.parse(sessionStorage.getItem("native") || "{}")`) as Promise<Record<string, string>>;
      const keys = Object.keys(await native());
      expect(keys.some((k) => k.endsWith(":slot:2")), name).toBe(true);
      expect(keys, name).toContain("liminalia-store:carried");
      expect(await p.evaluate(`window.__liminalia.system.slot(2).empty`), name).toBe(false);
      // 書いたものはアプリの置き場所へ
      await p.evaluate(`window.__liminalia.system.startAt("a")`);
      await waitText(p, "いちページめ");
      await p.evaluate(`window.__liminalia.system.saveTo(3)`);
      expect(Object.keys(await native()).some((k) => k.endsWith(":slot:3")), name).toBe(true);
      // 二度目の起動では移さない（アプリで消したセーブが戻らない）
      await p.evaluate(`window.__liminalia.system.deleteSlot(2)`);
      await p.reload();
      await p.waitForFunction(`window.__liminalia?.screen().mode === "title"`);
      expect(await p.evaluate(`window.__liminalia.system.slot(2).empty`), name).toBe(true);
      expect(await p.evaluate(`window.__liminalia.system.slot(3).empty`), name).toBe(false);
      await context.close();
    }
  });

  const called = (p: Page, s: string) => p.waitForFunction((s) => (window as unknown as { __calls: string[] }).__calls.includes(s), s);

  it("オートの間と動画の再生中だけスリープを止める（ブラウザは Screen Wake Lock、Android のアプリは FLAG_KEEP_SCREEN_ON の口）", async () => {
    for (const { name, browser } of list) {
      for (const [init, on, off] of [
        [BROWSER_DEVICE, "lock screen", "unlock"],
        [ANDROID_APP, "awake true", "awake false"],
        [IOS_APP, 'ios {"method":"keep-awake","on":true}', 'ios {"method":"keep-awake","on":false}'],
      ] as const) {
        const p = await open(browser, init);
        await p.evaluate(`window.__liminalia.system.startAt("a")`);
        await waitText(p, "いちページめ");
        expect(await p.evaluate(`window.__calls`), name).toEqual([]);
        await p.evaluate(`void window.__liminalia.system.perform("auto")`);
        await called(p, on);
        await p.evaluate(`void window.__liminalia.system.perform("auto")`);
        await called(p, off);
        expect(await p.evaluate(`window.__calls`), name).toEqual([on, off]);
        // 動画（@movie）の間
        await p.evaluate(`window.__calls.length = 0; window.__liminalia.system.startAt("m")`);
        await waitText(p, "動画の前");
        await p.mouse.click(640, 300);
        await p.waitForSelector("video.lim-movie");
        await called(p, on);
        await waitText(p, "動画の後");
        await called(p, off);
        expect(await p.evaluate(`window.__calls`), name).toEqual([on, off]);
        await p.close();
      }
    }
  });

  it("@vibrate: Android のアプリは端末の振動、iOS のアプリは触覚、ブラウザは Vibration API。つないだゲームパッドも振動させる", async () => {
    for (const { name, browser } of list) {
      for (const [init, want] of [
        [ANDROID_APP, ["vibrate [200,200,200]", "vibrate []"]],
        [IOS_APP, ['ios {"method":"haptic","pattern":[200,200,200]}', 'ios {"method":"haptic","pattern":[]}']],
        // ゲームパッドは振動ごとに頼む（0 ミリ秒と 400 ミリ秒）
        [BROWSER_DEVICE, ["vibrate [200,200,200]", "pad dual-rumble 200", "pad dual-rumble 200", "pad reset", "vibrate 0"]],
      ] as const) {
        const p = await open(browser, init);
        await p.evaluate(`window.__liminalia.system.startAt("v")`);
        await waitText(p, "ふるえる前");
        await p.mouse.click(640, 300);
        await waitText(p, "ふるえた");
        await p.waitForTimeout(600);
        await p.mouse.click(640, 300);
        await waitText(p, "とまった");
        expect(await p.evaluate(`window.__calls`), name).toEqual(want);
        await p.close();
      }
    }
  });
});
