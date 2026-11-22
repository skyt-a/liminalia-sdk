import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { check, defineSpec, parse, plainText, type Cast, type CommandSpec, type ExtraConfig, type Registry, type Statement } from "@liminalia/lang";
import { ignoredLines } from "./backport/lower.ts";
import { castEntry, collectCharaConfig, collectCharas, speakerName, type CharaDefs } from "./chara.ts";
import { compile } from "./compile.ts";
import { convert, normalizeStorage, type ConvertOptions, type Outcome, type TagProfile } from "./convert.ts";
import { formatSourceMap, sha256, type ImportSourceMap } from "./sourcemap.ts";
import type { BackportRule } from "./backport/inverse.ts";
import { buildMacros, collectCallKeys, findMacros, reachableMacros, UNSUPPORTED, type MacroSource } from "./macros.ts";
import type { RawCommand } from "./types.ts";
import { imageSize } from "./image-size.ts";
import { castFromTatieSettings, mergeCast } from "./tatie.ts";
import { inlineRubyPlain } from "./inline-ruby.ts";
import { lex } from "./lexer.ts";
import type { TagMapping } from "./mapping.ts";
import { resolveImportProfile } from "./profile.ts";
import { readWindowAssignments } from "./js-literal.ts";
import { realWithin } from "./safe-path.ts";

/**
 * TyranoScript のプロジェクトを .lim に取り込む。
 *
 * - data/scenario 以下の .ks を変換する（サブフォルダのものは "part1/chapter2.lim" の名前に。system/ 下・_ 始まりの生成物・
 *   profile.skipFiles に挙げたもの・skipFiles のファイルからだけ呼ばれるサブフォルダのものは除く。scenarioFiles）
 * - 立ち絵の定義（[chara_new] / [chara_face]）と [chara_config] は、変換しないもの（system/ など）を含む
 *   data/scenario 以下の全 .ks から集め、cast.json と本文の変換に使う（_ 始まりの生成物は除く）
 * - 立ち絵プラグイン tatie の設定（data/others/plugin/tatie/settings.js）があれば読んで cast.json に重ねる
 * - マクロ（[macro]）は、本文のファイル・data/scenario/system/ 下・[plugin] で読むプラグインの init.ks から集めて
 *   一つのファイル（library、既定は macros.lim）の @define にし、呼ぶファイルの先頭に @use を書く
 * - [plugin] で読むプラグインの JS は取り込めないので、手作業の対象として報告する
 * - 取り込み元から読むファイルは、実体（シンボリックリンクをたどった先）が取り込み元のフォルダの中にあるものだけ。
 *   外を指すもの（[call storage=../../…] やフォルダの外へのリンク）は読まずに、手作業の対象として報告する
 * - 書き出した .lim を読み直して構文と命令の型を検査する
 * - 本文（ページごとの文字列と話者）が .ks と一字一句同じかを照合する
 * - 報告を Markdown で書き出す
 * タグの変換（標準の命令の変換表・プラグインの変換表）・[iscript] の置き換え・作品固有のデータの書き出しは profile で渡す
 * （lim import は組み込みの標準の変換表とプラグインごとの "./import" を combineImportProfiles で重ねて渡す）。
 */
export interface TyranoImportProfile {
  /** 変換しない .ks（data/scenario からのパスの拡張子なし。直下なら名前だけ）。タイトル画面など、エンジンやプラグインが画面を持つ仕組み側のファイル。 */
  skipFiles?: readonly string[];
  /** .ks のタグから .lim の命令への変換表。命令の仕様は ImportOptions の registry から引く。 */
  mappings?: readonly TagMapping[];
  /** 変換表で書けないタグの変換（タグ名 → 変換）。変換表より優先する。 */
  tags?: TagProfile;
  /**
   * .ks のタグのうち、このエンジンでは扱わないもの（タグ名 → 理由）。取り込むと汎用の形にはせず、
   * TODO のコメントと理由付きのエラーにする。リファレンスにも理由とともに載る。
   */
  unsupportedTags?: Readonly<Record<string, string>>;
  /** この取り込み設定（tags など）が働きを引き受ける TyranoScript のプラグイン（[plugin name=…]）。JS があっても手作業として報告しない。 */
  plugins?: readonly string[];
  /** [iscript] / [eval] をプラグインの命令に置き換える。置き換えた .lim の行を返す。当てはまらなければ null。 */
  scriptProfile?: (code: string) => string[] | null;
  /** scriptProfile と同じ働きの規則の並び（scriptProfile のあとに前から試す）。 */
  scriptRules?: readonly ((code: string) => string[] | null)[];
  /** 取り込んだあとに作品固有のものを書き出す。返した cast は cast.json に入る（同じ名前なら [chara_new] から作ったものより優先）。 */
  afterImport?(ctx: AfterImportContext): Promise<AfterImportResult | void> | AfterImportResult | void;
  /**
   * 開発サーバーの立ち絵の位置調整画面で cast.json を保存したとき、取り込み元にも書き戻す（次の取り込みで戻らないように）。
   * 書き換えたファイルを返す。無ければ、取り込み元に tatie の設定があればそれに書き戻す（writeTatieSettings）。
   */
  writeCast?(ctx: WriteCastContext): Promise<string[] | void> | string[] | void;
  /**
   * 書き戻し（lim backport）で、.lim の命令の行を .ks のタグに戻す逆向きの変換（命令名 → 変換）。
   * 書き戻しはふつう変換表（mappings）と元のタグを手本に引数を書き換えて探すので要らない。tags で書いた変換のように
   * 手本だけでは戻せない命令に使う。
   */
  backport?: Readonly<Record<string, BackportRule>>;
}

