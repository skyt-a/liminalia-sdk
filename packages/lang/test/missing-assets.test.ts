import { describe, expect, it } from "vitest";
import { applyFix, assetNameResolver, CORE_COMMANDS, createRegistry, isLfsPointer, MEDIA_EXTENSIONS, MEDIA_TYPES, mediaKindOf, missingAssets, parse, unexportedAssets } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);

describe("無い素材", () => {
  it("シナリオ・キャスト・おまけ・持ち物・ゲームの設定から集め、無いものだけを位置つきで出す", () => {
    const scripts = new Map([["a", parse("@bg hill.webp\n@bg none.webp\n@bg none.webp\n", "a")]]);
    const asked: string[] = [];
    const have = new Set(["bgimage/hill.webp", "fgimage/akari/normal.png"]);
    const d = missingAssets({
      scripts,
      registry,
      cast: { アカリ: { appearances: { default: { variants: { normal: { image: "akari/normal.png" }, smile: { image: "akari/smile.png" } } } } } },
      castFile: "cast.json",
      extra: { cg: [{ id: "c1", images: ["cg/one.png"] }] },
      items: { key: { name: "鍵", image: "items/key.png" } },
      exists: (folder, path) => {
        asked.push(`${folder}/${path}`);
        return have.has(`${folder}/${path}`);
      },
    });
    expect(d.map((x) => [x.code, x.file, x.line, x.message])).toEqual([
      ["missing-asset", "a", 2, "素材 bgimage/none.webp がありません"],
      ["missing-asset", "a", 3, "素材 bgimage/none.webp がありません"],
      ["missing-asset", "cast.json", 1, "キャラクター アカリ の立ち絵 fgimage/akari/smile.png がありません"],
      ["missing-asset", "liminalia.json", 1, "extra.cg c1 の素材 bgimage/cg/one.png がありません"],
      ["missing-asset", "liminalia.json", 1, "items.key.image の素材 image/items/key.png がありません"],
    ]);
    // 同じ素材は一度だけ確かめる
    expect(asked.filter((a) => a === "bgimage/none.webp")).toHaveLength(1);
  });
});

describe("Git LFS のポインタのままの素材", () => {
  const pointer = new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("中身がポインタの文字の素材を、最初に参照した所に一度だけエラーで知らせる（キャラクターの立ち絵はその人物を添える）", () => {
    const scripts = new Map([["a", parse("@bg hill.webp\n@bg hill.webp\n@bg room.webp\n", "a")]]);
    const heads: Record<string, Uint8Array> = { "bgimage/hill.webp": pointer, "bgimage/room.webp": png, "fgimage/akari/normal.png": pointer };
    const d = missingAssets({
      scripts,
      registry,
      cast: { アカリ: { appearances: { default: { variants: { normal: { image: "akari/normal.png" } } } } } },
      castFile: "cast.json",
      exists: () => true,
      head: (folder, path) => heads[`${folder}/${path}`] ?? null,
    });
    expect(d.map((x) => [x.severity, x.code, x.file, x.line, x.message])).toEqual([
      ["error", "lfs-pointer", "a", 1, "素材 bgimage/hill.webp は Git LFS のポインタのままです（中身を取り込んでいないので、表示も再生もできません）"],
      ["error", "lfs-pointer", "cast.json", 1, "キャラクター アカリ の立ち絵 fgimage/akari/normal.png は Git LFS のポインタのままです（中身を取り込んでいないので、表示も再生もできません）"],
    ]);
    expect(d[0]!.hint).toBe("git lfs pull で中身を取り込みます（CI では actions/checkout に lfs: true を書きます）");
    expect(d[1]!.cast).toEqual({ who: "アカリ" });
    expect(isLfsPointer(pointer)).toBe(true);
    expect(isLfsPointer(png)).toBe(false);
  });
});

