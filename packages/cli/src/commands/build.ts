import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createPackage } from "@electron/asar";
import { packager } from "@electron/packager";
import { isDraftSource, mediaKindOf, missingAssets, parse, referencedAssetKeys, unexportedAssets, type AssetSources, type Diagnostic, type Script } from "@liminalia/lang";
import { assetNames, buildPack, exportFileNames, hostPlatform, listScenarioFiles, projectFlow, projectPackScripts, projectPacks, readScenarioFile, stdWebFeatures, suggestFileName, type ProjectConfig } from "@liminalia/project";
import type { SeedSave } from "@liminalia/web";
import { childPath, plainName } from "@liminalia/project/contained-path";
import { decodePng, encodePng, resizePixels } from "@liminalia/web/pwa-icons";
import { build as viteBuild, type Plugin } from "vite";
import { findChromium } from "../chromium.ts";
import { estimateBuildSpace } from "../build-space.ts";
import { copyFiles, planCopy, SPACE_RESERVE, type CopyPair } from "../clone.ts";
import { serveFolder } from "../serve-folder.ts";
import { loadContext, restrictedBuildMessage, type Context } from "../context.ts";
import { encryptAssetFile, encryptFolder, encryptionKey, hashFile, encryptProjectFiles, injectServiceWorkerLoader, relativeName, injectServiceWorkerRegister, precacheAtInstall, serviceWorkerSource, SERVICE_WORKER, type OfflineCache } from "../encrypt.ts";
import { writePlaceholders } from "../placeholder-assets.ts";
import { compressAssets, missingTools, type CompressResult, type MobileCompression } from "../compress.ts";
import { addMacAsarIntegrity, addWindowsAsarIntegrity, applyFuses, gameFuses, GAME_FUSE_NAMES, type GameFuses } from "../fuses.ts";
import { subsetFonts } from "../fonts.ts";
import { buildSeedSave } from "../seed.ts";
import { BEGIN_SOURCE } from "../playtest-drive.ts";
import { updateModule } from "../update.ts";
import { zipContents, zipFolder } from "../zip.ts";
import { tarGz } from "../tar.ts";
import { injectCsp, originOf } from "../csp.ts";
import { squeezeScreenTemplates, stripCommandDocs } from "../strip-docs.ts";
import { engineChunks } from "../engine-chunks.ts";
import { linuxDesktopEntry, linuxLauncher, linuxLauncherName } from "../linux.ts";
import { viteCache, WEB_ROOT } from "../web.ts";
import { androidPlatforms, buildAndroid, compilePlatform, findAndroidTools, findBundletool, PLAY_TARGET_SDK, pngIcon } from "../mobile/android.ts";
import { playGamesProblems } from "../mobile/achievements.ts";
import { collectedSummary, privacyManifest } from "../mobile/privacy.ts";
import { mobileProductIds } from "../mobile/store.ts";
import { appStoreConnectKey, archiveIos, buildIosDevice, buildIosSimulator, createIosProject, exportIos, exportOptionsPlist, installIos, iosTeam, launchIos, pickIosDevice, xcodeVersion, type IosExportMethod } from "../mobile/ios.ts";
import { checkMacSigning, macSigning, notarizeMacApp, signMacApp } from "../sign/mac.ts";
import { parseSignCommand, signError, signWindowsFile, windowsSigning } from "../sign/windows.ts";
import { buildInstaller, fileVersion, findMakensis, makensisHowTo } from "../installer/nsis.ts";
import { runCheck } from "./check.ts";
import { assetsNeededByCheck, assetsToDropForBuild } from "./unused.ts";
import { formatBytes, keepAfterBuild, keepSourceMaps, pruneBuilds, pruneSourceMaps, SOURCEMAPS, STAMPED_TARGETS, type StampedTarget } from "./clean.ts";
import { engineBundle } from "./size.ts";
import { runImport } from "./import.ts";
import { templateDir } from "./new.ts";
import { desktopDir, electronVersion as engineElectronVersion } from "../engine-paths.ts";
import { engineVersion } from "../version.ts";

// lim patch が使う暗号の部品（../encrypt.ts）
export { decryptBuffer, encryptAsset, encryptContent, encryptProjectFiles } from "../encrypt.ts";

/**
 * lim build [プロジェクト] <browser|mac|windows|android|ios|all> [--no-import] [--no-verify] [--seed ファイル[#ラベル] ...]
 *
 * 出力は paths.out（既定 dist/）の browser/・mac/・windows/・android/・ios/。作品の情報・アイコン・書き出しの設定は liminalia.json から読む。
 * all は browser・mac・windows（スマホ版は名前を書いたときだけ。Android SDK・Xcode が要るため）。
 *
 * 書き出す前に確かめること:
 * - import.tyrano があれば取り込み直し、未対応のタグ・手作業の箇所・構文エラーが 0 で本文がすべて一致すること
 * - lim check でエラーが無いこと
 * - シナリオとキャストの定義から参照される素材がすべてあること
 * - 組み立てたエンジンに、開発用の道具（TyranoScript の取り込み @liminalia/ks-import、立ち絵の位置調整画面、
 *   制作画面 @liminalia/studio）のコードと、開発用のページ（caster.html・studio.html）が入っていないこと
 *   （プラグインの "./commands" や "./web" が取り込みを import すると止める）
 * 書き出したあと、ブラウザ版と（この OS で動かせる）デスクトップ版は実際に起動し、タイトル画面まで進むことを確かめる。
 *
 * 容量について: 作業用のコピーは APFS の複製で作るので容量を使わない。素材はエンジン本体と分け、
 * デスクトップ版でも一度だけ入れる（ファイル隠蔽がオンなら assets.asar にまとめる）。
 */
/** 書き出し先。 */
export type BuildTarget = "browser" | "mac" | "windows" | "linux" | "android" | "ios";

export interface BuildOptions {
  targets: BuildTarget[];
  import: boolean;
  verify: boolean;
  seed?: { target: string; slot: number; mode: "successful_route" | "fresh"; title?: string; id?: string; overwrite: boolean };
  /**
   * iOS 版を実機に入れる（lim build ios --device [名前か ID]）。true なら入れられる端末が一台だけのとき、それに入れる。
   * チームで署名してビルドし、入れて起動する。
   */
  device?: string | true;
  /** 書き出したもの（フォルダ・ファイルの絶対パス）をここに足す（制作アプリが「フォルダを開く」に使う）。 */
  results?: string[];
  /**
   * Steam の版（build.steam.variants の名前か App ID の数字。"off" なら Steam につながない版）。
   * 省くと環境変数 LIMINALIA_STEAM、それも無ければ build.steam.appId。
   */
  steam?: string;
  /** 書き出しの版（build.variants の名前）。 */
  variant?: string;
  /**
   * テスト版にする（lim build --feedback）。遊びながらその場面に指摘を残す口（build.feedback）を入れる。
   * 省けば、エディション（build.variants）の feedback が true のときだけ入れる。製品の書き出しには入らない。
   */
  feedback?: boolean;
  /**
   * 使っている素材だけを入れる（lim build --only-used）。省けば liminalia.json の build.onlyUsed。
   * 外すのは lim unused の候補で、式で名前を組み立てて使うフォルダの素材は外さない（unused.ts の assetsToDropForBuild）。
   */
  onlyUsed?: boolean;
  /** 書き出し先（省くと liminalia.json の paths.out。lim patch が比べるための書き出しを別の場所に作るときに）。 */
  outDir?: string;
  /**
   * 配る形（lim build --zip・--dmg）。macZip は Mac 版の zip、macDmg は Mac 版の dmg、browserZip はブラウザ版の zip（Windows 版の zip も作る）。
   * 省いたものは、環境変数 LIMINALIA_ZIP・LIMINALIA_DMG、liminalia.json の build.mac.zip・build.mac.dmg・build.browser.zip の順に決める。
   */
  packaging?: { macZip?: boolean; macDmg?: boolean; browserZip?: boolean };
  /**
   * lim patch が前の書き出しと比べるために作るブラウザ版。素材の縮め方を前の書き出しの種類（browser か desktop）に合わせ、
   * ブラウザ版の暗号化はしない（パッチは前の書き出しの鍵で暗号にする）。
   */
  forPatch?: "browser" | "desktop";
  /**
   * iOS 版の Archive を作って書き出す（lim build ios --archive [--export app-store|ad-hoc|development] [--upload]）。
   * upload なら App Store Connect の API キーで上げる。
   */
  iosArchive?: { method: IosExportMethod; upload: boolean };
  /** Android 版を App Bundle（.aab）にもする（lim build android --aab。省くと LIMINALIA_AAB、build.androidAab）。 */
  aab?: boolean;
}

type SteamConfig = NonNullable<NonNullable<ProjectConfig["build"]>["steam"]>;

/** この書き出しで使う Steam の設定（つながない版なら null）。 */
export function steamFor(steam: SteamConfig | undefined, choice: string | undefined): Omit<SteamConfig, "variants"> | null {
  const pick = (choice ?? process.env.LIMINALIA_STEAM ?? "").trim();
  if (pick === "off" || pick === "none") return null;
  if (pick === "") {
    if (!steam) return null;
    const { variants: _, ...rest } = steam;
    return rest;
  }
  const { variants, ...rest } = steam ?? { appId: 0 };
  if (/^\d+$/.test(pick)) return { ...rest, appId: Number(pick) };
  const id = variants?.[pick];
  if (id === undefined) return fail(`build.steam.variants に ${pick} がありません（${Object.keys(variants ?? {}).join("、") || "variants がありません"}）`);
  return { ...rest, appId: id };
}

/** 実行ファイルを包むコマンド（環境変数 LIMINALIA_WIN_WRAP_COMMAND が優先。"off" なら行わない）。"{file}" が無ければ止める。 */
export function wrapCommand(configured: string[] | undefined, env: Record<string, string | undefined> = process.env): string[] | null {
  const fromEnv = (env.LIMINALIA_WIN_WRAP_COMMAND ?? "").trim();
  if (fromEnv === "off") return null;
  const command = fromEnv ? parseSignCommand(fromEnv) : configured;
  if (!command || command.length === 0) return null;
  if (!command.some((a) => a.includes("{file}"))) return fail('build.windows.wrap には、実行ファイルの場所に "{file}" を書いてください');
  return command;
}

type UpdateConfig = NonNullable<NonNullable<ProjectConfig["build"]>["update"]>;

/**
 * デスクトップ版に入れるアップデートの確認の設定（game.json の update）。環境変数 LIMINALIA_UPDATE_URL が優先し、"off" なら入れない。
 * Steam につなぐ版は Steam が更新を配るので、update.steam が true のときだけ入れる。
 */