export interface WriteCastContext {
  /** TyranoScript のプロジェクト。 */
  source: string;
  /** 保存したキャスト（cast.json の cast）。 */
  cast: Cast;
  /** 書き戻すファイルの前の版を残すフォルダ（プロジェクトの .liminalia/backups）。writeTatieSettings に渡せる。 */
  backupDir: string;
}

export interface AfterImportContext {
  /** TyranoScript のプロジェクト。 */
  source: string;
  scenarioOut: string;
  dataOut: string;
  speakers: ReadonlySet<string>;
  /** 立ち絵の命令に出てきたキャスト名。 */
  castNames: ReadonlySet<string>;
}

export interface AfterImportResult {
  cast?: Record<string, unknown>;
  /** 報告に載せる行。 */
  notes?: string[];
}

export interface ImportOptions {
  source: string;
  /** 取り込む .ks のフォルダ。既定は source の data/scenario（書き戻しの確かめで、書き戻した .ks を同じ設定で取り込むときに使う）。 */
  scenarioDir?: string;
  scenarioOut: string;
  dataOut: string;
  castOut: string;
  reportOut: string;
  /** 読み直しの検査に使う命令のレジストリ（組み込み＋プラグイン）。 */
  registry: Registry;
  profile?: TyranoImportProfile;
  /** マクロの @define を集めるファイル（拡張子なし）。既定は macros（同じ名前の .ks があれば tyrano_macros）。 */
  library?: string;
  /** 対応表（書き出した .lim の各行が .ks のどこから来たか。lim backport が使う）を書き出す場所。省略すると書き出さない。 */
  sourceMapOut?: string;
  /**
   * 書き出す作品のおまけの一覧（liminalia.json の extra）。CG の一覧にある画像を [bg] で出したすぐあとの [tb_cg] は、
   * 表示したときに解放されるので @cg-unlock を書き出さない。
   */
  extra?: ExtraConfig | undefined;
}

export interface ImportReport {
  files: number;
  totals: Record<Outcome, number>;
  genericTags: Map<string, number>;
  manual: string[];
  syntaxErrors: string[];
  checkErrors: string[];
  fidelity: { file: string; pages: number; mismatch: string | null }[];
  skipped: string[];
  /** マクロを集めたファイル（@define が一つもなければ null）と、@define にしたマクロの数。 */
  library: string | null;
  macros: number;
  /** このエンジンでは扱わないタグ（タグ名 → 件数）。理由は UNSUPPORTED と診断にある。 */
  unsupported: Map<string, number>;
  /** 未対応・手作業・構文エラー・検査エラーが 0 で、本文がすべて一致しているか。 */
  ok: boolean;
  markdown: string;
  /** 対応表。 */
  sourceMap: ImportSourceMap;
}

/**
 * 取り込みの準備（変換する .ks・立ち絵の定義・マクロ・変換に渡す設定）。importTyrano と、
 * 書き戻し（lim backport）が一つのタグを同じ設定で変換し直すときに使う。
 */
