import { focusables, GamepadInput, navigate, navigateAmong, PLAY_NAV, type Direction, type PadButton } from "./navigation.ts";
import "./input.css";

/**
 * 遊ぶ人の操作のうち、システム画面の作りによらないもの（指の長押し・なぞり、ゲームパッド、矢印キーでボタンを選ぶ、
 * 指で触れる端末のメニューのボタン、横長の作品を縦に持ったときの知らせ）を受ける部品。
 * 何をするか（メニューを開く・履歴を開く…）はシステム画面が controls で渡す。渡さなかった操作は何もしない。
 * 既定のシステム画面もこれを使う。作品が差し替えたシステム画面からも bindPlayerInput で同じ操作を使える。
 *
 * | 操作 | 指 | ゲームパッド |
 * |---|---|---|
 * | menu | 長押し・メニューのボタン | START・B（遊んでいる最中と、選択肢を出している間） |
 * | back（いちばん上の画面を閉じる） | — | B |
 * | backlog | 下へなぞる | Y（遊んでいる最中と、選択肢を出している間） |
 * | setHidden(true / false) | 上へなぞる（隠す）・隠しているときの長押し（戻す） | X（切り替え）・B（戻す） |
 * | config | — | SELECT |
 * | rollback・rollforward（一ページ戻る・進め直す） | 右へなぞる・左へなぞる（swipeSide。画面の左右の端から始めたものは除く） | LB・LT |
 * | skipHeld | — | RB を押している間 |
 * | auto・skip（切り替える） | — | RT・L3 |
 * | mute（ミュートを切り替える） | — | R3 |
 * | quickSave・quickLoad | — | 十字キーの右・左（遊んでいる最中で、選ぶボタンが無いとき） |
 * | advance | タップ（DomHost が送る） | A（選んでいるボタンが無いとき） |
 * 矢印キーと十字キー（左スティック）は navRoot の中のボタンを向きに近い順に選び、A・Enter で押す。
 * navRoot の無い、遊んでいる最中は、舞台の PLAY_NAV（[data-lm-play-nav]。std の常駐のボタンなど）の中のボタンを選ぶ。
 * 十字キーの左右は選んでいるときだけ動かし（選んでいなければクイックセーブ・クイックロード）、A で押し、B で選ぶのをやめる。
 * 矢印キーは、ゲームの操作に割り当てたキー（reserved）ならそちらに渡す。
 * 右スティックは開いている画面（navRoot）の中を送る（選んでいるものの入った、送れる要素。無ければ最初の送れる要素）。
 * ゲームパッドのボタンは、先に選んでいるもの（無ければ navRoot）へ lm-pad（detail.button）を送り、受け手が preventDefault したら
 * ここでは何もしない。右スティックも同じく lm-stick（detail.x・y・dt）を送る。画面が自分でパッドを扱うとき（おまけの CG の鑑賞など）に使う。
 *
 * キーの振り分けを自分で持つシステム画面は、自分のキーの受け口より先に bindPlayerInput を呼ぶ（矢印キーを先に受けるため）。
 */
export interface PlayerControls {
  /** 遊んでいる最中か（ゲーム中で、画面・選択肢・確認の枠が出ていない）。長押し・なぞり・X はこのときだけ効く。 */
  playing(): boolean;
  /** 矢印キーを、ボタンを選んで移る前に渡す（開いている作品の画面が自分で扱うとき）。扱ったら true。 */
  key?(e: KeyboardEvent): boolean;
  /** 矢印キー・十字キーで選ぶ範囲（いちばん上の画面・タイトル・選択肢など）。無ければ null。 */
  navRoot(): HTMLElement | null;
  /** 遊んでいる最中に、ゲームの操作に割り当てたキーか（矢印キーをそちらに使い、常駐のボタンを選ぶのには使わない）。 */
  reserved?(key: string): boolean;
  /** 開いている画面の名前（"menu"・"backlog" ならパッドの START・Y で閉じる）。無ければ null。 */
  screen?(): string | null;
  /**
   * 遊ぶ人の操作を待つゲームの中の画面（調べる画面・地図・文字の入力の枠など）だけを出していて、その上にメニュー・履歴・コンフィグを開けるか
   * （パッドの START・Y・SELECT が、遊んでいる最中と同じに開く）。
   */
  overScreen?(): boolean;
  /** 枠を隠しているか。 */
  hidden?(): boolean;
  /** 選択肢を出しているか（横になぞって戻る操作と、パッドの START・Y・B でメニューと履歴を開くのは、選択肢を出している間も受ける）。 */
  choosing?(): boolean;
  /** ゲーム中の送り（パッドの A。オート・スキップの止め方などはシステム画面が決める）。 */
  advance?(): void;
  /** いちばん上の画面を閉じる。閉じたら true。 */
  back?(): boolean;
  menu?(): void;
  backlog?(): void;
  setHidden?(hidden: boolean): void;
  config?(): void;
  /** 一ページ戻る・戻ったところから進め直す（巻き戻し）。 */
  rollback?(): void;
  rollforward?(): void;
  /** 押している間スキップ。 */
  skipHeld?(held: boolean): void;
  /** ミュートを切り替える（パッドの R3）。 */
  mute?(): void;
  /** オート・スキップを切り替える（パッドの RT・L3）。 */
  auto?(): void;
  skip?(): void;
  /** クイックセーブ・クイックロード（遊んでいる最中の十字キーの右・左）。 */
  quickSave?(): void;
  quickLoad?(): void;
}

