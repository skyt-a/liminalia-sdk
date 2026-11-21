/**
 * キャスト（cast.json の cast）の形と、立ち絵の解決の規則。検査・描画・取り込みが同じ規則を使う。
 *
 * 形と規則は立ち絵プラグイン Tyrano Tatie（tatie）の設定に合わせてある。
 * キャスト → 立ち絵セット（appearance。服装・時代・状態など）→ 差分（variant。表情・ポーズ）→ 画像と枠（frame）。
 * tatie と違い、枠のない差分も書ける（画像の実寸で出し、名前の立ち位置は画面下の中央。TyranoScript の [chara_new] 由来）。
 */
import type { CastSubject } from "./ast.ts";

export interface CastPosition {
  left: number;
  top: number;
}

/** 差分を出す枠。書いた差分は tatie と同じく、幅・高さの既定が 632×843、立ち位置の既定が left / center / right とも (0, 0)。 */
export interface CastFrame {
  width?: number;
  height?: number;
  /** 立ち位置の名前 → 左上の座標。 */
  positions?: Record<string, CastPosition>;
  /**
   * 左右反転（@chara の flip）して出すときに裏返す軸。画像の左端からの X（画像の px）。省くと画像の中央で裏返す。
   * 制作画面の「頭の大きさを揃える」が、反転しても差分ごとに顎が横へずれないように書く。
   */
  flipAxis?: number;
}

export interface CastVariant {
  /**
   * 画像（fgimage からのパス）。パーツ合成の差分（parts）では、一覧や大きさの目安に使う絵（空でもよい。空なら一番下の層）。
   */
  image: string;
  /**
   * パーツ合成の差分: 立ち絵セットの層（layers）の名前 → その層で使う絵の名前（"" はその層を出さない）。
   * 書かなかった層は、その層の default（無ければ出さない）。層の絵を下から重ねた一枚を立ち絵にする。
   */
  parts?: Record<string, string>;
  /** 画像を差し替えたときにブラウザのキャッシュを避けるための文字列（URL に付ける）。 */
  cacheKey?: string;
  /** 枠。省略すると画像の実寸で出し、名前の立ち位置は画面下の中央。 */
  frame?: CastFrame;
  /**
   * 口パクの重ね画像（fgimage からのパス。image と同じ大きさで、口の部分だけを描いたもの）。
   * 少し開いた口 → 大きく開いた口 の順。話しているあいだ image の上に重ねて切り替える。
   */
  lip?: string[];
  /** まばたきの重ね画像（半目 → 閉じた目 の順）。ときどき image の上に重ねる。 */
  blink?: string[];
  /** 顔ウィンドウの絵（fgimage からのパス）。省くと、立ち絵セットの face の範囲を立ち絵から切り出す。 */
  face?: string;
  /**
   * 画像の代わりにプラグインが描く立ち絵（Live2D・Spine など）。type でプラグインの描き方（WebPlugin の
   * extensions.spriteParts）を選び、ほかの項目はそのプラグインが読む。image は位置と大きさを決める静止画として使う。
   * 人物の model と同じ type なら、人物の model に重ねる（Live2D のモデルは人物に書き、差分には表情だけを書く、など）。
   */
  model?: CastModel;
}

/** プラグインが描く立ち絵の指定。type 以外はプラグインが決める。 */
export interface CastModel {
  type: string;
  [key: string]: unknown;
}

/**
 * パーツ合成の層（体、衣装、顔、目、口、眉、頬染めなど）。並びの先が下。絵はどれも同じ大きさのキャンバス（PSD の書き出しと同じ）で描く。
 */
export interface CastLayer {
  name: string;
  /** 選べる絵の名前 → fgimage からのパス。 */
  options: Record<string, string>;
  /** 差分が書かなかったときに使う絵の名前（省くと、その層は出さない）。 */
  default?: string;
}

export interface CastAppearance {
  /** 表示用の名前。 */
  label?: string;
  /** パーツ合成の層。差分の parts で層ごとの絵を選ぶ。@chara の差分に「smile+blush」と書くと、smile の差分に blush の絵を足す。 */
  layers?: CastLayer[];
  /** 差分を書かずに出したときの差分（基準の差分）。省くと normal → default の順にあるもの。 */
  defaultVariant?: string;
  /** 顔ウィンドウに使う、立ち絵（パーツ合成なら重ねた後）の中の範囲（px）。差分の face が無いときに使う。 */
  face?: FaceRect;
  variants: Record<string, CastVariant>;
}

