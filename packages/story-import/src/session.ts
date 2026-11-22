import type { VariableInitial } from "@liminalia/project";
import { DEFAULT_COMMANDS, mapCommand, splitCommand, type CommandMap } from "./commands.ts";
import { quote, type EndMode, type Issue, type Node, type Outcome } from "./ir.ts";

export interface StoryImportOptions {
  /** 書き出す .lim のファイル名（拡張子なし）。省くと元のファイル名から作る。 */
  name?: string;
  /** タグ・コマンドの対応表（組み込みの表に重ねる）。 */
  commands?: CommandMap;
  /** 終わり（Ink の END・DONE、Yarn のノードの終わりと <<stop>>）。既定は title（タイトル画面へ戻る）。 */
  end?: EndMode;
  /**
   * 変数の初期値の置き場所。config は結果の variables に入れる（lim import-ink が liminalia.json に書く）、
   * set はファイルの先頭に @set の行で書く（Studio のテキストのインポート）。既定は config。
   */
  variables?: "config" | "set";
  /** 今の話者。結果の newSpeakers はこれに無い名前。 */
  speakers?: readonly string[];
  /** 書く .lim の先頭の注記（どこから変換したか）の言語。既定は ja。Studio の英語の表示から取り込むときは en。 */
  language?: "ja" | "en";
}

/**
 * 取り込みで書く .lim の先頭の行（元のファイルと、変換したコマンド）。lim import-* は、この行で始まる .lim だけを上書きする（node.ts の MARK）。
 */
export function convertedHeader(source: string, kind: "ink" | "yarn" | "renpy" | "twine", language: "ja" | "en" = "ja"): string {
  const file = source.replace(/^.*[\\/]/, "");
  return language === "en" ? `// Converted from ${file} with lim import-${kind}` : `// ${file} から lim import-${kind} で変換`;
}

export interface StoryFile {
  /** .lim のファイル名（拡張子なし）。 */
  name: string;
  /** 元のファイル（報告に出す名前）。 */
  source: string;
  text: string;
}

export interface StoryImportResult {
  files: StoryFile[];
  /** 台詞の話者（出てきた順）。 */
  speakers: string[];
  newSpeakers: string[];
  /** 変数の初期値（"game.名前" → 値）。options.variables が set なら空。 */
  variables: Record<string, VariableInitial>;
  issues: Issue[];
  totals: Record<Outcome, number>;
  /** 対応表に無いタグ・コマンド（名前 → 件数）。コメントにして残したもの。 */
  unmapped: Map<string, number>;
  /** 変換しなかった構文（診断の識別子 → 件数）。 */
  unsupported: Map<string, number>;
  stats: { says: number; prose: number; choices: number; labels: number };
}

const FILE_NAME = /^[A-Za-z0-9_-]+$/;

/** 元のファイル名から .lim のファイル名を作る（使えない文字は _ に）。 */
export function limFileName(source: string): string {
  const base = source.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const name = base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return FILE_NAME.test(name) ? name : "story";
}

/** ラベルに使える名前（文字・数字・_・-）。 */
export function labelName(text: string): string {
  const n = text.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return n === "" ? "node" : n;
}

/** 変数の名前に使える名前。 */
export function variableName(text: string): string {
  const n = text.replace(/[^\p{L}\p{N}_]+/gu, "_");
  return /^[\p{L}_]/u.test(n) ? n : `_${n}`;
}