export interface PlayerInputOptions {
  /** 舞台（DomHost.stage）。 */
  stage: HTMLElement;
  controls: PlayerControls;
  /** 長押し・なぞりを受けない要素（システム画面のボタンの上など）。 */
  ignore?(target: Node): boolean;
  /** 指の操作を受けるか（既定 true）。 */
  touch?: boolean;
  /** 指で横になぞったら rollback・rollforward（右へなぞると戻る、左へなぞると進め直す）を呼ぶか（既定 true）。 */
  swipeSide?: boolean | (() => boolean);
  /** ゲームパッドを受けるか（既定 true）。 */
  gamepad?: boolean;
  /** 矢印キーで選ぶか（既定 true）。 */
  arrows?: boolean;
  /** 指で触れる端末に出すメニューのボタン（parent の中に置く。押すと controls.menu）。省略で出さない。 */
  touchMenu?: { parent: HTMLElement; label: string };
  /**
   * 横長の作品を縦に持ったときの知らせ（舞台の外に出す）。省略で出さない。
   * 縦に持って収まる舞台の幅が ROTATE_FIT_WIDTH より狭ければ画面全体を覆い（onCover(true)。止めるのはシステム画面）、
   * 広ければ（タブレットなど）上に知らせだけを出して keep のボタン（このまま遊ぶ）で閉じられる（このプレイの間は出し直さない）。
   */
  rotateHint?: { text: string; keep?: string; onCover?(covering: boolean): void };
  /** 標準の配置でないゲームパッドをつないだとき（はじめて見たときに一度）。 */
  onNonstandardPad?(id: string): void;
}

export interface PlayerInput {
  /** メニューのボタンを出す・隠す（ゲーム中だけ出すなど）。指で触れる端末でなければ、出すにしても見えない。 */
  setMenuButtonVisible(visible: boolean): void;
  /** 言語を替えたとき、メニューのボタンと縦向きの知らせの文言を替える。 */
  relabel(o: { menu?: string; rotate?: string; rotateKeep?: string }): void;
  /** キー・パッドで選んでいる枠を消す（マウスで操作し始めたときなど。ふつうは自動で消える）。 */
  clearNavigation(): void;
  /** ゲームパッドのボタンの入れ替え（押したボタン → その役目のボタン。コンフィグの「操作」）。 */
  setPadMap(map: Readonly<Record<string, string>>): void;
  /** 次に押したゲームパッドのボタン（入れ替える前のもの）を一度だけ受け取る（コンフィグで割り当てるとき）。null でやめる。 */
  capturePad(take: ((button: PadButton) => void) | null): void;
}

/** 長押しとみなす時間、指がぶれてよい幅、なぞりとみなす速さと長さ（画面の px）。 */
const LONG_PRESS = 550;
const TOUCH_SLOP = 12;
const SWIPE_TIME = 600;
const SWIPE_DISTANCE = 60;
/** 横になぞるのを受けない、画面の左右の端の幅（iOS の Safari などは端からなぞると前のページへ戻る）。 */
const SWIPE_EDGE = 24;
/** 縦に持ったときに収まる舞台の幅がこれ以上（CSS の px）なら、覆わずに知らせだけにする（タブレットなど）。 */
export const ROTATE_FIT_WIDTH = 560;
/** 矢印キーの向き。 */
const ARROWS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** ゲームパッドのボタンの受け手（bindPlayerInput が置く）。 */
const virtualPads = new Set<(button: PadButton, pressed: boolean) => void>();

/**
 * ゲームパッドのボタンを押した（離した）ことにする。ゲームパッドの API を通らない操作（Steam Input のアクションなど）を、
 * ゲームパッドと同じ動き（a: 決定と送り、b: 戻る、start: メニュー、rb: 押している間スキップ など）にする。
 */