export function prepareImport(o: Pick<ImportOptions, "source" | "scenarioDir" | "registry" | "profile" | "library">) {
  const scenarioDir = o.scenarioDir ?? join(o.source, "data/scenario");
  if (!existsSync(scenarioDir)) throw new Error(`${scenarioDir} がありません（TyranoScript のプロジェクトではありません）`);
  // 読んでよいのは取り込み元のフォルダ（と、書き戻しの確かめで渡す .ks のフォルダ）の中だけ
  const guard = sourceGuard([o.source, ...(o.scenarioDir ? [o.scenarioDir] : [])], o.source);
  const { files, skipped } = scenarioFiles(scenarioDir, new Set(o.profile?.skipFiles ?? []), (f) => guard.ok(join(scenarioDir, f)));
  const sources = new Map(files.map((f) => [f, readFileSync(join(scenarioDir, f), "utf8")]));

  // 立ち絵の定義と設定は全 .ks から。設定は、本文として変換しないファイル（first.ks を先に）のものを全ファイルの初期値にする
  // （本文のファイルの中の [chara_config] は、そのファイルの中でその位置から効く）。
  const everyKs = listKs(scenarioDir).filter((file) => guard.ok(join(scenarioDir, file))).map((file) => ({ file, source: readFileSync(join(scenarioDir, file), "utf8") }));
  const { defs: charas, notes: charaNotes } = collectCharas(everyKs);
  const setup = everyKs.filter(({ file }) => file === "first.ks" || !sources.has(file)).sort((a, b) => Number(b.file === "first.ks") - Number(a.file === "first.ks"));
  const { config: charaConfig, notes: configNotes } = collectCharaConfig(setup);
  const tatie = readTatieSettings(o.source);
  const naturalSize = (image: string) => {
    const file = join(o.source, "data/fgimage", image);
    return existsSync(file) && guard.ok(file) ? imageSize(readFileSync(file)) : null;
  };
  /** [chara_new] 由来のキャストに tatie の設定を重ねたもの（同じキャストは tatie の立ち絵セット・差分が勝つ）。 */
  const buildCast = (extra: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(), notes?: string[]): Cast => {
    const fromCharas: Cast = {};
    for (const [name, def] of charas.charas) fromCharas[name] = castEntry(def, extra.get(name), naturalSize, (n) => notes?.push(n));
    return mergeCast(fromCharas, tatie.cast);
  };
  const knownCast = buildCast();

  // マクロを書いたファイル（system/ 下と、[plugin]・[call] で読むプラグインの .ks）を集める。
  const discovered = discoverMacroFiles(scenarioDir, join(o.source, "data/scenario"), [...files, ...skipped], guard.ok);
  const skipCalls = new Set([...discovered.files.keys()]);

  // 1 回目: 話者を集める（地の文の行頭が話者名に紛れるときのエスケープに使う）
  const speakers = new Set<string>();
  for (const [f, src] of [...sources, ...discovered.files]) {
    for (const c of lex(src, f).commands) {
      const name = c.name === "chara_ptext" ? speakerName(c.pm.name?.trim() ?? "", charas) : "";
      if (name !== "") speakers.add(name);
    }
  }

  // マクロを @define にして一つのファイルに集める。TyranoScript で先に定義されるもの（system/・プラグイン）を先に見る。
  const library = o.library ?? (files.includes("macros.ks") ? "tyrano_macros" : "macros");
  const baseOptions: Parameters<typeof convert>[2] = { speakers, charas, charaConfig, cast: knownCast, skipCalls, registry: o.registry };
  if (o.profile) {
    const resolved = resolveImportProfile(o.profile, o.registry);
    baseOptions.profile = resolved.tags;
    baseOptions.scriptProfile = resolved.scriptProfile;
  }
  const irs = new Map(
    [...discovered.files, ...skipped.map((f) => [f, readFileSync(join(scenarioDir, f), "utf8")] as const), ...sources].map(([f, src]) => [f, compile(src, f)]),
  );
  const allMacros: MacroSource[] = [...irs].flatMap(([f, ir]) => findMacros(ir, f));
  const { used: macroSources, unused: unusedMacros } = reachableMacros(allMacros, files.map((f) => irs.get(f)!));
  const callKeys = new Map<string, Set<string>>();
  const macroNames = new Set(macroSources.map((m) => m.name));
  for (const ir of irs.values()) collectCallKeys(ir, macroNames, callKeys);
  const macros = buildMacros(macroSources, baseOptions, callKeys, { file: library, target: (f) => (files.includes(f) ? limName(f) : null) });
  /** 本文のファイルを変換するときの設定。 */
  const convertOptions: ConvertOptions = { ...baseOptions, macros: macros.signatures };
  return { scenarioDir, files, skipped, sources, charas, charaNotes, configNotes, tatie, buildCast, discovered, speakers, library, macros, unusedMacros, convertOptions, outside: guard.outside };
}

/**
 * 取り込み元から読むファイルの確かめ。ok は、実体が roots のどれかの中にあるか（無いファイルも false）。
 * 外を指すものは outside に（base からのパスで）挙げる。
 */
