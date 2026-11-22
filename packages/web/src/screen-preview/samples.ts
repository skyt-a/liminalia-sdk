import type { ExtraConfig, Flow, ItemsConfig, UiConfig } from "@liminalia/lang";
import { createState, toSaveData, type SaveData, type Value } from "@liminalia/runtime";
import type { LogEntry } from "../system/backlog.ts";
import type { ScreenInfo } from "@liminalia/studio/protocol";
import { SCREEN_CATALOG, SYSTEM_SCREEN_VARS, type Bilingual } from "../system/screen-catalog.ts";
import type { SlotRecord } from "../system/storage.ts";

/**
 * 制作画面の「ゲームの画面」の見本に入れる作り物の中身（セーブ、バックログ、おまけ、図鑑、持ち物、フローチャートなど）と、
 * 標準の画面（system/screen-catalog.ts の一覧）ごとの開き方。作り物はここにだけ置く。
 * 作品の名前、人物、シナリオの例は持ち込まず、中立の名前（案内人、旅人、灯台など）で作る。
 * 画面に関わるものを読まないので、Node からも読める（開発サーバーが制作画面へ一覧を渡す。test/screen-preview.test.ts が一覧と突き合わせる）。
 *
 * 開き方（プレイヤーの URL。開発サーバーのときだけ。書き出したゲームには入らない）:
 *   /?ui-preview=screen&screen=<画面の id>
 *     &state=empty|long        中身（省くと入った状態。empty は空、long は長い本文と長い名前。SCREEN_SAMPLES の states にあるものだけ）
 *     &orientation=portrait|landscape  画面の向き（省くと作品のまま。portrait なら縦長の並べ方 system/portrait.css）
 *     &lang=<言語>              遊ぶ言語（en なら標準の画面の文言を英語に。作品の languages に無くても見本の中だけ足す）
 *     &theme=<テーマの id>      当てるテーマ（ui.system.preset の名前。省くと作品のまま。作品の liminalia.json は書き換えない）
 *     &bg=<bgimage のパス>      見本の背景（省くと作り物の絵）
 *     &sample-lang=en           作り物の中身の言語（省くと遊ぶ言語。標準の画面の文言と同じ言語になる）
 *     &still=1                  開く演出を待たずに終わりの姿で出す（撮影の道具向け）
 * 開き終えたら html の data-lm-screen-preview が "ready"（開けなければ "failed"）になり、window.__liminaliaScreenPreview に様子が入り、
 * 親の画面（制作画面）へ liminalia:screen-preview を送る（@liminalia/studio の protocol.ts の ScreenPreviewReport）。
 */

/** 中身の状態（filled は入った状態）。 */
export type SampleState = "filled" | "empty" | "long";
/** 作り物の中身の言語。 */
export type SampleLanguage = "ja" | "en";

export interface SampleContext {
  lang: SampleLanguage;
  state: SampleState;
  /** 見本の背景（bgimage からのパス）。 */
  bg: string;
}

/** 見本のシナリオのファイルの名前（作品のシナリオと重ならない名前。main.ts の PREVIEW_FILE と同じ）。 */
export const SAMPLE_FILE = "__ui_preview__";
/** 作り物の絵の素材のパス（どの種類の素材でも、このパスなら作り物の絵の data URL を返す）。 */
export const SAMPLE_ASSET = "__sample__/";

/**
 * 開き方。
 * - page: 見本のページを出したまま（クリック待ち）
 * - open: 見本のページを出してから、標準の画面を名前で開く（@open-screen と同じ）
 * - script: 見本のシナリオの続き（screen の行）を流し、出たものを見せる（選択肢、結末、標準の命令の画面）
 * - backlog: 作り物のバックログを入れたセーブを読み込んでから開く
 * - confirm: 見本のページで「タイトルへ戻る」を押したときの確認を出す
 * - toast: 見本のページの上に短い知らせを出したままにする
 * - term: 用語の入った見本のページで、用語を押して説明を出す
 * - title: タイトル画面、warning: 注意書き、splash: 起動の演出
 */
export type ScreenHow = "page" | "open" | "script" | "backlog" | "confirm" | "toast" | "term" | "title" | "warning" | "splash";

export interface ScreenSample {
  /** 開き方（開けない画面は書かず、why に理由を書く）。 */
  how?: ScreenHow;
  /** 開く画面の名前（how が open のとき。default.ts の openScreenByName の名前）。 */
  screen?: string;
  /** 用意した状態（入った状態はどの画面にもある）。 */
  states?: readonly Exclude<SampleState, "filled">[];
  /** 開いたら出る要素（CSS のセレクタ。省くと一覧の CSS の部品の一つ目。プラグインが差し替えた画面では見ない）。 */
  shows?: string;
  /** 開けない理由（一覧に出す）。 */
  why?: Bilingual;
}

