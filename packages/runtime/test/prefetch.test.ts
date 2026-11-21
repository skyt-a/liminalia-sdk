import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { buildProgram, collectPrefetch, HeadlessHost, Runtime, type PrefetchItem } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const unitOf = (src: string) => buildProgram(parse(src, "a", { speakers: ["ユイ"] })).main;

describe("素材の先読み", () => {
  it("この先の背景・立ち絵・音を、分岐の両側と本文中の命令も含めて集める", () => {
    const unit = unitOf(
      [
        "一",
        "@bg room.jpg",
        "@if game.x",
        "@chara ユイカ smile appearance=winter",
        "@else",
        "@bgm night.ogg",
        "@end",
        "ユイ「{@se bell.wav}やあ」",
        "@bg (temp.next)",
      ].join("\n"),
    );
    expect(collectPrefetch(unit, 0, registry)).toEqual([
      { kind: "asset", folder: "bgimage", path: "room.jpg" },
      { kind: "sprite", who: "ユイカ", appearance: "winter", variant: "smile" },
      { kind: "asset", folder: "bgm", path: "night.ogg" },
      { kind: "asset", folder: "sound", path: "bell.wav" },
    ]);
  });

  it("画像の選択肢のボタンの画像も集める", () => {
    const unit = unitOf(["一", "@choice", "- 扉 -> #a image=button/door.png hover=button/door_on.png", "- 窓 -> #a", "@end", "# a"].join("\n"));
    expect(collectPrefetch(unit, 0, registry)).toEqual([
      { kind: "asset", folder: "image", path: "button/door.png" },
      { kind: "asset", folder: "image", path: "button/door_on.png" },
    ]);
  });

  it("見る範囲は limit 個の命令まで", () => {
    const unit = unitOf(["一", "@bg a.jpg", "二", "@bg b.jpg"].join("\n"));
    expect(collectPrefetch(unit, 0, registry, 2)).toEqual([{ kind: "asset", folder: "bgimage", path: "a.jpg" }]);
  });
});

describe("別のファイルの飛び先の先読み", () => {
  /** ページを出すたびに、読み込んだファイルと先読みを頼まれた素材を控える。 */
  const run = async (files: Record<string, string>, entry = "a") => {
    const loads: string[] = [];
    const prefetched: string[] = [];
    const host = new HeadlessHost({
      loadSource: async (f: string) => {
        loads.push(f);
        const src = files[f];
        if (src === undefined) throw new Error(`no file ${f}`);
        return src;
      },
    });
    (host as unknown as { prefetch(items: PrefetchItem[]): void }).prefetch = (items) => void prefetched.push(...items.flatMap((i) => (i.kind === "asset" ? [i.path] : [])));
    const atPage: { loads: string[]; prefetched: string[] }[] = [];
    host.waitClick = async () => {
      // 先読みは待たずに進むので、読み終わるのを少し待ってから控える
      await new Promise((r) => setTimeout(r, 5));
      atPage.push({ loads: [...loads], prefetched: [...prefetched] });
    };
    await new Runtime(host).start(entry);
    const diagnostics = host.trace.flatMap((t) => (t.type === "diagnostic" ? [`${t.diagnostic.file}:${t.diagnostic.code}`] : []));
    return { atPage, loads, diagnostics };
  };

  it("飛ぶ前のページで飛び先のファイルを読み、飛び先の頭の素材を頼む", async () => {
    const { atPage, loads } = await run({ a: "　一\n@jump b#x", b: "　前\n# x\n@bg far.jpg\n@bgm next.ogg\n　二" });
    expect(atPage[0]!.loads).toEqual(["a", "b"]);
    expect(atPage[0]!.prefetched).toEqual(expect.arrayContaining(["far.jpg", "next.ogg"]));
    // 本当に飛んだときに読み直さない
    expect(loads).toEqual(["a", "b"]);
  });

  it("選択肢の飛び先と @call の飛び先も読む。式の飛び先は読まない", async () => {
    const { atPage } = await run({
      a: '　一\n@choice\n- 左 -> c\n- 右 -> d\n@end\n@call e\n@jump ("f")',
      c: "@bg c.jpg\n　c",
      d: "@bg d.jpg\n　d",
      e: "@bg e.jpg\n@return",
      f: "@bg f.jpg",
    });
    expect(atPage[0]!.loads.slice().sort()).toEqual(["a", "c", "d", "e"]);
    expect(atPage[0]!.prefetched).toEqual(expect.arrayContaining(["c.jpg", "d.jpg", "e.jpg"]));
  });

  it("先読みしたファイルの誤りは、そのファイルへ飛んだときに知らせる。読めないファイルは黙る", async () => {
    const quiet = await run({ a: "　一\n@if false\n@jump b\n@end\n@jump c\n　終わり", b: "@if\n　壊れた", c: "　c" });
    expect(quiet.atPage[0]!.loads).toContain("b");
    expect(quiet.diagnostics.filter((d) => d.startsWith("b:"))).toEqual([]);
    const loud = await run({ a: "　一\n@jump b", b: "@if\n　壊れた" });
    expect(loud.diagnostics.some((d) => d.startsWith("b:"))).toBe(true);
    const missing = await run({ a: "　一\n@if false\n@jump nowhere\n@end\n　二" });
    expect(missing.diagnostics).toEqual([]);
  });
});
