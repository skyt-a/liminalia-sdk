import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { dialogOf, events, focusedLabel, focusProbe, onProbe, open, pad, recordEvents, screenNow, waitFocus, waitMode, waitScreen, waitText } from "./screens-behavior-shared.ts";

/**
 * プラグインが差し替えた画面（screens.confirm、screens.menu、screens.saveload、screens.backlog と、タイトルの title）の道筋を固定する。
 * 0.4.0 で標準の画面を HTML の型と印で組み直しても、次の三つが今と同じであること。
 * 1. 差し替えた画面が標準の画面より先に使われる（標準の部品は作らない）
 * 2. 差し替えた画面にも、システムが受け持つ部分（キー、ゲームパッド、閉じ方、閉じる演出、閉じたあとのフォーカスの戻り、
 *    確かめの答えの返し方、画面の出来事）が今までどおり渡る
 * 3. 文言の差し替え（texts。"confirm.title" など）が、差し替えた画面に渡す文と標準の画面の両方に効く
 * プラグインの直下に書いたもの（screens、title、texts）と、テーマ（themes.<名前>。ui.system.preset が合うとき）に書いたものの両方で確かめる。
 */

/** 差し替えた画面の部品（中立の名前）。開いた画面と答えを window に残す。 */
const PARTS = `
const el = (cls, text) => { const e = document.createElement("div"); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const button = (cls, text, onClick) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; b.onclick = onClick; return b; };
window.__closed = [];
window.__titleAsk = [];
window.__leave = null;
/** window.__useLeave が true なら、閉じる演出を window.__leave() を呼ぶまで続ける。 */
const leave = (api) => { api.leave = () => (window.__useLeave ? new Promise((r) => (window.__leave = r)) : undefined); };
const screens = {
  confirm: (api) => {
    const root = el("alt-confirm");
    root.dataset.kind = api.kind;
    root.append(el("alt-confirm-message", api.message));
    const no = button("alt-no", api.no, () => api.answer(false));
    const yes = button("alt-yes", api.yes, () => api.answer(true));
    root.append(no, yes);
    api.onClose(() => window.__closed.push("confirm"));
    requestAnimationFrame(() => yes.focus());
    return root;
  },
  menu: (api) => {
    const root = el("alt-menu");
    window.__menuItems = [...api.items];
    for (const a of api.items) root.append(button("alt-menu-item", api.label(a), () => api.perform(a)));
    root.append(button("alt-menu-close", "とじる", () => api.close()));
    api.onClose?.(() => window.__closed.push("menu"));
    leave(api);
    return root;
  },
  saveload: (api) => {
    const root = el("alt-saves");
    root.dataset.mode = api.mode;
    for (let i = 0; i < 3; i++) {
      const info = api.system.slot(i);
      root.append(button("alt-slot", (info.empty ? "空き" : "使用") + i, async () => {
        if (api.mode === "save") {
          if (!info.empty && !(await api.ask("上書き？", "overwrite"))) return;
          api.notify(api.save(i) ? "書いた" : "書けない");
          api.close();
        } else if (!info.empty) {
          if (api.inGame && !(await api.ask("読む？", "load"))) return;
          api.load(i);
        }
      }));
    }
    root.append(button("alt-saves-close", "とじる", () => api.close()));
    api.onClose(() => window.__closed.push(api.mode));
    return root;
  },
  backlog: (api) => {
    const root = el("alt-log");
    api.entries.forEach((e, i) => {
      root.append(el("alt-log-row", (e.label ?? "") + "|" + e.parts.map((p) => p.text ?? "").join("")));
      if (e.canJump) root.append(button("alt-log-jump", "戻る" + i, () => void api.jump(i)));
    });
    root.append(button("alt-log-close", "とじる", () => api.close()));
    api.onClose(() => window.__closed.push("backlog"));
    return root;
  },
};
const title = (api) => {
  const root = el("alt-title");
  const h = document.createElement("h1");
  h.textContent = "中立の題";
  root.append(h);
  const ask = button("alt-title-ask", "尋ねる", () => void api.ask("本当に？", "confirm").then((ok) => window.__titleAsk.push(ok)));
  root.append(button("alt-title-start", "始める", () => api.start()), button("alt-title-load", "続ける", () => api.load()), ask, button("alt-title-config", "設定", () => api.config()));
  window.__hasSave = api.hasSave();
  return root;
};
const texts = { "confirm.title": "最初の画面へ戻りますか？", "confirm.yes": "うん", "confirm.no": "やめる", "menu.save": "記録する", "help.heading": "あそびかた" };
`;

