import type { Diagnostic, Script } from "./ast.ts";
import { ExprError, parseExpr } from "./expr.ts";
import type { Registry } from "./registry.ts";
import { variablePaths, variableUses } from "./variables.ts";

/**
 * 作品のデータ（paths.data の .json）の形の宣言。プラグイン（@liminalia/sdk の CommandPlugin の data）が書き、
 * この一つの宣言から、検査（lim check・制作画面のチェック）、制作画面の自動のフォーム、名前を変えたときの書き換え、
 * データの中のフラグと台本の突き合わせ、CG の解放の申告を作る。宣言は JSON にできる素の値だけで書く（制作画面へそのまま送る）。
 */

/** 欄の見出し（日本語と英語）。 */
interface FieldCommon {
  /** 見出し。 */
  label?: string;
  labelEn?: string;
  /** 補いの説明（制作画面の欄の下に出す）。 */
  doc?: string;
  docEn?: string;
  /** 無いとエラー（record の中の欄）。 */
  required?: boolean;
}

export type DataField = FieldCommon &
  (
    /** translate なら遊ぶ人に見せる文で、lim i18n が訳のファイルに並べる（dataTranslatables）。 */
    | { kind: "string"; multiline?: boolean; suggest?: readonly string[]; translate?: boolean }
    | { kind: "number"; min?: number; max?: number }
    | { kind: "int"; min?: number; max?: number }
    | { kind: "bool" }
    | { kind: "enum"; values: readonly string[] }
    /**
     * 素材のパス（folder の中）。cg なら、プラグインがこの画像を CG として解放する（どこからも出ない CG の検査に数える）。
     * also は folder に無ければ探すほかのフォルダ（前の置き場所。描画の側も同じ順に探す）。
     */
    | { kind: "asset"; folder: string; cg?: boolean; also?: readonly string[] }
    /**
     * フラグ（変数）。`game.x` か、scope を省いた `x`（game.x）。use は、このデータでプラグインが立てる（set）か、読む（read）か。
     * 立てるフラグは台本の @set と同じに数え、読むフラグは条件と同じに数える（立てていない・読まれないの突き合わせ）。
     */
    | { kind: "flag"; use: "set" | "read" }
    /** 条件の式（`game.met && game.trust >= 2`）。中の変数は読むフラグに数える。 */
    | { kind: "expr" }
    /** キャストに登録した名前。 */
    | { kind: "cast" }
    /**
     * 飛び先（`#ラベル`・`ファイル`・`ファイル#ラベル`）。base を書くと、`#ラベル` のファイルは、外側の記録の欄 base（ファイル名の欄）の値。
     * 実在を確かめ、シーン・ファイルの名前を変えたら書き換える。bare なら # を書かずにラベルだけを書く（`kei_window`。ファイルは base）。
     */
    | { kind: "scene"; base?: string; bare?: boolean }
    /** シナリオのファイル名（拡張子なし）。 */
    | { kind: "file" }
    /** 同じデータの中の名前（to は一覧の欄への道。`/entries` の項目の id、`/categories` など）。 */
    | { kind: "ref"; to: string }
    /** 背景の上の矩形（x・y・width・height。舞台の px）。image は同じ記録か外側の記録の、背景の素材の欄の名前（制作画面が絵の上で矩形を引く）。 */
    | { kind: "rect"; image?: string }
    /**
     * 絵の上の点（x・y）。unit が percent（既定）なら絵の左上からの割合（0〜100）、px なら舞台の px。
     * image は背景の素材の欄の名前（同じ記録か外側の記録。制作画面が絵を出して点を置く）。`ref の欄>素材の欄` なら、
     * 同じ記録の ref の欄が指す項目の素材の欄（`category>map`）。keys を書くと、値を { x, y } にまとめず、
     * 同じ記録の二つの欄（`["x", "y"]`）に置く（欄そのものは値を持たない。今ある形のデータに点を置く欄を足すとき）。
     */
    | { kind: "point"; image?: string; unit?: "percent" | "px"; keys?: readonly [string, string] }
    /** 並び。sortable なら制作画面で並べ替えられる。key は項目を見分ける欄（三方向のマージで項目ごとに合わせる）。 */
    | { kind: "list"; of: DataField; sortable?: boolean; key?: string }
    /** 欄の決まった記録。 */
    | { kind: "record"; fields: Readonly<Record<string, DataField>>; title?: string }
    /** 名前 → 値の辞書（名前が id になる）。 */
    | { kind: "map"; of: DataField }
    /** 形を決めない値（検査も書き換えもしない）。 */
    | { kind: "json" }
  );

