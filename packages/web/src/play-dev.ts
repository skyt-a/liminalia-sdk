import type { Diagnostic } from "@liminalia/lang";
import type { TestPlayDesktopApi, TestPlayDiagnostic, TestPlayMessage } from "@liminalia/studio/protocol";
import { devText } from "./dev-language.ts";
import type { SystemController } from "./plugin.ts";
import "./play-dev.css";

/**
 * テストプレイ（開発サーバーのプレイヤー。制作画面の舞台と設定の見本は除く）の開発用の道具。書き出しには入らない（main.ts が開発サーバーのときだけ読む）。
 * - シナリオが変わったら、舞台の上に「シナリオが変わりました」と「この場所から読み直す」を出す。読み直すと、今の状態を控え、台本を読み直してから
 *   同じ場所から続ける（SystemController.reloadHere。無いシステム画面は、今のページのセーブを loadSave で読み直し、それも無ければページを読み直す）。⇧R でも
 * - ⇧E とメニューの「このページをシナリオで開く」で、今のページ（選択肢ならその選択肢）の行を制作画面で開く
 * - 実行時の問題（無い素材、式の誤りなど）を右上に小さく数で知らせ、押すとメニュー（上の二つの操作と、問題の一覧。行を押すと制作画面で開く）を出す。
 *   制作画面のチェックにも「テストプレイ」の分類で送る
 * 制作画面へは、制作アプリのテストプレイのウィンドウなら preload の口（window.liminaliaTestPlay）、ブラウザなら BroadcastChannel で渡す。
 * キーは遊ぶ側の既定の割り当て（DEFAULT_KEYS）に無い ⇧R と ⇧E。作品がこのキーを割り当てていても、テストプレイではこちらが先に受ける。
 */

/** @liminalia/studio の protocol.ts の TEST_PLAY_CHANNEL・TEST_PLAY_GLOBAL と同じ（遊ぶ側は制作画面のモジュールを読まない）。 */
const CHANNEL = "liminalia:test-play";
const GLOBAL = "liminaliaTestPlay";
/** 制作画面が「開く」を受けたかを待つ時間（ブラウザ）。 */
const ACK_TIMEOUT = 1000;
/** 隅と制作画面へ送らない実行時の知らせ（コンソールには出る）。 */
const IGNORED = new Set(["save-relocated"]);
/** 覚えておく問題の数（多すぎるときは古いものから捨てる）。 */
const PROBLEM_LIMIT = 200;

export interface PlayDevOptions {
  /** 道具を置く要素（舞台）。 */
  stage: HTMLElement;
  system: SystemController;
  /** 今のページの位置（選択肢ならその選択肢。まだ何も出していなければ null）。 */
  page(): { file: string; line: number } | null;
  /** 開発サーバーの知らせ（import.meta.hot）。 */
  hot: { on(event: "liminalia:scenario-changed", cb: (data: { file: string }) => void): void };
  /** 右上の道具の入口を出すか（撮影・自動確認の ?autostart=1 では出さない）。 */
  corner: boolean;
  /** 右上に開発時の位置表示を出しているか（その下に置く）。 */
  belowStatus: boolean;
}

export interface PlayDev {
  /** 実行時の問題を受ける（main.ts の onDiagnostic から）。 */
  diagnostic(d: Diagnostic): void;
  /** この場所から読み直す。 */
  reloadHere(): Promise<void>;
  /** このページをシナリオで開く。制作画面が受けたら true。 */
  openHere(): Promise<boolean>;
}

