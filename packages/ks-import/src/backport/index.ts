import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listScenarioFiles } from "@liminalia/project";
import { parse, projectMacros, type CommandDefaults, type CommandSpec, type ExtraConfig, type Registry } from "@liminalia/lang";
import { importTyrano, prepareImport, type TyranoImportProfile } from "../import.ts";
import { parseSourceMap, sha256, type ImportSourceMap, type SourceMapFile } from "../sourcemap.ts";
import { backportFile, collectSpeakerLines, collectTemplates, rubyStyleOf, type BackportIssue, type ProjectStyle } from "./backport-file.ts";
import { TagInverter } from "./inverse.ts";
import { diffLines } from "./line-diff.ts";
import { normalizeLimLine, readLimLines, type LimLine } from "./lim-line.ts";
import { ignoredLines, lowerLim, tbCgRule, type LowerOptions } from "./lower.ts";
import { isPlainRelative, realWithin, unsafeWriteTarget } from "../safe-path.ts";

/**
 * 書き戻し（lim backport）。取り込んだ時点の .ks・.lim・対応表と今の .lim から、今の .lim と同じ中身の .ks 一式を作る。
 *
 * - 基準の .ks（data/scenario の写し）を out に写し、.lim が変わったファイルだけを書き直す
 * - 新しく足された .lim は新しい .ks にする。消された .lim の .ks は消さずに、消す候補として報告する
 * - 最後に、書き戻した .ks を同じ取り込み設定でもう一度取り込み、今の .lim と（行の並び・本文・命令の意味で）比べる
 */
export interface BackportOptions {
  /** 取り込んだ時点の .ks（data/scenario の写し。system/ なども含めた一式）。 */
  baseKs: string;
  /** 取り込んだ時点の .lim（シナリオの出力先の写し）。 */
  baseLim: string;
  /** 取り込んだ時点の対応表（import-sourcemap.json）。 */
  sourceMap: string | ImportSourceMap;
  /** 今の .lim。 */
  currentLim: string;
  /** TyranoScript のプロジェクト（確かめの取り込みで、data/scenario 以外のもの（プラグイン・立ち絵の画像）を読む）。読むだけ。 */
  source: string;
  /** 書き戻した .ks 一式を書き出すフォルダ（data/scenario の形）。 */
  out: string;
  /** 報告（Markdown）を書き出す場所。省略すると out の隣の backport-report.md。 */
  reportOut?: string;
  registry: Registry;
  /** 取り込み設定（lim import と同じもの）。 */
  profile?: TyranoImportProfile;
  /** 今の cast.json の話者（新しい話者の台詞を見分けるため）。 */
  speakers?: Iterable<string>;
  /** 変わっていないファイルも書き直す（書き直しが元の .ks を一字一句保つかの確かめ用）。 */
  rewriteAll?: boolean;
  /**
   * 作品のおまけの一覧（liminalia.json の extra）。CG の一覧にある画像を出した行のあとに @cg-unlock が無ければ、
   * [tb_cg] を書き戻す（Liminalia は出したときに解放するが、TyranoScript の [bg] は解放しない）。
   */
  extra?: ExtraConfig | undefined;
  /**
   * 作品のコマンドの既定値（liminalia.json の commandDefaults）。今の .lim の省いたパラメータを既定値として書いてから比べるので、
   * 既定値で決めた値も .ks のタグに書き戻る（基準の .lim の省いたパラメータは、取り込んだときの標準の既定値のまま）。
   */
  commandDefaults?: CommandDefaults | undefined;
}

export interface BackportFileReport {
  /** .lim のファイル名。 */
  lim: string;
  /** .ks（data/scenario からのパス）。 */
  ks: string;
  status: "unchanged" | "changed" | "new" | "deleted";
  stats: { modified: number; inserted: number; deleted: number; failed: number };
  issues: BackportIssue[];
  /** 確かめの取り込みで、今の .lim と違っていた箇所（最初のいくつか）。 */
  mismatches: string[];
}

export interface BackportReport {
  files: BackportFileReport[];
  /** 書き戻した .ks が、取り込み直すと今の .lim とすべて同じになったか。 */
  verified: boolean;
  /** 書き戻せなかった箇所（error の issue）の数。 */
  failed: number;
  /** 書き換えた .ks（out からのパス）。 */
  written: string[];
  markdown: string;
  reportPath: string;
}

