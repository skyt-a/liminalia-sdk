import { describe, expect, it } from "vitest";
import {
  CHOICE_BLOCK,
  CHOICE_EN,
  CHOICE_OPTION,
  CORE_COMMANDS,
  CORE_COMMANDS_EN,
  FUNCTION_ARITY,
  commandExample,
  FUNCTION_DOCS_EN,
  FUNCTION_USAGE,
  FUNCTION_USAGE_EN,
  commandSummary,
  englishGaps,
  paramDoc,
  withEnglish,
} from "../src/index.ts";

const JAPANESE = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;


describe("組み込みのコマンドの英語", () => {
  it("どのコマンドにも英語の要約、パラメータの説明、やりたいことの言葉があり、英語で読む例に日本語が残らない", () => {
    expect(englishGaps([...CORE_COMMANDS, CHOICE_OPTION, CHOICE_BLOCK])).toEqual([]);
    for (const c of [...CORE_COMMANDS, CHOICE_OPTION, CHOICE_BLOCK]) expect(JAPANESE.test(commandExample(c, true)), c.name).toBe(false);
    expect(CORE_COMMANDS.find((c) => c.name === "chara")!.exampleEn).toBe("@chara Akari smile at=left time=300ms");
    expect(CHOICE_OPTION.exampleEn).toMatch(/^- Examine the door -> #door /);
  });

  it("例に日本語があるのに英語の例が無いもの、英語の例に日本語が混ざるものを englishGaps が拾う", () => {
    const base = { summary: "要約", summaryEn: "Summary", positional: [], params: {} };
    expect(englishGaps([{ ...base, name: "a", example: "@a ユイ" }])).toEqual(["a exampleEn: 例に日本語があるのに英語の例が無い（@a ユイ）"]);
    expect(englishGaps([{ ...base, name: "b", example: "@b ユイ", exampleEn: "@b 夜" }])).toEqual(["b exampleEn: 英語の例に日本語が混ざる（@b 夜）"]);
    expect(englishGaps([{ ...base, name: "c", example: "@c ユイ", exampleEn: "@c Yui" }, { ...base, name: "d", example: "@d 30ms" }])).toEqual([]);
  });

  it("英語の表に、無いコマンドや無いパラメータを書いていない", () => {
    const stale: string[] = [];
    for (const [name, en] of Object.entries(CORE_COMMANDS_EN)) {
      const spec = CORE_COMMANDS.find((c) => c.name === name);
      if (!spec) stale.push(name);
      else for (const p of Object.keys(en.params ?? {})) if (!spec.params[p]) stale.push(`${name}.${p}`);
    }
    for (const [key, spec] of [["option", CHOICE_OPTION], ["block", CHOICE_BLOCK]] as const) {
      for (const p of Object.keys(CHOICE_EN[key].params ?? {})) if (!spec.params[p]) stale.push(`choice ${key}.${p}`);
    }
    expect(stale).toEqual([]);
  });

  it("英語が無いときは日本語を出す", () => {
    const spec = { summary: "日本語", summaryEn: "English" };
    expect(commandSummary(spec, true)).toBe("English");
    expect(commandSummary(spec, false)).toBe("日本語");
    expect(commandSummary({ summary: "日本語" }, true)).toBe("日本語");
    expect(paramDoc({ doc: "説明" }, true)).toBe("説明");
    expect(paramDoc({ doc: "説明", docEn: "About" }, true)).toBe("About");
    expect(commandExample({ example: "@chara ユイ", exampleEn: "@chara Yui" }, true)).toBe("@chara Yui");
    expect(commandExample({ example: "@chara ユイ", exampleEn: "@chara Yui" }, false)).toBe("@chara ユイ");
    expect(commandExample({ example: "@wait 1s" }, true)).toBe("@wait 1s");
  });

  it("withEnglish は表の英語を先にし、表に無いパラメータは定義に書いた英語のまま", () => {
    const [c] = withEnglish([{ name: "x", summary: "要約", params: { a: { doc: "あ", docEn: "A (own)" }, b: { doc: "い", docEn: "B (own)" } } }], {
      x: { summary: "Summary", params: { a: "A (table)" }, keywords: ["word"], example: "@x Yui" },
    });
    expect(c).toMatchObject({ summaryEn: "Summary", keywordsEn: ["word"], exampleEn: "@x Yui", params: { a: { docEn: "A (table)" }, b: { docEn: "B (own)" } } });
    expect(withEnglish([{ name: "y", summary: "要約", params: {} }], {})[0]).not.toHaveProperty("summaryEn");
    // 表に例が無ければ、定義に書いた英語の例のまま
    expect(withEnglish([{ name: "z", summary: "要約", exampleEn: "@z own", params: {} }], { z: { summary: "Z" } })[0]!.exampleEn).toBe("@z own");
    expect(withEnglish([{ name: "z", summary: "要約", params: {} }], { z: { summary: "Z" } })[0]).not.toHaveProperty("exampleEn");
  });
});

describe("式の関数の英語", () => {
  it("どの関数にも英語の説明と書き方があり、書き方は日本語と同じ数", () => {
    for (const name of Object.keys(FUNCTION_ARITY)) {
      const doc = FUNCTION_DOCS_EN[name];
      expect(doc, name).toBeTruthy();
      expect(JAPANESE.test(doc!), name).toBe(false);
      const usage = FUNCTION_USAGE_EN[name];
      expect(usage?.length, name).toBe(FUNCTION_USAGE[name]?.length);
      for (const u of usage!) {
        expect(u.startsWith(`${name}(`), u).toBe(true);
        expect(JAPANESE.test(u), u).toBe(false);
      }
    }
    expect(Object.keys(FUNCTION_DOCS_EN).sort()).toEqual(Object.keys(FUNCTION_ARITY).sort());
    expect(Object.keys(FUNCTION_USAGE_EN).sort()).toEqual(Object.keys(FUNCTION_ARITY).sort());
  });
});

describe("@chara の replace の説明（2026-11-19 の X2）", () => {
  it("実行器が受け付ける入れ替え先の名前（left、center、right、枠の positions、autoLayout の positions、byCount の読み替え先）を日本語と英語で挙げる", () => {
    const replace = CORE_COMMANDS.find((c) => c.name === "chara")!.params.replace!;
    for (const en of [false, true]) {
      const doc = paramDoc(replace, en);
      for (const word of ["left", "center", "right", "frame", "positions", "autoLayout", "byCount"]) expect(doc, `${en ? "en" : "ja"}: ${word}`).toContain(word);
    }
    expect(paramDoc(replace, false)).not.toContain("・");
  });
});
