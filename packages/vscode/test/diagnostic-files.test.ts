import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticFilePath } from "../src/diagnostic-files.ts";

const root = "/work/game";
const info = {
  root,
  configFile: join(root, "liminalia.json"),
  paths: { scenario: join(root, "scenario"), assets: join(root, "assets"), data: join(root, "data"), cast: join(root, "cast.json"), lang: join(root, "lang"), voiceLock: join(root, "voice-lock.json") },
};

describe("シナリオでない診断を出すファイル", () => {
  it("設定、キャスト、訳、ボイスの番号の固定、作品のデータ", () => {
    expect(diagnosticFilePath("liminalia.json", info)).toBe(info.configFile);
    expect(diagnosticFilePath("cast.json", info)).toBe(info.paths.cast);
    expect(diagnosticFilePath("voice-lock.json", info)).toBe(info.paths.voiceLock);
    expect(diagnosticFilePath("lang/en.json", info)).toBe(join(root, "lang", "en.json"));
    expect(diagnosticFilePath("story/items.json", info, { dataFolder: "story" })).toBe(join(root, "data", "items.json"));
  });

  it("作品の CSS、画面のテンプレート、その画面の JS（template-script-export などの診断）", () => {
    expect(diagnosticFilePath("ui/screens.css", info)).toBe(join(root, "ui", "screens.css"));
    expect(diagnosticFilePath("ui/screens/confirm/confirm.html", info)).toBe(join(root, "ui", "screens", "confirm", "confirm.html"));
    expect(diagnosticFilePath("ui/screens/confirm/confirm.js", info)).toBe(join(root, "ui", "screens", "confirm", "confirm.js"));
  });

  it("分からないものは出さない", () => {
    expect(diagnosticFilePath("somewhere", info)).toBeNull();
  });
});
