import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { listScenarioFiles, loadCommandPlugins, loadProject, pluginEntry, readCast, resolvePackageDir, type Project } from "@liminalia/project";
import { assetCopyReport, copyAssetFolders, type AssetCopyResult } from "@liminalia/project/asset-copy";
import { normalizeStorage } from "./convert.ts";
import { lex } from "./lexer.ts";
import type { RawCommand } from "./types.ts";
import { combinePlugins } from "@liminalia/plugin-host";
import { backportTyrano, type BackportReport } from "./backport/index.ts";
import { importTyrano, type ImportReport, type TyranoImportProfile } from "./import.ts";
import { parseSourceMap, sha256 } from "./sourcemap.ts";
import { combineImportProfiles } from "./profile.ts";
import { STD_IMPORT } from "./std-tags/index.ts";
import { realWithin, unsafeWriteTarget } from "./safe-path.ts";

/**
 * プラグインごとの "./import"（取り込み設定）。liminalia.json の plugins の並び（先頭は標準の命令）に、
 * import.tyrano.profile が指すパッケージ（plugins に無ければ）を後ろに足す。"./import" の無いパッケージは飛ばす。
 */
export async function loadPluginImports(project: Project): Promise<{ dir: string; profile: TyranoImportProfile }[]> {
  const dirs = [...project.plugins];
  // 制限付きで開いた作品（@liminalia/project の trust.ts）では、作品の取り込み設定も読まない
  const spec = project.restricted ? undefined : project.config.import?.tyrano?.profile;
  if (spec) {
    const dir = resolvePackageDir(project.root, spec);
    if (!pluginEntry(dir, "import")) throw new Error(`${spec} に "./import" のエントリーポイントがありません`);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  const out: { dir: string; profile: TyranoImportProfile }[] = [];
  for (const dir of dirs) {
    const entry = pluginEntry(dir, "import");
    if (!entry) continue;
    const mod = (await import(pathToFileURL(entry).href)) as { default?: TyranoImportProfile };
    if (!mod.default) throw new Error(`${entry} が取り込み設定を default export していません`);
    out.push({ dir, profile: mod.default });
  }
  return out;
}

/** 取り込みに使う設定。組み込みの標準の変換表（STD_IMPORT）に、プラグインごとの "./import" を順に重ねたもの。 */
export async function loadImportProfile(project: Project): Promise<TyranoImportProfile> {
  return combineImportProfiles([STD_IMPORT, ...(await loadPluginImports(project)).map((p) => p.profile)]);
}

/** 取り込みの報告を書き出す場所（シナリオの出力先の一つ上）。 */
export function importReportPath(project: Project): string {
  return join(project.paths.scenario, "..", "import-report.md");
}

/** 取り込みの対応表（.lim の各行が .ks のどこから来たか）を書き出す場所（シナリオの出力先の一つ上）。 */
export function importSourceMapPath(project: Project): string {
  return join(project.paths.scenario, "..", "import-sourcemap.json");
}

/** 命令の仕様（組み込み＋プラグインの命令の表）。 */
async function projectRegistry(project: Project) {
  return createRegistry(CORE_COMMANDS, combinePlugins(await loadCommandPlugins(project)).specs);
}

/**
 * liminalia.json の import.tyrano.source にある TyranoScript のプロジェクトを、paths.scenario / data / cast に取り込む
 * （lim import と、開発サーバーの「取り込み直す」が使う）。命令の仕様は組み込み＋プラグインの命令の表から引く。
 * assets なら、素材（data/bgimage など）も素材のフォルダへ写す（lim import --assets。写す先にあるものは上書きしない）。
 */
export async function importProject(dir: string, o: { assets?: boolean } = {}): Promise<{ project: Project; report: ImportReport; reportPath: string; assets: AssetCopyResult | null }> {
  const project = loadProject(dir);
  const tyrano = project.config.import?.tyrano;
  if (!tyrano) throw new Error("liminalia.json に import.tyrano がありません（取り込みで作る作品ではありません）");
  const reportPath = importReportPath(project);
  const source = resolve(project.root, tyrano.source);
  const report = await importTyrano({
    source,
    scenarioOut: project.paths.scenario,
    dataOut: project.paths.data,
    castOut: project.paths.cast,
    reportOut: reportPath,
    sourceMapOut: importSourceMapPath(project),
    registry: await projectRegistry(project),
    profile: await loadImportProfile(project),
    extra: project.config.extra,
  });
  const assets = o.assets ? copyTyranoAssets(source, project.paths.assets) : null;
  if (assets) appendFileSync(reportPath, assetCopyReport(assets));
  return { project, report, reportPath, assets };
}

// ---- 作品のフォルダと素材 ----

/** TyranoScript の data の中の素材のフォルダ → 作品の素材のフォルダ（同じ名前。voice は TyranoScript の標準には無いが、あれば写す）。 */
export const TYRANO_ASSET_FOLDERS: Readonly<Record<string, string>> = {
  "data/bgimage": "bgimage",
  "data/fgimage": "fgimage",
  "data/image": "image",
  "data/bgm": "bgm",
  "data/sound": "sound",
  "data/voice": "voice",
  "data/video": "video",
  "data/others": "others",
};

/**
 * TyranoScript の作品の素材（data/bgimage、fgimage、image、bgm、sound、video、others）を、作品の素材のフォルダの同じ名前のフォルダへ写す。
 * data/others/plugin（TyranoScript のプラグインの JS と画像）は使わないので写さない。写す先にあるものは上書きしない（@liminalia/project の copyAssets）。
 */
export function copyTyranoAssets(source: string, assetsDir: string): AssetCopyResult {
  return copyAssetFolders(source, assetsDir, TYRANO_ASSET_FOLDERS, (from) => from.startsWith("data/others/plugin/"));
}

/** TyranoScript の作品のフォルダか（data/scenario に .ks がある）。 */
export function isTyranoProject(dir: string): boolean {
  const scenario = join(dir, "data/scenario");
  try {
    return statSync(scenario).isDirectory() && readdirSync(scenario).some((f) => f.endsWith(".ks"));
  } catch {
    return false;
  }
}

/**
 * TyranoScript の作品で、遊び始める .ks（「はじめから」の飛び先）。拡張子なしの data/scenario からのパスで返す。分からなければ null。
 * - title_screen.ks の *start の後の最初の [jump storage=…]（TyranoBuilder のタイトル画面）。*start が無ければ、最初の jump
 * - title_screen.ks が無ければ、first.ks の最初の jump（title_screen.ks へのものは除く）
 */
export function tyranoStartScenario(source: string): string | null {
  const scenario = join(source, "data/scenario");
  const read = (file: string): RawCommand[] => {
    const path = join(scenario, file);
    if (!existsSync(path) || !realWithin([source], path)) return [];
    return lex(readFileSync(path, "utf8"), file).commands;
  };
  const jumpTo = (c: RawCommand) => (c.name === "jump" && typeof c.pm.storage === "string" && c.pm.storage !== "" ? normalizeStorage(c.pm.storage) : null);
  const ok = (ks: string | null) => ks !== null && ks !== "first.ks" && ks !== "title_screen.ks" && existsSync(join(scenario, ks)) ? ks.replace(/\.ks$/, "") : null;
  const title = read("title_screen.ks");
  if (title.length > 0) {
    const start = title.findIndex((c) => c.name === "label" && c.pm.label_name === "start");
    if (start >= 0) {
      for (const c of title.slice(start + 1)) {
        if (c.name === "label") break;
        const to = ok(jumpTo(c));
        if (to) return to;
      }
    }
    for (const c of title) {
      const to = ok(jumpTo(c));
      if (to) return to;
    }
  }
  for (const c of read("first.ks")) {
    const to = ok(jumpTo(c));
    if (to) return to;
  }
  return null;
}

// ---- 書き戻し（lim backport）----

/**
 * 書き戻しの基準のフォルダの中身。取り込みで作った作品を .lim で直すようにする（.lim を正本に切り替える）時点で作っておく。
 *   ks/                    取り込み元の data/scenario の写し（system/ なども含めた一式）
 *   lim/                   その .ks を取り込んだ .lim（切り替えた時点の .lim と同じもの）
 *   import-sourcemap.json  対応表
 *   import-report.md       取り込みの報告
 *   base.json              作った日時と、取り込み元の場所・git の状態
 */
export const BACKPORT_BASE = { ks: "ks", lim: "lim", map: "import-sourcemap.json", report: "import-report.md", info: "base.json" } as const;

export interface BackportBaseInfo {
  createdAt: string;
  /** 取り込み元の TyranoScript のプロジェクト（絶対パス）。 */
  tyrano: string;
  /** 取り込み元の git の状態（git で管理していなければ null）。dirty は data/scenario の未コミットの変更。 */
  git: GitState | null;
  /** 基準を作ったエンジン（取り込みの変換）の git の状態。dirty は packages/ks-import の未コミットの変更。 */
  engine: GitState | null;
}

export interface GitState {
  commit: string;
  branch: string;
  dirty: string[];
}

/**
 * 書き戻しの基準を作る（lim backport --make-base）。tyrano の .ks を作品の取り込み設定（プラグインの "./import"）で
 * 取り込んで base/lim と対応表を書き、data/scenario を base/ks に写す。返す same は、取り込んだ .lim が
 * 作品の今の .lim（paths.scenario）と同じか（切り替えの時点なら同じはず）。
 */
export async function makeBackportBase(dir: string, base: string, tyrano: string): Promise<{ report: ImportReport; info: BackportBaseInfo; same: boolean; differs: string[] }> {
  const project = loadProject(dir);
  const work = mkdtempSync(join(tmpdir(), "liminalia-backport-base-"));
  try {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    const report = await importTyrano({
      source: tyrano,
      scenarioOut: join(base, BACKPORT_BASE.lim),
      dataOut: join(work, "data"),
      castOut: join(work, "cast.json"),
      reportOut: join(base, BACKPORT_BASE.report),
      sourceMapOut: join(base, BACKPORT_BASE.map),
      registry: await projectRegistry(project),
      profile: await loadImportProfile(project),
      extra: project.config.extra,
    });
    // シンボリックリンクは実体を写す。実体が取り込み元の外にあるものは写さない（取り込みでも読んでいない）
    cpSync(join(tyrano, "data/scenario"), join(base, BACKPORT_BASE.ks), {
      recursive: true,
      dereference: true,
      filter: (src) => !lstatSync(src).isSymbolicLink() || realWithin([tyrano], src),
    });
    const info: BackportBaseInfo = {
      createdAt: new Date().toISOString(),
      tyrano: resolve(tyrano),
      git: gitState(tyrano, "data/scenario"),
      engine: gitState(fileURLToPath(new URL("../../..", import.meta.url)), "packages/ks-import"),
    };
    writeFileSync(join(base, BACKPORT_BASE.info), JSON.stringify(info, null, 2) + "\n");
    const differs: string[] = [];
    const names = new Set([...listLim(join(base, BACKPORT_BASE.lim)), ...listLim(project.paths.scenario)]);
    for (const name of [...names].sort()) {
      const a = join(base, BACKPORT_BASE.lim, name);
      const b = join(project.paths.scenario, name);
      if (!existsSync(a) || !existsSync(b) || readFileSync(a, "utf8") !== readFileSync(b, "utf8")) differs.push(name);
    }
    return { report, info, same: differs.length === 0, differs };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 書き戻す（lim backport）。基準（base）と作品の今の .lim から .ks 一式を out に作り、取り込み直して確かめる。
 * write なら、書き戻した .ks を取り込み元（tyrano）の data/scenario に書く。force でなければ、書き戻せなかった箇所があるか
 * 確かめが一致しないときは何も書かず（held）、取り込み元の .ks が基準と違う（切り替えたあとに TyranoScript 側でも直した）ファイルは書かない（refused）。
 */
export async function backportProject(
  dir: string,
  o: { base: string; tyrano?: string; out?: string; write?: boolean; force?: boolean },
): Promise<{ report: BackportReport; out: string; tyrano: string; copied: string[]; refused: string[]; held: boolean }> {
  const project = loadProject(dir);
  const infoPath = join(o.base, BACKPORT_BASE.info);
  const info = existsSync(infoPath) ? (JSON.parse(readFileSync(infoPath, "utf8")) as BackportBaseInfo) : null;
  const tyrano = o.tyrano ?? info?.tyrano ?? (project.config.import?.tyrano ? resolve(project.root, project.config.import.tyrano.source) : null);
  if (!tyrano) throw new Error("取り込み元の TyranoScript のプロジェクトが分かりません（--tyrano で指定してください）");
  const out = o.out ?? join(project.root, ".liminalia/backport/scenario");
  const report = await backportTyrano({
    baseKs: join(o.base, BACKPORT_BASE.ks),
    baseLim: join(o.base, BACKPORT_BASE.lim),
    sourceMap: join(o.base, BACKPORT_BASE.map),
    currentLim: project.paths.scenario,
    source: tyrano,
    out,
    reportOut: join(dirname(out), "backport-report.md"),
    registry: await projectRegistry(project),
    profile: await loadImportProfile(project),
    speakers: readCast(project).speakers,
    extra: project.config.extra,
    commandDefaults: project.config.commandDefaults,
  });
  const copied: string[] = [];
  const refused: string[] = [];
  const held = o.write === true && !o.force && (!report.verified || report.failed > 0);
  if (o.write && !held) {
    const map = parseSourceMap(readFileSync(join(o.base, BACKPORT_BASE.map), "utf8"));
    const hashes = new Map(Object.values(map.files).flatMap((f) => (f.source ? [[f.source, f.sourceHash] as const] : [])));
    const scenario = join(tyrano, "data/scenario");
    for (const file of report.written) {
      // シンボリックリンク（と途中のフォルダのリンク）をたどって data/scenario の外を上書きしない。書き戻した側（out）も同じ
      if (unsafeWriteTarget(scenario, file) !== null || unsafeWriteTarget(out, file) !== null) {
        refused.push(file);
        continue;
      }
      const target = join(scenario, file);
      const expected = hashes.get(file);
      const now = existsSync(target) ? sha256(readFileSync(target, "utf8")) : null;
      // 取り込み元が基準のままか（新しいファイルなら、まだ無いか）
      const untouched = expected === undefined ? now === null : now === expected;
      if (!untouched && !o.force) {
        refused.push(file);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(out, file)));
      copied.push(file);
    }
  }
  return { report, out, tyrano, copied, refused, held };
}

/** フォルダの .lim（サブフォルダの台本も。名前は "part1/chapter2.lim" の形）。 */
function listLim(dir: string): string[] {
  return listScenarioFiles(dir).map((f) => `${f.name}.lim`);
}

/**
 * git の状態。dir はインポート元（他人のプロジェクトかもしれない）のこともあるので、リポジトリの設定に書かれたコマンドを
 * 走らせない（runGit）。
 */
export function gitState(dir: string, path: string): GitState | null {
  try {
    const run = (...args: string[]) => runGit(dir, args);
    const git = (...args: string[]) => run(...args).trim();
    // porcelain の行頭の空白は状態の欄なので切らない
    const dirty = run("status", "--porcelain", "--ignore-submodules=all", "--", path)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3));
    return { commit: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty };
  } catch {
    return null;
  }
}

