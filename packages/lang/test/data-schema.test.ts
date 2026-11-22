import { describe, expect, it } from "vitest";
import { checkData, checkDataFlags, checkExtra, CORE_COMMANDS, createRegistry, dataCgImages, jsonLines, mergeJson, parse, renameInData, type DataDeclaration } from "../src/index.ts";

const decl: DataDeclaration = {
  file: "inv.json",
  title: "調べる場所",
  root: {
    kind: "record",
    fields: {
      places: {
        kind: "map",
        of: {
          kind: "record",
          fields: {
            file: { kind: "file", required: true },
            background: { kind: "asset", folder: "bgimage", cg: true },
            done: { kind: "scene", base: "file" },
            spots: {
              kind: "list",
              key: "id",
              of: {
                kind: "record",
                fields: {
                  id: { kind: "string", required: true },
                  target: { kind: "scene", base: "file", required: true },
                  flag: { kind: "flag", use: "set" },
                  if: { kind: "expr" },
                  who: { kind: "cast" },
                },
              },
            },
          },
        },
      },
    },
  },
};

const value = {
  places: {
    room: {
      file: "a",
      background: "room.png",
      done: "#done",
      spots: [
        { id: "desk", target: "#desk", flag: "seen_desk", if: "game.met && game.trust >= 2", who: "ユイ" },
        { id: "bed", target: "b#nowhere", flag: "game.seen_bed" },
      ],
    },
  },
};

const scripts = new Map([
  ["a", parse("# desk\n@set game.met = true\n# done\n@if game.seen_desk\n@end\n", "a")],
  ["b", parse("# start\n", "b")],
]);
const registry = createRegistry(CORE_COMMANDS);

describe("データの形の宣言", () => {
  it("形・飛び先・素材・キャスト・式を確かめ、行を出す", () => {
    const text = JSON.stringify(value, null, 2);
    const d = checkData(decl, value, {
      fileName: "data/inv.json",
      text,
      labels: new Map([
        ["a", new Set(["desk", "done"])],
        ["b", new Set(["start"])],
      ]),
      assetExists: (folder, path) => folder === "bgimage" && path === "room.png",
      cast: new Set(["ユイ"]),
    });
    expect(d.map((x) => x.code)).toEqual(["data-unknown-scene"]);
    expect(d[0]!.line).toBe(jsonLines(text).get("/places/room/spots/1/target"));
  });

  it("型の違いと必須の欄を知らせる", () => {
    const d = checkData(decl, { places: { room: { background: 3, spots: [{ id: "x", target: "#y", if: "game.(" }] } } }, { fileName: "data/inv.json" });
    expect(d.map((x) => x.code).sort()).toEqual(["data-bad-expr", "data-missing", "data-type"]);
  });

  it("読むのに立てないフラグと、立てるのに読まれないフラグ", () => {
    const d = checkDataFlags([{ decl, value }], scripts, registry);
    // game.trust は読むのに立てない。seen_bed は立てるのに誰も読まない（seen_desk は台本が読む）
    expect(d.map((x) => `${x.code}:${x.message.match(/game\.\w+/)![0]}`)).toEqual(["data-flag-unset:game.trust", "data-flag-unread:game.seen_bed"]);
  });

  it("名前を変えたら書き換える", () => {
    const label = renameInData(decl, value, { kind: "label", file: "a", from: "desk", to: "table" });
    expect(label.count).toBe(1);
    expect((label.value as typeof value).places.room.spots[0]!.target).toBe("#table");
    const file = renameInData(decl, value, { kind: "file", from: "b", to: "c" });
    expect((file.value as typeof value).places.room.spots[1]!.target).toBe("c#nowhere");
    const asset = renameInData(decl, value, { kind: "asset", folder: "bgimage", from: "room.png", to: "rooms/room.png" });
    expect((asset.value as typeof value).places.room.background).toBe("rooms/room.png");
    const v = renameInData(decl, value, { kind: "variable", from: "game.met", to: "game.known" });
    expect((v.value as typeof value).places.room.spots[0]!.if).toBe("game.known && game.trust >= 2");
    const flag = renameInData(decl, value, { kind: "variable", from: "game.seen_desk", to: "game.desk_done" });
    expect((flag.value as typeof value).places.room.spots[0]!.flag).toBe("desk_done");
    expect(renameInData(decl, value, { kind: "cast", from: "ユイ", to: "ゆい" }).count).toBe(1);
    // 元の値は変えない
    expect(value.places.room.spots[0]!.target).toBe("#desk");
  });

  it("CG の印の素材は、どこからも出ない CG に数えない", () => {
    const extra = { cg: [{ id: "room", title: "部屋", images: ["room.png"] }] };
    expect(checkExtra(extra, scripts, registry).map((x) => x.code)).toContain("unshown-cg");
    expect(checkExtra(extra, scripts, registry, undefined, dataCgImages([{ decl, value }])).map((x) => x.code)).not.toContain("unshown-cg");
  });
});