/** プラグインの直下に書く。 */
const DIRECT = `import { defineWebPlugin } from "@liminalia/web";
${PARTS}
export default defineWebPlugin({ name: "t", screens, title, texts });
`;

/** テーマ（ui.system.preset が neutral のとき）に書く。 */
const THEMED = `import { defineWebPlugin } from "@liminalia/web";
${PARTS}
export default defineWebPlugin({ name: "t", themes: { neutral: { screens, title, texts } } });
`;

const SCENARIO = `@window show
一ページ目。
ソウ「二ページ目。」
三ページ目。
`;

const closed = (p: Page) => p.evaluate(() => (window as unknown as { __closed: string[] }).__closed.splice(0)) as Promise<string[]>;
const titleAsk = (p: Page) => p.evaluate(() => (window as unknown as { __titleAsk: boolean[] }).__titleAsk) as Promise<boolean[]>;
/** 標準の部品が一つも無い（差し替えた画面が先に使われた）。 */
const noStandard = (p: Page) => p.evaluate(() => document.querySelectorAll(".lm-dialog, .lm-dialog-backdrop, .lm-menu-panel, .lm-menu-list, .lm-saveload, .lm-slots, .lm-backlog, .lm-log, .lm-title-menu, .lm-title-button").length) as Promise<number>;

