/**
 * 既定の見た目や動きが変わったもの（CHANGELOG の「要対応」のうち、前の動きに戻せるもの）の表。lim migrate --keep-behavior が、
 * 作品の書式の版（liminalia.json の format）から今までに変わったものを並べ、前の動きにする設定を liminalia.json に書く。
 *
 * - before: この書式の版より前（format がこれより小さいか、書いていない）の作品で変わる。書式の版 2 は 0.1.18、3 は 0.2.0、4 は 0.6.0 で上げた。
 *   0.1.19 から 0.1.21 の変更は書式の版 2 のまま入ったので、版 2 の作品がその前に作られたかは分からない。版 3 より前の作品すべてに出す。
 *   0.2.1 から 0.5.x の変更も同じく、版 4 より前の作品すべてに出す。
 * - keep: 前の動きにする設定（liminalia.json に重ねる、鍵の道筋と値）。作品がもう決めているか、作品に関わらなければ null。
 *   無いものは設定では戻せない（manual に手順を書く）。
 * 変更を足したら、CHANGELOG の「要対応」と、docs/design/format.md の「lim migrate」の表（と英訳）にも書く。
 */

/** liminalia.json（読めた JSON）と、作品の台本の中身。 */
export interface BehaviorContext {
  config: Record<string, unknown>;
  /** 台本の中身（ファイルの名前 → 本文）。 */
  scripts: ReadonlyMap<string, string>;
}

export interface BehaviorChange {
  id: string;
  /** 変わったエンジンの版。 */
  version: string;
  /** この書式の版より前の作品で変わる。 */
  before: number;
  ja: string;
  en: string;
  keep?: (c: BehaviorContext) => { path: string[]; value: unknown } | null;
  /** 設定で戻せないものの、前に近づける手順。 */
  manual?: { ja: string; en: string };
}