/** 画面ごとの開き方（system/screen-catalog.ts の id → 開き方）。一覧に画面を足したら、ここにも書く（テストが落ちる）。 */
export const SCREEN_SAMPLES: Readonly<Record<string, ScreenSample>> = {
  gate: { why: { ja: "作品の設定を読む前に出す黒い面で、見た目は変わりません", en: "A black layer shown before the game's settings are read; its look doesn't change" } },
  splash: { how: "splash" },
  warning: { how: "warning", states: ["long"] },
  title: { how: "title", states: ["empty", "long"] },
  message: { how: "page", states: ["long"] },
  name: { how: "page", states: ["long"] },
  glyph: { how: "page" },
  choice: { how: "script", states: ["long"], shows: ".choices button, .lm-choices-custom" },
  menuBar: { how: "page" },
  indicator: { how: "script", shows: ".lm-indicator:not([hidden])" },
  menu: { how: "open", screen: "menu" },
  saveload: { how: "open", screen: "load", states: ["empty", "long"] },
  config: { how: "open", screen: "config" },
  backlog: { how: "backlog", states: ["empty", "long"] },
  confirm: { how: "confirm" },
  ending: { how: "script", states: ["long"] },
  extra: { how: "open", screen: "extra", states: ["empty", "long"] },
  flowchart: { how: "open", screen: "flowchart", states: ["empty", "long"] },
  help: { how: "open", screen: "help" },
  items: { how: "open", screen: "items", states: ["empty", "long"] },
  dialog: { how: "script", states: ["long"] },
  notice: { how: "script", states: ["long"] },
  toast: { how: "toast" },
  term: { how: "term", states: ["long"] },
  captions: { how: "script", states: ["long"] },
  rotate: { why: { ja: "スマホを縦に持ったときだけ出る案内です", en: "Only shown when a phone is held upright" } },
  feedback: { why: { ja: "lim build --feedback で書き出したテスト版だけに出ます", en: "Only in playtest builds made with lim build --feedback" } },
  codex: { how: "script", states: ["empty", "long"] },
  investigate: { how: "script", states: ["long"] },
  "map-choice": { how: "script", states: ["long"] },
  chapter: { how: "script", states: ["long"] },
  cutin: { how: "script" },
  hud: { how: "script", states: ["long"] },
  chat: { how: "script", states: ["empty", "long"] },
};

// ---- 文 ----

const T = (c: SampleContext, ja: string, en: string) => (c.lang === "en" ? en : ja);
const long = (c: SampleContext) => c.state === "long";
/** 台本の文字のパラメータ（"…"）。 */
const q = (s: string) => JSON.stringify(s);

/** 見本の話者（表示名。作品の cast.json には無いので、見本の中だけ話者に足す）。 */
export function sampleSpeakers(c: SampleContext): { guide: string; traveler: string } {
  return long(c) ? { guide: T(c, "とても長い肩書きを持っている案内人", "The guide with a remarkably long title"), traveler: T(c, "遠い町から来た旅人", "A traveler from a faraway town") } : { guide: T(c, "案内人", "Guide"), traveler: T(c, "旅人", "Traveler") };
}

function pageText(c: SampleContext): string {
  if (long(c))
    return T(
      c,
      "これは見本の長い台詞です。文字の大きさや色、行の間、メッセージウィンドウの形と、文が長くなったときの折り返しを、ここで確かめられます。三行、四行と続いても、ウィンドウの中に収まっているか、名前欄と重なっていないかを見てください。",
      "This is a long sample line. Check the text size and color, the line spacing, the shape of the message window and how long text wraps. Even when it runs to three or four lines, make sure it stays inside the window and clear of the name box.",
    );
  return T(c, "これは見本の台詞です。文字の大きさや色、メッセージウィンドウの形をここで確かめられます。", "This is a sample line. Check the text size and color and the shape of the message window here.");
}

// ---- 作り物の絵 ----