export type DataFieldKind = DataField["kind"];

/** データのファイルの宣言。 */
export interface DataDeclaration {
  /** paths.data からの名前（`codex.json`）。 */
  file: string;
  /** 制作画面の見出し。 */
  title: string;
  titleEn?: string;
  /** 一番外の値の形（ふつうは record）。 */
  root: DataField;
  /** ファイルが無くてもよいか（既定 true。無ければ検査しない）。 */
  optional?: boolean;
}

/** データの中の場所（JSON の鍵と番号の並び）。 */
export type DataPath = readonly (string | number)[];

/** 場所を JSON Pointer の形の文字（`/exams/a/spots/0`）にする。 */
export function dataPointer(path: DataPath): string {
  return path.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/**
 * JSON の文字から、値の場所（JSON Pointer）ごとの行（1 始まり）を求める。診断を押してその行へ移るのに使う。
 * 読めない JSON なら空の表。
 */
export function jsonLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  let line = 1;
  const ws = () => {
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\n") line++;
      else if (c !== " " && c !== "\t" && c !== "\r") break;
      i++;
    }
  };
  const str = (): string => {
    let s = "";
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        s += text.slice(i, i + 2);
        i += 2;
      } else s += text[i++];
    }
    i++;
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return s;
    }
  };
  const value = (path: string): void => {
    ws();
    out.set(path, line);
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      while (i < text.length) {
        ws();
        const key = str();
        ws();
        i++; // :
        value(`${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return void i++;
        else return;
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      let n = 0;
      while (i < text.length) {
        value(`${path}/${n++}`);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return void i++;
        else return;
      }
    } else if (c === '"') str();
    else while (i < text.length && !/[,\]}\s]/.test(text[i]!)) i++;
  };
  try {
    value("");
  } catch {
    return new Map();
  }
  return out;
}

/** 欄を一つ訪ねたときに渡すもの。records は外側の記録（近い順）。 */
export interface DataVisit {
  field: DataField;
  value: unknown;
  path: DataPath;
  records: readonly Record<string, unknown>[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 宣言に沿って値をたどり、欄ごとに visit を呼ぶ（形の合わない入れ物の中へは入らない）。 */
export function walkData(field: DataField, value: unknown, visit: (v: DataVisit) => void, path: DataPath = [], records: readonly Record<string, unknown>[] = []): void {
  visit({ field, value, path, records });
  if (value === undefined || value === null) return;
  switch (field.kind) {
    case "list":
      if (Array.isArray(value)) value.forEach((item, i) => walkData(field.of, item, visit, [...path, i], records));
      return;
    case "map":
      if (isRecord(value)) for (const [k, item] of Object.entries(value)) walkData(field.of, item, visit, [...path, k], records);
      return;
    case "record":
      if (isRecord(value)) {
        const inner = [value, ...records];
        for (const [k, f] of Object.entries(field.fields)) walkData(f, value[k], visit, [...path, k], inner);
      }
      return;
    default:
      return;
  }
}

/** 変数の名前を `game.x` の形にする（scope を省いたら game）。名前として読めなければ null。 */
export function flagPath(name: string): string | null {
  const full = /^(game|system|temp)\./.test(name) ? name : `game.${name}`;
  return /^(game|system|temp)\.[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(full) ? full : null;
}

/** 飛び先の文字を、ファイルとラベルに分ける（`#ラベル` は base のファイル）。 */
export function sceneOf(text: string, base: string | null): { file: string | null; label: string | null } {
  const hash = text.indexOf("#");
  const file = hash < 0 ? text : text.slice(0, hash);
  const label = hash < 0 ? null : text.slice(hash + 1);
  return { file: file === "" ? base : file, label: label === "" ? null : label };
}

/** 欄の飛び先（bare なら # の無い値はラベル）。 */
function fieldScene(field: Extract<DataField, { kind: "scene" }>, v: string, records: readonly Record<string, unknown>[]): { file: string | null; label: string | null } {
  const base = baseFile(field, records);
  return field.bare && !v.includes("#") ? { file: base, label: v } : sceneOf(v, base);
}

/** 外側の記録から、飛び先の base の欄の値（ファイル名）を探す。 */
function baseFile(field: Extract<DataField, { kind: "scene" }>, records: readonly Record<string, unknown>[]): string | null {
  if (!field.base) return null;
  for (const r of records) if (typeof r[field.base] === "string") return r[field.base] as string;
  return null;
}

/** データが指すもの（素材・フラグ・飛び先）。 */
export interface DataReferences {
  assets: { folder: string; path: string; cg: boolean; at: DataPath }[];
  /** プラグインがこのデータで立てるフラグ（`game.x`）。 */
  flagsSet: { path: string; at: DataPath }[];
  /** 条件・読むフラグで読む変数（`game.x`）。 */
  flagsRead: { path: string; at: DataPath }[];
  scenes: { file: string | null; label: string | null; text: string; at: DataPath }[];
  cast: { who: string; at: DataPath }[];
}

/** データが指すものを集める。 */
export function dataReferences(decl: DataDeclaration, value: unknown): DataReferences {
  const out: DataReferences = { assets: [], flagsSet: [], flagsRead: [], scenes: [], cast: [] };
  walkData(decl.root, value, ({ field, value: v, path, records }) => {
    if (typeof v !== "string" || v === "") return;
    switch (field.kind) {
      case "asset":
        out.assets.push({ folder: field.folder, path: v, cg: field.cg === true, at: path });
        return;
      case "flag": {
        const p = flagPath(v);
        if (p) (field.use === "set" ? out.flagsSet : out.flagsRead).push({ path: p, at: path });
        return;
      }
      case "expr":
        try {
          for (const p of variablePaths(parseExpr(v))) out.flagsRead.push({ path: p, at: path });
        } catch {
          // 読めない式は検査が知らせる
        }
        return;
      case "scene":
        out.scenes.push({ ...fieldScene(field, v, records), text: v, at: path });
        return;
      case "cast":
        out.cast.push({ who: v, at: path });
        return;
      default:
        return;
    }
  });
  return out;
}

/** 検査が読む作品。 */
export interface DataCheckEnv {
  /** 診断の file に書く名前（`data/codex.json`）。 */
  fileName: string;
  /** JSON の文字（行を求める。無ければ 1 行目）。 */
  text?: string;
  /** シナリオのファイル → ラベル。 */
  labels?: ReadonlyMap<string, ReadonlySet<string>>;
  /** 素材のフォルダの中にあるか。 */
  assetExists?: (folder: string, path: string) => boolean;
  /** キャストの名前。 */
  cast?: ReadonlySet<string>;
}

/** 欄の見出し（無ければ名前）。 */
function fieldName(path: DataPath, field: DataField): string {
  return field.label ?? String(path.at(-1) ?? "");
}

/** ref の to（`/entries`）が指す一覧の名前（map の鍵か、list の項目の id）。 */
function refNames(root: unknown, to: string): Set<string> | null {
  let v: unknown = root;
  for (const part of to.split("/").filter((p) => p !== "")) v = isRecord(v) ? v[part] : undefined;
  if (Array.isArray(v)) return new Set(v.flatMap((x) => (isRecord(x) && typeof x.id === "string" ? [x.id] : typeof x === "string" ? [x] : [])));
  if (isRecord(v)) return new Set(Object.keys(v));
  return null;
}

/** 宣言に沿ってデータを確かめる。 */
export function checkData(decl: DataDeclaration, value: unknown, env: DataCheckEnv): Diagnostic[] {
  const lines = env.text ? jsonLines(env.text) : new Map<string, number>();
  const lineOf = (path: DataPath) => {
    for (let p = [...path]; ; p = p.slice(0, -1)) {
      const l = lines.get(dataPointer(p));
      if (l !== undefined || p.length === 0) return l ?? 1;
    }
  };
  const out: Diagnostic[] = [];
  const at = (path: DataPath) => (path.length > 0 ? dataPointer(path) : "/");
  const push = (severity: Diagnostic["severity"], code: string, path: DataPath, message: string, messageEn: string, hint?: string, hintEn?: string) =>
    out.push({ severity, code, message, messageEn, file: env.fileName, line: lineOf(path), ...(hint ? { hint } : {}), ...(hintEn ? { hintEn } : {}) });
  walkData(decl.root, value, ({ field, value: v, path, records }) => {
    const name = fieldName(path, field);
    const where = at(path);
    // 同じ記録の二つの欄に置く点は、欄そのものに値が無い（二つの欄はそれぞれの宣言で確かめる）
    if (field.kind === "point" && field.keys) return;
    if (v === undefined || v === null) {
      if (field.required) push("error", "data-missing", path, `${env.fileName} の ${where}（${name}）がありません`, `${where} (${field.labelEn ?? name}) is missing in ${env.fileName}`, "宣言で必須の欄です。値を書きます", "This field is required. Add a value");
      return;
    }
    const wrong = (expected: string, expectedEn: string) =>
      push("error", "data-type", path, `${env.fileName} の ${where}（${name}）は${expected}で書きます`, `${where} (${field.labelEn ?? name}) in ${env.fileName} must be ${expectedEn}`);
    switch (field.kind) {
      case "string":
      case "cast":
      case "file":
        if (typeof v !== "string") return wrong("文字", "a string");
        if (field.kind === "cast" && env.cast && v !== "" && !env.cast.has(v))
          push("warning", "data-unknown-cast", path, `${env.fileName} の ${where} のキャスト ${v} は cast.json にありません`, `The cast ${v} at ${where} in ${env.fileName} isn't in cast.json`);
        if (field.kind === "file" && env.labels && v !== "" && !env.labels.has(v))
          push("error", "data-unknown-scene", path, `${env.fileName} の ${where} のファイル ${v} はシナリオにありません`, `The file ${v} at ${where} in ${env.fileName} isn't in the scenario`);
        return;
      case "number":
      case "int":
        if (typeof v !== "number" || !Number.isFinite(v) || (field.kind === "int" && !Number.isInteger(v))) return wrong(field.kind === "int" ? "整数" : "数", field.kind === "int" ? "an integer" : "a number");
        if ((field.min !== undefined && v < field.min) || (field.max !== undefined && v > field.max)) return wrong(`${field.min ?? ""}〜${field.max ?? ""} の数`, `a number in ${field.min ?? ""}..${field.max ?? ""}`);
        return;
      case "bool":
        if (typeof v !== "boolean") wrong("true か false", "true or false");
        return;
      case "enum":
        if (typeof v !== "string" || !field.values.includes(v)) wrong(`${field.values.join("・")} のどれか`, `one of ${field.values.join(", ")}`);
        return;
      case "asset":
        if (typeof v !== "string") return wrong("素材のパス", "an asset path");
        if (v !== "" && env.assetExists && ![field.folder, ...(field.also ?? [])].some((folder) => env.assetExists!(folder, v)))
          push("error", "data-missing-asset", path, `${env.fileName} の ${where} の素材 ${field.folder}/${v} がありません`, `The asset ${field.folder}/${v} at ${where} in ${env.fileName} doesn't exist`);
        return;
      case "flag":
        if (typeof v !== "string") return wrong("フラグの名前", "a flag name");
        if (v !== "" && !flagPath(v)) wrong("変数の名前（game.x か x）", "a variable name (game.x or x)");
        return;
      case "expr":
        if (typeof v !== "string") return wrong("式の文字", "an expression string");
        try {
          parseExpr(v);
        } catch (e) {
          const m = e instanceof ExprError || e instanceof Error ? e.message : String(e);
          push("error", "data-bad-expr", path, `${env.fileName} の ${where} の式を読めません: ${m}`, `Can't read the expression at ${where} in ${env.fileName}: ${m}`);
        }
        return;
      case "scene": {
        if (typeof v !== "string") return wrong("飛び先（ファイル#ラベル）", "a target (file#label)");
        if (v === "" || !env.labels) return;
        const s = fieldScene(field, v, records);
        if (!s.file) return push("error", "data-unknown-scene", path, `${env.fileName} の ${where} の飛び先 ${v} のファイルが分かりません`, `Can't tell the file of the target ${v} at ${where} in ${env.fileName}`, "ファイル#ラベル の形で書きます", "Write it as file#label");
        const labels = env.labels.get(s.file);
        if (!labels) push("error", "data-unknown-scene", path, `${env.fileName} の ${where} の飛び先のファイル ${s.file} はシナリオにありません`, `The file ${s.file} of the target at ${where} in ${env.fileName} isn't in the scenario`);
        else if (s.label && !labels.has(s.label)) push("error", "data-unknown-scene", path, `${env.fileName} の ${where} の飛び先のシーン ${s.file}#${s.label} がありません`, `The scene ${s.file}#${s.label} at ${where} in ${env.fileName} doesn't exist`);
        return;
      }
      case "ref": {
        if (typeof v !== "string") return wrong("名前", "a name");
        const names = refNames(value === undefined ? undefined : rootOf(decl, records), field.to);
        if (names && v !== "" && !names.has(v)) push("error", "data-unknown-ref", path, `${env.fileName} の ${where} の ${v} は ${field.to} にありません`, `${v} at ${where} in ${env.fileName} isn't in ${field.to}`);
        return;
      }
      case "rect":
        if (!isRecord(v) || !["x", "y", "width", "height"].every((k) => typeof v[k] === "number")) wrong("{ x, y, width, height } の数", "{ x, y, width, height } numbers");
        return;
      case "point":
        if (!isRecord(v) || !["x", "y"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k]))) return wrong("{ x, y } の数", "{ x, y } numbers");
        if (field.unit !== "px" && [v.x, v.y].some((n) => (n as number) < 0 || (n as number) > 100)) wrong("0〜100 の { x, y }", "{ x, y } in 0..100");
        return;
      case "list":
        if (!Array.isArray(v)) return wrong("並び（[…]）", "a list ([…])");
        if (field.key) {
          const seen = new Set<string>();
          v.forEach((item, i) => {
            const k = isRecord(item) ? item[field.key!] : undefined;
            if (typeof k !== "string") return;
            if (seen.has(k)) push("error", "data-duplicate", [...path, i], `${env.fileName} の ${where} に ${field.key} が ${k} のものが二つあります`, `${where} in ${env.fileName} has two items whose ${field.key} is ${k}`);
            seen.add(k);
          });
        }
        return;
      case "record":
        if (!isRecord(v)) return wrong("記録（{…}）", "an object ({…})");
        return;
      case "map":
        if (!isRecord(v)) wrong("辞書（{…}）", "an object ({…})");
        return;
      case "json":
        return;
    }
  });
  return out;
}

/** 一番外の記録（records の最後。無ければ null）。ref の to は一番外から数える。 */
function rootOf(_decl: DataDeclaration, records: readonly Record<string, unknown>[]): unknown {
  return records.at(-1) ?? null;
}

/** シナリオのファイル → ラベル（@if の中のものも）。データの飛び先の検査に渡す。 */
export function scriptLabels(scripts: Iterable<readonly [string, Script]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (body: Script["body"], names: Set<string>) => {
    for (const s of body) {
      if (s.kind === "label") names.add(s.name);
      else if (s.kind === "if") for (const b of s.branches) visit(b.body, names);
    }
  };
  for (const [file, script] of scripts) {
    const names = new Set<string>();
    visit(script.body, names);
    out.set(file, names);
  }
  return out;
}

/** 作品のデータのうち、宣言のあるもの。 */
export interface DeclaredData {
  decl: DataDeclaration;
  value: unknown;
  text?: string;
}

/** データの訳す文（file は paths.data からの名前、note は値の場所。en は同じ記録の英語の欄（`title` なら `titleEn`）に書いた文）。 */
export interface DataText {
  file: string;
  source: string;
  note: string;
  en?: string;
}

/** 宣言で訳す印（translate）の付いた、空でない文。lim i18n が訳のファイルに並べる。 */
export function dataTranslatables(data: readonly Pick<DeclaredData, "decl" | "value">[]): DataText[] {
  const out: DataText[] = [];
  for (const x of data) {
    walkData(x.decl.root, x.value, ({ field, value, path, records }) => {
      if (field.kind !== "string" || !field.translate || typeof value !== "string" || value.trim() === "") return;
      const key = path.at(-1);
      const en = typeof key === "string" ? records[0]?.[`${key}En`] : undefined;
      out.push({ file: x.decl.file, source: value, note: dataPointer(path), ...(typeof en === "string" && en.trim() !== "" ? { en } : {}) });
    });
  }
  return out;
}

/**
 * データの中のフラグと台本の突き合わせ。
 * - 読む（条件・読むフラグ）のに、どの台本の @set（と命令が結果を入れる変数）も、どのデータも立てない変数は警告（data-flag-unset）
 *   （liminalia.json の variables の初期値があれば、立てなくても値があるので見ない）
 * - データで立てる（プラグインが立てる）のに、どの台本もデータも読まない変数は情報（data-flag-unread）
 */
export function checkDataFlags(data: readonly DeclaredData[], scripts: Iterable<readonly [string, Script]>, registry: Registry, o: { variables?: Readonly<Record<string, unknown>>; fileName: (decl: DataDeclaration) => string } = { fileName: (d) => `data/${d.file}` }): Diagnostic[] {
  const scriptSet = new Set<string>();
  const scriptRead = new Set<string>();
  for (const [, script] of scripts) {
    for (const u of variableUses(script, registry)) (u.write ? scriptSet : scriptRead).add(u.path);
  }
  const initial = new Set(Object.keys(o.variables ?? {}).map((k) => flagPath(k) ?? k));
  const refs = data.map((d) => ({ d, r: dataReferences(d.decl, d.value), lines: d.text ? jsonLines(d.text) : new Map<string, number>() }));
  const dataSet = new Set(refs.flatMap(({ r }) => r.flagsSet.map((f) => f.path)));
  const dataRead = new Set(refs.flatMap(({ r }) => r.flagsRead.map((f) => f.path)));
  const out: Diagnostic[] = [];
  const reported = new Set<string>();
  for (const { d, r, lines } of refs) {
    const fileName = o.fileName(d.decl);
    const lineOf = (at: DataPath) => lines.get(dataPointer(at)) ?? 1;
    for (const f of r.flagsRead) {
      if (!f.path.startsWith("game.") || scriptSet.has(f.path) || dataSet.has(f.path) || initial.has(f.path) || reported.has(`r:${f.path}`)) continue;
      reported.add(`r:${f.path}`);
      out.push({
        severity: "warning",
        code: "data-flag-unset",
        message: `${fileName} が読むフラグ ${f.path} を、どの台本の @set もデータも立てません`,
        messageEn: `No @set in the scenario or data sets the flag ${f.path} that ${fileName} reads`,
        file: fileName,
        line: lineOf(f.at),
        hint: `台本で @set ${f.path} = true と立てるか、名前の綴りを直します`,
        hintEn: `Set it in the scenario with @set ${f.path} = true, or fix the spelling`,
      });
    }
    for (const f of r.flagsSet) {
      if (scriptRead.has(f.path) || dataRead.has(f.path) || reported.has(`s:${f.path}`)) continue;
      reported.add(`s:${f.path}`);
      out.push({
        severity: "info",
        code: "data-flag-unread",
        message: `${fileName} で立てるフラグ ${f.path} を、どの台本もデータも読みません`,
        messageEn: `No scenario or data reads the flag ${f.path} that ${fileName} sets`,
        file: fileName,
        line: lineOf(f.at),
      });
    }
  }
  return out;
}

/** 作品のデータが立てる（プラグインが値を入れる）フラグの変数（"game.x"）。変数の綴り違いの検査が、値を入れる所に数える。 */
export function dataFlagsSet(data: readonly DeclaredData[]): Set<string> {
  return new Set(data.flatMap((d) => dataReferences(d.decl, d.value).flagsSet.map((f) => f.path)));
}

/** データの中の、CG として解放する素材（宣言の asset の cg）。`フォルダ/パス` の集まり（どこからも出ない CG の検査に渡す）。 */
export function dataCgImages(data: readonly DeclaredData[]): Set<string> {
  const out = new Set<string>();
  for (const d of data) for (const a of dataReferences(d.decl, d.value).assets) if (a.cg) out.add(`${a.folder}/${a.path}`);
  return out;
}

/** 名前を変えたときの書き換え。 */
export type DataRename =
  /** シーン（ラベル）の名前。file のラベル from を to に。 */
  | { kind: "label"; file: string; from: string; to: string }
  /** シナリオのファイルの名前。 */
  | { kind: "file"; from: string; to: string }
  /** 素材（folder の中のパス）。 */
  | { kind: "asset"; folder: string; from: string; to: string }
  /** 変数（`game.x`）。 */
  | { kind: "variable"; from: string; to: string }
  /** キャストの名前。 */
  | { kind: "cast"; from: string; to: string };

/** 値の写しの中の path を value にする。 */
function setAt(root: unknown, path: DataPath, value: unknown): void {
  let o = root as Record<string | number, unknown>;
  for (const p of path.slice(0, -1)) o = o[p] as Record<string | number, unknown>;
  o[path.at(-1)!] = value;
}

/** 名前を変えたときにデータを書き換える。書き換えた写しと、書き換えた場所の数を返す（0 なら value のまま）。 */
export function renameInData(decl: DataDeclaration, value: unknown, change: DataRename): { value: unknown; count: number } {
  const edits: { path: DataPath; value: string }[] = [];
  walkData(decl.root, value, ({ field, value: v, path, records }) => {
    if (typeof v !== "string" || v === "") return;
    const put = (next: string) => next !== v && edits.push({ path, value: next });
    switch (field.kind) {
      case "scene": {
        const s = fieldScene(field, v, records);
        if (field.bare && !v.includes("#")) {
          if (change.kind === "label" && s.file === change.file && s.label === change.from) put(change.to);
          return;
        }
        const hash = v.indexOf("#");
        const writtenFile = hash < 0 ? v : v.slice(0, hash);
        if (change.kind === "label" && s.file === change.file && s.label === change.from) put(`${writtenFile}#${change.to}`);
        if (change.kind === "file" && writtenFile === change.from) put(`${change.to}${hash < 0 ? "" : v.slice(hash)}`);
        return;
      }
      case "file":
        if (change.kind === "file" && v === change.from) put(change.to);
        return;
      case "asset":
        if (change.kind === "asset" && (field.folder === change.folder || field.also?.includes(change.folder)) && v === change.from) put(change.to);
        return;
      case "cast":
        if (change.kind === "cast" && v === change.from) put(change.to);
        return;
      case "flag": {
        if (change.kind !== "variable" || flagPath(v) !== change.from) return;
        const short = !/^(game|system|temp)\./.test(v);
        put(short && change.to.startsWith("game.") ? change.to.slice(5) : change.to);
        return;
      }
      case "expr":
        if (change.kind === "variable") put(renameInExpr(v, change.from, change.to));
        return;
      default:
        return;
    }
  });
  if (edits.length === 0) return { value, count: 0 };
  const copy = structuredClone(value);
  for (const e of edits) setAt(copy, e.path, e.value);
  return { value: copy, count: edits.length };
}

/** 式の文字の中の変数 from を to にする（game.xy・a.game.x は替えない）。 */
function renameInExpr(text: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\p{ID_Continue}_.$"'])${escaped}(?![\\p{ID_Continue}_])`, "gu"), to);
}

/**
 * 三方向のマージ（base から ours と theirs へ変えたものを合わせる）。記録は欄ごと、key の欄を持つ項目の並び（`id` か
 * 引数 keyOf が返す欄）は項目ごとに合わせ、ほかの値は片方だけが変えていればその値。両方が違う値に変えていたら ours を採り、
 * その場所を conflicts に挙げる。
 */
export function mergeJson(base: unknown, ours: unknown, theirs: unknown, path: DataPath = [], conflicts: DataPath[] = []): { value: unknown; conflicts: DataPath[] } {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (same(ours, theirs)) return { value: ours, conflicts };
  if (same(base, ours)) return { value: theirs, conflicts };
  if (same(base, theirs)) return { value: ours, conflicts };
  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    const out: Record<string, unknown> = {};
    const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])];
    for (const k of keys) {
      const merged = mergeJson(base[k], ours[k], theirs[k], [...path, k], conflicts).value;
      if (merged !== undefined) out[k] = merged;
    }
    return { value: out, conflicts };
  }
  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    const key = itemKey(base) ?? itemKey(ours) ?? itemKey(theirs);
    if (key) return { value: mergeKeyed(base, ours, theirs, key, path, conflicts), conflicts };
  }
  conflicts.push(path);
  return { value: ours, conflicts };
}

