import { screenActionName, type ScreenAction, type SystemAction } from "../plugin.ts";
import { DEFAULT_MENU_BAR_ITEMS, type MenuBarItem, type UiMenuBar } from "@liminalia/lang";
import { TEXT } from "./strings.ts";
import { button, el } from "./ui.ts";

export type MenuAction = SystemAction;
/** 帯とメニューに並べられるもの（標準の操作か、作品の画面を開く "screen:<名前>"）。 */
export type MenuEntry = SystemAction | ScreenAction;

/** 回想の間は出さない操作（セーブとロード）。 */
const SAVE_ACTIONS: ReadonlySet<MenuAction> = new Set(["quick-save", "quick-load", "save", "load"]);
/** 帯にだけ置き、メニューには並べない操作（その場で一ページずつ動かすもの、全画面の切り替え）。 */
const BAR_ONLY: ReadonlySet<MenuAction> = new Set(["rollback", "rollforward", "fullscreen"]);

/** 帯の左右の余白（default.css の .lm-menubar の right・left と同じ）。 */
const BAR_MARGIN = 64;
const PORTRAIT_BAR_MARGIN = 16;

/** 帯とメニューに並べる順。exit はデスクトップ版だけ。文言は言語を替えたら変わるので、使うときに読む。 */
const ACTIONS: { action: MenuAction; label: () => string }[] = [
  { action: "quick-save", label: () => TEXT.menu.quickSave },
  { action: "quick-load", label: () => TEXT.menu.quickLoad },
  { action: "save", label: () => TEXT.menu.save },
  { action: "load", label: () => TEXT.menu.load },
  { action: "auto", label: () => TEXT.menu.auto },
  { action: "skip", label: () => TEXT.menu.skip },
  { action: "rollback", label: () => TEXT.menu.rollback },
  { action: "rollforward", label: () => TEXT.menu.rollforward },
  { action: "prev-choice", label: () => TEXT.menu.prevChoice },
  { action: "next-choice", label: () => TEXT.menu.nextChoice },
  { action: "next-unread", label: () => TEXT.menu.nextUnread },
  { action: "backlog", label: () => TEXT.menu.backlog },
  { action: "replay-voice", label: () => TEXT.menu.replayVoice },
  { action: "items", label: () => TEXT.menu.items },
  { action: "help", label: () => TEXT.menu.help },
  { action: "config", label: () => TEXT.menu.config },
  { action: "flowchart", label: () => TEXT.menu.flowchart },
  { action: "screenshot", label: () => TEXT.menu.screenshot },
  { action: "hide", label: () => TEXT.menu.hide },
  { action: "title", label: () => TEXT.menu.title },
  { action: "fullscreen", label: () => TEXT.menu.fullscreen },
  { action: "check-update", label: () => TEXT.menu.checkUpdate },
  { action: "exit", label: () => TEXT.menu.exit },
];

/** 操作の標準の文言（言語に合わせたもの。作品の帯・メニューにも渡す）。 */
export function menuLabel(action: MenuAction): string {
  return ACTIONS.find((a) => a.action === action)?.label() ?? action;
}

/** 遊ぶ人の操作を待つ画面（調べる画面・地図など）の上で開いたメニューに並べない、本文を読み進める操作。 */
const READING_ACTIONS: ReadonlySet<MenuAction> = new Set(["auto", "skip", "prev-choice", "next-choice", "next-unread", "replay-voice", "hide"]);

/** メニューの並びを決める、今の様子。 */
export interface MenuContext {
  desktop: boolean;
  replay?: boolean;
  flowchart?: boolean;
  items?: boolean;
  update?: boolean;
  voice?: boolean;
  overScreen?: boolean;
}

/**
 * 今メニューで使える操作か（回想の間はセーブとロードを除く。ボイスの再生は今のページにボイスがあるときだけ。終了はデスクトップ版だけ、
 * フローチャートと持ち物は作品が使うときだけ、アップデートの確認はデスクトップ版で build.update があるときだけ）。
 * overScreen は、遊ぶ人の操作を待つ画面の上で開いた（本文を読み進める操作を使わない）。メニューを開く操作（menu）は使わない。
 */
