// .lim の構文木。実行器・検査・整形・変換器が共通で使う。

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  /** 機械可読な識別子（例: "unknown-command"）。 */
  code: string;
  message: string;
  /** 英語の文（プラグインが自分で訳を持つとき。エンジンの診断の訳は diagnostics-en.ts の表）。 */
  messageEn?: string;
  file: string;
  /** 1 始まり。 */
  line: number;
  /** 1 始まり。行全体に対する指摘では省略。 */
  column?: number;
  /** 直し方の候補。AI がそのまま適用できる具体的な形で書く。 */
  hint?: string;
  /** hint の英語の文（messageEn と同じ）。 */
  hintEn?: string;
  /** プラグインの check が出した診断なら、そのプラグインの名前（チェックの分類の「プラグイン」に入る）。 */
  plugin?: string;
  /** キャストの定義（cast.json）への指摘なら、その対象（制作画面がキャラクターの画面を開くのに使う）。 */
  cast?: CastSubject;
  /** 機械で当てられる直し方（制作画面の「まとめて削除」など）。 */
  fix?: DiagnosticFix;
  /**
   * 直し方の候補を勧める順に（先頭が一番の案）。行の外を書き換えるもの（ProjectFix。話者に足す、シーンを作る）も入る。
   * fix があれば、それもこの中に入る（fix しか読まない画面は今までどおり動く）。
   */
  fixes?: (DiagnosticFix | ProjectFix)[];
}

/**
 * 機械で当てられる直し方（制作画面のエディタとチェックの画面の「修正」、./fix.ts の applyFix）。
 * - delete-line: その行を消す（text はその行の中身を空白を一つにそろえたもの。書いたあとに中身が変わっていれば当てない）
 * - replace: その行の find を with に置き換える（診断に column があれば、その桁の字を含むか、その桁から始まる語の中で始まるものだけ。
 *   column が無ければ行の最初のもの。find が無ければ当てない。./fix.ts の findAt）。綴りの近い候補（hintFrom）、無い素材の近い候補、約物の直し方が付ける。
 *   column の無い直し方は、同じ行の同じ字面のどれに当てても同じ結果になるものだけにする（test/fix-targets.test.ts）
 * - replace-lines: 続く何行かを一行に置き換える（ReplaceLinesFix）
 */
export type DiagnosticFix = { kind: "delete-line"; text: string } | { kind: "replace"; find: string; with: string } | ReplaceLinesFix;

/**
 * この行から lines.length 行を、with の一行（字下げは最初の行のもの）に置き換える（@mask の塊を @scene-change にするなど）。
 * lines はそれぞれの行の命令の形（./fix.ts の commandShape。空白や "…" の違いをそろえたもの）で、書いたあとに行が変わっていれば当てない。
 */
export interface ReplaceLinesFix {
  kind: "replace-lines";
  lines: string[];
  with: string;
}

/**
 * 行の外を書き換える直し方（Diagnostic の fixes。制作画面が当てる）。
 * - add-speaker: cast.json の speakers に name を足す（その行が台詞になる）
 * - add-label: シナリオ file（拡張子なしの名前）の終わりに `# label` の行を足す（シーンを作る）
 */
export type ProjectFix = { kind: "add-speaker"; name: string } | { kind: "add-label"; file: string; label: string };

/** キャストの定義への指摘の対象。kind は直し方の種類（default-appearance: 既定の立ち絵セット、default-variant: 基準の差分）。 */
export interface CastSubject {
  who: string;
  appearance?: string;
  kind?: "default-appearance" | "default-variant";
}

// ---- 式 ----

export type Expr =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "array"; items: Expr[] }
  /** 辞書のリテラル（`{"a": 1, b: 2}`）。キーは書いた順。 */
  | { kind: "object"; entries: { key: string; value: Expr }[] }
  | { kind: "name"; name: string }
  | { kind: "member"; object: Expr; property: string }
  | { kind: "index"; object: Expr; index: Expr }
  | { kind: "call"; callee: string; args: Expr[] }
  | { kind: "unary"; op: "!" | "-"; operand: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "conditional"; test: Expr; then: Expr; otherwise: Expr };

export type BinaryOp = "*" | "/" | "%" | "+" | "-" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

