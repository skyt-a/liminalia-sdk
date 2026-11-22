import { DEFAULT_APPEARANCE, type CastEntry, type CastVariant } from "@liminalia/lang";
import { lex } from "./lexer.ts";
import type { Params } from "./types.ts";

/**
 * TyranoScript の標準の立ち絵（[chara_new] [chara_face] [chara_config]）の定義を集める。
 * 定義はふつう本文として変換しないファイル（system/ や first.ks）にあるので、取り込みは
 * data/scenario 以下の全 .ks から先に集めておき、本文の変換と cast.json の書き出しに使う。
 */

/** [chara_new] と [chara_face] で定義したキャラクター。 */
export interface CharaDef {
  name: string;
  /** 話者名として出す名前（[chara_new] の jname）。 */
  jname: string;
  /** 表情 → 画像（fgimage からのパス）。"default" は [chara_new] の storage。 */
  faces: Record<string, string>;
  width?: number;
  height?: number;
  /** [chara_new] の reflect。 */
  reflect: boolean;
}

export interface CharaDefs {
  charas: Map<string, CharaDef>;
  /** jname → name。[chara_ptext] は jname でもキャラクターを指せる。 */
  jnames: Map<string, string>;
}

/** [chara_config] のうち、変換の結果に関わるもの。 */
export interface CharaConfig {
  /** pos_mode。true なら left のない [chara_show] は自動配置。 */
  posMode: boolean;
  /** time。[chara_mod] の time の既定（ミリ秒の文字列）。 */
  time: string;
  /** memory。false なら立ち絵を消したとき表情を default に戻す。 */
  memory: boolean;
  /** talk_anim。none でなければ `#名前:表情` の表情は待たずに一瞬で変わる。 */
  talkAnim: string;
}

/** TyranoScript の既定値。 */
export const DEFAULT_CHARA_CONFIG: Readonly<CharaConfig> = { posMode: true, time: "600", memory: false, talkAnim: "none" };

/**
 * 変換で反映する [chara_config] の引数（ptext は名前欄の指定で、変換には関わらない）。
 * 話者の強調（talk_focus・brightness_value）と動き（talk_anim）、並べ直し（pos_change_time・effect）は @chara-config にする（sprite-config.ts）。
 */
const APPLIED_CONFIG = new Set(["pos_mode", "time", "memory", "ptext", "cond", "talk_focus", "talk_anim", "brightness_value", "pos_change_time", "effect"]);

/**
 * [chara_config] の話者の強調・動き・並べ直しにあたる @chara-config の引数（無ければ空）。
 * talk_focus=brightness は dim（brightness_value は百分率）、blur は blur。talk_anim は none 以外を jump にする。
 * effect（jQuery の easing の名前）は、In・Out の向きだけを CSS の easing に写す。
 */
export function spriteConfigArgs(pm: Params): string[] {
  const out: string[] = [];
  const focus = pm.talk_focus;
  if (focus) out.push(`focus=${focus === "brightness" ? "dim" : focus === "blur" ? "blur" : "none"}`);
  if (pm.brightness_value && Number.isFinite(Number(pm.brightness_value))) out.push(`dim=${Math.max(0, Math.min(1, Number(pm.brightness_value) / 100))}`);
  if (pm.talk_anim) out.push(`jump=${pm.talk_anim !== "none"}`);
  if (pm.pos_change_time && /^\d+$/.test(pm.pos_change_time)) out.push(`move-time=${pm.pos_change_time}ms`);
  if (pm.effect) {
    const e = pm.effect;
    out.push(`easing=${/linear/i.test(e) ? "linear" : /InOut/.test(e) ? "ease-in-out" : /Out/.test(e) ? "ease-out" : /In/.test(e) ? "ease-in" : "ease"}`);
  }
  return out;
}

/** [chara_config] を当てた設定と、反映できなかった引数。 */
export function applyCharaConfig(config: CharaConfig, pm: Params): { config: CharaConfig; lossy: string[] } {
  const next = { ...config };
  if (pm.pos_mode) next.posMode = pm.pos_mode === "true";
  if (pm.time) next.time = pm.time;
  if (pm.memory) next.memory = pm.memory === "true";
  if (pm.talk_anim) next.talkAnim = pm.talk_anim;
  const lossy = Object.entries(pm)
    .filter(([k, v]) => v !== "" && !APPLIED_CONFIG.has(k) && !((k === "talk_focus" || k === "talk_anim") && v === "none"))
    .map(([k, v]) => `${k}=${v}`);
  return { config: next, lossy };
}

export interface KsSource {
  /** data/scenario からの相対パス。 */
  file: string;
  source: string;
}

/**
 * 全 .ks から [chara_new] / [chara_face] を集める。実行順はファイルの並びからは分からないので、
 * 先に [chara_new] をすべて集め、次に [chara_face] を当てる。同じ名前の定義が食い違えば notes に残す。
 */