/** 制作画面への送り口。アプリのテストプレイのウィンドウはアプリの口、ほかは BroadcastChannel。 */
function studioLink(): { send(m: TestPlayMessage): void; open(m: Extract<TestPlayMessage, { type: "test-play-open" }>): Promise<boolean> } {
  const desktop = (window as unknown as Record<string, TestPlayDesktopApi | undefined>)[GLOBAL];
  if (desktop && typeof desktop.send === "function") {
    return {
      send: (m) => void desktop.send(m).catch(() => false),
      open: (m) => desktop.send(m).catch(() => false),
    };
  }
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  const waiting = new Map<string, (ok: boolean) => void>();
  if (channel) {
    channel.onmessage = (e: MessageEvent<TestPlayMessage>) => {
      if (e.data?.type === "test-play-ack") waiting.get(e.data.id)?.(true);
    };
  }
  return {
    send: (m) => channel?.postMessage(m),
    open: (m) =>
      new Promise<boolean>((resolve) => {
        if (!channel) return resolve(false);
        const timer = setTimeout(() => done(false), ACK_TIMEOUT);
        const done = (ok: boolean) => {
          clearTimeout(timer);
          waiting.delete(m.id);
          resolve(ok);
        };
        waiting.set(m.id, done);
        channel.postMessage(m);
      }),
  };
}

const id = () => Math.random().toString(36).slice(2, 10);

