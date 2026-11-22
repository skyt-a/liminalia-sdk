import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, type CommandSpec } from "@liminalia/lang";
import { combineImportProfiles, convert, mechanicalConversion, resolveImportProfile, toProfile, type TagMapping, type TyranoImportProfile } from "../src/index.ts";

/** 変換表（TagMapping）と取り込み設定の重ね方。命令の仕様は registry から引く。 */

const stamp: CommandSpec = {
  name: "stamp",
  summary: "スタンプ",
  positional: ["image"],
  params: {
    image: { type: { kind: "asset", folder: "image" }, required: true, doc: "画像" },
    x: { type: { kind: "number" }, default: "640", doc: "横" },
    "fade-in": { type: { kind: "duration" }, default: "0ms", doc: "出す時間" },
    secret: { type: { kind: "string" }, doc: ".ks に対応なし" },
  },
  example: "@stamp a.png",
};
const registry = createRegistry(CORE_COMMANDS, [stamp]);
const lim = (ks: string, profile: TyranoImportProfile) => {
  const { tags, scriptProfile } = resolveImportProfile(profile, registry);
  return convert(ks, "t.ks", { profile: tags, scriptProfile });
};
const text = (ks: string, profile: TyranoImportProfile) => lim(ks, profile).text;

describe("変換表", () => {
  const base: TagMapping = { command: "stamp", tags: ["stamp_show"], params: { image: "storage", secret: null } };

  it("引数名は params で対応を書き、省いた引数は - を _ にした名前、既定値と同じ値は書かない", () => {
    expect(text('[stamp_show storage="a.png" x="640" fade_in="500" secret="s"]', { mappings: [base] })).toBe("@stamp a.png fade-in=500ms\n");
    expect(lim('[stamp_show storage="a.png" secret="s"]', { mappings: [base] }).diagnostics.map((d) => d.message)).toEqual(["[stamp_show] secret=s は変換していません"]);
    expect(lim('[stamp_show storage="a.png" page="fore"]', { mappings: [{ ...base, ignore: ["page"] }] }).diagnostics).toEqual([]);
  });

  it("mechanicalConversion は仕様と対応から機械的に変換する", () => {
    expect(mechanicalConversion(stamp, { storage: "a.png", x: "10" }, { params: { image: "storage" } })).toEqual({ name: "stamp", positional: ["a.png"], named: [["x", "10", "640"]] });
    expect(mechanicalConversion(stamp, { x: "10" }).notes).toEqual(["必須の image がありません"]);
  });

  it("convert・defer・swallowStop、ほかの命令の表で変換する convertAs", () => {
    const mappings: TagMapping[] = [
      base,
      {
        command: "stamp",
        tags: ["stamp_center", "stamp_jump"],
        params: { image: "storage" },
        defer: (pm) => pm.skip === "true",
        swallowStop: true,
        convert: (pm, tag, ctx) => (tag === "stamp_center" ? ctx.mechanical({ ...pm, x: "100" }) : ctx.convertAs("stamp", { storage: "b.png" }, "stamp_show")),
      },
    ];
    expect(text('[stamp_center storage="a.png"]\n[s]', { mappings })).toBe("@stamp a.png x=100\n");
    expect(text("[stamp_jump]", { mappings })).toBe("@stamp b.png\n");
    // defer したタグは組み込みの変換（未対応のタグなので汎用の形）に任せる
    expect(text('[stamp_center skip="true"]', { mappings })).toBe("@stamp-center skip=true\n");
  });

  it("変換先の命令が仕様に無ければ、変換表を作るときに知らせる", () => {
    expect(() => toProfile([{ command: "nothing", tags: ["x"] }], registry)).toThrow("@nothing が命令の仕様にありません");
  });
});

describe("取り込み設定の重ね方", () => {
  it("同じタグは 変換表 → 扱わないタグ → tags の順に後が勝ち、変換表どうしは後のものが勝つ", () => {
    const profile = combineImportProfiles([
      { mappings: [{ command: "stamp", tags: ["a", "b", "c"], params: { image: "storage" } }] },
      { mappings: [{ command: "stamp", tags: ["a"], convert: () => ({ name: "stamp", positional: ["late.png"], named: [] }) }], unsupportedTags: { b: "扱いません" } },
      { tags: { c: () => ({ name: "wait", positional: ["1s"], named: [] }) } },
    ]);
    expect(text("[a]", profile)).toBe("@stamp late.png\n");
    expect(lim("[b]", profile).diagnostics.map((d) => d.message)).toEqual(["[b] 扱いません"]);
    expect(text("[c]", profile)).toBe("@wait 1s\n");
  });

  it("[iscript] は scriptProfile、次に scriptRules を前から試す", () => {
    const profile = combineImportProfiles([
      { scriptRules: [(code) => (code.includes("x") ? ["@wait 1s"] : null)] },
      { scriptProfile: (code) => (code.includes("y") ? ["@wait 2s"] : null) },
    ]);
    expect(text("[iscript]\nx;y;\n[endscript]", profile)).toBe("@wait 2s\n");
    expect(text("[iscript]\nx;\n[endscript]", profile)).toBe("@wait 1s\n");
  });

  it("afterImport はすべて呼び、cast は後のものが勝ち notes はつなげる", async () => {
    const profile = combineImportProfiles([
      { afterImport: () => ({ cast: { a: 1, b: 1 }, notes: ["一"] }) },
      { afterImport: async () => ({ cast: { b: 2 }, notes: ["二"] }) },
      { skipFiles: ["title"] },
    ]);
    expect(profile.skipFiles).toEqual(["title"]);
    expect(await profile.afterImport!({ source: "", scenarioOut: "", dataOut: "", speakers: new Set(), castNames: new Set() })).toEqual({ cast: { a: 1, b: 2 }, notes: ["一", "二"] });
  });
});