export function updateFor(update: UpdateConfig | undefined, steam: unknown, env: Record<string, string | undefined> = process.env): { url: string; startup: boolean; publicKey?: string[] } | null {
  const fromEnv = (env.LIMINALIA_UPDATE_URL ?? "").trim();
  if (fromEnv === "off") return null;
  const url = fromEnv || update?.url;
  if (!url) return null;
  if (steam && update?.steam !== true) return null;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) return fail(`build.update.url は https:// の URL で書きます: ${url}`);
  // 署名を確かめる公開鍵（build.update.publicKey）。読めない鍵は書き出す前に止める
  const keys = update?.publicKey === undefined ? [] : Array.isArray(update.publicKey) ? update.publicKey : [update.publicKey];
  for (const k of keys) {
    try {
      updateModule.publicKeyFrom(k);
    } catch (e) {
      fail(`build.update.publicKey を読めません: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { url, startup: update?.checkOnStartup !== false, ...(keys.length > 0 ? { publicKey: keys } : {}) };
}

const ASSET_KINDS = ["bgimage", "fgimage", "image", "bgm", "sound", "voice", "video", "others"] as const;

class BuildError extends Error {}
const fail = (message: string): never => {
  throw new BuildError(message);
};
const step = (message: string) => console.log(`\n● ${message}`);

function envFlag(name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fail(`${name} には true か false を指定してください`);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 小さいファイル（台本・キャスト・訳・デスクトップ版の殻）を写す。素材は copyAssets（複製と空きの確かめ）で写す。 */
function copyFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** フォルダ（の中身の合計）かファイルの大きさ。 */
function sizeOf(path: string): string {
  // リンク（Mac のフレームワークの中の Versions/Current など）は先を数えない（二重に数えるため）
  const bytes = statSync(path).isDirectory() ? walk(path).reduce((a, f) => a + lstatSync(f).size, 0) : statSync(path).size;
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

export async function runBuild(dir: string, o: BuildOptions): Promise<boolean> {
  try {
    await build(dir, o);
    return true;
  } catch (e) {
    if (e instanceof BuildError) {
      console.error(`\n書き出しを中止しました: ${e.message}`);
      return false;
    }
    throw e;
  }
}

/** 組み立てた束の .map を、同じ並びのまま別のフォルダへ移す（配るファイルに入れない。build.sourcemap: "separate"）。移した数を返す。 */
export function moveSourceMaps(webDir: string, to: string): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith(".map")) {
        const dest = join(to, relative(webDir, path));
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(path, dest);
        n++;
      }
    }
  };
  walk(webDir);
  return n;
}

async function build(dir: string, o: BuildOptions): Promise<void> {
  let ctx = await loadContext(dir);
  const { project } = ctx;
  const cfg = project.config;
  const b = cfg.build ?? {};
  // 制限付きで読んだ作品（@liminalia/project の trust.ts）は書き出さない（プラグイン抜きのゲームになり、署名のコマンドや店の口も動く）
  if (project.restricted) fail(restrictedBuildMessage());

  // ---- 1. 取り込みと検査 ----
  if (o.import && cfg.import?.tyrano) {
    step("インポート（lim import）");
    if (!(await runImport(dir))) fail("インポートで、未対応のタグ、手作業で修正する箇所、構文エラー、本文の不一致のいずれかが見つかりました（import-report.md）");
    ctx = await loadContext(dir);
  }
  step("チェック（lim check）");
  if (!(await runCheck(dir, false, "ja", { build: true }))) fail("チェックでエラーが見つかりました");

  // 書き出すファイルの名前（build.executableName、無ければタイトル）が、書き出し先とこのコンピューターの OS で使えるか。
  // 使えなければ黙って置き換えずに止め、名前を決めてもらう
  const names = exportFileNames(cfg, o.targets, hostPlatform(process.platform));
  for (const n of names) for (const p of n.problems.filter((x) => x.level === "warning")) console.log(`  警告: ${n.what}「${n.name}」: ${p.message}`);
  const badNames = names.filter((n) => n.problems.some((p) => p.level === "error"));
  if (badNames.length > 0) {
    for (const n of badNames) for (const p of n.problems.filter((x) => x.level === "error")) console.error(`  ${n.what}「${n.name}」（${n.platform === "windows" ? "Windows" : n.platform === "mac" ? "Mac" : "Linux"}）: ${p.message}`);
    fail(`書き出すファイルの名前に使えない文字があります。liminalia.json の build.executableName に名前を指定してください（例: "executableName": ${JSON.stringify(suggestFileName(b.executableName ?? cfg.title, cfg.id))}）`);
  }
  const appName = cfg.title;
  // ファイルとしての名前（Mac のアプリ、Windows 版の実行ファイル、書き出し先のフォルダ）。確かめたので、そのまま使える
  const fileName = b.executableName ?? appName;
  const variant = o.variant ? b.variants?.[o.variant] : undefined;
  if (o.variant && !variant) fail(`build.variants に ${o.variant} がありません`);
  /** テスト版か（指摘の口を入れる）。 */
  const feedback = o.feedback ?? variant?.feedback === true;
  // 版ごとに書き出し先を分ける。テスト版は製品と同じ所に置かない（そのまま配らないように。lim publish もテスト版を見て止める）
  const fileSafeName = `${fileName}${o.variant ? `_${o.variant}` : ""}${feedback ? "_test" : ""}`;
  // Linux 版の実行ファイルは、既定でプロジェクト ID（端末から打ちやすいように）
  const linuxExe = b.executableName ?? cfg.id;
  const version = process.env.LIMINALIA_VERSION ?? cfg.version ?? "1.0.0";
  // id・版・エディションの名前をつないだフォルダとファイルの名前が、書き出し先の外や隣の書き出しを指さないか（何かを消す前に確かめる）
  const unsafe = unsafeExportNames(exportPathNames({ targets: o.targets, id: cfg.id, variant: o.variant, feedback, fileSafeName, version, linuxExe }));
  if (unsafe.length > 0) fail(`書き出す名前 ${unsafe.map((n) => JSON.stringify(n)).join("、")} はフォルダやファイルの名前に使えません（liminalia.json の id と version、エディションの名前に / と \\ と制御文字を書かず、. と .. にしません）`);
  const useAsar = envFlag("LIMINALIA_ASAR", b.asar ?? true);
  const resizable = envFlag("LIMINALIA_RESIZE", b.resizable ?? true);
  // 配る形。Windows の zip は既定で作り、Mac の zip と dmg、ブラウザ版の zip は頼まれたときだけ（lim build --zip・--dmg か build.mac・build.browser）
  const zip = o.packaging?.browserZip || o.packaging?.macZip || envFlag("LIMINALIA_ZIP", true);
  // デスクトップ版の CPU（書き出す先の分を、組み立てる前に確かめる。値の誤りで途中の先から止まらないように）
  const arches = {
    mac: o.targets.includes("mac") ? desktopArch("mac", process.env, b.mac?.arch) : "universal",
    windows: o.targets.includes("windows") ? desktopArch("windows", process.env, b.windows?.arch) : "x64",
    linux: o.targets.includes("linux") ? desktopArch("linux", process.env, b.linux?.arch) : "x64",
  } as const;
  const macZip = o.packaging?.macZip ?? envFlag("LIMINALIA_ZIP", b.mac?.zip ?? false);
  const macDmg = o.packaging?.macDmg ?? envFlag("LIMINALIA_DMG", b.mac?.dmg ?? false);
  const browserZip = o.packaging?.browserZip ?? envFlag("LIMINALIA_ZIP", b.browser?.zip ?? false);
  if (o.targets.includes("mac") && macDmg && process.platform !== "darwin") fail("Mac 版の dmg は Mac でだけ作れます（hdiutil を使うため）。dmg を作らないなら build.mac.dmg を外してください");
  const forbid = [...(b.forbid ?? []), ...(variant?.forbid ?? [])];
  const steam = steamFor(b.steam, o.steam);
  if (steam && (o.targets.includes("mac") || o.targets.includes("windows") || o.targets.includes("linux"))) console.log(`  Steam: App ID ${steam.appId}`);
  const exclude = [...(b.exclude ?? []), ...(variant?.exclude ?? [])];
  /**
   * ブラウザ版とデスクトップ版の素材を縮める設定（build.browser.compress・build.desktop.compress。書かなければ null で、元の素材を使う）。
   * 環境変数 LIMINALIA_COMPRESS=0 なら縮めない。lim patch の比べるための書き出しは、前の書き出しの種類と同じ縮め方にする。
   */
  const compression = (kind: "browser" | "desktop"): MobileCompression | null => {
    const like = kind === "browser" && o.forPatch ? o.forPatch : kind;
    const settings = like === "browser" ? b.browser?.compress : b.desktop?.compress;
    return settings && (settings.audio || settings.images) && envFlag("LIMINALIA_COMPRESS", true) ? settings : null;
  };
  /**
   * 素材とシナリオを暗号にする鍵（build.encrypt のときだけ使う）。作品ごとに一つ（.liminalia/encrypt-key に控え、どの OS の書き出しも同じ鍵）。
   * パッチ（lim patch）は前の書き出しのアプリの中の鍵を使うので、控えが無くなっても前の書き出しには合う。
   */
  const assetKey = b.encrypt ? encryptionKey(project.root) : randomBytes(32);
  /** ブラウザ版の鍵（build.browser.encrypt。公開したページから読めるので、デスクトップ版とは別の鍵）。 */
  const browserEncrypt = !!b.browser?.encrypt && o.targets.includes("browser") && !o.forPatch;
  /** 書き出した index.html に CSP を入れる（build.csp。止まったときの記録の送り先は取り寄せを許す）。 */
  const crashOrigin = b.crashReport?.url ? originOf(b.crashReport.url) : null;
  /** テスト版なら、指摘の送り先も取り寄せを許す。 */
  const feedbackOrigin = feedback && b.feedback?.url ? originOf(b.feedback.url) : null;
  /** 遊ばれ方の統計の送り先（build.analytics）も取り寄せを許す。 */
  const analyticsOrigin = b.analytics?.url ? originOf(b.analytics.url) : null;
  const connect = [crashOrigin, feedbackOrigin, analyticsOrigin].filter((x): x is string => x !== null);
  /** 書き出したゲームが送るもの（ストアへの申告。mobile/privacy.ts）。テスト版の指摘は送り先があるときだけ。 */
  const collected = { crashReport: !!b.crashReport?.url, analytics: !!b.analytics?.url, feedback: feedback && !!b.feedback?.url };
  const addCsp = (index: string) => writeFileSync(index, injectCsp(readFileSync(index, "utf8"), b.csp, connect.length > 0 ? { connect: [...new Set(connect)] } : {}));
  /** ブラウザ版をオフラインで遊べるようにするか（build.browser.offline。既定 true。lim patch が比べる書き出しには入れない）。 */
  const browserOffline = o.forPatch ? false : (b.browser?.offline ?? true);

  // デスクトップ版のアイコン（無ければ Mac 版は Electron のロゴ、Windows 版と Linux 版はアイコンなしになる）。Steam に出す版は止める
  if (o.targets.some((t) => t === "mac" || t === "windows" || t === "linux")) {
    const problem = desktopIconProblem(project.root, b.icon, b.winIcon);
    if (problem && steam) fail(`Steam 向けのアイコン: ${problem}`);
    if (problem) console.warn(`  警告: ${problem}`);
  }

  // 配布用の署名（時間のかかる組み立ての前に、証明書と道具があるかを確かめる）
  let macSign: ReturnType<typeof macSigning> = null;
  if (o.targets.includes("mac")) {
    try {
      macSign = macSigning(b.mac, project.root);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    if (macSign) {
      const problem = checkMacSigning(macSign);
      if (problem) fail(problem);
      console.log(`  Mac 版の署名: ${macSign.identity}${macSign.notary ? "（公証して staple する）" : "（公証の認証情報が無いため署名だけ。ダウンロードして開くと Gatekeeper に止められます）"}`);
    }
  }
  let winSign: ReturnType<typeof windowsSigning> = null;
  if (o.targets.includes("windows")) {
    try {
      winSign = windowsSigning(b.windows?.sign, project.root);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    if (winSign?.problem) {
      if (winSign.ifMissing === "skip") console.warn(`  警告: ${winSign.problem}。Windows 版は署名せずに書き出します`);
      else fail(`${winSign.problem}（署名せずに書き出すなら build.windows.sign.ifMissing を "skip" にしてください）`);
    } else if (winSign?.signer) console.log(`  Windows 版の署名: ${winSign.signer.kind === "command" ? `外部のコマンド（${winSign.signer.command[0]}）` : `${winSign.signer.kind}（${basename(winSign.signer.pfx)}）`}`);
  }
  // Windows のインストーラー（build.windows.installer）。makensis が無ければ組み立てる前に止める
  const installerCfg = b.windows?.installer;
  const installer = o.targets.includes("windows") && installerCfg && envFlag("LIMINALIA_INSTALLER", true) ? (installerCfg === true ? {} : installerCfg) : null;
  const makensis = installer ? findMakensis() : null;
  if (installer && !makensis) fail(`Windows のインストーラーを作る makensis（NSIS）が見つかりません。${makensisHowTo()}（インストーラーを作らずに書き出すなら、環境変数 LIMINALIA_INSTALLER=0 か、build.windows.installer を外してください）`);
  // 包むコマンドの書き方も先に確かめる
  if (o.targets.includes("windows")) wrapCommand(b.windows?.wrap);
  /** その OS の Electron の Fuses（build.desktop.fuses。false なら null で、手を付けない）。 */
  const fusesFor = (platform: "darwin" | "win32" | "linux"): GameFuses | null => {
    const configured = b.desktop?.fuses;
    if (configured === false) return null;
    const r = gameFuses({ platform, asar: useAsar, ...(configured ? { overrides: configured } : {}) });
    return r.problem ? fail(r.problem) : r.fuses;
  };
  // 設定の書き間違いは組み立てる前に止める
  for (const [target, platform] of [["mac", "darwin"], ["windows", "win32"], ["linux", "linux"]] as const) if (o.targets.includes(target)) fusesFor(platform);
  /** Windows のファイルに署名する（署名の設定が無ければ何もしない）。 */
  const signWin = (file: string) => {
    const signer = winSign?.signer;
    if (!signer) return;
    console.log(`  署名: ${basename(file)}`);
    try {
      signWindowsFile(signer, file, { name: appName });
    } catch (e) {
      fail(`${basename(file)} に署名できませんでした\n${signError(e)}`);
    }
  };

  // ---- 2. 素材の参照と、書き出しに入れる素材 ----
  step("素材の参照を確認");
  // テスト版は、無い画像と音を札と無音にして入れる（絵と音がそろう前の台本を読んでもらう）。札は一時フォルダに作る
  const placeholderDir = feedback ? join(tmpdir(), `liminalia-placeholders-${process.pid}`) : null;
  if (placeholderDir) {
    rmSync(placeholderDir, { recursive: true, force: true });
    process.once("exit", () => rmSync(placeholderDir, { recursive: true, force: true }));
  }
  const placeholders = checkAssetReferences(ctx, placeholderDir ? { placeholders: placeholderDir } : {});
  // 入れる素材（build.forbid に当たるものがあれば、組み立てる前に止める）。素材は書き出し先ごとに、元の場所から直接写す
  const selected = selectAssets(project.paths.assets, forbid, exclude);
  // 使っている素材だけ（lim build --only-used・build.onlyUsed）。lim unused の候補を外す
  if (o.onlyUsed ?? b.onlyUsed === true) {
    const { drop, kept, guessed } = await assetsToDropForBuild(project.root);
    const bytes = new Map(drop.map((a) => [a.path, a.bytes]));
    let removed = selected.files.filter((f) => bytes.has(f.rel));
    // 外す素材を使う所が検査で見つかれば戻す（外す判定と別の入力で確かめる。@flipbook のコマ、プラグインの既定の素材など）
    const { needed, problems } = assetsNeededByCheck(ctx, removed.map((f) => f.rel));
    if (needed.length > 0) {
      const back = new Set(needed);
      removed = removed.filter((f) => !back.has(f.rel));
      console.log(`  外すと検査で問題が出るので、次の ${needed.length} 件は外しません（${needed.slice(0, 5).join("、")}${needed.length > 5 ? ` ほか ${needed.length - 5} 件` : ""}）: ${problems[0]!.message}`);
    }
    const gone = new Set(removed);
    selected.files = selected.files.filter((f) => !gone.has(f));
    if (removed.length > 0) selected.skipped.set("build.onlyUsed", removed.length);
    console.log(`  使っている素材だけを入れます: ${removed.length} 件（${formatBytes(removed.reduce((n, f) => n + bytes.get(f.rel)!, 0))}）を外しました（一覧は lim unused）`);
    if (removed.length > 0) console.log(`  外した素材: ${removed.slice(0, 10).map((f) => f.rel).join("、")}${removed.length > 10 ? ` ほか ${removed.length - 10} 件` : ""}`);
    for (const k of kept) {
      const u = k.uses[0]!;
      console.log(`  ${k.folder}/ は、素材の名前を式で組み立てる命令が ${k.uses.length} か所（最初は ${u.file}.lim:${u.line} ${u.source}）あるので、使っていない候補 ${k.files} 件も外しません`);
    }
    if (guessed.length > 0) {
      const g = guessed[0]!;
      console.log(`  連番の型か、式でつなぐ名前の一部が文字に出てくるので、${guessed.length} 件は外しません（最初は ${g.path}。${g.where}:${g.line}）`);
    }
  }
  // 濁点などの合成だけが違う名前は、台本などが書いた形で写す
  const aligned = alignBuildAssetNames(ctx, selected.files);
  selected.files = aligned.files;
  if (aligned.renamed.length > 0) console.log(`  濁点などの文字の合成が台本と違う名前の素材 ${aligned.renamed.length} 件を、台本に書いた形の名前で入れます（最初は ${aligned.renamed[0]!.rel}）`);
  const assets = [...selected.files, ...placeholders];
  const out = o.outDir ?? project.paths.out;
  /** 素材を写すときの空きを確かめる。複製できないディスクで空きが足りなければ止め、写し方を返す。 */
  const ensureSpace = (pairs: readonly CopyPair[], toDir: string) => {
    const plan = planCopy(pairs, toDir);
    if (!plan.enough) {
      const where = relative(project.root, toDir);
      fail(`空きが足りません: 素材をコピーするのに ${formatBytes(plan.needed)} 要りますが、${where === "" || where.startsWith("..") ? toDir : where} のあるディスクの空きは ${formatBytes(plan.free)} です（このディスクへは素材を複製できないため、中身をコピーします）。空きを作ってから書き出し直してください`);
    }
    return plan;
  };
  /** 素材を toDir へ写す（同じ APFS のディスクなどへは複製。中身を写すなら先に空きを確かめる）。 */
  const copyAssets = (files: readonly AssetFile[], toDir: string): void => {
    const pairs = files.map((f) => ({ from: f.file, to: join(toDir, f.rel) }));
    copyFiles(pairs, ensureSpace(pairs, toDir));
  };
  // ブラウザ版は素材を書き出し先へ写すので、複製できないディスクなら組み立てる前に空きを確かめる（縮めるなら縮めたものを写すときに確かめる）
  if (o.targets.includes("browser") && !compression("browser")) ensureSpace(assets.map((f) => ({ from: f.file, to: join(out, "browser", f.rel) })), join(out, "browser"));
  checkBuildSpace();

  /**
   * 書き出し全体に要る空きを、組み立てる前に見積もって確かめる（素材を写す分のほか、Electron の本体、assets.asar、暗号化した素材の写し、
   * 配る形の zip や dmg やインストーラーの分。build-space.ts）。足りなければ、途中で書けなくなる前に止める。
   */
  function checkBuildSpace(): void {
    const pairs = (dir: string) => assets.map((f) => ({ from: f.file, to: join(dir, f.rel) }));
    const toOut = planCopy(pairs(join(out, "browser")), out);
    const toWork = planCopy(pairs(tmpdir()), tmpdir());
    const sameDisk = statSync(toOut.dir).dev === statSync(toWork.dir).dev;
    const estimate = estimateBuildSpace({
      targets: o.targets,
      assets: assets.reduce((n, f) => n + statSync(f.file).size, 0),
      copyToOut: [...toOut.methods.values()].includes("copy"),
      copyToWork: [...toWork.methods.values()].includes("copy"),
      sameDisk,
      asar: useAsar,
      encrypt: !!b.encrypt,
      browserEncrypt,
      browserZip,
      zip,
      macZip,
      macDmg,
      installer: !!installer,
      macUniversal: o.targets.includes("mac") && arches.mac === "universal",
    });
    const rel = relative(project.root, toOut.dir);
    const where = rel === "" ? "." : rel.startsWith("..") ? toOut.dir : rel;
    const outNeed = estimate.out + (sameDisk ? estimate.work : 0) + SPACE_RESERVE;
    if (sameDisk) console.log(`  空きの見込み: 約 ${formatBytes(outNeed)}（${where} のあるディスクの空き ${formatBytes(toOut.free)}）`);
    else console.log(`  空きの見込み: 書き出し先に約 ${formatBytes(outNeed)}（空き ${formatBytes(toOut.free)}）、一時フォルダに約 ${formatBytes(estimate.work + SPACE_RESERVE)}（空き ${formatBytes(toWork.free)}）`);
    if (outNeed > toOut.free) fail(`空きが足りません: 書き出しに約 ${formatBytes(outNeed)} 要りますが、${where} のあるディスクの空きは ${formatBytes(toOut.free)} です（Electron の本体、asar、暗号化、配る形の zip や dmg の分を含めた見込み）。空きを作ってから書き出し直してください`);
    if (!sameDisk && estimate.work + SPACE_RESERVE > toWork.free) fail(`空きが足りません: 書き出しの作業に約 ${formatBytes(estimate.work + SPACE_RESERVE)} 要りますが、一時フォルダ（${toWork.dir}）のあるディスクの空きは ${formatBytes(toWork.free)} です（Electron の本体、asar、暗号化、配る形の zip や dmg の分を含めた見込み）。空きを作ってから書き出し直してください`);
  }

  // ---- 3. 中身を組み立てる ----
  const work = join(tmpdir(), `liminalia-build-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  process.once("exit", cleanup);
  const webDir = join(work, "web");
  /** 書き出した日時（project/build.json の date。止まったときの記録の build と、残すソースマップのフォルダの名前に入る）。 */
  const builtAt = new Date().toISOString();
  /** 素材を一つのフォルダに集めたもの（デスクトップ版の asar と暗号化に使う）。要るときに一度だけ作る。 */
  let assetsOut: string | null = null;
  const assetsFolder = (): string => {
    if (assetsOut) return assetsOut;
    const dir = join(work, "assets");
    mkdirSync(dir, { recursive: true });
    copyAssets(assets, dir);
    return (assetsOut = dir);
  };

  try {
    step("エンジンとプラグインをビルド（Vite）");
    process.env.LIMINALIA_PROJECT = project.root;
    // 版（vite.config.ts の projectModule がプレイヤーに渡す）
    if (o.variant) process.env.LIMINALIA_VARIANT = o.variant;
    else delete process.env.LIMINALIA_VARIANT;
    // テスト版の指摘の口（vite.config.ts の define。製品の書き出しでは、口の部品ごと束に入らない）
    if (feedback) {
      process.env.LIMINALIA_FEEDBACK = "1";
      if (b.feedback?.url) console.log(`  テスト版: フィードバック機能を入れます（送り先 ${b.feedback.url}）`);
      else console.log("  テスト版: フィードバック機能を入れます（遊ぶ人がファイルに保存して渡す）");
    } else delete process.env.LIMINALIA_FEEDBACK;
    // 遊ばれ方の統計（build.analytics）を送る部品は、送り先を書いた作品の書き出しにだけ入れる（vite.config.ts の define）
    if (b.analytics?.url) process.env.LIMINALIA_ANALYTICS = "1";
    else delete process.env.LIMINALIA_ANALYTICS;
    // ソースマップ（build.sourcemap。既定は作らない）。"separate" は配るファイルに入れずに書き出し先の sourcemaps/ に残し、止まったときの記録の
    // プログラムの位置を元に戻すのに使う。"include" は書き出しに入れる。LIMINALIA_BUILD_SOURCEMAP=1 も入れる（束の中身の内訳を調べるとき。
    // scripts/bundle-breakdown.mjs が読む）
    const sourcemap = process.env.LIMINALIA_BUILD_SOURCEMAP === "1" ? "include" : (b.sourcemap ?? null);
    /** 今回残したソースマップの控え（片付けで消さない）。 */
    let mapsDir: string | null = null;
    await viteBuild({
      root: WEB_ROOT,
      ...viteCache(project),
      base: "./",
      logLevel: "warn",
      // 束の大きさは Vite の目安（一つの束 500 KB）ではなく、下の engineSize で見る
      build: { outDir: webDir, emptyOutDir: true, assetsDir: "engine", target: "es2022", chunkSizeWarningLimit: Number.POSITIVE_INFINITY, sourcemap: sourcemap === "include" ? true : sourcemap === "separate" ? "hidden" : false },
      // 標準の命令の描画は、作品が使う部品だけを始めに読む（部品ごとに別の束。ほかは一つの束 core。engine-chunks.ts）
      plugins: [devToolsGuard(), stripCommandDocs(), squeezeScreenTemplates(), engineChunks()],
      // 書き出したゲームの印。遊ぶ側の台本の検査と、制作画面の部品の見本を束から外す（runtime.ts と web の main.ts）
      define: { __LIMINALIA_EXPORT__: "true" },
    });
    // 束の大きさ（エンジンの束が大きくなっていないかは、リポジトリのテストが目安と比べる。engine-bundle.test.ts）。
    // 標準の命令の描画は、作品が使う部品だけを遊び始める前に読み、ほかは使うときに読む（vite.config.ts の projectModule）
    const engine = engineBundle(webDir, stdWebFeatures(project));
    if (engine) console.log(`  エンジンとプラグイン: ${formatBytes(engine.bytes)}（gzip で ${formatBytes(engine.gzip)}）。遊び始める前に読むのは ${formatBytes(engine.initial.bytes)}（gzip で ${formatBytes(engine.initial.gzip)}）`);
    const devPages = DEV_PAGES.filter((page) => existsSync(join(webDir, page)));
    if (devPages.length > 0) fail(`書き出すエンジンに開発用のページが含まれています: ${devPages.join("、")}`);
    if (sourcemap === "separate") {
      const maps = childPath(join(out, SOURCEMAPS), `${browserBuildName(cfg.id, o.variant, feedback)}-${builtAt.replace(/[:.]/g, "-")}`) ?? fail(`ソースマップの控えの置き場が ${join(out, SOURCEMAPS)} の直下になりません`);
      const moved = moveSourceMaps(webDir, maps);
      mapsDir = maps;
      console.log(`  ソースマップ: ${relative(project.root, maps) || maps}（${moved} 件。配るファイルには入れない）`);
    } else if (sourcemap === "include") console.log("  ソースマップを書き出しに入れます（build.sourcemap）");

    step("シナリオとデータをコピー");
    // サブフォルダの台本（part1/chapter2）も同じ形で置く（遊ぶ側は project/scenario/<名前>.lim を読む）
    // 下書き（先頭のコメントに // lim: draft）のファイルは入れない
    for (const { name, path } of listScenarioFiles(project.paths.scenario)) if (!isDraftSource(readScenarioFile(path).text)) copyFile(path, join(webDir, "project/scenario", `${name}.lim`));
    if (existsSync(project.paths.data)) cpSync(project.paths.data, join(webDir, "project/data"), { recursive: true });
    if (existsSync(project.paths.cast)) copyFile(project.paths.cast, join(webDir, "project/cast.json"));
    // 多言語の訳（原文以外の言語）
    for (const language of (project.config.languages ?? []).slice(1)) {
      const file = join(project.paths.lang, `${language}.json`);
      if (existsSync(file)) copyFile(file, join(webDir, "project/lang", `${language}.json`));
      else console.warn(`  ${language} の翻訳ファイル（${file}）がないため、その言語では原文を表示します`);
    }

    // テスト用セーブ（同梱しないときも空のファイルを置き、起動時の読み込みで 404 を出さない）
    const seeds: SeedSave[] = [];
    if (o.seed) {
      const [file = "", label = null] = o.seed.target.split("#");
      step(`テスト用セーブデータを作成: ${o.seed.target}（${o.seed.mode}、スロット ${o.seed.slot}）`);
      const save = await buildSeedSave(ctx, { file, label, mode: o.seed.mode }).catch((e: Error) => fail(e.message));
      seeds.push({ id: o.seed.id ?? `${Date.now()}`, slot: o.seed.slot, title: o.seed.title ?? `テスト: ${o.seed.target}`, overwrite: o.seed.overwrite, save });
      console.log(`  ${save.position.unit}:${save.position.index} から始まるセーブデータを同梱します`);
    }
    writeFileSync(join(webDir, "project/seed-saves.json"), JSON.stringify(seeds));
    // 何の書き出しか（lim patch が前の書き出しの版を知るため）と、使ったエンジンの版（プログラムには埋めない。版を上げただけで本体が変わらないように）
    // 外部の部品のライセンスの文書（ブラウザ版はフォルダの一番上に出る。デスクトップ版とスマホ版はアプリの中に入る）
    const licensesText = thirdPartyLicensesText(createRequire(import.meta.url)("vite/package.json").version);
    writeFileSync(join(webDir, THIRD_PARTY_LICENSES_FILE), licensesText);
    writeFileSync(join(webDir, "project/build.json"), JSON.stringify({ id: cfg.id, version: process.env.LIMINALIA_VERSION ?? cfg.version ?? "", engine: engineVersion(), ...(o.variant ? { variant: o.variant } : {}), ...(feedback ? { feedback: true } : {}), date: builtAt }));
    // 起動したときに読む一覧も、無いときは空のものを置く（404 を出さない。スマホ版で素材を縮めたときとパックがあるときは、あとで書き直す）
    writeFileSync(join(webDir, "project/assets-renamed.json"), "{}");
    writeFileSync(join(webDir, "project/audio-loops.json"), "{}");
    writeFileSync(join(webDir, "project/assets-scale.json"), "{}");
    mkdirSync(join(webDir, "packs"), { recursive: true });
    writeFileSync(join(webDir, "packs", "index.json"), "[]");
    // 遊ぶ人に見せるフローチャート（台本から作る）
    writeFileSync(join(webDir, "project/flow.json"), JSON.stringify(await projectFlow(project)));
    // 追加の中身・修正（作品のフォルダの packs/<id>/）。web の packs/ に入れ、入っているものの一覧を packs/index.json に
    const packDirs = projectPacks(project);
    if (packDirs.length > 0) {
      step("パックを追加");
      const ids: string[] = [];
      for (const dir of packDirs) {
        const r = await buildPack(project, dir, join(webDir, "packs", basename(dir)));
        for (const p of r.problems) console.warn(`  ${r.manifest.id}: ${p}`);
        if (r.problems.length > 0) fail(`パック ${r.manifest.id} のシナリオにエラーがあります`);
        ids.push(basename(dir));
        console.log(`  ${r.manifest.id}（シナリオ ${r.manifest.files!.scenario.length}、データ ${r.manifest.files!.data.length}、素材 ${r.manifest.files!.assets.length}）`);
      }
      writeFileSync(join(webDir, "packs", "index.json"), JSON.stringify(ids));
    }

    step("素材をコピー");
    console.log(`  ${assets.length} 件（${formatBytes(assets.reduce((n, f) => n + statSync(f.file).size, 0))}）。除外したもの: ${[...selected.skipped].map(([k, v]) => `${k} ${v}`).join("、") || "なし"}`);
    if (b.subsetFonts?.files.length) {
      step("フォントのサブセット化（build.subsetFonts）");
      // 縮める書体だけを作業のフォルダへ写して縮め、素材の一覧の元をそれに替える（元の素材は書き換えない）
      const fonts = join(work, "fonts");
      const byRel = new Map(assets.map((f) => [f.rel, f]));
      for (const rel of b.subsetFonts.files) {
        const font = byRel.get(rel.split(sep).join("/"));
        if (font) copyFile(font.file, join(fonts, font.rel));
      }
      for (const r of await subsetFonts(project, fonts, b.subsetFonts)) {
        console.log(`  ${r.file}: ${(r.before / 1024 / 1024).toFixed(1)} MB → ${(r.after / 1024).toFixed(0)} KB`);
        const font = byRel.get(r.file.split(sep).join("/"));
        if (font) font.file = join(fonts, font.rel);
      }
    }
    writeFileSync(join(webDir, "project/assets.json"), JSON.stringify(assetHashes(assets)));

    // ---- 4. 書き出し先ごと ----
    /** 縮めた素材（設定 → 結果。compressedFor が作る）。 */
    const compressed = new Map<string, Promise<CompressResult & { dir: string }>>();
    const results: string[] = [];
    for (const target of o.targets) {
      if (target === "browser") results.push(...(await buildBrowser()));
      if (target === "mac") results.push(...(await buildMac()));
      if (target === "windows") results.push(...(await buildWindows()));
      if (target === "linux") results.push(...(await buildLinux()));
      if (target === "android") results.push(...(await buildAndroidApp()));
      if (target === "ios") results.push(...(await buildIosApp()));
    }
    console.log("\n書き出しました:");
    for (const r of results) console.log(`- ${relative(project.root, r)}`);
    o.results?.push(...results);
    // 書き出しの記録（作品の版と、使ったエンジンの版。書き出し先の build-history.jsonl に一行ずつ足す）。lim patch の比べるための書き出しは残さない
    if (!o.forPatch) {
      const history = recordBuild(out, { id: cfg.id, version, engine: engineVersion(), targets: o.targets, ...(o.variant ? { variant: o.variant } : {}), ...(feedback ? { feedback: true } : {}), outputs: results });
      console.log(`作品のバージョン ${version}、エンジンのバージョン ${engineVersion()}（${relative(project.root, history)} に記録）`);
    }
    // 日時付きの古い書き出しを片付ける（LIMINALIA_KEEP か build.keep、無ければ 3 件。0 なら片付けない。今回書き出した先だけ）
    let keep: number | null = null;
    try {
      keep = keepAfterBuild(b.keep, process.env.LIMINALIA_KEEP);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    if (keep !== null) {
      const targets = o.targets.filter((t): t is StampedTarget => (STAMPED_TARGETS as readonly string[]).includes(t));
      const removed = pruneBuilds(out, keep, { targets, protect: results.filter((r) => r.startsWith(out + sep)).map((r) => stampedRoot(out, r)) });
      if (removed.length > 0) console.log(`\n古い書き出しを ${removed.length} 件片付けました（${formatBytes(removed.reduce((n, x) => n + x.bytes, 0))}。build.keep: ${keep}）`);
    }
    // ソースマップの控え（build.sourcemap: "separate"）も書き出しのたびに溜まるので、名前ごとに build.keepSourcemaps（無ければ build.keep）件を残す
    let mapsKeep: number | null = null;
    try {
      mapsKeep = keepSourceMaps(b.keepSourcemaps, keep);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    if (mapsKeep !== null && !o.forPatch) {
      const removed = pruneSourceMaps(out, mapsKeep, { protect: mapsDir ? [mapsDir] : [] });
      if (removed.length > 0) console.log(`古いソースマップの控えを ${removed.length} 件片付けました（${formatBytes(removed.reduce((n, x) => n + x.bytes, 0))}。build.keepSourcemaps: ${mapsKeep}）`);
    }

    // ---- ブラウザ ----
    async function buildBrowser(): Promise<string[]> {
      step("ブラウザ版");
      // 前の書き出しを消して置き直すので、消すのは <書き出し先>/browser の直下だけ（入口の検査だけに頼らない）
      const dest = browserBuildDir(out, cfg.id, o.variant, feedback) ?? fail(`ブラウザ版の書き出し先が ${join(out, "browser")} の直下になりません（liminalia.json の id とエディションの名前に / と \\ を書かず、. と .. にしません）`);
      rmSync(dest, { recursive: true, force: true });
      cpSync(webDir, dest, { recursive: true });
      // 素材は元の場所（縮めるなら縮めたもの）から書き出し先へ直接写す
      const small = await compressedFor("browser");
      copyAssets(small ? folderFiles(small.dir) : assets, join(dest, "assets"));
      if (small) writeAssetLists(join(dest, "project"), small);
      if (browserEncrypt) {
        // 素材と作品の中身を暗号にし、戻す Service Worker を置いて、index.html はそれを入れてからエンジンを読む
        step("素材とシナリオを暗号化（build.browser.encrypt）");
        const key = encryptionKey(project.root, "browser");
        encryptProjectFiles(dest, key);
        encryptFolder(join(dest, "assets"), key);
        writeFileSync(join(dest, SERVICE_WORKER), serviceWorkerSource(key, browserOffline ? offlineCache(dest, browserOffline) : null));
        writeFileSync(join(dest, "index.html"), injectServiceWorkerLoader(readFileSync(join(dest, "index.html"), "utf8")));
        console.log("  https のページで遊べます（Service Worker で戻すため。file:// では開けません）");
      } else if (browserOffline) {
        // 一度開いたら、オフラインでも遊べるように控える（Service Worker。入れられない場所でもそのまま遊べる）
        const offline = offlineCache(dest, browserOffline);
        writeFileSync(join(dest, SERVICE_WORKER), serviceWorkerSource(null, offline));
        writeFileSync(join(dest, "index.html"), injectServiceWorkerRegister(readFileSync(join(dest, "index.html"), "utf8")));
        if (browserOffline === "all") console.log(`  オフラインで遊べるように、はじめて開いたときに素材も含めて ${offline.precache.length} 個を控え、書体は使ったときに控えます（build.browser.offline）`);
        else console.log(`  オフラインで遊べるように、はじめて開いたときに ${offline.precache.length} 個を控え、素材と書体は使ったときに控えます（build.browser.offline）`);
      }
      addCsp(join(dest, "index.html"));
      console.log(`  ${relative(project.root, dest)}（${sizeOf(dest)}）`);
      const made = [dest];
      if (browserZip) {
        // itch.io などは index.html が zip の一番上に無いと遊べないので、フォルダの中身を zip にする
        const zipPath = `${dest}.zip`;
        rmSync(zipPath, { force: true });
        await zipContents(dest, zipPath);
        console.log(`  ${relative(project.root, zipPath)}（${sizeOf(zipPath)}。index.html が zip の一番上）`);
        made.push(zipPath);
      }
      if (o.verify) await verifyBrowser(dest, join(out, "browser", "verify-title.png"), b.verifyWait ?? 2500);
      return made;
    }

    /** オフラインで控えるもの（エンジン・台本・データ。"all" なら素材も、遊ぶ側が付ける中身の鍵 ?v= ごと）。 */
    function offlineCache(dest: string, mode: true | "all"): OfflineCache {
      const url = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");
      const files = walk(dest).map((f) => relative(dest, f).split(sep).join("/"));
      const precache = ["./", ...files.filter(precacheAtInstall).map(url)];
      if (mode === "all") {
        const read = (name: string) => {
          try {
            return JSON.parse(readFileSync(join(dest, "project", name), "utf8")) as Record<string, string>;
          } catch {
            // 前の書き出しの一覧が無い・読めないときは、無いものとして全部を書く
            return {};
          }
        };
        const hashes = read("assets.json");
        // 縮めて名前が変わった素材（遊ぶ側は元の名前の鍵で ?v= を付ける）
        const original = new Map(Object.entries(read("assets-renamed.json")).map(([from, to]) => [to, from]));
        for (const f of files.filter((f) => f.startsWith("assets/"))) {
          const key = f.slice("assets/".length);
          const hash = hashes[original.get(key) ?? key];
          precache.push(`${url(f)}${hash ? `?v=${hash}` : ""}`);
        }
      }
      const prefix = `lm-${cfg.id}-`;
      return { cache: `${prefix}${cfg.version ?? ""}-${Date.now().toString(36)}`, prefix, precache };
    }

    // ---- スマホ ----
    /**
     * スマホ版に入れる Web 版（エンジン・シナリオ・素材を一つのフォルダに）。build.mobile があれば素材を縮める
     * （名前が変わったものは project/assets-renamed.json に、元の音に埋め込まれていたループの位置は project/audio-loops.json に書き、
     * 中身の鍵も縮めたもので作り直す）。
     */
    async function mobileWeb(): Promise<string> {
      const dir = join(work, "mobile-web");
      if (existsSync(dir)) return dir;
      cpSync(webDir, dir, { recursive: true });
      copyAssets(assets, join(dir, "assets"));
      const mobile = b.mobile;
      if (mobile && (mobile.audio || mobile.images)) {
        step("スマホ版の素材を圧縮（build.mobile）");
        const r = await compressFolder(join(dir, "assets"), mobile, join(project.root, ".liminalia", "build-cache", "mobile"));
        writeAssetLists(join(dir, "project"), r);
      }
      return dir;
    }

    /** 縮めるのに要る道具を確かめて assets を縮め、結果を出す（スマホ版・ブラウザ版・デスクトップ版で同じ）。 */
    async function compressFolder(assets: string, settings: MobileCompression, cache: string): Promise<CompressResult> {
      const missing = await missingTools(settings);
      if (missing.length > 0) fail(`素材の圧縮には ${missing.join("、")} が必要です（brew install ffmpeg webp など）`);
      const r = await compressAssets(assets, settings, cache);
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (settings.audio) console.log(`  音声: ${r.audio.files} 件 ${mb(r.audio.before)} → ${mb(r.audio.after)}`);
      if (settings.images) console.log(`  画像: ${r.images.files} 件 ${mb(r.images.before)} → ${mb(r.images.after)}`);
      if (Object.keys(r.scaled).length > 0) console.log(`  解像度: ${Object.keys(r.scaled).length} 件を ${settings.images?.scale} 倍に下げました（遊ぶときは元の大きさで出す）`);
      if (Object.keys(r.loops).length > 0) console.log(`  ループの位置: ${Object.keys(r.loops).length} 件を元の音から引き継ぎました`);
      return r;
    }

    /**
     * 縮めた素材の一覧を、書き出しの project/ に書く。名前が変わったものは assets-renamed.json に、元の音に埋め込まれていたループの位置は
     * audio-loops.json に（縮めると OGG のタグが消えるかずれるので、遊ぶ側は埋め込みより先に使う）。中身の鍵も縮めたもので作り直す
     * （鍵は元の名前で引くので、名前が変わったものは縮めたものの鍵にする）。
     */
    function writeAssetLists(projectDir: string, r: CompressResult): void {
      const assets = join(projectDir, "..", "assets");
      writeFileSync(join(projectDir, "assets-renamed.json"), JSON.stringify(r.renamed));
      writeFileSync(join(projectDir, "audio-loops.json"), JSON.stringify(r.loops));
      // 解像度を下げた画像（遊ぶ側は元の大きさの絵として出す）
      writeFileSync(join(projectDir, "assets-scale.json"), JSON.stringify(r.scaled));
      const hashes = assetHashes(folderFiles(existsSync(assets) ? assets : r.dir));
      for (const [from, to] of Object.entries(r.renamed)) if (hashes[to]) hashes[from] = hashes[to]!;
      writeFileSync(join(projectDir, "assets.json"), JSON.stringify(hashes));
    }

    /**
     * ブラウザ版とデスクトップ版の素材を縮めたもの（build.browser.compress・build.desktop.compress。書かなければ null で、元の素材を使う）。
     * 縮めた素材のフォルダと結果を、同じ設定なら一度だけ作る。環境変数 LIMINALIA_COMPRESS=0 なら縮めない。
     */
    function compressedFor(kind: "browser" | "desktop"): Promise<(CompressResult & { dir: string }) | null> {
      const settings = compression(kind);
      if (!settings) return Promise.resolve(null);
      const key = JSON.stringify(settings);
      let made = compressed.get(key);
      if (!made) {
        made = (async () => {
          if (kind === "browser") step("ブラウザ版の素材を圧縮（build.browser.compress）");
          else step("デスクトップ版の素材を圧縮（build.desktop.compress）");
          const dir = join(work, `assets-compressed-${compressed.size}`);
          copyAssets(assets, dir);
          return { ...(await compressFolder(dir, settings, join(project.root, ".liminalia", "build-cache", "compress"))), dir };
        })();
        compressed.set(key, made);
      }
      return made;
    }

    /** ストアの版の番号（環境変数 LIMINALIA_BUILD_NUMBER、build.buildNumber、version から作る。storeBuildNumber）。 */
    function buildNumber(): number {
      const r = storeBuildNumber(version, process.env.LIMINALIA_BUILD_NUMBER ?? b.buildNumber);
      return typeof r === "number" ? r : fail(r.problem);
    }

    /**
     * アプリの ID（build.bundleId）。OS の名前の決まりに合わせる。
     * Android の名前は英数字と _ だけで、区切りごとに英字で始める。iOS は英数字と - と . だけ（_ は使えない）。
     */
    function mobileAppId(os: "android" | "ios"): string {
      const raw = process.env.LIMINALIA_BUNDLE_ID ?? b.bundleId ?? `liminalia.game.${cfg.id}`;
      if (!b.bundleId && !process.env.LIMINALIA_BUNDLE_ID) console.log(`  警告: build.bundleId がないため ${raw} を使います`);
      if (os === "ios") return raw.replace(/[^A-Za-z0-9.-]/g, "-");
      return raw
        .split(".")
        .map((part) => part.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "g"))
        .join(".");
    }

    /** 起動の演出（ui.splash）の最初のロゴの地の色（"#rrggbb" の形のときだけ。スマホ版の起動の画面の色）。 */
    function launchColor(): string | null {
      const first = cfg.ui?.splash?.logos?.[0]?.background?.trim();
      return first && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(first) ? first : null;
    }

    /** 横長の作品か（スマホ版の向き）と、アイコン（PNG）とその地の色。build.icon のファイルが無ければ知らせる。 */
    function mobileLook(): { landscape: boolean; icon: string | null; iconBackground?: string } {
      const icon = b.icon ? resolve(project.root, b.icon) : null;
      if (b.icon && !existsSync(icon!)) console.warn(`  警告: アイコン ${b.icon} が見つかりません`);
      return { landscape: project.screen.width >= project.screen.height, icon: pngIcon(icon, work), ...(b.iconBackground ? { iconBackground: b.iconBackground } : {}) };
    }

    async function buildAndroidApp(): Promise<string[]> {
      // Google Play 向けの App Bundle（--aab か build.androidAab）
      const aab = o.aab ?? envFlag("LIMINALIA_AAB", b.androidAab ?? false);
      // targetSdk は作品の設定（既定は Google Play の下限）。その版の SDK Platform が無ければ、Web 版を作る前に止める
      const targetSdk = b.android?.targetSdk ?? PLAY_TARGET_SDK;
      if (aab && targetSdk < PLAY_TARGET_SDK) fail(`Google Play に上げる App Bundle は targetSdk ${PLAY_TARGET_SDK} 以上が要ります（build.android.targetSdk が ${targetSdk}）`);
      try {
        compilePlatform(findAndroidTools().sdk, targetSdk);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let installed: number[] = [];
        try {
          installed = [...androidPlatforms(findAndroidTools().sdk).keys()].filter((n) => n >= 33);
        } catch {
          // SDK が見つからない
        }
        const newest = Math.max(0, ...installed);
        // 手元の端末で試すだけなら、入っている版を targetSdk に書けば書き出せる（Google Play には上げられない）
        if (newest > 0 && !aab) fail(`${message}。手元の端末で試すだけなら、liminalia.json の build.android.targetSdk に ${newest} を書けば書き出せます（Google Play には上げられません）`);
        fail(message);
      }
      if (targetSdk < PLAY_TARGET_SDK) console.warn(`  警告: targetSdk ${targetSdk}（build.android.targetSdk）の APK は Google Play に上げられません（今は ${PLAY_TARGET_SDK} 以上）`);
      // アイコンが無ければ知らせ、Google Play に上げる App Bundle は止める
      const look = mobileLook();
      if (!look.icon) {
        if (aab) fail("Google Play に上げる App Bundle にはアイコンが要ります。liminalia.json の build.icon に正方形の PNG（1024×1024 など）を書いてください");
        console.warn("  警告: アイコン（build.icon）が無いため、Android 版は Android の既定のアイコンで書き出します");
      }
      const web = await mobileWeb();
      step("Android 版");
      // ストアへの申告（Google Play のデータセーフティ。docs/distribution.md）
      console.log(`  ${collectedSummary(collected)}`);
      const dest = join(out, "android", `${fileSafeName}_${stamp()}.apk`);
      // アプリ内課金（Google Play Billing）。商品とライブラリの両方があるときだけ入れる
      const productIds = mobileProductIds(b.store?.products, "android");
      const libraries = (b.store?.android?.libraries ?? []).map((l) => resolve(project.root, l));
      if (productIds.length > 0 && libraries.length === 0) console.warn("  警告: build.store.android.libraries（Play Billing Library の AAR）が無いため、Android 版はアプリ内課金なしで書き出します");
      for (const l of libraries) if (!existsSync(l)) fail(`Play Billing Library のファイル ${l} がありません（build.store.android.libraries）`);
      // 実績（Google Play Games Services v2）。build.playGames があるときだけ入れる
      const playGames = b.playGames;
      const gamesProblems = playGamesProblems(playGames);
      if (gamesProblems.length > 0) fail(gamesProblems.join("\n"));
      const gamesLibraries = (playGames?.libraries ?? []).map((l) => resolve(project.root, l));
      for (const l of gamesLibraries) if (!existsSync(l)) fail(`Google Play Games のライブラリのファイル ${l} がありません（build.playGames.libraries）`);
      if (playGames) console.log(`  実績（Google Play Games）: ${Object.keys(playGames.achievements).join("、") || "（対応なし）"}`);
      // App Bundle の bundletool は組み立てる前に探す
      let bundletool: string[] | null = null;
      if (aab) {
        try {
          bundletool = findBundletool();
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      }
      const aabPath = dest.replace(/\.apk$/, ".aab");
      // 署名（keystore・alias・パスワードの環境変数の三つが揃っているとき。無ければ開発用の鍵）
      const a = b.android;
      const signing = a?.keystore && a.alias && a.storePasswordEnv ? { keystore: a.keystore, alias: a.alias, storePasswordEnv: a.storePasswordEnv, ...(a.keyPasswordEnv ? { keyPasswordEnv: a.keyPasswordEnv } : {}) } : null;
      try {
        buildAndroid({
          web,
          work,
          out: dest,
          appId: mobileAppId("android"),
          title: appName,
          version,
          versionCode: buildNumber(),
          ...look,
          targetSdk,
          ...(signing ? { signing } : {}),
          ...(productIds.length > 0 && libraries.length > 0 ? { billing: { libraries } } : {}),
          ...(playGames ? { playGames: { appId: playGames.appId, achievements: playGames.achievements, libraries: gamesLibraries } } : {}),
          ...(bundletool ? { bundle: { out: aabPath, bundletool } } : {}),
        });
      } catch (e) {
        const err = e as { stderr?: Buffer; message: string };
        fail(`Android 版をビルドできませんでした: ${(err.stderr?.toString().trim() || err.message).split("\n").slice(0, 20).join("\n")}`);
      }
      if (bundletool && signing) console.log(`  ${relative(project.root, aabPath)}（${sizeOf(aabPath)}。Google Play に上げる App Bundle）`);
      else if (bundletool) console.log(`  ${relative(project.root, aabPath)}（${sizeOf(aabPath)}。開発用の鍵で署名したので Google Play には上げられません。build.android にアップロード鍵を指定してください）`);
      console.log(`  ${relative(project.root, dest)}（${sizeOf(dest)}${signing ? "" : "。開発用の鍵で署名しました。ストアで公開するときは build.android に署名の鍵を指定してください"}）`);
      return bundletool ? [dest, aabPath] : [dest];
    }

    async function buildIosApp(): Promise<string[]> {
      // アイコンが無ければ知らせ、App Store に出す Archive は止める
      const look = mobileLook();
      if (!look.icon) {
        if (o.iosArchive?.method === "app-store") fail("App Store に出す iOS 版にはアイコンが要ります。liminalia.json の build.icon に正方形の PNG（1024×1024）を書いてください");
        console.warn("  警告: アイコン（build.icon）が無いため、iOS 版はアイコンなしで書き出します（App Store には上げられません）");
      }
      const web = await mobileWeb();
      step("iOS 版");
      const dest = join(out, "ios", `${fileSafeName}_${stamp()}`);
      const iosProducts = mobileProductIds(b.store?.products, "ios");
      if (iosProducts.length > 0) console.log(`  アプリ内課金（StoreKit 2）: ${iosProducts.join("、")}`);
      // 実績（Game Center）。build.gameCenter があるときだけ入れる
      if (b.gameCenter) console.log("  実績（Game Center）");
      // ストアへの申告（docs/distribution.md）。集める情報と、プライバシーマニフェスト（build.ios.privacyManifest で自分のものに替えられる）
      console.log(`  ${collectedSummary(collected)}`);
      const iosPrivacy = (): string => {
        const own = b.ios?.privacyManifest;
        if (!own) return privacyManifest(collected);
        const file = resolve(project.root, own);
        if (!existsSync(file)) fail(`build.ios.privacyManifest の ${own} がありません`);
        console.log(`  プライバシーマニフェスト: ${own}`);
        return readFileSync(file, "utf8");
      };
      const xcodeproj = createIosProject({
        web,
        dir: dest,
        appId: mobileAppId("ios"),
        title: appName,
        version,
        build: buildNumber(),
        ...look,
        ...(b.ios?.team ? { team: b.ios.team } : {}),
        ...(b.ios?.audioSession ? { audioSession: b.ios.audioSession } : {}),
        // 起動の画面は、ゲームの起動の演出（ui.splash）の最初の色に合わせる（無ければ黒）
        ...(launchColor() ? { launchBackground: launchColor()! } : {}),
        ...(iosProducts.length > 0 ? { products: iosProducts } : {}),
        ...(b.gameCenter ? { gameCenter: { achievements: b.gameCenter.achievements ?? {} } } : {}),
        privacy: iosPrivacy(),
      });
      if (o.iosArchive) console.log(`  ${relative(project.root, xcodeproj)}`);
      else console.log(`  ${relative(project.root, xcodeproj)}（App Store へは lim build ios --archive か、Xcode で開いて Product → Archive）`);
      if (o.iosArchive) return [xcodeproj, ...archiveAndExport(xcodeproj, dest, o.iosArchive)];
      if (o.device !== undefined) {
        if (process.platform !== "darwin") fail("実機へのインストールは Mac でのみできます");
        try {
          const device = pickIosDevice(o.device === true ? null : o.device);
          const team = iosTeam(b.ios?.team);
          step(`実機用にビルド（チーム ${team}）`);
          const app = buildIosDevice(xcodeproj, join(work, "ios-device"), team);
          step(`${device.name} にインストール`);
          installIos(app, device);
          console.log(`  ${device.name} にインストールしました`);
          // 起動できなくても、入れるのは済んでいるので書き出しは失敗にしない
          const launched = launchIos(device, mobileAppId("ios"));
          if (launched.ok) console.log(`  ${device.name} で起動しました`);
          else if (launched.locked) console.warn(`  起動できませんでした: ${device.name} がロックされています。ロックを解除して、ホーム画面からアプリを開いてください`);
          else console.warn(`  起動できませんでした（アプリはインストール済みです。ホーム画面から開いてください）:\n${launched.message.split("\n").slice(0, 5).join("\n")}`);
        } catch (e) {
          const err = e as { stderr?: Buffer; message: string };
          const lines = err.stderr?.toString().split("\n").filter((l) => /error/i.test(l)).slice(0, 20).join("\n");
          fail(`実機にインストールできませんでした\n${lines || err.message}`);
        }
      } else if (o.verify && process.platform === "darwin") {
        try {
          const app = buildIosSimulator(xcodeproj, join(work, "ios-build"));
          console.log(`  確認: シミュレータ用にビルドできました（${relative(work, app)}）`);
        } catch (e) {
          const err = e as { stderr?: Buffer; message: string };
          fail(`iOS 版をビルドできませんでした\n${(err.stderr?.toString() ?? err.message).split("\n").filter((l) => /error/i.test(l)).slice(0, 20).join("\n")}`);
        }
      }
      return [xcodeproj];
    }

    /** Archive を作り、ExportOptions.plist で書き出す（か App Store Connect へ上げる）。作ったものを返す。 */
    function archiveAndExport(xcodeproj: string, dest: string, a: NonNullable<BuildOptions["iosArchive"]>): string[] {
      if (process.platform !== "darwin") fail("iOS 版の Archive は Mac でだけ作れます（Xcode が要るため）");
      const key = appStoreConnectKey();
      if (a.upload && !key) fail("App Store Connect へ上げるには API キーが要ります（環境変数 LIMINALIA_ASC_KEY（.p8 のパス）、LIMINALIA_ASC_KEY_ID、LIMINALIA_ASC_ISSUER）");
      if (a.upload && a.method !== "app-store") fail("App Store Connect へ上げられるのは --export app-store だけです");
      let team = "";
      try {
        team = iosTeam(b.ios?.team);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      const archive = join(dest, "App.xcarchive");
      const exportDir = join(dest, "export");
      try {
        step(`Archive を作成（チーム ${team}）`);
        archiveIos(xcodeproj, archive, team);
        console.log(`  ${relative(project.root, archive)}`);
        step(a.upload ? "App Store Connect へアップロード" : `書き出し（${a.method}）`);
        const ipa = exportIos(archive, exportDir, exportOptionsPlist({ method: a.method, team, upload: a.upload, xcode: xcodeVersion() }), a.upload ? key : null);
        if (ipa) {
          console.log(`  ${relative(project.root, ipa)}（${sizeOf(ipa)}）`);
          if (a.method === "app-store") console.log("  App Store Connect へは、Transporter で上げるか、API キーを付けて lim build ios --archive --upload で上げます");
          return [archive, ipa];
        }
        console.log("  App Store Connect へ上げました（処理が済むと TestFlight に出ます）");
        return [archive];
      } catch (e) {
        const err = e as { stderr?: Buffer; stdout?: Buffer; message: string };
        const lines = `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`.split("\n").filter((l) => /error|requires|provisioning|certificate/i.test(l)).slice(0, 20).join("\n");
        // App Store 向けの署名は、Apple Developer Program（有料）に登録したチームでないと作れない
        if (a.method === "app-store" && /does not have permission|No profiles/i.test(lines)) return fail(`iOS 版を App Store 向けに書き出せませんでした。Apple Developer Program に登録したチームで、Xcode の Settings → Accounts にそのアカウントを入れてください（build.ios.team か LIMINALIA_IOS_TEAM でチームを選べます）\n${lines}`);
        return fail(`iOS 版を Archive・書き出しできませんでした\n${lines || err.message}`);
      }
    }

    // ---- デスクトップ ----
    async function stageElectronApp(platform: "darwin" | "win32" | "linux"): Promise<string> {
      const appDir = join(work, "electron-app");
      rmSync(appDir, { recursive: true, force: true });
      mkdirSync(appDir, { recursive: true });
      const desktop = desktopDir();
      // 殻のファイル（main.cjs、preload.cjs と、それが読む部品）はすべて入れる
      for (const f of readdirSync(desktop).filter((n) => n.endsWith(".cjs"))) copyFile(join(desktop, f), join(appDir, f));
      cpSync(webDir, join(appDir, "web"), { recursive: true });
      addCsp(join(appDir, "web", "index.html"));
      // 縮めた素材（build.desktop.compress）の一覧。素材そのものは addAssets が resources に入れる
      const small = await compressedFor("desktop");
      if (small) writeAssetLists(join(appDir, "web", "project"), small);
      // シナリオ・データ・キャスト・訳・フローチャートも暗号にする（build.encrypt。アプリが読むときに戻す）
      if (b.encrypt) encryptProjectFiles(join(appDir, "web"), assetKey);
      const updateCfg = updateFor(b.update, steam);
      // 作品のプラグインの店の口（build.store.desktop）。Steam につなぐ版では使わない。ファイルのあるフォルダごと store/ に入れる
      let storeModule: string | null = null;
      if (!steam && b.store?.desktop?.module) {
        const file = resolve(project.root, b.store.desktop.module);
        if (!existsSync(file)) fail(`ストア連携モジュールのファイル ${b.store.desktop.module} がありません（build.store.desktop.module）`);
        cpSync(dirname(file), join(appDir, "store"), { recursive: true });
        storeModule = `store/${basename(file)}`;
        console.log(`  ストア連携モジュールを追加: ${relative(project.root, file)}`);
      }
      writeFileSync(
        join(appDir, "game.json"),
        JSON.stringify({
          title: appName,
          id: cfg.id,
          width: project.screen.width,
          height: project.screen.height,
          resizable,
          ...(steam ? { steam } : {}),
          // セーブの保存先（書かなければ、Windows と Linux は実行ファイルの横、Mac は標準の場所。main.cjs が決める）
          ...(cfg.saves?.location ? { saves: cfg.saves.location } : {}),
          // 引き継げる作品（体験版など）の id → 題名（その作品のセーブの場所を探す）
          ...(cfg.saves?.carryFrom ? { carryFrom: cfg.saves.carryFrom } : {}),
          // 素材を暗号にした鍵（build.encrypt）
          ...(b.encrypt ? { encrypt: assetKey.toString("base64") } : {}),
          ...(b.gpu === "default" ? { gpu: "default" } : {}),
          ...(cfg.ui?.screen?.fullscreen === false ? { fullscreen: false } : {}),
          // アップデートの確認（build.update。Steam につなぐ版は Steam が配るので、update.steam が無ければ入れない）
          ...(updateCfg ? { update: updateCfg } : {}),
          ...(storeModule ? { store: { module: storeModule, ...(b.store?.desktop?.options ? { options: b.store.desktop.options } : {}) } } : {}),
        }),
      );
      // Steam につなぐ作品だけ、steamworks.js（Steam の部品と、その中の Steamworks SDK の再配布用のライブラリ）を入れる
      if (steam) {
        const steamworks = dirname(createRequire(import.meta.url).resolve("steamworks.js/package.json"));
        // ライブラリは書き出す OS の分だけ
        const dist = platform === "darwin" ? "dist/osx" : platform === "linux" ? "dist/linux64" : "dist/win64";
        for (const f of ["index.js", "package.json", "LICENSE", dist]) cpSync(join(steamworks, f), join(appDir, "node_modules", "steamworks.js", f), { recursive: true });
        console.log("  Steam のライブラリ（steamworks.js）を追加");
      }
      writeFileSync(
        join(appDir, "package.json"),
        JSON.stringify(
          { name: cfg.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase(), productName: appName, version, author: process.env.LIMINALIA_AUTHOR ?? cfg.author ?? appName, main: "main.cjs", private: true },
          null,
          2,
        ),
      );
      return appDir;
    }

    async function addAssets(resourcesDir: string): Promise<void> {
      const small = (await compressedFor("desktop"))?.dir;
      if (useAsar || b.encrypt) {
        const plain = small ?? assetsFolder();
        const source = b.encrypt ? encryptedAssets(plain) : plain;
        if (useAsar) return createPackage(source, join(resourcesDir, "assets.asar"));
        copyAssets(folderFiles(source), join(resourcesDir, "assets"));
      } else copyAssets(small ? folderFiles(small) : assets, join(resourcesDir, "assets"));
      // 複製は Finder の情報などの拡張属性も写す。Mac のアプリの中にあると署名（codesign）が通らないので外す
      if (process.platform === "darwin") spawnSync("/usr/bin/xattr", ["-cr", join(resourcesDir, "assets")], { stdio: "ignore" });
    }

    /** 素材を暗号にした写し（build.encrypt。デスクトップ版だけ。鍵は game.json に入れ、アプリが読むときに戻す）。 */
    function encryptedAssets(plain: string): string {
      const dir = join(work, `assets-encrypted-${basename(plain)}`);
      if (existsSync(dir)) return dir;
      step("素材を暗号化（build.encrypt）");
      for (const f of walk(plain)) {
        const to = join(dir, relative(plain, f));
        mkdirSync(dirname(to), { recursive: true });
        encryptAssetFile(f, to, assetKey, relativeName(plain, f));
      }
      return dir;
    }

    /**
     * Electron の Fuses を焼き込む（build.desktop.fuses。組み立てて素材を入れたあと、署名の前）。electron は Mac なら .app、
     * Windows なら .exe、Linux なら実行ファイル。asar の完全性を確かめるなら、後から入れた assets.asar を完全性の一覧に足す
     * （一覧に無い asar があると起動しない）。足せなければ完全性は確かめずに書き出す。
     */
    async function lockFuses(platform: "darwin" | "win32" | "linux", electron: string, resources: string): Promise<void> {
      const fuses = fusesFor(platform);
      if (!fuses) {
        console.log("  Fuses は既定のまま（build.desktop.fuses が false）");
        return;
      }
      const assetsAsar = join(resources, "assets.asar");
      if (fuses.EnableEmbeddedAsarIntegrityValidation && existsSync(assetsAsar)) {
        const problem = platform === "darwin" ? addMacAsarIntegrity(electron, [assetsAsar]) : addWindowsAsarIntegrity(electron, dirname(electron), [assetsAsar]);
        if (problem) {
          console.warn(`  警告: ${problem}。asar の完全性は確かめずに書き出します`);
          fuses.EnableEmbeddedAsarIntegrityValidation = false;
        }
      }
      await applyFuses(electron, fuses);
      console.log(`  Fuses: ${GAME_FUSE_NAMES.map((n) => `${n} ${fuses[n] ? "on" : "off"}`).join(", ")}`);
    }

    /**
     * Electron の言語のファイルを、作品の言語と英語の分だけにする（build.desktop.locales で足せ、"all" なら減らさない）。
     * Windows と Linux は locales/*.pak、Mac は .lproj（アプリと Electron Framework の中）。
     */
    function trimLocales(platform: "darwin" | "win32" | "linux", root: string): void {
      const extra = b.desktop?.locales;
      if (extra === "all") return;
      const languages = [...(cfg.languages ?? ["ja"]), ...(extra ?? [])];
      const dirs = platform === "darwin" ? [join(root, "Contents/Resources"), join(root, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources")] : [join(root, "locales")];
      const removed = removeElectronLocales(dirs, languages);
      if (removed > 0) console.log(`  Electron の言語のファイルを、作品の言語と英語の分だけにしました（${removed} 個を除く。build.desktop.locales）`);
    }

    async function buildMac(): Promise<string[]> {
      const arch = arches.mac;
      step(`Mac 版（${arch}）`);
      const icon = macIcon(work, project.root, b.icon);
      const dest = join(out, "mac", `${fileSafeName}_${stamp()}`);
      mkdirSync(dest, { recursive: true });
      const bundleId = process.env.LIMINALIA_BUNDLE_ID ?? b.bundleId ?? `liminalia.game.${cfg.id.replace(/[^A-Za-z0-9.-]/g, "-")}`;
      if (!b.bundleId && !process.env.LIMINALIA_BUNDLE_ID) console.log(`  警告: build.bundleId がないため ${bundleId} を使います`);
      const [appParent] = await packager({
        dir: await stageElectronApp("darwin"),
        out: join(work, "mac"),
        name: fileName,
        platform: "darwin",
        arch,
        electronVersion: electronVersion(),
        appVersion: version,
        appBundleId: bundleId,
        appCategoryType: "public.app-category.adventure-games",
        // Steam の部品は Intel 用と Apple Silicon 用を両方持つ（同じファイルが両方の組み立てに入るので、そのまま使ってよいと教える）
        ...(arch === "universal" ? { osxUniversal: { x64ArchFiles: "**/node_modules/steamworks.js/dist/osx/**" } } : {}),
        // Steam の部品などのネイティブのライブラリは asar の外に出す（中からは読めない）
        asar: useAsar ? { unpack: "**/*.{node,dylib,dll,so}" } : false,
        prune: false,
        overwrite: true,
        quiet: true,
        ...(icon ? { icon } : {}),
      });
      const appPath = join(appParent!, `${fileName}.app`);
      console.log("  素材をコピー");
      await addAssets(join(appPath, "Contents/Resources"));
      // Electron の既定の Info.plist に残る、使わない利用許可の文言を外す
      const plist = join(appPath, "Contents/Info.plist");
      for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription", "NSAudioCaptureUsageDescription"]) {
        spawnSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
      }
      trimLocales("darwin", appPath);
      await lockFuses("darwin", appPath, join(appPath, "Contents/Resources"));
      if (macSign) {
        // 配布用の署名（build.mac.signIdentity）。内側から順に hardened runtime と entitlements を付ける
        console.log(`  署名（${macSign.identity}、hardened runtime）`);
        await signMacApp(appPath, macSign, join(work, "mac-sign"), { thirdPartyLibraries: !!steam || !!b.store?.desktop?.module }).catch((e: unknown) => fail(`Mac 版に署名できませんでした\n${signError(e)}`));
      } else {
        // 最低限の署名（Apple Silicon で起動するのに必要）。配布用の Developer ID 署名・公証ではない
        console.log("  アドホック署名");
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
        execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);
      }
      const final = join(dest, `${fileName}.app`);
      movePath(appPath, final);
      writeFileSync(join(appParent!, THIRD_PARTY_LICENSES_FILE), licensesText);
      for (const f of DESKTOP_LICENSE_FILES) if (existsSync(join(appParent!, f))) movePath(join(appParent!, f), join(dest, f));
      if (macSign?.notary) {
        try {
          notarizeMacApp(final, macSign.notary, join(work, "mac-notarize"));
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      }
      console.log(`  ${relative(project.root, final)}（${sizeOf(final)}）`);
      // 配る形（公証したなら staple の後）。起動して確かめる前の、書き出したままのアプリを包む
      const made = [final];
      // zip と dmg には、.app の隣に置いたライセンスの文書も入れる（Windows と Linux はアプリのフォルダの中にあるので、そのまま入る）
      const licenses = DESKTOP_LICENSE_FILES.map((f) => join(dest, f));
      if (macZip) made.push(macAppZip(final, join(dest, `${fileSafeName}.zip`), licenses));
      if (macDmg) made.push(macAppDmg(final, join(dest, `${fileSafeName}.dmg`), fileName, join(work, "dmg"), licenses));
      for (const f of made.slice(1)) console.log(`  ${relative(project.root, f)}（${sizeOf(f)}）`);
      if (o.verify && process.platform === "darwin") verifyDesktop(join(final, "Contents/MacOS", fileName), join(dest, "verify-title.png"));
      return made;
    }

    async function buildWindows(): Promise<string[]> {
      const arch = arches.windows;
      step(`Windows 版（${arch}）`);
      const ico = windowsIcon(work, project.root, b.winIcon, b.icon);
      const dest = join(out, "windows", `${fileSafeName}_${stamp()}`);
      mkdirSync(dest, { recursive: true });
      const [appDir] = await packager({
        dir: await stageElectronApp("win32"),
        out: join(work, "windows"),
        name: fileName,
        // Packager は実行ファイル名を NFD に変える。Windows では元の名前と別物になるため、
        // 一旦 ASCII 名で作り、組み立て後に指定された名前へ変える。
        executableName: "LiminaliaGame",
        platform: "win32",
        arch,
        electronVersion: electronVersion(),
        appVersion: fileVersion(version),
        appCopyright: cfg.author ?? appName,
        win32metadata: { ProductName: appName, FileDescription: appName, InternalName: cfg.id },
        // Steam の部品などのネイティブのライブラリは asar の外に出す（中からは読めない）
        asar: useAsar ? { unpack: "**/*.{node,dylib,dll,so}" } : false,
        prune: false,
        overwrite: true,
        quiet: true,
        ...(ico && existsSync(ico) ? { icon: ico } : {}),
      });
      if (fileName !== "LiminaliaGame") renameSync(join(appDir!, "LiminaliaGame.exe"), join(appDir!, `${fileName}.exe`));
      console.log("  素材をコピー");
      await addAssets(join(appDir!, "resources"));
      // Electron の LICENSE の隣に、ゲームの中身の外部の部品のライセンスの文書も置く
      writeFileSync(join(appDir!, THIRD_PARTY_LICENSES_FILE), licensesText);
      const folder = join(dest, fileSafeName);
      movePath(appDir!, folder);
      trimLocales("win32", folder);
      await lockFuses("win32", join(folder, `${fileName}.exe`), join(folder, "resources"));
      // ストアの道具で包む（build.windows.wrap）。署名はその後
      const wrap = wrapCommand(b.windows?.wrap);
      if (wrap) {
        console.log(`  実行ファイルを包む（${wrap[0]}）`);
        const [cmd, ...args] = wrap.map((a) => a.replaceAll("{file}", join(folder, `${fileName}.exe`)));
        try {
          execFileSync(cmd!, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
          fail(`実行ファイルを包めませんでした\n${signError(e)}`);
        }
      }
      signWin(join(folder, `${fileName}.exe`));
      const made = [folder];
      if (zip) {
        console.log("  zip に圧縮");
        const zipPath = join(dest, `${fileSafeName}.zip`);
        await zipFolder(dest, fileSafeName, zipPath);
        made.push(zipPath);
      }
      if (installer && makensis) {
        console.log("  インストーラーを作成（NSIS）");
        const setup = childPath(dest, `${fileSafeName}_${version}_Setup.exe`) ?? fail(`インストーラーの置き場が ${dest} の直下になりません（liminalia.json の version に / と \\ を書きません）`);
        try {
          buildInstaller(
            makensis,
            { title: appName, id: `${cfg.id}${o.variant ? `_${o.variant}` : ""}${feedback ? "_test" : ""}`, version, ...(cfg.author ? { publisher: cfg.author } : {}), folderName: fileSafeName, exeName: fileName, sourceDir: folder, outFile: setup, icon: ico && existsSync(ico) ? ico : null, config: installer },
            join(work, "installer.nsi"),
          );
        } catch (e) {
          fail(`インストーラーを作成できませんでした\n${signError(e)}`);
        }
        signWin(setup);
        made.push(setup);
        console.log(`  ${relative(project.root, setup)}（${sizeOf(setup)}）`);
      }
      console.log(`  ${relative(project.root, folder)}（${sizeOf(folder)}）`);
      if (o.verify) console.log("  確認: Windows 版の起動確認は Windows 機か Wine で行ってください");
      return made;
    }

    async function buildLinux(): Promise<string[]> {
      const arch = arches.linux;
      step(`Linux 版（${arch}）`);
      const dest = join(out, "linux", `${fileSafeName}_${stamp()}`);
      mkdirSync(dest, { recursive: true });
      const png = pngIcon(b.icon ? resolve(project.root, b.icon) : null, work);
      const [appDir] = await packager({
        dir: await stageElectronApp("linux"),
        out: join(work, "linux"),
        name: fileName,
        executableName: linuxExe,
        platform: "linux",
        arch,
        electronVersion: electronVersion(),
        appVersion: version,
        appCopyright: cfg.author ?? appName,
        asar: useAsar ? { unpack: "**/*.{node,dylib,dll,so}" } : false,
        prune: false,
        overwrite: true,
        quiet: true,
        ...(png ? { icon: png } : {}),
      });
      console.log("  素材をコピー");
      await addAssets(join(appDir!, "resources"));
      // Electron の LICENSE の隣に、ゲームの中身の外部の部品のライセンスの文書も置く
      writeFileSync(join(appDir!, THIRD_PARTY_LICENSES_FILE), licensesText);
      const folder = join(dest, fileSafeName);
      movePath(appDir!, folder);
      trimLocales("linux", folder);
      await lockFuses("linux", join(folder, linuxExe), join(folder, "resources"));
      // 起動用の sh（sandbox が使えない環境では --no-sandbox を付ける）と、メニューに入れる .desktop とその絵
      const launcher = linuxLauncherName(linuxExe);
      const desktopFile = `${cfg.id}.desktop`;
      if (png) copyFileSync(png, join(folder, "icon.png"));
      writeFileSync(join(folder, launcher), linuxLauncher({ exe: linuxExe, desktop: desktopFile, icon: png ? "icon.png" : null }), { mode: 0o755 });
      writeFileSync(join(folder, desktopFile), linuxDesktopEntry({ title: appName, launcher, ...(cfg.description ? { comment: cfg.description } : {}) }), { mode: 0o755 });
      const made = [folder];
      if (zip) {
        // 実行の許可を保つため tar.gz にする（zip では Linux の実行の許可が落ちることがある）。持ち主は root（0）にする
        console.log("  tar.gz に圧縮");
        const archive = join(dest, `${fileSafeName}.tar.gz`);
        const executables = new Set([linuxExe, "chrome-sandbox", "chrome_crashpad_handler", launcher, desktopFile].map((f) => `${fileSafeName}/${f}`));
        await tarGz(dest, fileSafeName, archive, { executable: (p) => executables.has(p) || /\.(so(\.\d+)*|node)$/.test(p) });
        made.push(archive);
      }
      console.log(`  ${relative(project.root, folder)}（${sizeOf(folder)}。起動は ${launcher}、実行ファイルは ${linuxExe}）`);
      if (o.verify) console.log("  確認: Linux 版の起動確認は Linux 機で行ってください");
      return made;
    }
  } finally {
    cleanup();
  }
}

/**
 * ファイルかフォルダを動かす（mv の代わり。Windows には mv が無い）。作業の場所（一時のフォルダ）と書き出し先が別のドライブなら
 * （EXDEV。Windows では C: と D: など）、または Windows でほかのプロセスが掴んでいて名前を変えられなければ（EPERM）、写してから消す。
 * Mac のアプリの中のシンボリックリンクは、リンクのまま写す。
 */
export function movePath(from: string, to: string, rename: (from: string, to: string) => void = renameSync): void {
  try {
    rename(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** 言語の名前（"zh-Hans"、"pt_BR.lproj"、"en-US.pak"、"ja_FEMININE.lproj"）の頭の言語（"zh"、"pt"、"en"、"ja"）。 */
const primaryLanguage = (name: string): string => name.replace(/\.(lproj|pak)$/i, "").split(/[-_]/)[0]!.toLowerCase();

/**
 * Electron の言語のファイル（Windows と Linux の locales/*.pak、Mac の *.lproj）のうち、languages（作品の言語）と英語のどれとも
 * 頭の言語が合わないものを消す（zh なら zh-CN と zh-TW の両方を残す。Mac の Base.lproj は残す）。消した数を返す。
 * Chromium は OS の言語のファイルが無ければ en-US を使うので、英語は必ず残す。
 */
export function removeElectronLocales(dirs: string[], languages: string[]): number {
  const keep = new Set(["en", ...languages.map(primaryLanguage)]);
  let removed = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/\.(lproj|pak)$/i.test(name) || name === "Base.lproj" || keep.has(primaryLanguage(name))) continue;
      // Mac のアプリの Resources の .pak（chrome_100_percent.pak など）は言語のファイルではない
      if (name.endsWith(".pak") && !dir.endsWith("locales")) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * スマホ版のストアの版の番号（Android の versionCode、iOS の CFBundleVersion）。given（LIMINALIA_BUILD_NUMBER か build.buildNumber）が
 * 1 以上の整数ならそれ。書いていなければ version から作る（1.2.3 → 10203）。この作り方では、版の二つ目か三つ目が 100 以上だと
 * ほかの版と重なる（1.0.100 と 1.1.0 がどちらも 10100）ので、そのときは番号を書くよう理由を返す。
 */
export function storeBuildNumber(version: string, given: string | number | undefined): number | { problem: string } {
  if (given !== undefined && String(given).trim() !== "") {
    const n = Number(given);
    if (Number.isInteger(n) && n > 0 && n <= 2100000000) return n;
    return { problem: `ストアのビルド番号（LIMINALIA_BUILD_NUMBER か build.buildNumber）は 1 から 2100000000 の整数で書きます: ${given}` };
  }
  const [major = 1, minor = 0, patch = 0] = version.split(".").map((x) => Number.parseInt(x, 10) || 0);
  if (minor >= 100 || patch >= 100 || major >= 210000) return { problem: `version ${version} からはストアのビルド番号を作れません（二つ目と三つ目が 100 以上だと、ほかのバージョンと同じ番号になります。1.0.100 と 1.1.0 がどちらも 10100）。build.buildNumber か環境変数 LIMINALIA_BUILD_NUMBER に、前に上げたものより大きい番号を書いてください` };
  return Math.max(1, major * 10000 + minor * 100 + patch);
}

/**
 * デスクトップ版のアイコン（build.icon、Windows は build.winIcon も）の問題。無い、見つからない、ひな形の仮のアイコン（templates/default/icon.png）
 * のまま、なら理由を返す。問題が無ければ null。
 */
export function desktopIconProblem(root: string, icon: string | undefined, winIcon?: string): string | null {
  if (!icon) return winIcon ? "build.icon がありません。Mac 版は Electron のアイコンになります（1024px の PNG を build.icon に書いてください）" : "アイコン（build.icon）がありません。Mac 版は Electron のアイコン、Windows 版と Linux 版はアイコンなしで書き出します（1024px の PNG を build.icon に書いてください）";
  const file = resolve(root, icon);
  if (!existsSync(file)) return `アイコン ${icon} が見つかりません（build.icon）`;
  let placeholder: string | null = null;
  try {
    placeholder = join(templateDir("default"), "icon.png");
  } catch {
    // ひな形が無い（配ったエンジンの外）なら比べない
  }
  const hash = (f: string) => createHash("sha1").update(readFileSync(f)).digest("hex");
  if (placeholder && existsSync(placeholder) && hash(placeholder) === hash(file)) return `アイコン ${icon} がひな形の仮のアイコンのままです。配る前に作品のアイコンに差し替えてください`;
  return null;
}

/** デスクトップ版の書き出し先ごとの CPU の候補（先頭が既定）と、その先だけに効く環境変数。 */
const DESKTOP_ARCHES = {
  mac: { arches: ["universal", "arm64", "x64"], env: "LIMINALIA_MAC_ARCH" },
  windows: { arches: ["x64", "arm64", "ia32"], env: "LIMINALIA_WINDOWS_ARCH" },
  linux: { arches: ["x64", "arm64"], env: "LIMINALIA_LINUX_ARCH" },
} as const;

type DesktopArch<T extends keyof typeof DESKTOP_ARCHES> = (typeof DESKTOP_ARCHES)[T]["arches"][number];

/**
 * デスクトップ版の CPU。その先の環境変数（LIMINALIA_MAC_ARCH、LIMINALIA_WINDOWS_ARCH、LIMINALIA_LINUX_ARCH）、どの先にも効く LIMINALIA_ARCH、
 * liminalia.json の build.<先>.arch の順で決め、どれも値を確かめる（一度の書き出しで先ごとに違う CPU にするなら、先ごとの環境変数を使う）。
 * Mac の既定は universal（どの Mac でも動く一つのアプリ。遊ぶ人が CPU を知らなくてよく、macOS 26 まで Intel の Mac も使われる）で、
 * arm64 か x64 に絞ると半分ほどの大きさになる。Windows と Linux の既定は x64。LIMINALIA_ARCH の universal は、Windows と Linux では書かないのと同じ。
 */
export function desktopArch<T extends keyof typeof DESKTOP_ARCHES>(target: T, env: Readonly<Record<string, string | undefined>>, fromConfig: string | undefined): DesktopArch<T> {
  const spec = DESKTOP_ARCHES[target];
  const own = env[spec.env] || undefined;
  const shared = env.LIMINALIA_ARCH && !(target !== "mac" && env.LIMINALIA_ARCH === "universal") ? env.LIMINALIA_ARCH : undefined;
  const [arch, from] = own ? [own, spec.env] : shared ? [shared, "LIMINALIA_ARCH"] : fromConfig ? [fromConfig, `build.${target}.arch`] : [spec.arches[0], ""];
  if ((spec.arches as readonly string[]).includes(arch)) return arch as DesktopArch<T>;
  const hint = from === "LIMINALIA_ARCH" ? "。LIMINALIA_ARCH はどの書き出し先にも効くので、先ごとに決めるなら LIMINALIA_MAC_ARCH、LIMINALIA_WINDOWS_ARCH、LIMINALIA_LINUX_ARCH に書きます" : "";
  const list = spec.arches.join("、");
  // 書き出しの経過の英語の表（build-lines-en.ts）が先ごとの文で引くので、先の名前を文の頭に差し込まない
  if (target === "mac") return fail(`Mac 版の CPU（${from}）は ${list} のどれかです: ${arch}${hint}`);
  if (target === "windows") return fail(`Windows 版の CPU（${from}）は ${list} のどれかです: ${arch}${hint}`);
  return fail(`Linux 版の CPU（${from}）は ${list} のどれかです: ${arch}${hint}`);
}

/**
 * ブラウザ版の書き出し先のフォルダの名前（<書き出し先>/browser/ の中）。エディション（--variant）は -<名前>、テスト版（--feedback）は
 * -test を付けて、製品の書き出し（<id>）と分ける。
 */
export function browserBuildName(id: string, variant: string | undefined, feedback: boolean): string {
  return `${id}${variant ? `-${variant}` : ""}${feedback ? "-test" : ""}`;
}

/** ブラウザ版の書き出し先のフォルダ（<書き出し先>/browser の直下）。名前が直下に当たらなければ null（書き出しはそのフォルダを消して置き直すため）。 */
export function browserBuildDir(out: string, id: string, variant: string | undefined, feedback: boolean): string | null {
  return childPath(join(out, "browser"), browserBuildName(id, variant, feedback));
}

/**
 * 書き出す先ごとに、フォルダやファイルの名前になるもの（id・版・エディションの名前をつないだもの）。
 * 見るのは書き出す先の分だけ（ブラウザ版だけなら、題名から作る fileSafeName はどこの名前にもならない）。
 */
export function exportPathNames(o: { targets: readonly string[]; id: string; variant: string | undefined; feedback: boolean; fileSafeName: string; version: string; linuxExe: string }): string[] {
  return [
    ...(o.targets.includes("browser") ? [browserBuildName(o.id, o.variant, o.feedback)] : []),
    ...(o.targets.some((t) => t !== "browser") ? [o.fileSafeName] : []),
    ...(o.targets.includes("windows") ? [`${o.fileSafeName}_${o.version}_Setup.exe`] : []),
    ...(o.targets.includes("linux") ? [o.linuxExe, `${o.id}.desktop`] : []),
  ];
}

/** 書き出しでフォルダやファイルの名前になるもの（id・版・エディションの名前をつないだもの）のうち、一区切りの名前にならないもの。 */
export function unsafeExportNames(names: readonly string[]): string[] {
  return names.filter((n) => !plainName(n));
}

/** 書き出しの記録のファイル（書き出し先の直下。一行に一回の書き出しの JSON）。 */
export const BUILD_HISTORY = "build-history.jsonl";

/** 書き出しの記録の一行。 */
export interface BuildRecord {
  date: string;
  id: string;
  /** 作品の版（liminalia.json の version か環境変数 LIMINALIA_VERSION。無ければ 1.0.0 で書き出す）。 */
  version: string;
  /** 使ったエンジンの版（lim --version と同じ）。 */
  engine: string;
  targets: string[];
  variant?: string;
  /** テスト版（lim build --feedback。指摘の口を入れたもの）。 */
  feedback?: boolean;
  /** 書き出したもの（書き出し先からのパス。"/" 区切り）。 */
  outputs: string[];
}

/** 書き出しの記録を、書き出し先の build-history.jsonl に一行足す。ファイルのパスを返す。 */
export function recordBuild(out: string, r: Omit<BuildRecord, "date"> & { date?: string }): string {
  const file = join(out, BUILD_HISTORY);
  const record: BuildRecord = { date: r.date ?? new Date().toISOString(), id: r.id, version: r.version, engine: r.engine, targets: r.targets, ...(r.variant ? { variant: r.variant } : {}), ...(r.feedback ? { feedback: true } : {}), outputs: r.outputs.map((p) => (isAbsolute(p) ? relative(out, p) : p).split(sep).join("/")) };
  mkdirSync(out, { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/** 書き出したもの（フォルダの中のアプリや zip）の、日時付きのフォルダ（<out>/<先>/<名前>_<日時>）。 */
function stampedRoot(out: string, path: string): string {
  const [target, name] = relative(out, path).split(sep);
  return join(out, target!, name!);
}

/**
 * デスクトップ版と一緒に配る、Electron の部品のライセンスの文書。LICENSE は Electron の、LICENSES.chromium.html は
 * Chromium とその中の部品（FFmpeg、Node.js など）のもの。Windows と Linux はアプリのフォルダの中に、Mac は .app の隣にできる。
 * Mac の zip と dmg には .app と並べて入れる（サイトの /license/third-party/ の「書き出したゲームに入るもの」と合わせる）。
 */
export const ELECTRON_LICENSE_FILES = ["LICENSE", "LICENSES.chromium.html"] as const;

/**
 * 書き出したゲームに入る外部の部品のライセンスの文書（今は Vite が書き出しに加える読み込みの処理だけ）。どの書き出し先でも
 * ゲームの中身（web）に入れ、ブラウザ版はフォルダの一番上に、デスクトップ版は Electron の LICENSE の隣にも置く
 * （サイトの /license/third-party/ の「書き出したゲームに入るもの」と合わせる）。
 */
export const THIRD_PARTY_LICENSES_FILE = "THIRD_PARTY_LICENSES.txt";

/** デスクトップ版と一緒に配るライセンスの文書（Electron のものと、ゲームの中身の外部の部品のもの）。 */
export const DESKTOP_LICENSE_FILES = [...ELECTRON_LICENSE_FILES, THIRD_PARTY_LICENSES_FILE] as const;

/** THIRD_PARTY_LICENSES.txt の中身。viteVersion は書き出しに使った Vite の版。 */
export function thirdPartyLicensesText(viteVersion: string): string {
  return `このゲームには、次のオープンソースの部品が入っています。
This game includes the following open source software.

--------------------------------------------------------------------------------
Vite ${viteVersion} (the module preload helper added to the build)
https://vite.dev/
--------------------------------------------------------------------------------

MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

/**
 * Mac のアプリを zip にする（ditto。Finder の「圧縮」と同じ形で、フレームワークの中のシンボリックリンク・実行の許可・署名と
 * 拡張属性を保つ。zip コマンドや yazl ではリンクが実体になり、署名が壊れる）。
 * extras（ライセンスの文書など）を渡すと、zip の一番上に .app と並べて入れる（あるものだけ）。
 */
export function macAppZip(app: string, zipPath: string, extras: readonly string[] = []): string {
  rmSync(zipPath, { force: true });
  const files = extras.filter((f) => existsSync(f));
  if (files.length === 0) {
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zipPath]);
    return zipPath;
  }
  // .app と文書を一つのフォルダに並べ、そのフォルダの中身を zip にする
  const stage = `${zipPath}.parts`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    execFileSync("ditto", [app, join(stage, basename(app))]);
    for (const f of files) copyFileSync(f, join(stage, basename(f)));
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", stage, zipPath]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return zipPath;
}

/**
 * Mac のアプリを dmg にする（hdiutil。中はアプリと /Applications へのリンク「Applications」。開いてアプリをリンクへ引けば入る）。
 * extras（ライセンスの文書など）を渡すと、アプリと並べて入れる（あるものだけ）。
 */
export function macAppDmg(app: string, dmgPath: string, volume: string, work: string, extras: readonly string[] = []): string {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("ditto", [app, join(work, basename(app))]);
  for (const f of extras) if (existsSync(f)) copyFileSync(f, join(work, basename(f)));
  symlinkSync("/Applications", join(work, "Applications"));
  rmSync(dmgPath, { force: true });
  const r = spawnSync("hdiutil", ["create", "-volname", volume, "-srcfolder", work, "-fs", "HFS+", "-format", "UDZO", "-ov", dmgPath], { encoding: "utf8" });
  rmSync(work, { recursive: true, force: true });
  if (r.status !== 0) fail(`dmg を作れませんでした（hdiutil）\n${(r.stderr || r.stdout || "").trim()}`);
  return dmgPath;
}

/**
 * シナリオの命令・キャストの定義・おまけの一覧から参照される素材がすべてあるか（lim check と同じ集め方）。
 * placeholders（テスト版の書き出し）があれば、無い画像と音はそのフォルダに札と無音を作って書き出しの素材に足し（placeholder-assets.ts）、作ったものを返す。
 * ほかの種類（動画など）が無いときと、大文字と小文字だけが違う名前は、テスト版でも止める。
 */
export function checkAssetReferences(ctx: Context, o: { placeholders?: string } = {}): AssetFile[] {
  const { project } = ctx;
  const sources = assetSources(ctx);
  const { scripts } = sources;
  const where = (d: Diagnostic) => `${d.file}${scripts.has(d.file) ? ".lim" : ""}:${d.line}: ${d.message}`;
  const actual = assetNames(project.paths.assets);
  const exists = (folder: string, path: string) => existsSync(join(project.paths.assets, folder, path));
  // テスト版: 無い画像と音を、札と無音にして入れる
  let made: AssetFile[] = [];
  if (o.placeholders) {
    const lacking = [...referencedAssetKeys(sources)]
      .map((key) => ({ folder: key.slice(0, key.indexOf("/")), path: key.slice(key.indexOf("/") + 1) }))
      .filter((r) => {
        const found = actual(r.folder, r.path);
        return found === null || (found === undefined && !exists(r.folder, r.path));
      });
    made = writePlaceholders(lacking, o.placeholders, project.screen);
  }
  const placed = new Set(made.map((f) => f.rel));
  // 大文字と小文字だけが違う名前（asset-case-mismatch）も止める。Mac と Windows では existsSync が通っても、Linux のサーバーやスマホでは読めない
  const problems = missingAssets({
    ...sources,
    exists: (folder, path) => placed.has(`${folder}/${path}`) || exists(folder, path),
    actual: (folder, path) => (placed.has(`${folder}/${path}`) ? path : actual(folder, path)),
  });
  const missing = problems.filter((d) => d.code !== "asset-case-mismatch").map(where);
  const cased = problems.filter((d) => d.code === "asset-case-mismatch").map(where);
  if (missing.length > 0) fail(`参照されているのに見つからない素材が ${missing.length} 件あります\n${[...missing, ...cased].slice(0, 30).join("\n")}`);
  if (cased.length > 0) fail(`ファイルの名前と大文字と小文字が違う素材が ${cased.length} 件あります（Linux のサーバーやスマホでは読めません）\n${cased.slice(0, 30).join("\n")}`);
  if (made.length > 0) {
    console.log(`  テスト版: 無い素材 ${made.length} 件を仮の素材（画像は名前を書いた札、音は無音）にして入れます`);
    for (const f of made.slice(0, 30)) console.log(`    ${f.rel}`);
    if (made.length > 30) console.log(`    ほか ${made.length - 30} 件`);
  } else console.log("  シナリオ、キャラクターの定義、おまけの一覧から参照される素材はすべて揃っています");
  // 参照しているのに、書き出しに入らない種類のファイル（素材の表に無い拡張子）。黙って落とさずに知らせる
  const unexported = unexportedAssets(sources);
  for (const d of unexported.slice(0, 30)) console.warn(`  警告: ${where(d)}`);
  if (unexported.length > 30) console.warn(`  警告: ほか ${unexported.length - 30} 件`);
  if (unexported.length > 0) console.warn(`  （${unexported[0]!.hint}。書き出したゲームでは読み込めません）`);
  return made;
}

const sourcesOf = new WeakMap<Context, AssetSources & { scripts: Map<string, Script> }>();

/** 素材を参照するもの（書き出す台本。下書きは書き出さないので除く。キャストの定義、liminalia.json）。同じ作品は一度だけ読む。 */
function assetSources(ctx: Context): AssetSources & { scripts: Map<string, Script> } {
  const known = sourcesOf.get(ctx);
  if (known) return known;
  const { project, registry } = ctx;
  const scripts = new Map<string, Script>();
  for (const { name, path } of listScenarioFiles(project.paths.scenario)) {
    const script = parse(readScenarioFile(path).text, name, { speakers: ctx.cast.speakers });
    // 下書きは書き出さないので、そこだけが使う素材は無くてよい
    if (!script.draft) scripts.set(name, script);
  }
  const sources = { scripts, registry, cast: ctx.cast.cast, castFile: "cast.json", extra: project.config.extra, items: project.config.items, ui: project.config.ui };
  sourcesOf.set(ctx, sources);
  return sources;
}

/**
 * 書き出しに入れる素材を、台本などが書いた形の名前にそろえる（alignAssetNames）。書き出しはパックも入れ、パック（packs/<フォルダ>/scenario）の台本も
 * 本体の素材を使うので、パックの台本（下書きを除く）が書いた形も数える（無い素材の検査はパックの素材を見ないので、assetSources には足さない）。
 */
export function alignBuildAssetNames(ctx: Context, files: readonly AssetFile[]): { files: AssetFile[]; renamed: AssetFile[] } {
  const sources = assetSources(ctx);
  const written = [...referencedAssetKeys(sources)];
  for (const pack of projectPackScripts(ctx.project)) {
    const scripts = new Map([...pack.scripts].filter(([, s]) => !s.script.draft).map(([name, s]) => [name, s.script] as const));
    written.push(...referencedAssetKeys({ ...sources, scripts }));
  }
  return alignAssetNames(files, written);
}

/**
 * 台本などが、ファイルの名前と濁点などの合成だけが違う形（NFC と NFD）で書いた素材は、書いた形の名前で写す（Mac では読めても、
 * Linux のサーバー、Windows、assets.asar の中では、合成の違う名前のファイルを引けない）。書いた形が二つ以上あるものは、ファイルの名前のまま。
 */
export function alignAssetNames(files: readonly AssetFile[], referenced: Iterable<string>): { files: AssetFile[]; renamed: AssetFile[] } {
  const written = new Map<string, Set<string>>();
  for (const key of referenced) {
    const nfc = key.normalize("NFC");
    written.set(nfc, (written.get(nfc) ?? new Set()).add(key));
  }
  const renamed: AssetFile[] = [];
  const out = files.map((f) => {
    const forms = written.get(f.rel.normalize("NFC"));
    if (!forms || forms.size !== 1 || forms.has(f.rel)) return f;
    const moved = { rel: [...forms][0]!, file: f.file };
    renamed.push(moved);
    return moved;
  });
  return { files: out, renamed };
}

/** 書き出しに入れる素材の一つ。rel は素材のフォルダからのパス（"bgimage/a.png"）、file は写す元のファイル。 */
export interface AssetFile {
  rel: string;
  file: string;
}

/**
 * 書き出しに入れる素材（画像・音・動画・字幕・書体・シェーダー）を選ぶ。写さずに一覧だけを返す（書き出し先ごとに元の場所から直接写す）。
 * forbid に当たるものがあれば止め、exclude に当たるものと素材の表に無い拡張子のものは入れない（skipped に理由ごとの数）。
 */
export function selectAssets(assetsDir: string, forbid: string[], exclude: string[]): { files: AssetFile[]; skipped: Map<string, number> } {
  const files: AssetFile[] = [];
  const skipped = new Map<string, number>();
  for (const kind of ASSET_KINDS) {
    const dir = join(assetsDir, kind);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = relative(assetsDir, file).split(sep).join("/");
      const hit = forbid.find((p) => rel.includes(p));
      if (hit) fail(`書き出しに含めてはいけない素材があります（build.forbid の "${hit}"）: ${rel}`);
      const ext = extname(file).toLowerCase();
      // 入れるのは素材の表（@liminalia/lang の MEDIA_EXTENSIONS。制作画面の素材の画面と同じ）にある拡張子のファイルだけ
      const reason = exclude.some((p) => rel.includes(p)) ? "build.exclude" : !mediaKindOf(file) ? ext || basename(file) : null;
      if (reason) {
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
        continue;
      }
      files.push({ rel, file });
    }
  }
  return { files, skipped };
}

/** フォルダの中のファイルを素材の一覧にする（縮めた素材・暗号にした素材のフォルダ）。 */
function folderFiles(dir: string): AssetFile[] {
  return existsSync(dir) ? walk(dir).map((file) => ({ rel: relative(dir, file).split(sep).join("/"), file })) : [];
}

/**
 * 素材ごとの中身の鍵（"fgimage/a.png" → sha1 の頭 10 桁）。遊ぶ側が素材の URL に付けるので、
 * 同じ名前のまま差し替えた画像や音も、公開先や遊ぶ人のブラウザに残った古いキャッシュで出ない（手で cacheKey を書かなくてよい）。
 */
function assetHashes(files: readonly AssetFile[]): Record<string, string> {
  const out: Record<string, string> = {};
  // 少しずつ読む（素材の全体が数 GB の作品でも、大きな動画を丸ごとメモリに持たない）
  for (const f of files) out[f.rel] = hashFile(f.file, "sha1").toString("hex").slice(0, 10);
  return out;
}

/** 書き出すゲームに入れる Electron の版（engine-paths.ts）。見つからなければ止める。 */
function electronVersion(): string {
  const version = engineElectronVersion();
  if (!version) throw new Error("書き出すゲームに入れる Electron のバージョンが分かりません（このリポジトリなら npm install を実行してください）");
  return version;
}

/**
 * Windows 版のアイコン（.ico）。build.winIcon があればそれ、無ければ build.icon（PNG。Mac 版と同じもの）から作る。
 * .ico は大きさごとの PNG をそのまま並べた形（Windows Vista 以降が読める）で、Wine も要らない。
 * Mac では sips で、ほかの OS では PNG を開いて 16〜256px にそろえる。
 */
export function windowsIcon(work: string, root: string, winIcon: string | undefined, icon: string | undefined): string | null {
  if (winIcon) {
    const ico = resolve(root, winIcon);
    if (existsSync(ico)) return ico;
    console.log(`  警告: アイコン ${winIcon} が見つかりません`);
  }
  const png = pngIcon(icon ? resolve(root, icon) : null, work);
  if (!png) return null;
  const images: Buffer[] = [];
  const widthOf = (data: Buffer) => data.readUInt32BE(16);
  if (process.platform === "darwin") {
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      const out = join(work, `win-icon-${size}.png`);
      execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), png, "--out", out], { stdio: "ignore" });
      images.push(readFileSync(out));
    }
  } else {
    // ほかの OS（CI の Linux など）では、PNG を開いて縮める（@liminalia/web の pwa-icons.ts）。開けない PNG は 256px 以下ならそのまま
    const data = readFileSync(png);
    const decoded = decodePng(data);
    if (decoded && decoded.width === decoded.height) {
      for (const size of [16, 24, 32, 48, 64, 128, 256]) images.push(encodePng(resizePixels(decoded, size, size)));
    } else if (widthOf(data) > 256) {
      console.log("  警告: アイコンが 256px より大きく、この OS では縮小できないため、Windows 版はアイコンなしで書き出します（build.winIcon に .ico を指定すると使われます）");
      return null;
    } else images.push(data);
  }
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const w = widthOf(img);
    const h = img.readUInt32BE(20);
    const at = 6 + i * 16;
    header.writeUInt8(w >= 256 ? 0 : w, at);
    header.writeUInt8(h >= 256 ? 0 : h, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(img.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += img.length;
  });
  const out = join(work, "icon.ico");
  writeFileSync(out, Buffer.concat([header, ...images]));
  return out;
}

/** PNG（中身が ICO でもよい）から .icns を作る。小さいと粗くなるので注意を出す。 */
function macIcon(work: string, root: string, icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const src = resolve(root, icon);
  if (!existsSync(src)) {
    console.log(`  警告: アイコン ${icon} が見つかりません`);
    return undefined;
  }
  if (src.endsWith(".icns")) return src;
  if (process.platform !== "darwin") return undefined;
  const base = join(work, "icon-base.png");
  execFileSync("sips", ["-s", "format", "png", src, "--out", base], { stdio: "ignore" });
  const width = Number(/pixelWidth: (\d+)/.exec(execFileSync("sips", ["-g", "pixelWidth", base], { encoding: "utf8" }))?.[1] ?? 0);
  if (width < 512) console.log(`  警告: アイコン ${basename(src)} が ${width}px しかないため、Mac では粗く表示されます（512px 以上を推奨）`);
  const set = join(work, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [size, name] of [[s, `icon_${s}x${s}.png`], [s * 2, `icon_${s}x${s}@2x.png`]] as const) {
      execFileSync("sips", ["-z", String(size), String(size), base, "--out", join(set, name)], { stdio: "ignore" });
    }
  }
  const icns = join(work, "icon.icns");
  execFileSync("iconutil", ["-c", "icns", set, "-o", icns]);
  return icns;
}

/** 書き出しに入れてはいけない、開発用の道具のフォルダ（名前 → フォルダの実際のパス）。 */
export function devToolDirs(): Record<string, string> {
  const pkg = (name: string) => {
    // 入口のファイルから package.json のあるところまで上る（ks-import は exports に package.json を出していない）
    let dir = dirname(realpathSync(createRequire(import.meta.url).resolve(name)));
    while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
    return dir;
  };
  return {
    "TyranoScript のインポート（@liminalia/ks-import）": pkg("@liminalia/ks-import"),
    "立ち絵の位置調整画面（packages/web/src/caster）": realpathSync(join(WEB_ROOT, "src/caster")),
    "Studio（@liminalia/studio）": pkg("@liminalia/studio/package.json"),
  };
}

/** 開発サーバーだけで出すページ（packages/web の直下）。書き出しに入っていたら止める。 */
const DEV_PAGES = ["caster.html", "studio.html"];

/**
 * 組み立てたエンジンに開発用の道具のモジュールが入っていたら止める。どこから読まれたかも出す
 * （多いのは、プラグインの "./commands" が取り込みの部品を import している場合。取り込みの部品は "./import" へ移す）。
 */
function devToolsGuard(): Plugin {
  const dirs = Object.entries(devToolDirs());
  return {
    name: "liminalia-dev-tools-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const toolOf = (id: string) => dirs.find(([, dir]) => id.startsWith(dir + sep))?.[0];
      const included = Object.values(bundle).flatMap((chunk) => (chunk.type === "chunk" ? Object.keys(chunk.modules).filter((id) => toolOf(id)) : []));
      if (included.length === 0) return;
      // 道具の外から読んでいるところを出す（道具の中どうしの import と、中身の無い入口の再 export は辿って外へ出る）
      const hits = new Set<string>();
      for (const id of this.getModuleIds()) {
        const tool = toolOf(id);
        if (!tool) continue;
        for (const importer of this.getModuleInfo(id)?.importers ?? []) if (!toolOf(importer)) hits.add(`- ${tool}: ${importer} が ${id} を読んでいます`);
      }
      if (hits.size === 0) for (const id of included) hits.add(`- ${toolOf(id)}: ${id}`);
      fail(`書き出すエンジンに開発用ツールのコードが含まれています\n${[...hits].join("\n")}`);
    },
  };
}

/**
 * 書き出したフォルダを静的サーバーで開き、開始の演出からタイトル画面（なければゲーム）まで進み、「はじめから」で最初のページ
 * （か選択肢、終わり）まで進むことを確かめる。entry の台本が書き出しに入っていないゲームは、タイトル画面までは動いても「はじめから」で止まる。
 */
async function verifyBrowser(dir: string, shot: string, wait = 2500): Promise<void> {
  // 確かめるときだけ読む（制作アプリの中の書き出しは確かめず、playwright-core を同梱しない）
  const { chromium } = await import("playwright-core");
  let browser: import("playwright-core").Browser | undefined;
  const { server, url } = await serveFolder(dir);
  try {
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    await page.goto(url);
    await page.waitForFunction(() => !!window.__liminalia, null, { timeout: 30_000 });
    await page.evaluate(() => void window.__liminalia!.system.boot());
    await page.waitForFunction(() => ["title", "game"].includes(window.__liminalia!.screen().mode), null, { timeout: 90_000 });
    // 作品が撮影を止めていれば（host.holdShot）離すまで待ち、それから build.verifyWait だけ待って撮る
    await page.waitForFunction(() => window.__liminalia!.shotReady?.() !== false, null, { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(wait);
    await page.screenshot({ path: shot });
    if (errors.length > 0) fail(`ブラウザ版でエラーが出ました\n${errors.join("\n")}`);
    console.log(`  確認: タイトル画面まで進みました（${shot}）`);
    // 「はじめから」を始め、最初のページか選択肢かゲームの終わりまで待つ（遊ぶ人の操作を待つ画面は自動確認の進め方で進む）
    const begun = (await page.evaluate(BEGIN_SOURCE)) === true;
    // エラーが出たらすぐやめる（entry の台本が無ければ 404 で止まる）。文字の式は渡さない（書き出したゲームの CSP が文字の評価を止める）
    const firstPage = () => {
      const l = window.__liminalia!;
      return l.ended || l.pages() >= 1 || l.system.status?.choosing === true;
    };
    const deadline = Date.now() + 60_000;
    let reached = false;
    while (begun && !reached && errors.length === 0 && Date.now() < deadline) {
      reached = await page.evaluate(firstPage);
      if (!reached) await page.waitForTimeout(200);
    }
    // 読み込みの失敗はページの外の知らせが少し遅れて届く
    if (!reached) await page.waitForTimeout(500);
    if (errors.length > 0) fail(`ブラウザ版の「はじめから」でエラーが出ました\n${errors.join("\n")}`);
    if (reached) console.log("  確認: 「はじめから」の最初のページまで進みました");
    else console.log("  警告: 「はじめから」の最初のページまで進めませんでした（60 秒待っても本文も選択肢も出ませんでした。lim playtest で確かめます）");
  } finally {
    server.close();
    await browser?.close();
  }
}

/** 書き出したアプリを起動し、タイトル画面が出たら撮って終了させる（desktop/main.cjs の LIMINALIA_SMOKE）。 */
function verifyDesktop(executable: string, shot: string): void {
  console.log("  確認: 起動してタイトル画面が表示されるまで待機");
  const r = spawnSync(executable, [], { env: { ...process.env, LIMINALIA_SMOKE: shot }, encoding: "utf8", timeout: 150_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 || !output.includes("LIMINALIA_SMOKE ok")) fail(`書き出したアプリが正しく起動しません\n${output.split("\n").slice(-20).join("\n")}`);
  if (output.split("\n").some((l) => l.startsWith("error:"))) fail(`書き出したアプリでエラーが出ました\n${output}`);
  console.log(`  確認: タイトル画面まで起動しました（${shot}）`);
}
