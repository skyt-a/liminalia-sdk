import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { combineImportProfiles } from "@liminalia/ks-import";
import { copyTyranoAssets, importProject, importReportPath, importTyrano, isTyranoProject, loadImportProfile, readTyranoConfig, tyranoStartScenario, type ImportReport } from "@liminalia/ks-import/node";
import { CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { CONFIG_FILE, listScenarioFiles, loadCommandPlugins, loadProject, type ProjectConfig } from "@liminalia/project";
import { assetCopyReport, assetCopySummary, type AssetCopyResult } from "@liminalia/project/asset-copy";
import { englishBuildLine } from "@liminalia/project/build-lines-en";
import { combinePlugins } from "@liminalia/plugin-host";
import { runNew, type NewOptions } from "./new.ts";

/**
 * lim import [プロジェクト] [--assets] [--lang en]
 * liminalia.json の import.tyrano.source にある TyranoScript のプロジェクトを、paths.scenario / data / cast に取り込む。
 * 組み込みの標準の変換表と、プラグインごとの "./import"（import.tyrano.profile が指すものを含む）の変換表・
 * [iscript] の置き換え・作品固有の書き出しを重ね、命令の仕様は組み込み＋プラグインの命令の表から引く。
 * --assets なら素材（data/bgimage など）も素材のフォルダの同じ名前のフォルダへ写す（写す先にあるものは上書きしない）。
 * 報告の頭（件数の表と要約）を出す。--lang en なら英語で出す（報告のファイル import-report.md は日本語のまま。
 * 英語は書き出しの経過と同じ表で読み替えるので、英語の表示の制作アプリの書き出しの画面でも英語になる）。
 */
export async function runImport(dir: string, language: "ja" | "en" = "ja", o: { assets?: boolean } = {}): Promise<boolean> {
  const { report, reportPath, assets } = await importProject(dir, { assets: o.assets === true });
  const lines = [...report.markdown.split("\n").slice(0, 14), `詳細: ${reportPath}`];
  console.log((language === "en" ? lines.map(englishBuildLine) : lines).join("\n"));
  if (assets) console.log(assetCopySummary(assets, language));
  return report.ok;
}

/** TyranoScript の作品から新しい作品を作るときの選び方（lim new --from-tyrano と、制作アプリのはじめの画面）。 */
export interface TyranoNewOptions extends Omit<NewOptions, "blank" | "novel"> {
  /** 取り込む TyranoScript の作品のフォルダ（data/scenario のあるところ）。 */
  source: string;
}

export interface TyranoNewResult {
  root: string;
  reportPath: string;
  /** 報告の要約（lim new --from-tyrano が出す）。 */
  summary: string[];
  counts: TyranoImportCounts;
  /** 取り込みの報告の ok（未対応・手作業・エラーが無く、本文がすべて一致）。 */
  ok: boolean;
  /** 「はじめから」の台本（liminalia.json の entry）。 */
  entry: string;
  assets: AssetCopyResult;
  report: ImportReport;
}

/** 新しい作品では取り込まない .ks（TyranoScript の起動とタイトル画面。Liminalia の起動とタイトル画面が代わる）。 */
const TYRANO_SYSTEM_FILES = ["first", "title_screen"];

/** [jump storage=title_screen.ks]（と first.ks）を @title-screen に。条件付き（cond）とほかの飛び先は、ふつうの変換に任せる（null）。 */
function titleJump(pm: Readonly<Record<string, string | undefined>>): { name: string; positional: string[]; named: [string, string, string | null][] } | null {
  const storage = (pm.storage ?? "").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\.ks$/, "");
  if (pm.cond || !TYRANO_SYSTEM_FILES.includes(storage)) return null;
  return { name: "title-screen", positional: [], named: [] };
}

/**
 * TyranoScript／TyranoBuilder の作品から新しい作品を作る（lim new --from-tyrano と、制作アプリの「TyranoScript／TyranoBuilder の作品から」）。
 * 白紙の作品を作り、data/scenario の .ks を取り込み（first.ks と title_screen.ks は除く）、素材を写し、
 * 「はじめから」をタイトル画面の *start の飛び先（無ければ first.ks の飛び先）にして、取り込みの報告を書く。
 * 一度だけの取り込みで、作品の liminalia.json に import.tyrano は書かない（台本はこの作品の .lim を直していく。
 * TyranoScript の側で書き続けて取り込み直すなら、プロジェクトの設定の「インポート元」を書く）。
 */