function sourceGuard(roots: readonly string[], base: string) {
  const outside: string[] = [];
  const ok = (path: string): boolean => {
    if (realWithin(roots, path)) return true;
    if (!existsSync(path)) return false;
    const rel = relative(base, path).split(sep).join("/");
    if (!outside.includes(rel)) outside.push(rel);
    return false;
  };
  return { ok, outside };
}

export async function importTyrano(o: ImportOptions): Promise<ImportReport> {
  const { files, skipped, sources, charas, charaNotes, configNotes, tatie, buildCast, discovered, speakers, library, macros, unusedMacros, convertOptions, outside } = prepareImport(o);
  const sizeNotes: string[] = [];

  mkdirSync(o.scenarioOut, { recursive: true });
  mkdirSync(o.dataOut, { recursive: true });
  // 前の取り込みで書き出した、今回は変換しないファイルが残っていれば消す
  for (const f of skipped) rmSync(join(o.scenarioOut, `${limName(f)}.lim`), { force: true });

  const totals: Record<Outcome, number> = { mapped: 0, dropped: 0, generic: 0, manual: 0 };
  const genericTags = new Map<string, number>();
  const unsupported = new Map<string, number>();
  const diagnosticsByCode = new Map<string, number>();
  const manual: string[] = [];
  const fidelity: ImportReport["fidelity"] = [];
  const syntaxErrors: string[] = [];
  const checkErrors: string[] = [];
  const castNames = new Set<string>();
  /** storage で直接指定された画像（キャスト名 → 表情名 → 画像）。 */
  const castVariants = new Map<string, Map<string, string>>();
  const variantNotes: string[] = [];

  const tally = (stats: ReturnType<typeof convert>["stats"]) => {
    for (const [tag, outcomes] of Object.entries(stats.byTag)) {
      for (const [k, n] of Object.entries(outcomes) as [Outcome, number][]) {
        totals[k] += n;
        if (k === "generic") genericTags.set(tag, (genericTags.get(tag) ?? 0) + n);
        if (tag in UNSUPPORTED && (k === "dropped" || k === "manual")) unsupported.set(tag, (unsupported.get(tag) ?? 0) + n);
      }
    }
  };
  const record = (diagnostics: ReturnType<typeof convert>["diagnostics"]) => {
    for (const d of diagnostics) {
      diagnosticsByCode.set(d.code, (diagnosticsByCode.get(d.code) ?? 0) + 1);
      if (d.severity === "error") manual.push(`${d.file}:${d.line} [${d.code}] ${d.message}`);
    }
  };
  const compare = (file: string, expected: string[], actual: string[]) => {
    let mismatch: string | null = null;
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (expected[i] !== actual[i]) {
        mismatch = `${i + 1} ページ目\n    ks : ${JSON.stringify(expected[i])}\n    lim: ${JSON.stringify(actual[i])}`;
        break;
      }
    }
    fidelity.push({ file, pages: expected.length, mismatch });
  };
  /** 読み直して、構文と命令の型を検査する。 */
  const recheck = (name: string, text: string, defines: ReadonlyMap<string, CommandSpec>) => {
    const script = parse(text, name, { speakers });
    for (const d of script.diagnostics) syntaxErrors.push(`${name}.lim:${d.line} [${d.code}] ${d.message}`);
    for (const d of check(script, { registry: o.registry, defines })) {
      if (d.code === "unknown-command") continue; // 汎用の形で書き出した未対応のタグ（generic として数えている）
      if (d.severity === "error") checkErrors.push(`${name}.lim:${d.line} [${d.code}] ${d.message}`);
    }
    return script;
  };
  const mergeVariants = (variants: ReturnType<typeof convert>["variants"]) => {
    for (const [who, map] of variants) {
      const merged = castVariants.get(who) ?? new Map<string, string>();
      castVariants.set(who, merged);
      for (const [variant, image] of map) {
        const known = merged.get(variant);
        if (known !== undefined && known !== image) variantNotes.push(`${who} の表情 ${variant} に ${known} と ${image} の二つの画像が当たっています（${known} を使います）`);
        else merged.set(variant, image);
      }
    }
  };

  // マクロを集めたファイル
  tally(macros.stats);
  record(macros.diagnostics);
  for (const c of macros.cast) castNames.add(c);
  mergeVariants(macros.variants);
  const libraryPath = join(o.scenarioOut, `${library}.lim`);
  let librarySpecs = new Map<string, CommandSpec>();
  if (macros.defines.length > 0) {
    const text = [`// TyranoScript のマクロを取り込んだもの（lim import が書き出す）`, "", ...macros.defines.flatMap((d) => [...d.lines, ""])].join("\n");
    writeFileSync(libraryPath, text);
    const script = recheck(library, text, new Map());
    librarySpecs = new Map(script.body.flatMap((st) => (st.kind === "define" ? [[st.name, defineSpec(st)!] as const] : [])));
    compare(`${library}.lim（マクロ）`, macros.defines.flatMap((d) => pagesOf(d.source.ir.commands.slice(d.source.start + 1, d.source.end), charas)), limPages(script.body));
  } else {
    rmSync(libraryPath, { force: true });
  }

  // プラグインの JS は取り込めない（取り込みが働きを引き受けるものは除く）
  const handled = new Set([...Object.keys(HANDLED_PLUGINS), ...(o.profile?.plugins ?? [])]);
  const pluginsWithJs = discovered.plugins.filter((p) => p.js.length > 0 && !handled.has(p.name));
  for (const p of pluginsWithJs) {
    const message = `プラグイン ${p.name} の JS（${p.js.join(", ")}）は取り込めません。同じ働きを Liminalia のプラグイン（@liminalia/sdk の命令の表と @liminalia/web の描画）で作ってください`;
    manual.push(`${p.file}:${p.line} [plugin-js] ${message}`);
    diagnosticsByCode.set("plugin-js", (diagnosticsByCode.get("plugin-js") ?? 0) + 1);
  }

  const sourceMap: ImportSourceMap = { version: 1, files: {} };
  // 取り込み元のフォルダの外を指すため読まなかったファイル（立ち絵の画像の大きさは cast を作るときに読むので、最後に数える）
  const reportOutside = () => {
    for (const rel of outside) {
      manual.push(`${rel} [outside-project] インポート元のプロジェクトの外を指すため、読み込みません（シンボリックリンクか ../ を含むパスです）`);
      diagnosticsByCode.set("outside-project", (diagnosticsByCode.get("outside-project") ?? 0) + 1);
    }
  };
  if (macros.defines.length > 0) sourceMap.files[`${library}.lim`] = { source: null, sourceHash: null, limHash: sha256(readFileSync(libraryPath, "utf8")), lines: [] };
  let droppedUnlocks = 0;
  for (const [f, src] of sources) {
    const name = limName(f);
    const result = convert(src, f, convertOptions);
    // 表示したときに解放される CG の @cg-unlock は書き出さない（[tb_cg] は .lim のどの行にも対応しない .ks の行になる）
    const drop = ignoredLines(result.text, name, { registry: o.registry, speakers, extra: o.extra });
    if (drop.size > 0) {
      droppedUnlocks += drop.size;
      result.text = result.text.split("\n").filter((_, i) => !drop.has(i + 1)).join("\n");
      result.map = result.map.filter((_, i) => !drop.has(i + 1));
    }
    mkdirSync(dirname(join(o.scenarioOut, `${name}.lim`)), { recursive: true });
    writeFileSync(join(o.scenarioOut, `${name}.lim`), result.text);
    sourceMap.files[`${name}.lim`] = { source: f, sourceHash: sha256(src), limHash: sha256(result.text), lines: result.map };
    for (const c of result.cast) castNames.add(c);
    mergeVariants(result.variants);
    tally(result.stats);
    record(result.diagnostics);
    const script = recheck(name, result.text, result.uses.has(library) ? librarySpecs : new Map());
    // 本文の照合
    compare(f, ksPages(src, f, charas), limPages(script.body));
  }

  const extra = (await o.profile?.afterImport?.({ source: o.source, scenarioOut: o.scenarioOut, dataOut: o.dataOut, speakers, castNames })) ?? {};
  const built = buildCast(castVariants, sizeNotes);
  const cast: Record<string, unknown> = {};
  for (const name of [...new Set([...Object.keys(built), ...castNames, ...Object.keys(extra.cast ?? {})])].sort()) {
    cast[name] = extra.cast?.[name] ?? built[name] ?? {};
  }
  mkdirSync(dirname(o.castOut), { recursive: true });
  writeFileSync(o.castOut, JSON.stringify({ speakers: [...speakers].sort(), cast }, null, 2) + "\n");
  reportOutside();

  // ---- 報告 ----
  const all = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const pct = (n: number) => `${((n / all) * 100).toFixed(2)}%`;
  const okFiles = fidelity.filter((x) => x.mismatch === null);
  const lines: string[] = [];
  lines.push(`# 取り込みの報告（${files.length} ファイル）`, "");
  lines.push(`| 結果 | 件数 | 割合 |`, `|---|---:|---:|`);
  for (const k of ["mapped", "dropped", "generic", "manual"] as Outcome[]) lines.push(`| ${k} | ${totals[k]} | ${pct(totals[k])} |`);
  lines.push("", `- 構文エラー（読み直し）: ${syntaxErrors.length} 件`, `- 命令の検査エラー: ${checkErrors.length} 件`);
  lines.push(`- 本文の一致: ${okFiles.length} / ${fidelity.length} ファイル（${fidelity.reduce((a, x) => a + x.pages, 0)} ページ）`);
  lines.push(`- 変換しないファイル: ${skipped.join(" / ") || "なし"}`);
  lines.push(macros.defines.length > 0 ? `- マクロ: ${macros.defines.length} 個を ${library}.lim の @define にしました（使うファイルには @use ${library} を書いています）` : "- マクロ: @define にしたものはありません");
  if (unusedMacros.length > 0) {
    const names = [...new Set(unusedMacros.map((m) => m.name))];
    lines.push(`- 本文から呼ばれないマクロ ${names.length} 個は変換していません（${names.slice(0, 12).join("・")}${names.length > 12 ? " ほか" : ""}）`);
  }
  if (droppedUnlocks > 0) lines.push(`- 表示したときに解放される CG の [tb_cg] ${droppedUnlocks} 個は、@cg-unlock を書き出していません（@bg で出したときに解放されます）`);
  for (const note of extra.notes ?? []) lines.push(`- ${note}`);
  const charaReport = [...tatie.notes, ...charaNotes, ...configNotes, ...variantNotes, ...sizeNotes];
  if (charaReport.length > 0) {
    lines.push("", "## 立ち絵の定義と設定", "");
    for (const note of charaReport) lines.push(`- ${note}`);
  }
  lines.push("", "## 未対応のタグ（汎用の形で書き出したもの）", "");
  for (const [t, n] of [...genericTags].sort((a, b) => b[1] - a[1])) lines.push(`- ${t}: ${n}`);
  if (unsupported.size > 0) {
    lines.push("", "## このエンジンでは扱わないタグ", "");
    for (const [t, n] of [...unsupported].sort((a, b) => b[1] - a[1])) lines.push(`- ${t}: ${n}（${UNSUPPORTED[t]!.manual ? "手作業" : "書き出さない"}）${UNSUPPORTED[t]!.reason}`);
  }
  lines.push("", "## 診断の内訳", "");
  for (const [c, n] of [...diagnosticsByCode].sort((a, b) => b[1] - a[1])) lines.push(`- ${c}: ${n}`);
  lines.push("", "## 手作業が必要な箇所", "");
  for (const m of manual) lines.push(`- ${m}`);
  for (const [title, list] of [["構文エラー", syntaxErrors], ["命令の検査エラー", checkErrors]] as const) {
    if (list.length === 0) continue;
    lines.push("", `## ${title}`, "");
    for (const e of list) lines.push(`- ${e}`);
  }
  const mismatches = fidelity.filter((x) => x.mismatch !== null);
  if (mismatches.length > 0) {
    lines.push("", "## 本文の不一致（各ファイル最初の一件）", "");
    for (const m of mismatches) lines.push(`- ${m.file}: ${m.mismatch}`);
  }
  const markdown = lines.join("\n") + "\n";
  mkdirSync(dirname(o.reportOut), { recursive: true });
  writeFileSync(o.reportOut, markdown);
  if (o.sourceMapOut) {
    mkdirSync(dirname(o.sourceMapOut), { recursive: true });
    writeFileSync(o.sourceMapOut, formatSourceMap(sourceMap));
  }

  return {
    files: files.length,
    totals,
    genericTags,
    manual,
    syntaxErrors,
    checkErrors,
    fidelity,
    skipped,
    library: macros.defines.length > 0 ? library : null,
    macros: macros.defines.length,
    unsupported,
    ok:
      totals.generic === 0 &&
      totals.manual === 0 &&
      syntaxErrors.length === 0 &&
      checkErrors.length === 0 &&
      mismatches.length === 0 &&
      pluginsWithJs.length === 0 &&
      outside.length === 0,
    markdown,
    sourceMap,
  };
}

