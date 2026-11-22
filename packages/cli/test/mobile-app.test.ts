import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorChecks } from "../src/commands/doctor.ts";
import { androidPlatforms, BACKUP_RULES, buildAndroid, compilePlatform, findAndroidTools, mainActivity, manifest, MIN_ANDROID_WEBVIEW, missingPlatformMessage, PLAY_TARGET_SDK, saveFilesJava } from "../src/mobile/android.ts";
import { buildIosSimulator, createIosProject } from "../src/mobile/ios.ts";

/**
 * スマホのアプリの包み（Android の MainActivity とマニフェスト、iOS の App.swift）の、遊ぶ側の振る舞いに関わるところ。
 * LIMINALIA_MOBILE_BUILD=1 なら、手元の Android SDK と Xcode で組み立てまで通す。
 */
const build = process.env.LIMINALIA_MOBILE_BUILD === "1";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-mobile-app-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 中身の無い Android SDK（platforms と build-tools のフォルダだけ）と JDK の置き場。 */
function fakeSdk(platforms: string[]): { sdk: string; java: string } {
  const sdk = join(dir, "sdk");
  for (const p of platforms) {
    mkdirSync(join(sdk, "platforms", p), { recursive: true });
    writeFileSync(join(sdk, "platforms", p, "android.jar"), "");
  }
  mkdirSync(join(sdk, "build-tools", "33.0.2"), { recursive: true });
  const java = join(dir, "jdk");
  mkdirSync(join(java, "bin"), { recursive: true });
  writeFileSync(join(java, "bin", "javac"), "");
  return { sdk, java };
}

