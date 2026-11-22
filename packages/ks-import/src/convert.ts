import { AUTO_POSITION, DEFAULT_APPEARANCE, NAME_PATTERN, VARIABLE_PATH, appearanceKey, positionNames, resolveVariant, scanHtml, speechLine, speechOpenAt, type Cast, type Registry } from "@liminalia/lang";
import { applyCharaConfig, spriteConfigArgs, collectCharas, DEFAULT_CHARA_CONFIG, speakerName, type CharaConfig, type CharaDefs } from "./chara.ts";
import { convertJsAssignments, convertJsExpression } from "./js-expr.ts";
import { compile } from "./compile.ts";
import { inlineRubyPlain, splitInlineRuby } from "./inline-ruby.ts";
import { entity, markEntities, localMacros, unmark, UNSUPPORTED, type MacroBody, type MacroSignature } from "./macros.ts";
import type { Diagnostic, Params, RawCommand, ScenarioIR } from "./types.ts";

/**
 * .ks を .lim に変換する。
 *
 * TyranoScript の実際の値（省略時は TyranoScript の既定値）を求め、新形式の既定値と違うときだけ書き出す。
 * 意味を保てない箇所は診断に残す。変換できない命令は捨てずに、汎用の形
 * （`@タグ名 引数…`）で書き出し、未対応として数える。
 */

export type Outcome = "mapped" | "dropped" | "generic" | "manual";

export interface ConvertStats {
  /** タグ名 → 結果ごとの件数。地の文は "text"。 */
  byTag: Record<string, Partial<Record<Outcome, number>>>;
}

/** 作品固有のタグの変換。null を返すと汎用の形で書き出す。 */
export interface TagConversion {
  name: string;
  positional: string[];
  /** [引数名, .lim の値, .lim の既定値]。値が既定値と同じなら書かない。 */
  named: [string, string, string | null][];
  /** 変換できたが意味が変わる点（診断として残す）。 */
  notes?: string[];
  /**
   * 直後の [s] を書き出さない。UI を出して結果に応じて自分で飛ぶ命令（選んだ答えや行き先で分かれる画面など）は、
   * TyranoScript では [s] で止めておき UI 側から [jump] していた。新形式では命令の中で飛ぶので、その [s] は要らない。
   * タグに cond があるとき（条件が偽なら [s] で止まる）は飲み込まない。
   */
  swallowStop?: boolean;
  /**
   * 何も書き出さない（name は使わない）。複数のタグを一行にまとめる変換で、まとめ終わるまでのタグに使う
   * （[keyframe] [frame] を [endkeyframe] で @keyframe 一行にするなど）。notes は診断として残す。
   */
  drop?: boolean;
  /** このエンジンでは扱わない理由。汎用の形で書き出さず、TODO のコメントと理由付きのエラーにする（name は使わない）。 */
  unsupported?: string;
}

export type TagProfile = Record<string, (pm: Params, ctx?: { file: string }) => TagConversion | null>;

export interface ConvertOptions {
  /** 話者として登録する名前（プロジェクト全体）。地の文の行頭がこれと紛れるときにエスケープする。 */
  speakers?: ReadonlySet<string>;
  /** 作品固有のタグの変換表（タグ名 → 変換）。組み込みの変換より優先する。 */
  profile?: TagProfile;
  /**
   * [iscript] / [eval] の JS を作品固有の命令に置き換える。置き換えた .lim の行を返す。
   * null なら置き換えず、@script に入れて手作業の対象にする。
   */
  scriptProfile?: (code: string) => string[] | null;
  /**
   * [chara_new] / [chara_face] の定義（プロジェクト全体）。話者名（jname）・表情の確認・storage の表情名に使う。
   * 省略時はこのファイルの中の定義だけを使い、定義が一つもなければ未定義の確認をしない。
   */
  charas?: CharaDefs;
  /** このファイルを実行し始めるときの [chara_config]。省略時は TyranoScript の既定値。 */
  charaConfig?: CharaConfig;
  /**
   * 書き出すキャスト（[chara_new] 由来と tatie の設定を重ねたもの）。[tatie] の確認と、
   * [chara_*] の表情がある立ち絵セット（default）を明示するかの判断に使う。省略時は確かめない。
   */
  cast?: Cast;
  /**
   * 呼び出せるマクロ（[macro] から作った @define）。省略すると、このファイルの中の [macro] を
   * このファイルの @define にする。取り込み（importTyrano）はプロジェクト全体のマクロを一つのファイルに集めて渡し、
   * 呼んだファイルの先頭に `@use そのファイル` を書く。
   */
  macros?: ReadonlyMap<string, MacroSignature>;
  /** 変換しない .ks（system/ 下やプラグインの init.ks など。data/scenario からのパス）。ここへの [call] は書き出さない。 */
  skipCalls?: ReadonlySet<string>;
  /** 命令のレジストリ。マクロの引数の型を、引数を渡している命令の引数の型から決めるのに使う。 */
  registry?: Registry;
}

/** 変換する範囲（マクロの中身を @define にするとき）。 */
export interface ConvertRange {
  ir: ScenarioIR;
  from: number;
  to: number;
  macro?: MacroBody;
}

export interface ConvertResult {
  text: string;
  diagnostics: Diagnostic[];
  stats: ConvertStats;
  /** このファイルで台詞に使われた話者名。 */
  speakers: Set<string>;
  /** このファイルで立ち絵に使われたキャスト名。 */
  cast: Set<string>;
  /** マクロを呼ぶために @use したファイル（マクロの @define を置いたファイル）。 */
  uses: Set<string>;
  /** storage で直接指定された画像に付けた表情名（キャスト名 → 表情名 → 画像）。cast.json に足す。 */
  variants: Map<string, Map<string, string>>;
  /**
   * 対応表（ソースマップ）。text の各行（添字 = 行番号 - 1）が .ks のどこから来たか。
   * 空行・@use など .ks に対応しない行は null。書き戻し（lim backport）が使う。
   */
  map: (LineOrigin | null)[];
}

/** .lim の行の種類（対応表に記録する）。 */
export type LineKind =
  | "text"
  | "command"
  | "label"
  | "if"
  | "elif"
  | "else"
  | "end"
  | "choice"
  | "option"
  | "choice-end"
  | "script"
  | "define"
  | "comment";

/** 書き出した .lim の一行が .ks のどこから来たか。 */
export interface LineOrigin {
  kind: LineKind;
  /** .ks の行の範囲（1 始まり、両端を含む）。 */
  from: number;
  to: number;
  /** この行を書き出した .ks の命令（compile の commands の位置）。本文の行では省く。 */
  tags?: number[];
}

/**
 * 変換の時点で分かる範囲で追う立ち絵の状態。shown が null のときは分からない
 * （ラベル・分岐・呼び出し・変換できないタグのあとは、ほかから来たり何かが起きたりしうるので忘れる）。
 */
interface CharaTrack {
  shown: boolean | null;
  /** 表示中の位置（.lim の at / x / y の値）。分からなければ null。 */
  position: SpritePosition | null;
  /** 表示中の立ち絵セットと差分（tatie は [tatie] で出したもの）。分からなければ null。 */
  current: { appearance: string; variant: string; tatie?: true } | null;
  /** 次の [chara_show] が face なしで出す表情（TyranoScript の storage の記憶）。 */
  storage: string;
  /** 反転（TyranoScript では消しても覚えている）。 */
  reflect: boolean;
}

/** .lim の @chara の位置（at・x・y）。x / y があるとき at は書かない。 */
interface SpritePosition {
  at: string;
  x?: string;
  y?: string;
}

