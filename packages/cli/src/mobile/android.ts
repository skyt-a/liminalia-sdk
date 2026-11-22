import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { MEDIA_TYPES } from "@liminalia/lang";
import { updateModule } from "../update.ts";
import { playGamesBridgeJava, playGamesValuesXml, type PlayGamesConfig } from "./achievements.ts";
import { androidIcons, readIcon } from "./icon.ts";

/** 素材の中身の種類（書き出しと同じ表。@liminalia/lang の MEDIA_TYPES）を、Java の TYPES.put の行にする。 */
function mediaTypes(): string {
  return Object.entries(MEDIA_TYPES)
    .map(([ext, type]) => `    TYPES.put(${JSON.stringify(ext.slice(1))}, ${JSON.stringify(type.split(";")[0]!)});`)
    .join("\n");
}

/**
 * Android 版の書き出し。Gradle も外部のライブラリも使わず、Android SDK の道具（aapt2・d8・zipalign・apksigner）と
 * JDK の javac だけで、WebView 一枚のアプリ（APK）を作る。
 *
 * - 書き出した Web 版を APK の assets/web/ に入れ、https://appassets.androidplatform.net/ から読む（モジュールと fetch が普通に動く）
 * - 全画面（システムのバーを隠す。画面の切り欠きの分は空ける）・作品の向きで固定（appCategory="game" なので、Android 16 の大きな画面でも固定が効く）・
 *   裏へ回ったら音を止める。端末の文字の大きさ・表示の大きさ・言語を変えても作り直さない（ゲームはタイトルへ戻らない）
 * - 起動したとき、端末の Android System WebView が古ければ（MIN_ANDROID_WEBVIEW より前）、Google Play で更新するよう知らせる
 * - 描画のプロセスが落ちたら、WebView を作り直して読み直し、裏へ回したときのオートセーブから続ける
 * - 戻る（ボタンとなぞり）はゲームに渡す（window.__liminalia.back()。API 33 からは OnBackInvokedCallback。Android 16 の予測型の戻るでも閉じない）
 * - スクリーンショットとセーブデータのエクスポートは、ページから中身を受け取り（LiminaliaFiles）、共有のシートで渡す
 *   （中身はアプリのキャッシュに置き、アプリの ContentProvider（SharedFiles）から読ませる）。<a download> の data: と blob: も受ける
 * - セーブデータのインポートの <input type="file"> に、端末のファイルを選ぶ画面を出す
 * - セーブはアプリのファイルの saves/ に、鍵ごとに一つのファイルで書く（LiminaliaSaves・SaveFiles。端末のバックアップにはこれだけを入れる。localStorage は WebView が後で書くので、
 *   裏へ回った直後に落とされると消えることがある。SharedPreferences は書くたびに全部のスロットの縮小画像まで書き直すので重い）。
 *   前の版が SharedPreferences に書いたものは、はじめて起動したときに移す。裏へ回ったら（onPause）オートセーブを頼み、onStop で書き終わりを待つ（最大 1.5 秒）
 * - 署名は build.android の keystore があればそれで、無ければ開発用の鍵（~/.liminalia/debug.keystore）で署名する
 * - Google Play 向けの Android App Bundle（.aab）は、資源を proto の形でつなぎ直して bundletool で組み、jarsigner で同じ鍵で署名する
 */

export interface AndroidOptions {
  /** Web 版（index.html のあるフォルダ。素材も入れたもの）。 */
  web: string;
  /** 作業用のフォルダ。 */
  work: string;
  /** 書き出す APK のパス。 */
  out: string;
  appId: string;
  title: string;
  version: string;
  /** 1 以上の整数。 */
  versionCode: number;
  landscape: boolean;
  /** アイコン（PNG）。適応アイコン（前景と地の色）と、API 25 までの端末のアイコンを作る。 */
  icon: string | null;
  /** 適応アイコンの地の色（"#rrggbb"。build.iconBackground。省くとアイコンの縁の色、透明なら白）。 */
  iconBackground?: string;
  /** targetSdkVersion（既定は PLAY_TARGET_SDK）。組み立てにはこの版以上の SDK Platform が要る。 */
  targetSdk?: number;
  /** リリース用の署名（無ければ開発用の鍵）。パスワードは環境変数の名前で渡す。 */
  signing?: { keystore: string; alias: string; storePasswordEnv: string; keyPasswordEnv?: string };
  /**
   * アプリ内課金（Google Play Billing）。libraries は Play Billing Library の AAR と、その依存の AAR・JAR。
   * AAR の classes.jar と libs/ の JAR を組み込み、AndroidManifest.xml の権限と activity などを足す（資源 res/ は組み込まない）。
   */
  billing?: { libraries: string[] };
  /**
   * 実績（Google Play Games Services v2。achievements.ts）。libraries は play-services-games-v2 の AAR と、その依存の AAR・JAR。
   * 課金のライブラリと合わせて組み込み、AAR の資源（res/）もつなぐ。
   */
  playGames?: PlayGamesConfig;
  /**
   * Google Play に上げる Android App Bundle（.aab）も作る。out はその場所、bundletool は動かすコマンド（findBundletool）。
   * 署名は APK と同じ鍵で jarsigner で付ける（Play App Signing に登録する「アップロード鍵」）。
   */
  bundle?: { out: string; bundletool: string[] };
}

/**
 * bundletool（AAB を組み立てる Google の道具）を動かすコマンド。環境変数 LIMINALIA_BUNDLETOOL（.jar かコマンド）→ PATH の bundletool
 * （brew install bundletool）→ ~/.liminalia/tools/bundletool*.jar の順に探す。見つからなければ入れ方を投げる。
 */
export function findBundletool(env: Record<string, string | undefined> = process.env): string[] {
  const given = (env.LIMINALIA_BUNDLETOOL ?? "").trim();
  if (given) {
    if (!existsSync(given)) throw new Error(`LIMINALIA_BUNDLETOOL の ${given} がありません`);
    return given.toLowerCase().endsWith(".jar") ? ["java", "-jar", given] : [given];
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["bundletool.bat", "bundletool.cmd", "bundletool.exe"] : ["bundletool"]) if (dir && existsSync(join(dir, name))) return [join(dir, name)];
  }
  const tools = join(homedir(), ".liminalia", "tools");
  const jar = existsSync(tools) ? readdirSync(tools).filter((f) => /^bundletool.*\.jar$/.test(f)).sort().at(-1) : undefined;
  if (jar) return ["java", "-jar", join(tools, jar)];
  throw new Error("Android App Bundle（.aab）を作る bundletool が見つかりません（brew install bundletool か、https://github.com/google/bundletool/releases の bundletool-all-<版>.jar を ~/.liminalia/tools/ に置くか、環境変数 LIMINALIA_BUNDLETOOL にそのパスを指定してください）");
}

/**
 * Google Play が今求める targetSdk の下限（新しいアプリとアップデート。2026 年 8 月 31 日から Android 16 = API 36。
 * https://developer.android.com/google/play/requirements/target-sdk）。build.android.targetSdk の既定でもある。
 */
export const PLAY_TARGET_SDK = 36;
/**
 * ゲームが動く Android System WebView の版の下限（Chrome の版。エンジンの CSS がカスケードレイヤーを使うため 99 から。README の「遊べる環境」）。
 * 起動したときにこれより古ければ、更新するよう知らせる。
 */
export const MIN_ANDROID_WEBVIEW = 99;
/** 組み立てに使う android.jar の下限（戻るの OnBackInvokedCallback と android:enableOnBackInvokedCallback が API 33 から）。 */
export const MIN_COMPILE_SDK = 33;

/** Android の版の名前（API 33 から。それより前は API の番号だけ）。後ろに「の」を続ける形。 */
function androidName(api: number): string {
  return api >= 33 ? `Android ${api - 20}（API ${api}）` : `API ${api} `;
}