/** 名前から決まる数（同じ名前なら同じ絵）。 */
function seed(name: string): number {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * 作り物の絵（SVG の data URL）。空の色、丸、丘の重なり。色は名前で決める（同じ名前なら同じ絵）。
 * 名前に "portrait" を含めば縦長、"square" を含めば正方形。
 */
export function sampleImage(name: string): string {
  const s = seed(name);
  const hue = s % 360;
  const hue2 = (hue + 40 + ((s >> 9) % 80)) % 360;
  const [w, h] = name.includes("portrait") ? [900, 1600] : name.includes("square") ? [800, 800] : [1600, 900];
  const sun = { x: Math.round(w * (0.55 + ((s >> 3) % 30) / 100)), y: Math.round(h * (0.22 + ((s >> 5) % 15) / 100)), r: Math.round(Math.min(w, h) * 0.09) };
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 42% 30%)"/><stop offset="1" stop-color="hsl(${hue2} 48% 70%)"/></linearGradient></defs>`,
    `<rect width="${w}" height="${h}" fill="url(#g)"/>`,
    `<circle cx="${sun.x}" cy="${sun.y}" r="${sun.r}" fill="hsl(${(hue + 180) % 360} 70% 90%)" opacity="0.85"/>`,
    `<path d="M0 ${h * 0.7} C ${w * 0.2} ${h * 0.6} ${w * 0.35} ${h * 0.78} ${w * 0.55} ${h * 0.68} S ${w * 0.85} ${h * 0.62} ${w} ${h * 0.7} V${h} H0Z" fill="hsl(${hue} 30% 22%)" opacity="0.9"/>`,
    `<path d="M0 ${h * 0.82} C ${w * 0.25} ${h * 0.76} ${w * 0.45} ${h * 0.9} ${w * 0.65} ${h * 0.82} S ${w * 0.9} ${h * 0.78} ${w} ${h * 0.84} V${h} H0Z" fill="hsl(${hue} 35% 13%)"/>`,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 作り物の絵の素材のパス（sampleImage の名前）。 */
const img = (name: string) => `${SAMPLE_ASSET}${name}`;

// ---- 見本のシナリオ ----

/** 見本のシナリオの頭（背景とメッセージウィンドウを、待たずに出す）。 */
function setup(c: SampleContext): string[] {
  return ["@text-speed 0ms", `@bg ${q(c.bg)} time=0ms`, "@window show"];
}

/** 台詞の行（日本語は 名前「…」、英語は 名前 "…"）。 */
const say = (c: SampleContext, name: string, text: string) => (c.lang === "en" ? `${name} "${text}"` : `${name}「${text}」`);

/** 見本のページ（話者の台詞）。 */
function page(c: SampleContext): string {
  return say(c, sampleSpeakers(c).guide, pageText(c));
}

/**
 * 見本のシナリオ（SAMPLE_FILE の中身）。開き方が script の画面はその画面の行、ほかは見本のページ。選択肢などの行き先は # end。
 * 頭から流す（見本のセーブは頭から始める）。
 */
export function sampleScript(id: string, c: SampleContext): string {
  const body = SCREEN_SAMPLES[id]?.how === "script" ? screenLines(id, c) : [...(id === "backlog" ? ["@backlog off"] : []), ...(id === "items" ? sampleItemLines(c) : []), id === "term" ? termPage(c) : page(c)];
  // チャットの画面はメッセージウィンドウを使わない（吹き出しだけを出す）
  const head = id === "chat" ? setup(c).map((l) => (l === "@window show" ? "@window hide" : l)) : setup(c);
  return [...head, ...body, "@stop", "# end", "@stop"].join("\n");
}

/** 用語の入った見本のページ（用語を押すと説明を出す）。 */
function termPage(c: SampleContext): string {
  const g = sampleGlossary(c)[0]!;
  return say(c, sampleSpeakers(c).guide, T(c, `${g.term}に会ったら、道を尋ねてください。`, `If you meet the ${g.term}, ask them the way.`));
}

/** 画面ごとの行（開き方が script の画面）。クリックを待たずにその画面まで進む。 */
function screenLines(id: string, c: SampleContext): string[] {
  const { guide, traveler } = sampleSpeakers(c);
  switch (id) {
    case "choice": {
      const options = long(c)
        ? [T(c, "灯台の上まで階段を上り、遠くの海を見渡してから、町へ戻る道を探す", "Climb the lighthouse stairs, look out over the far sea, then look for the road back to town"), T(c, "港の市場で、案内人に聞いた古い地図を売っている店を探す", "Find the shop in the harbor market that sells the old map the guide mentioned"), T(c, "今日はここで休む", "Rest here today")]
        : [T(c, "灯台へ行く", "Go to the lighthouse"), T(c, "港の市場を見る", "Look around the harbor market"), T(c, "今日は休む", "Rest today")];
      return ["@choice", ...options.map((o) => `  - ${o} -> #end`), "@end"];
    }
    case "indicator":
      return ["@auto start", page(c), say(c, guide, T(c, "オートで進んでいます。", "Auto mode is on.")), "@wait 3600s"];
    case "ending":
      return [`@title-screen ending=good title=${q(long(c) ? T(c, "長い旅の終わりに灯台の明かりを見上げた日", "The day we looked up at the lighthouse at the end of a long journey") : T(c, "灯台の明かり", "The lighthouse light"))}`];
    case "dialog":
      return [`@dialog ${q(long(c) ? T(c, "これは見本の確認です。長い文のときに、ダイアログの中で折り返して、ボタンと重ならないかを確かめてください。先へ進みますか？", "This is a sample confirmation. Check that long text wraps inside the dialog and stays clear of the buttons. Do you want to go on?") : T(c, "これは見本の確認です。先へ進みますか？", "This is a sample confirmation. Go on?"))} type=confirm`];
    case "notice":
      return [
        `@notify ${q(T(c, "港の市場が開きました", "The harbor market is open"))} title=${q(T(c, "お知らせ", "Notice"))} time=3600s max=4`,
        `@notify ${q(long(c) ? T(c, "灯台の記録に新しいページが加わりました。図鑑から読み返せます", "A new page was added to the lighthouse log. You can read it again in the codex") : T(c, "記録が増えました", "A new entry was added"))} kind=success time=3600s max=4`,
        `@notify ${q(T(c, "道が分かれています", "The road splits here"))} kind=warning time=3600s max=4`,
        page(c),
      ];
    case "captions":
      // 字幕は少しのあいだで消えるので、出し続ける（効果音の素材は無くてよい。字幕だけを出す）
      return ["# captions", `@se ${q(img("se"))} caption=${q(long(c) ? T(c, "［遠くで汽笛が長く鳴り、波の音が重なる］", "[A ship's horn sounds long in the distance over the waves]") : T(c, "［汽笛が鳴る］", "[A ship's horn sounds]"))}`, "@wait 2000ms", "@jump #captions"];
    case "codex":
      return [...(c.state === "empty" ? [] : sampleCodex(c).entries.map((e) => `@codex-unlock ${e.id} notify=false`)), "@codex"];
    case "investigate":
      return ["@investigate sample opening=false"];
    case "map-choice":
      return ["@map-choice sample result=temp.where"];
    case "chapter":
      return [
        `@chapter-card number=${q(T(c, "第一章", "Chapter 1"))} title=${q(long(c) ? T(c, "灯台へ続く長い坂道と、港に残された古い地図", "The long slope to the lighthouse and the old map left at the harbor") : T(c, "灯台へ", "To the lighthouse"))} subtitle=${q(T(c, "見本の章", "A sample chapter"))} time=3600s fade=0ms`,
      ];
    case "cutin":
      return [`@cutin ${q(img("cutin-square"))} width=360 height=360 stay=true in=0ms`, page(c)];
    case "hud":
      return [
        `@hud-button sample call=#end label=${q(T(c, "地図", "Map"))} x=40 y=40`,
        `@hud-text day text=${q(long(c) ? T(c, "三日目の夕方、港の近く", "Day 3, evening, near the harbor") : T(c, "三日目", "Day 3"))} x=40 y=110`,
        page(c),
      ];
    case "chat": {
      const lines = c.state === "empty" ? [] : [
        `@chat ${q(traveler)} text=${q(T(c, "いまどこ？", "Where are you?"))} wait=false`,
        `@chat ${q(guide)} text=${q(long(c) ? T(c, "灯台の下にいます。坂を上ってくると、右手に古い門が見えるので、そこをくぐってください。", "I'm below the lighthouse. As you come up the slope you'll see an old gate on your right; go through it.") : T(c, "灯台の下です", "Below the lighthouse"))} wait=false`,
        `@chat ${q(traveler)} text=${q(T(c, "すぐ行きます", "On my way"))} wait=false`,
      ];
      return [`@chat-open ${q(T(c, "案内人", "Guide"))} me=${q(traveler)}`, ...lines, `@chat ${q(guide)} text=${q(T(c, "待っています", "I'll wait"))}`];
    }
  }
  return [page(c)];
}

// ---- セーブとバックログ ----

/** 見本のシナリオの頭から始めるセーブ（読み込むと見本のページを出す）。 */
export function sampleSave(): SaveData {
  return toSaveData(createState(SAMPLE_FILE));
}

const DATES = ["2026-04-12T21:34:00", "2026-04-11T08:05:00", "2026-04-09T23:51:00", "2026-04-03T14:20:00", "2026-03-28T19:02:00", "2026-03-15T10:47:00"];

/** 作り物のセーブスロット（番号 → 中身。クイックセーブとオートセーブも）。空なら無し。 */
export function sampleSlots(c: SampleContext): [slot: number | "quick" | "auto:0", record: SlotRecord][] {
  if (c.state === "empty") return [];
  const save = sampleSave();
  const chapter = (n: number) => (long(c) ? T(c, `第${n}章　灯台へ続く長い坂道と、港に残された古い地図`, `Chapter ${n}: The long slope to the lighthouse and the old map left at the harbor`) : T(c, `第${n}章　灯台へ`, `Chapter ${n}: To the lighthouse`));
  const titles = long(c)
    ? [pageText(c), T(c, "港の市場で、古い地図を売っている店を探して、細い路地を何度も曲がった。", "In the harbor market I turned down narrow alley after alley, looking for the shop that sells the old map.")]
    : [T(c, "灯台の明かりが、海の向こうで揺れていた。", "The lighthouse light flickered across the sea."), T(c, "港の市場は、朝からにぎやかだった。", "The harbor market was busy from early morning."), T(c, "地図の端に、知らない町の名前があった。", "At the edge of the map was the name of a town I didn't know.")];
  const record = (i: number, extra: Partial<SlotRecord> = {}): SlotRecord => ({
    version: 1,
    save,
    date: DATES[i % DATES.length]!,
    title: titles[i % titles.length]!,
    thumb: sampleImage(`slot-${i}`),
    chapter: chapter(1 + (i % 3)),
    playTime: (3 + i * 47) * 60_000 + i * 13_000,
    ...extra,
  });
  return [
    [0, record(0, { memo: long(c) ? T(c, "灯台の前の分かれ道。左を選んだあとで、右の道も確かめに戻るためのセーブ。", "The fork before the lighthouse. Saved to come back and try the right path after taking the left.") : T(c, "分かれ道の前", "Before the fork") })],
    [1, record(1, { locked: true })],
    [2, record(2)],
    [3, record(3, { memo: T(c, "見本のメモ", "A sample memo") })],
    [5, record(4)],
    ["quick", record(5)],
    ["auto:0", record(1)],
  ];
}

/** 作り物のバックログ（ボイスあり、二人が同時に話す、選んだ選択肢、ルビ）。空なら無し。 */
export function sampleLog(c: SampleContext): LogEntry[] {
  if (c.state === "empty") return [];
  const { guide, traveler } = sampleSpeakers(c);
  const at = (line: number) => ({ file: SAMPLE_FILE, line });
  const voice = (file: string, who: string) => ({ file: `${SAMPLE_ASSET}${file}.ogg`, volume: 1, folder: "voice", who });
  const text = (s: string) => [{ text: s }];
  const longer = (s: string, more: string) => (long(c) ? `${s}${more}` : s);
  return [
    { speaker: null, at: at(1), parts: text(longer(T(c, "坂道を上ると、海の向こうに灯台が見えた。", "At the top of the slope, a lighthouse came into view across the sea."), T(c, "風は冷たく、港の方からは市場のにぎわいがかすかに届いていた。どこかで汽笛が鳴り、鳥が一斉に飛び立った。", " The wind was cold, and the bustle of the market drifted up faintly from the harbor. Somewhere a ship's horn sounded and the birds took off all at once."))) },
    { speaker: guide, at: at(2), parts: text(longer(T(c, "「ようこそ。ここから先は、私が案内します」", "\"Welcome. I'll show you the way from here.\""), T(c, "「足元が悪いので、手すりにつかまりながら、ゆっくり上ってきてください」", " \"The footing is poor, so hold the rail and come up slowly.\""))), voice: voice("guide-1", guide) },
    { speaker: traveler, at: at(3), parts: text(T(c, "「よろしくお願いします」", "\"Thank you.\"")), voice: voice("traveler-1", traveler) },
    { speaker: guide, at: at(4), parts: text(T(c, "「では、行きましょう」", "\"Then let's go.\"")), voice: { ...voice("guide-2", guide), also: [voice("traveler-2", traveler)] }, with: [{ speaker: traveler }] },
    { speaker: null, at: at(5), parts: text(T(c, "灯台へ行く", "Go to the lighthouse")), choice: true },
    { speaker: null, at: at(6), parts: c.lang === "en" ? text("The old keeper's hut still had its light on.") : [{ text: "古い" }, { text: "灯台守", ruby: "とうだいもり" }, { text: "の小屋には、まだ明かりがついていた。" }] },
    { speaker: traveler, at: at(7), parts: text(longer(T(c, "「誰か住んでいるんですか」", "\"Does someone live there?\""), T(c, "「こんなに風の強い場所で、ひとりで暮らすのは大変そうですね」", " \"Living alone somewhere this windy must be hard.\""))) },
  ];
}

// ---- おまけ、用語集、持ち物、図鑑、フローチャート ----

/** 作り物の用語集（用語の説明とおまけの用語集）。 */
export function sampleGlossary(c: SampleContext): NonNullable<ExtraConfig["glossary"]> {
  /** 読みは日本語のときだけ（一覧の並びと見出しのルビ）。 */
  const reading = (r: string) => (c.lang === "en" ? {} : { reading: r });
  return [
    { id: "keeper", term: T(c, "灯台守", "lighthouse keeper"), ...reading("とうだいもり"), group: T(c, "人", "People"), description: long(c) ? T(c, "灯台の明かりを守る人。夜ごとに火を確かめ、霧の日には鐘を鳴らして船に岬の場所を知らせる。町の人からは、昔の話をよく知る人として頼られている。", "The person who tends the lighthouse light. They check the flame every night and ring the bell on foggy days to tell ships where the cape is. The townsfolk rely on them as someone who knows the old stories.") : T(c, "灯台の明かりを守る人。", "The person who tends the lighthouse light.") },
    { id: "market", term: T(c, "港の市場", "harbor market"), ...reading("みなとのいちば"), group: T(c, "場所", "Places"), description: T(c, "朝から開く、港の前の市場。", "The market in front of the harbor that opens in the morning.") },
    { id: "map", term: T(c, "古い地図", "old map"), ...reading("ふるいちず"), group: T(c, "物", "Things"), description: T(c, "知らない町の名前が書かれた地図。", "A map with the name of an unknown town on it.") },
  ];
}

/** 作り物のおまけ（CG、回想、音楽、実績、用語集、エンディング）。 */
export function sampleExtra(c: SampleContext): ExtraConfig {
  const title = (ja: string, en: string, ja2: string, en2: string) => (long(c) ? T(c, ja2, en2) : T(c, ja, en));
  return {
    cg: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `cg${n}`, title: title(`見本の絵 ${n}`, `Sample picture ${n}`, `灯台へ続く長い坂道から見下ろした港 ${n}`, `The harbor seen from the long slope to the lighthouse ${n}`), group: n <= 3 ? T(c, "第一章", "Chapter 1") : T(c, "第二章", "Chapter 2"), images: [img(`cg-${n}`)] })),
    replay: [1, 2, 3].map((n) => ({ id: `scene${n}`, title: title(`見本の回想 ${n}`, `Sample scene ${n}`, `灯台守の小屋で聞いた昔の話 ${n}`, `The old story heard in the keeper's hut ${n}`), target: SAMPLE_FILE, thumb: img(`replay-${n}`) })),
    music: [1, 2, 3].map((n) => ({ file: `${SAMPLE_ASSET}bgm-${n}.ogg`, title: title(`見本の曲 ${n}`, `Sample track ${n}`, `霧の朝に灯台から聞こえる鐘の音 ${n}`, `The bell heard from the lighthouse on a misty morning ${n}`), artist: T(c, "見本の作曲者", "Sample composer") })),
    achievements: [
      { id: "first", title: title("はじめの一歩", "First step", "はじめて灯台の上まで上り、海を見渡した", "Climbed to the top of the lighthouse and looked out to sea"), description: T(c, "見本の実績。", "A sample achievement.") },
      { id: "count", title: T(c, "市場めぐり", "Market rounds"), description: T(c, "市場の店を回る。", "Visit the market stalls."), goal: 5 },
      { id: "hidden", title: T(c, "見本の隠し実績", "Hidden sample"), description: T(c, "見本の実績。", "A sample achievement."), hidden: true },
    ],
    glossary: sampleGlossary(c),
  };
}

