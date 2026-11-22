import { describe, expect, it } from "vitest";
import { buildFlow, buildStoryMap, CORE_COMMANDS, createRegistry, lineIdKey, parse, plainText, translationKey, type Script } from "@liminalia/lang";
import { localizeFlow } from "../src/system/flowchart.ts";
import { setUiLanguage, TEXT, translatedUi } from "../src/system/strings.ts";
import { createTranslator } from "../src/system/translation.ts";
import { uiStringTable } from "../src/system/ui-strings.ts";

describe("訳の口: 固定の行 ID とシステム画面の文言", () => {
  it("ID のある行は ID の鍵で引き、無ければ原文の鍵で引く（ID を振ったあと、まだ合わせていない訳）", () => {
    const tr = createTranslator({
      language: "fr",
      lines: {
        [lineIdKey("a", "line", "g1")]: { source: "「おはよう！」", text: "« Bonjour ! »" },
        [translationKey("a", "line", "「またね」")]: { source: "「またね」", text: "« À plus »" },
        [lineIdKey("a", "option", "c1")]: { source: "行く", text: "Y aller" },
      },
    });
    expect(plainText(tr.line("a", "「おはよう」", undefined, "g1")!)).toBe("« Bonjour ! »");
    expect(plainText(tr.line("a", "「またね」", undefined, "g2")!)).toBe("« À plus »");
    expect(tr.line("a", "「おはよう！」")).toBeNull();
    expect(plainText(tr.option("a", "行く", undefined, "c1")!)).toBe("Y aller");
  });

  it("訳のファイルの ui は、原文を添えた形も読み、訳が空の鍵は英語のまま", () => {
    expect(translatedUi({ "title.start": { source: "New Game", text: "Nouvelle partie" }, "title.continue": { source: "Continue", text: "" }, "title.config": "Réglages" })).toEqual({ "title.start": "Nouvelle partie", "title.config": "Réglages" });
    setUiLanguage("fr", translatedUi({ "title.start": { source: "New Game", text: "Nouvelle partie" }, "title.continue": { source: "Continue", text: "" } }));
    expect([TEXT.title.start, TEXT.title.continue]).toEqual(["Nouvelle partie", "Continue"]);
    setUiLanguage("ja");
  });

  it("上書きできるシステム画面の文言の表は、英語の文字の項目すべて（関数の項目は入れない）", () => {
    const table = uiStringTable();
    expect(table).toContainEqual({ key: "title.start", source: "New Game" });
    expect(table.some((t) => t.key === "extra.rate")).toBe(false);
    expect(new Set(table.map((t) => t.key)).size).toBe(table.length);
  });

  it("フローチャートの場面の題と選択肢も、行 ID で訳を引く", () => {
    const text = "ユイ「丘へ行こう」 #line:t1\n@choice\n- 右へ -> #r #line:c1\n@end\n# r\n右の道。\n";
    const scripts = new Map<string, Script>([["a", parse(text, "a", { speakers: ["ユイ"] })]]);
    const flow = buildFlow(buildStoryMap({ scripts: new Map([["a", { script: scripts.get("a")!, text }]]), registry: createRegistry(CORE_COMMANDS), entry: "a", hooks: new Map(), data: () => undefined }), scripts);
    const tr = createTranslator({ language: "fr", speakers: { ユイ: "Yui" }, lines: { "a:l@t1": { source: "「丘へ行こう」", text: "« Allons-y »" }, "a:c@c1": { source: "右へ", text: "À droite" } } });
    const shown = localizeFlow(flow, tr);
    expect(shown.scenes.find((s) => s.id === "a")!.title).toBe("Yui« Allons-y »");
    expect(shown.links.find((l) => l.choice)!.choice).toBe("À droite");
  });
});