/** 入っている Android のプラットフォーム（API の番号 → フォルダ）。プレビュー（英字の名前）と android.jar の無いものは除く。 */
export function androidPlatforms(sdk: string): Map<number, string> {
  const out = new Map<number, string>();
  const root = join(sdk, "platforms");
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root)) {
    const m = /^android-(\d+)(?:\.\d+)?(?:-ext\d+)?$/.exec(d);
    if (!m || !existsSync(join(root, d, "android.jar"))) continue;
    const api = Number(m[1]);
    const prev = out.get(api);
    // 同じ API の小さな版（android-36 と android-36.1）は新しい方
    if (!prev || basename(prev).localeCompare(d, undefined, { numeric: true }) < 0) out.set(api, join(root, d));
  }
  return out;
}

/** targetSdk の SDK Platform が無いときの文（入れ方つき）。 */
export function missingPlatformMessage(api: number, installed: readonly number[]): string {
  const have = installed.length > 0 ? `入っているのは API ${[...installed].sort((a, b) => a - b).join("、")}` : "一つも入っていません";
  return `Android SDK に ${androidName(api)}の SDK Platform がありません（${have}）。Android Studio の SDK Manager で入れてください（コマンドなら sdkmanager "platforms;android-${api}"）`;
}

/**
 * 組み立てに使うプラットフォーム（compileSdk）。targetSdk と MIN_COMPILE_SDK のどちらも満たすもののうち、いちばん新しいもの。
 * 無ければ入れ方を投げる（手元の SDK の版で targetSdk を決めない。Google Play に出せない APK を黙って作らないため）。
 */
export function compilePlatform(sdk: string, targetSdk: number): { api: number; dir: string } {
  const all = androidPlatforms(sdk);
  const need = Math.max(targetSdk, MIN_COMPILE_SDK);
  const api = [...all.keys()].filter((n) => n >= need).sort((a, b) => b - a)[0];
  if (api === undefined) throw new Error(missingPlatformMessage(need, [...all.keys()]));
  return { api, dir: all.get(api)! };
}

/** Android SDK と JDK の場所（platform はいちばん新しいプラットフォーム）。見つからなければ理由を投げる。 */
export function findAndroidTools(): { sdk: string; platform: string; buildTools: string; java: string } {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk"), join(homedir(), "Android/Sdk"), process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android/Sdk") : undefined];
  const sdk = candidates.find((p): p is string => !!p && existsSync(join(p, "platforms")));
  if (!sdk) throw new Error("Android SDK が見つかりません（Android Studio をインストールするか、環境変数 ANDROID_HOME で場所を指定してください）");
  const platforms = androidPlatforms(sdk);
  const newest = [...platforms.keys()].sort((a, b) => b - a)[0];
  if (newest === undefined) throw new Error(`${sdk}/platforms に Android のプラットフォームがありません（Android Studio の SDK Manager でインストールしてください）`);
  const tools = existsSync(join(sdk, "build-tools")) ? readdirSync(join(sdk, "build-tools")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) : undefined;
  if (!tools) throw new Error(`${sdk}/build-tools がありません（Android Studio の SDK Manager でインストールしてください）`);
  const javaHomes = [process.env.JAVA_HOME, "/Applications/Android Studio.app/Contents/jbr/Contents/Home", "/Applications/Android Studio.app/Contents/jre/Contents/Home", process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs/Android Studio/jbr") : undefined, "C:/Program Files/Android/Android Studio/jbr"];
  const javaHome = javaHomes.find((p): p is string => !!p && existsSync(join(p, "bin", process.platform === "win32" ? "javac.exe" : "javac")));
  if (!javaHome) throw new Error("JDK が見つかりません（Android Studio をインストールするか、環境変数 JAVA_HOME で場所を指定してください）");
  return { sdk, platform: platforms.get(newest)!, buildTools: join(sdk, "build-tools", tools), java: javaHome };
}

