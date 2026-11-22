import { describe, expect, it } from "vitest";
import { buildFlow, buildStoryMap, collectTranslatable, CORE_COMMANDS, createRegistry, parse, type Script, type TranslationFile } from "@liminalia/lang";
import { localizeFlow } from "../src/system/flowchart.ts";
import { createTranslator } from "../src/system/translation.ts";

/** フローチャートの場面の題と選択肢の文を、訳のファイルの文で出す（訳を引く元は flow.json に入れておく）。 */

const speakers = ["ユイ"];
const TEXT = "ユイ「{r 丘|おか}へ行こう」\n@choice\n- 右へ -> #r\n- 左へ -> #l\n@end\n# r\n右の道。\n# l\n左の道。\n";

function flowOf(text: string) {
  const scripts = new Map<string, Script>([["a", parse(text, "a", { speakers })]]);
  const registry = createRegistry(CORE_COMMANDS);
  const flow = buildFlow(buildStoryMap({ scripts: new Map([["a", { script: scripts.get("a")!, text }]]), registry, entry: "a", hooks: new Map(), data: () => undefined }), scripts);
  return { flow, items: collectTranslatable(scripts.get("a")!, registry) };
}

describe("フローチャートの訳", () => {
  it("場面の題と選択肢の文に、訳のファイルの鍵と同じ元を持たせる", () => {
    const { flow, items } = flowOf(TEXT);
    const keys = new Set(items.map((t) => `${t.kind}:${t.source}`));
    const head = flow.scenes.find((s) => s.id === "a")!;
    expect(head.titleKey).toEqual({ file: "a", source: "「{r 丘|おか}へ行こう」", speaker: "ユイ" });
    expect(keys.has(`line:${head.titleKey!.source}`)).toBe(true);
    expect(flow.scenes.find((s) => s.id === "a#r")!.titleKey).toEqual({ file: "a", source: "右の道。", context: "r" });
    const choices = flow.links.filter((l) => l.choice).map((l) => l.choiceKey);
    expect(choices).toEqual([
      { file: "a", source: "右へ" },
      { file: "a", source: "左へ" },
    ]);
    for (const c of choices) expect(keys.has(`option:${c!.source}`)).toBe(true);
  });

  it("訳があれば題（話者名も訳す）と選択肢の文を訳に替え、無いものは原文のまま", () => {
    const { flow, items } = flowOf(TEXT);
    const words: Record<string, string> = { "「{r 丘|おか}へ行こう」": "“To the {r hill|おか}”", 右へ: "Right", "右の道。": "The right path." };
    const file: TranslationFile = { language: "en", speakers: { ユイ: "Yui" }, lines: Object.fromEntries(items.map((t) => [t.key, { source: t.source, text: words[t.source] ?? "" }])) };
    const shown = localizeFlow(flow, createTranslator(file));
    expect(shown.scenes.map((s) => s.title)).toEqual(["Yui“To the hill”", "The right path.", "左の道。"]);
    expect(shown.links.filter((l) => l.choice).map((l) => l.choice)).toEqual(["Right", "左へ"]);
    // 訳が無ければ（原文の言語）そのまま
    expect(localizeFlow(flow, null)).toBe(flow);
  });

  it("訳を引く元の無い古い flow.json は原文のまま出す", () => {
    const { flow } = flowOf(TEXT);
    const old = { ...flow, scenes: flow.scenes.map(({ titleKey: _k, ...s }) => s), links: flow.links.map(({ choiceKey: _k, ...l }) => l) };
    const shown = localizeFlow(old, createTranslator({ language: "en", lines: {} }));
    expect(shown.scenes.map((s) => s.title)).toEqual(flow.scenes.map((s) => s.title));
  });
});
