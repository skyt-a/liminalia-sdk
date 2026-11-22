/** タグの引数。.ks の値はすべて文字列として届く（解釈はタグ側の責任）。 */
export type Params = Record<string, string>;

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  /** 機械可読な識別子（例: "unclosed-tag"）。 */
  code: string;
  message: string;
  file: string;
  /** 1 始まりの行番号。 */
  line: number;
}

/**
 * 字句解析の結果となる一命令。TyranoScript のパーサの出力（name / pm / val / line）と
 * 一対一に対応させ、差分テストで突き合わせられる形にしてある。
 */
export interface RawCommand {
  /** タグ名。地の文は "text"、ラベルは "label"、`#名前` 行は "chara_ptext"。 */
  name: string;
  pm: Params;
  /** 地の文・ラベルの表示名。タグでは空文字。 */
  val: string;
  /** 1 始まりの行番号。 */
  line: number;
  /** 地の文は実行時にエンティティ（&式・%引数）を展開しない。 */
  entityDisabled?: true;
}

/** 実行用に構造を解決した命令。 */
export interface Command extends RawCommand {
  /**
   * if / elsif / else: 条件が偽のとき次に評価する分岐（elsif・else・endif）の位置。
   * macro / ignore / iscript: 対応する終端タグの位置。
   */
  next?: number;
  /** if / elsif / else: 対応する endif の位置。 */
  end?: number;
  /** iscript: [iscript] と [endscript] の間の本文（行ごとに改行で連結）。 */
  body?: string;
}

export interface ScenarioIR {
  file: string;
  commands: Command[];
  /** ラベル名 → commands 上の位置。重複時は先に出たものが有効（TyranoScript と同じ）。 */
  labels: Record<string, number>;
  diagnostics: Diagnostic[];
}

export interface LexOptions {
  /**
   * Config.tjs の KeepSpaceInParameterValue。
   * "1": 引用符内の空白を詰める / "2": 前後を切る（既定） / "3": そのまま残す。
   */
  keepSpaceInParameterValue?: "1" | "2" | "3";
}
