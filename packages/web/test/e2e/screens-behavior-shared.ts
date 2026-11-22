import type { Browser, Page } from "playwright-core";

/**
 * screens-behavior-*.test.ts が使う道具。標準の画面の「遊ぶ人から見える動き」を、DOM の作りによらずに読む。
 * 見るのは、開いている画面の名前（window.__liminalia.screen()）、フォーカスのある要素の文字と部品のクラス（screen-catalog.ts の parts と classes）、
 * role と aria の値、システムの出来事（system.onEvent）、録画が読む選べるもの（host.offered()）。
 * 待ちは時間でなく状態で待つ（waitForFunction）。
 */

/** 遊ぶ画面の状態（モードと、いちばん上の画面の名前）。 */
export const screenNow = (p: Page) => p.evaluate(() => window.__liminalia!.screen()) as Promise<{ mode: string; screen: string | null }>;

/** いちばん上の画面がその名前になるまで待つ（null なら、画面がすべて閉じるまで）。 */
export async function waitScreen(p: Page, name: string | null): Promise<void> {
  await p.waitForFunction((n) => window.__liminalia!.screen().screen === n, name, { timeout: 15_000 });
}

/** モードがそれになるまで待つ（title・game）。 */
export async function waitMode(p: Page, mode: string): Promise<void> {
  await p.waitForFunction((m) => window.__liminalia!.screen().mode === m, mode, { timeout: 15_000 });
}

/** 本文にその文字が出て、クリック待ちになるまで待つ。 */
export async function waitText(p: Page, text: string): Promise<void> {
  await p.waitForFunction((s) => !!document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, text, { timeout: 20_000 });
}

/** フォーカスのある要素が、そのセレクタに当たる要素（の中）になるまで待つ。 */
export async function waitFocus(p: Page, selector: string): Promise<void> {
  await p.waitForFunction((s) => !!document.activeElement?.closest(s), selector, { timeout: 10_000 });
}

/** フォーカスのある要素の、見えている文字（無ければ aria-label）。 */
export const focusedLabel = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return null;
    return (a.textContent ?? "").trim() || a.getAttribute("aria-label") || "";
  }) as Promise<string | null>;

/** フォーカスのある要素がそのセレクタに当たるか。 */
export const focusedIs = (p: Page, selector: string) => p.evaluate((s) => !!document.activeElement?.closest(s), selector) as Promise<boolean>;

/** ゲームパッドのボタンを押して離す（input.ts の pressPadButton。ゲームパッドの API を通らない、Steam Input と同じ道）。 */
export async function pad(p: Page, button: string): Promise<void> {
  // 関数で渡すと vitest が import() を書き換えるので、文で渡す
  await p.evaluate(`import("/src/system/input.ts").then((m) => { m.pressPadButton(${JSON.stringify(button)}, true); m.pressPadButton(${JSON.stringify(button)}, false); })`);
}

/** 画面の名前と、その画面の要素の role・aria-modal・名前（aria-labelledby の見出しか aria-label）。 */
export const dialogOf = (p: Page, name: string) =>
  p.evaluate((n) => {
    const root = document.querySelector<HTMLElement>(`[data-lm-screen="${n}"]`);
    if (!root) return null;
    const dialog = root.matches("[role=dialog], [role=alertdialog]") ? root : root.querySelector<HTMLElement>("[role=dialog], [role=alertdialog]");
    if (!dialog) return { role: null, modal: null, label: null };
    const by = dialog.getAttribute("aria-labelledby");
    const label = by ? (document.getElementById(by)?.textContent ?? null) : dialog.getAttribute("aria-label");
    return { role: dialog.getAttribute("role"), modal: dialog.getAttribute("aria-modal"), label };
  }, name) as Promise<{ role: string | null; modal: string | null; label: string | null } | null>;

/** 読み上げ（speechSynthesis）を差し替え、読んだ文を window.__said に残す（ページを開く前に呼ぶ）。 */
export async function captureSpeech(p: Page): Promise<void> {
  await p.addInitScript(() => {
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    Object.defineProperty(window, "speechSynthesis", { value: { speak: (u: { text: string }) => said.push(u.text), cancel: () => undefined, speaking: false, pending: false }, configurable: true });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      lang = "";
      constructor(public text: string) {}
    };
  });
}

/** システムの出来事（screen-open・screen-close など）を window.__events に残し始める。 */
export async function recordEvents(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __events: string[] };
    w.__events = [];
    window.__liminalia!.system.onEvent!((e) => {
      if (e.type === "screen-open" || e.type === "screen-close") w.__events.push(`${e.type}:${e.name}`);
    });
  });
}
export const events = (p: Page) => p.evaluate(() => (window as unknown as { __events: string[] }).__events.splice(0)) as Promise<string[]>;

/** 新しいページで作品を開く（start を渡せばその台本から遊ぶ。渡さなければタイトル）。 */
export async function open(browser: Browser, url: string, o: { start?: string; viewport?: { width: number; height: number }; speech?: boolean; init?: () => void } = {}): Promise<Page> {
  const p = await browser.newPage({ viewport: o.viewport ?? { width: 1280, height: 720 } });
  if (o.speech) await captureSpeech(p);
  if (o.init) await p.addInitScript(o.init);
  await p.goto(`${url}?autostart=1${o.start ? `&start=${encodeURIComponent(o.start)}` : ""}`);
  if (o.start) await p.waitForFunction(() => !!document.querySelector(".message .text .ch") && window.__liminalia!.host.waiting, undefined, { timeout: 60_000 });
  else await p.waitForSelector(".lm-title", { timeout: 60_000 });
  return p;
}

/**
 * 舞台の外にボタンを一つ置いてフォーカスする（画面を閉じたあと、開く前のところへ戻るかを見る目印。
 * クイックメニューのボタンは画面を開いている間は隠れるので目印にしない）。
 */
export async function focusProbe(p: Page): Promise<void> {
  await p.evaluate(() => {
    let b = document.getElementById("lm-test-probe");
    if (!b) {
      b = document.createElement("button");
      b.id = "lm-test-probe";
      b.textContent = "probe";
      b.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.01";
      document.body.append(b);
    }
    b.focus();
  });
}

/** フォーカスが目印（focusProbe）に戻っているか。 */
export const onProbe = (p: Page) => p.evaluate(() => document.activeElement?.id === "lm-test-probe") as Promise<boolean>;