describe.skipIf(!e2e)("差し替えた画面の道筋（ブラウザ）", { timeout: 300_000 }, () => {
  const projects: { label: string; project: TestProject }[] = [];
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    projects.push({ label: "直下", project: await startProject({ scenario: { a: SCENARIO }, plugin: DIRECT, config: { entry: "a" } }) });
    projects.push({ label: "テーマ", project: await startProject({ scenario: { a: SCENARIO }, plugin: THEMED, config: { entry: "a", ui: { system: { preset: "neutral" } } } }) });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const { project } of projects) await project.close();
  });

  it("タイトルと確認: 差し替えたタイトルを使い、矢印とパッドでそのボタンを選んで押せる。api.ask は差し替えた確認で尋ね、Esc・パッドの B は「いいえ」、閉じたら押したボタンへ戻る。texts の文言を渡す", async () => {
    for (const { label, project } of projects) {
      for (const { name, browser } of list) {
        const at = `${name} ${label}`;
        const p = await open(browser, project.url);
        await p.waitForSelector(".alt-title");
        expect(await p.locator(".lm-title-custom .alt-title").count(), at).toBe(1);
        expect(await noStandard(p), at).toBe(0);
        expect(await p.evaluate(() => (window as unknown as { __hasSave: boolean }).__hasSave), at).toBe(false);
        // 矢印とパッドで差し替えたタイトルのボタンを選ぶ（作品の要素はボタンを横に並べている。最初の一押しは向きによらず最初のボタン）
        await p.keyboard.press("ArrowDown");
        expect(await focusedLabel(p), at).toBe("始める");
        await p.keyboard.press("ArrowRight");
        expect(await focusedLabel(p), at).toBe("続ける");
        await pad(p, "right");
        expect(await focusedLabel(p), at).toBe("尋ねる");
        // パッドの A で押すと差し替えた確認。文言は texts（はい・いいえ）
        await recordEvents(p);
        await pad(p, "a");
        await waitScreen(p, "confirm");
        expect(await noStandard(p), at).toBe(0);
        expect(await p.locator(".alt-confirm-message").textContent(), at).toBe("本当に？");
        expect(await p.locator(".alt-confirm button").allTextContents(), at).toEqual(["やめる", "うん"]);
        expect(await p.locator(".alt-confirm").getAttribute("data-kind"), at).toBe("confirm");
        // 差し替えた画面にも dialog（aria-modal）を付け、開いたら中にフォーカス
        expect(await dialogOf(p, "confirm"), at).toMatchObject({ role: "dialog", modal: "true" });
        await waitFocus(p, ".alt-confirm");
        // 開いている間はゲームの操作のキーが効かない
        await p.keyboard.press("b");
        expect((await screenNow(p)).screen, at).toBe("confirm");
        // Esc は「いいえ」。閉じたら押したボタンへ戻る
        await p.keyboard.press("Escape");
        await waitScreen(p, null);
        expect(await focusedLabel(p), at).toBe("尋ねる");
        // パッドの B も「いいえ」、右クリックも
        await pad(p, "a");
        await waitFocus(p, ".alt-confirm");
        await pad(p, "b");
        await waitScreen(p, null);
        await pad(p, "a");
        await waitFocus(p, ".alt-confirm");
        await p.mouse.click(640, 360, { button: "right" });
        await waitScreen(p, null);
        // 差し替えた画面の「うん」で true。キーの Enter で押す
        await pad(p, "a");
        await waitFocus(p, ".alt-yes");
        await p.keyboard.press("Enter");
        await waitScreen(p, null);
        expect(await titleAsk(p), at).toEqual([false, false, false, true]);
        expect(await closed(p), at).toEqual(["confirm", "confirm", "confirm", "confirm"]);
        expect(await events(p), at).toEqual(Array(4).fill(["screen-open:confirm", "screen-close:confirm"]).flat());
        // 「続ける」は差し替えたロードの画面。閉じたら「続ける」へ戻る
        await p.locator(".alt-title-load").focus();
        await p.keyboard.press("Enter");
        await waitScreen(p, "load");
        expect([await p.locator(".alt-saves").getAttribute("data-mode"), await noStandard(p)], at).toEqual(["load", 0]);
        await p.keyboard.press("Escape");
        await waitScreen(p, null);
        expect(await focusedLabel(p), at).toBe("続ける");
        expect(await closed(p), at).toEqual(["load"]);
        // 「始める」でゲームへ
        await p.locator(".alt-title-start").click();
        await waitMode(p, "game");
        await waitText(p, "一ページ目");
        expect(await p.locator(".alt-title").count(), at).toBe(0);
        await p.close();
      }
    }
  });

  it("メニュー: Esc・右クリック・パッドの START と B で差し替えたメニューを開き、同じ操作で閉じる。項目を押すとメニューを閉じてからその操作をし、閉じる演出を待ってから外す", async () => {
    for (const { label, project } of projects) {
      for (const { name, browser } of list) {
        const at = `${name} ${label}`;
        const p = await open(browser, project.url, { start: "a" });
        await recordEvents(p);
        await focusProbe(p);
        await p.keyboard.press("Escape");
        await waitScreen(p, "menu");
        expect([await p.locator(".alt-menu").count(), await noStandard(p)], at).toEqual([1, 0]);
        expect(await dialogOf(p, "menu"), at).toMatchObject({ role: "dialog", modal: "true" });
        await waitFocus(p, "[data-lm-screen=menu]");
        // 並べる操作と、texts で替えた文言（menu.save）
        const items = (await p.evaluate(() => (window as unknown as { __menuItems: string[] }).__menuItems)) as string[];
        expect(items, at).toEqual(["quick-save", "quick-load", "save", "load", "auto", "skip", "prev-choice", "next-choice", "next-unread", "backlog", "help", "config", "screenshot", "hide", "title"]);
        expect(await p.locator(".alt-menu-item").nth(2).textContent(), at).toBe("記録する");
        // 矢印で差し替えた画面のボタンを選ぶ。ゲームの操作のキーは効かない
        await p.keyboard.press("ArrowDown");
        expect(await focusedLabel(p), at).toBe("Qセーブ");
        await p.keyboard.press("b");
        expect((await screenNow(p)).screen, at).toBe("menu");
        // Esc で閉じ、開く前のところへ戻る
        await p.keyboard.press("Escape");
        await waitScreen(p, null);
        expect(await onProbe(p), at).toBe(true);
        expect(await closed(p), at).toEqual(["menu"]);
        expect(await events(p), at).toEqual(["screen-open:menu", "screen-close:menu"]);
        // 右クリック、パッドの START、パッドの B で開いて閉じる
        await p.mouse.click(640, 300, { button: "right" });
        await waitScreen(p, "menu");
        await p.mouse.click(640, 300, { button: "right" });
        await waitScreen(p, null);
        await pad(p, "start");
        await waitScreen(p, "menu");
        await pad(p, "start");
        await waitScreen(p, null);
        await pad(p, "b");
        await waitScreen(p, "menu");
        await pad(p, "b");
        await waitScreen(p, null);
        expect(await closed(p), at).toEqual(["menu", "menu", "menu"]);
        // 閉じる演出: 閉じたらすぐ画面は無いことになり、要素は押せないまま演出が済むまで残る
        await p.evaluate(() => ((window as unknown as { __useLeave: boolean }).__useLeave = true));
        await p.keyboard.press("Escape");
        await waitScreen(p, "menu");
        await p.locator(".alt-menu-close").click();
        await waitScreen(p, null);
        expect(await p.locator(".alt-menu").evaluate((e) => [(e.closest("[data-lm-leaving]") as HTMLElement | null)?.dataset.lmLeaving ?? null, (e.closest("[inert]") ?? null) !== null]), at).toEqual(["true", true]);
        await p.evaluate(() => (window as unknown as { __leave: () => void }).__leave());
        await p.waitForFunction(() => !document.querySelector(".alt-menu"));
        await p.evaluate(() => ((window as unknown as { __useLeave: boolean }).__useLeave = false));
        // 項目（texts の「記録する」= save）を押すと、メニューを閉じて差し替えたセーブを開く
        await p.keyboard.press("Escape");
        await waitScreen(p, "menu");
        await p.locator(".alt-menu-item", { hasText: "記録する" }).click();
        await waitScreen(p, "save");
        expect(await p.locator(".alt-menu").count(), at).toBe(0);
        await p.keyboard.press("Escape");
        await waitScreen(p, null);
        // 「タイトルへ」は差し替えた確認で、texts の confirm.title の文。やめるならゲームに残る
        await p.keyboard.press("Escape");
        await waitScreen(p, "menu");
        await p.locator(".alt-menu-item", { hasText: "タイトルへ" }).click();
        await waitScreen(p, "confirm");
        expect([await p.locator(".alt-confirm").getAttribute("data-kind"), await p.locator(".alt-confirm-message").textContent()], at).toEqual(["title", "最初の画面へ戻りますか？"]);
        await p.locator(".alt-no").click();
        await waitScreen(p, null);
        expect((await screenNow(p)).mode, at).toBe("game");
        // 差し替えていない操作説明にも texts が効く（見出しが画面の名前になる）
        await p.evaluate(() => void window.__liminalia!.system.perform!("help"));
        await waitScreen(p, "help");
        expect((await dialogOf(p, "help"))?.label, at).toBe("あそびかた");
        await p.keyboard.press("Escape");
        await waitScreen(p, null);
        await p.close();
      }
    }
  });

  it("セーブとロード: 差し替えた画面の save・ask・notify・load・close がシステムに届き、Esc・右クリック・パッドの B で閉じる", async () => {
    for (const { label, project } of projects) {
      for (const { name, browser } of list) {
        const at = `${name} ${label}`;
        const p = await open(browser, project.url, { start: "a" });
        await recordEvents(p);
        await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
        await waitScreen(p, "save");
        expect([await p.locator(".alt-saves").getAttribute("data-mode"), await noStandard(p)], at).toEqual(["save", 0]);
        expect(await dialogOf(p, "save"), at).toMatchObject({ role: "dialog", modal: "true" });
        // 空きに書く（知らせを出して閉じる）
        await p.locator(".alt-slot", { hasText: "空き0" }).click();
        await waitScreen(p, null);
        await p.waitForFunction(() => [...document.querySelectorAll(".lm-toast")].some((t) => t.textContent === "書いた"));
        expect(await p.evaluate(() => window.__liminalia!.system.slot!(0).title), at).toBe("一ページ目。");
        // 使っているスロットは api.ask で差し替えた確認（kind は overwrite）。パッドの B は「いいえ」でセーブの画面に戻る
        await p.evaluate(() => window.__liminalia!.host.advance());
        await waitText(p, "二ページ目");
        await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
        await waitScreen(p, "save");
        await p.locator(".alt-slot", { hasText: "使用0" }).click();
        await waitScreen(p, "confirm");
        expect(await p.locator(".alt-confirm").getAttribute("data-kind"), at).toBe("overwrite");
        await waitFocus(p, ".alt-confirm");
        await pad(p, "b");
        await waitScreen(p, "save");
        expect(await p.evaluate(() => window.__liminalia!.system.slot!(0).title), at).toBe("一ページ目。");
        // 右クリックで閉じる
        await p.mouse.click(640, 360, { button: "right" });
        await waitScreen(p, null);
        // ロード: ゲーム中は確かめ（kind は load）、うんで読んで画面を閉じる
        await p.evaluate(() => void window.__liminalia!.system.perform!("load"));
        await waitScreen(p, "load");
        await p.locator(".alt-slot", { hasText: "使用0" }).click();
        await waitFocus(p, ".alt-confirm");
        expect(await p.locator(".alt-confirm").getAttribute("data-kind"), at).toBe("load");
        await p.keyboard.press("Enter");
        await waitScreen(p, null);
        await waitText(p, "一ページ目");
        expect(await closed(p), at).toEqual(["save", "confirm", "save", "confirm", "load"]);
        expect((await events(p)).filter((e) => e.endsWith(":load")), at).toEqual(["screen-open:load", "screen-close:load"]);
        // パッドの B で閉じる
        await p.evaluate(() => void window.__liminalia!.system.perform!("load"));
        await waitScreen(p, "load");
        await waitFocus(p, "[data-lm-screen=load]");
        await pad(p, "b");
        await waitScreen(p, null);
        await p.close();
      }
    }
  });

  it("履歴: B・パッドの Y で差し替えた履歴を開き、Esc・右クリック・パッドの Y と B で閉じる。api.jump は確かめてから読み直す", async () => {
    for (const { label, project } of projects) {
      for (const { name, browser } of list) {
        const at = `${name} ${label}`;
        const p = await open(browser, project.url, { start: "a" });
        await p.evaluate(() => window.__liminalia!.host.advance());
        await waitText(p, "二ページ目");
        await p.evaluate(() => window.__liminalia!.host.advance());
        await waitText(p, "三ページ目");
        await focusProbe(p);
        await p.keyboard.press("b");
        await waitScreen(p, "backlog");
        expect([await p.locator(".alt-log").count(), await noStandard(p)], at).toEqual([1, 0]);
        expect(await p.locator(".alt-log-row").allTextContents(), at).toEqual(["|一ページ目。", "ソウ|「二ページ目。」", "|三ページ目。"]);
        expect(await dialogOf(p, "backlog"), at).toMatchObject({ role: "dialog", modal: "true" });
        await p.keyboard.press("Escape");
        await waitScreen(p, null);
        expect(await onProbe(p), at).toBe(true);
        await pad(p, "y");
        await waitScreen(p, "backlog");
        await pad(p, "y");
        await waitScreen(p, null);
        await pad(p, "y");
        await waitScreen(p, "backlog");
        await pad(p, "b");
        await waitScreen(p, null);
        await p.keyboard.press("b");
        await waitScreen(p, "backlog");
        await p.mouse.click(640, 360, { button: "right" });
        await waitScreen(p, null);
        expect(await closed(p), at).toEqual(["backlog", "backlog", "backlog", "backlog"]);
        // 読み直す: 差し替えた確認（kind は backlog-jump）。やめるなら履歴に残り、うんならそのページへ
        await p.keyboard.press("b");
        await waitScreen(p, "backlog");
        await p.locator(".alt-log-jump", { hasText: "戻る0" }).click();
        await waitScreen(p, "confirm");
        expect(await p.locator(".alt-confirm").getAttribute("data-kind"), at).toBe("backlog-jump");
        await p.locator(".alt-no").click();
        await waitScreen(p, "backlog");
        await p.locator(".alt-log-jump", { hasText: "戻る0" }).click();
        await waitScreen(p, "confirm");
        await p.locator(".alt-yes").click();
        await waitScreen(p, null);
        await waitText(p, "一ページ目");
        await p.close();
      }
    }
  });
});