/** 台詞の始まり（日本語の括弧と、英語の引用符 " “。引用符で始まる本文は `話者 "…"` と半角の空白を挟んで書き出す）。 */
const SPEECH_OPENERS = /^[「『（("“]/;

/** 命令の名前付き引数: [引数名, .lim の値, .lim の既定値]。値が既定値と同じなら書かない。 */
type Named = [key: string, value: string, defaultValue: string | null];

/** [glink] と [s] の間に置かれる、選択肢の部品になるタグ。 */
const CHOICE_PARTS = new Set(["glink", "button", "clickable", "locate", "edit", "s"]);
/** 選択肢の行になるタグ。cond は @if で囲まずに、その選択肢の行の if=(式) にする（[link] は [endlink] で選択肢になる）。 */
const OPTION_TAGS = new Set(["glink", "button", "clickable"]);

export function convert(source: string, file: string, options: ConvertOptions = {}, range?: ConvertRange): ConvertResult {
  const ir = range?.ir ?? compile(source, file);
  const commands = ir.commands;
  const diagnostics: Diagnostic[] = range ? [] : ir.diagnostics.filter((d) => d.severity === "error");
  // このファイルの中の [macro] を、このファイルの @define にする（取り込みではプロジェクト全体で集めて渡される）。
  const inlineDefines = new Map<number, string[]>();
  let localStats: ConvertStats | null = null;
  if (!range && options.macros === undefined) {
    // マクロの中身も、このファイルの立ち絵の定義で変換する。
    const fileCharas = options.charas ?? collectCharas([{ file, source }]).defs;
    const local = localMacros(ir, file, fileCharas.charas.size > 0 ? { ...options, charas: fileCharas } : options);
    options = { ...options, macros: local.macros };
    for (const [index, lines] of local.defines) inlineDefines.set(index, lines);
    diagnostics.push(...local.diagnostics);
    localStats = local.stats;
  }
  const macro = range?.macro;
  const stats: ConvertStats = localStats ?? { byTag: {} };
  const speakers = new Set<string>();
  const cast = new Set<string>();
  const knownSpeakers = [...(options.speakers ?? [])];
  const charas = options.charas ?? collectCharas([{ file, source }]).defs;
  /** 未定義のキャラクター・表情をエラーにするか（定義が分かっているときだけ）。 */
  const validateCharas = options.charas !== undefined || charas.charas.size > 0;
  let charaConfig: CharaConfig = { ...(options.charaConfig ?? DEFAULT_CHARA_CONFIG) };
  const tracks = new Map<string, CharaTrack>();
  const variants = new Map<string, Map<string, string>>();

  const out: string[] = [];
  /** out の各行の出どころ（対応表）。 */
  const origins: (LineOrigin | null)[] = [];
  /** 今変換している命令の出どころ。 */
  let here: LineOrigin = { kind: "command", from: 0, to: 0 };
  /** まとめ終わるまで何も書き出さない変換（TagConversion.drop）をしたタグ。次に書き出した行の出どころに含める。 */
  let pendingDrops: number[] = [];
  let depth = 0;
  let speaker = "";
  let lineBuf = "";
  let lineStart = 0;
  /** 本文の行に最後に何かを足した .ks の行と、今の命令を変換し始めたときの lineBuf（対応表の行の範囲に使う）。 */
  let lineEnd = 0;
  let bufMark = "";
  let ruby: { reading: string; base: string } | null = null;
  let choice: { line: string; text: string; args?: string; origin: LineOrigin }[] = [];
  let currentLine = 0;
  let currentTag = "";
  /** {speed …} を開いているか。 */
  let speedOpen = false;
  /** 直前に変換した作品固有の命令が、直後の [s] を飲み込むか。 */
  let swallowStop = false;
  /** プラグインの変換に、目印にしていない値を渡したか（そのときは目印の使われ方を確かめない）。 */
  let rawEntities = false;
  /** マクロを呼ぶために @use するファイル。 */
  const uses = new Set<string>();
  /** [ruby] の読み。次の一文字に付く。 */
  let rubyNext: string | null = null;
  /** [font] の装飾（[resetfont] まで行をまたいで続く。.lim では行ごとに開き直す）と [mark] の色。 */
  let font: { bold?: true; italic?: true; color?: string; size?: string } = {};
  let markColor: string | null = null;
  /** 装飾を本文に開いている数（閉じる } の数）。 */
  let decoOpen = 0;
  /** [delay] で行をまたいで変えた文字の速さ（[endnowait] で戻す先）。 */
  let textSpeed: string | null = null;
  /** {speed …} を [nowait] で開いたか。 */
  let nowaitOpen = false;
  /** [link] の文が始まった lineBuf の位置。 */
  let linkStart: number | null = null;
  /** 最初の [link] の前の本文（問いかけ）の長さ。選択肢のあいだの [r] と分けるのに使う。 */
  let questionEnd: number | null = null;
  /** 開いている [if]・[ignore] の種類（対応しない [elsif]・[else]・[endif]・[endignore] を見分ける）。 */
  const openBlocks: ("if" | "ignore")[] = [];
  /**
   * 対応する開きの無い閉じ・枝のタグ。字下げを崩さずにコメントにして、手作業の箇所にする。
   * [if] の側（[elsif] [else] [endif]）は compile.ts の構造の確かめ（orphan-branch・orphan-endif）が報告している。
   */
  const orphan = (tag: string, opener: string) => {
    flushLine();
    if (tag === "endignore") report("error", "orphan-branch", `[${tag}] に対応する [${opener}] がありません（書き出さずにコメントにしました）`);
    emit(`// TODO ks: [${tag}]`);
    return "manual" as const;
  };
  let linkPm: Params = {};
  let linkLine = 0;
  let linkIndex = 0;
  /** [link] の cond を変換した式（無ければ null）。 */
  let linkCond: string | null = null;
  /** 変換中の選択肢のタグの cond を変換した式（無ければ null）。選択肢の行の if= になる。 */
  let optionCond: string | null = null;
  /** [locate] の位置（座標のないボタンに使う）。 */
  let locate: { x?: string; y?: string } = {};
  /** 選択肢の前に置いた [edit]（@text-input）の数。 */
  let editPending = 0;

  const count = (tag: string, outcome: Outcome) => {
    const s = (stats.byTag[tag] ??= {});
    s[outcome] = (s[outcome] ?? 0) + 1;
  };
  const report = (severity: Diagnostic["severity"], code: string, message: string, line = currentLine) => {
    diagnostics.push({ severity, code, message, file, line });
  };
  const emit = (text: string, origin: LineOrigin = here) => {
    out.push("  ".repeat(depth) + text);
    origins.push({ ...origin, kind: origin.kind === "command" ? lineKind(text) : origin.kind });
  };
  const blank = () => {
    if (out.length > 0 && out.at(-1) !== "") {
      out.push("");
      origins.push(null);
    }
  };

  // ---- 本文 ----

  /** 溜めた本文を一行として書き出す。[p] 以外で書き出すときは、.lim では一クリック増えることを報告する。 */
  /**
   * 溜めた本文を一行にする。byPage は [p] で終わったか。noclick なら、[p] で終わらずに選択肢・[s] が続く本文（問いかけ）なので、
   * 行の最後に {noclick} を付けて、クリックを待たずに次へ進める（TyranoScript と同じく、本文を出したまま選択肢を出す）。
   */
  const flushLine = (byPage = false, endLine?: number, noclick = false) => {
    if (lineBuf === "") return;
    closeDeco();
    if (speedOpen) {
      lineBuf += "}";
      speedOpen = false;
    }
    // 行末の半角空白は .lim では残らない（表示上の差はない）。
    lineBuf = lineBuf.replace(/[ \t]+$/, "");
    if (noclick) lineBuf += "{noclick}";
    else if (!byPage) report("warning", "text-without-p", "[p] で終わらない本文を一行として書き出しました（クリック待ちが一つ増えます）", lineStart);
    if (ruby) {
      report("warning", "unclosed-ruby", "[srb] が [erb] で閉じられないままページが終わりました");
      lineBuf += escapeText(ruby.base);
      ruby = null;
    }
    let line = lineBuf;
    const origin: LineOrigin = { kind: "text", from: lineStart, to: Math.max(lineStart, endLine ?? (byPage || lineBuf !== bufMark ? currentLine : lineEnd)) };
    if (speaker !== "" && SPEECH_OPENERS.test(line)) {
      speakers.add(speaker);
      emit(speechLine(speaker, line), origin);
    } else {
      if (speaker !== "") report("warning", "speaker-without-bracket", `話者 ${speaker} の行が括弧か引用符で始まらないため、地の文として書き出しました`, lineStart);
      if (needsLeadingEscape(line, knownSpeakers)) line = `\\${line}`;
      emit(line, origin);
    }
    lineBuf = "";
    nowaitOpen = false;
  };

  const appendText = (text: string) => {
    if (lineBuf === "") lineStart = currentLine;
    if (ruby) {
      ruby.base += inlineRubyPlain(text);
      return;
    }
    // 装飾は台詞の開きの括弧の内側から（括弧の前に { があると台詞にならない）。
    if (lineBuf === "" && speaker !== "" && decoPrefix() !== "" && SPEECH_OPENERS.test(text)) {
      lineBuf += escapeText(text[0]!);
      text = text.slice(1);
    }
    if (text === "") return;
    openDeco();
    // [ruby] の読みは次の一文字に付く。
    if (rubyNext !== null) {
      const first = String.fromCodePoint(text.codePointAt(0)!);
      lineBuf += rubyInline(first, rubyNext);
      rubyNext = null;
      text = text.slice(first.length);
    }
    // auto_ruby の本文中の記法 ｜対象《ルビ》 は {r 対象|ルビ} にする。
    for (const part of splitInlineRuby(text)) {
      if ("text" in part) lineBuf += escapeText(part.text);
      else lineBuf += rubyInline(part.base, part.reading);
    }
  };

  const rubyInline = (base: string, reading: string) => `{r ${escapeText(base).replace(/\|/g, "\\|")}|${escapeText(reading)}}`;

  const appendInline = (inline: string) => {
    if (lineBuf === "") lineStart = currentLine;
    lineBuf += inline;
  };

  // ---- 本文の装飾（[font] [mark]）----

  /** 今の装飾を開く書き方（{b {c #fff …）。 */
  const decoPrefix = () => {
    let p = "";
    if (font.bold) p += "{b ";
    if (font.italic) p += "{i ";
    if (font.color) p += `{c ${font.color} `;
    if (font.size) p += `{size ${font.size} `;
    if (markColor) p += `{mark ${markColor} `;
    return p;
  };
  const openDeco = () => {
    if (decoOpen > 0) return;
    const p = decoPrefix();
    if (p === "") return;
    if (lineBuf === "") lineStart = currentLine;
    lineBuf += p;
    decoOpen = (p.match(/\{/g) ?? []).length;
  };
  /** 装飾を閉じる。次に文字を足すとき、そのときの装飾で開き直す。 */
  const closeDeco = () => {
    if (decoOpen === 0) return;
    // 何も囲んでいない装飾は書かない。
    const p = decoPrefix();
    if (p !== "" && lineBuf.endsWith(p)) lineBuf = lineBuf.slice(0, -p.length);
    else lineBuf += "}".repeat(decoOpen);
    decoOpen = 0;
  };
  const resetFont = () => {
    closeDeco();
    font = {};
  };

  // ---- 命令の書き出し ----

  /**
   * 命令を書き出す。named の値が既定値と同じなら書かない。
   * 本文の途中にある命令は、その位置で実行されるよう本文中に {@…} として置く。
   */
  const command = (name: string, positional: string[], named: [key: string, value: string, defaultValue: string | null][] = []) => {
    const parts = [`@${name}`, ...positional];
    for (const [key, value, def] of named) if (value !== def) parts.push(`${key}=${value}`);
    if (lineBuf !== "") appendInline(`{${parts.join(" ")}}`);
    else emit(parts.join(" "));
  };

  const flushChoice = () => {
    if (choice.length === 0) return;
    blank();
    emit("@choice", { ...here, kind: "choice" });
    for (const o of choice) emit(`  - ${o.text === "" ? "" : `${o.text} `}-> ${o.line}${o.args ? ` ${o.args}` : ""}`, o.origin);
    emit("@end", { ...here, kind: "choice-end" });
    choice = [];
  };

  /** マクロの中身の飛び先は、マクロを書いたファイルのラベル（TyranoScript はそのファイルで実行する）。 */
  const targetOf = (storage: string, label: string) => {
    if (storage === "" && label !== "" && macro && macro.file !== null) return macro.file === "" ? null : jumpTarget(macro.file, label);
    return jumpTarget(storage, label);
  };
  /** 外に出せなかった @define（@if の中に [macro] があったとき）。ファイルの最後に置く。 */
  const deferredDefines: { text: string; origin: LineOrigin | null }[] = [];

  for (let index = range?.from ?? 0; index < (range?.to ?? commands.length); index++) {
    const c = commands[index]!;
    // 前の命令が本文の行に何かを足していれば、その行を本文の行の終わりとして覚えておく。
    if (lineBuf !== "" && lineBuf !== bufMark) lineEnd = currentLine;
    bufMark = lineBuf;
    currentLine = c.line;
    currentTag = c.name;
    here = { kind: "command", from: pendingDrops.length > 0 ? commands[pendingDrops[0]!]!.line : c.line, to: c.line, tags: [...pendingDrops, index] };
    const pm = c.pm;

    // 本文に関わるタグは cond を持たない前提で先に処理する。
    switch (c.name) {
      case "text":
        appendText(c.val);
        count("text", "mapped");
        continue;
      case "p":
        if (lineBuf === "") command("wait-click", []);
        else flushLine(true);
        count("p", "mapped");
        continue;
      case "l":
        // 本文の途中なら {click}、本文の外なら単独のクリック待ち。
        if (lineBuf === "") command("wait-click", []);
        else appendInline("{click}");
        count("l", "mapped");
        continue;
      case "r":
        appendInline("{br}");
        count("r", "mapped");
        continue;
      case "chara_ptext": {
        flushLine();
        const name = (pm.name ?? "").trim();
        speaker = speakerName(name, charas);
        // `#名前:表情` の表情は [chara_mod name=… face=…] と同じ（talk_anim があるときは待たずに一瞬で変える）。
        let outcome: Outcome = "mapped";
        if (pm.face) {
          const mod: Params = { name: charas.jnames.get(name) ?? name, face: pm.face };
          if (charaConfig.talkAnim !== "none") Object.assign(mod, { time: "0", wait: "false" });
          outcome = convertCommand({ name: "chara_mod", pm: mod, val: "", line: c.line }, index);
        }
        count("chara_ptext", outcome);
        continue;
      }
      case "srb":
        if (lineBuf === "") lineStart = currentLine;
        ruby = { reading: pm.text ?? "", base: "" };
        count("srb", "mapped");
        continue;
      case "erb":
        if (ruby) {
          appendInline(rubyInline(ruby.base, ruby.reading));
          ruby = null;
        }
        count("erb", "mapped");
        continue;
      case "ruby":
        rubyNext = pm.text ?? "";
        count("ruby", "mapped");
        continue;
      case "emb": {
        const expr = convertJsExpression(pm.exp ?? "", macro?.names);
        if (expr === null) {
          report("error", "manual-expression", `[emb] の式を変換できません: ${pm.exp}`);
          count("emb", "manual");
          continue;
        }
        openDeco();
        appendInline(`{= ${expr}}`);
        count("emb", "mapped");
        continue;
      }
      case "lr":
        // TyranoBuilder のマクロ [lr] は [l][r]。
        if (lineBuf === "") command("wait-click", []);
        else appendInline("{click}");
        appendInline("{br}");
        count("lr", "mapped");
        continue;
      case "font":
        count("font", fontTag(pm));
        continue;
      case "resetfont":
        resetFont();
        count("resetfont", "mapped");
        continue;
      case "mark":
        closeDeco();
        markColor = color(pm.color || "0xFFFF00");
        if (!markColor.startsWith("#")) {
          report("warning", "lossy-param", `[mark] の color=${pm.color} は色として読めないため、黄色にしました`);
          markColor = "#ffff00";
        }
        if (pm.font_color || pm.size) report("warning", "lossy-param", "[mark] の font_color・size は変換していません");
        count("mark", "mapped");
        continue;
      case "endmark":
        closeDeco();
        markColor = null;
        count("endmark", "mapped");
        continue;
      case "nowait": {
        // 同じ行の [p] より前で [endnowait] するなら、その範囲だけの {speed 0ms …} にする。
        if (closesOnLine(index, "endnowait") && !speedOpen) {
          closeDeco();
          appendInline("{speed 0ms ");
          speedOpen = true;
          nowaitOpen = true;
        } else {
          command("text-speed", ["0ms"]);
        }
        count("nowait", "mapped");
        continue;
      }
      case "endnowait":
        if (nowaitOpen && speedOpen) {
          closeDeco();
          appendInline("}");
          speedOpen = false;
          nowaitOpen = false;
        } else if (textSpeed !== null) {
          command("text-speed", [textSpeed]);
        } else {
          command("text-speed-reset", []);
        }
        count("endnowait", "mapped");
        continue;
      case "link":
        closeDeco();
        if (lineBuf === "") lineStart = currentLine;
        linkStart = lineBuf.length;
        linkLine = c.line;
        linkIndex = index;
        linkPm = markEntities(pm, macro, report);
        linkCond = optionCondition(pm.cond, "link");
        count("link", "mapped");
        continue;
      case "endlink": {
        if (linkStart === null) {
          count("endlink", "dropped");
          continue;
        }
        closeDeco();
        const text = lineBuf.slice(linkStart);
        lineBuf = lineBuf.slice(0, linkStart);
        linkStart = null;
        const target = targetOf(linkPm.storage ?? "", linkPm.target ?? "");
        if (target === null) {
          report("error", "manual-target", `[link] の飛び先を変換できません: storage=${unmark(linkPm.storage ?? "")} target=${unmark(linkPm.target ?? "")}`);
          count("endlink", "manual");
          continue;
        }
        if (choice.length === 0) questionEnd = lineBuf.length;
        choice.push({ text, line: target, args: withCondition(linkCond, ""), origin: { kind: "option", from: linkLine, to: c.line, tags: [linkIndex, index] } });
        count("endlink", "mapped");
        continue;
      }
    }

    // [macro] 〜 [endmacro] は @define にしてあるので読み飛ばす。
    if (c.name === "macro" && c.next !== undefined) {
      flushLine();
      const lines = inlineDefines.get(index);
      const origin: LineOrigin = { kind: "define", from: c.line, to: commands[c.next]!.line, tags: [index, c.next] };
      if (lines && depth === 0) {
        blank();
        for (const l of lines) emit(l, origin);
        blank();
      } else if (lines) {
        deferredDefines.push({ text: "", origin: null }, ...lines.map((text) => ({ text, origin })));
      }
      count("macro", options.macros?.has(pm.name ?? "") ? "mapped" : "dropped");
      count("endmacro", "dropped");
      index = c.next;
      continue;
    }
    // [html] 〜 [endhtml] の中の HTML は本文ではない。JS の入っていない HTML だけなら @html にする（入っていれば手作業）。
    if (c.name === "html") {
      flushLine();
      let end = index + 1;
      while (end < commands.length && commands[end]!.name !== "endhtml") end++;
      const lines = end < commands.length ? htmlLines(commands.slice(index + 1, end)) : null;
      if (lines === null) count("html", unsupported(c.name));
      else {
        const args = [pm.name ? str(pm.name) : null, pm.left ? `x=${numberValue(pm.left)}` : null, pm.top ? `y=${numberValue(pm.top)}` : null].filter((a) => a !== null);
        const origin: LineOrigin = { kind: "command", from: c.line, to: commands[end]!.line, tags: [index, end] };
        emit(["@html", ...args].join(" "), origin);
        // 中身は @script と同じく、そのまま持つ行
        for (const l of lines) emit(l, { ...origin, kind: "script" });
        emit("@end", { ...origin, kind: "end" });
        count("html", "mapped");
      }
      if (end < commands.length) count("endhtml", "dropped");
      index = end;
      continue;
    }

    // ここから先は命令。
    if (choice.length > 0 && !CHOICE_PARTS.has(c.name)) {
      report("warning", "choice-interrupted", `[glink] と [s] の間に [${c.name}] があるため、選択肢をその前で閉じました`);
      flushChoice();
    }

    const cond = pm.cond;
    let condOpened = false;
    optionCond = null;
    if (cond && OPTION_TAGS.has(c.name)) {
      optionCond = optionCondition(cond, c.name);
    } else if (cond) {
      const expr = convertJsExpression(cond, macro?.names);
      if (expr === null) {
        report("error", "manual-cond", `cond の式を変換できません: ${cond}`);
      } else {
        emit(`@if ${expr}`);
        depth++;
        condOpened = true;
      }
    }

    swallowStop = false;
    // &式・%引数 は、変換したあと (式) として書き出される目印に置き換えておく。
    const resolved: RawCommand = { ...c, pm: markEntities(c.pm, macro, report) };
    const before = out.length;
    const bufBefore = lineBuf;
    rawEntities = false;
    const outcome = convertCommand(resolved, index, c.pm);
    // まとめて書き出す変換のタグは、書き出した行の出どころに含めたので忘れる。
    if (out.length > before) pendingDrops = [];
    count(c.name, outcome);
    if (!rawEntities) checkEntities(resolved.pm, before, bufBefore);
    // 条件付きのタグのあとは、立ち絵が出ているかどうか分からない。
    if (cond) forgetShown();
    if (swallowStop && !cond && commands[index + 1]?.name === "s" && !commands[index + 1]!.pm.cond) {
      index++;
      count("s", "dropped");
    }
    // [iscript] の中身は @script に入れたので、[endscript] まで読み飛ばす。
    if (c.name === "iscript" && commands[index]!.next !== undefined) index = commands[index]!.next!;

    if (condOpened) {
      depth--;
      emit("@end");
    }
  }
  if (lineBuf !== "" && lineBuf !== bufMark) lineEnd = currentLine;
  bufMark = lineBuf;
  flushLine();
  flushChoice();
  for (const d of deferredDefines) {
    out.push(d.text);
    origins.push(d.origin);
  }

  // マクロの中身（range）は @define の中に入るので @use を書かない（@define を集めたファイルの中で呼ぶ）。
  const header = range ? [] : [...uses].sort().map((u) => `@use ${u}`);
  const text = [...header, "", ...out].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  const map = finalMap([...header, "", ...out], [...header.map(() => null), null, ...origins], text);
  if (map === null) report("warning", "sourcemap-mismatch", "対応表を作れませんでした（書き戻しはこのファイルを扱えません）", 0);
  return { text, diagnostics, stats, speakers, cast, variants, uses, map: map ?? [] };

  // ---- 目印と装飾 ----

  /**
   * 変換し終えた命令に &式・%引数 の目印が残っていないか（文字列の一部に埋め込まれたなど、式にできなかった）、
   * 使われずに消えていないか（変換が値を比べるだけに使ったなど）を確かめる。
   */
  function checkEntities(pm: Params, before: number, bufBefore: string): void {
    const exprs = Object.entries(pm).flatMap(([k, v]) => {
      const e = entity(v);
      return e === null ? [] : [[k, e] as const];
    });
    if (exprs.length === 0) return;
    const produced = out.slice(before).join("\n") + (lineBuf.startsWith(bufBefore) ? lineBuf.slice(bufBefore.length) : lineBuf);
    if (/[\uE000\uE001]/.test(produced)) {
      report("error", "manual-entity", `[${currentTag}] の &式・%引数 を、式として書き出せない位置で使っています`);
      for (let i = before; i < out.length; i++) out[i] = unmark(out[i]!);
      lineBuf = unmark(lineBuf);
      return;
    }
    for (const [key, e] of exprs) {
      if (!produced.includes(`(${e})`) && !produced.includes(`{= ${e}}`)) {
        report("warning", "entity-dropped", `${key} の値（${e}）は変換で使われなかったため、効きません`);
      }
    }
  }

  /** [font]。大きさ・色・太字・斜体は本文の装飾にする。 */
  function fontTag(pm: Params): Outcome {
    closeDeco();
    if (pm.size) font.size = String(Number(pm.size));
    if (pm.color) {
      const c = color(pm.color);
      if (c.startsWith("#")) font.color = c;
      else report("warning", "lossy-param", `[font] の color=${pm.color} は色として読めないため変換していません`);
    }
    if (pm.bold) {
      if (pm.bold === "true") font.bold = true;
      else delete font.bold;
    }
    if (pm.italic) {
      if (pm.italic === "true") font.italic = true;
      else delete font.italic;
    }
    const lossy = ["face", "edge", "shadow", "gradient", "effect", "effect_speed", "edge_method"].filter((k) => pm[k]);
    if (lossy.length > 0) report("warning", "lossy-param", `[font] の ${lossy.join("・")} は変換していません（書体・縁取り・影は本文の見た目（TextTheme）か CSS で決めます）`);
    return "mapped";
  }

  /** 同じ行の [p] より前に closing のタグがあるか。 */
  function closesOnLine(index: number, closing: string): boolean {
    const line = commands[index]!.line;
    for (let j = index + 1; j < commands.length; j++) {
      const n = commands[j]!;
      if (n.line !== line || n.name === "p") return false;
      if (n.name === closing) return true;
    }
    return false;
  }

  /**
   * [html] 〜 [endhtml] のあいだを @html の中身の行にする。地の文だけでできていて、JS（<script>・on… の属性・javascript:）が
   * 入っていないときだけ。ほかのタグや JS があれば null（手作業に回す）。使えないタグ・属性は lim check が知らせる。
   */
  function htmlLines(inner: RawCommand[]): string[] | null {
    if (inner.some((n) => n.name !== "text")) return null;
    const rows = new Map<number, string>();
    for (const n of inner) rows.set(n.line, (rows.get(n.line) ?? "") + n.val);
    const lines = [...rows.values()].filter((l) => l.trim() !== "");
    const body = lines.join("\n");
    if (/<\s*script|javascript\s*:|\{=/i.test(body)) return null;
    if (scanHtml(body).issues.some((i) => i.code === "html-event-attribute")) return null;
    return lines;
  }

  /** このエンジンでは扱わないタグ。理由と直し方を診断に残す。 */
  function unsupported(tag: string): Outcome {
    const u = UNSUPPORTED[tag]!;
    report(u.manual ? "error" : "warning", "unsupported-tag", `[${tag}] は取り込みません: ${u.reason}`);
    return u.manual ? "manual" : "dropped";
  }

  // ---- 個別の変換 ----

  function convertCommand(c: RawCommand, index: number, raw?: Params): Outcome {
    const pm = c.pm;
    const custom = options.profile?.[c.name];
    if (custom) {
      // プラグインの変換は、マクロの外では書かれたままの値（&式・%引数 を自分で見分ける）を受け取る。
      // マクロの中では %引数 を (式) にするため、目印にした値を渡す。
      rawEntities = raw !== undefined && !macro;
      const converted = custom(rawEntities ? raw! : pm, { file });
      if (converted) {
        // 作品固有の変換が立ち絵を動かしたかは分からない。
        forgetShown();
        for (const note of converted.notes ?? []) report("warning", "lossy-param", `[${c.name}] ${note}`);
        if (converted.unsupported !== undefined) {
          flushLine();
          const args = Object.entries(pm).map(([k, value]) => ` ${k}=${JSON.stringify(unmark(value))}`);
          emit(`// TODO ks: [${c.name}${args.join("")}]`);
          report("error", "unsupported-tag", `[${c.name}] ${converted.unsupported}`);
          return "manual";
        }
        if (converted.drop) {
          pendingDrops.push(index);
          return "dropped";
        }
        command(converted.name, converted.positional, converted.named);
        swallowStop = converted.swallowStop === true;
        return "mapped";
      }
      rawEntities = false;
    }
    const v = (key: string, def: string) => (pm[key] === undefined || pm[key] === "" ? def : pm[key]!);

    switch (c.name) {
      // 新形式では不要になるもの
      case "tb_start_text":
      case "_tb_end_text":
        flushLine();
        if (c.name === "tb_start_text") blank();
        return "dropped";
      case "tb_start_tyrano_code":
      case "_tb_end_tyrano_code":
      case "_tb_system_call":
      case "preload":
        return "dropped";

      case "label": {
        flushLine();
        forgetShown();
        const name = pm.label_name ?? "";
        blank();
        if (macro) {
          report("error", "macro-label", `マクロの中のラベル *${name} へは飛べません（@define の中にはラベルを置けない）。マクロの外に出してください`);
          emit(`// TODO ks: *${name}`);
          return "manual";
        }
        if (!NAME_PATTERN.test(name)) {
          report("error", "bad-label-name", `ラベル名 *${name} は .lim のラベルにできません`);
          emit(`// TODO ks: *${name}`);
          return "manual";
        }
        emit(`# ${name}`);
        return "mapped";
      }

      case "cm":
      case "er":
      case "ct":
        // どれもメッセージ枠の文字を消し、[font] の装飾を戻す。
        resetFont();
        command("clear", []);
        return "mapped";

      case "bg":
        command("bg", [str(v("storage", ""))], [
          ["time", ms(v("time", "3000")), "0ms"],
          ["method", v("method", "crossfade"), "crossfade"],
          ["cross", bool(v("cross", "false")), "false"],
          ["wait", bool(v("wait", "true")), "true"],
        ]);
        return "mapped";

      case "chara_new":
      case "chara_face":
        // 定義は取り込みが全ファイルから集めて cast.json に書く。
        return "dropped";

      case "chara_config": {
        const applied = applyCharaConfig(charaConfig, pm);
        charaConfig = applied.config;
        if (applied.lossy.length > 0) report("warning", "lossy-param", `[chara_config] の ${applied.lossy.join(" ")} は変換していません`);
        const sprite = spriteConfigArgs(pm);
        if (sprite.length === 0) return "dropped";
        command("chara-config", sprite);
        return "mapped";
      }

      case "fuki_start":
      case "tb_fuki_start":
        command("balloon", ["on"]);
        return "mapped";

      case "fuki_stop":
      case "tb_fuki_stop":
        command("balloon", ["off"]);
        return "mapped";

      case "chara_show": {
        const name = v("name", "");
        const face = pm.face ?? "";
        if (!charaDefined(c.name, name, face)) return "manual";
        const t = track(name);
        let variant = t.storage;
        if (face !== "") variant = face;
        else if (pm.storage) variant = variantFor(name, pm.storage);
        lossy(c.name, pm, [
          ["layer", "0"],
          ["page", "fore"],
          ["depth", "front"],
          ["width", String(charas.charas.get(name)?.width ?? "")],
          ["height", String(charas.charas.get(name)?.height ?? "")],
        ]);
        // pos_mode なら left のないものは自動配置（top があれば上端だけ固定）。それ以外は left / top（無ければ 0）。
        const auto = charaConfig.posMode && !pm.left;
        const position: SpritePosition = auto
          ? pm.top
            ? { at: AUTO_POSITION, y: coordinate(pm.top) }
            : { at: AUTO_POSITION }
          : { at: "", x: coordinate(pm.left || "0"), y: coordinate(pm.top || "0") };
        // TyranoScript では表示中なら何もしないので if-hidden=true（消したばかりと分かっているときは書かない）。
        const wasShown = t.shown;
        const reflect = pm.reflect ? pm.reflect === "true" : t.reflect;
        if (wasShown !== true) {
          if (auto) warnMixedPositions(name);
          if (face === "" && pm.storage) t.storage = variant;
          t.reflect = reflect;
          t.shown = true;
          t.position = position;
          t.current = { appearance: DEFAULT_APPEARANCE, variant };
        }
        cast.add(name);
        command("chara", [str(name), str(variant)], [
          ...charaAppearance(name),
          ...positionArgs(position),
          ...charaZ(pm.zindex ?? ""),
          ["flip", reflect ? "true" : "false", "false"],
          ["time", ms(v("time", "1000")), "0ms"],
          ["wait", pm.wait === "false" ? "false" : "true", "false"],
          ["if-hidden", wasShown === false ? "false" : "true", "false"],
        ]);
        return "mapped";
      }

      case "chara_mod": {
        const name = v("name", "");
        const face = pm.face ?? "";
        if (!charaDefined(c.name, name, face)) return "manual";
        const t = track(name);
        // @chara は出ている人物の今の値を保つので、出ていて同じ値だと分かっているものだけ省く
        const known = t.shown === true;
        const before = { appearance: t.current?.appearance, position: t.position, reflect: t.reflect };
        const variant = face !== "" ? face : pm.storage ? variantFor(name, pm.storage) : null;
        if (variant !== null) t.storage = variant;
        if (pm.reflect) t.reflect = pm.reflect === "true";
        if (t.shown === false) {
          report("warning", "chara-mod-hidden", `${name} は表示されていないため、[chara_mod] は次に出すときの表情・反転を変えるだけです（命令は書き出していません）`);
          return "dropped";
        }
        if (variant === null && !pm.reflect) return "dropped";
        if (variant !== null && t.current?.tatie) {
          report("warning", "chara-mod-on-tatie", `TyranoScript では [tatie] で出した ${name} の枠（位置・大きさ）のまま画像だけが替わりますが、.lim では差分 ${variant} の枠で出します`);
        }
        // 差分はいつも書く（.ks の表情の記憶と .lim の状態を合わせるため）
        const shown = variant !== null ? { appearance: DEFAULT_APPEARANCE, variant } : (t.current ?? { appearance: DEFAULT_APPEARANCE, variant: t.storage });
        const position = t.position ?? unknownPosition(name);
        t.shown = true;
        t.position = position;
        t.current = shown;
        cast.add(name);
        command("chara", [str(name), str(shown.variant)], [
          ...(known && before.appearance === shown.appearance ? [] : [["appearance", str(shown.appearance), null] as Named]),
          ...(known && before.position === position ? [] : positionArgs(position, true)),
          ["flip", t.reflect ? "true" : "false", known && before.reflect === t.reflect ? (t.reflect ? "true" : "false") : null],
          ["cross", pm.cross === "false" ? "false" : "true", "true"],
          ["time", ms(pm.time || charaConfig.time), "0ms"],
          ["wait", pm.wait === "false" ? "false" : "true", "false"],
        ]);
        return "mapped";
      }

      case "tatie":
        return tatie(c);

      case "chara_hide": {
        const name = v("name", "");
        const t = track(name);
        if (t.shown !== false && !charaConfig.memory) t.storage = "default";
        lossy(c.name, pm, [
          ["layer", "0"],
          ["page", "fore"],
        ]);
        // .lim の自動配置は auto の立ち絵だけを並べ直すので、このファイルで auto に置いた立ち絵がなければ差は出ない。
        const anyAuto = [...tracks.values()].some((other) => other.position?.at === AUTO_POSITION);
        if (charaConfig.posMode && pm.pos_mode === "false" && anyAuto) {
          report("warning", "lossy-param", "[chara_hide] の pos_mode=false（残りの立ち絵を並べ直さない）は変換していません");
        }
        t.shown = false;
        t.position = null;
        t.current = null;
        if (charaConfig.posMode && pm.pos_mode !== "false") warnMixedPositions(name);
        cast.add(name);
        command("chara-hide", [str(name)], [
          ["time", ms(v("time", "1000")), "0ms"],
          ["wait", bool(v("wait", "true")), "false"],
        ]);
        return "mapped";
      }

      case "chara_hide_all":
        lossy(c.name, pm, [
          ["layer", "0"],
          ["page", "fore"],
        ]);
        // 定義済みのキャラクターはすべて消えている。
        for (const name of charas.charas.keys()) track(name);
        for (const t of tracks.values()) {
          if (t.shown !== false && !charaConfig.memory) t.storage = "default";
          t.shown = false;
          t.position = null;
          t.current = null;
        }
        command("chara-hide-all", [], [
          ["time", ms(v("time", "1000")), "0ms"],
          ["wait", bool(v("wait", "true")), "false"],
        ]);
        return "mapped";

      case "mask": {
        const method = maskMethod(v("effect", "fadeIn"), "In");
        if (method === null) report("warning", "lossy-param", `mask の effect=${pm.effect} は変換していません（${MASK_METHODS_NOTE}）`);
        if (pm.graphic) report("warning", "lossy-param", `mask の graphic=${pm.graphic} は変換していません（色で覆います）`);
        command("mask", [], [
          ["color", color(v("color", "0x000000")), "#000000"],
          ["time", ms(v("time", "1000")), "0ms"],
          ["method", method ?? "crossfade", "crossfade"],
        ]);
        return "mapped";
      }

      case "mask_off": {
        const method = maskMethod(v("effect", "fadeOut"), "Out");
        if (method === null) report("warning", "lossy-param", `mask_off の effect=${pm.effect} は変換していません（${MASK_METHODS_NOTE}）`);
        command("mask-off", [], [
          ["time", ms(v("time", "1000")), "0ms"],
          ["method", method ?? "crossfade", "crossfade"],
        ]);
        return "mapped";
      }

      case "tb_show_message_window":
        command("window", ["show"]);
        return "mapped";
      case "tb_hide_message_window":
        command("window", ["hide"]);
        return "mapped";

      case "tb_eval":
      case "eval": {
        const sets = convertJsAssignments(pm.exp ?? "", macro?.names);
        if (sets === null) return script(pm.exp ?? "", c);
        if (lineBuf !== "") report("warning", "mid-line-command", "行の途中にあった代入を、その行の前に移しました");
        for (const line of sets) emit(line);
        return "mapped";
      }

      // ボイスの自動再生。TyranoScript は [voconfig] で設定し [vostart] で鳴らし始め、[vostop] で止める（番号は保つ）。
      // 話者は [chara_new] の name で指すので、名前欄の名前（jname）にする。ファイルは効果音のフォルダ（sound）から探す。
      case "voconfig": {
        const name = v("name", "");
        const pattern = v("vostorage", "");
        if (name === "" || pattern === "") {
          report("error", "manual-voice", "name か vostorage のない [voconfig] は変換していません");
          return "manual";
        }
        const who = speakerName(name, charas);
        if (pm.sebuf !== undefined) report("warning", "lossy-param", `[voconfig] の sebuf=${pm.sebuf} は変換していません（ボイスは専用の一本で鳴らします）`);
        command("voice-auto", [/^[^\s"=]+$/.test(who) ? who : str(who)], [
          ["pattern", str(pattern.replace(/\{number\}/g, "{n}")), null],
          ["next", v("number", "0"), null],
          ["folder", "sound", "voice"],
          ["start", "false", "true"],
        ]);
        return "mapped";
      }
      case "vostart":
        command("voice-auto", []);
        return "mapped";
      case "vostop":
        command("voice-auto-off", []);
        return "mapped";

      case "tb_cg":
        if (!pm.storage) {
          report("error", "manual-cg", "storage のない tb_cg（id だけ）は変換していません");
          return "manual";
        }
        command("cg-unlock", [str(pm.storage)]);
        return "mapped";

      case "jump":
      case "call": {
        flushLine();
        if (c.name === "call" && options.skipCalls?.has(normalizeStorage(pm.storage ?? ""))) {
          // system/ 下やプラグインの .ks は本文として取り込まない（中のマクロは @define に集めてある）。
          report("info", "skipped-call", `[call storage=${pm.storage}] は取り込まないファイルなので書き出しません（中のマクロは @define にしてあります）`);
          return "dropped";
        }
        if (c.name === "call") forgetShown();
        const target = targetOf(pm.storage ?? "", pm.target ?? "");
        if (target === null) {
          emit(`// TODO ks: [${c.name} storage=${pm.storage ?? ""} target=${pm.target ?? ""}]`);
          report("error", "manual-target", `[${c.name}] の飛び先を変換できません: storage=${pm.storage} target=${pm.target}`);
          return "manual";
        }
        command(c.name, [target]);
        return "mapped";
      }

      case "return":
        command("return", []);
        return "mapped";

      case "wait":
        command("wait", [ms(v("time", "0"))]);
        return "mapped";

      case "stopbgm":
        command("stop-bgm", [], [["time", v("fadeout", "false") === "true" ? ms(v("time", "2000")) : "0ms", "0ms"]]);
        return "mapped";

      case "playbgm":
      case "fadeinbgm": {
        const fadein = c.name === "fadeinbgm" || v("fadein", "false") === "true";
        if (v("buf", "0") !== "0") report("warning", "lossy-param", `playbgm の buf=${pm.buf} は変換していません`);
        command("bgm", [str(v("storage", ""))], [
          ["volume", v("volume", "100"), "100"],
          ["time", fadein ? ms(v("time", "2000")) : "0ms", "0ms"],
          ["loop", bool(v("loop", "true")), "true"],
        ]);
        return "mapped";
      }

      case "playse":
        command("se", [str(v("storage", ""))], [
          ["channel", v("buf", "0"), "0"],
          ["volume", v("volume", "100"), "100"],
          ["time", v("fadein", "false") === "true" ? ms(v("time", "2000")) : "0ms", "0ms"],
          ["loop", bool(v("loop", "false")), "false"],
        ]);
        return "mapped";

      case "stopse":
      case "fadeoutse": {
        const fadeout = c.name === "fadeoutse" || v("fadeout", "false") === "true";
        command("stop-se", [], [
          ["channel", v("buf", "0"), "0"],
          ["time", fadeout ? ms(v("time", "2000")) : "0ms", "0ms"],
        ]);
        return "mapped";
      }

      case "quake":
        command("quake", [], [
          ["time", ms(v("time", "300")), "300ms"],
          ["count", v("count", "5"), "5"],
          ["horizontal", v("hmax", "0"), "0"],
          ["vertical", v("vmax", "10"), "10"],
          ["wait", bool(v("wait", "true")), "true"],
        ]);
        return "mapped";

      case "camera":
      case "reset_camera": {
        if (v("layer", "layer_camera") !== "layer_camera") report("warning", "lossy-param", `${c.name} の layer=${pm.layer} は変換していません`);
        // TyranoScript は x だけ符号を反転して中身を動かす。新形式は x・y ともカメラ自体の位置なので y の符号を反転する。
        const negate = (value: string) => String(-Number(value));
        const optional = (key: string, as: string, flip = false): [string, string, string | null] => [as, pm[key] ? (flip ? negate(pm[key]!) : pm[key]!) : "", ""];
        // TyranoScript は from_* を一つでも指定すると、指定しなかった開始値を現在値ではなく 0（倍率は 1）にする。
        const hasFrom = ["from_x", "from_y", "from_zoom", "from_rotate"].some((k) => pm[k]);
        const from = (key: string, as: string, def: string, flip = false): [string, string, string | null] => [
          as,
          pm[key] ? (flip ? negate(pm[key]!) : pm[key]!) : hasFrom ? def : "",
          "",
        ];
        command(c.name === "camera" ? "camera" : "reset-camera", [], [
          ...(c.name === "camera"
            ? [
                optional("zoom", "zoom"),
                optional("x", "x"),
                optional("y", "y", true),
                optional("rotate", "rotate"),
                from("from_zoom", "from-zoom", "1"),
                from("from_x", "from-x", "0"),
                from("from_y", "from-y", "0", true),
                from("from_rotate", "from-rotate", "0"),
              ]
            : []),
          ["time", ms(v("time", "1000")), "1s"],
          ["ease", v("ease_type", "ease"), "ease"],
          ["wait", bool(v("wait", "true")), "true"],
        ]);
        return "mapped";
      }

      case "delay": {
        if (!pm.speed) {
          command("text-speed-reset", []);
          return "mapped";
        }
        // 同じ行の [p] より前で [resetdelay] されるなら、その範囲だけの {speed …} にする。
        let closesOnLine = false;
        for (let j = index + 1; j < commands.length; j++) {
          const n = commands[j]!;
          if (n.line !== c.line || n.name === "p") break;
          if (n.name === "resetdelay") {
            closesOnLine = true;
            break;
          }
        }
        if (closesOnLine && !speedOpen) {
          closeDeco();
          appendInline(`{speed ${ms(pm.speed)} `);
          speedOpen = true;
          return "mapped";
        }
        textSpeed = ms(pm.speed);
        command("text-speed", [textSpeed]);
        return "mapped";
      }
      case "resetdelay":
        if (speedOpen) {
          closeDeco();
          appendInline("}");
          speedOpen = false;
          return "mapped";
        }
        textSpeed = null;
        command("text-speed-reset", []);
        return "mapped";

      case "glink": {
        const target = targetOf(pm.storage ?? "", pm.target ?? "");
        if (pm.exp) report("error", "manual-glink-exp", `[glink] の exp は変換していません: ${pm.exp}`);
        if (target === null) {
          report("error", "manual-target", `[glink] の飛び先を変換できません: storage=${pm.storage} target=${pm.target}`);
          return "manual";
        }
        // [p] で終わっていない本文（問いかけ）は、クリックを待たずに選択肢を出す
        flushLine(false, undefined, true);
        choice.push({ text: escapeText(pm.text ?? ""), line: target, args: withCondition(optionCond, ""), origin: { ...here, kind: "option" } });
        return pm.exp ? "manual" : "mapped";
      }

      case "s":
        if (choice.length > 0 && lineBuf !== "") {
          // [link] の前の本文（問いかけ）は一行にする。行末の改行（[r]）は、書き戻しで .ks に戻せるように {br} のまま残す
          // （.lim では選択肢はメッセージ枠の外に出るので、行末の改行は見た目を変えない）。改行だけの本文は書き出さない。
          closeDeco();
          // 選択肢のあいだの改行（[endlink][r]）は選択肢の並べ方なので落とす
          const q = Math.min(questionEnd ?? lineBuf.length, lineBuf.length);
          lineBuf = lineBuf.slice(0, q) + lineBuf.slice(q).replace(/(\{br\})+$/, "");
          questionEnd = null;
          if (lineBuf.replace(/(\{br\})+$/, "").replace(/[ \t]/g, "") !== "") {
            // 問いかけは行の最後に {noclick} を付け、クリックを待たずに選択肢を出す（TyranoScript と同じ）。
            // 対応表の本文の範囲は、最初の選択肢の前の行まで（選択肢の行は選択肢のもの）
            flushLine(true, Math.min(currentLine, choice[0]!.origin.from - 1), true);
          } else {
            lineBuf = "";
          }
        }
        questionEnd = null;
        // [p] で終わっていない本文のあとの [s] も、クリックを待たずに止める（本文は出したまま）
        flushLine(false, undefined, true);
        if (choice.length === 1 && editPending > 0) {
          // [edit] の入力欄と決定のボタン一つは、@text-input（決定まで待つ）と飛び先への @jump にする。
          emit(`@jump ${choice[0]!.line}`);
          choice = [];
        } else if (choice.length > 0) {
          if (editPending > 0) report("warning", "edit-before-choice", "[edit] の入力は選択肢を出す前に決定させます");
          flushChoice();
        } else {
          command("stop", []);
        }
        editPending = 0;
        return "mapped";

      case "if":
      case "elsif": {
        if (c.name === "elsif" && openBlocks.at(-1) !== "if") return orphan("elsif", "if");
        if (c.name === "if") openBlocks.push("if");
        flushLine();
        forgetShown();
        const expr = convertJsExpression(pm.exp ?? "", macro?.names);
        if (c.name === "elsif") depth--;
        if (expr === null) {
          report("error", "manual-expression", `[${c.name}] の式を変換できません: ${pm.exp}`);
          // ブロックの構造を保つため条件は false にして、元の式をコメントに残す。
          emit(`@${c.name === "if" ? "if" : "elif"} false`);
          emit(`  // TODO ks: [${c.name} exp=${pm.exp}]`);
        } else {
          emit(`@${c.name === "if" ? "if" : "elif"} ${expr}`);
        }
        depth++;
        return expr === null ? "manual" : "mapped";
      }
      case "else":
        if (openBlocks.at(-1) !== "if") return orphan("else", "if");
        flushLine();
        forgetShown();
        depth--;
        emit("@else");
        depth++;
        return "mapped";
      case "endif":
        if (openBlocks.at(-1) !== "if") return orphan("endif", "if");
        openBlocks.pop();
        flushLine();
        forgetShown();
        depth--;
        emit("@end");
        return "mapped";

      case "iscript":
        return script(commands[index]!.body ?? "", c);
      case "endscript":
        return "dropped";

      // ---- 選択肢の部品（[s] で @choice になる）----
      case "button": {
        if (pm.role) return unsupportedButton(pm);
        if (v("fix", "false") !== "false") return fixButton(pm);
        const target = targetOf(pm.storage ?? "", pm.target ?? "");
        if (pm.exp) report("error", "manual-glink-exp", `[button] の exp は変換していません: ${pm.exp}`);
        if (target === null) {
          report("error", "manual-target", `[button] の飛び先を変換できません: storage=${unmark(pm.storage ?? "")} target=${unmark(pm.target ?? "")}`);
          return "manual";
        }
        if (v("folder", "image") !== "image") report("warning", "lossy-param", `[button] の folder=${pm.folder} は変換していません（画像は image/ から探します）`);
        const lossy = ["activeimg", "clickimg", "clickse", "enterse", "leavese", "autoimg", "skipimg", "preexp", "savesnap"].filter((k) => pm[k]);
        if (lossy.length > 0) report("warning", "lossy-param", `[button] の ${lossy.join("・")} は変換していません`);
        const args = optionArgs([
          ["image", pm.graphic],
          ["hover", pm.enterimg],
          ["x", pm.x || locate.x],
          ["y", pm.y || locate.y],
          ["width", pm.width],
          ["height", pm.height],
        ]);
        flushLine(false, undefined, true);
        choice.push({ text: escapeText(pm.hint ?? ""), line: target, args: withCondition(optionCond, args), origin: { ...here, kind: "option" } });
        return pm.exp ? "manual" : "mapped";
      }
      case "clickable": {
        const target = targetOf(pm.storage ?? "", pm.target ?? "");
        if (target === null) {
          report("error", "manual-target", `[clickable] の飛び先を変換できません: storage=${unmark(pm.storage ?? "")} target=${unmark(pm.target ?? "")}`);
          return "manual";
        }
        const lossy = ["color", "opacity", "mouseopacity", "border"].filter((k) => pm[k]);
        if (lossy.length > 0) report("warning", "lossy-param", `[clickable] の ${lossy.join("・")} は変換していません（押せる範囲は見えない四角になります）`);
        flushLine(false, undefined, true);
        choice.push({
          text: "",
          line: target,
          origin: { ...here, kind: "option" },
          args: withCondition(
            optionCond,
            optionArgs([
              ["x", pm.x || locate.x],
              ["y", pm.y || locate.y],
              ["width", pm.width],
              ["height", pm.height],
            ]),
          ),
        });
        return "mapped";
      }
      case "locate":
        if (pm.x !== undefined) locate.x = pm.x;
        if (pm.y !== undefined) locate.y = pm.y;
        return "dropped";
      case "edit": {
        const variable = convertJsExpression(pm.name ?? "", macro?.names);
        if (variable === null || !VARIABLE_PATH.test(variable)) {
          report("error", "manual-variable", `[edit] の name を変数にできません: ${pm.name}`);
          return "manual";
        }
        const lossy = ["left", "top", "width", "height", "size", "color", "face", "length", "autocomplete"].filter((k) => pm[k]);
        if (lossy.length > 0) report("warning", "lossy-param", `[edit] の ${lossy.join("・")} は変換していません（入力欄は既定の枠で出ます）`);
        flushLine();
        command("text-input", [variable], [
          ["initial", pm.initial ? str(pm.initial) : '""', '""'],
          ["placeholder", pm.placeholder ? str(pm.placeholder) : '""', '""'],
          ["max", v("maxchars", "1000"), "1000"],
        ]);
        editPending++;
        return "mapped";
      }
      case "commit":
        // 入力は @text-input で決定したときに変数に入っている。
        return "dropped";

      // ---- 確認の枠・入力 ----
      case "dialog": {
        const type = v("type", "alert");
        const ok = pm.storage || pm.target ? targetOf(pm.storage ?? "", pm.target ?? "") : "";
        const cancel = pm.storage_cancel || pm.target_cancel ? targetOf(pm.storage_cancel ?? "", pm.target_cancel ?? "") : "";
        if (ok === null || cancel === null) {
          report("error", "manual-target", "[dialog] の飛び先を変換できません");
          return "manual";
        }
        let variable = "";
        if (type === "input") {
          variable = convertJsExpression(v("name", "tf.dialog_value"), macro?.names) ?? "";
          if (!VARIABLE_PATH.test(variable)) {
            report("error", "manual-variable", `[dialog] の name を変数にできません: ${pm.name}`);
            return "manual";
          }
        }
        flushLine();
        command("dialog", [str(v("text", ""))], [
          ["type", type, "alert"],
          ["ok-label", str(v("label_ok", "OK")), "OK"],
          ["cancel-label", str(v("label_cancel", "Cancel")), "Cancel"],
          ["target", ok, ""],
          ["cancel-target", cancel, ""],
          ["variable", variable, ""],
        ]);
        return "mapped";
      }
      case "hidemessage":
        command("peek", []);
        return "mapped";

      // ---- システム画面への要求 ----
      case "skipstart":
      case "skipstop":
      case "cancelskip":
        command("skip", [c.name === "skipstart" ? "start" : "stop"]);
        return "mapped";
      case "autostart":
      case "autostop":
        command("auto", [c.name === "autostart" ? "start" : "stop"]);
        return "mapped";
      case "showsave":
      case "showload":
      case "showlog":
      case "showmenu":
        flushLine();
        command("open-screen", [{ showsave: "save", showload: "load", showlog: "log", showmenu: "menu" }[c.name]!]);
        return "mapped";
      case "position": {
        // 縦書き（vertical）だけを @vertical にする。枠の位置・大きさ・見た目は取り込まない（liminalia.json の ui.message で決める）
        if (pm.vertical !== "true" && pm.vertical !== "false") return unsupported("position");
        command("vertical", [pm.vertical === "true" ? "on" : "off"]);
        const rest = Object.keys(pm).filter((k) => !["vertical", "layer", "page"].includes(k));
        if (rest.length > 0) report("warning", "unsupported-tag", `[position] の ${rest.join("・")} は取り込みません: ${UNSUPPORTED.position!.reason}`);
        return "mapped";
      }
      case "showmenubutton":
      case "hidemenubutton":
        command("menu-button", [c.name === "showmenubutton" ? "show" : "hide"]);
        return "mapped";
      case "start_keyconfig":
      case "stop_keyconfig":
        command("shortcuts", [c.name === "start_keyconfig" ? "on" : "off"]);
        return "mapped";
      case "tb_keyconfig":
        command("shortcuts", [pm.flag === "1" ? "on" : "off"]);
        return "mapped";
      case "autosave":
        flushLine();
        if (pm.title) report("warning", "lossy-param", `[autosave] の title=${pm.title} は変換していません（題名はシステム画面が付けます）`);
        command("autosave", []);
        return "mapped";
      case "autoload":
        flushLine();
        command("autoload", []);
        return "mapped";
      case "nolog":
      case "endnolog":
        command("backlog", [c.name === "nolog" ? "off" : "on"]);
        return "mapped";
      case "pushlog":
        command("backlog-add", [str(v("text", ""))], [["join", bool(v("join", "false")), "false"]]);
        return "mapped";
      case "screen_full":
        command("fullscreen", []);
        return "mapped";
      case "close":
        flushLine();
        command("quit", [], [["ask", bool(v("ask", "true")), "true"]]);
        return "mapped";
      case "title":
        command("window-title", [str(v("name", ""))]);
        return "mapped";
      case "web":
        command("open-url", [str(v("url", ""))]);
        return "mapped";
      case "configdelay":
        if (!pm.speed) return "dropped";
        command("config", [], [["text-speed", ms(pm.speed), null]]);
        return "mapped";
      case "autoconfig":
        if (!pm.speed && !pm.clickstop) return "dropped";
        command("config", [], [
          ["auto-wait", pm.speed ? ms(pm.speed) : "", ""],
          ["auto-click-stop", pm.clickstop ? bool(pm.clickstop) : "", ""],
        ]);
        return "mapped";

      // ---- 音 ----
      case "fadeoutbgm":
        command("stop-bgm", [], [["time", ms(String(Math.max(100, Number(v("time", "2000"))))), "0ms"]]);
        return "mapped";
      case "fadeinse":
        command("se", [str(v("storage", ""))], [
          ["channel", v("buf", "0"), "0"],
          ["volume", v("volume", "100"), "100"],
          ["time", ms(String(Math.max(100, Number(v("time", "2000"))))), "0ms"],
          ["loop", bool(v("loop", "false")), "false"],
        ]);
        return "mapped";
      case "xchgbgm":
        // 鳴っている BGM を消しながら次の BGM を出す。@bgm の time は前の BGM も同じ時間で消す。
        command("bgm", [str(v("storage", ""))], [
          ["volume", v("volume", "100"), "100"],
          ["time", Number(v("time", "2000")) === 0 ? "0ms" : ms(String(Math.max(100, Number(v("time", "2000"))))), "0ms"],
          ["loop", bool(v("loop", "true")), "true"],
        ]);
        return "mapped";
      case "pausebgm":
      case "resumebgm":
        command(c.name === "pausebgm" ? "pause-bgm" : "resume-bgm", []);
        return "mapped";
      case "pausese":
      case "resumese":
        command(c.name === "pausese" ? "pause-se" : "resume-se", [], [["channel", pm.buf ?? "", ""]]);
        return "mapped";
      case "changevol": {
        if (!pm.volume) return "dropped";
        const se = v("target", "bgm") !== "bgm";
        command(se ? "se-volume" : "bgm-volume", [pm.volume], [
          ...(se ? [["channel", pm.buf ?? "", ""] as [string, string, string]] : []),
          ["time", pm.time ? ms(pm.time) : "0ms", "0ms"],
        ]);
        return "mapped";
      }
      case "bgmopt":
      case "seopt": {
        const se = c.name === "seopt";
        if (pm.volume) command("config", [], [[se ? "se-volume" : "bgm-volume", pm.volume, null]]);
        if (pm.tag_volume) {
          command(se ? "se-volume" : "bgm-volume", [pm.tag_volume], [
            ...(se ? [["channel", pm.buf ?? "", ""] as [string, string, string]] : []),
            ["time", pm.time ? ms(pm.time) : "0ms", "0ms"],
          ]);
        }
        const lossy = ["effect", "samebgm_restart", ...(se ? [] : ["buf"])].filter((k) => pm[k]);
        if (lossy.length > 0) report("warning", "lossy-param", `[${c.name}] の ${lossy.join("・")} は変換していません`);
        return pm.volume || pm.tag_volume ? "mapped" : "dropped";
      }
      case "wbgm":
        command("wait-bgm", []);
        return "mapped";
      case "wse":
        command("wait-se", []);
        return "mapped";

      // ---- 変数と実行の状態 ----
      case "clearvar": {
        if (!pm.exp) {
          command("clear-vars", ["all"]);
          return "mapped";
        }
        const target = convertJsExpression(pm.exp, macro?.names);
        if (target === null || !VARIABLE_PATH.test(target)) {
          report("error", "manual-variable", `[clearvar] の exp を変数にできません: ${pm.exp}`);
          return "manual";
        }
        emit(`@set ${target} = null`);
        return "mapped";
      }
      case "clearsysvar":
        command("clear-vars", ["system"]);
        return "mapped";
      case "clearstack": {
        const stack = v("stack", "");
        if (stack === "" || stack === "call" || stack === "macro") {
          command("clear-stack", []);
          return "mapped";
        }
        return "dropped";
      }
      case "sleepgame": {
        flushLine();
        const target = targetOf(pm.storage ?? "", pm.target ?? "");
        if (target === null) {
          report("error", "manual-target", `[sleepgame] の行き先を変換できません: storage=${unmark(pm.storage ?? "")} target=${unmark(pm.target ?? "")}`);
          return "manual";
        }
        command("sleep-game", [target]);
        return "mapped";
      }
      case "awakegame":
        flushLine();
        if (v("sound_opt_over", "true") !== "true") report("warning", "lossy-param", "[awakegame] の sound_opt_over は変換していません");
        command("awake-game", [], [
          ["keep-variables", bool(v("variable_over", "true")), "true"],
          ["keep-bgm", bool(v("bgm_over", "true")), "true"],
        ]);
        return "mapped";
      case "breakgame":
        command("break-game", []);
        return "mapped";
      case "checkpoint":
        command("checkpoint", [str(v("name", ""))]);
        return "mapped";
      case "rollback":
        flushLine();
        command("rollback", [str(v("checkpoint", ""))], [
          ["keep-variables", bool(v("variable_over", "true")), "true"],
          ["keep-bgm", bool(v("bgm_over", "false")), "false"],
        ]);
        return "mapped";
      case "clear_checkpoint":
        command("clear-checkpoint", [], [["name", pm.name ? str(pm.name) : "", ""]]);
        return "mapped";

      // ---- マクロ・条件 ----
      case "ignore": {
        flushLine();
        const expr = convertJsExpression(pm.exp ?? "", macro?.names);
        if (expr === null) {
          report("error", "manual-expression", `[ignore] の式を変換できません: ${pm.exp}`);
          emit("@if false");
          emit(`  // TODO ks: [ignore exp=${pm.exp}]`);
        } else {
          emit(`@if !(${expr})`);
        }
        openBlocks.push("ignore");
        depth++;
        return expr === null ? "manual" : "mapped";
      }
      case "endignore":
        if (openBlocks.at(-1) !== "ignore") return orphan("endignore", "ignore");
        openBlocks.pop();
        flushLine();
        depth--;
        emit("@end");
        return "mapped";
      case "plugin":
        // プラグインの init.ks のマクロは @define に集めてある。JS は取り込みの報告に出す。
        return "dropped";
      case "endmacro":
      case "endhtml":
        return "dropped";

      // ---- TyranoBuilder のマクロ ----
      case "tb_ptext_show": {
        // [mtext]（anim=true）か [ptext] を layer=2 に出すマクロ。
        const anim = pm.anim === "true";
        const keys = ["text", "x", "y", "size", "face", "color", "name", "bold", "time", "edge", "shadow", ...(anim ? ["fadeout", "wait", "in_effect", "out_effect"] : [])];
        const expanded: Params = { layer: "2" };
        for (const k of keys) if (pm[k] !== undefined) expanded[k] = pm[k]!;
        return convertCommand({ ...c, name: anim ? "mtext" : "ptext", pm: expanded }, index);
      }
      case "clearfix":
        // [button fix=true] のボタンを外す（name を書けばその名前だけ）
        flushLine();
        command("hud-button-off", pm.name ? [str(unmark(pm.name))] : []);
        return "mapped";
      case "tb_ptext_hide":
        return convertCommand({ ...c, name: "freeimage", pm: { layer: "2", ...(pm.time !== undefined ? { time: pm.time } : {}) } }, index);
      case "tb_replay":
        // 回想を見られるようにし、回想として来ていれば（@sleep-game の途中なら）元に戻る。
        flushLine();
        command("replay-unlock", [str(v("id", ""))]);
        command("awake-game", []);
        return "mapped";

      default: {
        if (c.name in UNSUPPORTED) return unsupported(c.name);
        const signature = options.macros?.get(c.name);
        if (signature) return macroCall(c, signature);
        return generic(c);
      }
    }
  }

  /** role 付きの [button]（システムのボタン）。 */
  function unsupportedButton(pm: Params): Outcome {
    report("error", "unsupported-tag", `[button] の role=${pm.role} のボタンは取り込みません: システムの機能のボタンはシステム画面（ui.menuBar かプラグインの system）で作ります`);
    return "manual";
  }

  /** fix=true の [button]（遊んでいるあいだ出ていて、押すと [call] するボタン）は @hud-button。[clearfix] は @hud-button-off。 */
  function fixButton(pm: Params): Outcome {
    const target = targetOf(pm.storage ?? "", pm.target ?? "");
    if (target === null) {
      report("error", "manual-target", `[button fix=true] の飛び先を変換できません: storage=${unmark(pm.storage ?? "")} target=${unmark(pm.target ?? "")}`);
      return "manual";
    }
    // 名前が無ければ画像の名前（[clearfix name=] は name で外すので、名前のあるものはそのまま）
    const name = pm.name ? unmark(pm.name) : (pm.graphic ? unmark(pm.graphic) : "button").replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "") || "button";
    const lossy = ["activeimg", "clickimg", "clickse", "enterse", "leavese", "autoimg", "skipimg", "exp", "preexp", "savesnap", "folder", "auto_next"].filter((k) => pm[k]);
    if (lossy.length > 0) report("warning", "lossy-param", `[button fix=true] の ${lossy.join("・")} は変換していません`);
    flushLine();
    // cond= は置くときに一度だけ見る（TyranoScript と同じ）。偽なら置かない
    if (optionCond !== null) {
      emit(`@if ${optionCond}`);
      depth++;
    }
    command("hud-button", [str(name)], [
      ["image", pm.graphic ? str(pm.graphic) : "", ""],
      ["hover", pm.enterimg ? str(pm.enterimg) : "", ""],
      ["label", pm.hint ? str(pm.hint) : "", ""],
      ["x", pm.x || locate.x ? numberValue(pm.x || locate.x!) : "0", "0"],
      ["y", pm.y || locate.y ? numberValue(pm.y || locate.y!) : "0", "0"],
      ["width", pm.width ? numberValue(pm.width) : "", ""],
      ["height", pm.height ? numberValue(pm.height) : "", ""],
      ["call", target, null],
    ]);
    if (optionCond !== null) {
      depth--;
      emit("@end");
    }
    return "mapped";
  }

  /** 選択肢のタグの cond を、選択肢の行の if= の式にする。変換できなければ報告して null（条件なしで出す）。 */
  function optionCondition(cond: string | undefined, tag: string): string | null {
    if (!cond) return null;
    const expr = convertJsExpression(cond, macro?.names);
    if (expr === null) report("error", "manual-cond", `[${tag}] の cond の式を変換できません: ${cond}`);
    return expr;
  }

  /** 選択肢の行の引数（見た目）の前に、出す条件 if=(式) を足す。 */
  function withCondition(expr: string | null, args: string): string {
    return [...(expr === null ? [] : [`if=(${expr})`]), ...(args === "" ? [] : [args])].join(" ");
  }

  /** 選択肢の見た目の引数。値のないものは書かない。 */
  function optionArgs(pairs: [string, string | undefined][]): string {
    return pairs
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${key === "image" || key === "hover" ? str(value!) : numberValue(value!)}`)
      .join(" ");
  }

  /** マクロ（@define）の呼び出し。引数は @define の引数の型に合わせて書く。 */
  function macroCall(c: RawCommand, signature: MacroSignature): Outcome {
    if (signature.library !== undefined && signature.library !== file.replace(/\.ks$/, "")) uses.add(signature.library);
    const named: [string, string, string | null][] = [];
    const spread = c.pm["*"] !== undefined;
    for (const [key, raw] of Object.entries(c.pm)) {
      if (key === "cond" || key === "*" || key.startsWith("_")) continue;
      const param = signature.params.get(key);
      if (!param) {
        if (!spread) report("warning", "lossy-param", `[${c.name}] の ${key}=${unmark(raw)} はマクロの中で使われていないため書き出しません`);
        continue;
      }
      named.push([param.name, typedValue(param.type, raw), param.default]);
    }
    command(signature.name, [], named);
    return "mapped";
  }

  /** JS をそのまま @script に入れる。エンジンの API に書き直すまで動かないので手作業の対象。 */
  function script(code: string, c: RawCommand): Outcome {
    flushLine();
    forgetShown();
    const replaced = options.scriptProfile?.(code);
    // [iscript] 〜 [endscript] の全体が出どころ。
    const next = c.name === "iscript" ? commands[here.tags?.at(-1) ?? -1]?.next : undefined;
    const origin: LineOrigin = next !== undefined ? { ...here, kind: "script", to: commands[next]!.line, tags: [...(here.tags ?? []), next] } : { ...here, kind: "script" };
    if (replaced) {
      for (const line of replaced) emit(line, { ...origin, kind: "command" });
      return "mapped";
    }
    const uses = [/\$\(|jQuery/.test(code) && "jQuery", /TYRANO|TG\./.test(code) && "TYRANO", /\bdocument\b|\bwindow\b/.test(code) && "DOM", /\bmp\./.test(code) && "mp"]
      .filter(Boolean)
      .join("・");
    report("error", "manual-script", `[${c.name}] の JS は書き直しが必要です${uses ? `（${uses} を使用）` : ""}`);
    blank();
    emit("@script", origin);
    for (const line of code.replace(/\n$/, "").split("\n")) emit(line.trim() === "" ? "" : `  ${line}`, origin);
    emit("@end", origin);
    blank();
    return "manual";
  }

  function generic(c: RawCommand): Outcome {
    forgetShown();
    const name = toKebab(c.name);
    const args = Object.entries(c.pm)
      .filter(([k]) => k !== "cond" && k !== "_clickable_img")
      .map(([k, value]) => `${toKebab(k)}=${genericValue(value)}`);
    command(name || "unknown", args);
    report("warning", "unmapped-tag", `[${c.name}] には対応する命令がまだないため、汎用の形で書き出しました`);
    return "generic";
  }

  // ---- 立ち絵 ----

  function track(name: string): CharaTrack {
    let t = tracks.get(name);
    if (!t) tracks.set(name, (t = { shown: null, position: null, current: null, storage: "default", reflect: charas.charas.get(name)?.reflect ?? false }));
    return t;
  }

  /** 表示しているかと、どこに何を出しているかを忘れる（表情の記憶と反転は残す）。 */
  function forgetShown(): void {
    for (const t of tracks.values()) {
      t.shown = null;
      t.position = null;
      t.current = null;
    }
  }

  /**
   * [tatie]（立ち絵プラグイン Tyrano Tatie）。既定は time=500・wait=false・cross=true・reflect=false・position=center。
   * mode=show（か show_only=true）は表示中なら何もしない。表示していなければ mode=mod でも新しく出す。
   */
  function tatie(c: RawCommand): Outcome {
    const pm = c.pm;
    const name = pm.name ?? "";
    const variant = pm.variant ?? "";
    let appearance = pm.appearance ?? "";
    let position = pm.position || "center";
    const entry = options.cast?.[name];
    if (options.cast) {
      const resolved = entry ? resolveVariant(entry, appearance, variant) : null;
      if (!entry || !resolved?.variant) {
        report("error", "undefined-tatie", entry ? `tatie の ${name} の ${resolved!.appearance} に差分 ${variant} はありません` : `tatie の設定にキャラクター ${name} がありません`);
        if (lineBuf === "") emit(`// TODO ks: [tatie name=${name} appearance=${appearance} variant=${variant}]`);
        return "manual";
      }
      // tatie は無い立ち絵セット・立ち位置を黙って既定のものにする。.lim では書けないので既定に直して知らせる。
      if (appearance !== "" && !entry.appearances[appearance]) {
        report("warning", "tatie-fallback", `${name} に立ち絵セット ${appearance} が無いため、tatie と同じく ${resolved.appearance} にしました`);
        appearance = "";
      }
      if (position !== AUTO_POSITION && !positionNames(resolved.variant).includes(position)) {
        report("warning", "tatie-fallback", `${name} の ${resolved.appearance} / ${variant} に立ち位置 ${position} が無いため、tatie と同じく center にしました`);
        position = "center";
      }
    }
    if (validateCharas && !charas.charas.has(name)) {
      report("error", "undefined-chara", `キャラクター ${name} は [chara_new] で定義されていません（[tatie] も [chara_new] の定義が要ります）`);
      if (lineBuf === "") emit(`// TODO ks: [tatie name=${name} variant=${variant}]`);
      return "manual";
    }
    lossy(c.name, pm, [
      ["layer", "0"],
      ["page", "fore"],
    ]);
    const ifHidden = pm.mode === "show" || pm.show_only === "true";
    const flip = pm.reflect === "true";
    const t = track(name);
    const resolvedAppearance = entry ? appearanceKey(entry, appearance) : appearance;
    // tatie は立ち絵セット・位置・反転を書かなければ既定に戻すが、@chara は出ている人物の今の値を保つ。
    // 消えていると分かっているか、出ていて同じ値と分かっているときだけ省き、ほかは書く
    const before = { shown: t.shown, appearance: t.current?.appearance, at: t.position?.x === undefined ? t.position?.at : undefined, reflect: t.reflect };
    // if-hidden の行は、出ていれば何もしないので、消えているときと同じに考える
    const same = <T>(now: T | undefined, value: T, fallback: T) => (before.shown === false || ifHidden ? value === fallback : before.shown === true && now === value);
    if (!(ifHidden && t.shown === true)) {
      t.shown = true;
      t.position = { at: position };
      t.current = { appearance: resolvedAppearance, variant, tatie: true };
      t.reflect = flip;
    }
    cast.add(name);
    const defaultAppearance = entry ? appearanceKey(entry) : "";
    command("chara", [str(name), str(variant)], [
      ["appearance", str(resolvedAppearance), same(before.appearance, resolvedAppearance, defaultAppearance) ? str(resolvedAppearance) : null],
      ["at", str(position), same(before.at, position, "center") ? str(position) : null],
      ["flip", flip ? "true" : "false", same(before.reflect, flip, false) ? (flip ? "true" : "false") : null],
      ["cross", pm.cross === "false" ? "false" : "true", "true"],
      ["time", ms(pm.time === undefined || pm.time === "" ? "500" : pm.time), "0ms"],
      ["wait", pm.wait && pm.wait !== "false" ? "true" : "false", "false"],
      ["if-hidden", ifHidden ? "true" : "false", "false"],
    ]);
    return "mapped";
  }

  /** .lim の位置の引数。 */
  function positionArgs(p: SpritePosition, explicit = false): Named[] {
    if (p.x !== undefined && p.y !== undefined) return [["x", p.x, null], ["y", p.y, null]];
    return [["at", p.at === "" ? "center" : p.at, explicit ? null : "center"], ["x", p.x ?? "", ""], ["y", p.y ?? "", ""]];
  }

  /** 表示中の位置が分からないとき。pos_mode なら自動配置で出したとみなす。 */
  function unknownPosition(name: string): SpritePosition {
    if (charaConfig.posMode) return { at: AUTO_POSITION };
    report("warning", "chara-position-unknown", `${name} をどこに出したか分からないため、左上（0, 0）に置きました`);
    return { at: "", x: "0", y: "0" };
  }

  /** [chara_new] の表情は立ち絵セット default にある。キャストの既定の立ち絵セットが別なら明示する。 */
  function charaAppearance(name: string): Named[] {
    const entry = options.cast?.[name];
    return entry && appearanceKey(entry) !== DEFAULT_APPEARANCE ? [["appearance", DEFAULT_APPEARANCE, null]] : [];
  }

  /** TyranoScript では未定義のキャラクター・表情はエラーで止まる。手作業の対象にして、行の外なら元のタグを残す。 */
  function charaDefined(tag: string, name: string, face: string): boolean {
    if (!validateCharas) return true;
    const def = charas.charas.get(name);
    if (def && (face === "" || def.faces[face] !== undefined)) return true;
    if (!def) report("error", "undefined-chara", `キャラクター ${name} は [chara_new] で定義されていません`);
    else report("error", "undefined-face", `${name} の表情 ${face} は [chara_new] / [chara_face] で定義されていません`);
    if (lineBuf === "") emit(`// TODO ks: [${tag} name=${name}${face ? ` face=${face}` : ""}]`);
    return false;
  }

  /**
   * storage で直接指定した画像の表情名。定義済みの表情と同じ画像ならその名前、
   * そうでなければファイル名（ほかの画像とぶつかるときは拡張子を除いたパス）にして、cast.json に足す。
   */
  function variantFor(name: string, storage: string): string {
    const faces = charas.charas.get(name)?.faces ?? {};
    for (const [face, image] of Object.entries(faces)) if (image === storage) return face;
    const own = variants.get(name) ?? new Map<string, string>();
    variants.set(name, own);
    const taken = (n: string) => (faces[n] ?? own.get(n) ?? storage) !== storage;
    const base = storage.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
    const variant = base !== "" && !taken(base) ? base : storage.replace(/\.[^.]*$/, "");
    own.set(variant, storage);
    return variant;
  }

  /** 既定値と違う、変換できない引数を報告する。 */
  function lossy(tag: string, pm: Params, defaults: [key: string, defaultValue: string][]): void {
    const given = defaults.filter(([k, def]) => (pm[k] ?? "") !== "" && pm[k] !== def).map(([k]) => `${k}=${pm[k]}`);
    if (given.length > 0) report("warning", "lossy-param", `[${tag}] の ${given.join(" ")} は変換していません`);
  }

  /**
   * [chara_show] の zindex を @chara の z= に。TyranoScript の既定の 1 は書かない（ほかの立ち絵と同じ重なりで、後から出したものが手前）。
   * .lim の z の既定は 0 なので、zindex=0（既定の立ち絵より奥）は .lim では既定の立ち絵と同じ重なりになる（報告する）。
   */
  function charaZ(value: string): Named[] {
    const v = value.trim();
    if (v === "" || v === "1") return [];
    const e = entity(v);
    if (e !== null) return [["z", `(${e})`, null]];
    if (!/^-?\d+$/.test(v)) {
      report("warning", "lossy-param", `[chara_show] の zindex=${v} は整数ではないので変換していません`);
      return [];
    }
    if (Number(v) === 0) report("warning", "chara-zindex", "zindex=0 は TyranoScript では既定（1）の立ち絵より奥ですが、.lim の z=0 は既定と同じ重なり（後から出したものが手前）です");
    return [["z", String(Number(v)), null]];
  }

  /** 位置の数値。数でなければ 0 にして報告する。 */
  function coordinate(value: string): string {
    const n = Number(value);
    if (Number.isFinite(n)) return String(n);
    report("warning", "lossy-param", `位置 ${value} は数ではないため 0 にしました`);
    return "0";
  }

  /** TyranoScript の自動配置は left / top で置いた立ち絵も並べ直すが、.lim の auto は auto どうしだけを並べる。 */
  function warnMixedPositions(except: string): void {
    const manual = [...tracks].filter(([n, t]) => n !== except && t.shown === true && t.position !== null && t.position.at !== AUTO_POSITION).map(([n]) => n);
    if (manual.length > 0) {
      report("warning", "chara-position-mixed", `TyranoScript ではここで自動配置の外に置いた ${manual.join("・")} も並べ直されますが、.lim では元の位置のままです`);
    }
  }
}

// ---- 対応表 ----

/** 書き出した行の種類（出どころが命令のとき、行の字面から決める）。 */
function lineKind(text: string): LineKind {
  const t = text.trimStart();
  if (t.startsWith("//")) return "comment";
  if (t.startsWith("# ")) return "label";
  const name = /^@([a-z][a-z0-9-]*)/.exec(t)?.[1];
  if (name === "if" || name === "elif" || name === "else" || name === "end" || name === "choice" || name === "script" || name === "define") return name;
  return t.startsWith("@") ? "command" : "text";
}

/**
 * 書き出した行の並び（join する前）と出どころから、仕上げた text の各行の出どころを作る。
 * 仕上げ（3 つ以上続く改行を 2 つにし、前後の空白を切る）を行の並びの上でたどり、text と一致しなければ null。
 */
function finalMap(rows: readonly string[], origins: readonly (LineOrigin | null)[], text: string): (LineOrigin | null)[] | null {
  const lines: string[] = [];
  const map: (LineOrigin | null)[] = [];
  rows.forEach((row, i) => {
    for (const part of row.split("\n")) {
      // 続く空行は一つにする
      if (part === "" && lines.length > 0 && lines.at(-1) === "") continue;
      lines.push(part);
      map.push(part === "" ? null : (origins[i] ?? null));
    }
  });
  // 前後の空白だけの行を落とし、残った最初と最後の行の前後の空白を切る
  while (lines.length > 0 && lines[0]!.trim() === "") {
    lines.shift();
    map.shift();
  }
  while (lines.length > 0 && lines.at(-1)!.trim() === "") {
    lines.pop();
    map.pop();
  }
  if (lines.length > 0) {
    lines[0] = lines[0]!.trimStart();
    lines[lines.length - 1] = lines.at(-1)!.trimEnd();
  }
  return lines.join("\n") + "\n" === text ? map : null;
}

// ---- 値の書き方 ----

/** 本文の文字。&式・%引数 の目印は {= 式} にする（[glink text=%label] など）。 */
function escapeText(text: string): string {
  return text.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/\uE000([^\uE001]*)\uE001/g, (_, e: string) => `{= ${e}}`);
}

/** @mask / @mask-off の method にできる animate.css の名前（In の形。fadeIn は crossfade と同じ）。 */
const MASK_METHODS = ["fadeInLeft", "fadeInRight", "fadeInUp", "fadeInDown", "slideInLeft", "slideInRight", "slideInUp", "slideInDown", "puffIn", "vanishIn"];
const MASK_METHODS_NOTE = "fade / slide / puff / vanish の In と Out だけを変換します";

/**
 * [mask] の effect（In の名前）と [mask_off] の effect（Out の名前）を method にする。
 * fadeIn / fadeOut は既定の crossfade。対応しない名前は null。
 */
function maskMethod(effect: string, kind: "In" | "Out"): string | null {
  if (effect === `fade${kind}`) return "crossfade";
  const name = kind === "Out" ? effect.replace("Out", "In") : effect;
  if (kind === "Out" && !effect.includes("Out")) return null;
  return MASK_METHODS.includes(name) ? name : null;
}

function needsLeadingEscape(line: string, speakers: readonly string[]): boolean {
  if (/^[@#\t ]|^\/\//.test(line)) return true;
  return speakers.some((s) => line.startsWith(s) && speechOpenAt(line, s.length) >= 0);
}

/** ミリ秒の文字列を時間の書き方にする。1000 の倍数は秒で書く。 */
export function ms(value: string): string {
  const e = entity(value);
  if (e !== null) return `(${e})`;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}ms`;
  return n !== 0 && n % 1000 === 0 ? `${n / 1000}s` : `${n}ms`;
}

export function bool(value: string): string {
  const e = entity(value);
  if (e !== null) return `(${e})`;
  return value === "true" ? "true" : "false";
}

const NAMED_COLORS: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000" };

export function color(value: string): string {
  const e = entity(value);
  if (e !== null) return `(${e})`;
  const v = value.trim().toLowerCase();
  if (/^0x[0-9a-f]{6}$/.test(v)) return `#${v.slice(2)}`;
  if (/^#[0-9a-f]{3,8}$/.test(v)) return v;
  return NAMED_COLORS[v] ?? `"${value}"`;
}

/** 文字列の値。空白や紛らわしい形のときだけ引用符で囲む。 */
export function str(value: string): string {
  const e = entity(value);
  if (e !== null) return `(${e})`;
  const plain = /^[^\s"()=]+$/.test(value) && !/^(-?\d+(\.\d+)?(ms|s)?|true|false|#[0-9a-fA-F]{3,8})$/.test(value);
  return plain ? value : JSON.stringify(value);
}

/** 数値の値。数値でなければ文字列として書く（検査で型の違いが分かる）。 */
function numberValue(value: string): string {
  if (entity(value) !== null) return `(${entity(value)})`;
  return /^-?\d+(\.\d+)?$/.test(value.trim()) ? String(Number(value)) : str(value);
}

/** マクロの引数の型に合わせた値の書き方。 */
export function typedValue(type: string, value: string): string {
  switch (type) {
    case "duration":
      return ms(value);
    case "bool":
      return bool(value);
    case "color":
      return color(value);
    case "number":
      return numberValue(value);
    default:
      return str(value);
  }
}

/** storage を data/scenario からのパスにそろえる（./ と、ks の拡張子の有無を問わない）。 */
export function normalizeStorage(storage: string): string {
  const parts: string[] = [];
  for (const part of storage.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  const path = parts.join("/");
  return path.endsWith(".ks") ? path : `${path}.ks`;
}

function genericValue(value: string): string {
  if (entity(value) !== null) return `(${entity(value)})`;
  if (/^-?\d+(\.\d+)?$/.test(value) || value === "true" || value === "false") return value;
  return str(value);
}

function toKebab(name: string): string {
  return name.toLowerCase().replace(/_/g, "-").replace(/^-+|-+$/g, "").replace(/[^a-z0-9-]/g, "");
}

/** ティラノの storage / target を .lim の飛び先にする。 */
function jumpTarget(storage: string, target: string): string | null {
  const file = storage.replace(/\.ks$/, "");
  const label = target.replace(/^\*/, "");
  if (file !== "" && !/^[\w./-]+$/.test(file)) return null;
  if (label !== "" && !NAME_PATTERN.test(label)) return null;
  if (file === "" && label === "") return null;
  return `${file}${label ? `#${label}` : ""}`;
}

export type { Params };