export function buildAndroid(o: AndroidOptions): string {
  const tools = findAndroidTools();
  const env = { ...process.env, JAVA_HOME: tools.java, PATH: `${join(tools.java, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const bt = (name: string) => join(tools.buildTools, process.platform === "win32" ? `${name}.bat` : name);
  // targetSdk は作品の設定（既定は Google Play の下限）。手元の SDK の版では決めない
  const targetSdk = o.targetSdk ?? PLAY_TARGET_SDK;
  const androidJar = join(compilePlatform(tools.sdk, targetSdk).dir, "android.jar");
  const pkg = o.appId;
  const dir = join(o.work, "android");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src", ...pkg.split(".")), { recursive: true });
  mkdirSync(join(dir, "res"), { recursive: true });

  // 1. 中身（アプリ内課金と実績があれば、ライブラリの JAR と資源と、そのマニフェストに書かれた権限と activity なども）
  const libraries = [...new Set([...(o.billing?.libraries ?? []), ...(o.playGames?.libraries ?? [])])];
  const library = libraries.length > 0 ? androidLibraries(libraries, join(dir, "libs")) : null;
  writeFileSync(join(dir, "AndroidManifest.xml"), manifest(o, pkg, library ? mergeLibraryManifests(library.manifests, pkg, { billing: !!o.billing }) : null, { playGames: !!o.playGames }));
  const src = (name: string) => join(dir, "src", ...pkg.split("."), name);
  const sources = [src("MainActivity.java"), src("SharedFiles.java"), src("AssetRanges.java"), src("SaveFiles.java")];
  writeFileSync(src("MainActivity.java"), mainActivity(pkg, !!o.billing, !!o.playGames));
  writeFileSync(src("SharedFiles.java"), sharedFilesJava(pkg));
  writeFileSync(src("AssetRanges.java"), assetRangesJava(pkg));
  writeFileSync(src("SaveFiles.java"), saveFilesJava(pkg));
  if (o.billing) {
    sources.push(src("StoreBridge.java"));
    writeFileSync(src("StoreBridge.java"), storeBridgeJava(pkg));
  }
  if (o.playGames) {
    sources.push(src("AchievementsBridge.java"));
    writeFileSync(src("AchievementsBridge.java"), playGamesBridgeJava(pkg, o.playGames.achievements));
    mkdirSync(join(dir, "res", "values"), { recursive: true });
    writeFileSync(join(dir, "res", "values", "games.xml"), playGamesValuesXml(o.playGames.appId));
  }
  if (o.icon) writeAndroidIcons(o.icon, join(dir, "res"), o.iconBackground);
  writeBackupRules(join(dir, "res"));
  const assets = join(dir, "assets");
  cpSync(o.web, join(assets, "web"), { recursive: true });

  // 2. 資源と assets を APK に（aapt2）。ライブラリの資源は重ねてつなぎ、ライブラリの R も作る（ライブラリの classes.jar が読む）
  const linkArgs = ["link", "-o", join(dir, "base.apk"), "-I", androidJar, "--manifest", join(dir, "AndroidManifest.xml"), "-A", assets, "--min-sdk-version", "24", "--target-sdk-version", String(targetSdk), "--version-code", String(o.versionCode), "--version-name", o.version];
  run(bt("aapt2"), ["compile", "--dir", join(dir, "res"), "-o", join(dir, "res.zip")]);
  linkArgs.push(join(dir, "res.zip"));
  const gen = join(dir, "gen");
  if (library && library.res.length > 0) {
    library.res.forEach((res, i) => {
      const zip = join(dir, "libs", `res-${i}.zip`);
      run(bt("aapt2"), ["compile", "--dir", res, "-o", zip]);
      linkArgs.push("-R", zip);
    });
    mkdirSync(gen, { recursive: true });
    linkArgs.push("--auto-add-overlay", "--java", gen, ...(library.packages.length > 0 ? ["--extra-packages", library.packages.join(":")] : []));
  }
  run(bt("aapt2"), linkArgs);
  if (existsSync(gen)) sources.push(...walk(gen).filter((f) => f.endsWith(".java")));

  // 3. Java を dex に（javac・d8）
  const classes = join(dir, "classes");
  mkdirSync(classes, { recursive: true });
  const jars = library?.jars ?? [];
  run(join(tools.java, "bin", "javac"), ["-source", "8", "-target", "8", "-bootclasspath", androidJar, ...(jars.length > 0 ? ["-classpath", jars.join(delimiter)] : []), "-nowarn", "-Xlint:-options", "-d", classes, ...sources]);
  const classFiles = walk(classes).filter((f) => f.endsWith(".class"));
  run(bt("d8"), ["--lib", androidJar, "--min-api", "24", "--output", dir, ...classFiles, ...jars]);

  const dexes = readdirSync(dir).filter((f) => /^classes\d*\.dex$/.test(f)).sort();
  // 署名の鍵（無ければ開発用の鍵を作る。AAB も同じ鍵で署名する）
  const sign = o.signing ? releaseSigning(o.signing) : debugSigning(tools.java, run);

  // 4.（頼まれたとき）Android App Bundle。資源を proto の形でもう一度つなぎ、bundletool の module の形（manifest/・dex/・res/・assets/・resources.pb）に並べ直す
  if (o.bundle) {
    const java = (name: string) => join(tools.java, "bin", process.platform === "win32" ? `${name}.exe` : name);
    run(bt("aapt2"), [...linkArgs.map((a) => (a === join(dir, "base.apk") ? join(dir, "proto.apk") : a)), "--proto-format"]);
    const module = join(dir, "module");
    rmSync(module, { recursive: true, force: true });
    updateModule.extractZip(join(dir, "proto.apk"), join(dir, "proto"));
    mkdirSync(join(module, "manifest"), { recursive: true });
    copyFileSync(join(dir, "proto", "AndroidManifest.xml"), join(module, "manifest", "AndroidManifest.xml"));
    for (const name of ["res", "assets", "resources.pb"]) if (existsSync(join(dir, "proto", name))) cpSync(join(dir, "proto", name), join(module, name), { recursive: true });
    mkdirSync(join(module, "dex"), { recursive: true });
    for (const dex of dexes) copyFileSync(join(dir, dex), join(module, "dex", dex));
    const moduleZip = join(dir, "base-module.zip");
    rmSync(moduleZip, { force: true });
    run(java("jar"), ["cMf", moduleZip, "-C", module, "."]);
    mkdirSync(dirname(o.bundle.out), { recursive: true });
    rmSync(o.bundle.out, { force: true });
    const [tool, ...toolArgs] = o.bundle.bundletool.map((a) => (a === "java" ? java("java") : a));
    run(tool!, [...toolArgs, "build-bundle", `--modules=${moduleZip}`, `--output=${o.bundle.out}`]);
    run(java("jarsigner"), [...jarSigning(o.signing), "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256", o.bundle.out, o.signing?.alias ?? "liminaliadebug"]);
    run(java("jarsigner"), ["-verify", o.bundle.out]);
    run(tool!, [...toolArgs, "validate", `--bundle=${o.bundle.out}`]);
  }

  // 5. APK: dex を足し、揃えて署名する（ライブラリが大きいと classes2.dex などに分かれる）
  for (const dex of dexes) zipAdd(join(dir, "base.apk"), dir, dex);
  const aligned = join(dir, "aligned.apk");
  run(bt("zipalign"), ["-p", "-f", "4", join(dir, "base.apk"), aligned]);
  mkdirSync(dirname(o.out), { recursive: true });
  run(bt("apksigner"), ["sign", ...sign, "--out", o.out, aligned]);
  run(bt("apksigner"), ["verify", o.out]);
  return o.out;
}

/**
 * アイコンの資源。適応アイコン（mipmap-anydpi-v26 の ic_launcher.xml。前景の画像と地の色）と、API 25 までの端末のアイコン（192px）。
 * 開けない PNG は、前と同じくそのまま mipmap/ に入れる。
 */
export function writeAndroidIcons(icon: string, res: string, background?: string): void {
  const img = readIcon(icon);
  if (!img) {
    console.warn(`  警告: アイコン ${icon} を開けないため、Android 版は適応アイコンにせずに入れます`);
    mkdirSync(join(res, "mipmap"), { recursive: true });
    copyFileSync(icon, join(res, "mipmap", "ic_launcher.png"));
    return;
  }
  const icons = androidIcons(img, background);
  mkdirSync(join(res, "mipmap-xxxhdpi"), { recursive: true });
  writeFileSync(join(res, "mipmap-xxxhdpi", "ic_launcher.png"), icons.legacy);
  writeFileSync(join(res, "mipmap-xxxhdpi", "ic_launcher_foreground.png"), icons.foreground);
  mkdirSync(join(res, "mipmap-anydpi-v26"), { recursive: true });
  writeFileSync(
    join(res, "mipmap-anydpi-v26", "ic_launcher.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background" />
  <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`,
  );
  mkdirSync(join(res, "values"), { recursive: true });
  writeFileSync(join(res, "values", "ic_launcher.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${icons.background}</color>\n</resources>\n`);
}

/** 開発用の鍵（無ければ作る）。 */
function debugSigning(javaHome: string, run: (cmd: string, args: string[]) => Buffer): string[] {
  const ks = join(homedir(), ".liminalia", "debug.keystore");
  if (!existsSync(ks)) {
    mkdirSync(dirname(ks), { recursive: true });
    run(join(javaHome, "bin", "keytool"), ["-genkeypair", "-keystore", ks, "-storepass", "android", "-keypass", "android", "-alias", "liminaliadebug", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Liminalia Debug,O=Liminalia,C=JP"]);
  }
  return ["--ks", ks, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--ks-key-alias", "liminaliadebug"];
}

/** AAB に署名する jarsigner の引数（鍵は APK と同じ。無ければ開発用の鍵。パスワードは環境変数から渡す）。 */
function jarSigning(s: AndroidOptions["signing"]): string[] {
  if (!s) return ["-keystore", join(homedir(), ".liminalia", "debug.keystore"), "-storepass", "android", "-keypass", "android"];
  if (!process.env[s.storePasswordEnv]) throw new Error(`署名の鍵のパスワードを環境変数 ${s.storePasswordEnv} に設定してください`);
  return ["-keystore", s.keystore, "-storepass:env", s.storePasswordEnv, "-keypass:env", s.keyPasswordEnv ?? s.storePasswordEnv];
}

function releaseSigning(s: NonNullable<AndroidOptions["signing"]>): string[] {
  if (!process.env[s.storePasswordEnv]) throw new Error(`署名の鍵のパスワードを環境変数 ${s.storePasswordEnv} に設定してください`);
  return ["--ks", s.keystore, "--ks-key-alias", s.alias, "--ks-pass", `env:${s.storePasswordEnv}`, "--key-pass", `env:${s.keyPasswordEnv ?? s.storePasswordEnv}`];
}

/** zip に一つのファイルを足す（zip コマンド。Windows は PowerShell の Compress-Archive では揃えられないので jar を使う）。 */
function zipAdd(zip: string, cwd: string, file: string): void {
  if (process.platform === "win32") execFileSync("jar", ["uf", zip, file], { cwd });
  else execFileSync("zip", ["-q", "-0", zip, file], { cwd });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * アプリ内課金と実績のライブラリ（AAR と JAR）。AAR は classes.jar と libs/ の JAR を取り出し、AndroidManifest.xml を控える。
 * 資源（res/）のある AAR は、その資源のフォルダと、R を作るパッケージの名前（マニフェストの package）を返す。
 */
export function androidLibraries(libraries: string[], dir: string): { jars: string[]; manifests: string[]; res: string[]; packages: string[] } {
  const jars: string[] = [];
  const manifests: string[] = [];
  const res: string[] = [];
  const packages: string[] = [];
  libraries.forEach((lib, i) => {
    if (lib.toLowerCase().endsWith(".jar")) {
      jars.push(lib);
      return;
    }
    if (!lib.toLowerCase().endsWith(".aar")) throw new Error(`アプリ内課金と実績のライブラリは .aar か .jar です: ${lib}`);
    const out = join(dir, `${i}-${basename(lib, ".aar")}`);
    rmSync(out, { recursive: true, force: true });
    updateModule.extractZip(lib, out);
    if (existsSync(join(out, "classes.jar"))) jars.push(join(out, "classes.jar"));
    if (existsSync(join(out, "libs"))) for (const j of readdirSync(join(out, "libs")).filter((f) => f.endsWith(".jar"))) jars.push(join(out, "libs", j));
    const xml = existsSync(join(out, "AndroidManifest.xml")) ? readFileSync(join(out, "AndroidManifest.xml"), "utf8") : null;
    if (xml) manifests.push(xml);
    if (existsSync(join(out, "res")) && walk(join(out, "res")).length > 0) {
      res.push(join(out, "res"));
      const name = xml ? /<manifest\b[^>]*\bpackage="([^"]+)"/.exec(xml)?.[1] : undefined;
      if (name && !packages.includes(name)) packages.push(name);
    }
  });
  return { jars, manifests, res, packages };
}

/** 前の名前（アプリ内課金のライブラリ）。 */
export const billingLibraries = androidLibraries;

/**
 * ライブラリのマニフェストから、アプリのマニフェストに足すもの（application の外の uses-permission と queries、中の activity・service・receiver・provider・meta-data）。
 * ${applicationId} はアプリの ID に置き換える。同じものは一度だけ。billing（既定 true）なら課金の権限も足す。
 */
export function mergeLibraryManifests(manifests: string[], pkg: string, o: { billing?: boolean } = {}): { outside: string[]; inside: string[] } {
  const outside = new Set<string>(o.billing === false ? [] : ['<uses-permission android:name="com.android.vending.BILLING" />']);
  const inside = new Set<string>();
  const elements = (xml: string, names: string[]) => {
    const out: string[] = [];
    const re = new RegExp(`<(${names.join("|")})\\b[^>]*?(?:/>|>[\\s\\S]*?</\\1>)`, "g");
    for (const m of xml.matchAll(re)) out.push(m[0].replace(/\s+/g, " ").replace(/\$\{applicationId\}/g, pkg));
    return out;
  };
  for (const xml of manifests.map((m) => m.replace(/<!--[\s\S]*?-->/g, ""))) {
    const app = /<application\b[^>]*?(?:\/>|>([\s\S]*?)<\/application>)/.exec(xml);
    const head = app ? xml.slice(0, app.index) + xml.slice(app.index + app[0].length) : xml;
    for (const e of elements(head, ["uses-permission", "queries"])) outside.add(e);
    for (const e of elements(app?.[1] ?? "", ["activity", "service", "receiver", "provider", "meta-data"])) inside.add(e);
  }
  return { outside: [...outside], inside: [...inside] };
}

/**
 * 端末のバックアップ（Google のアカウントへのバックアップと、新しい端末への引き継ぎ）に入れるもの。セーブの置き場所（アプリのファイルの saves/）
 * だけにする。何も決めないと、WebView の控え（app_webview/）までバックアップに入り、上限（25 MB）を超えると何も残らない。
 * Android 11 までは fullBackupContent、Android 12 からは dataExtractionRules を読む。
 */
export const BACKUP_RULES = {
  "backup_rules.xml": `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <include domain="file" path="saves/" />
</full-backup-content>
`,
  "data_extraction_rules.xml": `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <include domain="file" path="saves/" />
  </cloud-backup>
  <device-transfer>
    <include domain="file" path="saves/" />
  </device-transfer>
</data-extraction-rules>
`,
} as const;

function writeBackupRules(res: string): void {
  mkdirSync(join(res, "xml"), { recursive: true });
  for (const [name, text] of Object.entries(BACKUP_RULES)) writeFileSync(join(res, "xml", name), text);
}

export function manifest(o: Pick<AndroidOptions, "title" | "icon" | "landscape">, pkg: string, merged: { outside: string[]; inside: string[] } | null = null, extra: { playGames?: boolean } = {}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}">
  <uses-permission android:name="android.permission.VIBRATE" />${merged ? merged.outside.filter((e) => !e.includes('"android.permission.VIBRATE"')).map((e) => `\n  ${e}`).join("") : ""}
  <application
      android:label="${xml(o.title)}"${o.icon ? `\n      android:icon="@mipmap/ic_launcher"` : ""}
      android:appCategory="game"
      android:enableOnBackInvokedCallback="true"
      android:hardwareAccelerated="true"
      android:allowBackup="true"
      android:fullBackupContent="@xml/backup_rules"
      android:dataExtractionRules="@xml/data_extraction_rules"
      android:theme="@android:style/Theme.Black.NoTitleBar.Fullscreen">
    <activity
        android:name=".MainActivity"
        android:exported="true"
        android:screenOrientation="${o.landscape ? "sensorLandscape" : "sensorPortrait"}"
        android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|keyboard|navigation|uiMode|smallestScreenSize|fontScale|density|locale|layoutDirection">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
    <provider
        android:name=".SharedFiles"
        android:authorities="${pkg}.files"
        android:exported="false"
        android:grantUriPermissions="true" />${
          extra.playGames
            ? `
    <meta-data android:name="com.google.android.gms.games.APP_ID" android:value="@string/game_services_project_id" />`
            : ""
        }${merged ? merged.inside.map((e) => `\n    ${e}`).join("") : ""}
  </application>
</manifest>
`;
}

export function mainActivity(pkg: string, store = false, achievements = false): string {
  return `package ${pkg};

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Liminalia の書き出し（lim build android）が作るアプリ。assets/web/ の Web 版を全画面の WebView で遊ぶ。 */
public class MainActivity extends Activity {
  private static final String HOST = "appassets.androidplatform.net";
  private static final Map<String, String> TYPES = new HashMap<>();
  static {
    TYPES.put("html", "text/html");
    TYPES.put("js", "text/javascript");
    TYPES.put("mjs", "text/javascript");
    TYPES.put("css", "text/css");
    TYPES.put("json", "application/json");
    TYPES.put("webmanifest", "application/manifest+json");
    TYPES.put("lim", "text/plain");
${mediaTypes()}
  }

  private WebView web;
  /** インポートで選ぶファイルを待っている <input type="file">。 */
  private ValueCallback<Uri[]> picking;
  private static final int PICK_FILE = 1;
  /** 裏へ回ったときのオートセーブが書き終わったら数え終わる（onStop で待つ）。 */
  private volatile CountDownLatch leaving;
  /** WebView を入れる枠（画面の切り欠きの分だけ内側に寄せる）。 */
  private FrameLayout root;
  /** 戻るを受ける口（API 33 から。それより前の端末では使わないので Object で持つ）。 */
  private Object backCallback;
  /** 描画のプロセスが落ちた時刻（続けて落ちるなら読み直すのをやめる）。 */
  private final java.util.ArrayList<Long> crashes = new java.util.ArrayList<>();
  /** セーブの置き場所（アプリのファイルの saves/）。 */
  private SaveFiles saves;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    // セーブは鍵ごとのファイルに置く。前の版が SharedPreferences に書いたものは、はじめて使うときに移す（SharedPreferences は消さない）
    saves = new SaveFiles(getFilesDir());
    if (!saves.exists()) saves.create(getSharedPreferences("liminalia-saves", MODE_PRIVATE).getAll());
    web = createWeb();
    root = new FrameLayout(this);
    root.setBackgroundColor(0xff000000);
    root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    // 画面の切り欠き（カメラの穴）の分は空ける（targetSdk 35 からは窓が切り欠きまで広がるため）
    if (Build.VERSION.SDK_INT >= 28) {
      root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
        @Override
        public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
          android.view.DisplayCutout c = insets.getDisplayCutout();
          if (c != null) v.setPadding(c.getSafeInsetLeft(), c.getSafeInsetTop(), c.getSafeInsetRight(), c.getSafeInsetBottom());
          else v.setPadding(0, 0, 0, 0);
          return insets;
        }
      });
    }
    setContentView(root);
    hideSystemBars();
    if (Build.VERSION.SDK_INT >= 33) registerBack();
    web.loadUrl("https://" + HOST + "/index.html");
    checkWebView();
  }

  /** ゲームが動く WebView の版の下限（Chrome の版）。 */
  private static final int MIN_WEBVIEW = ${MIN_ANDROID_WEBVIEW};

  /**
   * 端末の Android System WebView が古ければ（ゲームが動かないことがある）、Google Play で更新するよう知らせる。
   * 版は WebView の User-Agent の Chrome/<版> で見る（API 24 から使える）。
   */
  private void checkWebView() {
    int version;
    try {
      Matcher m = Pattern.compile("Chrome/(\\\\d+)").matcher(WebSettings.getDefaultUserAgent(this));
      if (!m.find()) return;
      version = Integer.parseInt(m.group(1));
    } catch (Exception e) {
      return;
    }
    if (version >= MIN_WEBVIEW) return;
    // 更新するアプリ（Android 7〜9 は Chrome が WebView を兼ねることがある）
    String provider = "com.google.android.webview";
    if (Build.VERSION.SDK_INT >= 26) {
      android.content.pm.PackageInfo p = WebView.getCurrentWebViewPackage();
      if (p != null) provider = p.packageName;
    }
    final String store = provider;
    boolean ja = "ja".equals(Locale.getDefault().getLanguage());
    new AlertDialog.Builder(this)
        .setTitle(ja ? "WebView を更新してください" : "Update Android System WebView")
        .setMessage(ja
            ? "この端末の Android System WebView（" + version + "）が古いため、ゲームが正しく動かないことがあります。Google Play で更新してください（" + MIN_WEBVIEW + " 以降で動きます）。"
            : "This device's Android System WebView (" + version + ") is too old, so the game may not work correctly. Update it on Google Play (version " + MIN_WEBVIEW + " or later is needed).")
        .setPositiveButton(ja ? "更新する" : "Update", new DialogInterface.OnClickListener() {
          @Override
          public void onClick(DialogInterface dialog, int which) {
            try {
              startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + store)));
            } catch (android.content.ActivityNotFoundException e) {
              openExternal("https://play.google.com/store/apps/details?id=" + store);
            }
          }
        })
        .setNegativeButton(ja ? "閉じる" : "Close", null)
        .show();
  }

  /**
   * 描画のプロセスが落ちた（裏にいる間にメモリを空けるため止められたなど）。黒い画面のまま残さず、WebView を作り直して読み直し、
   * 裏へ回したときのオートセーブから続ける（?resume=1。packages/web の resumeLeft）。1 分のうちに 3 回落ちたら、読み直すのをやめて閉じる。
   */
  private void restartWeb() {
    long now = System.currentTimeMillis();
    for (int i = crashes.size() - 1; i >= 0; i--) if (now - crashes.get(i) > 60_000) crashes.remove(i);
    crashes.add(now);
    WebView old = web;
    root.removeView(old);
    old.destroy();
    if (crashes.size() >= 3) {
      finish();
      return;
    }
    web = createWeb();
    root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    web.loadUrl("https://" + HOST + "/index.html?resume=1");
  }

  /** ゲームの WebView（素材を assets から返し、アプリの口を置く）。 */
  private WebView createWeb() {
    final WebView web = new WebView(this);
    web.setBackgroundColor(0xff000000);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    // 端末の文字の大きさの設定でゲームの文字が大きくならないように（大きさはゲームの設定で変える）
    s.setTextZoom(100);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase() : "";
        String type = TYPES.containsKey(ext) ? TYPES.get(ext) : "application/octet-stream";
        try {
          String name = "web" + path;
          InputStream in = getAssets().open(name);
          // 範囲の指定（Range）に答える（長い BGM を展開せずに流し読みするため。音と動画の飛ばし読みも）
          String range = null;
          Map<String, String> asked = request.getRequestHeaders();
          if (asked != null) for (Map.Entry<String, String> h : asked.entrySet()) if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
          if (range != null) {
            long size = assetLength(name, in);
            long[] span = AssetRanges.parse(range, size);
            if (span != null) {
              Map<String, String> headers = AssetRanges.headers(span, size);
              headers.put("Cache-Control", "no-cache");
              if (span.length == 0) {
                in.close();
                return new WebResourceResponse(type, null, 416, "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
              }
              return new WebResourceResponse(type, null, 206, "Partial Content", headers, AssetRanges.slice(in, span));
            }
          }
          WebResourceResponse r = new WebResourceResponse(type, type.startsWith("text/") || type.endsWith("json") ? "utf-8" : null, in);
          Map<String, String> headers = new HashMap<>();
          headers.put("Cache-Control", "no-cache");
          headers.put("Accept-Ranges", "bytes");
          r.setResponseHeaders(headers);
          return r;
        } catch (IOException e) {
          return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
        }
      }

      /** ゲームの外へ移ろうとしたら（作品の HTML の <a>、window.open）、ゲームの中では開かず端末のブラウザに渡す。 */
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (HOST.equals(url.getHost()) || !request.isForMainFrame()) return false;
        openExternal(url.toString());
        return true;
      }

      @Override
      public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        if (view == MainActivity.this.web) restartWeb();
        return true;
      }
    });
    // セーブ（SharedPreferences）、ファイルを渡す口、<a download>、インポートのファイルを選ぶ画面
    web.addJavascriptInterface(new SavesBridge(), "LiminaliaSaves");
    web.addJavascriptInterface(new FilesBridge(), "LiminaliaFiles");
    // アプリへの頼み（外のブラウザで開く・画面を消さない・振動・アプリを閉じる）
    web.addJavascriptInterface(new AppBridge(), "LiminaliaApp");
    web.setDownloadListener(new DownloadListener() {
      @Override
      public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
        download(url, contentDisposition, mimetype);
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (picking != null) picking.onReceiveValue(null);
        picking = callback;
        try {
          startActivityForResult(params.createIntent(), PICK_FILE);
        } catch (Exception e) {
          picking = null;
          return false;
        }
        return true;
      }
    });
