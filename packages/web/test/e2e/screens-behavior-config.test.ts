import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { dialogOf, events, focusedIs, focusedLabel, focusProbe, onProbe, open, pad, recordEvents, screenNow, waitFocus, waitScreen } from "./screens-behavior-shared.ts";

/**
 * 標準の画面の今の動き（コンフィグ）を固定する。0.4.0 で画面を HTML のテンプレートと属性で組み直しても、同じテストが通ること。
 * DOM の作りは見ず、遊ぶ人から見える動き（キー、ゲームパッド、フォーカス、読み上げ、値の変わり方、閉じ方、縦長）と、
 * 作品の CSS が当てる部品のクラス（screen-catalog.ts の parts と classes）で確かめる。
 * 項目ごとの効き目（settings-extra、settings-display、volume、controls、config-window、desktop-shell）とは重ねない。
 */

const SCENARIO = `@window show
一ページ目。
二ページ目。
`;

/** 開いているタブの項目の名前。 */
const labels = (p: Page) => p.evaluate(() => [...document.querySelectorAll(".lm-config-rows:not([hidden]) .lm-config-label")].map((e) => e.textContent));
/** 押された（aria-pressed が true の）タブの文字。 */
const pressedTab = (p: Page) => p.locator(".lm-config .lm-tab[aria-pressed=true]").allTextContents();
/** 名前の行の中の、押された選択の文字。 */
const chosen = (p: Page, label: string) =>
  p
    .locator(".lm-config-row")
    .filter({ has: p.locator(".lm-config-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator('.lm-toggle[aria-pressed="true"]')
    .allTextContents();
const row = (p: Page, label: string) => p.locator(".lm-config-row").filter({ has: p.locator(".lm-config-label", { hasText: new RegExp(`^${label}$`) }) });
const settings = (p: Page) => p.evaluate(() => JSON.parse(JSON.stringify(window.__liminalia!.system.settings))) as Promise<Record<string, unknown>>;
const openConfig = async (p: Page) => {
  await p.evaluate(() => void window.__liminalia!.system.perform!("config"));
  await waitScreen(p, "config");
};

describe.skipIf(!e2e)("標準の画面の今の動き: コンフィグ（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let speakers: TestProject;
  let portrait: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    speakers = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { settings: { voiceSpeakers: "all" } } } });
    portrait = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", screen: { width: 720, height: 1280 } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await speakers?.close();
    await portrait?.close();
  });

  it("開くとダイアログで、画面の根にフォーカスし、四つのタブと項目を並べる。C キー、Esc、右クリック、パッドの B で開いて閉じ、閉じたら開く前のところへ戻す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await recordEvents(p);
      await focusProbe(p);
      await p.keyboard.press("c");
      await waitScreen(p, "config");
      expect(await events(p), name).toEqual(["screen-open:config"]);
      expect(await dialogOf(p, "config"), name).toEqual({ role: "dialog", modal: "true", label: "コンフィグ" });
      for (const cls of [".lm-config", ".lm-config-row", ".lm-config-label", ".lm-config-control", ".lm-config-value", ".lm-preview", ".lm-range", ".lm-toggle", ".lm-screen-title", ".lm-tab", ".lm-close", ".lm-button"]) {
        expect(await p.locator(cls).count(), `${name} ${cls}`).toBeGreaterThan(0);
      }
      await p.waitForFunction(() => document.activeElement === document.querySelector("[data-lm-screen=config]"));
      expect(await p.locator(".lm-config .lm-tab").allTextContents(), name).toEqual(["テキスト", "画面", "サウンド", "操作"]);
      expect(await pressedTab(p), name).toEqual(["テキスト"]);
      expect(await labels(p), name).toEqual(["テキスト速度", "オートの待ち時間", "スキップの対象", "スキップの速さ", "選択肢のあとのオート", "選択肢のあとのスキップ", "選択肢の制限時間"]);
      expect(await p.locator(".lm-preview").isVisible(), name).toBe(true);
      expect(await p.locator(".lm-preview").textContent(), name).toContain("プレビュー");
      // 下の帯は「初期設定に戻す」（ブラウザ版はセーブの書き出しと読み込みも）
      expect(await p.locator(".lm-config-footer .lm-button").allTextContents(), name).toEqual(["セーブデータをエクスポート", "セーブデータをインポート", "初期設定に戻す"]);

      // 遊んでいる最中のキー（B はバックログ、S はセーブ）は効かない
      await p.keyboard.press("b");
      await p.keyboard.press("s");
      expect((await screenNow(p)).screen, name).toBe("config");
      // Tab は画面の中を回る
      for (let i = 0; i < 60; i++) {
        await p.keyboard.press("Tab");
        expect(await focusedIs(p, "[data-lm-screen=config]"), `${name} Tab ${i}`).toBe(true);
      }
      // Esc で閉じ、開く前のところへ戻す
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await events(p), name).toEqual(["screen-close:config"]);
      expect(await onProbe(p), name).toBe(true);
      // 右クリックとパッドの B でも閉じる
      await openConfig(p);
      await p.mouse.click(640, 360, { button: "right" });
      await waitScreen(p, null);
      await openConfig(p);
      await pad(p, "b");
      await waitScreen(p, null);
      // 閉じるボタン
      await openConfig(p);
      await p.locator(".lm-config .lm-close").click();
      await waitScreen(p, null);
      expect((await screenNow(p)).mode, name).toBe("game");
      await p.close();
    }
  });

  it("タブ: 押すとそのタブの項目だけを出し、プレビューはテキストと画面のタブだけ。開き直すと最後のタブを出す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await openConfig(p);
      const fullscreen = await p.evaluate(() => document.fullscreenEnabled || !!(document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);
      await p.locator(".lm-config .lm-tab", { hasText: "画面" }).click();
      expect(await pressedTab(p), name).toEqual(["画面"]);
      expect(await labels(p), name).toEqual([
        "ウィンドウの不透明度",
        "文字サイズ",
        "フォント",
        "画面の揺れ",
        "光の点滅",
        "既読の文の色",
        "行間",
        "文字の縁",
        "テキスト読み上げ",
        "高コントラスト",
        ...(fullscreen ? ["画面モード"] : []),
        "色覚の補正",
        "効果音の字幕",
        "確認のメッセージ",
        "動かさないマウスのカーソルを隠す",
      ]);
      expect(await p.locator(".lm-preview").isVisible(), name).toBe(true);
      expect(await row(p, "フォント").locator(".lm-toggle").allTextContents(), name).toEqual(["標準", "明朝", "ゴシック", "丸ゴシック", "UD"]);
      expect(await row(p, "文字の縁").locator(".lm-toggle").allTextContents(), name).toEqual(["標準", "なし", "影", "縁取り"]);
      expect(await row(p, "行間").locator(".lm-toggle").allTextContents(), name).toEqual(["標準", "広め", "より広め"]);
      expect(await row(p, "色覚の補正").locator(".lm-toggle").allTextContents(), name).toEqual(["しない", "1 型（P）", "2 型（D）", "3 型（T）"]);
      await p.locator(".lm-config .lm-tab", { hasText: "サウンド" }).click();
      expect(await labels(p), name).toEqual(["全体の音量", "ミュート", "BGM の音量", "効果音の音量", "ボイスの音量", "次へ進んだとき", "ボイス再生中の BGM"]);
      expect(await p.locator(".lm-preview").isVisible(), name).toBe(false);
      expect(await row(p, "次へ進んだとき").locator(".lm-toggle").allTextContents(), name).toEqual(["ボイスを止める", "再生を続ける"]);
      await p.locator(".lm-config .lm-tab", { hasText: "操作" }).click();
      expect(await p.locator(".lm-preview").isVisible(), name).toBe(false);
      expect(await p.locator(".lm-config-rows:not([hidden]) .lm-config-group").allTextContents(), name).toEqual(["キーボード", "ゲームパッド"]);
      const controls = await labels(p);
      expect(controls.slice(0, 3), name).toEqual(["読み進める", "メニュー", "バックログ"]);
      expect(controls, name).toContain("ボタンの表記");
      expect(controls.at(-1), name).toBe("ミュート");
      expect(await p.locator(".lm-config-rows:not([hidden]) .lm-button").allTextContents(), name).toEqual(["操作を初期値に戻す"]);
      // 開き直すと最後のタブ
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await openConfig(p);
      expect(await pressedTab(p), name).toEqual(["操作"]);
      await p.locator(".lm-config .lm-tab", { hasText: "テキスト" }).click();
      expect(await pressedTab(p), name).toEqual(["テキスト"]);
      await p.close();
    }
  });

  it("値: つまみは矢印キーで動いて値の文字と設定が変わり、選択は押したものだけが押された見た目になる。「初期設定に戻す」で戻す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await openConfig(p);
      // テキスト速度: 右ほど速い。既定は 30 ms、右へ一つで 25 ms、端まで行くとノーウェイト
      const speed = row(p, "テキスト速度");
      expect(await speed.locator(".lm-config-value").textContent(), name).toBe("30 ms");
      expect(await speed.locator(".lm-config-end").allTextContents(), name).toEqual(["遅い", "速い"]);
      await speed.locator(".lm-range").focus();
      await p.keyboard.press("ArrowRight");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.textSpeed === 25);
      expect(await speed.locator(".lm-config-value").textContent(), name).toBe("25 ms");
      // 矢印はつまみの値を変えるだけで、フォーカスは動かない
      expect(await focusedIs(p, ".lm-range"), name).toBe(true);
      await p.keyboard.press("End");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.textSpeed === 0);
      expect(await speed.locator(".lm-config-value").textContent(), name).toBe("ノーウェイト");
      // オートの待ち時間は秒で出す
      const wait = row(p, "オートの待ち時間");
      expect(await wait.locator(".lm-config-value").textContent(), name).toBe("1.5 秒");
      await wait.locator(".lm-range").focus();
      await p.keyboard.press("ArrowLeft");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.autoWait === 1400);
      expect(await wait.locator(".lm-config-value").textContent(), name).toBe("1.4 秒");
      // 選択: 押したものだけが押された見た目
      expect(await chosen(p, "スキップの対象"), name).toEqual(["既読のみ"]);
      await row(p, "スキップの対象").locator(".lm-toggle", { hasText: "すべて" }).click();
      expect(await chosen(p, "スキップの対象"), name).toEqual(["すべて"]);
      expect((await settings(p)).skipUnread, name).toBe(true);
      // キー（Enter）でも選べる
      await row(p, "選択肢のあとのオート").locator(".lm-toggle", { hasText: "続ける" }).focus();
      await p.keyboard.press("Enter");
      expect((await settings(p)).autoAfterChoice, name).toBe(true);
      expect(await chosen(p, "選択肢のあとのオート"), name).toEqual(["続ける"]);
      // サウンドのタブの音量（0〜100 の数で出す）とミュート
      await p.locator(".lm-config .lm-tab", { hasText: "サウンド" }).click();
      const bgm = row(p, "BGM の音量");
      expect(await bgm.locator(".lm-config-value").textContent(), name).toBe("80");
      await bgm.locator(".lm-range").focus();
      await p.keyboard.press("ArrowRight");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.bgm === 85);
      expect(await bgm.locator(".lm-config-value").textContent(), name).toBe("85");
      await row(p, "ミュート").locator(".lm-toggle", { hasText: "オン" }).click();
      expect((await settings(p)).mute, name).toBe(true);
      // 画面の外で変わった値（設定の口）も、開いたままの画面に映す
      await p.evaluate(() => void window.__liminalia!.system.updateSettings!({ bgm: 40, mute: false }));
      await p.waitForFunction(() => document.querySelector<HTMLInputElement>(".lm-config-rows:not([hidden]) .lm-range[aria-label='BGM の音量']")?.value === "40");
      expect(await bgm.locator(".lm-config-value").textContent(), name).toBe("40");
      expect(await chosen(p, "ミュート"), name).toEqual(["オフ"]);
      // 初期設定に戻す（つまみも選択も戻る）
      await p.locator(".lm-config-footer .lm-button", { hasText: "初期設定に戻す" }).click();
      await p.waitForFunction(() => window.__liminalia!.system.settings!.bgm === 80);
      expect(await bgm.locator(".lm-config-value").textContent(), name).toBe("80");
      await p.locator(".lm-config .lm-tab", { hasText: "テキスト" }).click();
      expect(await row(p, "テキスト速度").locator(".lm-config-value").textContent(), name).toBe("30 ms");
      expect(await chosen(p, "スキップの対象"), name).toEqual(["既読のみ"]);
      expect(await chosen(p, "選択肢のあとのオート"), name).toEqual(["止める"]);
      const s = await settings(p);
      expect([s.textSpeed, s.autoWait, s.skipUnread, s.autoAfterChoice], name).toEqual([30, 1500, false, false]);
      await p.close();
    }
  });

  it("キーとパッド: 矢印とパッドの十字で選んで A で押し、読み上げはキーで選んだ部品の名前を読む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a", speech: true });
      await p.evaluate(() => void window.__liminalia!.system.updateSettings!({ selfVoicing: true }));
      await openConfig(p);
      // 下へでタブ、さらに下へで項目へ
      await p.keyboard.press("ArrowDown");
      expect(await focusedIs(p, ".lm-tab, .lm-close"), name).toBe(true);
      // テキストのタブへ行き、Enter で押す
      await p.locator(".lm-config .lm-tab", { hasText: "テキスト" }).focus();
      await p.keyboard.press("Enter");
      expect(await pressedTab(p), name).toEqual(["テキスト"]);
      // 右へで次のタブ、パッドの A で押す
      await pad(p, "right");
      expect(await focusedLabel(p), name).toBe("画面");
      await pad(p, "a");
      expect(await pressedTab(p), name).toEqual(["画面"]);
      expect(await focusedLabel(p), name).toBe("画面");
      // 読み上げ: Tab で選んだつまみと選択の名前を読む
      await p.evaluate(() => ((window as unknown as { __said: string[] }).__said.length = 0));
      await row(p, "フォント").locator(".lm-toggle", { hasText: "明朝" }).focus();
      await p.keyboard.press("Shift+Tab");
      await p.keyboard.press("Tab");
      await p.waitForFunction(() => (window as unknown as { __said: string[] }).__said.includes("明朝"));
      await row(p, "文字サイズ").locator(".lm-range").focus();
      await p.keyboard.press("Tab");
      await p.keyboard.press("Shift+Tab");
      await p.waitForFunction(() => (window as unknown as { __said: string[] }).__said.includes("文字サイズ"));
      // パッドの A で選択を押す
      await row(p, "フォント").locator(".lm-toggle", { hasText: "明朝" }).focus();
      await pad(p, "a");
      expect(await chosen(p, "フォント"), name).toEqual(["明朝"]);
      expect((await settings(p)).font, name).toBe("mincho");
      await pad(p, "b");
      await waitScreen(p, null);
      await p.close();
    }
  });

  it("話者ごとの声の音量は、作品が決めればまだ聞いていない人物も並べ、話者ごとに設定する", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, speakers.url, { start: "a" });
      await openConfig(p);
      await p.locator(".lm-config .lm-tab", { hasText: "サウンド" }).click();
      const all = await labels(p);
      const voices = all.filter((l) => l?.endsWith("の声"));
      expect(voices.length, name).toBeGreaterThan(0);
      // ボイスの音量のすぐあとに並ぶ
      expect(all.indexOf(voices[0]!), name).toBe(all.indexOf("ボイスの音量") + 1);
      const first = row(p, voices[0]!);
      expect(await first.locator(".lm-config-value").textContent(), name).toBe("100");
      await first.locator(".lm-range").focus();
      await p.keyboard.press("ArrowLeft");
      expect(await first.locator(".lm-config-value").textContent(), name).toBe("95");
      const who = voices[0]!.slice(0, -"の声".length);
      await p.waitForFunction((w) => (window.__liminalia!.system.settings!.speakerVoice as Record<string, number>)[w] === 95, who);
      expect(await first.locator(".lm-range").getAttribute("aria-label"), name).toBe(voices[0]);
      await p.close();
    }
  });

  it("縦長の画面: コンフィグのタブと項目が舞台に収まり、キーで同じに動く", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, portrait.url, { start: "a", viewport: { width: 540, height: 960 } });
      expect(await p.evaluate(() => document.querySelector(".stage")!.classList.contains("lm-portrait")), name).toBe(true);
      await openConfig(p);
      const inStage = (sel: string) =>
        p.evaluate((s) => {
          const st = document.querySelector(".stage")!.getBoundingClientRect();
          return [...document.querySelectorAll(s)].every((e) => {
            const r = e.getBoundingClientRect();
            return r.width === 0 || (r.left >= st.left - 1 && r.right <= st.right + 1);
          });
        }, sel) as Promise<boolean>;
      for (const tab of ["テキスト", "画面", "サウンド", "操作"]) {
        await p.locator(".lm-config .lm-tab", { hasText: tab }).click();
        expect(await pressedTab(p), name).toEqual([tab]);
        expect(await inStage(".lm-config-rows:not([hidden]) .lm-config-row, .lm-config .lm-tab, .lm-config .lm-close"), `${name} ${tab}`).toBe(true);
      }
      await p.locator(".lm-config .lm-tab", { hasText: "テキスト" }).click();
      const speed = row(p, "テキスト速度");
      await speed.locator(".lm-range").focus();
      await p.keyboard.press("ArrowRight");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.textSpeed === 25);
      await waitFocus(p, ".lm-range");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await p.close();
    }
  });
});