/** 取り込みが働きを引き受ける TyranoScript のプラグイン（JS があっても手作業にしない）。 */
const HANDLED_PLUGINS: Record<string, string> = {
  tatie: "立ち絵の設定（settings.js）は cast.json に取り込む",
  auto_ruby: "本文の ｜対象《ルビ》 はルビに変換する",
  tb_filter: "TyranoBuilder のフィルタのタグ（tb_filter_* / tb_free_filter）は標準の @filter / @filter-off に変換する",
};

/**
 * 本文として変換しないが、マクロを集めるために読む .ks（data/scenario からのパス → 中身）。
 * data/scenario/system/ 下の .ks と、そこや本文から [plugin]・[call] で読むファイル（プラグインの init.ks など）。
 * あわせて、[plugin] で読むプラグインに JS があるかを調べる。
 */
function discoverMacroFiles(scenarioDir: string, sourceScenarioDir: string, converted: readonly string[], readable: (path: string) => boolean) {
  const files = new Map<string, string>();
  const plugins: { name: string; file: string; line: number; js: string[] }[] = [];
  const queue: string[] = [];
  const add = (rel: string) => {
    if (converted.includes(rel) || files.has(rel)) return;
    // data/scenario の外（プラグインの init.ks など）は、取り込み元のプロジェクトのもの
    const path = join(rel.startsWith("../") ? sourceScenarioDir : scenarioDir, rel);
    if (!existsSync(path) || !statSync(path).isFile() || !readable(path)) return;
    files.set(rel, readFileSync(path, "utf8"));
    queue.push(rel);
  };
  const systemDir = join(scenarioDir, "system");
  if (existsSync(systemDir)) for (const f of readdirSync(systemDir).sort()) if (f.endsWith(".ks") && !f.startsWith("_")) add(`system/${f}`);
  const scan = (rel: string, src: string) => {
    for (const c of lex(src, rel).commands) {
      if (c.name === "plugin" && c.pm.name) {
        const dir = join(sourceScenarioDir, "../others/plugin", c.pm.name);
        const js = existsSync(dir) && readable(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js")).map((f) => f.split(sep).join("/")).sort() : [];
        if (!plugins.some((p) => p.name === c.pm.name)) plugins.push({ name: c.pm.name, file: rel, line: c.line, js });
        add(normalizeStorage(`../others/plugin/${c.pm.name}/${c.pm.storage || "init.ks"}`));
      }
      if (c.name === "call" && c.pm.storage) add(normalizeStorage(c.pm.storage));
    }
  };
  for (const f of converted) scan(f, readFileSync(join(scenarioDir, f), "utf8"));
  while (queue.length > 0) {
    const rel = queue.shift()!;
    scan(rel, files.get(rel)!);
  }
  return { files, plugins };
}

/** TyranoScript の Config.tjs から、作品の情報（タイトル・ID・画面サイズ）を読む。 */
export function readTyranoConfig(source: string): { title: string; id: string; width: number; height: number } {
  const config = new Map<string, string>();
  const file = join(source, "data/system/Config.tjs");
  if (existsSync(file) && realWithin([source], file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^;\s*([\w.]+)\s*=\s*(.*?)\s*(?:\/\/.*)?$/.exec(line.trim());
      if (m) config.set(m[1]!, m[2]!.replace(/"/g, ""));
    }
  }
  const id = config.get("projectID") || basename(source);
  return { title: config.get("System.title") || id, id, width: Number(config.get("scWidth") || 1280), height: Number(config.get("scHeight") || 720) };
}

// ---- ページの取り出し ----

/**
 * 立ち絵プラグイン tatie の設定（data/others/plugin/tatie/settings.js）を読む。
 * settings.js は `window.TYRANO_TATIE_SETTINGS = {…}` を書くだけのファイルなので、実行はせず、右辺のリテラルを
 * 解析して読む（readWindowAssignments。関数の呼び出しなどリテラルでないものがあれば読めないとして報告する）。
 * 無ければ空のキャスト。
 */
export function readTatieSettings(source: string): { cast: Cast; notes: string[] } {
  const file = join(source, "data/others/plugin/tatie/settings.js");
  if (!existsSync(file)) return { cast: {}, notes: [] };
  if (!realWithin([source], file)) return { cast: {}, notes: ["tatie の設定（settings.js）はインポート元のプロジェクトの外を指すため、読み込みません"] };
  let assigned: Map<string, unknown>;
  try {
    assigned = readWindowAssignments(readFileSync(file, "utf8"));
  } catch (e) {
    return { cast: {}, notes: [`tatie の設定を読めません（${(e as Error).message}）`] };
  }
  const cast = castFromTatieSettings(assigned.get("TYRANO_TATIE_SETTINGS"));
  return { cast, notes: [`tatie の設定から ${Object.keys(cast).length} 人のキャストを読みました`] };
}

/** .ks（data/scenario からのパス）を取り込んだ .lim の名前（拡張子なし。サブフォルダは "part1/chapter2" の形）。 */
export function limName(ks: string): string {
  return ks.replace(/\.ks$/, "");
}

/**
 * 本文として取り込む .ks（files）と、取り込まないもの（skipped）。どちらも data/scenario からのパスで、並べ替え済み。
 * サブフォルダの .ks も取り込む（名前は "part1/chapter2.ks"）。ただし次のものは除く。
 * - system/ 下（エンジンの設定やマクロ。マクロは別に集める）と、_ 始まりの生成物
 * - skipFiles に挙げたもの（拡張子なしのパス。直下のファイルは名前だけ）は skipped に
 * - サブフォルダの .ks で、skipped のファイルからだけ [call]・[jump] されるもの（タイトル画面などの仕組み側のデータ）は skipped に
 */
export function scenarioFiles(scenarioDir: string, skip: ReadonlySet<string>, readable: (file: string) => boolean): { files: string[]; skipped: string[] } {
  const all = listKs(scenarioDir).filter((f) => !f.startsWith("system/") && readable(f));
  const skipped = new Set(all.filter((f) => skip.has(limName(f))));
  // サブフォルダのファイルが、どのファイルから呼ばれるか
  const sub = all.filter((f) => f.includes("/") && !skipped.has(f));
  if (sub.length > 0) {
    const callers = new Map<string, Set<string>>();
    for (const f of all) {
      for (const c of lex(readFileSync(join(scenarioDir, f), "utf8"), f).commands) {
        if ((c.name !== "call" && c.name !== "jump") || !c.pm.storage) continue;
        const to = normalizeStorage(c.pm.storage);
        if (to === f) continue;
        if (!callers.has(to)) callers.set(to, new Set());
        callers.get(to)!.add(f);
      }
    }
    // skipped から呼ばれ、ほかの本文から呼ばれないものを skipped にする（skipped が増えなくなるまで）
    for (let changed = true; changed; ) {
      changed = false;
      for (const f of sub) {
        const from = callers.get(f);
        if (skipped.has(f) || !from || from.size === 0) continue;
        if ([...from].every((c) => skipped.has(c))) {
          skipped.add(f);
          changed = true;
        }
      }
    }
  }
  return { files: all.filter((f) => !skipped.has(f)), skipped: all.filter((f) => skipped.has(f)) };
}

/** data/scenario 以下の .ks（相対パス、並べ替え済み）。_ 始まりの生成物は除く。 */
function listKs(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ks") && !basename(f).startsWith("_"))
    .map((f) => f.split(sep).join("/"))
    .sort();
}

/** .ks のページ。マクロの中身は、マクロを集めたファイルの側で照合する。 */
function ksPages(src: string, file: string, charas: CharaDefs): string[] {
  return pagesOf(lex(src, file).commands, charas);
}

/**
 * .ks のページ（[p] までの表示文字列。ルビは親文字だけ、[r] は改行）。
 * [iscript]・[macro]・[html] の中と、[link] の文（選択肢になる）は除く。
 * 話者は名前欄に出る文字列（[chara_new] の name なら jname）。
 */
function pagesOf(commands: readonly RawCommand[], charas: CharaDefs): string[] {
  const pages: string[] = [];
  let buf = "";
  let speaker = "";
  let skipUntil: string | null = null;
  let inLink = false;
  const push = () => {
    const p = page(speaker, buf);
    if (p !== "") pages.push(p);
    buf = "";
  };
  for (const c of commands) {
    if (skipUntil !== null) {
      if (c.name === skipUntil) skipUntil = null;
      continue;
    }
    if (c.name === "iscript") skipUntil = "endscript";
    else if (c.name === "macro") skipUntil = "endmacro";
    else if (c.name === "html") skipUntil = "endhtml";
    else if (c.name === "link") inLink = true;
    else if (c.name === "endlink") inLink = false;
    else if (c.name === "chara_ptext") speaker = speakerName(c.pm.name?.trim() ?? "", charas);
    else if (c.name === "text") buf += inLink ? "" : inlineRubyPlain(c.val);
    else if (c.name === "r" || c.name === "lr") buf += "\n";
    else if (c.name === "p" || ((c.name === "tb_start_text" || c.name === "_tb_end_text" || c.name === "s") && buf !== "")) push();
  }
  if (buf !== "") push();
  return pages;
}

/** 行末の空白と改行は .lim では残らない（選択肢の前の改行も落とす）ので比較から外す。 */
function page(speaker: string, text: string): string {
  const t = text.replace(/[ \t\n]+$/, "");
  return t === "" ? "" : (speaker && /^[「『（("“]/.test(t) ? `${speaker}:` : "") + t;
}

function limPages(body: Statement[]): string[] {
  const pages: string[] = [];
  const add = (prefix: string, text: string) => {
    const t = text.replace(/[ \t\n]+$/, "");
    if (t !== "") pages.push(prefix + t);
  };
  const visit = (statements: Statement[]) => {
    for (const s of statements) {
      if (s.kind === "say") add(`${s.speaker}:`, plainText(s.content));
      else if (s.kind === "prose") add("", plainText(s.content));
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(body);
  return pages;
}