export function menuAllows(a: MenuAction, o: MenuContext): boolean {
  return (
    a !== "menu" &&
    !(a === "replay-voice" && !o.voice) &&
    !(a === "exit" && !o.desktop) &&
    !(a === "flowchart" && !o.flowchart) &&
    !(a === "items" && !o.items) &&
    !(a === "check-update" && !o.update) &&
    !(o.replay && SAVE_ACTIONS.has(a)) &&
    !(o.overScreen && READING_ACTIONS.has(a))
  );
}

/** メニューに並べる操作（標準の並び。帯にだけ置く操作は並べない）。 */
export function menuItems(o: MenuContext): MenuAction[] {
  return ACTIONS.map((a) => a.action).filter((a) => !BAR_ONLY.has(a) && menuAllows(a, o));
}

/** メニューの並びに作品の画面を足す（タイトルへ・アップデートの確認・終了の前。それらが無ければ最後）。 */
export function withScreens(items: readonly MenuAction[], screens: readonly ScreenAction[]): MenuEntry[] {
  const at = items.findIndex((a) => a === "title" || a === "check-update" || a === "exit");
  const i = at < 0 ? items.length : at;
  return [...items.slice(0, i), ...screens, ...items.slice(i)];
}

/**
 * ゲーム中、メッセージ枠の下に出す小さな操作の帯。オート・スキップは入っている間は押された見た目にする。
 * 帯には終了を置かない（右クリック・Esc のメニューにだけ置く）。
 */
const barImage = (url: string) => `url("${url.replace(/"/g, '\\"')}")`;

export class MenuBar {
  readonly el: HTMLElement;
  private readonly toggles = new Map<MenuAction, HTMLButtonElement>();
  /** 文字を置き換えるボタン（ui.menuBar.labels）。言語を替えても、書いた文字のままにする。 */
  private labels: UiMenuBar["labels"];

  constructor(
    private readonly run: (a: MenuEntry) => void,
    config?: UiMenuBar,
    private readonly asset?: (path: string) => string,
    /** 作品の画面（"screen:<名前>"）の文字（defineScreen の label。無ければ null で名前を出す）。 */
    private readonly screenLabel: (name: string) => string | null = () => null,
  ) {
    this.labels = config?.labels;
    this.el = el("nav", "lm-menubar");
    this.el.setAttribute("aria-label", TEXT.menu.heading);
    // 帯の上のクリックは送りにしない（ホイールは舞台と同じに扱う）
    this.el.addEventListener("click", (e) => e.stopPropagation());
    this.configure(config);
  }

  /** 置くボタンと並び・帯の位置（liminalia.json の ui.menuBar）。 */
  configure(config: UiMenuBar | undefined): void {
    this.toggles.clear();
    this.labels = config?.labels;
    const items: readonly MenuEntry[] = config?.items ?? DEFAULT_MENU_BAR_ITEMS;
    this.el.replaceChildren();
    for (const action of items) {
      const entry = ACTIONS.find((a) => a.action === action);
      const screen = screenActionName(action);
      if ((!entry && screen === null) || action === "exit") continue;
      const b = button("lm-menubar-button", config?.labels?.[action as MenuBarItem] ?? this.labelOf(action), () => this.run(action));
      b.dataset.action = action;
      // 絵のボタン（ui.menuBar.images）。文字はそのまま読み上げに使う
      const image = config?.images?.[action as MenuBarItem];
      if (image && this.asset) {
        b.classList.add("has-image");
        b.style.setProperty("--lm-bar-image", barImage(this.asset(image)));
        const active = config?.activeImages?.[action as MenuBarItem];
        if (active) b.style.setProperty("--lm-bar-active-image", barImage(this.asset(active)));
      }
      if (action === "auto" || action === "skip") {
        b.setAttribute("aria-pressed", "false");
        this.toggles.set(action, b);
      }
      this.el.append(b);
    }
    this.position = config?.position ?? "bottom-right";
    for (const c of [...this.el.classList]) if (c.startsWith("lm-menubar-at-")) this.el.classList.remove(c);
    this.el.classList.add(`lm-menubar-at-${this.position}`);
    // 左端と上端（ui.menuBar.x・y）。書いた軸だけ position の置き方より優先する
    const style = this.el.style;
    for (const p of ["left", "top", "right", "bottom", "transform"]) style.removeProperty(p);
    if (typeof config?.x === "number" && Number.isFinite(config.x)) {
      style.left = `${config.x}px`;
      style.right = "auto";
      style.transform = "none";
    }
    if (typeof config?.y === "number" && Number.isFinite(config.y)) {
      style.top = `${config.y}px`;
      style.bottom = "auto";
    }
    this.unfit = true;
  }

