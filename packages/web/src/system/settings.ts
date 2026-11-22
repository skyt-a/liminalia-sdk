import { UI_KEY_ACTIONS, type UiDefaults, type UiSettings } from "@liminalia/lang";
import { COLOR_VISIONS } from "./color-vision.ts";
import { PAD_STYLES } from "./pad-names.ts";
import type { Value } from "@liminalia/runtime";

/**
 * 設定画面の値。全セーブ共通で、システム変数と同じ場所（Storage の "config"）に保存する。
 */
export interface Settings {
  /** 一文字あたりのミリ秒。0 は一度に出す。 */
  textSpeed: number;
  /** オートでページを出し終えてから次へ送るまでのミリ秒（本文の長さに応じて足す分は別）。 */
  autoWait: number;
  /** 全体の音量 0〜100（BGM・効果音・ボイス・動画のすべてに掛ける）。 */
  master: number;
  /** ミュート（すべての音を消す。音量の設定はそのまま）。 */
  mute: boolean;
  /** BGM の音量 0〜100。 */
  bgm: number;
  /** 効果音の音量 0〜100。 */
  se: number;
  /** スキップで未読も飛ばすか（false なら既読のページだけ飛ばし、未読で止まる）。 */
  skipUnread: boolean;
  /** スキップの速さ（fast は一ページずつ見える速さ、fastest は最速）。 */
  skipSpeed: SkipSpeed;
  /** 既読の文に色を付けるか（"" は作品のまま。on で作品が ui.text.readColor を決めていなければ既定の色）。 */
  readColor: "" | "on" | "off";
  /** 本文の行間（作品の行間に対する %。LINE_SPACINGS のどれか）。 */
  lineSpacing: number;
  /** 本文の文字の縁（"" は作品のまま。none はなし、shadow は影、edge は縁取り）。 */
  textEdge: "" | TextEdge;
  /** 画面の揺れを弱めるか（揺らさない）。 */
  reduceShake: boolean;
  /** 光の点滅を弱めるか（点滅させずに薄い幕を一度かける）。 */
  reduceFlash: boolean;
  /** 選択肢を選んだあともオートを続けるか（false なら選択肢で止めたまま）。 */
  autoAfterChoice: boolean;
  /** 選択肢を選んだあともスキップを続けるか（「次の選択肢へ」「次の未読へ」で始めたスキップは続けない）。 */
  skipAfterChoice: boolean;
  /** 選択肢の制限時間（@choice timeout=）を使うか。false なら時間切れにせず、残り時間のバーも出さない。 */
  choiceTimer: boolean;
  /** 右クリックの動作（作品の設定画面から変える）。"" は ui.input.rightClick のまま。 */
  rightClick: "" | "menu" | "hide";
  /** ボイスの音量 0〜100。 */
  voice: number;
  /** 次のページへ進んだらボイスを止めるか。 */
  voiceStopOnPage: boolean;
  /** 話者ごとのボイスの音量 0〜100（無い話者は 100）。 */
  speakerVoice: Record<string, number>;
  /** ボイスを聞いた話者（聞いた順）。設定画面の話者ごとの音量には、ここにある話者だけを出す（まだ出ていない人物を見せない）。 */
  voiceSpeakers: string[];
  /** 遊ぶ言語（liminalia.json の languages のどれか）。空は決めていない（ブラウザの言語か原文）。 */
  language: string;
  /** 全画面で遊ぶか（デスクトップ版は次の起動でも全画面で始める）。 */
  fullscreen: boolean;
  /** デスクトップ版のウィンドウの大きさ（ゲームの大きさに対する倍率。0 ははじめの大きさ。画面に収まらなければ縮める）。 */
  windowScale: number;
  /** メッセージ枠の濃さ 0〜100（枠の色の不透明度に掛ける。文字は薄くしない）。 */
  windowOpacity: number;
  /** 文字の大きさ（作品の大きさに対する %。本文・選択肢・名前欄・バックログ・システム画面。ui.screen.textScale が message なら本文と選択肢だけ）。 */
  textScale: number;
  /** 本文の書体（"" は作品の書体、mincho・gothic・maru）。 */
  font: string;
  /**
   * 確認のダイアログを出すか。false なら、タイトルへ戻る・終了・ロード・上書き・ジャンプなどの確認を省く
   * （セーブの削除・読み込み・引き継ぎ・止まったときの記録を送る、は省かない）。
   */
  confirm: boolean;
  /** 遊ぶ人のキーの割り当て（操作 → キーの名前。作品の ui.keys と既定の上に重ねる）。 */
  keys: Record<string, string[]>;
  /** ゲームパッドのボタンの入れ替え（押したボタン → その役目のボタン。a・b・x・y・lb・rb・lt・rt・start・select・l3・r3）。 */
  pad: Record<string, string>;
  /** ゲームパッドのボタンの表記（"" はつないだゲームパッドから決める。xbox・playstation・nintendo。pad-names.ts）。 */
  padStyle: string;
  /** 効果音と BGM の字幕を出すか。 */
  captions: boolean;
  /** 色覚の補正（"" はしない。protan・deutan・tritan。color-vision.ts）。 */
  colorVision: string;
  /** ゲーム中、マウスを動かさずに 3 秒たったらカーソルを隠すか。 */
  hideCursor: boolean;
  /** ボイスを鳴らしている間、BGM を下げるか。 */
  duckBgm: boolean;
  /**
   * 最小化したとき（ブラウザはタブを裏へ回したとき）。pause は音、動画、オート、選択肢の制限時間を止める。mute は音だけ消して進める。
   * play はそのまま。"" は作品の設定（ui.screen.pauseInBackground が false なら play、ほかは pause）。
   */
  whenHidden: "" | InactiveAction;
  /** ほかのウィンドウを選んでいるとき（ゲームのウィンドウが前に出ていない）。動きは whenHidden と同じ。 */
  whenUnfocused: InactiveAction;
  /** 本文・選択肢・画面のボタンを端末の声で読み上げるか（ボイスのある台詞は読まない）。 */
  selfVoicing: boolean;
  /** 文字と枠をくっきりした色にするか（高コントラスト）。 */
  highContrast: boolean;
  /** 表現を控えめにするか（作品が ui.contentFilter を使うとき）。 */
  contentFilter: boolean;
  /** システムボイス（作品が ui.systemVoice を使うとき）。"" はすべての候補から選ぶ、"off" は鳴らさない、ほかは担当のキャラクター。 */
  systemVoice: string;
  /**
   * 作品独自の設定（名前 → JSON にできる値。ウィンドウの透過率・エフェクトを切るなど）。エンジンは読まず、同じ場所に保存するだけ。
   * 作品が既定値を持ち、ここに無ければ既定値を使う。
   */
  custom: Record<string, Value>;
}

