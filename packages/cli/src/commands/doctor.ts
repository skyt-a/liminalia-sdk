import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProject, type Project } from "@liminalia/project";
import { findChromium } from "../chromium.ts";
import { androidPlatforms, compilePlatform, findAndroidTools, findBundletool, PLAY_TARGET_SDK } from "../mobile/android.ts";
import { iosTeam } from "../mobile/ios.ts";
import { findMakensis } from "../installer/nsis.ts";
import { updateModule } from "../update.ts";
import { electronVersion, nodeEngines } from "../engine-paths.ts";
import { findSteamcmd } from "./publish-steam.ts";
import { englishText } from "../english-output.ts";

/**
 * lim doctor [プロジェクト] [--target mac,windows,android,…] [--json] — 書き出しに要る道具をまとめて確かめる。
 * 作品を渡すと、その liminalia.json の設定（素材の圧縮、インストーラー、署名、Steam、署名つきの更新など）から「要るもの」を決める。
 * --target を渡すと、その書き出し先に要るものも「要る」にする。要るものが一つでも無ければ終了の値は 1。
 * 何も変えない（入れたり鍵を作ったりはしない）。
 */

export type Need = "required" | "optional";
export interface DoctorCheck {
  group: string;
  name: string;
  ok: boolean;
  need: Need;
  detail: string;
  /** 無いときの入れ方。 */
  fix?: string;
}

const TARGETS = ["browser", "mac", "windows", "linux", "android", "ios", "steam", "update"] as const;
export type DoctorTarget = (typeof TARGETS)[number];

function has(cmd: string, args: string[] = ["-version"]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  } catch {
    // 動かせない道具は「無い」と出す（診断の表の一行になる）
    return null;
  }
}

/** package.json の engines（^22.23.4 || ^24.22.1 || >=26.12.1）に Node の版が合うか。 */
export function nodeSatisfies(version: string, range: string): boolean {
  const v = version.replace(/^v/, "").split(".").map(Number);
  const ge = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  return range.split("||").some((part) => {
    const p = part.trim();
    const m = /^(\^|>=)?(\d+)\.(\d+)\.(\d+)$/.exec(p);
    if (!m) return false;
    const want = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (m[1] === ">=") return ge(v, want);
    if (m[1] === "^") return v[0] === want[0] && ge(v, want);
    return v.join(".") === want.join(".");
  });
}