export function pressPadButton(button: PadButton, pressed: boolean): void {
  for (const pad of virtualPads) pad(button, pressed);
}

export function bindPlayerInput(o: PlayerInputOptions): PlayerInput {
  const c = o.controls;
  let padMap: Record<string, string> = {};
  let padCapture: ((button: PadButton) => void) | null = null;
  const stage = o.stage;
  const setNavigating = (on: boolean) => stage.classList.toggle("lm-nav", on);
  /** 遊んでいる最中に選べるもの（舞台の PLAY_NAV の中の、見えているボタン。std の常駐のボタンなど）。遊んでいなければ空。 */
  const playItems = (): HTMLElement[] => (c.playing() ? [...stage.querySelectorAll<HTMLElement>(PLAY_NAV)].flatMap((r) => focusables(r)) : []);
  /** 遊んでいる最中に選んでいるもの（PLAY_NAV の中にフォーカスがあれば）。 */
  const playFocused = (): HTMLElement | null => {
    const a = document.activeElement;
    return a instanceof HTMLElement && stage.contains(a) && a.closest(PLAY_NAV) && c.navRoot() === null ? a : null;
  };
  const nav = (dir: Direction, pad = false): boolean => {
    const root = c.navRoot();
    if (!root) {
      // 遊んでいる最中は常駐のボタンなど。十字キーの左右は選んでいるときだけ（選んでいなければクイックセーブ・クイックロード）
      const items = playItems();
      if (items.length === 0 || (pad && (dir === "left" || dir === "right") && !playFocused())) return false;
      setNavigating(true);
      return navigateAmong(items, dir);
    }
    setNavigating(true);
    // 選べるものが無い画面（おまけの CG を大きく見ているなど）では、矢印キーをその画面に渡す
    if (focusables(root).length === 0) return false;
    navigate(root, dir);
    return true;
  };
  /** 選んでいるもの（無ければ開いている画面）へ、パッドの操作を知らせる。受け手が扱ったら true。 */
  const notify = (type: "lm-pad" | "lm-stick", detail: Record<string, unknown>): boolean => {
    const root = c.navRoot();
    if (!root) return false;
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : root;
    return !active.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail }));
  };
  /** 右スティックで開いている画面を送る。 */
  const scrollScreen = (x: number, y: number, dt: number) => {
    const root = c.navRoot();
    if (!root || notify("lm-stick", { x, y, dt })) return;
    const scrolls = (el: Element) => {
      const s = getComputedStyle(el);
      return (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1);
    };
    let target: Element | null = null;
    for (let n: Element | null = document.activeElement; n && root.contains(n); n = n.parentElement) {
      if (scrolls(n)) {
        target = n;
        break;
      }
    }
    target ??= [root, ...root.querySelectorAll("*")].find((el) => !el.closest("[inert], [hidden]") && scrolls(el)) ?? null;
    if (!target) return;
    const speed = 1.2 * dt;
    target.scrollBy({ left: x * speed, top: y * speed });
  };
  stage.addEventListener("pointermove", () => setNavigating(false));
  /** 横になぞるのを受けるか（swipeSide。関数なら、なぞるたびに聞く）。 */
  const side = () => (typeof o.swipeSide === "function" ? o.swipeSide() : o.swipeSide !== false);

  // ---- 指で触れる端末のメニューのボタンと、縦向きの知らせ ----
  let menuButton: HTMLButtonElement | null = null;
  if (o.touchMenu) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lm-touch-menu";
    b.textContent = o.touchMenu.label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      c.menu?.();
    });
    o.touchMenu.parent.append(b);
    menuButton = b;
  }
  let rotate: HTMLElement | null = null;
  let rotateText: HTMLElement | null = null;
  let rotateKeep: HTMLButtonElement | null = null;
  if (o.rotateHint) {
    const hint = o.rotateHint;
    rotate = document.createElement("div");
    rotate.className = "lm-rotate";
    rotate.setAttribute("role", "status");
    rotateText = document.createElement("span");
    rotateText.textContent = hint.text;
    rotateKeep = document.createElement("button");
    rotateKeep.type = "button";
    rotateKeep.className = "lm-rotate-keep";
    rotateKeep.textContent = hint.keep ?? "OK";
    rotate.append(rotateText, rotateKeep);
    document.body.append(rotate);
    /** 知らせを閉じた（このプレイの間は出し直さない）。 */
    let kept = false;
    let covering = false;
    const update = () => {
      const touch = matchMedia("(pointer: coarse)").matches || document.documentElement.classList.contains("lm-emulate-touch");
      const portrait = matchMedia("(orientation: portrait)").matches;
      const on = touch && portrait;
      // 縦に持ったときに収まる舞台の幅（舞台の縦横比で、画面の幅か高さのどちらかに合わせる）
      const aspect = stage.offsetWidth > 0 && stage.offsetHeight > 0 ? stage.offsetWidth / stage.offsetHeight : 16 / 9;
      const fit = Math.min(window.innerWidth, window.innerHeight * aspect);
      const notice = on && fit >= ROTATE_FIT_WIDTH;
      const cover = on && !notice;
      rotate!.classList.toggle("is-cover", cover);
      rotate!.classList.toggle("is-notice", notice && !kept);
      if (cover !== covering) {
        covering = cover;
        hint.onCover?.(cover);
      }
    };
    rotateKeep.addEventListener("click", (e) => {
      e.stopPropagation();
      kept = true;
      update();
    });
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    update();
  }

  // ---- 指の長押し・なぞり ----
  /** 長押しでメニューを開いた時刻（続けて来る Android の長押しの右クリックを捨てる）。 */
  let longPressAt = -Infinity;
  if (o.touch !== false) {
    let start: { x: number; y: number; t: number; lastX: number; lastY: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let swallowUntil = 0;
    stage.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        // 選択肢を出している間は、横になぞって戻るのだけを受ける
        const sideOnly = !c.playing() && side() && c.choosing?.() === true;
        if (!t || e.touches.length > 1 || (!c.playing() && !sideOnly) || o.ignore?.(e.target as Node)) {
          start = null;
          return;
        }
        start = { x: t.clientX, y: t.clientY, t: performance.now(), lastX: t.clientX, lastY: t.clientY };
        clearTimeout(timer);
        if (sideOnly) return;
        timer = setTimeout(() => {
          if (!start || !c.playing()) return;
          start = null;
          // 長押しのあとのクリック（ブラウザによっては来る）と、Android の長押しの右クリックは使わない
          longPressAt = performance.now();
          swallowUntil = longPressAt + 600;
          if (c.hidden?.()) c.setHidden?.(false);
          else c.menu?.();
        }, LONG_PRESS);
      },
      { passive: true },
    );
    // 遊んでいる画面の上では、指を動かしてもスクロールさせない（ブラウザがスクロールに取ると、なぞりが途中で切れる）
    stage.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (!start || !t) return;
        // 選択肢を出している間は止めない（並びが長ければ縦にスクロールできるように）
        if (c.playing()) e.preventDefault();
        start.lastX = t.clientX;
        start.lastY = t.clientY;
        if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > TOUCH_SLOP) clearTimeout(timer);
      },
      { passive: false },
    );
    stage.addEventListener("touchend", () => {
      clearTimeout(timer);
      if (!start) return;
      const from = start;
      const dx = from.lastX - from.x;
      const dy = from.lastY - from.y;
      const quick = performance.now() - from.t < SWIPE_TIME;
      start = null;
      const playing = c.playing();
      if (!quick || (!playing && !c.choosing?.())) return;
      if (Math.abs(dy) >= SWIPE_DISTANCE && Math.abs(dy) >= Math.abs(dx) * 1.5) {
        if (!playing) return;
        if (dy > 0) c.backlog?.();
        else c.setHidden?.(true);
        return;
      }
      // 横: 右へなぞると一ページ戻り、左へなぞると進め直す。画面の端から始めたものは OS の戻る操作なので見ない
      if (!side() || Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (from.x < SWIPE_EDGE || from.x > window.innerWidth - SWIPE_EDGE) return;
      if (dx > 0) c.rollback?.();
      else c.rollforward?.();
    });
    stage.addEventListener("touchcancel", () => {
      clearTimeout(timer);
      start = null;
    });
    // 長押しの直後のクリックは送りにしない（DomHost は舞台の click で送る）。システム画面のクリックの受け口より先に見る
    stage.addEventListener(
      "click",
      (e) => {
        if (performance.now() > swallowUntil) return;
        swallowUntil = 0;
        e.stopImmediatePropagation();
      },
      true,
    );
    stage.addEventListener(
      "contextmenu",
      (e) => {
        if (performance.now() - longPressAt > 1000) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }

  // ---- ゲームパッド ----
  if (o.gamepad !== false) {
    const onPad = (button: PadButton, pressed: boolean) => {
      if (button === "rb") {
        c.skipHeld?.(pressed);
        return;
      }
      if (!pressed) return;
      // 開いている画面が自分で扱う操作（lm-pad を preventDefault したもの）
      if (notify("lm-pad", { button })) return;
      if (button === "up" || button === "down" || button === "left" || button === "right") {
        // 選ぶボタンが無いとき（遊んでいる最中）は、右でクイックセーブ、左でクイックロード
        if (nav(button, true) || !c.playing()) return;
        if (button === "right") c.quickSave?.();
        else if (button === "left") c.quickLoad?.();
        return;
      }
      const root = c.navRoot();
      // 画面の根（開いたときにフォーカスを置く）は選んでいるものに数えない（押すと画面の外を押したことになる）
      const focused = document.activeElement instanceof HTMLElement && document.activeElement !== root && root?.contains(document.activeElement) ? document.activeElement : null;
      const screen = c.screen?.() ?? null;
      switch (button) {
        case "a": {
          const picked = focused ?? playFocused();
          if (picked) {
            setNavigating(true);
            picked.click();
          } else if (root) nav("down");
          else c.advance?.();
          return;
        }
        case "b": {
          if (c.back?.()) return;
          // 常駐のボタンを選んでいれば、選ぶのをやめる
          const picked = playFocused();
          if (picked) {
            picked.blur();
            return;
          }
          if (c.hidden?.()) c.setHidden?.(false);
          else if (c.playing() || c.choosing?.()) c.menu?.();
          return;
        }
        case "x":
          if (c.playing()) c.setHidden?.(!c.hidden?.());
          return;
        case "y":
          if (screen === "backlog") c.back?.();
          else if (c.playing() || c.choosing?.() || c.overScreen?.()) c.backlog?.();
          return;
        case "start":
          if (screen === "menu") c.back?.();
          else if (c.playing() || c.choosing?.() || c.overScreen?.()) c.menu?.();
          return;
        case "select":
          if (!screen || c.overScreen?.()) c.config?.();
          return;
        // 選択肢を出している間も戻れる
        case "lb":
          if (!screen) c.rollback?.();
          return;
        case "lt":
          if (!screen) c.rollforward?.();
          return;
        case "rt":
          if (!screen) c.auto?.();
          return;
        case "l3":
          if (!screen) c.skip?.();
          return;
        case "r3":
          c.mute?.();
          return;
      }
    };
    // ゲームパッドのボタンは、入れ替え（コンフィグの「操作」）を通してから受ける。割り当てを決めている間は、押したボタンをそのまま渡す
    new GamepadInput(
      (button, pressed) => {
        if (padCapture) {
          if (pressed) {
            const take = padCapture;
            padCapture = null;
            take(button);
          }
          return;
        }
        onPad((padMap[button] as PadButton | undefined) ?? button, pressed);
      },
      {
        onStick: (x, y, dt) => {
          if (!padCapture) scrollScreen(x, y, dt);
        },
        ...(o.onNonstandardPad ? { onNonstandard: o.onNonstandardPad } : {}),
      },
    );
    // 店のコントローラーの操作（Steam Input）は役目のボタンとして受ける（入れ替えない）
    virtualPads.add(onPad);
  }

  // ---- 矢印キー ----
  if (o.arrows !== false) {
    window.addEventListener(
      "keydown",
      (e) => {
        const arrow = ARROWS[e.key];
        if (!arrow || e.altKey || e.metaKey || e.ctrlKey) return;
        if (c.key?.(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        const active = document.activeElement;
        // 入力欄の中の左右は文字の上を動かし、つまみの左右は値を一目盛り動かす（どちらもブラウザに任せる）
        if (((active instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(active.type)) || active instanceof HTMLTextAreaElement) && (arrow === "left" || arrow === "right")) {
          if (active instanceof HTMLInputElement && active.type === "range") setNavigating(true);
          return;
        }
        // 遊んでいる最中に、ゲームの操作に割り当てた矢印キーはそちらへ（常駐のボタンを選ぶのに使わない）
        if (!c.navRoot() && c.reserved?.(e.key)) return;
        if (nav(arrow)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  return {
    setMenuButtonVisible(visible) {
      if (menuButton) menuButton.hidden = !visible;
    },
    relabel(l) {
      if (menuButton && l.menu !== undefined) menuButton.textContent = l.menu;
      if (rotateText && l.rotate !== undefined) rotateText.textContent = l.rotate;
      if (rotateKeep && l.rotateKeep !== undefined) rotateKeep.textContent = l.rotateKeep;
    },
    clearNavigation() {
      setNavigating(false);
    },
    setPadMap(map) {
      padMap = { ...map };
    },
    capturePad(take) {
      padCapture = take;
    },
  };
}
