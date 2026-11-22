import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { dialogOf, events, focusProbe, focusedIs, onProbe, focusedLabel, open, pad, recordEvents, screenNow, waitFocus, waitMode, waitScreen, waitText } from "./screens-behavior-shared.ts";

/**
 * 標準の画面の今の動き（確認、メニュー、操作説明、結末の名前）を固定する。0.4.0 で画面を HTML の型と印で組み直しても、同じテストが通ること。
 * DOM の作り（入れ子やクラスの並び）は見ず、遊ぶ人から見える動き（キー、ゲームパッド、フォーカス、読み上げに渡す値、結果、閉じ方）と、
 * 作品の CSS が当てる部品のクラス（screen-catalog.ts の parts と classes）だけで確かめる。
 * 既にあるテスト（accessibility、ending、help、ui-sounds）と重なるところは足さない。
 */

const SCENARIO = `@window show
一ページ目。
二ページ目。
三ページ目。
`;

/** 結末の名前（title= つき）。 */
const ENDING = `@window show
はじまり。
@title-screen ending=bad title="沈黙"
`;

describe.skipIf(!e2e)("標準の画面の今の動き: 確認、メニュー、操作説明、結末の名前（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let keyed: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO, end: ENDING }, config: { entry: "a" } });
    // 作品がキーを割り当て直した（メニューは q、セーブは w、ロードは o、操作説明は無いので F1 は割り当てない）
    keyed = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { keys: { menu: ["q"], save: ["w"], load: ["o"], backlog: ["k"] } } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await keyed?.close();
  });

  /** 確かめを開く（答えは window.__answers に積む）。 */
  const ask = (p: Page, message: string) =>
    p.evaluate((m) => {
      const w = window as unknown as { __answers: boolean[] };
      w.__answers ??= [];
      void window.__liminalia!.system.ask!(m).then((ok) => w.__answers.push(ok));
    }, message);
  const answers = (p: Page) => p.evaluate(() => (window as unknown as { __answers?: boolean[] }).__answers ?? []) as Promise<boolean[]>;
  /** クイックメニューのボタンにフォーカスを置く（閉じたあとにここへ戻るかを見る）。 */
  const focusBar = (p: Page) =>
    p.evaluate(() => {
      document.querySelector<HTMLElement>(".lm-menubar button[data-action=backlog]")!.focus();
    });

  it("確認: 開くと「はい」を選び、矢印と Tab は二つのボタンの間だけを動き、Enter と Space とパッドの A で答え、Esc と右クリックとパッドの B は「いいえ」。閉じたら開く前のところへ戻す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await recordEvents(p);
      const pages = await p.evaluate(() => window.__liminalia!.pages());

      // 開く。alertdialog（aria-modal）で、文とボタン（いいえ、はい の順）を出し、「はい」にフォーカス
      // 名前は見えない見出しの「確認」（aria-labelledby）、説明は尋ねる文（aria-describedby。前はどちらも無く、名前の無いダイアログとして読まれた）
      await focusProbe(p);
      await ask(p, "消してよいですか？");
      await waitScreen(p, "confirm");
      const d = await dialogOf(p, "confirm");
      expect([d?.role, d?.modal, d?.label], name).toEqual(["alertdialog", "true", "確認"]);
      expect(
        await p.evaluate(() => {
          const by = document.querySelector("[data-lm-screen=confirm] [role=alertdialog]")?.getAttribute("aria-describedby");
          return by ? (document.getElementById(by)?.textContent ?? null) : null;
        }),
        name,
      ).toBe("消してよいですか？");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("消してよいですか？");
      expect(await p.locator(".lm-dialog-buttons button").allTextContents(), name).toEqual(["いいえ", "はい"]);
      for (const cls of [".lm-dialog-backdrop", ".lm-dialog"]) expect(await p.locator(cls).count(), `${name} ${cls}`).toBe(1);
      await waitFocus(p, ".lm-dialog-buttons");
      expect(await focusedLabel(p), name).toBe("はい");
      expect(await events(p), name).toEqual(["screen-open:confirm"]);

      // 矢印: 左で「いいえ」、右で「はい」。端からさらに押しても外へ出ない
      await p.keyboard.press("ArrowLeft");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("ArrowLeft");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("ArrowRight");
      expect(await focusedLabel(p), name).toBe("はい");
      // Tab と Shift+Tab は二つのボタンを回る
      await p.keyboard.press("Tab");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("Tab");
      expect(await focusedLabel(p), name).toBe("はい");
      await p.keyboard.press("Shift+Tab");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("Shift+Tab");
      expect(await focusedLabel(p), name).toBe("はい");
      // 遊んでいる最中のキー（バックログの B、クイックセーブの S）は効かない
      await p.keyboard.press("b");
      await p.keyboard.press("s");
      expect((await screenNow(p)).screen, name).toBe("confirm");
      expect(await p.locator(".lm-toast").count(), name).toBe(0);

      // Enter で「はい」。本文は送らず、開く前のボタンへフォーカスを戻す
      await p.keyboard.press("Enter");
      await waitScreen(p, null);
      expect(await answers(p), name).toEqual([true]);
      expect(await p.evaluate(() => window.__liminalia!.pages()), name).toBe(pages);
      expect(await onProbe(p), name).toBe(true);
      expect(await events(p), name).toEqual(["screen-close:confirm"]);

      // Esc は「いいえ」
      await focusProbe(p);
      await ask(p, "二つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      // 右クリックは「いいえ」
      await ask(p, "三つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.mouse.click(100, 100, { button: "right" });
      await waitScreen(p, null);
      // パッドの B は「いいえ」
      await ask(p, "四つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await pad(p, "b");
      await waitScreen(p, null);
      // パッドの十字キーで「いいえ」を選んで A
      await ask(p, "五つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await pad(p, "left");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await pad(p, "right");
      expect(await focusedLabel(p), name).toBe("はい");
      await pad(p, "left");
      await pad(p, "a");
      await waitScreen(p, null);
      // Space で「はい」
      await ask(p, "六つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press(" ");
      await waitScreen(p, null);
      // 背景の暗がりを押しても閉じない（答えるまで残る）
      await ask(p, "七つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.mouse.click(30, 30);
      expect((await screenNow(p)).screen, name).toBe("confirm");
      await p.locator(".lm-dialog-buttons button", { hasText: "いいえ" }).click();
      await waitScreen(p, null);
      expect(await answers(p), name).toEqual([true, false, false, false, false, true, false]);
      expect(await p.evaluate(() => window.__liminalia!.pages()), name).toBe(pages);
      await p.close();
    }
  });

  it("確認: コンフィグで確認を省くと、上書きなどは尋ねずに「はい」にし、削除は省かずに尋ねる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await p.evaluate(() => window.__liminalia!.system.updateSettings!({ confirm: false }));
      const said = await p.evaluate(() => window.__liminalia!.system.ask!("上書きしますか？", "overwrite"));
      expect([said, (await screenNow(p)).screen], name).toEqual([true, null]);
      await p.evaluate(() => {
        const w = window as unknown as { __del: boolean[] };
        w.__del = [];
        void window.__liminalia!.system.ask!("削除しますか？", "delete").then((ok) => w.__del.push(ok));
      });
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitScreen(p, null);
      expect(await p.evaluate(() => (window as unknown as { __del: boolean[] }).__del), name).toEqual([true]);
      await p.close();
    }
  });

  it("メニュー: Esc とパッドの START と B と右クリックで開き、「ゲームに戻る」を選ぶ。矢印で項目を動き、Esc・右クリック・START・B・背景で閉じ、押した項目はメニューを閉じてから行う", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await recordEvents(p);
      // Esc で開く。dialog（aria-modal）で、名前は見出しの「メニュー」
      await focusProbe(p);
      await p.keyboard.press("Escape");
      await waitScreen(p, "menu");
      expect(await dialogOf(p, "menu"), name).toEqual({ role: "dialog", modal: "true", label: "メニュー" });
      for (const cls of [".lm-menu", ".lm-menu-panel", ".lm-menu-list", ".lm-screen-title", ".lm-button"]) expect(await p.locator(cls).count(), `${name} ${cls}`).toBeGreaterThan(0);
      await waitFocus(p, "[data-lm-screen=menu]");
      expect(await focusedLabel(p), name).toBe("ゲームに戻る");
      // 並ぶ項目（ブラウザ版の既定。ボイスの再生、持ち物、フローチャート、終了、アップデートの確認は出さない）
      expect(await p.locator(".lm-menu-list button").allTextContents(), name).toEqual([
        "Qセーブ",
        "Qロード",
        "セーブ",
        "ロード",
        "オート",
        "スキップ",
        "前の選択肢へ",
        "次の選択肢へ",
        "次の未読へ",
        "バックログ",
        "操作説明",
        "コンフィグ",
        "スクリーンショット",
        "ウィンドウを消す",
        "タイトルへ",
      ]);
      // オートとスキップは押された状態を aria-pressed で渡す
      expect(await p.locator(".lm-menu-list button", { hasText: "オート" }).getAttribute("aria-pressed"), name).toBe("false");
      expect(await p.locator(".lm-menu-list button", { hasText: "スキップ" }).getAttribute("aria-pressed"), name).toBe("false");
      // 矢印で上へ動くと項目を選ぶ（画面の外へは出ない）
      await p.keyboard.press("ArrowUp");
      const up = await focusedLabel(p);
      expect(up !== "ゲームに戻る" && (await focusedIs(p, ".lm-menu-list")), `${name} ${up}`).toBe(true);
      for (let i = 0; i < 30; i++) await p.keyboard.press("ArrowUp");
      expect(await focusedIs(p, "[data-lm-screen=menu]"), name).toBe(true);
      for (let i = 0; i < 30; i++) await p.keyboard.press("ArrowDown");
      expect(await focusedIs(p, "[data-lm-screen=menu]"), name).toBe(true);
      // 開いている間はほかのキー（バックログの B）は効かず、ミュートの M は効く
      await p.keyboard.press("b");
      expect((await screenNow(p)).screen, name).toBe("menu");
      await p.keyboard.press("m");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.mute === true);
      await p.keyboard.press("m");
      await p.waitForFunction(() => window.__liminalia!.system.settings!.mute === false);
      // Esc で閉じ、開く前のボタンへ戻る
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await onProbe(p), name).toBe(true);
      expect(await events(p), name).toEqual(["screen-open:menu", "screen-close:menu"]);

      // クイックメニューのボタンを選んで押して開いた画面（バックログ）を閉じると、フォーカスはそのボタンへ戻る。
      // 帯は画面を開いている間は隠れるので、閉じるときは帯を出し直してからフォーカスを戻す（前は出し直す前に戻そうとして、文書の本体に落ちていた）。
      // 帯のボタンを選んでいるときの Enter は本文を送り、ボタンは押さないので、押すのはクリックで
      await focusBar(p);
      await p.evaluate(() => (document.activeElement as HTMLElement).click());
      await waitScreen(p, "backlog");
      await waitFocus(p, ".lm-log");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await focusedIs(p, ".lm-menubar button[data-action=backlog]"), name).toBe(true);

      // 右クリックで開き、右クリックで閉じる
      await p.mouse.click(640, 300, { button: "right" });
      await waitScreen(p, "menu");
      await p.mouse.click(640, 300, { button: "right" });
      await waitScreen(p, null);
      // パッドの START で開き、START で閉じる
      await pad(p, "start");
      await waitScreen(p, "menu");
      await pad(p, "start");
      await waitScreen(p, null);
      // パッドの B で開き、B で閉じる
      await pad(p, "b");
      await waitScreen(p, "menu");
      await waitFocus(p, "[data-lm-screen=menu]");
      await pad(p, "b");
      await waitScreen(p, null);
      // 「ゲームに戻る」と、背景（枠の外）を押して閉じる。本文は送らない
      const pages = await p.evaluate(() => window.__liminalia!.pages());
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      await p.keyboard.press("Enter");
      await waitScreen(p, null);
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      const panel = (await p.locator(".lm-menu-panel").boundingBox())!;
      await p.mouse.click(Math.max(5, panel.x - 40), 360);
      await waitScreen(p, null);
      expect(await p.evaluate(() => window.__liminalia!.pages()), name).toBe(pages);

      // 項目を押すとメニューを閉じてからその操作（バックログを開く）。パッドの十字キーで選んで A でも同じ
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      await p.locator(".lm-menu-list button", { hasText: "バックログ" }).click();
      await waitScreen(p, "backlog");
      expect(await p.locator("[data-lm-screen=menu]").count(), name).toBe(0);
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await pad(p, "start");
      await waitFocus(p, "[data-lm-screen=menu]");
      // 項目は二列に並ぶ（上へ: タイトルへ → スクリーンショット → 操作説明、右へ: コンフィグ）
      const walked: (string | null)[] = [];
      for (const dir of ["up", "up", "up", "right"]) {
        await pad(p, dir);
        walked.push(await focusedLabel(p));
      }
      expect(walked, name).toEqual(["タイトルへ", "スクリーンショット", "操作説明", "コンフィグ"]);
      expect(await focusedLabel(p), name).toBe("コンフィグ");
      await pad(p, "a");
      await waitScreen(p, "config");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      // 「ウィンドウを消す」はメニューを閉じて枠を隠す。Enter で戻す
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      await p.locator(".lm-menu-list button", { hasText: "ウィンドウを消す" }).click();
      await waitScreen(p, null);
      await p.waitForFunction(() => window.__liminalia!.system.status!.hidden === true);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__liminalia!.system.status!.hidden === false);
      expect(await p.evaluate(() => window.__liminalia!.pages()), name).toBe(pages);
      // 「タイトルへ」は確かめてから。「いいえ」ならゲームに残る
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      await p.locator(".lm-menu-list button", { hasText: "タイトルへ" }).click();
      await waitScreen(p, "confirm");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("タイトル画面に戻りますか？\nセーブしていない進行状況は失われます。");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect((await screenNow(p)).mode, name).toBe("game");
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      await p.locator(".lm-menu-list button", { hasText: "タイトルへ" }).click();
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitMode(p, "title");
      await p.close();
    }
  });

  it("メニュー: オートとスキップを入れている間に開くと aria-pressed が true。作品の ui.keys で割り当てたキーで開き、画面の中では Esc で閉じる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await p.keyboard.press("a");
      await p.waitForFunction(() => window.__liminalia!.system.status!.auto === true);
      await p.keyboard.press("Escape");
      await waitScreen(p, "menu");
      expect(await p.locator(".lm-menu-list button", { hasText: "オート" }).getAttribute("aria-pressed"), name).toBe("true");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await p.close();

      const q = await open(browser, keyed.url, { start: "a" });
      // Esc はメニューに割り当てていないので開かない。q で開く
      await q.keyboard.press("Escape");
      expect((await screenNow(q)).screen, name).toBeNull();
      await q.keyboard.press("q");
      await waitScreen(q, "menu");
      // 画面を開いている間の q は何もせず、Esc で閉じる
      await q.keyboard.press("q");
      expect((await screenNow(q)).screen, name).toBe("menu");
      await q.keyboard.press("Escape");
      await waitScreen(q, null);
      // w でセーブ、o でロード、k でバックログ（B は外れる）
      await q.keyboard.press("w");
      await waitScreen(q, "save");
      await q.keyboard.press("Escape");
      await waitScreen(q, null);
      await q.keyboard.press("o");
      await waitScreen(q, "load");
      await q.keyboard.press("Escape");
      await waitScreen(q, null);
      await q.keyboard.press("b");
      expect((await screenNow(q)).screen, name).toBeNull();
      await q.keyboard.press("k");
      await waitScreen(q, "backlog");
      await q.keyboard.press("Escape");
      await waitScreen(q, null);
      await q.close();
    }
  });

  it("操作説明: メニューから開き、見出しで名前を付け、閉じるボタン・Esc・右クリック・パッドの B で閉じてメニューへは戻らない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await focusProbe(p);
      for (const close of ["button", "Escape", "right", "pad"] as const) {
        await p.keyboard.press("Escape");
        await waitFocus(p, "[data-lm-screen=menu]");
        await p.locator(".lm-menu-list button", { hasText: "操作説明" }).click();
        await waitScreen(p, "help");
        expect(await dialogOf(p, "help"), name).toEqual({ role: "dialog", modal: "true", label: "操作説明" });
        for (const cls of [".lm-help", ".lm-help-body", ".lm-help-table", ".lm-screen-title", ".lm-close"]) expect(await p.locator(cls).count(), `${name} ${cls}`).toBeGreaterThan(0);
        // 開いたら画面の中にフォーカス。タブは作品のページが無いので出さない
        await waitFocus(p, "[data-lm-screen=help]");
        expect(await p.locator(".lm-help .lm-tab").count(), name).toBe(0);
        // 矢印で閉じるボタンを選べる
        await p.keyboard.press("ArrowDown");
        expect(await focusedLabel(p), name).toBe("閉じる");
        if (close === "button") await p.keyboard.press("Enter");
        else if (close === "Escape") await p.keyboard.press("Escape");
        else if (close === "right") await p.mouse.click(640, 400, { button: "right" });
        else await pad(p, "b");
        await waitScreen(p, null);
        // メニューを閉じてから開いたので、閉じたらゲームへ戻る
        expect((await screenNow(p)).mode, `${name} ${close}`).toBe("game");
      }
      await p.close();
    }
  });

  it("結末の名前: 開くと名前のボタンを選び、読み上げの名前に種類・名前・終わりの表記・進む操作を入れ、録画に「進む」を知らせる。Space、パッドの A、パッドの B、右クリックで進み、ほかのキーは効かない", async () => {
    for (const { name, browser } of list) {
      for (const how of ["space", "padA", "padB", "right", "click"] as const) {
        const p = await open(browser, project.url, { start: "end" });
        await waitText(p, "はじまり");
        await p.keyboard.press("Enter");
        await waitScreen(p, "ending");
        await waitFocus(p, ".lm-ending-go");
        for (const cls of [".lm-ending", ".lm-ending-go", ".lm-ending-kind", ".lm-ending-name", ".lm-ending-rule", ".lm-ending-mark"]) expect(await p.locator(cls).count(), `${name} ${cls}`).toBe(1);
        expect(await p.locator(".lm-ending-go").getAttribute("aria-label"), name).toBe("BAD END 沈黙 終 タイトルへ戻る");
        expect(await dialogOf(p, "ending"), name).toMatchObject({ role: "dialog", modal: "true" });
        expect(await p.evaluate(() => window.__liminalia!.host.offered()), name).toMatchObject({ options: ["タイトルへ戻る"], proceed: 0 });
        // バックログ、メニュー、クイックセーブのキーは効かない（開いたまま）
        await p.keyboard.press("b");
        await p.keyboard.press("s");
        expect(await screenNow(p), `${name} ${how}`).toEqual({ mode: "game", screen: "ending" });
        if (how === "space") await p.keyboard.press(" ");
        else if (how === "padA") await pad(p, "a");
        else if (how === "padB") await pad(p, "b");
        else if (how === "right") await p.mouse.click(640, 360, { button: "right" });
        else await p.mouse.click(200, 200);
        await waitMode(p, "title");
        expect(await p.locator(".lm-ending").count(), `${name} ${how}`).toBe(0);
        expect(await p.evaluate(() => window.__liminalia!.host.offered()), `${name} ${how}`).toBeNull();
        await p.close();
      }
    }
  });
});