${
    store
      ? `    // アプリ内課金（Google Play Billing）の口をゲームの画面に置く（window.LiminaliaStore）
    web.addJavascriptInterface(new StoreBridge(this, web), "LiminaliaStore");
`
      : ""
  }${
    achievements
      ? `    // 実績（Google Play Games Services v2）の口をゲームの画面に置く（window.LiminaliaAchievements）
    web.addJavascriptInterface(new AchievementsBridge(this), "LiminaliaAchievements");
`
      : ""
  }    return web;
  }

  /** 戻るを受ける（API 33 から。Android 16 では onBackPressed が呼ばれないため）。 */
  private void registerBack() {
    OnBackInvokedCallback callback = new OnBackInvokedCallback() {
      @Override
      public void onBackInvoked() {
        back();
      }
    };
    backCallback = callback;
    getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
  }

  /** 全画面（ステータスバーとナビゲーションバーを隠し、端からなぞったときだけ一時的に出す）。 */
  private void hideSystemBars() {
    if (Build.VERSION.SDK_INT >= 30) {
      WindowInsetsController c = getWindow().getInsetsController();
      if (c != null) {
        c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemBars();
  }

  /** 戻るボタン（API 32 まで。33 からは registerBack の口）。 */
  @Override
  public void onBackPressed() {
    back();
  }

  /**
   * 戻るはゲームに渡す（window.__liminalia.back()。入力の枠を取り消す・開いている画面を閉じる・メニュー・タイトルでは終わるかを尋ねる）。
   * ゲームが扱わなければ（読み込みの途中など）、ホームへ戻るのと同じく裏へ回る。
   */
  private void back() {
    web.evaluateJavascript("(function () { try { var g = window.__liminalia; return !!(g && g.back && g.back()); } catch (e) { return false; } })()", new ValueCallback<String>() {
      @Override
      public void onReceiveValue(String handled) {
        if (!"true".equals(handled)) moveTaskToBack(true);
      }
    });
  }

  /** 裏へ回ったらオートセーブして音を止め、戻ったら鳴らす。書き終わったら LiminaliaSaves.left() で知らせてもらう。 */
  @Override
  protected void onPause() {
    leaving = new CountDownLatch(1);
    web.evaluateJavascript("try { window.__liminalia && window.__liminalia.leave && window.__liminalia.leave(); window.__liminalia && window.__liminalia.host.audio.context.suspend() } finally { window.LiminaliaSaves && window.LiminaliaSaves.left() }", null);
    web.onPause();
    super.onPause();
  }

  /** 裏へ回ったあと、オートセーブを書き終わるまで待つ（ページの JS は別のスレッドで動き、書き込みは SharedPreferences へ同期で入る）。 */
  @Override
  protected void onStop() {
    CountDownLatch l = leaving;
    if (l != null) {
      try {
        l.await(1500, TimeUnit.MILLISECONDS);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
    }
    super.onStop();
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != PICK_FILE || picking == null) return;
    picking.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
    picking = null;
  }

  /** <a download> の data: はそのまま、blob: はページで読んで LiminaliaFiles へ渡してもらう。 */
  /** 素材の大きさ（バイト）。縮めずに入れたもの（音・画像・動画）は openFd で、縮めたものは開いた流れの残りで知る。 */
  private long assetLength(String name, InputStream in) {
    try {
      android.content.res.AssetFileDescriptor fd = getAssets().openFd(name);
      long n = fd.getLength();
      fd.close();
      if (n >= 0) return n;
    } catch (IOException e) {
      // 縮めて入れたもの
    }
    try {
      return in.available();
    } catch (IOException e) {
      return -1;
    }
  }

  private void download(String url, String contentDisposition, String mimetype) {
    String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
    if (url.startsWith("data:")) {
      int comma = url.indexOf(',');
      if (comma < 0) return;
      String head = url.substring(5, comma);
      String type = head.contains(";") ? head.substring(0, head.indexOf(';')) : head;
      byte[] bytes = head.endsWith(";base64") ? Base64.decode(url.substring(comma + 1), Base64.DEFAULT) : Uri.decode(url.substring(comma + 1)).getBytes();
      share(name, type.isEmpty() ? mimetype : type, bytes);
    } else if (url.startsWith("blob:")) {
      String js = "fetch(" + JSONObject.quote(url) + ").then(function (r) { return r.blob(); }).then(function (b) { var f = new FileReader(); f.onload = function () { var d = String(f.result); window.LiminaliaFiles.save(" + JSONObject.quote(name) + ", b.type || " + JSONObject.quote(mimetype == null ? "" : mimetype) + ", d.slice(d.indexOf(',') + 1)); }; f.readAsDataURL(b); })";
      web.evaluateJavascript(js, null);
    }
  }

  /** 中身をキャッシュの share/ に置き、共有のシートを開く。 */
  private boolean share(String name, String mime, byte[] bytes) {
    String safe = name.replaceAll("[\\\\/:*?\\"<>|]", "_");
    if (safe.isEmpty()) safe = "file";
    File dir = new File(getCacheDir(), "share");
    if (!dir.isDirectory() && !dir.mkdirs()) return false;
    File file = new File(dir, safe);
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(bytes);
    } catch (IOException e) {
      return false;
    }
    Uri uri = Uri.parse("content://" + getPackageName() + ".files/" + Uri.encode(safe));
    final Intent send = new Intent(Intent.ACTION_SEND);
    send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
    send.putExtra(Intent.EXTRA_STREAM, uri);
    send.putExtra(Intent.EXTRA_TITLE, safe);
    send.setClipData(ClipData.newRawUri(safe, uri));
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        startActivity(Intent.createChooser(send, null));
      }
    });
    return true;
  }

  /** 端末のブラウザ（ほかのアプリ）で開く。http・https・mailto だけ（ほかは開かない）。 */
  private void openExternal(String url) {
    Uri uri = Uri.parse(url);
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
    if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) return;
    final Intent view = new Intent(Intent.ACTION_VIEW, uri);
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        try {
          startActivity(view);
        } catch (android.content.ActivityNotFoundException e) {
          // 開けるアプリが無い
        }
      }
    });
  }

  /** ゲームの画面からの頼み（window.LiminaliaApp。packages/web の native.ts）。 */
  private class AppBridge {
    /** 外のブラウザで開く（@open-url）。 */
    @JavascriptInterface
    public void openUrl(String url) {
      openExternal(url);
    }

    /** 画面を消さない・戻す（オート中と動画の再生中）。 */
    @JavascriptInterface
    public void keepAwake(final boolean on) {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
          else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
      });
    }

    /** 振動（@vibrate）。振動と休みのミリ秒の並び（JSON の配列）。空なら止める。 */
    @JavascriptInterface
    public void vibrate(String pattern) {
      Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
      if (v == null || !v.hasVibrator()) return;
      long[] wave;
      try {
        JSONArray a = new JSONArray(pattern);
        // Android の並びは休みから始まる
        wave = new long[a.length() + 1];
        for (int i = 0; i < a.length(); i++) wave[i + 1] = Math.max(0, a.getLong(i));
      } catch (Exception e) {
        return;
      }
      if (wave.length <= 1) {
        v.cancel();
        return;
      }
      if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(wave, -1));
      else v.vibrate(wave, -1);
    }

    /** アプリを閉じる（@quit・タイトルとメニューの「終了」。オートセーブはページが書いてから呼ぶ）。 */
    @JavascriptInterface
    public void quit() {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          finishAndRemoveTask();
        }
      });
    }
  }

  /** ページから中身を受け取る口（window.LiminaliaFiles.save(名前, MIME, base64)。packages/web の system/download.ts）。 */
  private class FilesBridge {
    @JavascriptInterface
    public boolean save(String name, String mime, String base64) {
      try {
        return share(name, mime, Base64.decode(base64, Base64.DEFAULT));
      } catch (IllegalArgumentException e) {
        return false;
      }
    }
  }

  /**
   * セーブの置き場所（window.LiminaliaSaves。packages/web の system/storage.ts が localStorage の代わりに使う）。
   * アプリのファイルの saves/ に鍵ごとのファイルで書き切る（SaveFiles。呼ばれるのはページの JS のスレッドで、画面のスレッドを止めない）。
   * 書けなければ set が false を返し、ページは「セーブできませんでした」と知らせる。
   */
  private class SavesBridge {
    @JavascriptInterface
    public String load() {
      return saves.load();
    }

    @JavascriptInterface
    public boolean set(String key, String value) {
      return saves.set(key, value);
    }

    @JavascriptInterface
    public void remove(String key) {
      saves.remove(key);
    }

    /** 裏へ回ったときのオートセーブを書き終えた。 */
    @JavascriptInterface
    public void left() {
      CountDownLatch l = leaving;
      if (l != null) l.countDown();
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    web.onResume();
    web.evaluateJavascript("window.__liminalia && window.__liminalia.host.audio.context.resume()", null);
  }
}
`;
}

/**
 * 素材の範囲の指定（HTTP の Range）に答える部品。android.jar に頼らない Java だけで書く（テストが JDK で動かして確かめる）。
 * 答えるのは一つの範囲（bytes=a-b・bytes=a-・bytes=-n）だけ。いくつも並べた指定や読めない指定は、全体を返す（parse が null）。
 */
export function assetRangesJava(pkg: string): string {
  return `package ${pkg};

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 素材の範囲の指定（Range）に答える。 */
public final class AssetRanges {
  private static final Pattern RANGE = Pattern.compile("^bytes=(\\\\d*)-(\\\\d*)$");