export interface CastEntry {
  /** appearance を書かなかったときの立ち絵セット。 */
  defaultAppearance?: string;
  /** 本文の行の話者名（キャスト名と違うとき）。口パクで、話しているのがこのキャストかを見るのに使う。 */
  speaker?: string;
  /** 名前の欄の文字の色（CSS の色。"#e05a7a" など）。省略でシステム画面の既定の色。 */
  color?: string;
  /**
   * この人物の台詞の本文の文字の見た目（メッセージ枠、NVL、吹き出し）。color は文字の色、font は書体（CSS の font-family）、italic は斜体。
   * 省いた項目は作品の既定（ui.text）。本文の中の {c …} などの飾りが先。
   */
  text?: CastText;
  /** この人物が話すときの名前の欄の画像（image からのパス）。名前の欄の地に敷く（文字はそのまま）。省くと ui.name.image。 */
  nameImage?: string;
  /** この人物が話すあいだのメッセージ枠の画像（image からのパス）。@window-image が先。省くと ui.message.image。 */
  windowImage?: string;
  /** 立ち絵セット。立ち絵の無い人物（名前の色だけを決める話者など）は空でよい。 */
  appearances: Record<string, CastAppearance>;
  /**
   * この人物のすべての差分に使う立ち絵の部品（差分の model と同じ書き方。差分に別の type の model があればそちらを使い、
   * 同じ type なら差分の項目を重ねる）。{ "type": "sway" } で、一枚絵の立ち絵を呼吸・首の傾き・髪の揺れで動かす。
   * 公式のプラグインを入れると { "type": "live2d", "src": "…" }（Live2D）と { "type": "spine", "src": "…" }（Spine）も使える。
   */
  model?: CastModel;
  /**
   * 登場順の自動配置での定位置。left なら並びの左に、right なら右に寄せる（同じ側の人物どうしは登場順）。
   * 位置を明示して出したときには効かない。
   */
  side?: "left" | "right";
}

export type Cast = Record<string, CastEntry>;

/** 人物ごとの台詞の文字の見た目（CastEntry.text）。 */
export interface CastText {
  color?: string;
  font?: string;
  italic?: boolean;
}

/** 立ち絵の中の範囲（画像の左上からの px）。 */
export interface FaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 話者名のキャスト（キャスト名が話者名で speaker が違わないもの → speaker が話者名のもの）。無ければ null。 */
export function castForSpeaker(cast: Readonly<Record<string, CastEntry>>, speaker: string): string | null {
  const own = cast[speaker];
  if (own && (own.speaker === undefined || own.speaker === speaker)) return speaker;
  return Object.keys(cast).find((k) => cast[k]?.speaker === speaker) ?? null;
}

/** 差分の顔ウィンドウの絵。差分の face（絵）→ 立ち絵セットの face（立ち絵から切り出す範囲）の順。どちらも無ければ null。 */
export function variantFace(appearance: CastAppearance | undefined, variant: CastVariant): { image: string } | { crop: FaceRect } | null {
  if (variant.face) return { image: variant.face };
  return appearance?.face ? { crop: appearance.face } : null;
}

export const DEFAULT_APPEARANCE = "default";
/** 枠に幅・高さを書かなかったときの大きさ（tatie と同じ）。 */
export const DEFAULT_FRAME_SIZE = { width: 632, height: 843 } as const;
/** 枠のある差分に必ずある立ち位置。 */
export const FRAME_POSITIONS = ["left", "center", "right"] as const;
/** 自動配置の予約された立ち位置。 */
export const AUTO_POSITION = "auto";

/** 使う立ち絵セットの名前。指定 → defaultAppearance → "default" → 最初のもの、の順に、あるものを選ぶ。 */
export function appearanceKey(entry: CastEntry, requested = ""): string {
  const appearances = entry.appearances ?? {};
  if (requested !== "" && appearances[requested]) return requested;
  if (entry.defaultAppearance && appearances[entry.defaultAppearance]) return entry.defaultAppearance;
  if (appearances[DEFAULT_APPEARANCE]) return DEFAULT_APPEARANCE;
  return Object.keys(appearances)[0] ?? DEFAULT_APPEARANCE;
}