export function collectCharas(sources: readonly KsSource[]): { defs: CharaDefs; notes: string[] } {
  const defs: CharaDefs = { charas: new Map(), jnames: new Map() };
  const notes: string[] = [];
  const tags = sources.flatMap(({ file, source }) => lex(source, file).commands.map((c) => ({ file, c })));
  const dynamic = (pm: Params) => Object.values(pm).some((v) => /^[&%]/.test(v));

  for (const { file, c } of tags) {
    if (c.name !== "chara_new") continue;
    const pm = c.pm;
    const where = `${file}:${c.line}`;
    if (!pm.name || !pm.storage || dynamic(pm)) {
      notes.push(`${where} [chara_new] は name と storage を文字で書いたものだけ取り込みます`);
      continue;
    }
    const known = defs.charas.get(pm.name);
    if (known && known.faces.default !== pm.storage) notes.push(`${where} [chara_new name=${pm.name}] が別の画像で定義し直されています（後のものを使います）`);
    const def: CharaDef = { name: pm.name, jname: pm.jname ?? "", faces: { ...known?.faces, default: pm.storage }, reflect: pm.reflect === "true" };
    const size = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const width = size(pm.width);
    const height = size(pm.height);
    if (width !== undefined) def.width = width;
    if (height !== undefined) def.height = height;
    if (pm.color) notes.push(`${where} [chara_new name=${pm.name}] の color（名前の色）は取り込んでいません`);
    defs.charas.set(pm.name, def);
    if (def.jname !== "") defs.jnames.set(def.jname, pm.name);
  }

  for (const { file, c } of tags) {
    if (c.name !== "chara_face") continue;
    const pm = c.pm;
    const where = `${file}:${c.line}`;
    const def = pm.name ? defs.charas.get(pm.name) : undefined;
    if (!def || !pm.face || !pm.storage || dynamic(pm)) {
      notes.push(`${where} [chara_face name=${pm.name ?? ""} face=${pm.face ?? ""}] を取り込めません（キャラクターが未定義か、引数が足りません）`);
      continue;
    }
    if (def.faces[pm.face] !== undefined && def.faces[pm.face] !== pm.storage) notes.push(`${where} [chara_face name=${pm.name} face=${pm.face}] が別の画像で定義し直されています（後のものを使います）`);
    def.faces[pm.face] = pm.storage;
  }
  return { defs, notes };
}

/** [chara_config] を順に当てる（本文として変換しないファイルの設定を、全ファイルの初期値にするため）。 */
export function collectCharaConfig(sources: readonly KsSource[]): { config: CharaConfig; notes: string[] } {
  let config: CharaConfig = { ...DEFAULT_CHARA_CONFIG };
  const notes: string[] = [];
  for (const { file, source } of sources) {
    for (const c of lex(source, file).commands) {
      if (c.name !== "chara_config") continue;
      const applied = applyCharaConfig(config, c.pm);
      config = applied.config;
      if (applied.lossy.length > 0) notes.push(`${file}:${c.line} [chara_config] の ${applied.lossy.join(" ")} は変換していません`);
    }
  }
  return { config, notes };
}

/**
 * [chara_ptext name=X]（`#X` の行）で名前欄に出る文字列。
 * X が jname ならそのキャラクターの jname（つまり X）、[chara_new] の name ならその jname
 * （jname が空なら名前欄も空）、どちらでもなければ X そのもの。
 */
export function speakerName(name: string, defs: CharaDefs): string {
  const chara = defs.charas.get(defs.jnames.get(name) ?? name);
  return chara ? chara.jname : name;
}

/**
 * [chara_new] / [chara_face] のキャラクターをキャストにする。立ち絵セットは default 一つで、表情ごとに差分を持つ。
 * width / height を書いたキャラクターだけ枠を持たせる（位置は自動配置か座標で決めるので positions は持たない）。
 * 片方だけ書いたときは、naturalSize で画像の実寸を引いて縦横比から残りを決める（引けなければ枠を付けず onNote で知らせる）。
 */
export function castEntry(
  def: CharaDef,
  extra: ReadonlyMap<string, string> = new Map(),
  naturalSize?: (image: string) => { width: number; height: number } | null,
  onNote?: (note: string) => void,
): CastEntry {
  const variants: Record<string, CastVariant> = {};
  for (const [face, image] of [...Object.entries(def.faces), ...extra]) {
    if (variants[face]) continue;
    const variant: CastVariant = { image };
    const size = frameFor(def, image, naturalSize);
    if (size) variant.frame = size;
    else if (def.width !== undefined || def.height !== undefined) onNote?.(`${def.name} の ${face}（${image}）は画像の大きさが分からないため、[chara_new] の width / height を使わず実寸で出します`);
    variants[face] = variant;
  }
  return { appearances: { [DEFAULT_APPEARANCE]: { variants } } };
}

function frameFor(def: CharaDef, image: string, naturalSize?: (image: string) => { width: number; height: number } | null): { width: number; height: number } | null {
  const { width, height } = def;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width === undefined && height === undefined) return null;
  const natural = naturalSize?.(image);
  if (!natural || natural.width === 0 || natural.height === 0) return null;
  // TyranoScript は書いた辺だけを CSS に指定するので、残りの辺は画像の縦横比で決まる。
  if (width !== undefined) return { width, height: Math.round((natural.height * width) / natural.width) };
  return { width: Math.round((natural.width * height!) / natural.height), height: height! };
}
