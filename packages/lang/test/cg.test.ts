import { describe, expect, it } from "vitest";
import { cgMatcher, checkExtra, CORE_COMMANDS, createRegistry, parse, redundantCgUnlocks, shownImages, unshownCg, type CommandSpec, type Script } from "../src/index.ts";

const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([name, src]) => [name, parse(src, name)]));

/** 章末の扉絵を出すプラグインのコマンド（image に CG の印）と、印の無いコマンド。 */
const ENDING: CommandSpec = { name: "ending", summary: "章末", positional: [], params: { image: { type: { kind: "asset", folder: "bgimage", cg: true }, doc: "扉絵" } }, example: "@ending image=a.png" };
const NOTE: CommandSpec = { name: "note", summary: "通知", positional: ["text"], params: { text: { type: { kind: "string" }, doc: "文" } }, example: "@note 文" };
const registry = createRegistry(CORE_COMMANDS, [ENDING, NOTE]);
const extra = { cg: [{ id: "a", images: ["a.png", "a2.png"] }, { id: "f", folder: "fgimage" as const, images: ["f.png"] }], cgAuto: { folder: "stills" } };

describe("CG の解放", () => {
  it("CG の一覧（extra.cg の images と cgAuto のフォルダ）。CG が無ければ null", () => {
    const match = cgMatcher(extra)!;
    expect([match("bgimage", "a.png"), match("bgimage", "stills/x.png"), match("fgimage", "f.png"), match("bgimage", "f.png"), match("fgimage", "stills/x.png"), match("bgimage", "b.png")]).toEqual([true, true, true, false, false, false]);
    expect(cgMatcher(undefined)).toBeNull();
    expect(cgMatcher({ cg: [] })).toBeNull();
  });

  it("同じ画像を前に @bg で出した @cg-unlock は情報（行を消す直し方つき）", () => {
    const d = redundantCgUnlocks(scripts({ s: "@bg a.png time=1s\n@cg-unlock a.png\n@stop-bgm\n@cg-unlock stills/e1/x.png" }), extra, registry);
    expect(d.map((x) => [x.severity, x.code, x.line])).toEqual([["info", "redundant-cg-unlock", 2]]);
    expect(d[0]!.message).toBe("CG a.png は 1 行目の @bg で表示したときに解放されるため、この @cg-unlock は要りません");
    expect(d[0]!.fix).toEqual({ kind: "delete-line", text: "@cg-unlock a.png" });
  });

  it("後ろで出すものは、あいだが組み込みのコマンドだけなら要らない", () => {
    const d = redundantCgUnlocks(scripts({ s: "@cg-unlock a.png\n@stop-bgm\n@bg a.png\n@cg-unlock a2.png\n@note 通知\n@bg a2.png" }), extra, registry);
    expect(d.map((x) => x.line)).toEqual([1]);
  });

  it("ラベル・本文・選択肢・@if で並びが切れていたら、別のフォルダや一覧に無い画像なら知らせない", () => {
    const src = [
      "@bg a.png",
      "# label",
      "@cg-unlock a.png",
      "@bg a2.png",
      "本文",
      "@cg-unlock a2.png",
      "@bg b.png",
      "@cg-unlock b.png",
      "@bg a.png",
      "@cg-unlock a.png folder=fgimage",
      "@if game.x",
      "  @cg-unlock a.png",
      "@end",
    ].join("\n");
    expect(redundantCgUnlocks(scripts({ s: src }), extra, registry)).toEqual([]);
  });

  it("本文の中の {@cg-unlock} も、同じ行やその前の並びで出していれば要らない（行を消す直し方は持たない）", () => {
    const d = redundantCgUnlocks(scripts({ s: "本文{click}{@bg a.png time=1s}{@cg-unlock a.png}{@wait 1s}続き\n@bg a2.png\n本文{@cg-unlock a2.png}\n本文{@cg-unlock a.png}{@bg a.png}" }), extra, registry);
    expect(d.map((x) => [x.line, x.message, x.fix])).toEqual([
      [1, "CG a.png は 同じ行の {@bg} で表示したときに解放されるため、本文の中のこの {@cg-unlock} は要りません", undefined],
      [3, "CG a2.png は 2 行目の @bg で表示したときに解放されるため、本文の中のこの {@cg-unlock} は要りません", undefined],
      [4, "CG a.png は 同じ行の {@bg} で表示したときに解放されるため、本文の中のこの {@cg-unlock} は要りません", undefined],
    ]);
    expect(d[0]!.hint).toBe("本文から {@cg-unlock a.png} を削除します");
    // 行のコマンドから、後ろの本文の中のコマンドへは見ない
    expect(redundantCgUnlocks(scripts({ s: "@cg-unlock a.png\n本文{@bg a.png}" }), extra, registry)).toEqual([]);
  });

  it("本文の中の解放のコマンドも、一覧に無い名前なら警告し、cgAuto の出す画像に数える", () => {
    const d = checkExtra({ ...extra, replay: [] }, scripts({ s: "本文{@cg-unlock z.png}\n本文{@replay-unlock nope}" }), registry).filter((x) => x.code === "not-in-extra");
    expect(d.map((x) => x.line)).toEqual([1, 2]);
    expect(shownImages(scripts({ s: "本文{@bg stills/i.png}" }), registry)).toEqual(["stills/i.png"]);
  });

  it("CG の印の付いたプラグインのコマンドで出しても要らない。印が無ければ要る", () => {
    expect(redundantCgUnlocks(scripts({ s: "@ending image=a.png\n@cg-unlock a.png" }), extra, registry).map((x) => x.line)).toEqual([2]);
    const unmarked = createRegistry(CORE_COMMANDS, [{ ...ENDING, params: { image: { type: { kind: "asset", folder: "bgimage" }, doc: "扉絵" } } }]);
    expect(redundantCgUnlocks(scripts({ s: "@ending image=a.png\n@cg-unlock a.png" }), extra, unmarked)).toEqual([]);
  });

  it("どのシナリオも出さず解放もしない CG の画像は警告。式で出す画像があれば情報", () => {
    const d = unshownCg(extra, scripts({ s: "@bg a.png\n@cg-unlock f.png folder=fgimage" }), registry);
    expect(d.map((x) => [x.severity, x.code, x.message])).toEqual([["warning", "unshown-cg", "CG a の画像 a2.png は、どのシナリオでも表示も解放もしないため、おまけで見られません"]]);
    expect(unshownCg(extra, scripts({ s: "@ending image=a2.png\n@bg a.png\n{@cg-unlock f.png folder=fgimage}本文" }), registry)).toEqual([]);
    expect(unshownCg(extra, scripts({ s: "@bg (game.cg)" }), registry).map((x) => x.severity)).toEqual(["info", "info", "info"]);
    // cgAuto で足したもの（auto）は見ない
    expect(unshownCg({ cg: [{ id: "auto:x", images: ["stills/x.png"], auto: true }] }, scripts({}), registry)).toEqual([]);
  });

  it("おまけの検査にまとめて出る。形の崩れがあれば出どころは見ない", () => {
    const codes = checkExtra(extra, scripts({ s: "@bg a.png\n@cg-unlock a.png" }), registry).map((d) => d.code);
    expect(codes.sort()).toEqual(["redundant-cg-unlock", "unshown-cg", "unshown-cg"]);
    expect(checkExtra({ cg: [{ id: "a" }] }, scripts({ s: "@bg a.png" }), registry).map((d) => d.code)).toEqual(["bad-extra"]);
  });

  it("出す画像には CG の印の付いたパラメータの画像を数える", () => {
    expect(shownImages(scripts({ s: "@ending image=stills/e.png\n@bg stills/b.png\n@note stills/n.png\n@cg-unlock stills/c.png" }), registry)).toEqual(["stills/e.png", "stills/b.png", "stills/c.png"]);
  });
});