describe("絵の上の点（point）", () => {
  const points: DataDeclaration = {
    file: "pins.json",
    title: "印",
    root: {
      kind: "list",
      of: {
        kind: "record",
        fields: {
          at: { kind: "point" },
          px: { kind: "point", unit: "px" },
          // 同じ記録の x と y に置く点（欄そのものは値を持たない）
          pin: { kind: "point", keys: ["x", "y"], required: true },
          x: { kind: "number" },
          y: { kind: "number" },
        },
      },
    },
  };
  const codes = (v: unknown) => checkData(points, v, { fileName: "data/pins.json" }).map((d) => `${d.code} ${d.message}`);

  it("{ x, y } の数で書き、割合なら 0〜100。keys の点は欄が無くてもよい", () => {
    expect(codes([{ at: { x: 10, y: 90 }, px: { x: 1200, y: 700 }, x: 1, y: 2 }])).toEqual([]);
    expect(codes([{ at: { x: 10 } }])).toEqual(["data-type data/pins.json の /0/at（at）は{ x, y } の数で書きます"]);
    expect(codes([{ at: { x: 120, y: 0 } }])).toEqual(["data-type data/pins.json の /0/at（at）は0〜100 の { x, y }で書きます"]);
  });
});

describe("三方向のマージ", () => {
  it("欄ごと・項目ごとに合わせ、両方が変えたところを挙げる", () => {
    const base = { title: "a", n: 1, list: [{ id: "x", v: 1 }, { id: "y", v: 1 }] };
    const ours = { title: "b", n: 2, list: [{ id: "x", v: 2 }, { id: "y", v: 1 }] };
    const theirs = { title: "a", n: 3, list: [{ id: "x", v: 1 }, { id: "y", v: 1 }, { id: "z", v: 1 }] };
    const r = mergeJson(base, ours, theirs);
    expect(r.value).toEqual({ title: "b", n: 2, list: [{ id: "x", v: 2 }, { id: "y", v: 1 }, { id: "z", v: 1 }] });
    expect(r.conflicts).toEqual([["n"]]);
  });

  it("片方が消した項目は消す", () => {
    const base = { list: [{ id: "x" }, { id: "y" }] };
    const r = mergeJson(base, { list: [{ id: "x" }, { id: "y", note: 1 }] }, { list: [{ id: "y" }] });
    expect(r.value).toEqual({ list: [{ id: "y", note: 1 }] });
    expect(r.conflicts).toEqual([]);
  });

  it("片方が消してもう片方が変えた項目は、どちらの向きでも残して争いに挙げる", () => {
    const base = { list: [{ id: "a", v: 1 }, { id: "b", v: 2 }] };
    // ours が b を消し、theirs が b を変えた
    const r1 = mergeJson(base, { list: [{ id: "a", v: 1 }] }, { list: [{ id: "a", v: 1 }, { id: "b", v: 9 }] });
    expect(r1.value).toEqual({ list: [{ id: "a", v: 1 }, { id: "b", v: 9 }] });
    expect(r1.conflicts).toEqual([["list", "b"]]);
    // theirs が b を消し、ours が b を変えた
    const r2 = mergeJson(base, { list: [{ id: "a", v: 1 }, { id: "b", v: 9 }] }, { list: [{ id: "a", v: 1 }] });
    expect(r2.value).toEqual({ list: [{ id: "a", v: 1 }, { id: "b", v: 9 }] });
    expect(r2.conflicts).toEqual([["list", "b"]]);
  });
});
