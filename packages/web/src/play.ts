import type { StageState, Value } from "@liminalia/runtime";
import type { DomHost, RenderContext } from "./dom-host.ts";
import { SYSTEM_REQUESTS, type SystemRequest } from "./plugin.ts";
import { fullscreen } from "./system/fullscreen.ts";
import { argFilter, stageSound } from "./audio.ts";
import { runUpdate } from "./system/update.ts";
import { TEXT } from "./system/strings.ts";
import { pushBackHandler } from "./back.ts";
import { canQuitApp, openExternal, quitApp } from "./native.ts";
import type { InputOffer } from "./input-offer.ts";

/**
 * 遊ぶ側の仕組みに関わる組み込み命令の描画（システム画面への要求・音の一時停止と音量・文字入力・確認の枠・@peek）。
 * システム画面への要求は、まずシステム画面（SystemController.request）に渡し、扱わなければ最小の既定の動きにする。
 */

const num = (v: Value | undefined, d = 0) => (typeof v === "number" ? v : d);
const str = (v: Value | undefined, d = "") => (typeof v === "string" ? v : d);
const channel = (v: Value | undefined) => (v === undefined ? undefined : String(v));
const isRequest = (name: string): name is SystemRequest["name"] => (SYSTEM_REQUESTS as readonly string[]).includes(name);

export async function renderPlay(host: DomHost, ctx: RenderContext, name: string, a: Record<string, Value>, wait: boolean, stage: StageState): Promise<Value | void> {
  if (isRequest(name)) return request(host, ctx, { name, args: a });
  const t = (ms: number) => ctx.time(ms);
  switch (name) {
    case "pause-bgm": {
      ctx.audio.pauseBgm();
      // 止めた位置を状態に残す（セーブに入り、ロードしたあとの @resume-bgm で続きから鳴らす）
      const at = ctx.audio.pausedBgmAt;
      if (stage.bgm && at !== null) stage.bgm.pausedAt = Math.round(at * 1000) / 1000;
      return;
    }
    case "resume-bgm": {
      const at = stage.bgm?.pausedAt;
      if (stage.bgm) delete stage.bgm.pausedAt;
      // ロードしたあとなど、止めた音が手元に無ければ、止めた位置から鳴らし直す
      if (!ctx.audio.resumeBgm() && stage.bgm) void ctx.audio.playBgm(stage.bgm.file, stage.bgm.volume, stage.bgm.loop, 0, { ...stageSound(stage.bgm), ...(typeof at === "number" && at > 0 ? { offset: at } : {}) });
      return;
    }
    case "pause-se":
      ctx.audio.pauseSe(channel(a.channel));
      return;
    case "resume-se": {
      const resumed = ctx.audio.resumeSe(channel(a.channel));
      // ロードしたあとは一時停止した音が手元にないので、ループの効果音を始めから鳴らす。
      for (const [c, se] of Object.entries(stage.loopingSe)) {
        if (!resumed.includes(c) && (a.channel === undefined || String(a.channel) === c)) void ctx.audio.playSe(c, se.file, se.volume, true, 0, stageSound(se));
      }
      return;
    }
    case "bgm-volume":
      ctx.audio.setBgmVolume(num(a.volume, 100), t(num(a.time)));
      return;
    case "se-volume":
      ctx.audio.setSeVolume(channel(a.channel), num(a.volume, 100), t(num(a.time)));
      return;
    case "wait-bgm":
      if (wait && !ctx.skipping) await ctx.audio.waitBgm();
      return;
    case "wait-se":
      if (wait && !ctx.skipping) await ctx.audio.waitSe(channel(a.channel));
      return;
    case "voice":
      // 本文の中の @voice（本文の外のものは実行器が次のページのボイスにする）
      host.playVoice(str(a.folder, "voice"), str(a.file), num(a.volume, 100), typeof a.caption === "string" && a.caption !== "" ? a.caption : undefined, {
        ...(typeof a.channel === "number" ? { channel: a.channel } : {}),
        ...(typeof a.who === "string" && a.who !== "" ? { who: a.who } : {}),
        // 実行器が、書いたフィルターか @voice-filter のものを渡す
        filter: argFilter(a),
      });
      return;
    case "voice-filter":
      ctx.audio.setVoiceFilter(argFilter(a), t(num(a.time)), typeof a.who === "string" && a.who !== "" ? a.who : undefined);
      return;
    case "stop-voice":
      ctx.audio.stopVoice(t(num(a.time)));
      return;
    case "wait-voice":
      if (wait && !ctx.skipping) await ctx.audio.waitVoice();
      return;
    case "text-input":
      return textInput(ctx, a);
    case "item-select":
      return host.pickItem ? host.pickItem(typeof a.title === "string" ? a.title : undefined) : null;
    case "item-add":
      if (a.notify !== false) host.onItemAdded?.(str(a.item));
      return;
    case "dialog":
      return dialog(ctx, a);
    case "peek":
      return peek(ctx, stage);
    default:
      return;
  }
}