export function doctorChecks(project: Project | null, targets: readonly DoctorTarget[] = [], env: Record<string, string | undefined> = process.env): DoctorCheck[] {
  const b = project?.config.build;
  const want = (t: DoctorTarget, configured = false): Need => (targets.includes(t) || configured ? "required" : "optional");
  const out: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => out.push(c);
  const mac = process.platform === "darwin";

  // ---- 共通 ----
  const engines = nodeEngines();
  add({ group: "共通", name: "Node.js", ok: !engines || nodeSatisfies(process.version, engines), need: "required", detail: engines ? `${process.version}（要るのは ${engines}）` : process.version, fix: "https://nodejs.org/ から、セキュリティの修正の入った版を入れてください" });
  let chromium: string | undefined;
  try {
    chromium = findChromium();
  } catch {
    // 見つからない理由は表の「見つかりません」と入れ方で出す
    chromium = undefined;
  }
  add({ group: "共通", name: "Chromium（書き出しの確かめ、lim shot、lim playtest）", ok: !!chromium && existsSync(chromium), need: "required", detail: chromium ?? "見つかりません", fix: "npx playwright-core install chromium-headless-shell（か環境変数 LIMINALIA_CHROMIUM に場所）" });
  // npm で入れた lim は版だけを持ち、本体は書き出すときに取り寄せる（engine-paths.ts）
  const electron = electronVersion() ?? "";
  add({ group: "デスクトップ版", name: "Electron", ok: !!electron, need: want("mac") === "required" || want("windows") === "required" || want("linux") === "required" ? "required" : "optional", detail: electron || "見つかりません", fix: "このリポジトリで npm install" });

  // ---- 素材の圧縮 ----
  const compress = [b?.mobile, b?.browser?.compress, b?.desktop?.compress].filter(Boolean);
  const needAudio = compress.some((c) => c?.audio);
  const needImages = compress.some((c) => c?.images);
  const ffmpeg = has("ffmpeg");
  add({ group: "素材の圧縮", name: "ffmpeg（音）", ok: !!ffmpeg, need: needAudio ? "required" : "optional", detail: ffmpeg ?? "見つかりません", fix: "brew install ffmpeg（Linux は apt install ffmpeg）" });
  const cwebp = has("cwebp", ["-version"]);
  add({ group: "素材の圧縮", name: "cwebp（画像）", ok: !!cwebp, need: needImages ? "required" : "optional", detail: cwebp ? `cwebp ${cwebp}` : "見つかりません", fix: "brew install webp（Linux は apt install webp）" });

  // ---- Mac ----
  if (mac) {
    const ids = has("security", ["find-identity", "-v", "-p", "codesigning"]) !== null ? execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }) : "";
    const developerId = /Developer ID Application/.test(ids);
    const configured = !!(env.LIMINALIA_MAC_SIGN_IDENTITY ?? b?.mac?.signIdentity);
    add({ group: "Mac 版", name: "Developer ID の証明書（配布用の署名）", ok: developerId, need: configured ? "required" : "optional", detail: developerId ? "キーチェーンにあります" : "ありません（自分の Mac で動かすだけならアドホック署名で書き出せます）", fix: "Apple Developer の「Certificates」で Developer ID Application を作り、キーチェーンに入れる" });
    const notary = !!(env.LIMINALIA_NOTARY_PROFILE ?? b?.mac?.notaryProfile ?? env.LIMINALIA_NOTARY_KEY ?? env.LIMINALIA_NOTARY_APPLE_ID);
    add({ group: "Mac 版", name: "公証の認証情報", ok: notary, need: "optional", detail: notary ? "あります" : "ありません（署名だけになります）", fix: "xcrun notarytool store-credentials liminalia-notary（docs/distribution.md）" });
  }

  // ---- Windows ----
  const installer = !!b?.windows?.installer;
  const makensis = findMakensis(env);
  add({ group: "Windows 版", name: "makensis（インストーラー）", ok: !!makensis, need: installer ? "required" : "optional", detail: makensis ?? "見つかりません", fix: "brew install makensis（Linux は apt install nsis）" });
  if (process.platform !== "win32") {
    const pfx = !!(env.LIMINALIA_WIN_PFX ?? b?.windows?.sign?.pfx);
    const osslsigncode = has(env.LIMINALIA_OSSLSIGNCODE ?? "osslsigncode", ["--version"]);
    add({ group: "Windows 版", name: "osslsigncode（PFX での署名）", ok: !!osslsigncode, need: pfx ? "required" : "optional", detail: osslsigncode ?? "見つかりません", fix: "brew install osslsigncode（Linux は apt install osslsigncode）" });
    add({ group: "Windows 版", name: "Wine", ok: true, need: "optional", detail: "要りません（実行ファイルの書き換えは JavaScript だけで行います。起動の確かめは Windows 機で）" });
  }

  // ---- Android ----
  let android = "";
  let androidProblem = "";
  let sdk = "";
  try {
    const t = findAndroidTools();
    android = `${t.buildTools}（JDK ${t.java}）`;
    sdk = t.sdk;
  } catch (e) {
    androidProblem = e instanceof Error ? e.message : String(e);
  }
  add({ group: "Android 版", name: "Android SDK と JDK", ok: !!android, need: want("android"), detail: android || androidProblem, fix: "Android Studio を入れ、SDK Manager で Platform と Build-Tools を入れる（場所は ANDROID_HOME、JAVA_HOME）" });
  // targetSdk の SDK Platform（targetSdk は作品の設定。既定は Google Play の下限。手元の SDK の版では決めない）
  const targetSdk = b?.android?.targetSdk ?? PLAY_TARGET_SDK;
  let platform = "";
  let platformProblem = "";
  if (sdk) {
    try {
      platform = compilePlatform(sdk, targetSdk).dir;
    } catch (e) {
      platformProblem = e instanceof Error ? e.message : String(e);
    }
  } else platformProblem = "Android SDK が見つかりません";
  add({ group: "Android 版", name: `SDK Platform（targetSdk ${targetSdk}）`, ok: !!platform, need: want("android", !!b?.androidAab), detail: platform || platformProblem, fix: `SDK Manager の「SDK Platforms」で API ${Math.max(targetSdk, 33)} 以上と、同じバージョンの Build-Tools を入れる（sdkmanager "platforms;android-${Math.max(targetSdk, 33)}"）` });
  if (targetSdk < PLAY_TARGET_SDK) {
    const installed = sdk ? [...androidPlatforms(sdk).keys()].sort((x, y) => x - y).join("、") : "";
    add({ group: "Android 版", name: "targetSdk（Google Play）", ok: false, need: b?.androidAab ? "required" : "optional", detail: installed ? `build.android.targetSdk が ${targetSdk}（Google Play は ${PLAY_TARGET_SDK} 以上。--aab は止めます）。入っている SDK Platform は API ${installed}` : `build.android.targetSdk が ${targetSdk}（Google Play は ${PLAY_TARGET_SDK} 以上。--aab は止めます）`, fix: `build.android.targetSdk を消すか ${PLAY_TARGET_SDK} 以上にする` });
  }
  let bundletool = "";
  try {
    bundletool = findBundletool(env).join(" ");
  } catch {
    // 見つからない理由は表の「見つかりません」と入れ方で出す
    bundletool = "";
  }
  add({ group: "Android 版", name: "bundletool（Google Play の .aab）", ok: !!bundletool, need: b?.androidAab ? "required" : "optional", detail: bundletool || "見つかりません", fix: "brew install bundletool（か bundletool-all の jar を ~/.liminalia/tools/ に置く、LIMINALIA_BUNDLETOOL）" });
  const signing = b?.android;
  if (signing?.keystore && signing.storePasswordEnv) {
    const ks = resolve(project!.root, signing.keystore);
    const pass = signing.storePasswordEnv;
    add({ group: "Android 版", name: "リリースの鍵（build.android）", ok: existsSync(ks) && !!env[pass], need: "required", detail: env[pass] ? `${existsSync(ks) ? ks : `${ks} がありません`}、パスワードの環境変数 ${pass} はあります` : `${existsSync(ks) ? ks : `${ks} がありません`}、パスワードの環境変数 ${pass} はありません`, fix: "keytool -genkeypair で作り、パスワードを環境変数に入れる（docs/distribution.md の Google Play）" });
  }

  // ---- iOS ----
  if (mac) {
    const xcode = has("xcodebuild", ["-version"]);
    add({ group: "iOS 版", name: "Xcode", ok: !!xcode, need: want("ios"), detail: xcode ?? "見つかりません", fix: "App Store から Xcode を入れ、xcode-select -s /Applications/Xcode.app" });
    let team = "";
    let teamProblem = "";
    try {
      team = iosTeam(b?.ios?.team);
    } catch (e) {
      teamProblem = e instanceof Error ? e.message : String(e);
    }
    add({ group: "iOS 版", name: "署名のチーム（実機、Archive）", ok: !!team, need: "optional", detail: team || teamProblem, fix: "Xcode の Settings → Accounts に Apple ID を入れる（App Store に出すなら Apple Developer Program の登録）" });
    const asc = !!((env.LIMINALIA_ASC_KEY ?? env.LIMINALIA_NOTARY_KEY) && (env.LIMINALIA_ASC_KEY_ID ?? env.LIMINALIA_NOTARY_KEY_ID) && (env.LIMINALIA_ASC_ISSUER ?? env.LIMINALIA_NOTARY_ISSUER));
    add({ group: "iOS 版", name: "App Store Connect の API キー（--upload）", ok: asc, need: "optional", detail: asc ? "あります" : "ありません（Transporter で上げるなら要りません）", fix: "App Store Connect の「ユーザとアクセス → 統合」でキーを作り、LIMINALIA_ASC_KEY、_KEY_ID、_ISSUER" });
  } else add({ group: "iOS 版", name: "Xcode", ok: false, need: want("ios"), detail: "iOS 版は Mac でだけ書き出せます" });

  // ---- Steam ----
  const steamcmd = findSteamcmd(env);
  add({ group: "Steam", name: "steamcmd（lim publish steam）", ok: !!steamcmd, need: b?.steam?.depots || targets.includes("steam") ? "required" : "optional", detail: steamcmd ?? "見つかりません", fix: "Steamworks SDK の tools/ContentBuilder/builder_osx/steamcmd.sh を LIMINALIA_STEAMCMD に（か PATH に steamcmd）" });
  if (b?.steam) add({ group: "Steam", name: "デポ（build.steam.depots）", ok: !!b.steam.depots && Object.keys(b.steam.depots).length > 0, need: targets.includes("steam") ? "required" : "optional", detail: b.steam.depots ? Object.entries(b.steam.depots).map(([k, v]) => `${k} ${v}`).join("、") : "ありません", fix: "Steamworks の SteamPipe → デポで作り、liminalia.json の build.steam.depots に書く" });

  // ---- 更新の署名 ----
  const publicKey = b?.update?.publicKey;
  const keyFile = env.LIMINALIA_UPDATE_SIGN_KEY;
  if (publicKey || keyFile || targets.includes("update")) {
    let detail = keyFile ? (existsSync(keyFile) ? keyFile : `${keyFile} がありません`) : "LIMINALIA_UPDATE_SIGN_KEY がありません";
    let ok = !!keyFile && existsSync(keyFile);
    if (ok && publicKey) {
      const keys = Array.isArray(publicKey) ? publicKey : [publicKey];
      const pub = updateModule.publicKeyOf(readFileSync(keyFile!, "utf8"));
      ok = keys.includes(pub);
      if (!ok) detail = `${keyFile} の公開鍵 ${pub} が build.update.publicKey と合いません`;
    }
    add({ group: "更新", name: "マニフェストの署名の秘密鍵", ok, need: publicKey || targets.includes("update") ? "required" : "optional", detail, fix: "lim update-key で作り、LIMINALIA_UPDATE_SIGN_KEY にそのパス（docs/distribution.md）" });
  }

  // ---- 暗号化 ----
  if (project && (b?.encrypt || b?.browser?.encrypt)) {
    const keys = [b?.encrypt ? "encrypt-key" : null, b?.browser?.encrypt ? "encrypt-key-browser" : null].filter((x): x is string => !!x);
    const missing = keys.filter((k) => !existsSync(join(project.root, ".liminalia", k)));
    add({ group: "暗号化", name: "暗号の鍵（.liminalia/）", ok: true, need: "optional", detail: missing.length === 0 ? "あります（控えておいてください）" : `${missing.join("、")} は、はじめて書き出すときに作ります` });
  }
  return out;
}

