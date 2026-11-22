import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIosProject } from "../src/mobile/ios.ts";
import { collectedSummary, privacyManifest } from "../src/mobile/privacy.ts";

/** ストアへの申告（iOS のプライバシーマニフェストと、書き出しの経過の一行）。docs/distribution.md の「ストアへの申告」。 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-store-privacy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const none = { crashReport: false, analytics: false, feedback: false };

describe("プライバシーマニフェスト", () => {
  it("送り先を書いていなければ、追跡せず、集める情報も理由の要る API も無い", () => {
    const xml = privacyManifest(none);
    expect(xml).toContain("<key>NSPrivacyTracking</key>\n\t<false/>");
    expect(xml).toContain("<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>");
    expect(xml).toContain("<key>NSPrivacyAccessedAPITypes</key>\n\t<array/>");
    expect(collectedSummary(none)).toBe("ストアへの申告: 集める情報なし");
  });

  it("止まったときの記録と遊ばれ方の統計は、人に結び付けず追跡に使わない収集として書く", () => {
    const xml = privacyManifest({ crashReport: true, analytics: true, feedback: false });
    expect(xml).toContain("<string>NSPrivacyCollectedDataTypeCrashData</string>");
    expect(xml).toContain("<string>NSPrivacyCollectedDataTypeProductInteraction</string>");
    expect(xml).toContain("<string>NSPrivacyCollectedDataTypePurposeAnalytics</string>");
    expect(xml).not.toContain("NSPrivacyCollectedDataTypeOtherUserContent");
    expect(xml.match(/<key>NSPrivacyCollectedDataTypeLinked<\/key>\n\t\t\t<false\/>/g)).toHaveLength(2);
    expect(collectedSummary({ crashReport: true, analytics: true, feedback: false })).toBe("ストアへの申告: 集める情報 build.crashReport、build.analytics");
  });

  it.runIf(process.platform === "darwin")("plutil が読める plist", () => {
    const file = join(dir, "PrivacyInfo.xcprivacy");
    writeFileSync(file, privacyManifest({ crashReport: true, analytics: true, feedback: true }));
    const r = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    expect(r.stdout).toContain("OK");
  });

  it("iOS 版のプロジェクトに入れ、Resources に載せる", () => {
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>G</title>");
    const project = createIosProject({ web: join(dir, "web"), dir: join(dir, "proj"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null, privacy: privacyManifest(none) });
    expect(readFileSync(join(dir, "proj", "App", "PrivacyInfo.xcprivacy"), "utf8")).toContain("NSPrivacyTracking");
    const pbx = readFileSync(join(project, "project.pbxproj"), "utf8");
    expect(pbx).toContain("/* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile;");
    expect(pbx.match(/PrivacyInfo\.xcprivacy in Resources \*\/,/g)).toHaveLength(1);
    // iOS 版のアプリの部分は、理由の申告が要る API を使わない（使うなら privacyManifest の NSPrivacyAccessedAPITypes に足す）
    const swift = readFileSync(join(dir, "proj", "App", "App.swift"), "utf8");
    expect(swift).not.toMatch(/UserDefaults|creationDate|modificationDate|systemUptime|mach_absolute_time|volumeAvailableCapacity|activeInputModes/);
    // 渡さなければ入れない（前と同じ）
    const plain = createIosProject({ web: join(dir, "web"), dir: join(dir, "plain"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null });
    expect(readFileSync(join(plain, "project.pbxproj"), "utf8")).not.toContain("PrivacyInfo");
  });
});