/**
 * dir で git を呼ぶ。リポジトリの .git/config に書けるコマンド（core.fsmonitor、フック、フィルタの clean / smudge / process）を
 * -c で打ち消し、索引を書き換えない（--no-optional-locks）。フックは空のフォルダを指して、どの OS でも走らないようにする。
 */
export function runGit(dir: string, args: readonly string[]): string {
  const hooks = mkdtempSync(join(tmpdir(), "liminalia-git-hooks-"));
  try {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    const base = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, "-C", dir];
    const exec = (a: readonly string[]) => execFileSync("git", [...base, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
    // フィルタの名前は設定を読むだけで分かる（読むときにはコマンドは走らない）。名前ごとに中身を空にする
    let names: string[] = [];
    try {
      names = exec(["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"])
        .split("\n")
        .map((l) => /^filter\.(.*)\.[a-z]+(?:\s|$)/i.exec(l)?.[1])
        .filter((n): n is string => n !== undefined);
    } catch {
      // フィルタの設定が無い（git config は終了コード 1）
    }
    const filters = [...new Set(names)].flatMap((n) => ["-c", `filter.${n}.clean=`, "-c", `filter.${n}.smudge=`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`]);
    return exec([...filters, ...args]);
  } finally {
    rmSync(hooks, { recursive: true, force: true });
  }
}