/** 本文の層の選択肢と結末の名前を差し替える（中立の名前）。 */
const LAYER_PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "t",
  screens: {
    choice: (api) => {
      const row = document.createElement("div");
      row.className = "alt-choices";
      window.__choiceTime = api.time;
      for (const o of api.options) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "alt-choice";
        b.textContent = o.text;
        b.disabled = o.locked;
        b.onclick = () => api.choose(o.index);
        row.append(b);
      }
      return row;
    },
    ending: (api) => {
      const el = document.createElement("div");
      el.className = "alt-ending";
      el.textContent = api.name;
      el.onclick = () => api.close();
      return el;
    },
  },
});
`;

const LAYER_SCENARIO = `@window show
選ぶ前。
@choice timeout=60s default=0
- 一つ目 -> #one
- 鍵の要る二つ目 -> #two locked=true
- 三つ目 -> #three
@end
# one
一つ目を選んだ。
@stop
# two
二つ目を選んだ。
@stop
# three
三つ目を選んだ。
@title-screen ending=bad title="沈黙"
`;

describe.skipIf(!e2e)("差し替えた選択肢と結末の名前の道筋（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: LAYER_SCENARIO }, plugin: LAYER_PLUGIN, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("選択肢: 差し替えても制限時間のバー、数字のキー（押せるものを数える）、矢印、読み上げ、録画への知らせはシステムが受け持つ。結末の名前: 差し替えても録画に知らせ、パッドの B で進む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await waitText(p, "選ぶ前");
      await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForSelector(".alt-choice");
      expect([await p.locator(".choices.lm-choices-custom .alt-choices").count(), await p.locator(".choices > button").count()], name).toEqual([1, 0]);
      expect(await p.evaluate(() => (window as unknown as { __choiceTime: number }).__choiceTime), name).toBe(60_000);
      expect(await p.locator(".choices .choice-timer").count(), name).toBe(1);
      // 読み上げ（ライブ領域）は押せるボタンだけ。録画には押せないものを除いて知らせる
      expect(await p.evaluate(() => [document.querySelector(".lm-sr-only")?.getAttribute("role"), document.querySelector(".lm-sr-only")?.getAttribute("aria-live")]), name).toEqual(["log", "polite"]);
      await p.waitForFunction(() => document.querySelector(".lm-sr-only")?.textContent === "選択肢: 一つ目、三つ目");
      expect(((await p.evaluate(() => window.__liminalia!.host.offered())) as { options: (string | null)[] }).options, name).toEqual(["一つ目", null, "三つ目"]);
      // 出したら最初の押せるボタンを選ぶ。矢印は作品のボタンの間を動く（作品の要素は横に並べている。押せないものは飛ばす）
      await waitFocus(p, ".alt-choice");
      expect(await focusedLabel(p), name).toBe("一つ目");
      await p.keyboard.press("ArrowRight");
      expect(await focusedLabel(p), name).toBe("三つ目");
      // 数字のキー: 2 は押せるものの二つ目（三つ目）
      await p.keyboard.press("2");
      await waitText(p, "三つ目を選んだ");
      expect(await p.locator(".alt-choice").count(), name).toBe(0);
      // 結末の名前
      await p.evaluate(() => window.__liminalia!.host.advance());
      await waitScreen(p, "ending");
      expect([await p.locator(".alt-ending").textContent(), await p.locator(".lm-ending").count()], name).toEqual(["沈黙", 0]);
      expect(await dialogOf(p, "ending"), name).toMatchObject({ role: "dialog", modal: "true" });
      expect(await p.evaluate(() => window.__liminalia!.host.offered()), name).toMatchObject({ options: ["タイトルへ戻る"], proceed: 0 });
      await p.keyboard.press("b");
      expect((await screenNow(p)).screen, name).toBe("ending");
      await pad(p, "b");
      await waitMode(p, "title");
      await p.close();
    }
  });
});
