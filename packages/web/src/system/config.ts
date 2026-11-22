import { autoDelay, DEFAULT_SETTINGS, PAD_BUTTONS, PLAYER_FONTS, SETTING_RANGES, WINDOW_SCALES, type InactiveAction, type Settings } from "./settings.ts";
import { UI_KEY_ACTIONS, type UiKeyAction } from "@liminalia/lang";
import type { Value } from "@liminalia/runtime";
import { fullscreen } from "./fullscreen.ts";
import { TEXT } from "./strings.ts";
import { languageName } from "./translation.ts";
import { padLabel } from "./pad-names.ts";
import { choice as uiChoice, slider as uiSlider, toggle as uiToggle } from "../ui-parts.ts";
import { el } from "./ui.ts";
import type { ScreenTemplates, TemplateItem } from "./template.ts";

/** キーの名前の見せ方。 */
export function keyName(key: string): string {
  const names: Record<string, string> = { " ": "Space", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  return names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 最後に開いていたタブ（開き直したときに同じタブを出す）。 */
let lastTab = "text";

export interface ConfigOptions {
  /** 「初期設定に戻す」で戻す値（作品の初期値。liminalia.json の ui.defaults）。無ければエンジンの既定値。 */
  defaults?: Settings;
  /** セーブを丸ごと書き出す・読み込む（渡したときだけボタンを出す）。 */
  exportSaves?(): void;
  importSaves?(): void;
  /** 表現を控えめにする項目（作品が使うときだけ。label は項目の名前）。 */
  contentFilter?: { label: string };
  /** システムボイス（作品が使うときだけ。characters は担当を選べるキャラクター。無ければオンとオフ）。 */
  systemVoice?: { characters: string[] };
  /** キーとゲームパッドの割り当て（「操作」のタブ）。keys は作品の割り当て（ui.keys と既定。遊ぶ人の割り当ての下）。 */
  controls?: { keys(action: UiKeyAction, player: Readonly<Record<string, string[]>>): readonly string[]; capturePad(take: ((button: string) => void) | null): void };
  /**
   * 画面の外で設定が変わったら知らせてもらう（M キーのミュートなど。開いたままの画面の値を合わせる）。返す関数で知らせを止める。
   */
  subscribe?(listener: (s: Readonly<Settings>) => void): () => void;
  /** ウィンドウの大きさを選ばせる（デスクトップ版だけ）。game はゲームの大きさ、available は今の画面で使える大きさ。 */
  screenSize?: { game: { width: number; height: number }; available: { width: number; height: number } };
  /**
   * 最小化したときと、ほかのウィンドウを選んだときの動きを選ばせる（デスクトップ版だけ）。hiddenDefault は遊ぶ人が決めていないときの
   * 最小化したときの動き（作品の ui.screen.pauseInBackground）。
   */
  inactive?: { hiddenDefault: InactiveAction };
  /** 音量の欄を動かし終えたら鳴らす試聴（ui.settings.samples。全体の音量は効果音の試聴）。渡したときだけ鳴らす。 */
  sample?(kind: "bgm" | "se" | "voice"): void;
  /** 遊ばれ方の統計を送るか（作品が build.analytics を書いたときだけ。analytics.ts）。設定の値ではなく、この端末に別に覚える。 */
  analytics?: { get(): boolean; set(on: boolean): void };
  /** 作品が既読の文の色（ui.text.readColor）を決めているか（「既読の文の色」の、遊ぶ人が決めていないときの見せ方）。 */
  readColor?: boolean;
  /**
   * 話者ごとの声の音量に、まだ声を聞いていない人物も並べる（作品の ui.settings.voiceSpeakers が all か masked のとき）。
   * all は並べる人物（キャストの話者）、masked なら聞いていない人物の名前を伏せる。
   */
  speakers?: { all: readonly string[]; masked: boolean };
}

/**
 * 「初期設定に戻す」の値。初期値（作品の ui.defaults）に戻し、聞いた話者の一覧・言語・全画面・揺れと点滅を弱める・読み上げ・見やすい色・
 * 選択肢の制限時間は、遊ぶ人が決めたまま残す（作品の設定画面の ConfigScreenApi.reset も同じ）。
 */
export function resetSettings(s: Readonly<Settings>, defaults: Readonly<Settings>): Settings {
  return { ...defaults, voiceSpeakers: s.voiceSpeakers, language: s.language, fullscreen: s.fullscreen, reduceShake: s.reduceShake, reduceFlash: s.reduceFlash, selfVoicing: s.selfVoicing, highContrast: s.highContrast, choiceTimer: s.choiceTimer };
}

/** つまみの欄（data-setting の行の <input>）。 */
interface SliderSpec {
  range: { min: number; max: number; step: number };
  get(): number;
  put(v: number): void;
  /** 値の文字（data-field="設定の名前" の要素に出す）。 */
  show?(v: number): string;
  label?: string;
  commit?: (() => void) | undefined;
}

/** 選択と切り替えの欄（data-value、data-toggle）。 */
interface ValueSpec {
  get(): Value;
  put(v: Value): void;
  /** data-value の文字を値にする。 */
  parse(raw: string): Value;
}

/** data-value の文字を、設定の値の形にする（今の値が真偽なら真偽、数なら数。作品独自の設定は文字の形から）。 */
function parseLike(sample: unknown, raw: string): Value {
  if (typeof sample === "boolean") return raw === "true";
  if (typeof sample === "number") return Number(raw);
  if (sample !== undefined) return raw;
  if (raw === "true" || raw === "false") return raw === "true";
  return raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
}

/**
 * 設定画面を、型（標準か、作品が写して直した ui.templates.config。screens/config.ts）から作る。
 * 項目の行（data-setting）の欄を設定の値と結び、変えたらすぐ change() で反映、保存し、プレビューで文字の速さとオートの待ちを繰り返し見せる。
 * 今は使えない項目の行は外す。タブ（data-role="page" と data-page）は押したものの data-page の要素だけを出す。
 * 話者ごとの声の音量、言語、ウィンドウの大きさ、システムボイス、キーとパッドの割り当ては、数が変わるので一覧の部品で並べる。
 * 作品の画面の JS（ui/screens/config/config.js）があれば呼ぶ。閉じるときに dispose を呼ぶ。
 */
export function createConfig(templates: ScreenTemplates, initial: Settings, change: (s: Settings) => void, close: () => void, languages: readonly string[] = [], o: ConfigOptions = {}): { el: HTMLElement; dispose(): void } {
  let s: Settings = { ...initial };
  /** 画面の値を合わせている間（欄の set が呼ぶ onChange で、もう一度書かない）。 */
  let syncing = false;
  const set = (patch: Partial<Settings>) => {
    if (syncing) return;
    s = { ...s, ...patch };
    change(s);
    restartPreview();
  };
  const syncs: (() => void)[] = [];
  const C = TEXT.config;

  // テキスト速度は「右ほど速い」にするため、つまみの値は (最大 − ミリ秒)
  const speed = SETTING_RANGES.textSpeed;
  const trySample = (kind: "bgm" | "se" | "voice") => (o.sample ? () => o.sample!(kind) : undefined);
  const volume = (key: "master" | "bgm" | "se" | "voice", sample: "bgm" | "se" | "voice"): SliderSpec => ({ range: SETTING_RANGES[key], get: () => s[key], put: (v) => set({ [key]: v }), show: String, label: C[key], commit: trySample(sample) });
  const percent = (key: "windowOpacity" | "textScale"): SliderSpec => ({ range: SETTING_RANGES[key], get: () => s[key], put: (v) => set({ [key]: v }), show: (v) => `${v}%`, label: C[key] });
  const sliders: Record<string, SliderSpec> = {
    textSpeed: {
      range: { min: 0, max: speed.max - speed.min, step: speed.step },
      get: () => speed.max - s.textSpeed,
      put: (v) => set({ textSpeed: speed.max - v }),
      show: (v) => (v === speed.max - speed.min ? C.instant : `${speed.max - v} ms`),
      label: C.textSpeed,
    },
    autoWait: { range: SETTING_RANGES.autoWait, get: () => s.autoWait, put: (v) => set({ autoWait: v }), show: C.seconds, label: C.autoWait },
    windowOpacity: percent("windowOpacity"),
    textScale: percent("textScale"),
    master: volume("master", "se"),
    bgm: volume("bgm", "bgm"),
    se: volume("se", "se"),
    voice: volume("voice", "voice"),
  };

  // 数が変わる選択（一覧の部品 option）: 言語、ウィンドウの大きさ（この画面に収まるものだけ）、システムボイス
  const sizes = o.screenSize ? WINDOW_SCALES.filter((k) => k === 0 || (o.screenSize!.game.width * k <= o.screenSize!.available.width && o.screenSize!.game.height * k <= o.screenSize!.available.height)) : [];
  const voices = o.systemVoice ? ["", ...o.systemVoice.characters, "off"] : [];
  const options: Record<string, { list: string; values: readonly Value[]; items: TemplateItem[] }> = {
    language: { list: "languages", values: languages, items: languages.map((l) => ({ fields: { label: languageName(l), lang: l } })) },
    windowScale: { list: "sizes", values: sizes, items: sizes.map((k) => ({ fields: { label: k === 0 ? C.windowSizeDefault : `${Math.round(o.screenSize!.game.width * k)}×${Math.round(o.screenSize!.game.height * k)}` } })) },
    systemVoice: { list: "voices", values: voices, items: voices.map((v) => ({ fields: { label: v === "" ? (o.systemVoice!.characters.length > 0 ? C.systemVoiceRandom : C.on) : v === "off" ? C.off : v } })) },
  };

  // 今は使えない項目（行ごと外す）
  const unavailable = new Set<string>([
    ...(languages.length > 1 ? [] : ["language"]),
    ...(fullscreen.supported() ? [] : ["fullscreen"]),
    ...(sizes.length > 1 ? [] : ["windowScale"]),
    ...(o.analytics ? [] : ["analytics"]),
    ...(o.contentFilter ? [] : ["contentFilter"]),
    ...(o.systemVoice ? [] : ["systemVoice"]),
    ...(o.inactive ? [] : ["whenHidden", "whenUnfocused"]),
  ]);
  const hiddenDefault = o.inactive?.hiddenDefault ?? "pause";
  /** 選択と切り替えで結ぶ値（設定の名前。作品独自の設定は custom.名前）。 */
  const valueOf = (key: string): ValueSpec | null => {
    const plain = (k: keyof Settings): ValueSpec => ({ get: () => s[k] as Value, put: (v) => set({ [k]: v }), parse: (raw) => parseLike(DEFAULT_SETTINGS[k], raw) });
    switch (key) {
      case "readColor":
        // 遊ぶ人が決めていなければ、作品が決めているかどうか
        return { get: () => s.readColor || (o.readColor ? "on" : "off"), put: (v) => set({ readColor: v as Settings["readColor"] }), parse: (raw) => raw };
      case "language":
        return { get: () => s.language || languages[0] || "", put: (v) => set({ language: v as string }), parse: (raw) => raw };
      case "windowScale":
        return { get: () => s.windowScale, put: (v) => set({ windowScale: v as number, fullscreen: false }), parse: Number };
      case "whenHidden":
        return { get: () => s.whenHidden || hiddenDefault, put: (v) => set({ whenHidden: v as InactiveAction }), parse: (raw) => raw };
      case "analytics":
        // 設定の値ではなく、この端末に別に覚える（初期設定に戻しても変えない）
        return { get: () => o.analytics?.get() ?? false, put: (v) => o.analytics?.set(v === true), parse: (raw) => raw === "true" };
    }
    if (key.startsWith("custom.")) {
      const name = key.slice(7);
      return { get: () => s.custom[name] ?? null, put: (v) => set({ custom: { ...s.custom, [name]: v } }), parse: (raw) => parseLike(s.custom[name] ?? undefined, raw) };
    }
    return key in DEFAULT_SETTINGS && key !== "custom" ? plain(key as keyof Settings) : null;
  };

  // ---- 操作（キーとゲームパッドの割り当て） ----
  /** 割り当てを待っている行（もう一度押すか、ほかを押すとやめる）。 */
  let waiting: { list: string; index: number; stop(): void } | null = null;
  const PAD_ROLES = ["a", "b", "x", "y", "start", "select", "lb", "lt", "rb", "rt", "l3", "r3"];
  const physical = (role: string) => PAD_BUTTONS.find((p) => (s.pad[p] ?? p) === role) ?? role;
  const isWaiting = (list: string, i: number) => waiting?.list === list && waiting.index === i;
  const bindingItem = (list: string, i: number, label: string, now: string, wait: string, start: () => void): TemplateItem => ({
    fields: { label, keys: isWaiting(list, i) ? wait : now, waiting: String(isWaiting(list, i)) },
    roles: {
      change: () => {
        const was = waiting;
        stopWaiting();
        // 待っている行をもう一度押したらやめる
        if (was?.list === list && was.index === i) return;
        start();
        relist();
      },
    },
  });
  const keyItems = (): TemplateItem[] =>
    UI_KEY_ACTIONS.map((action, i) =>
      bindingItem("keys", i, C.keyActions[action] ?? action, [...new Set(o.controls!.keys(action, s.keys).map(keyName))].join(" / ") || C.noKey, C.pressKey, () => {
        const take = (e: KeyboardEvent) => {
          // 待っている間に画面を閉じた
          if (!view.el.isConnected) return stopWaiting();
          if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          stopWaiting();
          set({ keys: { ...s.keys, [action]: [e.key] } });
        };
        window.addEventListener("keydown", take, true);
        waiting = { list: "keys", index: i, stop: () => window.removeEventListener("keydown", take, true) };
      }),
    );
  // 役目ごとに、それをするボタン（入れ替えは押したボタン → 役目。役目を替えたら、前にその役目だったボタンと入れ替える）
  const padItems = (): TemplateItem[] =>
    PAD_ROLES.map((role, i) =>
      bindingItem("buttons", i, C.padRoles[role] ?? role, padLabel(physical(role), s.padStyle), C.pressButton, () => {
        const controls = o.controls!;
        controls.capturePad((pressed) => {
          waiting = null;
          controls.capturePad(null);
          if (!view.el.isConnected) return;
          if (PAD_BUTTONS.includes(pressed)) {
            const before = physical(role);
            const pad = { ...s.pad };
            // 押したボタンのこれまでの役目を、この役目をしていたボタンへ渡す
            pad[before] = pad[pressed] ?? pressed;
            pad[pressed] = role;
            for (const [k, v] of Object.entries(pad)) if (k === v) delete pad[k];
            set({ pad });
          }
          relist();
        });
        waiting = { list: "buttons", index: i, stop: () => controls.capturePad(null) };
      }),
    );
  let listed = "";
  /** キーとパッドの行を作り直す（割り当てを替えたとき、待ち始めたとき、やめたとき）。 */
  const relist = () => {
    if (!o.controls) return;
    listed = JSON.stringify([s.keys, s.pad, s.padStyle]);
    view.list("keys", keyItems());
    view.list("buttons", padItems());
  };
  function stopWaiting(): void {
    if (!waiting) return;
    waiting.stop();
    waiting = null;
    relist();
  }

  // 話者ごとの声の音量は、ボイスを聞いた話者だけ（作品が決めれば、まだ聞いていない人物も。伏せるなら名前を出さない）
  const heard = new Set(s.voiceSpeakers);
  const speakers = [...new Set([...(o.speakers?.all ?? []), ...s.voiceSpeakers])];
  const speakerLabel = (who: string) => C.speakerVoice(o.speakers?.masked && !heard.has(who) ? C.unknownSpeaker : who);

  const view = templates.screen("config", {
    fields: { "filter-label": o.contentFilter?.label },
    show: { controls: !!o.controls },
    roles: {
      close,
      page: (e) => e?.dataset.page && showTab(e.dataset.page),
      reset: () => {
        // 作品独自の設定は、作品の初期値にあるものだけを戻す（設定の口の updateSettings が名前ごとに重ねるのと同じ）
        const back = resetSettings(s, o.defaults ?? DEFAULT_SETTINGS);
        set({ ...back, custom: { ...s.custom, ...back.custom } });
        refresh();
      },
      export: o.exportSaves ? () => o.exportSaves!() : null,
      import: o.importSaves ? () => o.importSaves!() : null,
      "reset-controls": () => {
        stopWaiting();
        set({ keys: {}, pad: {} });
      },
    },
    lists: {
      ...Object.fromEntries(Object.values(options).map((x) => [x.list, x.items])),
      speakers: speakers.map((who) => ({ fields: { label: speakerLabel(who) } })),
      ...(o.controls ? { keys: keyItems(), buttons: padItems() } : {}),
    },
  });
  const root = view.el;
  listed = JSON.stringify([s.keys, s.pad, s.padStyle]);

  /** つまみを付ける（output は値の文字を出す要素）。 */
  const bindSlider = (input: HTMLElement, spec: SliderSpec, outputs: readonly HTMLElement[]) => {
    const part = uiSlider(input, {
      ...spec.range,
      value: spec.get(),
      ...(spec.label && !input.hasAttribute("aria-label") ? { label: spec.label } : {}),
      onChange: (v) => {
        spec.put(v);
        for (const out of outputs) out.textContent = spec.show?.(spec.get()) ?? "";
      },
    });
    // 遊ぶ人が動かし終えたとき（指を離した・キーで動かした。開き直して値を合わせたときは除く）
    if (spec.commit) input.addEventListener("change", () => spec.commit!());
    const sync = () => {
      part.set(spec.get());
      for (const out of outputs) out.textContent = spec.show?.(spec.get()) ?? "";
    };
    syncs.push(sync);
    sync();
  };
  const bindChoice = (spec: ValueSpec, items: readonly { el: HTMLElement; value: Value }[]) => {
    for (const it of items) if (it.el instanceof HTMLButtonElement && !it.el.hasAttribute("type")) it.el.type = "button";
    const c = uiChoice(items, { value: spec.get(), onChange: (v) => spec.put(v) });
    syncs.push(() => c.set(spec.get()));
  };

  // 項目の行: 使えないものは外し、欄を設定と結ぶ
  for (const row of [...root.querySelectorAll<HTMLElement>("[data-setting]")]) {
    const key = row.dataset.setting!;
    if (unavailable.has(key)) {
      row.remove();
      continue;
    }
    const input = row.querySelector<HTMLElement>("input");
    const custom = key.startsWith("custom.") ? key.slice(7) : null;
    const slider =
      sliders[key] ??
      (custom !== null && input instanceof HTMLInputElement
        ? {
            range: { min: Number(input.getAttribute("min") ?? 0), max: Number(input.getAttribute("max") ?? 100), step: Number(input.getAttribute("step") ?? 1) },
            get: () => Number(s.custom[custom] ?? input.getAttribute("min") ?? 0),
            put: (v: number) => set({ custom: { ...s.custom, [custom]: v } }),
          }
        : undefined);
    if (slider && input) bindSlider(input, slider, [...root.querySelectorAll<HTMLElement>(`[data-field="${key}"]`)]);
    // 同じ行に、つまみと並べて選択や切り替えも書ける
    const spec = valueOf(key);
    if (!spec) {
      if (import.meta.hot) console.warn(`コンフィグのテンプレートの data-setting="${key}" は、設定の名前ではありません`);
      continue;
    }
    const picks = [...row.querySelectorAll<HTMLElement>("[data-value]")].map((e) => ({ el: e, value: spec.parse(e.dataset.value!) }));
    const opt = options[key];
    if (opt) view.items(opt.list).forEach((e, i) => picks.push({ el: e, value: opt.values[i]! }));
    if (picks.length > 0) bindChoice(spec, picks);
    const flip = row.querySelector<HTMLElement>("[data-toggle]");
    if (flip) {
      if (flip instanceof HTMLButtonElement && !flip.hasAttribute("type")) flip.type = "button";
      const t = uiToggle(flip, { value: spec.get() === true, onChange: (v) => spec.put(v) });
      syncs.push(() => t.set(spec.get() === true));
    }
  }
  // 話者ごとの声の音量
  view.items("speakers").forEach((row, i) => {
    const who = speakers[i]!;
    const input = row.querySelector<HTMLElement>("input");
    if (!input) return;
    bindSlider(input, { range: SETTING_RANGES.voice, get: () => s.speakerVoice[who] ?? 100, put: (v) => set({ speakerVoice: { ...s.speakerVoice, [who]: v } }), show: String, label: speakerLabel(who) }, [...row.querySelectorAll<HTMLElement>('[data-field="volume"]')]);
  });

  // タブ: 押したものの data-page を含む要素だけを出す
  const tabs = [...root.querySelectorAll<HTMLElement>("[data-role=page][data-page]")];
  const panes = [...root.querySelectorAll<HTMLElement>("[data-page]:not([data-role])")];
  function showTab(id: string): void {
    lastTab = id;
    for (const p of panes) p.hidden = !p.dataset.page!.split(/\s+/).includes(id);
    for (const t of tabs) {
      t.setAttribute("aria-pressed", String(t.dataset.page === id));
      t.toggleAttribute("data-lm-current", t.dataset.page === id);
    }
    stopWaiting();
  }
  const names = tabs.map((t) => t.dataset.page!);
  if (names.length > 0) showTab(names.includes(lastTab) ? lastTab : names[0]!);

  const sample = root.querySelector<HTMLElement>('[data-field="preview"]');
  function refresh(): void {
    syncing = true;
    try {
      for (const sync of syncs) sync();
    } finally {
      syncing = false;
    }
    if (JSON.stringify([s.keys, s.pad, s.padStyle]) !== listed) relist();
    // 見本の文字に書体を当てる（大きさは本文と同じ倍率の --text-scale。設定を変えるとすぐ舞台に載る）
    if (sample) sample.style.fontFamily = s.font && PLAYER_FONTS[s.font] ? PLAYER_FONTS[s.font]! : "";
  }

  // プレビュー: 文字を設定の速さで出し、オートの待ちのあと出し直す
  let timer: ReturnType<typeof setTimeout> | undefined;
  function restartPreview(): void {
    refresh();
    clearTimeout(timer);
    if (!sample || (!root.isConnected && sample.childElementCount > 0)) return;
    const chars = [...C.previewText];
    sample.replaceChildren(
      ...chars.map((ch, i) => {
        const span = el("span", "ch", ch);
        if (s.textSpeed === 0) span.classList.add("shown");
        else span.style.animationDelay = `${i * s.textSpeed}ms`;
        return span;
      }),
    );
    timer = setTimeout(
      () => {
        if (root.isConnected) restartPreview();
      },
      chars.length * s.textSpeed + autoDelay(s, chars.length),
    );
  }
  restartPreview();
  // 画面の外での変更（M キーのミュート、パッドのボタンなど）を、開いたままの画面に映す
  const unsubscribe = o.subscribe?.((next) => {
    s = { ...next };
    refresh();
  });
  return {
    el: root,
    dispose() {
      unsubscribe?.();
      clearTimeout(timer);
      waiting?.stop();
      waiting = null;
      view.dispose();
    },
  };
}