  private AssetRanges() {}

  /**
   * 返す範囲 { 頭, 終わり }（終わりも含む）。答えない指定（読めない・いくつも並べた・大きさが分からない）は null、
   * 範囲が素材の外なら長さ 0 の配列（416 で答える）。
   */
  public static long[] parse(String header, long size) {
    if (header == null || size < 0) return null;
    Matcher m = RANGE.matcher(header.trim());
    if (!m.matches()) return null;
    String a = m.group(1);
    String b = m.group(2);
    if (a.isEmpty() && b.isEmpty()) return null;
    long start;
    long end;
    try {
      if (a.isEmpty()) {
        long n = Long.parseLong(b);
        if (n <= 0) return new long[0];
        start = Math.max(0, size - n);
        end = size - 1;
      } else {
        start = Long.parseLong(a);
        end = b.isEmpty() ? size - 1 : Math.min(Long.parseLong(b), size - 1);
      }
    } catch (NumberFormatException e) {
      return null;
    }
    if (start >= size || start > end) return new long[0];
    return new long[] { start, end };
  }

  /** 答えの見出し（206 なら Content-Range・Content-Length、416 なら Content-Range の * の形）。 */
  public static Map<String, String> headers(long[] span, long size) {
    Map<String, String> h = new HashMap<>();
    h.put("Accept-Ranges", "bytes");
    if (span.length == 0) {
      h.put("Content-Range", "bytes */" + size);
    } else {
      h.put("Content-Range", "bytes " + span[0] + "-" + span[1] + "/" + size);
      h.put("Content-Length", String.valueOf(span[1] - span[0] + 1));
    }
    return h;
  }