/** 並びの項目を見分ける欄（どの項目も文字の id を持つなら "id"）。 */
function itemKey(list: readonly unknown[]): string | null {
  if (list.length === 0) return null;
  for (const k of ["id", "key"]) if (list.every((x) => isRecord(x) && typeof x[k] === "string")) return k;
  return null;
}

/** 項目ごとに合わせる。並びは ours の順に、theirs で足したものをその前の項目の後ろへ入れる。 */
function mergeKeyed(base: readonly unknown[], ours: readonly unknown[], theirs: readonly unknown[], key: string, path: DataPath, conflicts: DataPath[]): unknown[] {
  const id = (x: unknown) => (isRecord(x) ? String(x[key]) : "");
  const byBase = new Map(base.map((x) => [id(x), x]));
  const byOurs = new Map(ours.map((x) => [id(x), x]));
  const byTheirs = new Map(theirs.map((x) => [id(x), x]));
  const order = ours.map(id);
  theirs.forEach((x, i) => {
    const k = id(x);
    if (byOurs.has(k) || byBase.has(k)) return;
    const before = i > 0 ? id(theirs[i - 1]) : null;
    const at = before === null ? 0 : order.indexOf(before) + 1;
    order.splice(at > 0 ? at : before === null ? 0 : order.length, 0, k);
  });
  const out: unknown[] = [];
  for (const k of order) {
    const b = byBase.get(k);
    const o = byOurs.get(k);
    const t = byTheirs.get(k);
    if (b !== undefined && t === undefined) {
      // theirs が消した。ours が変えていなければ消す
      if (o !== undefined && JSON.stringify(o) !== JSON.stringify(b)) {
        conflicts.push([...path, k]);
        out.push(o);
      }
      continue;
    }
    if (b !== undefined && o === undefined) continue;
    const merged = mergeJson(b, o ?? t, t ?? o, [...path, k], conflicts).value;
    if (merged !== undefined) out.push(merged);
  }
  // ours が消したもの（order に入らないので別に見る）。theirs が変えていれば消えずに残し、争いに挙げる
  for (const [k, b] of byBase) {
    if (byOurs.has(k)) continue;
    const t = byTheirs.get(k);
    if (t !== undefined && JSON.stringify(t) !== JSON.stringify(b)) {
      conflicts.push([...path, k]);
      out.push(t);
    }
  }
  return out;
}