// ---- 本文 ----

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "ruby"; base: string; reading: string }
  | { kind: "value"; expr: Expr; source: string }
  | { kind: "click" }
  /** 行の終わりでクリックを待たずに次へ進む（行の最後にだけ書ける。Ren'Py の {nw} に当たる）。 */
  | { kind: "noclick" }
  | { kind: "br" }
  /** 囲んだ部分だけ文字を出す速さを変える（一文字あたり perChar ミリ秒）。 */
  | { kind: "speed"; perChar: number; source: string; children: Inline[] }
  /** 本文がこの位置まで表示されたときに命令を実行する。column は @ の桁（1 から。行の頭からの桁。診断の桁に使う）。 */
  | { kind: "command"; name: string; args: Argument[]; column?: number }
  | { kind: "style"; style: "bold" | "italic"; children: Inline[] }
  | { kind: "color"; color: string; children: Inline[] }
  /** 囲んだ部分の文字の大きさ（px）。 */
  | { kind: "size"; size: number; children: Inline[] }
  /** 囲んだ部分に蛍光ペンのような背景色を引く。 */
  | { kind: "mark"; color: string; children: Inline[] }
  /** 文字の動き。strength は動きの大きさ、speed は速さの倍率（1 で標準。書かなければ無い）。 */
  | { kind: "fx"; effect: TextEffect; strength?: number; speed?: number; children: Inline[] }
  /** 囲んだ部分に傍点（圏点）を打つ。 */
  | { kind: "emphasis"; children: Inline[] }
  /** 本文の中の画像（image フォルダ。アイコンや外字）。height は高さ（px。省くと文字の大きさ）。column はパスの頭の桁（1 から。行の頭からの桁）。 */
  | { kind: "image"; path: string; height?: number; column?: number }
  /**
   * 本文の出し分け（`{seq a|b|c}`）。同じ所を通るたびに items のどれかを出す（mode は TEXT_VARIANTS）。
   * 何回通ったかはセーブに入る（実行器の state.variants。鍵はファイルと行と、その行の何番目の出し分けか）。
   */
  | { kind: "variants"; mode: TextVariantMode; items: Inline[][]; /** items を頭からつないだもの（本文をたどる処理が、中の命令と式と画像を見るため）。 */ children: Inline[] };

/**
 * 本文の出し分けの種類（Ink の順番と同じ）。seq は順に出して最後のものを出し続ける、cycle は順に出して頭に戻る、
 * once は順に一度ずつ出して出し終えたら何も出さない、shuffle は毎回ばらばら（同じものを続けては出さない）。
 */
export const TEXT_VARIANTS = ["seq", "cycle", "once", "shuffle"] as const;
export type TextVariantMode = (typeof TEXT_VARIANTS)[number];

/** 文字の動き（{fx …}）。shake 震え・wave 波打つ・pop 弾んで出る・fade じわりと出る・glow 光る。 */
export const TEXT_EFFECTS = ["shake", "wave", "pop", "fade", "glow"] as const;
export type TextEffect = (typeof TEXT_EFFECTS)[number];

// ---- 命令の引数 ----

export type Literal =
  | { kind: "string"; value: string; quoted: boolean }
  | { kind: "number"; value: number }
  | { kind: "duration"; ms: number; source: string }
  | { kind: "bool"; value: boolean }
  | { kind: "color"; value: string }
  /** `(式)` と書いた値。実行時に評価する。 */
  | { kind: "expr"; expr: Expr; source: string };

export interface Argument {
  /** 位置引数なら null。 */
  key: string | null;
  value: Literal;
  column: number;
  /** 書いたままの字面（`fade=300`、`"a b"`、`( temp.t )`）。直し方の find に使う（値を書き直した字面は書いたものと違うことがある）。 */
  text?: string;
}

/** ジャンプ先。`#ラベル`・`ファイル`・`ファイル#ラベル`。 */
export interface Target {
  file: string | null;
  label: string | null;
  /**
   * 飛び先を実行時に決める式（`@jump (game.next)`。値は `#ラベル`・`ファイル`・`ファイル#ラベル` の文字列）。
   * あるときは file・label は null。検査と分岐の地図は、式の中の文字列か、変数に入れる文字列から候補を割り出す
   * （割り出せなければ to= の候補が要る）。
   */
  expr?: Expr;
  /** 式の飛び先の候補（`to=#a,#b,ch2#start`）。書いてあれば、実行時の値はこの中のどれかでなければならない。 */
  candidates?: string[];
}

export interface Param {
  name: string;
  type: string;
  defaultValue: Literal | null;
}

// ---- 文 ----

interface At {
  line: number;
}