/**
 * 基準の差分の名前（差分を書かずに出したとき）。defaultVariant → normal → default → 最初のもの、の順にあるもの。
 * 最後の「最初のもの」は差分の並び頼みなので、検査（castWarnings）が知らせる。
 */
export function baseVariant(appearance: CastAppearance | undefined): string | null {
  const variants = appearance?.variants ?? {};
  return [appearance?.defaultVariant, "normal", "default", Object.keys(variants)[0]].find((k): k is string => !!k && !!variants[k]) ?? null;
}

/**
 * 差分を引く。立ち絵セットは appearanceKey の規則で選び、差分が無ければ variant は null。
 * variant が空なら基準の差分（baseVariant。@chara で差分を書かなかったとき）。
 */
export function resolveVariant(entry: CastEntry, appearance: string, variant: string): { appearance: string; variant: CastVariant | null } {
  const key = appearanceKey(entry, appearance);
  const set = entry.appearances?.[key];
  const variants = set?.variants ?? {};
  // 「smile+blush」: 差分（空なら標準の差分）に、層の絵を足す（パーツ合成の立ち絵セットだけ）
  const [name = "", ...extras] = variant.split("+");
  const baseName = name === "" ? baseVariant(set) : name;
  const base = baseName ? (variants[baseName] ?? null) : null;
  if (extras.length === 0 || !base) return { appearance: key, variant: base };
  const parts = { ...(base.parts ?? {}) };
  for (const extra of extras) {
    const layer = set?.layers?.find((l) => Object.hasOwn(l.options, extra));
    if (!layer) return { appearance: key, variant: null };
    parts[layer.name] = extra;
  }
  return { appearance: key, variant: { ...base, parts } };
}

/** パーツ合成の差分の層の絵（fgimage からのパス。下から順）。パーツ合成でなければ null。 */
export function variantLayers(appearance: CastAppearance | undefined, variant: CastVariant): string[] | null {
  const layers = appearance?.layers;
  if (!variant.parts || !layers?.length) return null;
  const out: string[] = [];
  for (const layer of layers) {
    const pick = variant.parts[layer.name] ?? layer.default;
    const path = pick ? layer.options[pick] : undefined;
    if (path) out.push(path);
  }
  return out;
}

/** 差分の一覧や大きさの目安にする絵（image、無ければパーツ合成の一番下の層）。 */
export function variantPreview(appearance: CastAppearance | undefined, variant: CastVariant): string {
  return variant.image || variantLayers(appearance, variant)?.[0] || "";
}

/**
 * 実行時の立ち絵の姿の誤り（検査の unknown-appearance・unknown-variant・unknown-position と同じ判定）。無ければ null。
 * appearance・variant・at は状態の値（"" は既定）。描画側は、立ち絵セットが無ければ既定、位置が無ければ center で出し、差分が無ければ出さない。
 */
export function spriteProblem(cast: Readonly<Record<string, CastEntry>>, who: string, appearance: string, variant: string, at: string): { code: string; message: string } | null {
  const entry = cast[who];
  if (!entry) return { code: "unknown-cast", message: `キャラクター ${who} はありません（立ち絵を表示しません）` };
  const appearances = entry.appearances ?? {};
  if (appearance !== "" && !appearances[appearance]) {
    return { code: "unknown-appearance", message: `${who} に立ち絵セット ${appearance} はありません（${appearanceKey(entry)} で表示します）` };
  }
  const key = appearanceKey(entry, appearance);
  const resolved = resolveVariant(entry, key, variant).variant;
  if (!resolved) return { code: "unknown-variant", message: `${who} の ${key} に差分 ${variant === "" ? "（標準の差分）" : variant} はありません（立ち絵を表示しません）` };
  if (at !== "" && at !== AUTO_POSITION && !positionNames(resolved).includes(at)) {
    return { code: "unknown-position", message: `${who} の ${key} / ${variant || "標準の差分"} に立ち位置 ${at} はありません（center に表示します）` };
  }
  return null;
}

/**
 * キャストの定義の、誤りではないが意図せず決まりうるもの（警告）。
 * - 立ち絵セットが二つ以上あるのに既定（defaultAppearance・default）が無い: 並びの最初のものを使う
 * - 差分が二つ以上ある立ち絵セットに基準の差分（defaultVariant・normal・default）が無い: 並びの最初のものを使う
 * - 枠（frame）に名前の立ち位置 left・center・right が欠けている: 欠けた位置は center（center も無ければ左上）に出る
 */
