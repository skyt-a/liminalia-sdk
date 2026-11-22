import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { androidPlatforms, assetRangesJava, buildAndroid, findAndroidTools, mainActivity, manifest, PLAY_TARGET_SDK, sharedFilesJava } from "../src/mobile/android.ts";
import { createIosProject } from "../src/mobile/ios.ts";

/** Android の包みが裏へ回ったとき（onPause）にページで動かす JS。 */
function androidLeaveScript(java: string): string {
  const m = /protected void onPause\(\) \{[\s\S]*?web\.evaluateJavascript\("((?:[^"\\]|\\.)*)", null\)/.exec(java);
  return m ? (JSON.parse(`"${m[1]}"`) as string) : "";
}

/** スマホ版のアプリの包みが、ページからファイル（スクリーンショット・セーブデータのエクスポート）を受け取り、共有のシートで渡すこと。 */
describe("スマホ版のファイルを渡す口", () => {
  it("Android: ページの口（LiminaliaFiles）と <a download> を受け、キャッシュに置いて自前の ContentProvider から共有する", () => {
    const java = mainActivity("com.example.game");
    expect(java).toContain('web.addJavascriptInterface(new FilesBridge(), "LiminaliaFiles")');
    expect(java).toContain("public boolean save(String name, String mime, String base64)");
    expect(java).toContain("web.setDownloadListener(");
    // blob: はページで読んで渡してもらい、data: はそのまま
    expect(java).toContain('url.startsWith("blob:")');
    expect(java).toContain('url.startsWith("data:")');
    expect(java).toContain("Intent.createChooser(send, null)");
    expect(java).toContain('"content://" + getPackageName() + ".files/"');
    // インポートの <input type="file">
    expect(java).toContain("onShowFileChooser");
    expect(java).toContain("FileChooserParams.parseResult(result, data)");
    // android.jar だけで組み立てるので、ラムダは使わない
    expect(java).not.toMatch(/\)\s*->/);
    const provider = sharedFilesJava("com.example.game");
    expect(provider).toContain("public class SharedFiles extends ContentProvider");
    expect(provider).toContain("ParcelFileDescriptor.MODE_READ_ONLY");
    expect(provider).toContain('new File(getContext().getCacheDir(), "share")');
    const xml = manifest({ title: "G", icon: null, landscape: true }, "com.example.game");
    expect(xml).toContain('android:name=".SharedFiles"');
    expect(xml).toContain('android:authorities="com.example.game.files"');
    expect(xml).toContain('android:exported="false"');
    expect(xml).toContain('android:grantUriPermissions="true"');
  });

  it("Android: セーブはアプリのファイルに同期で書き、裏へ回ったらオートセーブの書き終わりを onStop で待つ", () => {
    const java = mainActivity("com.example.game");
    expect(java).toContain('web.addJavascriptInterface(new SavesBridge(), "LiminaliaSaves")');
    expect(java).toContain("return saves.set(key, value);");
    // onPause でオートセーブを頼み、済んだら left() で知らせてもらい、onStop で待つ
    expect(androidLeaveScript(java)).toContain("window.LiminaliaSaves.left()");
    expect(java).toMatch(/protected void onStop\(\) \{[\s\S]*?l\.await\(1500, TimeUnit\.MILLISECONDS\)/);
  });

  it("iOS: ページの口（liminaliaFiles）を置き、受け取ったら共有のシートを開く", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-ios-files-"));
    try {
      mkdirSync(join(dir, "web"));
      createIosProject({ web: join(dir, "web"), dir: join(dir, "a"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null });
      const swift = readFileSync(join(dir, "a", "App", "App.swift"), "utf8");
      expect(swift).toContain('config.userContentController.add(files, name: "liminaliaFiles")');
      expect(swift).toContain("UIActivityViewController(activityItems: [file]");
      expect(swift).toContain("Data(base64Encoded: base64)");
      expect(swift).toContain("popoverPresentationController");
      // 裏へ回るときは、オートセーブが IndexedDB に入るまで裏で動かしてもらう
      expect(swift).toContain("func sceneWillResignActive(_ scene: UIScene) { game.leave() }");
      expect(swift).toMatch(/beginBackgroundTask[\s\S]*callAsyncJavaScript\(script[\s\S]*finish\(\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** JDK（javac と java）。無ければ null（Android の部品を動かすテストを飛ばす）。 */
function jdk(): { javac: string; java: string } | null {
  try {
    const tools = findAndroidTools();
    return { javac: join(tools.java, "bin", "javac"), java: join(tools.java, "bin", "java") };
  } catch {
    return null;
  }
}

/** Android 版が素材の範囲の指定（Range）に答えること（長い BGM の流し読みのため）。 */
describe("Android 版の素材の範囲の指定", () => {
  it("素材を返すところが Range を読んで 206 か 416 で答え、ふだんの答えにも Accept-Ranges を付ける", () => {
    const java = mainActivity("com.example.game");
    expect(java).toContain('"range".equalsIgnoreCase(h.getKey())');
    expect(java).toContain('new WebResourceResponse(type, null, 206, "Partial Content", headers, AssetRanges.slice(in, span))');
    expect(java).toContain('new WebResourceResponse(type, null, 416, "Range Not Satisfiable"');
    expect(java).toContain('headers.put("Accept-Ranges", "bytes")');
    // 縮めずに入れた素材は openFd で大きさを知る
    expect(java).toContain("getAssets().openFd(name)");
    const ranges = assetRangesJava("com.example.game");
    expect(ranges).toContain('Pattern.compile("^bytes=(\\\\d*)-(\\\\d*)$")');
    expect(ranges).not.toMatch(/import android\./);
  });

  const tools = jdk();
  // javac と java を起こす
  it.skipIf(!tools)("範囲の部品を JDK で動かすと、指定どおりの見出しと中身を返す", { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-android-ranges-"));
    try {
      const src = join(dir, "src", "com", "example", "game");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "AssetRanges.java"), assetRangesJava("com.example.game"));
      // 0〜99 のバイトを並べた素材で、いくつかの指定を試し、結果を一行ずつ書く
      writeFileSync(
        join(src, "Try.java"),
        `package com.example.game;
import java.io.*;
import java.util.*;
public class Try {
  public static void main(String[] a) throws Exception {
    byte[] data = new byte[100];
    for (int i = 0; i < 100; i++) data[i] = (byte) i;
    for (String h : new String[] { "bytes=0-9", "bytes=95-", "bytes=-5", "bytes=90-200", "bytes=100-", "bytes=0-1,5-6", "items=0-1", "bytes=-0" }) {
      long[] span = AssetRanges.parse(h, data.length);
      if (span == null) { System.out.println(h + " null"); continue; }
      Map<String, String> head = AssetRanges.headers(span, data.length);
      StringBuilder body = new StringBuilder();
      if (span.length > 0) {
        InputStream in = AssetRanges.slice(new ByteArrayInputStream(data), span);
        int c;
        while ((c = in.read()) >= 0) body.append(c).append(' ');
      }
      System.out.println(h + " " + head.get("Content-Range") + " " + head.get("Content-Length") + " " + body.toString().trim());
    }
  }
}
`,
      );
      const classes = join(dir, "classes");
      mkdirSync(classes);
      execFileSync(tools!.javac, ["-nowarn", "-Xlint:-options", "-source", "8", "-target", "8", "-d", classes, join(src, "AssetRanges.java"), join(src, "Try.java")]);
      const out = execFileSync(tools!.java, ["-cp", classes, "com.example.game.Try"]).toString().trim().split("\n").map((l) => l.trimEnd());
      expect(out).toEqual([
        "bytes=0-9 bytes 0-9/100 10 0 1 2 3 4 5 6 7 8 9",
        "bytes=95- bytes 95-99/100 5 95 96 97 98 99",
        "bytes=-5 bytes 95-99/100 5 95 96 97 98 99",
        "bytes=90-200 bytes 90-99/100 10 90 91 92 93 94 95 96 97 98 99",
        "bytes=100- bytes */100 null",
        "bytes=0-1,5-6 null",
        "items=0-1 null",
        "bytes=-0 bytes */100 null",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.LIMINALIA_MOBILE_BUILD !== "1")("範囲の部品を入れた APK を組み立てる", { timeout: 600_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-android-ranges-build-"));
    try {
      const web = join(dir, "web");
      mkdirSync(join(web, "assets", "bgm"), { recursive: true });
      writeFileSync(join(web, "index.html"), "<!doctype html><title>G</title>");
      writeFileSync(join(web, "assets", "bgm", "long.ogg"), Buffer.alloc(2 * 1024 * 1024));
      const work = join(dir, "work");
      const out = join(dir, "out", "game.apk");
      // 手元の SDK に Google Play の下限の版が無ければ、入っている版で組み立てる
      const targetSdk = Math.min(PLAY_TARGET_SDK, Math.max(...androidPlatforms(findAndroidTools().sdk).keys()));
      buildAndroid({ web, work, out, appId: "com.example.game", title: "G", version: "1.0.0", versionCode: 1, landscape: true, icon: null, targetSdk });
      expect(existsSync(out)).toBe(true);
      expect(readdirSync(join(work, "android", "classes", "com", "example", "game"))).toContain("AssetRanges.class");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