export async function backportTyrano(o: BackportOptions): Promise<BackportReport> {
  const map = typeof o.sourceMap === "string" ? parseSourceMap(readFileSync(o.sourceMap, "utf8")) : o.sourceMap;
  const prepared = prepareImport({ source: o.source, scenarioDir: o.baseKs, registry: o.registry, ...(o.profile ? { profile: o.profile } : {}) });
  const speakers = new Set([...prepared.speakers, ...(o.speakers ?? [])]);
  const mappings = o.profile?.mappings ?? [];
  // 足した @cg-unlock は extra.cg の id で [tb_cg] にする（取り込み設定の逆向きの変換があればそちらが先）
  const rules = { "cg-unlock": tbCgRule(o.extra), ...(o.profile?.backport ?? {}) };

  // 基準の一式を読む
  const entries = Object.entries(map.files).filter(([, f]) => f.source !== null);
  const base = new Map<string, { ks: string; lim: string; file: (typeof entries)[number][1] }>();
  const notes: string[] = [];
  for (const [lim, f] of entries) {
    // 対応表の .ks のパスは基準のフォルダの中だけ（../ や絶対パスで外を読み書きしない）
    if (!isPlainRelative(f.source!) || !isPlainRelative(lim)) throw new Error(`対応表の ${lim}（${f.source}）が基準のフォルダの外を指しています`);
    const ksPath = join(o.baseKs, f.source!);
    const limPath = join(o.baseLim, lim);
    if (!existsSync(ksPath) || !existsSync(limPath)) throw new Error(`基準の ${existsSync(ksPath) ? limPath : ksPath} がありません`);
    const ks = readFileSync(ksPath, "utf8");
    const limText = readFileSync(limPath, "utf8");
    if (f.sourceHash && sha256(ks) !== f.sourceHash) throw new Error(`基準の ${f.source} が対応表を作ったときの .ks と違います（取り込んだ時点の .ks のコピーを指定してください）`);
    if (sha256(limText) !== f.limHash) throw new Error(`基準の ${lim} が対応表を作ったときの .lim と違います（取り込んだ時点の .lim のコピーを指定してください）`);
    base.set(lim, { ks, lim: limText, file: f });
  }

  // プロジェクト全体の書き方
  const templates = new Map<string, string[]>();
  const speakerLines = new Map<string, string>();
  let allKs = "";
  let block: ProjectStyle["block"] = null;
  for (const b of base.values()) {
    collectTemplates(b.file.source!, b.ks, b.lim, b.file.lines, speakers, templates);
    collectSpeakerLines(b.file.source!, b.ks, prepared.charas, speakerLines);
    allKs += b.ks;
    if (!block) {
      const open = /^\s*(\[tb_start_text\b[^\]]*\])\s*$/m.exec(b.ks)?.[1];
      const close = /^\s*(\[_tb_end_text\s*\])\s*$/m.exec(b.ks)?.[1];
      if (open && close) block = { open, close };
    }
  }
  const project: ProjectStyle = { ruby: rubyStyleOf(allKs) ?? { kind: "ruby", bar: "｜" }, speakerLines, block, templates };

  // 書き出す先に基準の一式を写す
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(dirname(o.out), { recursive: true });
  // シンボリックリンクは実体を写す（実体が基準のフォルダとインポート元の外にあるものは写さない）。out の中のリンクの先に書かないため
  cpSync(o.baseKs, o.out, { recursive: true, dereference: true, filter: (src) => !lstatSync(src).isSymbolicLink() || realWithin([o.baseKs, o.source], src) });
  /** out の中の file に書く。シンボリックリンクや out の外を指すなら書かずに理由を返す。 */
  const writeOut = (file: string, text: string): string | null => {
    const unsafe = unsafeWriteTarget(o.out, file);
    if (unsafe !== null) return `${file} に書けません（${unsafe}）`;
    mkdirSync(dirname(join(o.out, file)), { recursive: true });
    writeFileSync(join(o.out, file), text);
    return null;
  };

  // .lim を TyranoScript で同じ動きになる形に直す（lower.ts）。基準も今も、CG の解放を @cg-unlock の行にしてから比べる
  // @define のマクロの省いたパラメータにも作品の既定値を書く（今の .lim のマクロの仕様）
  // 今の .lim（サブフォルダの台本も。名前は "part1/chapter2.lim" の形）
  const current = listScenarioFiles(o.currentLim).map((f) => `${f.name}.lim`);
  const macros = current.length > 0 ? projectMacros(current.map((f) => [limBase(f), parse(readFileSync(join(o.currentLim, f), "utf8"), limBase(f), { speakers })] as const)) : new Map<string, CommandSpec>();
  const lowering: LowerOptions = { registry: o.registry, speakers, extra: o.extra, commandDefaults: o.commandDefaults, macros };
  const lowerBase = (lim: string, text: string, lines: SourceMapFile["lines"]) => {
    const l = lowerLim(text, limBase(lim), { ...lowering, cgUnlocks: true });
    // 対応表は終わりの改行のあとの空の行を数えない
    const count = l.text.endsWith("\n") ? l.origin.length - 1 : l.origin.length;
    return { text: l.text, lines: l.origin.slice(0, count).map((line, i) => (l.added[i] ? null : (lines[line - 1] ?? null))) };
  };
  const lowerCurrent = (lim: string, text: string) => lowerLim(text, limBase(lim), { ...lowering, defaults: true, cgUnlocks: true });
  /** 直した今の .lim の行の書き戻せなかった箇所を、元の行番号にする。 */
  const remap = (issues: BackportIssue[], origin: readonly number[]) => issues.map((i) => (i.limLine === null ? i : { ...i, limLine: origin[i.limLine - 1] ?? i.limLine }));
  const compareOptions = { extra: o.extra };

  const files: BackportFileReport[] = [];
  const written: string[] = [];
  const libraries = new Set(Object.entries(map.files).filter(([, f]) => f.source === null).map(([lim]) => lim));
  const inverterFor = (file: string) => new TagInverter({ file, convertOptions: prepared.convertOptions, registry: o.registry, mappings, speakers, rules });

  for (const [lim, b] of base) {
    const ksFile = b.file.source!;
    const curPath = join(o.currentLim, lim);
    if (!existsSync(curPath)) {
      files.push({ lim, ks: ksFile, status: "deleted", stats: zero(), issues: [], mismatches: [] });
      continue;
    }
    const baseLowered = lowerBase(lim, b.lim, b.file.lines);
    const cur = lowerCurrent(lim, readFileSync(curPath, "utf8"));
    const result = backportFile({
      file: ksFile,
      baseKs: b.ks,
      baseLim: baseLowered.text,
      map: baseLowered.lines,
      curLim: cur.text,
      inverter: inverterFor(ksFile),
      registry: o.registry,
      speakers,
      charas: prepared.charas,
      project,
      ...(o.rewriteAll ? { rewriteAll: true } : {}),
    });
    const changed = result.ks !== b.ks;
    const issues = remap(result.issues, cur.origin);
    if (changed) {
      const refused = writeOut(ksFile, result.ks);
      if (refused === null) written.push(ksFile);
      else issues.push({ severity: "error", limLine: null, ksLine: null, message: refused });
    }
    files.push({ lim, ks: ksFile, status: changed ? "changed" : "unchanged", stats: result.stats, issues, mismatches: [] });
  }
  // 新しく足された .lim
  for (const lim of current) {
    if (base.has(lim) || libraries.has(lim)) continue;
    const ksFile = `${limBase(lim)}.ks`;
    if (existsSync(join(o.out, ksFile))) {
      files.push({ lim, ks: ksFile, status: "new", stats: zero(), issues: [{ severity: "error", limLine: null, ksLine: null, message: `同じ名前の .ks（${ksFile}）が基準にあるため、新しい .ks を作れません` }], mismatches: [] });
      continue;
    }
    const cur = lowerCurrent(lim, readFileSync(join(o.currentLim, lim), "utf8"));
    const result = backportFile({
      file: ksFile,
      baseKs: "",
      baseLim: "",
      map: [],
      curLim: cur.text,
      inverter: inverterFor(ksFile),
      registry: o.registry,
      speakers,
      charas: prepared.charas,
      project,
    });
    const issues = remap(result.issues, cur.origin);
    const refused = writeOut(ksFile, result.ks);
    if (refused === null) written.push(ksFile);
    else issues.push({ severity: "error", limLine: null, ksLine: null, message: refused });
    if (project.block) issues.push({ severity: "info", limLine: null, ksLine: null, message: "新しいファイルです。TyranoBuilder の [_tb_system_call] は書いていません。TyranoBuilder の編集画面で使うときは、シーンとして登録してください" });
    files.push({ lim, ks: ksFile, status: "new", stats: result.stats, issues, mismatches: [] });
  }
  // マクロを集めたファイルは行の対応を持たない
  for (const lim of libraries) {
    const curPath = join(o.currentLim, lim);
    const now = existsSync(curPath) ? readFileSync(curPath, "utf8") : null;
    if (now === null || sha256(now) !== map.files[lim]!.limHash) notes.push(`${lim}（マクロを集めたファイル）の変更は書き戻せません。.ks の [macro] を手で直してください`);
  }

  // ---- 確かめ: 書き戻した .ks を取り込み直して、今の .lim と比べる ----
  const work = mkdtempSync(join(tmpdir(), "liminalia-backport-"));
  let verified = true;
  try {
    // 基準の .ks を今の取り込みの変換で取り込み直し、基準の .lim と同じか（エンジンの変換が基準を作ったときから変わっていないか）
    await importTyrano({
      source: o.source,
      scenarioDir: o.baseKs,
      scenarioOut: join(work, "base"),
      dataOut: join(work, "base-data"),
      castOut: join(work, "base-cast.json"),
      reportOut: join(work, "base-report.md"),
      registry: o.registry,
      ...(o.profile ? { profile: o.profile } : {}),
      extra: o.extra,
    });
    const drift = [...base].filter(([lim, b]) => !existsSync(join(work, "base", lim)) || compareLim(readFileSync(join(work, "base", lim), "utf8"), b.lim, speakers, o.registry, compareOptions).length > 0).map(([lim]) => lim);
    if (drift.length > 0) {
      notes.push(
        `基準の .ks を今の取り込みで取り込み直すと、基準の .lim と違うファイルがあります（${drift.slice(0, 8).join(" ")}${drift.length > 8 ? " ほか" : ""}）。` +
          "基準を作ったときから取り込みの変換（エンジン・取り込み設定）が変わっているため、確かめの違いにはその分が混じります",
      );
    }
    await importTyrano({
      source: o.source,
      scenarioDir: o.out,
      scenarioOut: join(work, "scenario"),
      dataOut: join(work, "data"),
      castOut: join(work, "cast.json"),
      reportOut: join(work, "import-report.md"),
      registry: o.registry,
      ...(o.profile ? { profile: o.profile } : {}),
      extra: o.extra,
    });
    for (const f of files) {
      if (f.status === "deleted") continue;
      const again = join(work, "scenario", f.lim);
      // 今の .lim は既定値を書いてから比べる（取り込み直したものは .ks に書いた値をそのまま持つ）
      const now = lowerLim(readFileSync(join(o.currentLim, f.lim), "utf8"), limBase(f.lim), { ...lowering, defaults: true });
      f.mismatches = existsSync(again) ? compareLim(readFileSync(again, "utf8"), now.text, speakers, o.registry, { ...compareOptions, origin: now.origin }) : ["取り込み直した .lim がありません"];
      if (f.mismatches.length > 0) verified = false;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const failed = files.reduce((n, f) => n + f.issues.filter((i) => i.severity === "error").length, 0);
  const reportPath = o.reportOut ?? join(dirname(o.out), "backport-report.md");
  const markdown = reportMarkdown(files, verified, notes, o);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown);
  return { files, verified, failed, written, markdown, reportPath };
}