  /** 流れの、範囲の分だけ（頭を読み飛ばし、終わりで止める）。 */
  public static InputStream slice(InputStream in, long[] span) throws IOException {
    long skip = span[0];
    while (skip > 0) {
      long n = in.skip(skip);
      if (n <= 0) {
        if (in.read() < 0) break;
        n = 1;
      }
      skip -= n;
    }
    return new Limited(in, span[1] - span[0] + 1);
  }

  /** 決まった長さで終わる流れ。 */
  private static final class Limited extends FilterInputStream {
    private long left;

    Limited(InputStream in, long length) {
      super(in);
      left = length;
    }

    @Override
    public int read() throws IOException {
      if (left <= 0) return -1;
      int c = super.read();
      if (c >= 0) left--;
      return c;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      if (left <= 0) return -1;
      int n = super.read(b, off, (int) Math.min(len, left));
      if (n > 0) left -= n;
      return n;
    }

    @Override
    public long skip(long n) throws IOException {
      long done = super.skip(Math.min(n, left));
      left -= done;
      return done;
    }

    @Override
    public int available() throws IOException {
      return (int) Math.min(super.available(), left);
    }

    @Override
    public boolean markSupported() {
      return false;
    }
  }
}
`;
}

/**
 * セーブを鍵ごとに一つのファイルで置く部品（Android 版の LiminaliaSaves）。android.jar に頼らない Java だけで書く（テストが JDK で動かして確かめる）。
 * - 書くときは saves-tmp/ に書いて端末へ書き切ってから、saves/ の中へ名前を替えて移す（途中で落ちても前の中身が残る）
 * - ファイルの名前は鍵を URL の形に符号化したもの（":" なども使える）
 * - 前の版の置き場所の中身は、別のフォルダに書き揃えてから saves/ に名前を替える（途中で落ちたら置き場所を作らず、次にもう一度移す）
 */
export function saveFilesJava(pkg: string): string {
  return `package ${pkg};

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.Map;