/** 台詞の名前として読める長さと、名前に入らない文字。 */
const NAME_MAX = 20;
const NOT_NAME = /[「」『』（）()【】[\]{}<>：:、。,.!?！？…"“”#]/;

/** `名前: 台詞` を名前と本文に分ける（名前らしくなければ null）。 */
export function splitSpeaker(text: string): { name: string; body: string } | null {
  const m = /^([^:：]+?)\s*[:：]\s*(.*)$/s.exec(text);
  if (!m) return null;
  const name = m[1]!.trim();
  if (name.length === 0 || name.length > NAME_MAX || NOT_NAME.test(name) || name.split(/\s+/).length > 3) return null;
  return { name, body: m[2]!.trim() };
}

/** 変換の途中の記録。 */
export class Session {
  readonly issues: Issue[] = [];
  readonly totals: Record<Outcome, number> = { mapped: 0, dropped: 0, generic: 0, manual: 0 };
  readonly unmapped = new Map<string, number>();
  readonly unsupported = new Map<string, number>();
  readonly speakers: string[] = [];
  readonly variables = new Map<string, VariableInitial>();
  readonly stats = { says: 0, prose: 0, choices: 0, labels: 0 };
  readonly commands: CommandMap;
  file = "";
  private readonly varNames = new Set<string>();

  constructor(readonly options: StoryImportOptions) {
    const extra = Object.fromEntries(Object.entries(options.commands ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.commands = { ...DEFAULT_COMMANDS, ...extra };
  }

  count(outcome: Outcome, n = 1): void {
    this.totals[outcome] += n;
  }

  issue(severity: Issue["severity"], code: string, message: string, line: number): void {
    this.issues.push({ severity, code, message, file: this.file, line });
  }

  /** 変換しない構文。manual として数え、警告にする。 */
  unsupportedSyntax(code: string, message: string, line: number): void {
    this.count("manual");
    this.unsupported.set(code, (this.unsupported.get(code) ?? 0) + 1);
    this.issue("warning", code, message, line);
  }

  speaker(name: string): void {
    if (!this.speakers.includes(name)) this.speakers.push(name);
  }

  /** 重ならない game. の変数の名前。 */
  gameVariable(base: string, initial: VariableInitial): string {
    let name = `game.${variableName(base)}`;
    for (let n = 2; this.varNames.has(name); n++) name = `game.${variableName(base)}_${n}`;
    this.varNames.add(name);
    this.variables.set(name, initial);
    return name;
  }

  /** 名前を決めた game. の変数（同じ名前ならそのまま使う）。 */
  declare(name: string, initial: VariableInitial): string {
    const full = `game.${variableName(name)}`;
    if (!this.varNames.has(full)) {
      this.varNames.add(full);
      this.variables.set(full, initial);
    }
    return full;
  }

  /** タグ・コマンドを対応表で .lim の行にする。対応表に無ければコメントにする。 */
  command(text: string, line: number, kind: "タグ" | "コマンド"): Node[] {
    const { name, args } = splitCommand(text);
    const mapped = mapCommand(this.commands, name, args);
    if (Array.isArray(mapped)) {
      this.count(mapped.length > 0 ? "mapped" : "dropped");
      return mapped.map((t) => ({ k: "raw", text: t }));
    }
    this.count("generic");
    this.unmapped.set(name, (this.unmapped.get(name) ?? 0) + 1);
    if (mapped === "missing") this.issue("warning", "command-args", `${kind} ${name} の値が足りないので変換しません: ${text}`, line);
    else this.issue("info", "unmapped-command", `${kind} ${name} は対応表に無いのでコメントにしました`, line);
    return [{ k: "comment", text: kind === "タグ" ? `#${text}` : `<<${text}>>` }];
  }

  /** 初期値を @set の行にする（options.variables が set のとき）。 */
  variableLines(): string[] {
    return [...this.variables].map(([k, v]) => `@set ${k} = ${limInitial(v)}`);
  }

  result(files: StoryFile[]): StoryImportResult {
    const known = new Set(this.options.speakers ?? []);
    return {
      files,
      speakers: [...this.speakers],
      newSpeakers: this.speakers.filter((s) => !known.has(s)),
      variables: this.options.variables === "set" ? {} : Object.fromEntries(this.variables),
      issues: this.issues,
      totals: this.totals,
      unmapped: this.unmapped,
      unsupported: this.unsupported,
      stats: this.stats,
    };
  }
}

/** 初期値を .lim の値の書き方にする（JSON.stringify は \t を書き逃しにするが、.lim の文字列は \t を読まないので "t" に消える）。 */
function limInitial(v: VariableInitial): string {
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) return `[${v.map(limInitial).join(", ")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${limInitial(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}