/** .lim のファイル名（"part1/chapter2.lim"）から拡張子を除いた台本の名前。 */
function limBase(lim: string): string {
  return lim.replace(/\.lim$/, "");
}

function zero() {
  return { modified: 0, inserted: 0, deleted: 0, failed: 0 };
}

/**
 * 取り込み直した .lim（again）と今の .lim（now）を、行の並び・本文・命令の意味で比べる。空行とコメントは比べない。
 * extra があれば、表示したときに解放されるので要らない @cg-unlock も比べない（取り込みは書き出さない）。
 * 違う箇所を「今の .lim の行番号: 内容」で返す（最初の 20 件）。
 */
export function compareLim(again: string, now: string, speakers: Iterable<string>, registry?: Registry, o: { extra?: ExtraConfig | undefined; origin?: readonly number[] } = {}): string[] {
  const norm = (text: string) => {
    const rows = text.split("\n");
    const skip = registry ? ignoredLines(text, "lim", { registry, speakers, extra: o.extra }) : new Set<number>();
    // 行の if=(式) は、取り込み（.ks の cond=）が書く @if 〜 @end の三行と同じに比べる
    return readLimLines(text, speakers)
      .flatMap((l, i) => {
        const at = { line: i + 1, raw: rows[i]!.trim() };
        if (skip.has(i + 1)) return [{ key: null, ...at }];
        if ((l.kind === "command" || l.kind === "set" || l.kind === "jump") && l.cond !== undefined) {
          const { cond, ...plain } = l;
          return [{ key: `if:${cond.replace(/\s+/g, "")}`, ...at }, { key: normalizeLimLine(plain as LimLine, registry), ...at }, { key: "end:if", ...at }];
        }
        return [{ key: normalizeLimLine(l, registry), ...at }];
      })
      .filter((x): x is { key: string; line: number; raw: string } => x.key !== null);
  };
  const a = norm(again);
  const b = norm(now);
  const ops = diffLines(
    a.map((x) => x.key),
    b.map((x) => x.key),
  );
  const out: string[] = [];
  for (const op of ops) {
    if (op.op === "equal") continue;
    if (out.length >= 20) {
      out.push("…");
      break;
    }
    if (op.op === "insert") out.push(`今の .lim ${o.origin?.[b[op.b]!.line - 1] ?? b[op.b]!.line} 行目が、取り込み直すと出てこない: ${b[op.b]!.raw}`);
    else out.push(`取り込み直すと余分に出る行（書き戻した .ks の取り込みの ${a[op.a]!.line} 行目）: ${a[op.a]!.raw}`);
  }
  return out;
}