/** 作り物のおまけの解放（全セーブ共通の変数）。空なら何も解放しない。 */
function sampleUnlocks(c: SampleContext): Record<string, Value> {
  if (c.state === "empty") return {};
  return {
    cg_unlocked: { [img("cg-1")]: true, [img("cg-2")]: true, [img("cg-4")]: true, [img("cg-5")]: true },
    replay_unlocked: { scene1: true, scene2: true },
    bgm_heard: { [`${SAMPLE_ASSET}bgm-1.ogg`]: true, [`${SAMPLE_ASSET}bgm-2.ogg`]: true },
    achievements: { first: "2026-04-12T21:34:00" },
    achievement_progress: { count: 3 },
    glossary_unlocked: { keeper: true, market: true },
  };
}

/** 作り物の持ち物。 */
export function sampleItems(c: SampleContext): ItemsConfig {
  return {
    lamp: { name: long(c) ? T(c, "灯台守から借りた古い手提げのランプ", "The old hand lamp borrowed from the keeper") : T(c, "ランプ", "Lamp"), image: img("item-lamp-square"), description: long(c) ? T(c, "灯台守から借りた手提げのランプ。油は半分ほど残っている。風の強い日でも消えにくいよう、火のまわりに細かい網が張ってある。", "A hand lamp borrowed from the keeper, about half full of oil. A fine mesh around the flame keeps it from going out even on windy days.") : T(c, "灯台守から借りたランプ。", "A lamp borrowed from the keeper.") },
    map: { name: T(c, "古い地図", "Old map"), image: img("item-map-square"), description: T(c, "知らない町の名前が書かれた地図。", "A map with the name of an unknown town on it.") },
    key: { name: T(c, "小屋の鍵", "Hut key"), image: img("item-key-square"), description: T(c, "灯台守の小屋の鍵。", "The key to the keeper's hut.") },
  };
}

