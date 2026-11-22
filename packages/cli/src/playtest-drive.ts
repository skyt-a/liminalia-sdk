/**
 * lim playtest の、ページの中で動く手順（ほかのモジュールを読まない。制作アプリのメインのプロセスも、書き出したブラウザ版を
 * 見えないウィンドウで流すときにこれを使う。packages/studio-desktop/src/main/playtest.ts）。
 */

/** lim playtest の既定（--runs、--max-pages、--timeout、--stuck）。 */
export const PLAYTEST_DEFAULTS = { runs: 1, maxPages: 5000, timeoutSeconds: 600, stuckSeconds: 20 } as const;

/**
 * 「はじめから」を始める（ページの中で評価する式）。標準のシステム画面の newGame、差し替えた画面なら「はじめから」の押しボタン。
 * もうゲームの画面なら true、始められなければ false。
 * 始める前に自動確認にする（host.automated）。遊ぶ人の操作を待つ画面（作品のプラグインの画面、@investigate、@text-input など）と
 * 動画は、命令の autoplay で進める（行き先を選ぶ画面は選択肢になり、下の送りの手順が選ぶ）。
 */
export const BEGIN_SOURCE = `(() => {
  const l = window.__liminalia;
  l.host.automated = true;
  if (l.screen().mode === "game") return true;
  if (typeof l.system.newGame === "function") {
    void l.system.newGame();
    return true;
  }
  const button = [...document.querySelectorAll("button, [role=button]")].find((b) => /はじめから|New Game|Start/i.test(b.textContent || ""));
  if (button) button.click();
  return !!button;
})()`;

/**
 * ページの中で動く送りの手順（page.evaluate に文字のまま渡す。TypeScript から渡すと、書き換えで名前を付ける関数 __name が混ざり、ページの中に無いため）。
 * 引数は { run, choose, maxPages, timeout, stuck }。止まらずに送り、選択肢は choose を順に、使い切ったら run + その選択肢に戻った回数 番目を選ぶ。
 * window.__liminaliaPlaytest（lim playtest の --log・--shots・--avoid-…。playtest-watch.ts）があれば、ページごとに step を、
 * 選択肢で pick（choose で決めたもの以外）と choice を呼ぶ。
 */
export const DRIVE_SOURCE = `async (o) => {
  const l = window.__liminalia;
  const hook = window.__liminaliaPlaytest || null;
  const picks = [...o.choose];
  const seen = new Map();
  const choices = [];
  const deadline = performance.now() + o.timeout;
  let lastPages = -1;
  let lastAt = "";
  let moved = performance.now();
  for (;;) {
    const now = l.runtime() && l.runtime().at ? l.runtime().at.file + ":" + l.runtime().at.line : null;
    if (l.ended) return { outcome: "ended", pages: l.pages(), choices, at: now };
    if (l.screen().mode === "title") return { outcome: "title", pages: l.pages(), choices, at: now };
    if (performance.now() > deadline) return { outcome: "timeout", pages: l.pages(), choices, at: now };
    const pages = l.pages();
    if (pages !== lastPages || (now || "") !== lastAt) {
      lastPages = pages;
      lastAt = now || "";
      moved = performance.now();
    }
    if (pages >= o.maxPages) return { outcome: "max-pages", pages, choices, at: now };
    if (performance.now() - moved > o.stuck) return { outcome: "stuck", pages, choices, at: now };
    if (hook) await hook.step();
    const buttons = [...document.querySelectorAll(".layer.choices button")].filter((b) => !b.disabled);
    if (l.system.status && l.system.status.choosing && buttons.length > 0) {
      const key = buttons.map((b) => b.textContent || "").join("\\u0000");
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      const explicit = picks.length > 0;
      let i = (explicit ? picks.shift() : o.run + n) % buttons.length;
      if (hook && !explicit) i = hook.pick(buttons, i);
      if (hook) await hook.choice(buttons, i);
      choices.push((buttons[i].textContent || "").trim() || String(i));
      buttons[i].click();
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    l.host.advance();
    await new Promise((r) => setTimeout(r, 15));
  }
}`;