export function runDoctor(dir: string | null, o: { targets?: string[]; json?: boolean; lang?: "ja" | "en" }): boolean {
  const bad = (o.targets ?? []).filter((t) => !(TARGETS as readonly string[]).includes(t));
  if (bad.length > 0) throw new Error(`--target に ${bad.join("、")} は使えません（${TARGETS.join(" / ")}）`);
  const project = dir ? loadProject(dir) : null;
  // 英語の出力では、表の名前と中身と入れ方も英語の表（messages-en.ts）で読み替える
  const t = o.lang === "en" ? englishText : (text: string) => text;
  const checks = doctorChecks(project, (o.targets ?? []) as DoctorTarget[]).map((c) => ({ ...c, group: t(c.group), name: t(c.name), detail: t(c.detail), ...(c.fix ? { fix: t(c.fix) } : {}) }));
  const missing = checks.filter((c) => !c.ok && c.need === "required");
  if (o.json) {
    console.log(JSON.stringify({ project: project?.root ?? null, ok: missing.length === 0, checks }, null, 2));
    return missing.length === 0;
  }
  let group = "";
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`\n${group}`);
    }
    const mark = c.ok ? "○" : c.need === "required" ? "×" : "△";
    console.log(`  ${mark} ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) console.log(`      → ${c.fix}`);
  }
  console.log(project ? "\n○ あり　× 要るのに無い　△ 無い（この作品の設定では使わない。使うときに要る）" : "\n○ あり　× 要るのに無い　△ 無い（作品を渡さなければ使わない。使うときに要る）");
  if (missing.length > 0) console.log(`要るのに無いもの: ${missing.length} 件`);
  else console.log(project ? "この作品の書き出しに要るものは揃っています" : "共通に要るものは揃っています（作品のフォルダを渡すと、その設定に要るものも確かめます）");
  return missing.length === 0;
}
