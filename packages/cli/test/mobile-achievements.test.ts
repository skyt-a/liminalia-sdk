import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gameCenterSwift, playGamesBridgeJava, playGamesProblems, playGamesValuesXml } from "../src/mobile/achievements.ts";
import { androidPlatforms, buildAndroid, findAndroidTools, mainActivity, manifest, mergeLibraryManifests, PLAY_TARGET_SDK } from "../src/mobile/android.ts";
import { buildIosSimulator, createIosProject } from "../src/mobile/ios.ts";
import { nativeAchievements } from "../../web/src/achievements.ts";

/**
 * スマホの実績（Game Center と Google Play Games）。作るコードを確かめる。
 * LIMINALIA_MOBILE_BUILD=1 なら、包みのビルド（Android は javac と d8 まで通して APK を作る。iOS は xcodebuild のシミュレータ用）も確かめる。
 * Play Games のライブラリは手元に無いので、使う API と同じ形の差し替え（スタブ）の JAR と、資源を持つ AAR を作って組み立てる。
 */
const build = process.env.LIMINALIA_MOBILE_BUILD === "1";

describe("スマホの実績の口", () => {
  it("ゲームの画面は、iOS と Android のアプリの口へ {method, id, value, goal} の JSON を送る", () => {
    const sent: string[] = [];
    nativeAchievements({ webkit: { messageHandlers: { liminaliaAchievements: { postMessage: (m) => sent.push(`ios ${m}`) } } } })!({ method: "unlock", id: "star" });
    nativeAchievements({ LiminaliaAchievements: { call: (m) => sent.push(`android ${m}`) } })!({ method: "progress", id: "reads", value: 3, goal: 10 });
    expect(sent).toEqual(['ios {"method":"unlock","id":"star"}', 'android {"method":"progress","id":"reads","value":3,"goal":10}']);
    expect(nativeAchievements({})).toBeNull();
  });

  it("iOS: Game Center があるときだけ GameKit の口・サインイン・entitlements を入れる。ID は対応（無ければ同じ名前）", () => {
    const swift = gameCenterSwift({ star: "com.example.star" });
    expect(swift).toContain('private let ids: [String: String] = ["star": "com.example.star"]');
    expect(swift).toContain("GKAchievement.report");
    expect(swift).toContain("value / goal * 100");
    expect(gameCenterSwift({})).toContain("private let ids: [String: String] = [:]");
    const dir = mkdtempSync(join(tmpdir(), "liminalia-ios-games-"));
    try {
      mkdirSync(join(dir, "web"));
      const base = { web: join(dir, "web"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null };
      createIosProject({ ...base, dir: join(dir, "a"), gameCenter: { achievements: { star: "com.example.star" } } });
      const app = readFileSync(join(dir, "a", "App", "App.swift"), "utf8");
      expect(app).toContain("import GameKit");
      expect(app).toContain('config.userContentController.add(achievements, name: "liminaliaAchievements")');
      expect(app).toContain("achievements.authenticate()");
      expect(readFileSync(join(dir, "a", "App", "App.entitlements"), "utf8")).toContain("com.apple.developer.game-center");
      expect(readFileSync(join(dir, "a", "App.xcodeproj", "project.pbxproj"), "utf8")).toContain("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;");
      createIosProject({ ...base, dir: join(dir, "b") });
      expect(readFileSync(join(dir, "b", "App", "App.swift"), "utf8")).not.toContain("GameKit");
      expect(existsSync(join(dir, "b", "App", "App.entitlements"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Android: Play Games の口は対応のある実績だけ送り、ラムダを使わない。マニフェストに APP_ID、課金の無いときは課金の権限を足さない", () => {
    const java = playGamesBridgeJava("com.example.game", { star: "CgkIabc" });
    expect(java).toContain('IDS.put("star", "CgkIabc");');
    expect(java).toContain("PlayGamesSdk.initialize(activity)");
    expect(java).toContain(".unlock(key)");
    expect(java).toContain(".setSteps(key, steps)");
    expect(java).not.toMatch(/\)\s*->/);
    expect(mainActivity("com.example.game", false, true)).toContain('web.addJavascriptInterface(new AchievementsBridge(this), "LiminaliaAchievements");');
    expect(mainActivity("com.example.game")).not.toContain("AchievementsBridge");
    expect(manifest({ title: "G", icon: null, landscape: true }, "com.example.game", null, { playGames: true })).toContain('android:name="com.google.android.gms.games.APP_ID" android:value="@string/game_services_project_id"');
    expect(playGamesValuesXml("1234567890")).toContain('<string name="game_services_project_id" translatable="false">1234567890</string>');
    expect(mergeLibraryManifests([], "com.example.game", { billing: false }).outside).toEqual([]);
    expect(playGamesProblems({ appId: "abc", achievements: {}, libraries: [] })).toHaveLength(2);
    expect(playGamesProblems({ appId: "123", achievements: {}, libraries: ["a.aar"] })).toEqual([]);
  });
});

/** Play Games Services v2 と Tasks の、口が使う API と同じ形の差し替え（実機では本物の AAR を使う）。 */
const STUBS: Record<string, string> = {
  "com/google/android/gms/tasks/OnCompleteListener.java": "package com.google.android.gms.tasks;\npublic interface OnCompleteListener<T> { void onComplete(Task<T> task); }\n",
  "com/google/android/gms/tasks/Task.java": "package com.google.android.gms.tasks;\npublic abstract class Task<T> { public abstract Task<T> addOnCompleteListener(OnCompleteListener<T> l); public abstract boolean isSuccessful(); public abstract T getResult(); }\n",
  "com/google/android/gms/games/AuthenticationResult.java": "package com.google.android.gms.games;\npublic class AuthenticationResult { public boolean isAuthenticated() { return false; } }\n",
  "com/google/android/gms/games/GamesSignInClient.java": "package com.google.android.gms.games;\nimport com.google.android.gms.tasks.Task;\npublic interface GamesSignInClient { Task<AuthenticationResult> isAuthenticated(); Task<AuthenticationResult> signIn(); }\n",
  "com/google/android/gms/games/AchievementsClient.java": "package com.google.android.gms.games;\npublic interface AchievementsClient { void unlock(String id); void setSteps(String id, int steps); }\n",
  "com/google/android/gms/games/PlayGames.java": "package com.google.android.gms.games;\npublic final class PlayGames { public static GamesSignInClient getGamesSignInClient(android.app.Activity a) { return null; } public static AchievementsClient getAchievementsClient(android.app.Activity a) { return null; } }\n",
  "com/google/android/gms/games/PlayGamesSdk.java": "package com.google.android.gms.games;\npublic final class PlayGamesSdk { public static void initialize(android.content.Context c) {} }\n",
};

describe.skipIf(!build)("スマホの実績の包みのビルド", { timeout: 600_000 }, () => {
  it("Android: Play Games の口と、資源を持つライブラリ（R を作り、meta-data が資源を読む）を組み込んだ APK を作る", () => {
    const tools = findAndroidTools();
    const javac = join(tools.java, "bin", "javac");
    const jar = join(tools.java, "bin", "jar");
    const androidJar = join(tools.platform, "android.jar");
    const dir = mkdtempSync(join(tmpdir(), "liminalia-android-games-"));
    try {
      // 1. Play Games の差し替えの JAR
      const stubSrc = join(dir, "stub-src");
      for (const [path, text] of Object.entries(STUBS)) {
        mkdirSync(join(stubSrc, path, ".."), { recursive: true });
        writeFileSync(join(stubSrc, path), text);
      }
      const stubClasses = join(dir, "stub-classes");
      mkdirSync(stubClasses);
      execFileSync(javac, ["-source", "8", "-target", "8", "-nowarn", "-Xlint:-options", "-bootclasspath", androidJar, "-d", stubClasses, ...Object.keys(STUBS).map((p) => join(stubSrc, p))]);
      const stubJar = join(dir, "play-games-stub.jar");
      execFileSync(jar, ["cf", stubJar, "-C", stubClasses, "."]);
      // 2. 資源を持つ AAR（play-services-basement の google_play_services_version と同じ形。クラスはその R を読む）
      const aarDir = join(dir, "aar");
      mkdirSync(join(aarDir, "res", "values"), { recursive: true });
      writeFileSync(join(aarDir, "res", "values", "values.xml"), '<?xml version="1.0" encoding="utf-8"?>\n<resources><integer name="lib_version">12451000</integer></resources>\n');
      writeFileSync(join(aarDir, "AndroidManifest.xml"), '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.lib"><application><meta-data android:name="com.example.lib.version" android:value="@integer/lib_version" /></application></manifest>\n');
      const libSrc = join(dir, "lib-src", "com", "example", "lib");
      mkdirSync(libSrc, { recursive: true });
      writeFileSync(join(libSrc, "R.java"), "package com.example.lib;\npublic final class R { public static final class integer { public static int lib_version; } }\n");
      writeFileSync(join(libSrc, "Uses.java"), "package com.example.lib;\npublic final class Uses { public static int id() { return R.integer.lib_version; } }\n");
      const libClasses = join(dir, "lib-classes");
      mkdirSync(libClasses);
      execFileSync(javac, ["-source", "8", "-target", "8", "-nowarn", "-Xlint:-options", "-bootclasspath", androidJar, "-d", libClasses, join(libSrc, "R.java"), join(libSrc, "Uses.java")]);
      // ライブラリの classes.jar に R は入れない（アプリを組み立てるときに作る）
      rmSync(join(libClasses, "com", "example", "lib", "R.class"));
      rmSync(join(libClasses, "com", "example", "lib", "R$integer.class"));
      execFileSync(jar, ["cf", join(aarDir, "classes.jar"), "-C", libClasses, "."]);
      const aar = join(dir, "lib.aar");
      execFileSync("zip", ["-q", "-r", aar, "classes.jar", "AndroidManifest.xml", "res"], { cwd: aarDir });
      // 3. アプリ
      const web = join(dir, "web");
      mkdirSync(web);
      writeFileSync(join(web, "index.html"), "<!doctype html><title>G</title>");
      const work = join(dir, "work");
      const out = join(dir, "out", "game.apk");
      buildAndroid({ web, work, out, appId: "com.example.game", title: "G", version: "1.0.0", versionCode: 1, landscape: true, icon: null, playGames: { appId: "1234567890", achievements: { star: "CgkIabc" }, libraries: [stubJar, aar] }, targetSdk: Math.min(PLAY_TARGET_SDK, Math.max(...androidPlatforms(tools.sdk).keys())) });
      expect(existsSync(out)).toBe(true);
      // ライブラリの R を作り、アプリの口と一緒に組み立てた
      expect(existsSync(join(work, "android", "gen", "com", "example", "lib", "R.java"))).toBe(true);
      expect(readdirSync(join(work, "android", "classes", "com", "example", "game"))).toContain("AchievementsBridge.class");
      const badging = execFileSync(join(tools.buildTools, "aapt2"), ["dump", "xmltree", "--file", "AndroidManifest.xml", out]).toString();
      expect(badging).toContain("com.google.android.gms.games.APP_ID");
      expect(badging).toContain("com.example.lib.version");
      expect(badging).not.toContain("com.android.vending.BILLING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("iOS: Game Center とアプリ内課金の口を入れたプロジェクトを、シミュレータ用にビルドする", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-ios-games-build-"));
    try {
      mkdirSync(join(dir, "web"));
      writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>G</title>");
      const project = createIosProject({ web: join(dir, "web"), dir: join(dir, "proj"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null, products: ["com.example.full"], gameCenter: { achievements: { star: "com.example.star" } } });
      const app = buildIosSimulator(project, join(dir, "build"));
      expect(existsSync(app)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