/** スキップの速さ。 */
export type SkipSpeed = "fast" | "fastest";
export const SKIP_SPEEDS: readonly SkipSpeed[] = ["fast", "fastest"];
/** スキップの速さごとの、一ページを出しておく時間（ミリ秒）。 */
export const SKIP_PAGE_MS: Readonly<Record<SkipSpeed, number>> = { fast: 140, fastest: 16 };
/** 本文の文字の縁。 */
export type TextEdge = "none" | "shadow" | "edge";
export const TEXT_EDGES: readonly TextEdge[] = ["none", "shadow", "edge"];
/** 選べる行間（作品の行間に対する %）。 */
export const LINE_SPACINGS: readonly number[] = [100, 125, 150];

/** 遊ぶ人が決めた文字の縁の text-shadow（"" は作品のまま。決めたときは作品の縁取り text-stroke も外す）。 */
export function playerTextEdge(edge: Settings["textEdge"]): string {
  if (edge === "none") return "none";
  if (edge === "shadow") return "0 2px 4px rgba(0, 0, 0, 0.85)";
  if (edge === "edge") return ["1px 1px", "-1px 1px", "1px -1px", "-1px -1px", "0 1px", "0 -1px", "1px 0", "-1px 0"].map((o) => `${o} 0 #000`).join(", ");
  return "";
}