  private position: string = "bottom-right";
  /** 置くボタンか文言が変わり、帯の大きさを測り直す。 */
  private unfit = true;

  /**
   * 帯が舞台の幅（左右の余白 64px ずつを除く）に収まらなければ、文字と余白を同じ割合で小さくして一行に収める
   * （ボタンを多く置くと、文言が一、二文字ずつ折り返して帯が崩れるので。二段にするとメッセージ枠に重なる）。
   * 測れるのは帯が出ているときだけなので、出したときに測る。
   */
  private fit(): void {
    const stage = this.el.offsetParent as HTMLElement | null;
    if (!stage) return;
    this.unfit = false;
    this.el.style.removeProperty("--lm-menubar-fit");
    // 縦長の舞台は左右の余白が狭い（system/portrait.css の .lm-menubar）
    const room = stage.clientWidth - (stage.closest(".lm-portrait") ? PORTRAIT_BAR_MARGIN : BAR_MARGIN) * 2;
    const need = this.el.offsetWidth;
    if (need <= room) return;
    // ボタンの間（gap）は縮めないので、その分を除いて割合を出す
    const gaps = parseFloat(getComputedStyle(this.el).columnGap || "0") * Math.max(0, this.el.childElementCount - 1);
    const scale = Math.floor(((room - gaps) / (need - gaps)) * 100) / 100;
    if (scale > 0) this.el.style.setProperty("--lm-menubar-fit", String(scale));
  }

  /** 標準の文言（作品の画面は defineScreen の label か名前）。 */
  private labelOf(action: MenuEntry): string {
    const screen = screenActionName(action);
    return screen === null ? menuLabel(action as MenuAction) : (this.screenLabel(screen) ?? screen);
  }

  /** 言語を替えたあと・作品の画面を登録したあと、ボタンの文言を読み直す。 */
  relabel(): void {
    this.el.setAttribute("aria-label", TEXT.menu.heading);
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      const action = b.dataset.action as MenuEntry;
      b.textContent = this.labels?.[action as MenuBarItem] ?? this.labelOf(action);
    }
    this.unfit = true;
  }

  sync(state: { visible: boolean; auto: boolean; skip: boolean; replay?: boolean; canRollback?: boolean; canRollforward?: boolean; canReplayVoice?: boolean }): void {
    this.el.hidden = !state.visible || this.position === "hidden";
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      const action = b.dataset.action as MenuAction;
      b.hidden = !!state.replay && SAVE_ACTIONS.has(action);
      if (action === "rollback") b.disabled = !state.canRollback;
      if (action === "rollforward") b.disabled = !state.canRollforward;
      if (action === "replay-voice") b.disabled = !state.canReplayVoice;
    }
    this.toggles.get("auto")?.setAttribute("aria-pressed", String(state.auto));
    this.toggles.get("skip")?.setAttribute("aria-pressed", String(state.skip));
    if (!this.el.hidden && this.unfit) this.fit();
  }
}