/** 鍵の道筋の値（無ければ undefined）。 */
export function valueAt(json: unknown, path: readonly string[]): unknown {
  let v: unknown = json;
  for (const k of path) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** 鍵の道筋に値を置く（途中のオブジェクトは作る。オブジェクトでない値があれば置き換えない）。 */
export function setAt(json: Record<string, unknown>, path: readonly string[], value: unknown): boolean {
  let at = json;
  for (const k of path.slice(0, -1)) {
    const next = at[k];
    if (next === undefined) at = at[k] = {} as Record<string, unknown>;
    else if (next && typeof next === "object" && !Array.isArray(next)) at = next as Record<string, unknown>;
    else return false;
  }
  at[path.at(-1)!] = value;
  return true;
}

/** 道筋がまだ決まっていなければ、その設定にする。 */
const unless = (path: string[], value: unknown) => (c: BehaviorContext) => (valueAt(c.config, path) === undefined ? { path, value } : null);

/** 台本にエンディング（ending= か title= のあるプレイを終える命令）があるか（字面で見る）。 */
const hasEnding = (c: BehaviorContext) => [...c.scripts.values()].some((t) => /^\s*@title-screen\b.*\b(?:ending|title)=/m.test(t));

/** 0.2.0 より前の、結末の名前の画面の書体。 */
const OLD_ENDING_FONT = '"Hiragino Mincho ProN", "Yu Mincho", serif';

export const BEHAVIOR_CHANGES: readonly BehaviorChange[] = [
  {
    id: "line-break",
    version: "0.1.18",
    before: 2,
    ja: "日本語と中国語の本文は、ui.text.lineBreak を書かなければ strict で折り返す（行頭に小さい「ッ」や「ー」を置かない）",
    en: "Japanese and Chinese text wraps with strict line breaking when ui.text.lineBreak isn't set (no small kana or long vowel marks at the start of a line)",
    keep: (c) => {
      const langs = Array.isArray(c.config.languages) && c.config.languages.length > 0 ? c.config.languages : ["ja"];
      if (!langs.some((l) => typeof l === "string" && /^(?:ja|zh)\b/.test(l))) return null;
      return unless(["ui", "text", "lineBreak"], "auto")(c);
    },
  },
  {
    id: "chara-swap",
    version: "0.1.18",
    before: 2,
    ja: "同じ立ち位置に別の人物を出すときは、前の人物が消えてから出す（@chara swap=after が既定）",
    en: "When another character appears in the same position, the previous one leaves first (@chara swap=after is the default)",
    keep: unless(["commandDefaults", "chara", "swap"], "cross"),
  },
  {
    id: "chara-keep-text",
    version: "0.1.18",
    before: 2,
    ja: "wait=true の @chara で次の人物の出を待つ間、前の話者の名前欄と本文を消す（0.4.1 からは、ページを送ったあとの最初の命令でも消すので、残すには page-keep-text も要る）",
    en: "While @chara with wait=true waits for the next character to appear, the previous speaker's name box and text are cleared (since 0.4.1 they're also cleared at the first command after a page, so keeping them also needs page-keep-text)",
    keep: unless(["ui", "chara", "keepText"], true),
  },
  {
    id: "movie-skip",
    version: "0.1.18",
    before: 2,
    ja: "スキップ中に来た、skip を書いていない初めての @movie は流す",
    en: "During skip, a first-time @movie without skip is played",
    manual: { ja: "飛ばしてよい @movie に skip=true を書きます", en: "Write skip=true on each @movie that may be skipped" },
  },
  {
    id: "voice-overlap",
    version: "0.1.18",
    before: 2,
    ja: "同じ台詞の前に話者かチャンネルの違う @voice を二つ書くと、二つを同時に鳴らす",
    en: "Two @voice lines with different speakers or channels before the same line play at the same time",
    manual: { ja: "後の @voice だけを鳴らすなら、前の @voice を消します", en: "To play only the later @voice, remove the earlier one" },
  },
  {
    id: "bgm-filter",
    version: "0.1.18",
    before: 2,
    ja: "鳴っている同じ曲への @bgm は、フィルターを掛け直す（書かなければ外す）",
    en: "@bgm for the same track that's already playing sets the filter again (removes it if none is written)",
    manual: { ja: "フィルターを残すなら、その @bgm にも同じ filter を書きます", en: "To keep the filter, write the same filter on that @bgm too" },
  },
  {
    id: "choice-position",
    version: "0.1.21",
    before: 3,
    ja: "選択肢は、立ち絵の顔に重なるときだけ、重ならない高さへずらす（ui.choice.position が avoid-faces）",
    en: "Choices move to a height that doesn't cover the sprites' faces only when they would (ui.choice.position is avoid-faces)",
    keep: (c) => (valueAt(c.config, ["ui", "choice", "y"]) !== undefined ? null : unless(["ui", "choice", "position"], "center")(c)),
  },
  {
    id: "ending-card",
    version: "0.1.21",
    before: 3,
    ja: "@title-screen ending= で終えると、結末の名前と終わりの表記を出し、押すのを待ってからタイトルへ戻る",
    en: "Ending with @title-screen ending= shows the ending's name and an end mark, and waits for a press before going back to the title",
    keep: (c) => (hasEnding(c) ? unless(["commandDefaults", "title-screen", "card"], "false")(c) : null),
  },
  {
    id: "ending-font",
    version: "0.2.0",
    before: 3,
    ja: "結末の名前の画面の書体は、ui.ending.font を書かなければ本文の書体（ui.text.font）に合う",
    en: "The font of the ending name screen follows the text font (ui.text.font) when ui.ending.font isn't set",
    keep: (c) => (hasEnding(c) && valueAt(c.config, ["ui", "text", "font"]) !== undefined ? unless(["ui", "ending", "font"], OLD_ENDING_FONT)(c) : null),
  },
  {
    id: "system-colors",
    version: "0.2.0",
    before: 3,
    ja: "ui.system に色を書いた作品では、確かめと入力の枠、通知、短い知らせの色が ui.system の色に合う",
    en: "In projects that set colors in ui.system, the dialog and input boxes, notifications and short notices follow those colors",
    manual: {
      ja: "前の暗い色に戻すなら、作品の CSS で .lm-notice、.lm-panel-buttons button、.lm-sys > .lm-toast の背景と文字の色を決めます（CHANGELOG 0.2.0）",
      en: "To go back to the old dark colors, set the background and text colors of .lm-notice, .lm-panel-buttons button and .lm-sys > .lm-toast in the project's CSS (CHANGELOG 0.2.0)",
    },
  },
  {
    id: "page-keep-text",
    version: "0.4.1",
    before: 4,
    ja: "クリックでページを送ったあと、最初の命令（背景、立ち絵、待つなど）で前のページの名前と本文を消す（枠は残す）",
    en: "After a click turns the page, the first command (a background, a sprite, a wait, and so on) clears the previous page's name and text (the box stays)",
    keep: unless(["ui", "message", "keepText"], true),
  },
  {
    id: "reduce-motion",
    version: "0.5.0",
    before: 4,
    ja: "コンフィグの「画面効果」（標準／控えめ）をなくした。文字の動き、@effect、揺れる立ち絵、パーティクルなどはいつも動く。「画面の揺れ」と「光の点滅」は残る",
    en: "The \"Screen effects\" (standard / reduced) setting was removed. Text effects, @effect, swaying sprites, particles and so on always move. \"Screen shake\" and \"Flashing\" remain",
    manual: {
      ja: "ctx.reduceMotion を見ていたプラグインと、lm-reduce-motion を見ていた作品の CSS は、その分岐を消します（揺れは ctx.reduceShake、点滅は ctx.reduceFlash）",
      en: "Remove the branches in plugins that read ctx.reduceMotion and in project CSS that used lm-reduce-motion (shake is ctx.reduceShake, flashing is ctx.reduceFlash)",
    },
  },
];

/** その作品で変わったもの（書式の版がその変更より前で、関わるもの）。 */
export interface BehaviorCandidate {
  id: string;
  version: string;
  text: { ja: string; en: string };
  /** 前の動きにする設定（無ければ設定では戻せない）。 */
  setting?: { path: string[]; value: unknown };
  manual?: { ja: string; en: string };
  /** 設定を書いたか。 */
  kept: boolean;
}

/** 作品の書式の版（format。書いていないか数でなければ 1）から今までに変わったもののうち、その作品に関わるもの。 */
export function behaviorCandidates(format: number | null, c: BehaviorContext): BehaviorCandidate[] {
  const from = format ?? 1;
  const out: BehaviorCandidate[] = [];
  for (const b of BEHAVIOR_CHANGES) {
    if (from >= b.before) continue;
    if (b.keep) {
      const setting = b.keep(c);
      if (!setting) continue;
      out.push({ id: b.id, version: b.version, text: { ja: b.ja, en: b.en }, setting, kept: false });
    } else out.push({ id: b.id, version: b.version, text: { ja: b.ja, en: b.en }, ...(b.manual ? { manual: b.manual } : {}), kept: false });
  }
  return out;
}