/** 最小化したときと、ほかのウィンドウを選んでいるときの動き（一時停止、ミュート、そのまま）。 */
export type InactiveAction = "pause" | "mute" | "play";
export const INACTIVE_ACTIONS: readonly InactiveAction[] = ["pause", "mute", "play"];

/** updateSettings に渡す変更。custom は名前ごとに重ね、undefined の名前は消す。 */
export type SettingsPatch = Partial<Omit<Settings, "custom">> & { custom?: Record<string, Value | undefined> };

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  textSpeed: 30,
  autoWait: 1500,
  master: 100,
  mute: false,
  bgm: 80,
  se: 80,
  skipUnread: false,
  skipSpeed: "fastest",
  readColor: "",
  lineSpacing: 100,
  textEdge: "",
  reduceShake: false,
  reduceFlash: false,
  autoAfterChoice: false,
  skipAfterChoice: false,
  choiceTimer: true,
  rightClick: "",
  voice: 80,
  voiceStopOnPage: true,
  speakerVoice: {},
  voiceSpeakers: [],
  language: "",
  fullscreen: false,
  windowScale: 0,
  windowOpacity: 100,
  textScale: 100,
  font: "",
  duckBgm: true,
  whenHidden: "",
  whenUnfocused: "play",
  confirm: true,
  hideCursor: false,
  colorVision: "",
  captions: false,
  keys: {},
  pad: {},
  padStyle: "",
  selfVoicing: false,
  // OS でコントラストを上げていれば、はじめから高コントラスト
  highContrast: typeof matchMedia === "function" && matchMedia("(prefers-contrast: more)").matches,
  contentFilter: false,
  systemVoice: "",
  custom: {},
};

/** 遊ぶ人が選べる本文の書体（設定画面の「書体」）。 */
export const PLAYER_FONTS: Record<string, string> = {
  mincho: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", serif',
  gothic: '"Hiragino Sans", "Yu Gothic", "YuGothic", "Noto Sans JP", sans-serif',
  maru: '"Hiragino Maru Gothic ProN", "Zen Maru Gothic", "M PLUS Rounded 1c", sans-serif',
  // 読みやすさのために作られた UD 書体（無ければゴシック）
  ud: '"BIZ UDPGothic", "BIZ UDGothic", "UD Digi Kyokasho NK-R", "UDデジタル教科書体 NK-R", "Hiragino Sans", "Noto Sans JP", sans-serif',
};
/** 入れ替えられるゲームパッドのボタン（十字キーは入れ替えない）。 */
export const PAD_BUTTONS: readonly string[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "start", "select", "l3", "r3"];

