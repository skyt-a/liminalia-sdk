import { describe, expect, it } from "vitest";
import { check, COMMAND_GROUPS, COMMAND_META, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { previewsWithoutMeta } from "../../lang/src/command-meta.ts";
import { combinePlugins } from "@liminalia/sdk";
import std from "../src/commands/index.ts";

/** 組み込みの命令の情報（lang の command-meta.ts）が、組み込みと標準の命令と食い違っていないか。 */

const { specs } = combinePlugins([std]);
const registry = createRegistry([...CORE_COMMANDS, ...specs]);
const castEntries = { ユイ: { defaultAppearance: "default", appearances: { default: { variants: { normal: { image: "yui.png" } } } } } };

describe("命令の情報", () => {
  it("見本だけあって表に無い命令は無い", () => {
    expect(previewsWithoutMeta()).toEqual([]);
  });

  it("載せた命令はどれも実在する", () => {
    const missing = Object.keys(COMMAND_META).filter((name) => !registry.has(name) && !["choice", "if", "while", "with", "content", "define", "use", "set", "jump", "call", "return"].includes(name));
    expect(missing).toEqual([]);
  });

  it("小分けはその命令の区切りのもので、組み込みと標準の命令はどれも小分けを持つ（流れの書き方は除く）", () => {
    const wrong = Object.entries(COMMAND_META).filter(([, m]) => m.group && !COMMAND_GROUPS[m.category].includes(m.group)).map(([n, m]) => `${n}: ${m.category}/${m.group}`);
    expect(wrong).toEqual([]);
    const missing = [...registry.keys()].filter((n) => COMMAND_META[n] && !COMMAND_META[n]!.group && COMMAND_META[n]!.category !== "flow");
    expect(missing).toEqual([]);
  });

  it("見本の行は、背景と人物を当てはめれば検査を通る", () => {
    for (const [name, meta] of Object.entries(COMMAND_META)) {
      if (!meta.preview) continue;
      const fill = (l: string) =>
        l
          .replaceAll("{bg}", "a.png")
          .replaceAll("{bg2}", "b.png")
          .replaceAll("{who}", "ユイ")
          .replaceAll("{speaker}", "ユイ")
          .replaceAll("{bgm}", "m.ogg")
          .replaceAll("{se}", "s.ogg")
          .replaceAll("{voice}", "v.ogg");
      const lines = [...meta.preview.lines, ...(meta.preview.reset ?? [])].map(fill);
      expect(lines.join("\n")).not.toMatch(/\{[a-z0-9]+\}/);
      const errors = check(parse(lines.join("\n"), "t.lim", { speakers: ["ユイ"] }), { registry, castEntries, speakers: ["ユイ"] }).filter((d) => d.severity === "error");
      expect([name, errors.map((d) => `${d.code} ${d.message}`)]).toEqual([name, []]);
    }
  });
});
