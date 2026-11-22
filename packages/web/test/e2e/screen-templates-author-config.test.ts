import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { focusedIs, open, waitScreen } from "./screens-behavior-shared.ts";

/**
 * 作品が写して直したコンフィグ（liminalia.json の ui.templates.config。0.4.0 の段 f3）。HTML と CSS だけで、項目を外し、並べ替え、
 * まとまり（タブ）を変え、欄の形（つまみ、切り替え、選択）を選べることを、中立の名前の作品で確かめる。
 * - 画面の全体を差し替える: タブは二つ、項目は少しだけ。ミュートは切り替え（data-toggle）、BGM はつまみと選択を一つの行に並べ、作品独自の設定（custom.名前）も選べる。
 *   ブラウザで使えない項目（デスクトップ版だけの項目）は、書いてもエンジンが外す
 * - 部品一つだけを差し替える: キーの割り当ての一行（binding）だけを作品のものにし、残りは標準のまま
 */

const SCENARIO = `@window show
一つ目のページ。
二つ目のページ。
`;

/** 画面の全体。タブは「おと」と「もじ」、項目は並べ替えて少しだけ。 */
const SCREEN = `<style>
  .my-switch[data-lm-on] { color: rgb(255, 0, 0); }
</style>
<template data-part="screen" data-version="1">
<div class="lm-screen lm-config my-config">
  <header class="lm-screen-header">
    <h2 class="lm-screen-title">せってい</h2>
    <nav class="lm-tabs">
      <button class="lm-tab" data-role="page" data-page="a">おと</button>
      <button class="lm-tab" data-role="page" data-page="b">もじ</button>
    </nav>
    <button class="lm-button lm-close" data-role="close">とじる</button>
  </header>
  <div class="lm-config-rows my-a" data-page="a">
    <div class="lm-config-row" data-setting="bgm"><span class="lm-config-label">きょく</span><input class="lm-range"><output class="my-bgm" data-field="bgm"></output><button class="my-zero" data-value="0">ゼロ</button></div>
    <div class="lm-config-row" data-setting="mute"><span class="lm-config-label">けす</span><button class="my-switch" data-toggle>けす</button></div>
    <template data-list="speakers" data-item="speaker"></template>
  </div>
  <div class="lm-config-rows my-b" data-page="b">
    <div class="lm-config-row" data-setting="skipUnread"><span class="lm-config-label">とばす</span><button class="lm-toggle" data-value="true">ぜんぶ</button><button class="lm-toggle" data-value="false">よんだところ</button></div>
    <div class="lm-config-row" data-setting="textSpeed"><span class="lm-config-label">はやさ</span><input class="lm-range"><output class="my-speed" data-field="textSpeed"></output></div>
    <div class="lm-config-row" data-setting="whenHidden"><span class="lm-config-label">かくれたとき</span><button class="lm-toggle" data-value="pause">とめる</button></div>
    <div class="lm-config-row" data-setting="custom.sparkle"><span class="lm-config-label">きらきら</span><button class="lm-toggle" data-value="false">なし</button><button class="lm-toggle" data-value="true">あり</button></div>
  </div>
  <div class="my-preview" data-page="b" data-field="preview"></div>
  <button class="lm-button my-reset" data-role="reset">もどす</button>
</div>
</template>
`;

/** 画面の JS: 要素に印を付ける。 */
const SCREEN_JS = `export default function (screen, api) {
  screen.dataset.fromJs = api.screen;
}
`;

/** キーの割り当ての一行だけ（名前と今のキーを一つの行に、変えるボタンは文字で）。 */
const BINDING = `<template data-part="binding" data-version="1">
<div class="lm-config-row my-binding">
  <span class="lm-config-label" data-field="label"></span>
  <kbd class="my-keys" data-field="keys"></kbd>
  <button class="my-change" data-role="change" data-attr-aria-pressed="waiting">かえる</button>
</div>
</template>
`;