export function castWarnings(cast: Readonly<Record<string, CastEntry>>): ({ who: string; message: string; hint: string } & Omit<CastSubject, "who">)[] {
  const out: ({ who: string; message: string; hint: string } & Omit<CastSubject, "who">)[] = [];
  for (const [who, entry] of Object.entries(cast)) {
    const appearances = entry.appearances ?? {};
    const keys = Object.keys(appearances);
    if (keys.length > 1 && !(entry.defaultAppearance && appearances[entry.defaultAppearance]) && !appearances[DEFAULT_APPEARANCE]) {
      out.push({ who, message: `${who} の既定の立ち絵セットが設定されていないため、最初の ${keys[0]} を使います`, hint: `${who} に "defaultAppearance": "…" を書きます`, kind: "default-appearance" });
    }
    if (entry.defaultAppearance && !appearances[entry.defaultAppearance]) {
      out.push({ who, message: `${who} の defaultAppearance ${entry.defaultAppearance} という立ち絵セットはありません`, hint: keys.join(" / "), kind: "default-appearance" });
    }
    for (const [key, appearance] of Object.entries(appearances)) {
      const variants = Object.keys(appearance.variants ?? {});
      if (appearance.defaultVariant && !appearance.variants?.[appearance.defaultVariant]) {
        out.push({ who, message: `${who} の ${key} の defaultVariant ${appearance.defaultVariant} という差分はありません`, hint: variants.join(" / "), appearance: key, kind: "default-variant" });
      } else if (variants.length > 1 && !["normal", "default", appearance.defaultVariant].some((k) => k && appearance.variants[k])) {
        out.push({ who, message: `${who} の ${key} の標準の差分が設定されていないため、差分を書かずに表示すると最初の ${variants[0]} になります`, hint: `${key} に "defaultVariant": "…" を書きます`, appearance: key, kind: "default-variant" });
      }
      for (const [name, variant] of Object.entries(appearance.variants ?? {})) {
        const positions = variant.frame?.positions;
        if (!variant.frame) continue;
        const missing = FRAME_POSITIONS.filter((p) => !positions?.[p]);
        if (missing.length > 0) {
          out.push({ who, message: `${who} の ${key} / ${name} のフレーム（frame）に立ち位置 ${missing.join("、")} がありません（${positions?.center ? "center" : "左上（0, 0）"}に表示します）`, hint: "frame.positions に書きます", appearance: key });
        }
      }
    }
  }
  return out;
}

/** 枠の大きさ。 */
export function frameSize(frame: CastFrame): { width: number; height: number } {
  return { width: frame.width ?? DEFAULT_FRAME_SIZE.width, height: frame.height ?? DEFAULT_FRAME_SIZE.height };
}

/**
 * 左右反転して出すときに裏返す軸の、枠の幅に対する割合（描画は絵を枠いっぱいに伸ばし、この位置で裏返す）。
 * imageWidth は差分の絵の幅（画像の px）。軸が無い・数でない・絵の幅が分からないときは 0.5（中央）。
 */
export function flipAxisRatio(frame: CastFrame | undefined, imageWidth: number): number {
  const axis = frame?.flipAxis;
  return typeof axis === "number" && Number.isFinite(axis) && imageWidth > 0 ? axis / imageWidth : 0.5;
}

/** 枠の中の立ち位置。無い名前は center、center も無ければ (0, 0)。 */
export function framePosition(frame: CastFrame, at: string): CastPosition {
  return frame.positions?.[at] ?? frame.positions?.center ?? { left: 0, top: 0 };
}

/** その差分で書ける立ち位置の名前（auto を除く）。枠があれば left / center / right と positions の名前、なければ center だけ。 */
export function positionNames(variant: CastVariant): string[] {
  if (!variant.frame) return ["center"];
  return [...new Set([...FRAME_POSITIONS, ...Object.keys(variant.frame.positions ?? {})])];
}