/** 持ち物を持たせる行（空なら持たせない）。 */
function sampleItemLines(c: SampleContext): string[] {
  return c.state === "empty" ? [] : ["@item-add lamp notify=false", "@item-add map count=2 notify=false"];
}

/** 作り物の図鑑（data/codex.json。一覧、年表、相関図）。 */
export function sampleCodex(c: SampleContext): { title: string; notify: boolean; categories: Record<string, unknown>[]; entries: ({ id: string } & Record<string, unknown>)[] } {
  const longText = T(c, "灯台の明かりを守る人。夜ごとに火を確かめ、霧の日には鐘を鳴らして船に岬の場所を知らせる。町の人からは、昔の話をよく知る人として頼られている。", "The person who tends the lighthouse light. They check the flame every night and ring the bell on foggy days to tell ships where the cape is.");
  return {
    title: T(c, "図鑑", "Codex"),
    notify: false,
    categories: [
      { id: "people", label: T(c, "人物", "People"), type: "relations" },
      { id: "places", label: T(c, "場所", "Places") },
      { id: "events", label: T(c, "出来事", "Events"), type: "timeline" },
    ],
    entries: [
      { id: "guide", category: "people", title: long(c) ? T(c, "とても長い肩書きを持っている案内人", "The guide with a remarkably long title") : T(c, "案内人", "Guide"), summary: T(c, "灯台への道を案内する人。", "The one who shows the way to the lighthouse."), image: img("codex-guide-square"), x: 30, y: 40, links: [{ to: "traveler", label: T(c, "案内する", "Guides"), tone: "positive" }], sections: [{ title: T(c, "人柄", "Character"), text: long(c) ? longText : T(c, "口数は少ないが、道にはくわしい。", "Quiet, but knows every road.") }] },
      { id: "traveler", category: "people", title: T(c, "旅人", "Traveler"), summary: T(c, "遠い町から来た人。", "Someone from a faraway town."), image: img("codex-traveler-square"), x: 70, y: 55, sections: [{ text: T(c, "古い地図を持って港に着いた。", "Arrived at the harbor with an old map.") }] },
      { id: "lighthouse", category: "places", title: T(c, "灯台", "Lighthouse"), summary: T(c, "岬の先に立つ白い灯台。", "A white lighthouse at the tip of the cape."), image: img("codex-lighthouse"), sections: [{ text: T(c, "夜になると明かりが海を照らす。", "At night its light sweeps the sea.") }] },
      { id: "market", category: "places", title: T(c, "港の市場", "Harbor market"), summary: T(c, "朝から開く市場。", "A market that opens in the morning."), image: img("codex-market"), sections: [{ text: T(c, "魚と果物の店が多い。", "Mostly fish and fruit stalls.") }] },
      { id: "arrival", category: "events", title: T(c, "港に着く", "Arrival at the harbor"), date: T(c, "一日目", "Day 1"), sections: [{ text: T(c, "船で港に着いた。", "Arrived at the harbor by boat.") }] },
      { id: "climb", category: "events", title: T(c, "灯台に上る", "Climbing the lighthouse"), date: T(c, "三日目", "Day 3"), sections: [{ text: T(c, "階段を上って海を見渡した。", "Climbed the stairs and looked out to sea.") }] },
    ],
  };
}