export type Statement =
  /** 地の文。id は行末の `#line:ID`（固定の行 ID。訳とボイスの番号の固定の鍵になる。line-ids.ts）。 */
  | ({ kind: "prose"; content: Inline[]; id?: string } & At)
  /**
   * 台詞。name はこの行だけ名前欄に出す名前（`話者{name 表示名}「…」`。文字と {= 式} だけ）。話者（口パク、ボイス、名前の色など）は speaker のまま。
   * id は行末の `#line:ID`（固定の行 ID）。
   */
  | ({ kind: "say"; speaker: string; name?: Inline[]; content: Inline[]; id?: string } & At)
  | ({ kind: "label"; name: string } & At)
  /** body は @end までの行をそのまま持つ命令（@html）の中身。 */
  | ({ kind: "command"; name: string; args: Argument[]; body?: CommandBody } & At)
  /**
   * 条件分岐（@if）。同じ形で二つの書き方も表す（中の行を見る処理が、@if の枝と同じにたどれるように）。
   * - loop: `@while 条件` 〜 `@end`。枝は一つで、条件が真の間、中を繰り返す
   * - with: `@with マクロ パラメータ…` 〜 `@end`。枝は一つ（条件なし）で、中身をマクロに渡す（マクロの中の @content で実行する）
   * - each: `@for 名前 in 式` 〜 `@end`。loop も付き、枝は一つ（条件なし）で、配列の要素を一つずつ name の局所変数に入れて中をくり返す
   * - guard: 命令の行の `if=(式)`（`@bg x if=(game.night)`）。枝は一つで、中身はその命令の一文だけ（行も同じ）。値は式の字面
   */
  | ({ kind: "if"; branches: IfBranch[]; loop?: true; with?: { name: string; args: Argument[] }; each?: { name: string; list: Expr }; guard?: string } & At)
  /** args は @choice の行のパラメータ（timeout・default。CHOICE_BLOCK）。 */
  | ({ kind: "choice"; options: ChoiceOption[]; args?: Argument[] } & At)
  /** doc は @define のすぐ上に続く // の行（マクロの要約。補完と説明に出す）。 */
  | ({ kind: "define"; name: string; params: Param[]; body: Statement[]; doc?: string } & At)
  | ({ kind: "script"; code: string } & At)
  | ({ kind: "set"; target: Expr; op: "=" | "+=" | "-=" | "*=" | "/="; value: Expr } & At)
  | ({ kind: "let"; name: string; value: Expr } & At)
  | ({ kind: "jump" | "call"; target: Target } & At)
  /** value は @define の中の `@return (式)`（マクロの戻り値。呼び出しの variable 型のパラメータに入れる）。 */
  | ({ kind: "return"; value?: Expr } & At)
  /** @define の中で、@with で渡された中身を実行する。 */
  | ({ kind: "content" } & At)
  /** 別のファイルの @define をこのファイルで使う。ファイルの一番外側にだけ置ける。 */
  | ({ kind: "use"; file: string } & At)
  /**
   * 式で呼べる自前の関数（`@function rank(score) = score >= 80 ? "A" : "B"`）。中身は式一つで、値を返すだけ（変数を変えない）。
   * ファイルの一番外側にだけ置ける。呼べるのはそのファイルと、それを @use したファイル。
   */
  | ({ kind: "function"; name: string; params: string[]; body: Expr } & At);

/** @end までの行をそのまま持つ命令（@html）の中身。 */
export interface CommandBody {
  /** 字下げをそろえた中身（行は \n で区切る）。 */
  text: string;
  /** 中身の最初の行（1 始まり）。 */
  line: number;
  /** そろえるときに外した字下げの文字数（中身の桁から行の桁を出すのに使う）。 */
  indent: number;
}

export interface IfBranch {
  /** else は null。 */
  condition: Expr | null;
  body: Statement[];
  line: number;
}

export interface ChoiceOption {
  content: Inline[];
  target: Target;
  /** 出す条件（if=）と見た目の指定（image= hover= x= y= width= height=）。条件のない文字のボタンなら空。 */
  args: Argument[];
  line: number;
  /** 行末の `#line:ID`（固定の行 ID。訳の鍵になる）。 */
  id?: string;
}

export interface Script {
  file: string;
  body: Statement[];
  diagnostics: Diagnostic[];
  /**
   * 診断を黙らせるコメント（`// lim-ignore コード…` は次の行に、`// lim-ignore-file コード…` はファイル全体に効く）。
   * 書いてあるときだけ持つ。黙らせるのは警告と情報だけ（./suppress.ts）。
   */
  ignores?: IgnoreDirective[];
  /** ファイルの先頭のコメントの `// lim: draft`（下書き。書き出し、全ルートテスト、網羅率、届かない行の検査から外す）。 */
  draft?: true;
}

/** 診断を黙らせるコメント。line はコメントの行、target は効く行（ファイル全体なら "file"）。codes が空ならその行のエラー以外のすべて。text はコメントの行の中身（空白を一つにそろえたもの）。 */
export interface IgnoreDirective {
  line: number;
  target: number | "file";
  codes: string[];
  text: string;
}