/** ロードしたとき、続いている要求（メニューのボタン・ショートカット）をシステム画面に伝え直す。出していた入力の枠は片付ける。 */
export async function restorePlay(host: DomHost, ctx: RenderContext, stage: StageState): Promise<void> {
  // ロード・巻き戻しの前の入力の枠（捨てたプレイのもの）。新しいプレイは命令をもう一度読んで出し直す
  for (const close of [...openPanels]) close();
  const ui = stage.ui ?? { menuButton: true, shortcuts: true, backlog: true };
  await request(host, ctx, { name: "menu-button", args: { mode: ui.menuButton ? "show" : "hide" } });
  await request(host, ctx, { name: "shortcuts", args: { mode: ui.shortcuts ? "on" : "off" } });
  await request(host, ctx, { name: "backlog", args: { mode: ui.backlog ? "on" : "off" } });
}

async function request(host: DomHost, ctx: RenderContext, req: SystemRequest): Promise<void> {
  if (await host.systemRequest?.(req)) return;
  const a = req.args;
  switch (req.name) {
    case "auto":
      host.auto = a.mode === "start";
      return;
    case "skip":
      host.skipping = a.mode === "start";
      return;
    case "shortcuts":
      host.shortcuts = a.mode === "on";
      return;
    case "config":
      if (a["bgm-volume"] !== undefined) ctx.audio.setMasterVolume("bgm", num(a["bgm-volume"]));
      if (a["se-volume"] !== undefined) ctx.audio.setMasterVolume("sound", num(a["se-volume"]));
      if (a["voice-volume"] !== undefined) ctx.audio.setMasterVolume("voice", num(a["voice-volume"]));
      if (a["text-speed"] !== undefined) host.setDefaultTextSpeed(num(a["text-speed"]));
      if (a["auto-wait"] !== undefined) host.autoWait = num(a["auto-wait"]);
      return;
    case "fullscreen":
      // 作品が全画面を許さない（ui.screen.fullscreen が false）なら何もしない
      if (!fullscreen.allowed()) return;
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      else await document.documentElement.requestFullscreen().catch(() => undefined);
      return;
    case "quit":
      // システム画面が無いとき。閉じられない（iOS のアプリとブラウザ）なら知らせるだけ。確認はゲームの中の枠で、遊んでいる言語の文言
      if (!canQuitApp()) await dialog(ctx, { text: TEXT.quitUnavailable });
      else if (a.ask === false || (await dialog(ctx, { text: TEXT.confirm.exit, type: "confirm" })) === true) quitApp();
      return;
    case "window-title":
      document.title = str(a.title);
      return;
    case "presence":
      window.liminaliaDesktop?.presence?.(str(a.text));
      return;
    case "open-url":
      openExternal(str(a.url));
      return;
    case "check-update": {
      // システム画面が扱わないとき（作品が差し替えた画面など）は、ゲームの中の確認の枠で尋ねる
      const update = window.liminaliaDesktop?.update;
      if (update) await runUpdate(update, { ask: async (m) => (await dialog(ctx, { text: m, type: "confirm" })) === true, toast: (m) => console.info(m), language: document.documentElement.lang || "ja" }, true);
      return;
    }
    case "menu-button":
    case "backlog":
    case "backlog-add":
    case "replay-end":
    case "achieve":
      // システム画面が無いときは、メニューのボタンも履歴も回想も実績の知らせもないので、何もしない。
      return;
    default:
      console.info(`@${req.name} はシステム画面が扱っていないため、何もしませんでした`);
  }
}