/** セーブを鍵ごとに一つのファイルで置く（Liminalia の書き出しが作る）。 */
public final class SaveFiles {
  private final File dir;
  private final File tmp;

  public SaveFiles(File root) {
    dir = new File(root, "saves");
    tmp = new File(root, "saves-tmp");
  }

  /** 置き場所があるか（無ければ、前の版の置き場所から create で作る）。 */
  public synchronized boolean exists() {
    return dir.isDirectory();
  }

  /** 前の版の置き場所の中身（文字列の値だけ）で置き場所を作る。作れたか。 */
  public synchronized boolean create(Map<String, ?> entries) {
    File staging = new File(tmp, "staging");
    clear(staging);
    if (!staging.mkdirs()) return false;
    for (Map.Entry<String, ?> e : entries.entrySet()) {
      if (e.getValue() instanceof String && !write(staging, e.getKey(), (String) e.getValue())) return false;
    }
    return staging.renameTo(dir);
  }

  /** 全部（鍵 → 値の JSON）。 */
  public synchronized String load() {
    StringBuilder out = new StringBuilder("{");
    File[] files = dir.listFiles();
    if (files != null) {
      for (File f : files) {
        if (!f.isFile()) continue;
        String value;
        try {
          value = read(f);
        } catch (IOException e) {
          continue;
        }
        if (out.length() > 1) out.append(',');
        quote(out, key(f.getName()));
        out.append(':');
        quote(out, value);
      }
    }
    return out.append('}').toString();
  }

  /** 書く（書き切れたか）。 */
  public synchronized boolean set(String key, String value) {
    if (!dir.isDirectory() && !dir.mkdirs()) return false;
    if (!tmp.isDirectory() && !tmp.mkdirs()) return false;
    File target = new File(dir, name(key));
    File part = new File(tmp, name(key));
    if (!write(tmp, key, value)) return false;
    if (part.renameTo(target)) return true;
    // 名前を替えて上書きできない環境では、消してから替える
    target.delete();
    return part.renameTo(target);
  }

  public synchronized boolean remove(String key) {
    File f = new File(dir, name(key));
    return !f.exists() || f.delete();
  }

  private static boolean write(File in, String key, String value) {
    File f = new File(in, name(key));
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(value.getBytes("UTF-8"));
      out.getFD().sync();
      return true;
    } catch (IOException e) {
      f.delete();
      return false;
    }
  }

  private static String read(File f) throws IOException {
    try (InputStream in = new FileInputStream(f)) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[65536];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
      return new String(out.toByteArray(), "UTF-8");
    }
  }

  private static void clear(File f) {
    File[] children = f.listFiles();
    if (children != null) for (File c : children) clear(c);
    f.delete();
  }

  /** 鍵 → ファイルの名前（URL の形に符号化する）。 */
  static String name(String key) {
    try {
      return URLEncoder.encode(key, "UTF-8").replace("*", "%2A");
    } catch (UnsupportedEncodingException e) {
      throw new IllegalStateException(e);
    }
  }

  static String key(String name) {
    try {
      return URLDecoder.decode(name, "UTF-8");
    } catch (UnsupportedEncodingException e) {
      throw new IllegalStateException(e);
    }
  }

  /** JSON の文字列にする。 */
  private static void quote(StringBuilder out, String s) {
    out.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\\\') out.append('\\\\').append(c);
      else if (c < 0x20 || c == 0x2028 || c == 0x2029) out.append(String.format("\\\\u%04x", (int) c));
      else out.append(c);
    }
    out.append('"');
  }
}
`;
}

/**
 * 共有のシートでほかのアプリにファイルを読ませる ContentProvider（キャッシュの share/ だけ。読むだけ）。
 * androidx の FileProvider を使わずに、android.jar だけで組み立てるため自前で持つ。
 */
export function sharedFilesJava(pkg: string): string {
  return `package ${pkg};

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileNotFoundException;

/** スクリーンショットとセーブデータを、共有のシートからほかのアプリへ渡す（Liminalia の書き出しが作る）。 */
public class SharedFiles extends ContentProvider {
  @Override
  public boolean onCreate() {
    return true;
  }