describe("Android の targetSdk", () => {
  it("既定は Google Play の下限。組み立てには targetSdk（と戻るの口のある 33）以上の SDK Platform が要り、無ければ入れ方を出す", () => {
    expect(PLAY_TARGET_SDK).toBeGreaterThanOrEqual(36);
    const { sdk } = fakeSdk(["android-33", "android-36", "android-36.1", "android-Baklava", "android-34-ext12"]);
    expect([...androidPlatforms(sdk).keys()].sort()).toEqual([33, 34, 36]);
    // 同じ API の新しい方（36.1）を使う
    expect(compilePlatform(sdk, 36)).toEqual({ api: 36, dir: join(sdk, "platforms", "android-36.1") });
    // 33 より前の targetSdk でも、組み立ては 33 以上（いちばん新しいもの）
    expect(compilePlatform(sdk, 30).api).toBe(36);
    expect(() => compilePlatform(sdk, 37)).toThrow('Android 17（API 37）の SDK Platform がありません（入っているのは API 33、34、36）。Android Studio の SDK Manager で入れてください（コマンドなら sdkmanager "platforms;android-37"）');
    expect(missingPlatformMessage(36, [])).toContain("一つも入っていません");
  });

  // lim doctor の確かめ（手元の道具を一つずつ起こす）を三度流す
  it("lim doctor: targetSdk の SDK Platform が無ければ要るものとして知らせ、Google Play の下限より小さい targetSdk は --aab で止めると出す", { timeout: 60_000 }, () => {
    const { sdk, java } = fakeSdk(["android-33"]);
    const saved = { ANDROID_HOME: process.env.ANDROID_HOME, JAVA_HOME: process.env.JAVA_HOME };
    process.env.ANDROID_HOME = sdk;
    process.env.JAVA_HOME = java;
    try {
      const game = join(dir, "game");
      mkdirSync(game);
      writeFileSync(join(game, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { androidAab: true } }));
      const of = (checks: ReturnType<typeof doctorChecks>, name: string) => checks.find((c) => c.name.startsWith(name));
      const plain = doctorChecks(loadProject(game), ["android"], {});
      expect(of(plain, "SDK Platform")).toMatchObject({ name: `SDK Platform（targetSdk ${PLAY_TARGET_SDK}）`, ok: false, need: "required" });
      expect(of(plain, "SDK Platform")!.detail).toContain("入っているのは API 33");
      expect(of(plain, "targetSdk（Google Play）")).toBeUndefined();
      writeFileSync(join(game, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { androidAab: true, android: { targetSdk: 33 } } }));
      const low = doctorChecks(loadProject(game), ["android"], {});
      expect(of(low, "SDK Platform")).toMatchObject({ ok: true });
      expect(of(low, "targetSdk（Google Play）")).toMatchObject({ ok: false, need: "required" });
      // 署名を書いていなければ、リリースの鍵の行は出さない（targetSdk だけを書いてもよい）
      expect(of(low, "リリースの鍵")).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("Android のアプリの振る舞い", () => {
  const java = mainActivity("com.example.game");
  const xml = manifest({ title: "G", icon: null, landscape: true }, "com.example.game");

  it("ゲームとして登録し（Android 16 の大きな画面でも向きの固定が効く）、文字の大きさ・表示の大きさ・言語を変えても作り直さない", () => {
    expect(xml).toContain('android:appCategory="game"');
    expect(xml).toContain('android:screenOrientation="sensorLandscape"');
    expect(xml).toMatch(/android:configChanges="[^"]*\bfontScale\|density\|locale\|layoutDirection"/);
    // 端末の文字の大きさの設定でゲームの文字を大きくしない
    expect(java).toContain("s.setTextZoom(100);");
    // 画面の切り欠きの分を空ける
    expect(java).toContain("insets.getDisplayCutout()");
  });

  it("戻るは API 33 から OnBackInvokedCallback で受け（予測型の戻るでも閉じない）、ゲームの __liminalia.back() に渡す", () => {
    expect(xml).toContain('android:enableOnBackInvokedCallback="true"');
    expect(java).toContain("getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)");
    expect(java).toMatch(/public void onBackPressed\(\) \{\s*back\(\);/);
    expect(java).toContain("g.back && g.back()");
    // ゲームが扱わなければ裏へ回る（閉じない）
    expect(java).toContain('if (!"true".equals(handled)) moveTaskToBack(true);');
    // 古い Esc の送り方はやめた
    expect(java).not.toContain("key: 'Escape'");
  });

  it("@open-url とゲームの外へのリンクは端末のブラウザへ（http・https・mailto だけ）、@quit はアプリを閉じる", () => {
    expect(java).toContain('web.addJavascriptInterface(new AppBridge(), "LiminaliaApp")');
    expect(java).toMatch(/public void openUrl\(String url\) \{\s*openExternal\(url\);/);
    expect(java).toContain("finishAndRemoveTask();");
    expect(java).toContain('if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) return;');
    expect(java).toContain("new Intent(Intent.ACTION_VIEW, uri)");
    expect(java).toMatch(/shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\) \{[\s\S]*?if \(HOST\.equals\(url\.getHost\(\)\) \|\| !request\.isForMainFrame\(\)\) return false;/);
  });

  it("起動したとき、端末の WebView が古ければ（99 より前）Google Play で更新するよう知らせる", () => {
    expect(MIN_ANDROID_WEBVIEW).toBe(99);
    expect(java).toContain("private static final int MIN_WEBVIEW = 99;");
    expect(java).toContain('Pattern.compile("Chrome/(\\\\d+)").matcher(WebSettings.getDefaultUserAgent(this))');
    expect(java).toMatch(/web\.loadUrl\("https:\/\/" \+ HOST \+ "\/index\.html"\);\s*checkWebView\(\);/);
    expect(java).toContain('"market://details?id=" + store');
    expect(java).toContain("WebView.getCurrentWebViewPackage()");
    // 日本語と英語
    expect(java).toContain('"WebView を更新してください" : "Update Android System WebView"');
  });

  it("描画のプロセスが落ちたら、WebView を作り直して ?resume=1 で読み直す（続けて落ちるなら閉じる）", () => {
    expect(java).toMatch(/public boolean onRenderProcessGone\(WebView view, android\.webkit\.RenderProcessGoneDetail detail\) \{\s*if \(view == MainActivity\.this\.web\) restartWeb\(\);\s*return true;/);
    expect(java).toMatch(/private void restartWeb\(\) \{[\s\S]*?old\.destroy\(\);[\s\S]*?web = createWeb\(\);[\s\S]*?web\.loadUrl\("https:\/\/" \+ HOST \+ "\/index\.html\?resume=1"\);/);
    expect(java).toContain("if (crashes.size() >= 3) {");
  });

  it("オートと動画の間は画面を消さず（FLAG_KEEP_SCREEN_ON）、@vibrate は端末の振動（VIBRATE の許可）", () => {
    expect(java).toMatch(/public void keepAwake\(final boolean on\)[\s\S]*?addFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)[\s\S]*?clearFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
    expect(java).toContain("VibrationEffect.createWaveform(wave, -1)");
    expect(java).toContain("v.cancel();");
    expect(xml).toContain('<uses-permission android:name="android.permission.VIBRATE" />');
    // ライブラリのマニフェストが同じ許可を持っていても一つだけ
    const merged = manifest({ title: "G", icon: null, landscape: true }, "com.example.game", { outside: ['<uses-permission android:name="android.permission.VIBRATE" />', '<uses-permission android:name="com.android.vending.BILLING" />'], inside: [] });
    expect(merged.match(/android\.permission\.VIBRATE/g)).toHaveLength(1);
  });

  it("セーブは鍵ごとのファイル（SaveFiles）に書き、前の版の SharedPreferences は、はじめて使うときに移す", () => {
    expect(java).toContain("saves = new SaveFiles(getFilesDir());");
    expect(java).toContain('if (!saves.exists()) saves.create(getSharedPreferences("liminalia-saves", MODE_PRIVATE).getAll());');
    expect(java).toMatch(/public boolean set\(String key, String value\) \{\s*return saves\.set\(key, value\);/);
    expect(saveFilesJava("com.example.game")).not.toMatch(/import android\./);
  });

  it("端末のバックアップ（Google のアカウントと新しい端末への引き継ぎ）には、セーブの置き場所（saves/）だけを入れる", () => {
    expect(xml).toContain('android:allowBackup="true"');
    expect(xml).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(xml).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(BACKUP_RULES["backup_rules.xml"]).toContain('<include domain="file" path="saves/" />');
    const rules = BACKUP_RULES["data_extraction_rules.xml"];
    expect(rules.match(/<include domain="file" path="saves\/" \/>/g)).toHaveLength(2);
    expect(rules).toMatch(/<cloud-backup>[\s\S]*<\/cloud-backup>\s*<device-transfer>[\s\S]*<\/device-transfer>/);
  });

  const jdk = (() => {
    try {
      const t = findAndroidTools();
      return { javac: join(t.java, "bin", "javac"), java: join(t.java, "bin", "java") };
    } catch {
      return null;
    }
  })();
  it.skipIf(!jdk)("SaveFiles を JDK で動かすと、前の版の中身を移し、書く・消す・全部を JSON で返す", { timeout: 60_000 }, () => {
    const src = join(dir, "src", "com", "example", "game");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SaveFiles.java"), saveFilesJava("com.example.game"));
    writeFileSync(
      join(src, "Try.java"),
      `package com.example.game;
import java.io.File;
import java.util.*;
public class Try {
  public static void main(String[] a) throws Exception {
    SaveFiles s = new SaveFiles(new File(a[0]));
    System.out.println(s.exists());
    Map<String, Object> old = new LinkedHashMap<>();
    old.put("liminalia:g:slot:1", "{\\"a\\":\\"x\\\\\\"y\\"}");
    old.put("日本:語 *", "改行\\nと\\u2028と\\t");
    old.put("liminalia:g:count", Integer.valueOf(3));
    System.out.println(s.create(old));
    System.out.println(s.exists());
    System.out.println(s.set("liminalia:g:config", "{}"));
    System.out.println(s.set("liminalia:g:config", "{\\"b\\":1}"));
    System.out.println(s.remove("日本:語 *"));
    System.out.println(s.set("liminalia:g:slot:2", "二つめ"));
    System.out.println(s.load());
  }
}
`,
    );
    const classes = join(dir, "classes");
    mkdirSync(classes);
    execFileSync(jdk!.javac, ["-encoding", "UTF-8", "-nowarn", "-Xlint:-options", "-source", "8", "-target", "8", "-d", classes, join(src, "SaveFiles.java"), join(src, "Try.java")]);
    const root = join(dir, "files");
    mkdirSync(root);
    const out = execFileSync(jdk!.java, ["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-cp", classes, "com.example.game.Try", root]).toString("utf8").trim().split("\n");
    expect(out.slice(0, 7)).toEqual(["false", "true", "true", "true", "true", "true", "true"]);
    expect(JSON.parse(out[7]!)).toEqual({ "liminalia:g:slot:1": '{"a":"x\\"y"}', "liminalia:g:config": '{"b":1}', "liminalia:g:slot:2": "二つめ" });
    // 移す前の中身は、書き切ってから置き場所の名前にした
    expect(existsSync(join(root, "saves-tmp", "staging"))).toBe(false);
  });

  it.skipIf(!build)("手元の SDK で組み立て、マニフェストに targetSdk と appCategory が入る", { timeout: 600_000 }, () => {
    const tools = findAndroidTools();
    const targetSdk = Math.min(PLAY_TARGET_SDK, Math.max(...androidPlatforms(tools.sdk).keys()));
    const web = join(dir, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>G</title>");
    const out = join(dir, "out", "game.apk");
    // アイコン（適応アイコンの資源も組み立てる）
    const icon = join(dir, "icon.png");
    writeFileSync(icon, readFileSync(resolve(import.meta.dirname, "../../../site/public/brand/icon-256.png")));
    buildAndroid({ web, work: join(dir, "work"), out, appId: "com.example.game", title: "G", version: "1.0.0", versionCode: 1, landscape: true, icon, targetSdk });
    const resources = execFileSync(join(tools.buildTools, "aapt2"), ["dump", "resources", out]).toString();
    expect(resources).toContain("mipmap/ic_launcher_foreground");
    expect(resources).toContain("color/ic_launcher_background");
    expect(resources).toMatch(/mipmap\/ic_launcher[\s\S]*?anydpi-v26/);
    const tree = execFileSync(join(tools.buildTools, "aapt2"), ["dump", "xmltree", "--file", "AndroidManifest.xml", out]).toString();
    expect(tree).toMatch(new RegExp(`targetSdkVersion\\(0x[0-9a-f]+\\)=${targetSdk}`));
    expect(tree).toContain("appCategory");
    expect(tree).toContain("enableOnBackInvokedCallback");
    expect(tree).toContain("fullBackupContent");
    expect(tree).toContain("dataExtractionRules");
    expect(resources).toContain("xml/backup_rules");
    expect(resources).toContain("xml/data_extraction_rules");
  });
});

describe("iOS のアプリの振る舞い", () => {
  const swiftOf = (o: Partial<Parameters<typeof createIosProject>[0]> = {}) => {
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>G</title>");
    const project = createIosProject({ web: join(dir, "web"), dir: join(dir, "proj"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null, ...o });
    return { project, swift: readFileSync(join(dir, "proj", "App", "App.swift"), "utf8") };
  };

  it("@open-url とゲームの外へのリンク・window.open は端末のブラウザで開く（http・https・mailto だけ）", () => {
    const { swift } = swiftOf();
    expect(swift).toContain('config.userContentController.add(app, name: "liminaliaApp")');
    expect(swift).toContain('["http", "https", "mailto"].contains(scheme)');
    expect(swift).toContain("UIApplication.shared.open(url)");
    expect(swift).toContain("web.navigationDelegate = self");
    expect(swift).toContain("decisionHandler(.cancel)");
    expect(swift).toContain("createWebViewWith configuration");
  });

  it("セーブはアプリの Application Support に鍵ごとのファイルで置き、ページの頭で LiminaliaSaves（previous: indexeddb）を置く", () => {
    const { swift } = swiftOf();
    expect(swift).toContain('appendingPathComponent("liminalia-saves", isDirectory: true)');
    expect(swift).toContain('config.userContentController.add(saves, name: "liminaliaSaves")');
    expect(swift).toContain("previous: 'indexeddb'");
    expect(swift).toContain("injectionTime: .atDocumentStart");
    expect(swift).toContain("write(to: file(key), options: .atomic)");
    // 読み直すときは、今の中身でスクリプトを置き直す
    expect(swift).toMatch(/guard crashes\.count < 3 else \{ return \}\s*installScripts\(webView\.configuration\.userContentController\)/);
  });

  it("起動の画面は白くせず作品の起動の演出の色（無ければ黒）。音の扱いは既定で消音スイッチに従い（ambient）、playback も選べる", () => {
    const { swift } = swiftOf();
    const plist = readFileSync(join(dir, "proj", "App", "Info.plist"), "utf8");
    expect(plist).toMatch(/<key>UILaunchScreen<\/key>\s*<dict>\s*<key>UIColorName<\/key>\s*<string>LaunchBackground<\/string>/);
    const color = JSON.parse(readFileSync(join(dir, "proj", "App", "Assets.xcassets", "LaunchBackground.colorset", "Contents.json"), "utf8"));
    expect(color.colors[0].color.components).toEqual({ red: "0.000", green: "0.000", blue: "0.000", alpha: "1.000" });
    // アイコンが無くても素材のカタログは入れる（起動の画面の色のため）。アイコンの設定は入れない
    const pbx = readFileSync(join(dir, "proj", "App.xcodeproj", "project.pbxproj"), "utf8");
    expect(pbx).toContain("Assets.xcassets in Resources");
    expect(pbx).not.toContain("ASSETCATALOG_COMPILER_APPICON_NAME");
    expect(swift).toContain("try? AVAudioSession.sharedInstance().setCategory(.ambient)");
    expect(swift).toContain("navigator.audioSession.type = 'ambient'");
    rmSync(join(dir, "proj"), { recursive: true, force: true });
    const play = swiftOf({ audioSession: "playback", launchBackground: "#ff8000" });
    expect(play.swift).toContain("setCategory(.playback)");
    expect(play.swift).toContain("navigator.audioSession.type = 'playback'");
    expect(JSON.parse(readFileSync(join(dir, "proj", "App", "Assets.xcassets", "LaunchBackground.colorset", "Contents.json"), "utf8")).colors[0].color.components).toEqual({ red: "1.000", green: "0.502", blue: "0.000", alpha: "1.000" });
  });

  it("描画のプロセスが落ちたら ?resume=1 で読み直す（続けて落ちるなら読み直さない）", () => {
    const { swift } = swiftOf();
    expect(swift).toMatch(/func webViewWebContentProcessDidTerminate\(_ webView: WKWebView\) \{[\s\S]*?guard crashes\.count < 3 else \{ return \}[\s\S]*?app:\/\/game\/index\.html\?resume=1/);
  });

  it("オートと動画の間は画面を消さず（isIdleTimerDisabled）、@vibrate は触覚（Core Haptics）", () => {
    const { swift } = swiftOf();
    expect(swift).toContain('case "keep-awake":');
    expect(swift).toContain("UIApplication.shared.isIdleTimerDisabled = body[\"on\"] as? Bool ?? false");
    expect(swift).toContain("import CoreHaptics");
    expect(swift).toContain("CHHapticEngine.capabilitiesForHardware().supportsHaptics");
    expect(swift).toContain("eventType: .hapticContinuous");
  });

  it.skipIf(!build || process.platform !== "darwin")("シミュレータ用にビルドする", { timeout: 600_000 }, () => {
    const { project } = swiftOf();
    expect(existsSync(buildIosSimulator(project, join(dir, "build")))).toBe(true);
  });
});