// ---- 文字入力と確認の枠 ----

/** 出している入力の枠を片付けるもの（ロードしたときに、捨てたプレイの枠を外す。結果は null）。 */
const openPanels = new Set<() => void>();

/** 枠の中で受けて、下（本文の送り）へ渡さないキー。ほか（クイックセーブ・履歴・コンフィグなど）はシステム画面へ渡す。 */
const PANEL_KEYS: ReadonlySet<string> = new Set(["Enter", " ", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete"]);

/**
 * 枠を overlay に出し、押されたボタンの結果で解決する。キー入力が本文の送りに伝わらないようにする（欄で打つ字と決定・移動のキー。
 * ほかのキーはシステム画面へ渡し、出している間もメニュー・セーブ・履歴・コンフィグを開ける）。
 * 戻る（Esc・Android の戻る・スマホのブラウザの戻る）は cancel に渡す（cancel が無い枠はメニューを開く。閉じたら枠に戻る）。
 * build が返した選べるものは、枠を出している間、録画（lim shot --video）に知らせる（RenderContext.offer）。
 * bare なら標準の枠を作らず、build に幕（.lm-panel）を渡す（作品の枠 WebPlugin.screens.dialog）。
 */
function panel(ctx: RenderContext, build: (box: HTMLDivElement, done: (v: Value) => void) => InputOffer | void, cancel?: (done: (v: Value) => void) => void, bare = false): Promise<Value> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = bare ? "lm-panel lm-panel-custom" : "lm-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    // 作品の枠（WebPlugin.screens.dialog）は、標準の枠（.lm-panel-box）を作らずに幕の上へ直に置く
    const box = bare ? root : document.createElement("div");
    if (!bare) {
      box.className = "lm-panel-box";
      root.append(box);
    }
    let release = () => {
      // 戻るの受け口を付ける前に閉じたときは、外すものが無い
    };
    // 指で触る端末では、画面のキーボードに隠れないように、枠を見えている範囲（visualViewport）の上に寄せる
    const unfit = typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches ? fitToKeyboard(root) : () => undefined;
    let withdraw = () => {
      // 選べるものを知らせる前に閉じたときは、外すものが無い
    };
    let closed = false;
    const done = (v: Value) => {
      if (closed) return;
      closed = true;
      openPanels.delete(discard);
      release();
      withdraw();
      unfit();
      root.remove();
      resolve(v);
    };
    const discard = () => done(null);
    openPanels.add(discard);
    // 上にシステム画面（メニュー・セーブ・履歴など）を開いている間は、戻るとキーはそちらが受ける
    const covered = () => !!ctx.system?.status?.screen;
    const back = () => {
      if (covered()) return false;
      if (cancel) cancel(done);
      else void ctx.system?.perform("menu");
      return true;
    };
    release = pushBackHandler(back);
    root.addEventListener("click", (e) => e.stopPropagation());
    root.addEventListener("keydown", (e) => {
      if (covered()) return;
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        back();
      }
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
      if (typing || e.isComposing || PANEL_KEYS.has(e.key)) e.stopPropagation();
    });
    const offer = build(box, done);
    if (offer && !closed) withdraw = ctx.offer?.(offer) ?? withdraw;
    ctx.layers.overlay.append(root);
    (box.querySelector("input") ?? box.querySelector("button"))?.focus();
  });
}