/** cast.json の cast の形の誤り（キャスト名ごと）。 */
export function castProblems(cast: Readonly<Record<string, unknown>>): { who: string; message: string; hint?: string }[] {
  const out: { who: string; message: string; hint?: string }[] = [];
  for (const [who, raw] of Object.entries(cast)) {
    const entry = raw as Partial<CastEntry> & { outfits?: unknown };
    if (!entry || typeof entry !== "object") {
      out.push({ who, message: `キャラクター ${who} の定義がオブジェクトではありません` });
      continue;
    }
    if (entry.outfits !== undefined) {
      out.push({ who, message: `キャラクター ${who} は古い形式（outfits）で書かれています`, hint: "outfits → appearances、defaultOutfit → defaultAppearance、差分の width / height / positions → frame に移します" });
      continue;
    }
    if (!entry.appearances || typeof entry.appearances !== "object" || Array.isArray(entry.appearances)) {
      out.push({ who, message: `キャラクター ${who} に立ち絵セット（appearances）がありません`, hint: "立ち絵のないキャラクターは appearances を {} にします" });
      continue;
    }
    if (entry.color !== undefined && (typeof entry.color !== "string" || entry.color === "")) out.push({ who, message: `キャラクター ${who} の color は色の文字列で書きます` });
    // 台詞の文字の見た目と、名前の欄と枠の画像
    const text = entry.text as unknown;
    if (text !== undefined) {
      if (!text || typeof text !== "object" || Array.isArray(text)) out.push({ who, message: `キャラクター ${who} の text は { color, font, italic } で書きます` });
      else {
        const t = text as Record<string, unknown>;
        for (const k of ["color", "font"] as const) if (t[k] !== undefined && (typeof t[k] !== "string" || t[k] === "")) out.push({ who, message: `キャラクター ${who} の text の ${k} は文字列で書きます` });
        if (t.italic !== undefined && typeof t.italic !== "boolean") out.push({ who, message: `キャラクター ${who} の text の italic は true か false で書きます` });
        const unknown = Object.keys(t).filter((k) => !["color", "font", "italic"].includes(k));
        if (unknown.length > 0) out.push({ who, message: `キャラクター ${who} の text に ${unknown.join("、")} は書けません`, hint: "color、font、italic" });
      }
    }
    for (const k of ["nameImage", "windowImage"] as const) {
      if (entry[k] !== undefined && (typeof entry[k] !== "string" || entry[k] === "")) out.push({ who, message: `キャラクター ${who} の ${k} は image からのパスで書きます` });
    }
    for (const [key, appearance] of Object.entries(entry.appearances)) {
      const face = appearance?.face;
      if (face !== undefined && !(face && typeof face === "object" && (["x", "y", "width", "height"] as const).every((k) => typeof face[k] === "number" && Number.isFinite(face[k]) && face[k] >= 0) && face.width > 0 && face.height > 0)) {
        out.push({ who, message: `キャラクター ${who} の ${key} の face は { x, y, width, height }（px）で書きます` });
      }
      // パーツ合成の層: 名前と、絵の名前 → パスの組
      const layers = appearance?.layers;
      if (layers !== undefined) {
        if (!Array.isArray(layers)) out.push({ who, message: `キャラクター ${who} の ${key} の layers は層の配列で書きます` });
        else {
          for (const [i, l] of layers.entries()) {
            const ok = !!l && typeof l === "object" && typeof l.name === "string" && l.name !== "" && !!l.options && typeof l.options === "object" && Object.values(l.options).every((p) => typeof p === "string" && p !== "");
            if (!ok) out.push({ who, message: `キャラクター ${who} の ${key} の layers の ${i + 1} 番目は { name, options: { 絵の名前: パス } } で書きます` });
            else if (l.default !== undefined && !Object.hasOwn(l.options, l.default)) out.push({ who, message: `キャラクター ${who} の ${key} の層 ${l.name} の default ${l.default} という絵はありません`, hint: Object.keys(l.options).join(" / ") });
          }
        }
      }
      for (const [name, variant] of Object.entries(appearance?.variants ?? {})) {
        const parts = variant?.parts;
        if (parts !== undefined) {
          if (!parts || typeof parts !== "object" || Array.isArray(parts)) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の parts は 層 → 絵の名前 の組で書きます` });
          else {
            for (const [layer, pick] of Object.entries(parts)) {
              const l = Array.isArray(layers) ? layers.find((x) => x?.name === layer) : undefined;
              if (!l) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の parts の層 ${layer} はありません`, hint: Array.isArray(layers) ? layers.map((x) => x?.name).join(" / ") : "立ち絵セットに layers を書きます" });
              else if (typeof pick !== "string" || (pick !== "" && !Object.hasOwn(l.options ?? {}, pick))) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の層 ${layer} に絵 ${String(pick)} はありません`, hint: Object.keys(l.options ?? {}).join(" / ") });
            }
          }
        }
        if (typeof variant?.image !== "string" || (variant.image === "" && parts === undefined)) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} に image がありません` });
        for (const part of ["lip", "blink"] as const) {
          const v = variant?.[part];
          if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === ""))) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の ${part} は画像のパスの配列で書きます` });
        }
        if (variant?.face !== undefined && (typeof variant.face !== "string" || variant.face === "")) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の face は画像のパスで書きます` });
        const flipAxis = (variant?.frame as CastFrame | undefined)?.flipAxis as unknown;
        if (flipAxis !== undefined && (typeof flipAxis !== "number" || !Number.isFinite(flipAxis))) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の frame の flipAxis は、画像の左端からの X（px）の数で書きます` });
        const model = variant?.model;
        if (model !== undefined && (typeof model !== "object" || model === null || typeof model.type !== "string" || model.type === "")) out.push({ who, message: `キャラクター ${who} の ${key} / ${name} の model に type がありません` });
      }
    }
    const model = (entry as { model?: unknown }).model as CastModel | undefined;
    if (model !== undefined && (typeof model !== "object" || model === null || typeof model.type !== "string" || model.type === "")) out.push({ who, message: `キャラクター ${who} の model に type がありません` });
  }
  return out;
}

/** 組み込みの立ち絵の部品の種類（model.type。@liminalia/web の BUILTIN_SPRITE_PARTS）。 */
export const BUILTIN_MODEL_TYPES: readonly string[] = ["sway"];
/** 公式のプラグインが描く立ち絵の種類（model.type → 画面の名前。プラグインの名前は種類と同じ）。 */
export const OFFICIAL_MODEL_TYPES: Readonly<Record<string, string>> = { live2d: "Live2D", spine: "Spine" };

/**
 * cast.json の model（人物と差分）の種類を描くものが無い人物（model-plugin-missing の元。人物と種類ごとに一つ）。遊ぶ画面では画像の立ち絵で出る。
 * available はその種類を描くプラグインがあるか（読み込んだプラグインと liminalia.json の plugins から呼ぶ側が決める）。
 * 公式の種類（live2d、spine）は描くものが無ければ知らせ、それ以外は組み込みと公式の種類に綴りの近いものだけ知らせる
 * （作品のプラグインが描く知らない種類を誤って知らせないため）。src の誤りは、そのプラグインの検査が知らせる。
 */
export function castModelProblems(cast: Readonly<Record<string, unknown>>, available: (type: string) => boolean): { who: string; message: string; hint: string }[] {
  const out: { who: string; message: string; hint: string }[] = [];
  const known = [...BUILTIN_MODEL_TYPES, ...Object.keys(OFFICIAL_MODEL_TYPES)];
  for (const [who, raw] of Object.entries(cast)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<CastEntry>;
    const types = new Set<string>();
    const add = (m: unknown) => {
      if (m && typeof m === "object" && typeof (m as CastModel).type === "string" && (m as CastModel).type !== "") types.add((m as CastModel).type);
    };
    add(entry.model);
    for (const appearance of Object.values(entry.appearances ?? {})) for (const variant of Object.values(appearance?.variants ?? {})) add(variant?.model);
    for (const type of types) {
      if (BUILTIN_MODEL_TYPES.includes(type) || available(type)) continue;
      const label = OFFICIAL_MODEL_TYPES[type];
      if (label !== undefined) {
        out.push({
          who,
          message: `${who} の model の ${label}（type ${type}）を描くプラグインが入っていません（遊ぶ画面では画像の立ち絵で出ます）`,
          hint: `制作画面の「プラグイン」の「公式のプラグイン」で ${label} をインストールします。使わないなら model を消します`,
        });
        continue;
      }
      const near = known.find((k) => k === type.toLowerCase() || typoDistanceAtMostOne(k, type.toLowerCase()));
      if (near !== undefined) out.push({ who, message: `${who} の model の type ${type} を描くものがありません（遊ぶ画面では画像の立ち絵で出ます）`, hint: `${near} のことですか？` });
    }
  }
  return out;
}

/** 一字の違い（置き換え、足りない、多い）までか。 */
function typoDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}