function reportMarkdown(files: readonly BackportFileReport[], verified: boolean, notes: readonly string[], o: BackportOptions): string {
  const lines: string[] = [];
  const changed = files.filter((f) => f.status === "changed" || f.status === "new");
  const sum = (k: keyof BackportFileReport["stats"]) => files.reduce((n, f) => n + f.stats[k], 0);
  const errors = files.flatMap((f) => f.issues.filter((i) => i.severity === "error").map((i) => ({ f, i })));
  lines.push(`# 書き戻しの報告`, "");
  lines.push(`- 書き戻した .ks: ${changed.length} ファイル（新しいファイル ${files.filter((f) => f.status === "new").length}）`);
  lines.push(`- .lim の行: 書き換え ${sum("modified")}・追加 ${sum("inserted")}・削除 ${sum("deleted")}`);
  lines.push(`- 書き戻せなかった箇所: ${errors.length} 件`);
  lines.push(`- 確かめ（書き戻した .ks を取り込み直して今の .lim と比べる）: ${verified ? "すべて一致" : `${files.filter((f) => f.mismatches.length > 0).length} ファイルで違いあり`}`);
  lines.push(`- 書き出し先: ${o.out}`);
  const deleted = files.filter((f) => f.status === "deleted");
  if (deleted.length > 0) {
    lines.push("", "## 消された .lim（.ks を消す候補）", "", "書き出し先には基準の .ks を残しています。消すかどうかは作者が決めてください。", "");
    for (const f of deleted) lines.push(`- ${f.lim} → ${f.ks}`);
  }
  if (notes.length > 0) {
    lines.push("", "## 注意", "");
    for (const n of notes) lines.push(`- ${n}`);
  }
  if (errors.length > 0) {
    lines.push("", "## 書き戻せなかった箇所", "");
    for (const { f, i } of errors) lines.push(`- ${f.lim}${i.limLine ? `:${i.limLine}` : ""}${i.ksLine ? `（${f.ks}:${i.ksLine}）` : ""} ${i.message}`);
  }
  const warnings = files.flatMap((f) => f.issues.filter((i) => i.severity !== "error").map((i) => ({ f, i })));
  if (warnings.length > 0) {
    lines.push("", "## 気をつけること", "");
    for (const { f, i } of warnings) lines.push(`- ${f.lim}${i.limLine ? `:${i.limLine}` : ""} ${i.message}`);
  }
  const mismatched = files.filter((f) => f.mismatches.length > 0);
  if (mismatched.length > 0) {
    lines.push("", "## 確かめで違っていた箇所", "");
    for (const f of mismatched) {
      lines.push(`### ${f.lim}`, "");
      for (const m of f.mismatches) lines.push(`- ${m}`);
      lines.push("");
    }
  }
  if (changed.length > 0) {
    lines.push("", "## ファイルごと", "", "| .lim | .ks | 書き換え | 追加 | 削除 | 書き戻せない | 確かめ |", "|---|---|---:|---:|---:|---:|---|");
    for (const f of changed) {
      lines.push(`| ${f.lim} | ${f.ks}${f.status === "new" ? "（新規）" : ""} | ${f.stats.modified} | ${f.stats.inserted} | ${f.stats.deleted} | ${f.issues.filter((i) => i.severity === "error").length} | ${f.mismatches.length === 0 ? "一致" : "違いあり"} |`);
    }
  }
  return lines.join("\n") + "\n";
}

export type { BackportIssue } from "./backport-file.ts";
export type { BackportRule } from "./inverse.ts";