/** 作り物の調べる場所と地図（data/investigation.json。@investigate sample と @map-choice sample）。 */
export function sampleInvestigation(c: SampleContext): unknown {
  const desc = long(c)
    ? T(c, "朝から開く港の市場。魚と果物の店が多く、奥には古い地図を売る店がある。細い路地が入り組んでいるので、迷わないように気をつけて進むこと。", "The harbor market opens in the morning. Most stalls sell fish and fruit, and at the back is a shop that sells old maps. The alleys twist, so take care not to get lost.")
    : T(c, "朝から開く港の市場。", "The harbor market that opens in the morning.");
  return {
    places: {
      sample: {
        title: T(c, "灯台の前", "In front of the lighthouse"),
        file: SAMPLE_FILE,
        finish: "button",
        incomplete: "#end",
        views: [
          {
            id: "front",
            label: T(c, "正面", "Front"),
            background: img("investigate"),
            spots: [
              { id: "door", label: long(c) ? T(c, "灯台守の小屋の古い木の扉", "The old wooden door of the keeper's hut") : T(c, "扉", "Door"), rect: { x: 180, y: 300, width: 220, height: 260 }, target: "#end", required: true },
              { id: "bell", label: T(c, "鐘", "Bell"), rect: { x: 620, y: 160, width: 160, height: 160 }, target: "#end" },
              { id: "path", label: T(c, "坂道", "Slope"), rect: { x: 900, y: 420, width: 260, height: 200 }, target: "#end" },
            ],
          },
        ],
      },
    },
    maps: {
      sample: {
        title: T(c, "町の地図", "Town map"),
        prompt: T(c, "どこへ行きますか", "Where will you go?"),
        file: SAMPLE_FILE,
        background: img("map"),
        spots: [
          { id: "lighthouse", label: T(c, "灯台", "Lighthouse"), rect: { x: 900, y: 120, width: 200, height: 160 }, desc: T(c, "岬の先に立つ白い灯台。", "A white lighthouse at the tip of the cape."), image: img("map-lighthouse") },
          { id: "market", label: long(c) ? T(c, "港の前の朝から開く市場", "The morning market in front of the harbor") : T(c, "港の市場", "Harbor market"), rect: { x: 360, y: 380, width: 220, height: 160 }, desc, image: img("map-market") },
          { id: "forest", label: T(c, "北の森", "North forest"), rect: { x: 160, y: 100, width: 200, height: 160 }, desc: T(c, "まだ入れない。", "Not open yet."), locked: "true" },
        ],
      },
    },
  };
}