/** 選べるウィンドウの大きさ（ゲームの大きさに対する倍率。0 ははじめの大きさ）。 */
export const WINDOW_SCALES: readonly number[] = [0, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** ボイスの間に BGM を下げるときの倍率。 */
export const DUCK_LEVEL = 0.4;

type Range = { min: number; max: number; step: number };
type RangedKey = "textSpeed" | "autoWait" | "master" | "bgm" | "se" | "voice" | "windowOpacity" | "textScale";
const BASE_RANGES: Readonly<Record<RangedKey, Readonly<Range>>> = {
  textSpeed: { min: 0, max: 80, step: 5 },
  autoWait: { min: 500, max: 5000, step: 100 },
  master: { min: 0, max: 100, step: 5 },
  bgm: { min: 0, max: 100, step: 5 },
  se: { min: 0, max: 100, step: 5 },
  voice: { min: 0, max: 100, step: 5 },
  windowOpacity: { min: 0, max: 100, step: 5 },
  textScale: { min: 80, max: 200, step: 10 },
};

/** 数値の設定の幅（設定画面のつまみもこの幅で動く）。文字の速さとオートの待ちは作品が liminalia.json の ui.settings で替えられる。 */
export const SETTING_RANGES: Record<RangedKey, Range> = structuredClone(BASE_RANGES) as Record<RangedKey, Range>;

/** オートで本文一文字ごとに足す待ち（ミリ秒）の既定。長いページほど長く待つ。 */
export const AUTO_PER_CHAR = 25;
let autoPerChar = AUTO_PER_CHAR;

/**
 * 作品の設定の幅（liminalia.json の ui.settings）を当てる。書いていない幅は既定に戻す。
 * 文字の速さ（一文字のミリ秒）とオートの待ち（ミリ秒）の幅・刻みと、オートで一文字ごとに足す待ち。
 */
export function configureSettings(s: UiSettings | undefined): void {
  Object.assign(SETTING_RANGES, structuredClone(BASE_RANGES));
  const pick = (key: "textSpeed" | "autoWait") => {
    const base = BASE_RANGES[key];
    const min = s?.[`${key}Min`] ?? base.min;
    const max = Math.max(min, s?.[`${key}Max`] ?? base.max);
    SETTING_RANGES[key] = { min, max, step: s?.[`${key}Step`] ?? base.step };
  };
  pick("textSpeed");
  pick("autoWait");
  autoPerChar = s?.autoPerChar ?? AUTO_PER_CHAR;
}

/** オートの待ち時間。chars は出し終えたページの文字数。 */
export function autoDelay(settings: Settings, chars: number): number {
  return settings.autoWait + Math.max(0, chars) * autoPerChar;
}

/** 作品の初期の設定（liminalia.json の ui.defaults）を既定値に重ねる（幅の外は幅に収める）。 */
export function settingsDefaults(defaults: UiDefaults | undefined): Settings {
  return defaults ? normalizeSettings(defaults) : { ...DEFAULT_SETTINGS };
}

/**
 * 保存されていた値（古い・壊れた値を含む）を、今の形の設定にする。足りない項目は base（既定は DEFAULT_SETTINGS）で埋め、幅の外は幅に収める。
 */
export function normalizeSettings(raw: unknown, base: Readonly<Settings> = DEFAULT_SETTINGS): Settings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Settings = { ...base, speakerVoice: { ...base.speakerVoice }, voiceSpeakers: [...base.voiceSpeakers], keys: structuredClone(base.keys ?? {}), pad: { ...(base.pad ?? {}) }, custom: structuredClone(base.custom ?? {}) };
  for (const key of Object.keys(SETTING_RANGES) as (keyof typeof SETTING_RANGES)[]) {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const { min, max } = SETTING_RANGES[key];
    out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (typeof o.skipUnread === "boolean") out.skipUnread = o.skipUnread;
  if ((SKIP_SPEEDS as readonly unknown[]).includes(o.skipSpeed)) out.skipSpeed = o.skipSpeed as SkipSpeed;
  if (o.readColor === "" || o.readColor === "on" || o.readColor === "off") out.readColor = o.readColor;
  if (typeof o.lineSpacing === "number" && LINE_SPACINGS.includes(o.lineSpacing)) out.lineSpacing = o.lineSpacing;
  if (o.textEdge === "" || (TEXT_EDGES as readonly unknown[]).includes(o.textEdge)) out.textEdge = o.textEdge as Settings["textEdge"];
  if (typeof o.reduceShake === "boolean") out.reduceShake = o.reduceShake;
  if (typeof o.reduceFlash === "boolean") out.reduceFlash = o.reduceFlash;
  if (typeof o.autoAfterChoice === "boolean") out.autoAfterChoice = o.autoAfterChoice;
  if (typeof o.skipAfterChoice === "boolean") out.skipAfterChoice = o.skipAfterChoice;
  if (typeof o.choiceTimer === "boolean") out.choiceTimer = o.choiceTimer;
  if (typeof o.mute === "boolean") out.mute = o.mute;
  if (o.rightClick === "" || o.rightClick === "menu" || o.rightClick === "hide") out.rightClick = o.rightClick;
  if (typeof o.voiceStopOnPage === "boolean") out.voiceStopOnPage = o.voiceStopOnPage;
  if (typeof o.fullscreen === "boolean") out.fullscreen = o.fullscreen;
  if (typeof o.windowScale === "number" && WINDOW_SCALES.includes(o.windowScale)) out.windowScale = o.windowScale;
  if (typeof o.duckBgm === "boolean") out.duckBgm = o.duckBgm;
  if (o.whenHidden === "" || (INACTIVE_ACTIONS as readonly unknown[]).includes(o.whenHidden)) out.whenHidden = o.whenHidden as Settings["whenHidden"];
  if ((INACTIVE_ACTIONS as readonly unknown[]).includes(o.whenUnfocused)) out.whenUnfocused = o.whenUnfocused as InactiveAction;
  if (typeof o.confirm === "boolean") out.confirm = o.confirm;
  if (typeof o.hideCursor === "boolean") out.hideCursor = o.hideCursor;
  if (typeof o.captions === "boolean") out.captions = o.captions;
  if (o.keys && typeof o.keys === "object" && !Array.isArray(o.keys)) {
    for (const [action, list] of Object.entries(o.keys as Record<string, unknown>)) {
      if ((UI_KEY_ACTIONS as readonly string[]).includes(action) && Array.isArray(list)) out.keys[action] = list.filter((k): k is string => typeof k === "string" && k !== "");
    }
  }
  if (o.pad && typeof o.pad === "object" && !Array.isArray(o.pad)) {
    for (const [from, to] of Object.entries(o.pad as Record<string, unknown>)) if (PAD_BUTTONS.includes(from) && typeof to === "string" && PAD_BUTTONS.includes(to)) out.pad[from] = to;
  }
  if (o.padStyle === "" || (typeof o.padStyle === "string" && (PAD_STYLES as readonly string[]).includes(o.padStyle))) out.padStyle = o.padStyle as string;
  if (typeof o.colorVision === "string" && (o.colorVision === "" || (COLOR_VISIONS as readonly string[]).includes(o.colorVision))) out.colorVision = o.colorVision;
  if (typeof o.selfVoicing === "boolean") out.selfVoicing = o.selfVoicing;
  if (typeof o.highContrast === "boolean") out.highContrast = o.highContrast;
  if (typeof o.contentFilter === "boolean") out.contentFilter = o.contentFilter;
  if (typeof o.font === "string" && (o.font === "" || o.font in PLAYER_FONTS)) out.font = o.font;
  if (typeof o.systemVoice === "string") out.systemVoice = o.systemVoice;
  if (o.speakerVoice && typeof o.speakerVoice === "object") {
    for (const [who, v] of Object.entries(o.speakerVoice as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out.speakerVoice[who] = Math.min(100, Math.max(0, Math.round(v)));
  }
  if (typeof o.language === "string") out.language = o.language;
  out.voiceSpeakers = Array.isArray(o.voiceSpeakers) ? [...new Set(o.voiceSpeakers.filter((x): x is string => typeof x === "string"))] : [];
  if (o.custom && typeof o.custom === "object" && !Array.isArray(o.custom)) {
    for (const [k, v] of Object.entries(o.custom as Record<string, unknown>)) if (isJson(v)) out.custom[k] = structuredClone(v);
  }
  return out;
}

/** 今の設定に変更を重ねる（幅の外は幅に収める。custom は名前ごとに重ね、undefined の名前は消す）。 */
export function mergeSettings(now: Readonly<Settings>, patch: SettingsPatch): Settings {
  const { custom, ...rest } = patch;
  const merged: Record<string, unknown> = { ...now, ...rest, custom: { ...now.custom } };
  for (const [k, v] of Object.entries(custom ?? {})) {
    if (v === undefined) delete (merged.custom as Record<string, Value>)[k];
    else (merged.custom as Record<string, Value>)[k] = v;
  }
  return normalizeSettings(merged, { ...now, custom: {} });
}

function isJson(v: unknown): v is Value {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isJson);
  return false;
}