/**
 * 枠を、画面のキーボードを除いた見えている範囲（visualViewport）の上に置く（root の --lm-visible-top と --lm-visible-height。舞台の px）。
 * 返す関数で見るのをやめる。
 */
function fitToKeyboard(root: HTMLElement): () => void {
  root.classList.add("lm-panel-touch");
  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  const update = () => {
    const stage = root.parentElement;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const k = r.height / (stage.offsetHeight || 1) || 1;
    const top = Math.max(0, (vv.offsetTop - r.top) / k);
    const height = Math.max(0, Math.min(stage.offsetHeight - top, vv.height / k));
    root.style.setProperty("--lm-visible-top", `${top}px`);
    root.style.setProperty("--lm-visible-height", `${height}px`);
  };
  requestAnimationFrame(update);
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
  };
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function field(a: Record<string, Value>): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = str(a.initial);
  input.placeholder = str(a.placeholder);
  if (typeof a.max === "number") input.maxLength = a.max;
  return input;
}

/** 文字の入力の種類（@text-input mode=）。number は数字のキーボードで数字だけ、password は打った文字を伏せる。 */
function applyMode(input: HTMLInputElement, mode: string): void {
  if (mode === "password") input.type = "password";
  if (mode === "number") {
    input.inputMode = "numeric";
    input.autocomplete = "off";
    // 数字のほか（全角の数字は半角に）は入れない
    input.addEventListener("input", () => {
      const v = input.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
      if (v !== input.value) input.value = v;
    });
  }
}

/** 受け付ける形（@text-input pattern=。全体が合うか）。正規表現として読めなければ null（何でも受け付ける）。 */
function patternOf(a: Record<string, Value>): RegExp | null {
  if (typeof a.pattern !== "string" || a.pattern === "") return null;
  try {
    return new RegExp(`^(?:${a.pattern})$`, "u");
  } catch {
    console.warn(`@text-input の pattern を正規表現として読めません: ${a.pattern}`);
    return null;
  }
}

/** つないでいるゲームパッドがあるか（画面のキーボードを出す）。 */
function padConnected(): boolean {
  try {
    return typeof navigator.getGamepads === "function" && [...navigator.getGamepads()].some((p) => !!p);
  } catch {
    return false;
  }
}

/** パッドで打つ画面のキーボードの字の並び（mode が number なら数字だけ）。 */
const KEYBOARD_SETS: Record<string, string[]> = {
  kana: ["あいうえお", "かきくけこ", "さしすせそ", "たちつてと", "なにぬねの", "はひふへほ", "まみむめも", "やゆよ", "らりるれろ", "わをんー", "ゃゅょっ", "がぎぐげご", "ざじずぜぞ", "だぢづでど", "ばびぶべぼ", "ぱぴぷぺぽ"],
  katakana: ["アイウエオ", "カキクケコ", "サシスセソ", "タチツテト", "ナニヌネノ", "ハヒフヘホ", "マミムメモ", "ヤユヨ", "ラリルレロ", "ワヲンー", "ャュョッ", "ガギグゲゴ", "ザジズゼゾ", "ダヂヅデド", "バビブベボ", "パピプペポ"],
  latin: ["ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ", "abcdefghij", "klmnopqrst", "uvwxyz", "0123456789", "-.'!? "],
  number: ["123", "456", "789", "0"],
};

/**
 * パッドで打つ画面のキーボード（字のボタンの並び。十字キーで選んで A で入れる）。字の組をタブで替え（日本語なら かな、カナ、英数）、
 * 「1 字消す」で最後の字を消す。入れたら input に input の知らせを送る。
 */