/** 作り物のフローチャート（場面、選択肢、二つの結末）。 */
export function sampleFlow(c: SampleContext): Flow {
  const t = (ja: string, en: string, ja2: string, en2: string) => (long(c) ? T(c, ja2, en2) : T(c, ja, en));
  const scene = (id: string, title: string, end?: { ending: string; title: string }) => ({ id, title, anchor: null, nodes: [id], pages: 3, ...(end ? { end } : {}) });
  return {
    entry: "s1",
    scenes: [
      scene("s1", t("港に着く", "Arriving at the harbor", "船で港に着き、坂の上に灯台を見つける", "Arriving by boat and spotting the lighthouse on the hill")),
      scene("s2", ""),
      scene("s3", t("灯台へ", "To the lighthouse", "灯台へ続く長い坂道を上る", "Climbing the long slope to the lighthouse")),
      scene("s4", t("市場へ", "To the market", "港の市場で古い地図の店を探す", "Looking for the map shop in the harbor market")),
      scene("s5", t("明かり", "The light", "灯台の明かりを見上げる", "Looking up at the lighthouse light"), { ending: "good", title: T(c, "灯台の明かり", "The lighthouse light") }),
      scene("s6", t("地図", "The map", "地図の端の町へ旅立つ", "Setting out for the town at the map's edge"), { ending: "normal", title: T(c, "知らない町へ", "To an unknown town") }),
    ],
    links: [
      { from: "s1", to: "s2" },
      { from: "s2", to: "s3", choice: T(c, "灯台へ行く", "Go to the lighthouse") },
      { from: "s2", to: "s4", choice: T(c, "港の市場を見る", "Look around the harbor market") },
      { from: "s3", to: "s5" },
      { from: "s4", to: "s6" },
    ],
    pages: {},
  };
}