describe("大文字と小文字の違う素材（asset-case-mismatch）", () => {
  // 素材のフォルダの中身（Mac や Windows では Room.JPG と書いても開けてしまう）
  const tree: Record<string, string[]> = { bgimage: ["Room.jpg", "Sub"], "bgimage/Sub": ["Night.png"], fgimage: ["akari"], "fgimage/akari": ["Normal.png"] };
  const actual = assetNameResolver((segments) => tree[segments.join("/")] ?? null);

  it("フォルダの中身の本当の名前と突き合わせ、違えばエラーと本当の名前に置き換える直し方を出す（途中のフォルダも）", () => {
    const text = "@bg room.jpg\n@bg Room.jpg\n@bg sub/night.png\n@bg none.jpg\n";
    const scripts = new Map([["a", parse(text, "a")]]);
    const d = missingAssets({
      scripts,
      registry,
      cast: { アカリ: { appearances: { default: { variants: { normal: { image: "akari/normal.png" } } } } } },
      castFile: "cast.json",
      // exists は大文字と小文字を問わない（Mac の existsSync と同じ）。actual があればそちらを使う
      exists: () => true,
      actual,
    });
    expect(d.map((x) => [x.code, x.file, x.line])).toEqual([
      ["asset-case-mismatch", "a", 1],
      ["asset-case-mismatch", "a", 3],
      ["missing-asset", "a", 4],
      ["asset-case-mismatch", "cast.json", 1],
    ]);
    expect(d[0]!.message).toBe("素材 bgimage/room.jpg は、ファイルの名前と大文字と小文字が違います（ファイルは Room.jpg。Linux のサーバーやスマホでは読めません）");
    expect(d[1]!.fix).toEqual({ kind: "replace", find: "sub/night.png", with: "Sub/Night.png" });
    expect(applyFix("@bg sub/night.png", d[1]!.fix!, d[1]!.column)).toMatchObject({ text: "@bg Sub/Night.png" });
    // キャストの定義は行の置き換えができないので直し方は付けない
    expect(d[3]!.fix).toBeUndefined();
    expect(d[3]!.hint).toBe("akari/Normal.png と書きます");
  });

  it(". や .. を含むパスは分からないとして exists に任せる", () => {
    expect(actual("bgimage", "./Room.jpg")).toBeUndefined();
    expect(actual("bgimage", "ROOM.JPG")).toBe("Room.jpg");
    expect(actual("bgimage", "Room.jpg")).toBe("Room.jpg");
    expect(actual("bgm", "x.ogg")).toBeNull();
  });
});

describe("書き出しに入らない種類の素材", () => {
  it("参照している素材のうち、素材の表に無い拡張子のものを警告にする（同じ素材は一度だけ）", () => {
    const scripts = new Map([["a", parse("@bg hill.webp\n@bg room.bmp\n@bg room.bmp\n@bgm theme.opus\n", "a")]]);
    const d = unexportedAssets({
      scripts,
      registry,
      cast: { アカリ: { appearances: { default: { variants: { normal: { image: "akari/normal.psd" } } } } } },
      castFile: "cast.json",
    });
    expect(d.map((x) => [x.severity, x.code, x.file, x.line, x.message])).toEqual([
      ["warning", "asset-not-exported", "a", 2, "素材 bgimage/room.bmp は書き出しに入らない種類のファイルです（.bmp）"],
      ["warning", "asset-not-exported", "cast.json", 1, "素材 fgimage/akari/normal.psd は書き出しに入らない種類のファイルです（.psd）"],
    ]);
    expect(d[0]!.hint).toContain(".frag");
  });

  it("素材の表: Studio が受ける音・動画と、シェーダー・AVIF も入り、どれにも中身の種類がある", () => {
    for (const f of ["a.aac", "a.OPUS", "a.mov", "a.ogv", "a.avif", "shaders/glow.frag", "a.eot"]) expect(mediaKindOf(f)).not.toBeNull();
    for (const f of ["a.psd", "notes.md", "noext", ".frag"]) expect(mediaKindOf(f)).toBeNull();
    for (const ext of Object.values(MEDIA_EXTENSIONS).flat()) expect(MEDIA_TYPES[ext]).toBeTruthy();
  });

  it("素材の表: Live2D と Spine のモデルと、others に置くランタイムのスクリプトも書き出しに入る", () => {
    for (const f of ["yui/yui.moc3", "yui/yui.model3.json", "yui/motions/idle.motion3.json", "hero/hero.skel", "hero/hero.json", "hero/hero.atlas"]) expect(mediaKindOf(f)).toBe("model");
    expect(mediaKindOf("live2d/live2dcubismcore.min.js")).toBe("script");
    expect([MEDIA_TYPES[".js"], MEDIA_TYPES[".json"]]).toEqual(["text/javascript", "application/json"]);
  });
});