export async function createFromTyrano(dir: string, o: TyranoNewOptions): Promise<TyranoNewResult> {
  const source = resolve(o.source);
  if (!isTyranoProject(source)) throw new Error(`${o.source} は TyranoScript の作品のフォルダではありません（data/scenario に .ks がありません）`);
  const info = readTyranoConfig(source);
  const size = { width: Math.round(info.width), height: Math.round(info.height) };
  const usable = Number.isInteger(size.width) && Number.isInteger(size.height) && size.width >= 320 && size.height >= 320 && size.width <= 7680 && size.height <= 7680;
  const { source: _source, ...rest } = o;
  runNew(dir, {
    ...rest,
    title: o.title ?? info.title,
    // 省くとフォルダ名かタイトルから作る（作れなければ --id を求めて止める）
    ...(o.id ? { id: o.id } : {}),
    ...(o.screen ? { screen: o.screen } : usable ? { screen: size } : {}),
    blank: true,
  });
  const project = loadProject(dir);
  // 白紙の台本は外す（同じ名前の .ks があれば、取り込んだものに替わる）
  rmSync(join(project.paths.scenario, "start.lim"), { force: true });
  const reportPath = importReportPath(project);
  const registry = createRegistry(CORE_COMMANDS, combinePlugins(await loadCommandPlugins(project)).specs);
  const report = await importTyrano({
    source,
    scenarioOut: project.paths.scenario,
    dataOut: project.paths.data,
    castOut: project.paths.cast,
    reportOut: reportPath,
    registry,
    // タイトル画面と起動の .ks への [jump] は、Liminalia のタイトル画面へ戻る @title-screen にする（その .ks は取り込まないため）
    profile: combineImportProfiles([{ skipFiles: TYRANO_SYSTEM_FILES, tags: { jump: titleJump } }, await loadImportProfile(project)]),
    extra: project.config.extra,
  });
  const scenarios = listScenarioFiles(project.paths.scenario).map((f) => f.name).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const start = tyranoStartScenario(source);
  const entry = start && scenarios.includes(start) ? start : (scenarios.find((n) => !n.startsWith("macros")) ?? scenarios[0] ?? "start");
  if (scenarios.length === 0) writeFileSync(join(project.paths.scenario, "start.lim"), "# start\n");
  const configFile = join(project.root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as ProjectConfig;
  writeFileSync(configFile, `${JSON.stringify({ ...config, entry }, null, 2)}\n`);
  const assets = copyTyranoAssets(source, project.paths.assets);
  appendFileSync(
    reportPath,
    [
      "",
      "## 新しいプロジェクト",
      "",
      `- 取り込み元: ${source}`,
      `- 「はじめから」: ${entry}.lim${start ? `（title_screen.ks か first.ks の飛び先）` : "（飛び先が分からないため、最初の台本）"}`,
      `- first.ks と title_screen.ks は取り込んでいません（起動とタイトル画面は Liminalia のものを使います）`,
      "- 一度だけの取り込みです。TyranoScript の側で書き続けて取り込み直すときは、プロジェクトの設定の「インポート元」に TyranoScript の作品を書きます",
      "",
    ].join("\n") + assetCopyReport(assets),
  );
  const counts: TyranoImportCounts = {
    files: report.files,
    matched: report.fidelity.filter((f) => f.mismatch === null).length,
    checked: report.fidelity.length,
    issues: report.manual.length + report.syntaxErrors.length + report.checkErrors.length,
    copied: assets.copied.length,
    bytes: assets.bytes,
    kept: assets.kept.length,
  };
  return { root: project.root, reportPath, summary: tyranoSummary(counts), counts, ok: report.ok, entry, assets, report };
}

/** 取り込みの数（制作アプリが、取り込んだあとに知らせる）。 */
export interface TyranoImportCounts {
  /** 取り込んだ .ks の数。 */
  files: number;
  /** 本文が .ks と一字一句同じだったファイルの数と、照合したファイルの数。 */
  matched: number;
  checked: number;
  /** 手作業が必要な箇所と、構文と命令の検査のエラーの数。 */
  issues: number;
  /** 写した素材の数と大きさ、写す先にあったので上書きしなかった数。 */
  copied: number;
  bytes: number;
  kept: number;
}

/** 取り込みの要約（lim new --from-tyrano が出す数行。en なら英語）。 */
export function tyranoSummary(c: TyranoImportCounts, language: "ja" | "en" = "ja"): string[] {
  const mb = (c.bytes / 1024 / 1024).toFixed(1);
  if (language === "en") {
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    return [
      `Imported ${n(c.files, "script file")} (text matches in ${c.matched} of ${n(c.checked, "file")})`,
      c.issues > 0 ? `${n(c.issues, "place")} need manual work or have errors` : "Nothing needs manual work",
      `Copied ${n(c.copied, "asset")} (${mb} MB)`,
    ];
  }
  return [
    `シナリオ ${c.files} ファイルを取り込みました（本文の一致 ${c.matched} / ${c.checked} ファイル）`,
    c.issues > 0 ? `手作業が必要な箇所とエラーが ${c.issues} 件あります` : "手作業が必要な箇所はありません",
    `素材 ${c.copied} 件をコピーしました（${mb} MB）`,
  ];
}

/** lim new --from-tyrano。作って、要約と報告の場所を出す。 */
export async function runNewFromTyrano(dir: string, o: TyranoNewOptions): Promise<boolean> {
  const r = await createFromTyrano(dir, o);
  const en = o.language === "en";
  console.log([...tyranoSummary(r.counts, en ? "en" : "ja"), en ? `New Game starts at ${r.entry}.lim` : `「はじめから」: ${r.entry}.lim`, en ? `Full report (in Japanese): ${r.reportPath}` : `詳細: ${r.reportPath}`].join("\n"));
  return r.ok;
}
