import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "@liminalia/lang";
import { loadProject, stdWebFeatures, stdWebFeaturesOf } from "../src/index.ts";

/**
 * 書き出しで始めに読む標準の命令の描画の部品（stdWebFeatures）。作品が使う道をすべて拾うこと:
 * 台本の行の命令、本文と選択肢の中の命令、@if と @define の中、プラグインのコードに書いた命令の名前、ui.chat.dialogue、
 * data/codex.json（図鑑はメニュー、おまけ、@open-screen codex から開く）。下書きの台本とプラグインのテストは見ない。
 */

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("作品が使う標準の命令の描画の部品", () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-std-features-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("台本、プラグイン、設定、データから拾い、使わない部品は入れない", () => {
    write(join(dir, "liminalia.json"), JSON.stringify({ id: "t", title: "t", entry: "start", plugins: ["./plugins/storm"] }));
    // 行の命令（粒子）、本文の中の命令（光る: oneshot）、選択肢の中の命令（集中線: manga）、@if の中（常駐の表示: hud）、@define の中（画面効果: effect）
    write(
      join(dir, "scenario", "start.lim"),
      [
        "@particles snow",
        "雪が降る。{@flash color=#ffffff}光った。",
        "@choice",
        "- 走る{@speedlines focus} -> #run",
        "- 待つ -> #run",
        "@end",
        "# run",
        "@if (game.night)",
        '  @hud-text clock text="夜"',
        "@end",
        "@define storm()",
        "  @effect ripple",
        "@end",
      ].join("\n"),
    );
    // 下書きは書き出さないので見ない
    write(join(dir, "scenario", "draft.lim"), "// lim: draft\n@staff-roll credits.txt\n");
    // 図鑑のデータ（メニュー、おまけ、@open-screen codex から開く）
    write(join(dir, "data", "codex.json"), JSON.stringify({ entries: [] }));
    // プラグインが描画側から名前で描かせる命令（章の扉）。入口（"./web"）から import でたどれるコードだけを見る
    // （テストや、入口から読まないファイルは書き出しに入らないので見ない）
    write(join(dir, "plugins", "storm", "package.json"), JSON.stringify({ name: "storm", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    write(join(dir, "plugins", "storm", "src", "web.ts"), 'import { card } from "./card.js";\nexport default { name: "storm", setup(host) { card(host); } };\n');
    write(join(dir, "plugins", "storm", "src", "card.ts"), 'export const card = (host) => void host.present({ type: "command", name: "chapter-card", args: {}, wait: false, stage: host.stageNow });\n');
    write(join(dir, "plugins", "storm", "src", "unused.ts"), 'export const name = "map-choice";\n');
    write(join(dir, "plugins", "storm", "test", "web.test.ts"), 'const name = "investigate";\n');
    const project = loadProject(dir);
    expect(stdWebFeatures(project)).toEqual(["chapter", "codex", "effect", "hud", "manga", "oneshot", "particles"]);
  });

  it("本文をチャットに積む作品（ui.chat.dialogue。言語ごとの ui.languages も）はチャットを読む。何も使わなければ空", () => {
    const empty = mkdtempSync(join(tmpdir(), "liminalia-std-features-empty-"));
    try {
      const scripts = [parse("@bg hill.png\n本文。\n", "a")];
      expect(stdWebFeaturesOf({ scripts, dataDir: join(empty, "data"), plugins: [] })).toEqual([]);
      expect(stdWebFeaturesOf({ scripts, ui: { chat: { dialogue: true } }, dataDir: join(empty, "data"), plugins: [] })).toEqual(["chat"]);
      expect(stdWebFeaturesOf({ scripts, ui: { languages: { en: { chat: { dialogue: true } } } }, dataDir: join(empty, "data"), plugins: [] })).toEqual(["chat"]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