  /** キャッシュの share/ の中のファイル（外へは出さない）。 */
  private File fileOf(Uri uri) throws FileNotFoundException {
    String name = uri.getLastPathSegment();
    if (name == null || name.contains("/") || name.equals("..")) throw new FileNotFoundException();
    File file = new File(new File(getContext().getCacheDir(), "share"), name);
    if (!file.isFile()) throw new FileNotFoundException();
    return file;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public String getType(Uri uri) {
    String name = uri.getLastPathSegment();
    String ext = name == null || !name.contains(".") ? "" : name.substring(name.lastIndexOf('.') + 1).toLowerCase();
    String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
    return type != null ? type : "application/octet-stream";
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
    File file;
    try {
      file = fileOf(uri);
    } catch (FileNotFoundException e) {
      return null;
    }
    MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
    c.addRow(new Object[] { file.getName(), file.length() });
    return c;
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    return null;
  }

  @Override
  public int delete(Uri uri, String selection, String[] args) {
    return 0;
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] args) {
    return 0;
  }
}
`;
}

/**
 * アプリ内課金（Google Play Billing。Play Billing Library 7 と 8 のどちらでも組み立てられる書き方）。ゲームの画面の
 * LiminaliaStore.call から {"id", "method", "product"} を受け、window.__liminaliaStoreReply(id, 結果) で答える。
 * 買ったもの（購入済みの状態）は確認（acknowledge）する（しないと 3 日で返金される）。Google Play は購入をアカウントに結ぶので、
 * 復元は持っているものを聞き直すことと同じ。
 */
export function storeBridgeJava(pkg: string): string {
  return `package ${pkg};

import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.AcknowledgePurchaseResponseListener;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.ProductDetailsResponseListener;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesResponseListener;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** アプリ内課金（Google Play Billing）。Liminalia の書き出し（lim build android）が作る。 */
public class StoreBridge implements PurchasesUpdatedListener {
  private final Activity activity;
  private final WebView web;
  private final BillingClient client;
  /** 買っている頼みの id（買い終えたら onPurchasesUpdated で答える）。 */
  private int buying = -1;

  StoreBridge(Activity activity, WebView web) {
    this.activity = activity;
    this.web = web;
    client = BillingClient.newBuilder(activity).setListener(this).enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()).build();
  }

  @JavascriptInterface
  public void call(String json) {
    final int id;
    final String method;
    final String product;
    try {
      JSONObject o = new JSONObject(json);
      id = o.getInt("id");
      method = o.optString("method");
      product = o.optString("product");
    } catch (Exception e) {
      return;
    }
    final boolean buy = "buy".equals(method);
    connect(id, buy, new Runnable() {
      @Override
      public void run() {
        if (buy) buy(id, product);
        else owned(id);
      }
    });
  }

  /** つないでから行う。つながらなければ失敗を答える（持っているものは null。ゲームの画面は前に確かめたものを使う）。 */
  private void connect(final int id, final boolean buy, final Runnable then) {
    if (client.isReady()) {
      then.run();
      return;
    }
    client.startConnection(new BillingClientStateListener() {
      @Override
      public void onBillingSetupFinished(BillingResult result) {
        if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) then.run();
        else reply(id, buy ? "failed" : null);
      }

      @Override
      public void onBillingServiceDisconnected() {}
    });
  }

  private void owned(final int id) {
    client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(), new PurchasesResponseListener() {
      @Override
      public void onQueryPurchasesResponse(BillingResult result, List<Purchase> purchases) {
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
          reply(id, null);
          return;
        }
        JSONArray out = new JSONArray();
        for (Purchase p : purchases) {
          if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
          acknowledge(p);
          for (String product : p.getProducts()) out.put(product);
        }
        reply(id, out);
      }
    });
  }

  private void buy(final int id, String product) {
    QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
        .setProductList(Collections.singletonList(QueryProductDetailsParams.Product.newBuilder().setProductId(product).setProductType(BillingClient.ProductType.INAPP).build()))
        .build();
    // 答えの受け手は Proxy で作る（Play Billing Library 7 は商品の一覧、8 は一覧を持つもの（getProductDetailsList）を渡すため、
    // どちらの形でもコンパイルでき、動くように）
    Object listener = Proxy.newProxyInstance(StoreBridge.class.getClassLoader(), new Class<?>[] { ProductDetailsResponseListener.class }, new InvocationHandler() {
      @Override
      public Object invoke(Object self, Method method, Object[] args) {
        if (!"onProductDetailsResponse".equals(method.getName()) || args == null || args.length < 2) return null;
        onDetails(id, (BillingResult) args[0], args[1]);
        return null;
      }
    });
    client.queryProductDetailsAsync(params, (ProductDetailsResponseListener) listener);
  }

  private void onDetails(final int id, BillingResult result, Object details) {
    List<?> list;
    try {
      list = details instanceof List ? (List<?>) details : details == null ? null : (List<?>) details.getClass().getMethod("getProductDetailsList").invoke(details);
    } catch (Exception e) {
      list = null;
    }
    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || list == null || list.isEmpty()) {
      reply(id, "failed");
      return;
    }
    final BillingFlowParams flow = BillingFlowParams.newBuilder()
        .setProductDetailsParamsList(Collections.singletonList(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails((ProductDetails) list.get(0)).build()))
        .build();
    activity.runOnUiThread(new Runnable() {
      @Override
      public void run() {
        buying = id;
        BillingResult launched = client.launchBillingFlow(activity, flow);
        int code = launched.getResponseCode();
        if (code != BillingClient.BillingResponseCode.OK) {
          buying = -1;
          reply(id, code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED ? "purchased" : "failed");
        }
      }
    });
  }

  @Override
  public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
    int id = buying;
    buying = -1;
    int code = result.getResponseCode();
    String answer = "failed";
    if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
      for (Purchase p : purchases) {
        if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
          acknowledge(p);
          answer = "purchased";
        } else if (p.getPurchaseState() == Purchase.PurchaseState.PENDING && !"purchased".equals(answer)) answer = "pending";
      }
    } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) answer = "cancelled";
    else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) answer = "purchased";
    // 承認待ちだった購入が済んだときなど、頼まれていないときは確認だけする
    if (id >= 0) reply(id, answer);
  }

  private void acknowledge(Purchase p) {
    if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED || p.isAcknowledged()) return;
    client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(), new AcknowledgePurchaseResponseListener() {
      @Override
      public void onAcknowledgePurchaseResponse(BillingResult r) {}
    });
  }

  private void reply(final int id, Object result) {
    final String json = result == null ? "null" : result instanceof String ? JSONObject.quote((String) result) : result.toString();
    web.post(new Runnable() {
      @Override
      public void run() {
        web.evaluateJavascript("window.__liminaliaStoreReply(" + id + "," + json + ")", null);
      }
    });
  }
}
`;
}

/**
 * アイコンを PNG にする。中身が PNG ならそのまま、ほかの画像（名前が .png でも中身が ICO など）は Mac なら
 * sips で work に PNG を作って返す。使えなければ null（アイコンなしで書き出す）。
 */
export function pngIcon(path: string | null, work: string): string | null {
  if (!path || !existsSync(path)) return null;
  const head = readFileSync(path).subarray(0, 8);
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return path;
  if (process.platform !== "darwin") {
    console.warn(`  アイコン ${path} は PNG ではないため、スマホ版はアイコンなしで書き出します`);
    return null;
  }
  const out = join(work, "icon.png");
  mkdirSync(work, { recursive: true });
  try {
    execFileSync("sips", ["-s", "format", "png", path, "--out", out], { stdio: "ignore" });
    return out;
  } catch {
    console.warn(`  アイコン ${path} を PNG に変換できないため、スマホ版はアイコンなしで書き出します`);
    return null;
  }
}