export function installPlayDev(o: PlayDevOptions): PlayDev {
  const link = studioLink();
  const session = id();
  link.send({ type: "test-play-start", session });

  const problems: TestPlayDiagnostic[] = [];
  const seen = new Set<string>();
  let banner: HTMLElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let menu: HTMLElement | null = null;

  /** 押したクリック・ホイール・指は本文の送りにしない。 */
  const shield = (el: HTMLElement) => {
    for (const type of ["click", "wheel", "pointerdown", "pointerup", "contextmenu"] as const) el.addEventListener(type, (e) => e.stopPropagation());
  };
  const button = (text: string, run: () => void, extra: Partial<HTMLButtonElement> & { keys?: string } = {}): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (extra.className) b.className = extra.className;
    if (extra.title) b.title = extra.title;
    if (extra.keys) b.setAttribute("aria-keyshortcuts", extra.keys);
    b.addEventListener("click", () => run());
    return b;
  };

  // ---- 右上の入口（問題の数）とメニュー ----

  const corner = document.createElement("div");
  corner.className = `lm-play-dev${o.belowStatus ? " is-below" : ""}`;
  shield(corner);
  const entry = button("⋯", () => toggleMenu(), { className: "lm-play-dev-entry", title: devText("テストプレイツール", "Test play tools") });
  entry.setAttribute("aria-haspopup", "true");
  entry.setAttribute("aria-expanded", "false");
  corner.append(entry);
  if (o.corner) o.stage.append(corner);

  const paintEntry = () => {
    const errors = problems.filter((p) => p.severity === "error").length;
    const warnings = problems.length - errors;
    entry.classList.toggle("is-error", errors > 0);
    entry.classList.toggle("is-warning", errors === 0 && warnings > 0);
    entry.textContent = errors > 0 ? devText(`エラー ${errors}`, `${errors} ${errors === 1 ? "error" : "errors"}`) : warnings > 0 ? devText(`警告 ${warnings}`, `${warnings} ${warnings === 1 ? "warning" : "warnings"}`) : "⋯";
    if (menu) renderMenu();
  };

  function toggleMenu(): void {
    if (menu) closeMenu();
    else {
      menu = document.createElement("div");
      menu.className = "lm-play-dev-menu";
      menu.setAttribute("role", "menu");
      corner.append(menu);
      entry.setAttribute("aria-expanded", "true");
      renderMenu();
      (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
    }
  }

  function closeMenu(): void {
    menu?.remove();
    menu = null;
    entry.setAttribute("aria-expanded", "false");
  }

  function renderMenu(): void {
    if (!menu) return;
    const items: HTMLElement[] = [
      button(devText("この場所から読み直す", "Reload from here"), () => (closeMenu(), void api.reloadHere()), { title: "⇧R", keys: "Shift+R" }),
      button(devText("このページをシナリオで開く", "Open this page in the script"), () => (closeMenu(), void api.openHere()), { title: "⇧E", keys: "Shift+E" }),
    ];
    for (const b of items) b.setAttribute("role", "menuitem");
    menu.replaceChildren(...items);
    if (problems.length === 0) return;
    const list = document.createElement("ul");
    list.className = "lm-play-dev-problems";
    for (const p of problems) {
      const li = document.createElement("li");
      const b = button("", () => (closeMenu(), void send(p.file, p.line)), { className: `is-${p.severity}` });
      b.setAttribute("role", "menuitem");
      const where = document.createElement("span");
      where.className = "lm-play-dev-where";
      where.textContent = `${p.file}.lim ${p.line}`;
      const text = document.createElement("span");
      text.textContent = p.message;
      b.append(where, text);
      li.append(b);
      list.append(li);
    }
    menu.append(list);
  }

  // ---- 舞台の上の知らせ（シナリオが変わった・制作画面が見つからない） ----

  function showBanner(text: string, actions: HTMLButtonElement[], until?: number): void {
    banner?.remove();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    const b = document.createElement("div");
    b.className = "lm-play-dev-banner";
    b.setAttribute("role", "status");
    const span = document.createElement("span");
    span.textContent = text;
    b.append(span, ...actions, button(devText("閉じる", "Close"), () => hideBanner()));
    shield(b);
    o.stage.append(b);
    banner = b;
    if (until) toastTimer = setTimeout(() => hideBanner(), until);
  }

  function hideBanner(): void {
    banner?.remove();
    banner = null;
  }

  // シナリオが変わった（vite.config.ts の SCENARIO_CHANGED_EVENT）。遊んでいる最中だけ知らせる（タイトルから始めるプレイは新しい台本を読む）
  o.hot.on("liminalia:scenario-changed", () => {
    if (o.system.mode !== "game" || !o.system.runtime) return;
    showBanner(devText("シナリオが変わりました", "The script changed"), [button(devText("この場所から読み直す", "Reload from here"), () => void api.reloadHere(), { className: "is-primary", title: "⇧R", keys: "Shift+R" })]);
  });

  async function send(file: string, line: number): Promise<boolean> {
    const ok = await link.open({ type: "test-play-open", id: id(), file, line });
    if (!ok) showBanner(devText("Studio が開いていません", "Studio isn't open"), [], 4000);
    return ok;
  }

  const api: PlayDev = {
    diagnostic(d) {
      // セーブした位置がシナリオの変更でずれた（読み直したとき・前のセーブを読んだとき）のは、直すべき問題ではない
      if (IGNORED.has(d.code)) return;
      const key = `${d.file}:${d.line}:${d.code}:${d.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      const p: TestPlayDiagnostic = { severity: d.severity, code: d.code, message: d.message, file: d.file, line: d.line };
      problems.push(p);
      if (problems.length > PROBLEM_LIMIT) problems.shift();
      link.send({ type: "test-play-diagnostic", session, diagnostic: p });
      paintEntry();
    },
    async reloadHere() {
      hideBanner();
      const system = o.system;
      if (system.reloadHere) {
        await system.reloadHere();
        return;
      }
      const rt = system.runtime;
      if (rt && system.loadSave) {
        await system.loadSave(rt.save());
        return;
      }
      location.reload();
    },
    async openHere() {
      const at = o.page();
      if (!at) return false;
      return send(at.file, at.line);
    },
  };

  // アプリのメニューの「この場所から読み直す」「このページをシナリオで開く」
  (window as unknown as Record<string, TestPlayDesktopApi | undefined>)[GLOBAL]?.onCommand?.((command) => {
    if (command === "reload") void api.reloadHere();
    else if (command === "open") void api.openHere();
  });

  // ⇧R・⇧E（作品のキーより先に受ける。文字の入力欄では受けない）
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !["checkbox", "radio", "button", "range"].includes(t.type)))) return;
      const key = e.key === "R" || e.code === "KeyR" ? "R" : e.key === "E" || e.code === "KeyE" ? "E" : null;
      if (!key) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (key === "R") void api.reloadHere();
      else void api.openHere();
    },
    true,
  );
  // メニューの外を押す・Esc で閉じる
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (menu && !corner.contains(e.target as Node)) closeMenu();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (menu && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeMenu();
        entry.focus();
      }
    },
    true,
  );

  return api;
}