const write = (files: Record<string, string>, scripts: Record<string, string> = {}) => (dir: string) => {
  for (const [name, html] of Object.entries(files)) {
    mkdirSync(join(dir, "ui", "screens", name), { recursive: true });
    writeFileSync(join(dir, "ui", "screens", name, `${name}.html`), html);
  }
  for (const [name, js] of Object.entries(scripts)) {
    mkdirSync(join(dir, "ui", "screens", name), { recursive: true });
    writeFileSync(join(dir, "ui", "screens", name, `${name}.js`), js);
  }
};

const settings = (p: Page) => p.evaluate(() => JSON.parse(JSON.stringify(window.__liminalia!.system.settings))) as Promise<Record<string, unknown>>;
const openConfig = async (p: Page) => {
  await p.evaluate(() => void window.__liminalia!.system.perform!("config"));
  await waitScreen(p, "config");
};
const labels = (p: Page) => p.evaluate(() => [...document.querySelectorAll(".lm-config-rows:not([hidden]) .lm-config-label")].map((e) => e.textContent));

describe.skipIf(!e2e)("作品のテンプレートで差し替えたコンフィグ（ブラウザ）", { timeout: 300_000 }, () => {
  let whole: TestProject;
  let part: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    whole = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", ui: { settings: { voiceSpeakers: "all" }, templates: { config: "ui/screens/config/config.html" } } },
      before: write({ config: SCREEN }, { config: SCREEN_JS }),
    });
    part = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { templates: { config: "ui/screens/config/config.html" } } }, before: write({ config: BINDING }) });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await whole?.close();
    await part?.close();
  });

  it("画面の全体: 作品のタブと項目の並びで出し、使えない項目は外す。つまみ、切り替え、選択、作品独自の設定が値と結ばれ、「もどす」で戻る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, whole.url, { start: "a" });
      await openConfig(p);
      expect(await p.locator(".my-config").getAttribute("data-from-js"), name).toBe("config");
      expect(await p.locator(".lm-config .lm-tab").allTextContents(), name).toEqual(["おと", "もじ"]);
      // 前のタブ（テキスト）が無いので、一つ目のタブを出す
      expect(await p.locator(".lm-config .lm-tab[aria-pressed=true]").allTextContents(), name).toEqual(["おと"]);
      expect(await p.locator(".lm-config .lm-tab[data-lm-current]").allTextContents(), name).toEqual(["おと"]);
      const a = await labels(p);
      expect(a.slice(0, 2), name).toEqual(["きょく", "けす"]);
      // 話者ごとの声の音量は標準の一行の部品で、作品の並びの場所に並ぶ
      expect(a.length, name).toBeGreaterThan(2);
      expect(a.slice(2).every((l) => l?.endsWith("の声")), name).toBe(true);
      expect(await p.locator(".my-preview").isVisible(), name).toBe(false);
      // つまみ
      expect(await p.locator(".my-bgm").textContent(), name).toBe("80");
      await p.locator(".my-a .lm-range").first().focus();
      await p.keyboard.press("ArrowRight");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.bgm === 85);
      expect(await p.locator(".my-bgm").textContent(), name).toBe("85");
      expect(await p.locator(".my-a .lm-range").first().getAttribute("aria-label"), name).toBe("BGM の音量");
      // 同じ行の選択（data-value）でも変えられ、つまみと値の文字も合う
      await p.locator(".my-zero").click();
      await p.waitForFunction(() => window.__liminalia!.system.settings!.bgm === 0);
      expect([await p.locator(".my-bgm").textContent(), await p.locator(".my-a .lm-range").first().inputValue(), await p.locator(".my-zero").getAttribute("aria-pressed")], name).toEqual(["0", "0", "true"]);
      // 切り替え（role="switch"、aria-checked、data-lm-on）
      const sw = p.locator(".my-switch");
      expect([await sw.getAttribute("role"), await sw.getAttribute("aria-checked")], name).toEqual(["switch", "false"]);
      await sw.click();
      expect((await settings(p)).mute, name).toBe(true);
      expect(await sw.getAttribute("aria-checked"), name).toBe("true");
      expect(await sw.evaluate((e) => getComputedStyle(e).color), name).toBe("rgb(255, 0, 0)");
      // 画面の外で変えても合わせる
      await p.evaluate(() => void window.__liminalia!.system.updateSettings!({ mute: false }));
      await p.waitForFunction(() => document.querySelector(".my-switch")?.getAttribute("aria-checked") === "false");

      // もう一つのタブ: 並べ替えた順。デスクトップ版だけの項目は外れる
      await p.locator(".lm-config .lm-tab", { hasText: "もじ" }).click();
      expect(await labels(p), name).toEqual(["とばす", "はやさ", "きらきら"]);
      expect(await p.locator("[data-setting=whenHidden]").count(), name).toBe(0);
      expect(await p.locator(".my-preview").isVisible(), name).toBe(true);
      expect((await p.locator(".my-preview").textContent())!.length, name).toBeGreaterThan(0);
      // 選択（作品の並びのまま。押したものに aria-pressed）
      // 作品独自の設定は、値が無ければどれも押されていない
      expect(await p.locator(".my-b .lm-toggle[aria-pressed=true]").allTextContents(), name).toEqual(["よんだところ"]);
      await p.locator(".my-b .lm-toggle", { hasText: "ぜんぶ" }).click();
      expect((await settings(p)).skipUnread, name).toBe(true);
      await p.locator(".my-b .lm-toggle", { hasText: "あり" }).click();
      expect(((await settings(p)).custom as Record<string, unknown>).sparkle, name).toBe(true);
      expect(await p.locator(".my-b .lm-toggle[aria-pressed=true]").allTextContents(), name).toEqual(["ぜんぶ", "あり"]);
      expect(await p.locator(".my-speed").textContent(), name).toBe("30 ms");
      // もどす
      await p.locator(".my-reset").click();
      await p.waitForFunction(() => window.__liminalia!.system.settings!.bgm === 80);
      const s = await settings(p);
      // 作品独自の設定は、作品の初期値（ui.defaults）に無ければ戻さない（設定の口の reset と同じ）
      expect([s.skipUnread, s.mute, (s.custom as Record<string, unknown>).sparkle], name).toEqual([false, false, true]);
      expect(await p.locator(".my-b .lm-toggle[aria-pressed=true]").allTextContents(), name).toEqual(["よんだところ", "あり"]);
      expect(await p.locator(".my-bgm").textContent(), name).toBe("80");
      // 閉じるボタンと Esc
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await p.close();
    }
  });

  it("部品一つだけ: キーの割り当ての一行を作品のものにし、標準のタブと項目はそのまま。変えるボタンで割り当て、フォーカスは同じ行に残る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, part.url, { start: "a" });
      await openConfig(p);
      expect(await p.locator(".lm-config .lm-tab").allTextContents(), name).toEqual(["テキスト", "画面", "サウンド", "操作"]);
      await p.locator(".lm-config .lm-tab", { hasText: "操作" }).click();
      // キーボードとゲームパッドの行のどちらも作品の一行
      expect(await p.locator(".my-binding").count(), name).toBe(20 + 12);
      const backlog = p.locator(".my-binding", { hasText: "バックログ" }).first();
      // キーで押す（クリックでは WebKit がボタンにフォーカスを置かない）
      await backlog.locator(".my-change").focus();
      await p.keyboard.press("Enter");
      expect(await p.locator(".my-binding", { hasText: "バックログ" }).first().locator(".my-keys").textContent(), name).toBe("キーを押してください");
      expect(await p.locator(".my-binding", { hasText: "バックログ" }).first().locator(".my-change").getAttribute("aria-pressed"), name).toBe("true");
      expect(await focusedIs(p, ".my-binding .my-change"), name).toBe(true);
      await p.keyboard.press("j");
      await p.waitForFunction(() => JSON.stringify((window.__liminalia!.system.settings!.keys as Record<string, string[]>).backlog) === '["j"]');
      const row = p.locator(".my-binding", { hasText: "バックログ" }).first();
      expect(await row.locator(".my-keys").textContent(), name).toBe("J");
      expect(await row.locator(".my-change").getAttribute("aria-pressed"), name).toBe("false");
      expect(await focusedIs(p, ".my-binding .my-change"), name).toBe(true);
      // 割り当てたキーで履歴を開く
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await p.keyboard.press("j");
      await waitScreen(p, "backlog");
      await p.close();
    }
  });
});