/** フローチャートで着いた場面（空ならどこにも着いていない）。 */
function sampleReached(c: SampleContext): string[] {
  return c.state === "empty" ? [] : ["s1", "s2", "s3", "s5"];
}

/** 作り物の注意書き（作品が ui.contentWarning を書いていなければ）。 */
export function sampleWarning(c: SampleContext): NonNullable<UiConfig["contentWarning"]> {
  return {
    text: long(c)
      ? T(c, "これは見本の注意書きです。この作品には、暗い場面や大きな音が出る場面があります。長い文のときに、枠の中で折り返して、ボタンと重ならないかを確かめてください。気分が悪くなったら、休憩を取りながら遊んでください。", "This is a sample content warning. This game has dark scenes and scenes with loud sounds. Check that long text wraps inside the panel and stays clear of the buttons. If you feel unwell, take a break.")
      : T(c, "これは見本の注意書きです。この作品には、暗い場面や大きな音が出る場面があります。", "This is a sample content warning. This game has dark scenes and scenes with loud sounds."),
    always: true,
  };
}

/** 作り物の起動の演出（作品が ui.splash を書いていなければ）。押すまで注意書きの段で止める。 */
export function sampleSplash(c: SampleContext): NonNullable<UiConfig["splash"]> {
  return {
    notice: {
      title: T(c, "ご注意", "Notice"),
      blocks: [
        { label: T(c, "見本", "Sample"), text: T(c, "これは起動の演出の見本です。", "This is a sample opening sequence.") },
        { label: T(c, "音", "Sound"), text: T(c, "音が出ます。\n音量にご注意ください。", "This game plays sound.\nMind the volume.") },
      ],
      auto: false,
    },
    skip: false,
  };
}

/**
 * 画面ごとの作り物（作品の設定に重ねるもの、作品のデータ、記憶の場所に入れるもの）。
 * - project: liminalia.json に重ねる（おまけ、持ち物）。見本の中だけで、作品のファイルは変えない
 * - data: data/<名前> の作り物（図鑑、調べる場所）
 * - store: 記憶の場所に入れるもの（鍵は "liminalia:<作品の id>:" の後ろ。全セーブ共通の変数 system、着いた場面 scene:<id> など）
 * - slots: セーブスロット
 * - log: 見本のセーブ（読み込んでから開く画面）に入れるバックログ
 */
export interface SampleContent {
  project: { extra?: ExtraConfig; items?: ItemsConfig };
  data: Record<string, unknown>;
  store: Record<string, unknown>;
  slots: [slot: number | "quick" | "auto:0", record: SlotRecord][];
  log: LogEntry[];
}

export function sampleContent(id: string, c: SampleContext): SampleContent {
  const out: SampleContent = { project: {}, data: {}, store: {}, slots: [], log: [] };
  // セーブのある画面（タイトルのつづきから、セーブとロード、メニュー）
  if (["title", "saveload", "menu"].includes(id)) out.slots = sampleSlots(c);
  if (id === "backlog") out.log = sampleLog(c);
  if (id === "extra") {
    out.project.extra = sampleExtra(c);
    out.store.system = sampleUnlocks(c);
  }
  // 用語の説明（解放済みにしておき、はじめて出たときの知らせを重ねない）
  if (id === "term") {
    out.project.extra = { glossary: sampleGlossary(c) };
    out.store.system = { glossary_unlocked: Object.fromEntries(sampleGlossary(c).map((g) => [g.id, true])) };
  }
  if (id === "flowchart") {
    out.project.extra = { flowchart: true, endings: true };
    for (const s of sampleReached(c)) out.store[`scene:${s}`] = true;
  }
  if (id === "items") out.project.items = sampleItems(c);
  if (id === "codex") out.data["codex.json"] = sampleCodex(c);
  if (id === "investigate" || id === "map-choice") out.data["investigation.json"] = sampleInvestigation(c);
  // 字幕を出す設定
  if (id === "captions") out.store.config = { captions: true };
  return out;
}

/**
 * 制作画面に渡す標準の画面の一覧（system/screen-catalog.ts の一覧に、見本で開けるか、用意した状態、開けない理由を添えたもの）。
 * 開発サーバーが @liminalia/studio の setScreenTable で渡し、制作画面は GET /screens で読む。
 */
export function screenPreviewTable(): ScreenInfo[] {
  return SCREEN_CATALOG.map((e) => {
    const s = SCREEN_SAMPLES[e.id];
    const why = s?.why ?? (s?.how ? undefined : { ja: "見本を用意していません", en: "No sample yet" });
    return {
      id: e.id,
      name: e.name,
      owner: e.owner,
      opens: !!s?.how,
      states: [...(s?.states ?? [])],
      ...(why ? { why } : {}),
      texts: e.texts,
      theme: e.theme,
      classes: e.classes,
      vars: e.vars,
      ...(e.systemVars ? { systemVars: true, systemVarNames: SYSTEM_SCREEN_VARS } : {}),
      replace: e.replace,
      parts: e.parts,
    };
  });
}