function padKeyboard(input: HTMLInputElement, mode: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "lm-keyboard";
  const keys = document.createElement("div");
  keys.className = "lm-keyboard-keys";
  const type = (s: string) => {
    if (input.maxLength > 0 && [...input.value].length >= input.maxLength) return;
    input.value += s;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const show = (set: string) => {
    keys.replaceChildren(
      ...KEYBOARD_SETS[set]!.map((row) => {
        const line = document.createElement("div");
        line.className = "lm-keyboard-row";
        for (const ch of [...row]) line.append(button(ch === " " ? TEXT.dialog.space : ch, () => type(ch)));
        return line;
      }),
    );
  };
  const sets = mode === "number" ? ["number"] : (document.documentElement.lang || "ja").startsWith("ja") ? ["kana", "katakana", "latin"] : ["latin"];
  const tools = document.createElement("div");
  tools.className = "lm-keyboard-tools";
  if (sets.length > 1)
    for (const set of sets) {
      const b = button(TEXT.dialog.keyboardSets[set] ?? set, () => {
        for (const x of tools.querySelectorAll("[aria-pressed]")) x.setAttribute("aria-pressed", String(x === b));
        show(set);
      });
      b.setAttribute("aria-pressed", String(set === sets[0]));
      tools.append(b);
    }
  tools.append(
    button(TEXT.dialog.backspace, () => {
      input.value = [...input.value].slice(0, -1).join("");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  );
  show(sets[0]!);
  wrap.append(keys, tools);
  return wrap;
}

/** 作品の枠（WebPlugin.screens.dialog）。無ければ null。 */
const dialogLook = (ctx: RenderContext) => ctx.host.screens?.dialog ?? null;

/** 入力の種類（@text-input mode=。知らない値は text）。 */
const inputMode = (a: Record<string, Value>): "text" | "number" | "password" => (a.mode === "number" || a.mode === "password" ? a.mode : "text");

/** 入力欄の中身（作品の枠に渡す）。 */
const inputSpec = (a: Record<string, Value>, mode: "text" | "number" | "password") => ({ initial: str(a.initial), placeholder: str(a.placeholder), max: typeof a.max === "number" ? a.max : null, mode, required: a.required === true });

function textInput(ctx: RenderContext, a: Record<string, Value>): Promise<Value> {
  const pattern = patternOf(a);
  // required=true なら空（空白だけも）のあいだ、pattern があれば合わないあいだは決められない
  const accepts = (v: string) => !((a.required === true && v.trim() === "") || (pattern !== null && !pattern.test(v)));
  const look = dialogLook(ctx);
  if (look) {
    return panel(
      ctx,
      (root, done) => {
        const ok = (v?: string) => {
          const value = typeof v === "string" ? v : str(a.initial);
          if (accepts(value)) done(value);
        };
        root.append(look({ kind: "text", message: str(a.prompt), input: inputSpec(a, inputMode(a)), okLabel: TEXT.dialog.ok, cancelLabel: null, accepts, ok, cancel: () => undefined }));
        // 録画（lim shot --video）は、欄の文字（initial）のまま決める
        return { options: [TEXT.dialog.ok], proceed: 0, choose: () => done(str(a.initial)) };
      },
      undefined,
      true,
    );
  }
  return panel(ctx, (box, done) => {
    const input = field(a);
    const mode = str(a.mode, "text");
    applyMode(input, mode);
    const blocked = () => !accepts(input.value);
    const ok = () => {
      if (!blocked()) done(input.value);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && ok());
    const buttons = document.createElement("div");
    buttons.className = "lm-panel-buttons";
    const okButton = button(TEXT.dialog.ok, ok);
    const refresh = () => {
      okButton.toggleAttribute("disabled", blocked());
      input.toggleAttribute("aria-invalid", pattern !== null && input.value !== "" && !pattern.test(input.value));
    };
    input.addEventListener("input", refresh);
    refresh();
    buttons.append(okButton);
    if (typeof a.prompt === "string" && a.prompt !== "") {
      const prompt = document.createElement("p");
      prompt.textContent = a.prompt;
      box.append(prompt);
      input.setAttribute("aria-label", a.prompt);
    }
    box.append(input);
    // ゲームパッドで遊んでいるなら、画面のキーボードを出す（Steam の画面のキーボードがあるデスクトップ版を除く）
    if (padConnected() && !window.liminaliaDesktop?.gamepadText) box.append(padKeyboard(input, mode));
    box.append(buttons);
    // Steam Deck・ゲームパッドで遊んでいるデスクトップ版は、Steam の画面のキーボードで打つ（打ったら決める。やめたら欄に残る）
    const keyboard = window.liminaliaDesktop?.gamepadText;
    if (keyboard) {
      void keyboard({ description: str(a.prompt, str(a.placeholder)), max: typeof a.max === "number" ? a.max : 64, text: input.value }).then((text) => {
        if (text === null || !input.isConnected) return;
        input.value = text;
        ok();
      });
    }
    // 録画（lim shot --video）は、欄の文字（initial）のまま決める（自動確認の autoplay と同じ。決められない文字でも進める）
    return { options: [okButton.textContent ?? TEXT.dialog.ok], proceed: 0, choose: () => done(input.value) };
  });
}

function dialog(ctx: RenderContext, a: Record<string, Value>): Promise<Value> {
  const type = str(a.type, "alert");
  const look = dialogLook(ctx);
  const cancelled = (done: (v: Value) => void) => done(type === "alert" ? true : type === "input" ? null : false);
  if (look) {
    const kind = type === "confirm" || type === "input" ? type : "alert";
    const okLabel = str(a["ok-label"], TEXT.dialog.ok);
    const cancelLabel = kind === "alert" ? null : str(a["cancel-label"], TEXT.dialog.cancel);
    return panel(
      ctx,
      (root, done) => {
        const ok = (v?: string) => done(kind === "input" ? (typeof v === "string" ? v : str(a.initial)) : true);
        const cancel = () => cancelled(done);
        root.append(look({ kind, message: str(a.text), input: kind === "input" ? inputSpec(a, "text") : null, okLabel, cancelLabel, accepts: () => true, ok, cancel }));
        // 録画（lim shot --video）は OK で進める
        return { options: cancelLabel === null ? [okLabel] : [okLabel, cancelLabel], proceed: 0, choose: (i) => (i === 0 ? ok() : cancel()) };
      },
      cancelled,
      true,
    );
  }
  return panel(ctx, (box, done) => {
    const text = document.createElement("p");
    text.textContent = str(a.text);
    box.append(text);
    const input = type === "input" ? field(a) : null;
    if (input) {
      input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && done(input.value));
      box.append(input);
    }
    const buttons = document.createElement("div");
    buttons.className = "lm-panel-buttons";
    // ボタンの名前を書かなければ、遊んでいる言語のシステム画面の文言（訳のファイルの ui の dialog.ok・dialog.cancel で替えられる）
    const okButton = button(str(a["ok-label"], TEXT.dialog.ok), () => done(input ? input.value : true));
    buttons.append(okButton);
    if (type !== "alert") buttons.append(button(str(a["cancel-label"], TEXT.dialog.cancel), () => done(input ? null : false)));
    box.append(buttons);
    // 録画（lim shot --video）は OK で進める（自動確認の autoplay と同じ）
    return { buttons: [...buttons.children] as HTMLElement[], proceed: 0 };
  }, cancelled);
}

/** メッセージ枠を隠してクリックを待ち、元に戻す。本文は残す。 */
async function peek(ctx: RenderContext, stage: StageState): Promise<void> {
  ctx.message.root.classList.remove("visible");
  await ctx.waitClick();
  ctx.message.root.classList.toggle("visible", stage.window);
}
