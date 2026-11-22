import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, latestBuild, sizeReport } from "../src/commands/size.ts";
import { alignAssetNames, alignBuildAssetNames } from "../src/commands/build.ts";
import { assetsNeededByCheck, assetsToDropForBuild, findUnusedAssets } from "../src/commands/unused.ts";
import { loadContext } from "../src/context.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-size-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(path: string, bytes: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

describe("書き出しの大きさの内訳", () => {
  it("ブラウザ版を種類別・フォルダ別に分け、大きい順に並べる", () => {
    const web = join(dir, "browser", "game");
    file(join(web, "index.html"), 10);
    file(join(web, "engine", "index.js"), 500);
    file(join(web, "project", "scenario", "start.lim"), 50);
    file(join(web, "assets", "bgimage", "a.webp"), 3000);
    file(join(web, "assets", "voice", "v.ogg"), 2000);
    const r = sizeReport(web, 2);
    expect(r.total).toBe(5560);
    expect(r.kinds.image).toBe(3000);
    expect(r.kinds.audio).toBe(2000);
    expect(r.kinds.engine).toBe(510);
    expect(r.kinds.scenario).toBe(50);
    expect(r.folders[0]).toEqual({ folder: "assets/bgimage", bytes: 3000 });
    expect(r.largest.map((f) => f.path)).toEqual(["assets/bgimage/a.webp", "assets/voice/v.ogg"]);
    expect(latestBuild(dir)).toBe(web);
  });

  it("デスクトップ版の assets.asar の中を数え、Electron 本体は実行環境にする", async () => {
    const src = join(dir, "src");
    file(join(src, "bgm", "a.m4a"), 700);
    const app = join(dir, "win", "Game");
    mkdirSync(join(app, "resources"), { recursive: true });
    await createPackage(src, join(app, "resources", "assets.asar"));
    const appSrc = join(dir, "appsrc");
    file(join(appSrc, "main.cjs"), 10);
    await createPackage(appSrc, join(app, "resources", "app.asar"));
    file(join(app, "Game.exe"), 9000);
    const r = sizeReport(app);
    expect(r.kinds.audio).toBe(700);
    expect(r.folders.find((f) => f.folder === "assets/bgm")?.bytes).toBe(700);
    expect(r.kinds.runtime).toBe(9000);
    expect(r.kinds.engine).toBe(10);
    expect(classify("Game.app/Contents/Resources/app.asar/web/engine/x.js").kind).toBe("engine");
  });
});

describe("使っていない素材の候補", () => {
  it("参照も名前の出現も無い素材だけを出し、声は --all のときだけ見る", async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    file(join(dir, "assets", "bgimage", "never_used.png"), 1234);
    file(join(dir, "assets", "image", "named_in_data.png"), 10);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "gallery.json"), JSON.stringify({ pics: ["named_in_data"] }));
    file(join(dir, "assets", "voice", "v001.ogg"), 10);
    const r = await findUnusedAssets(dir);
    expect(r.unused).toEqual([{ path: "bgimage/never_used.png", bytes: 1234 }]);
    expect(r.skippedVoice).toBe(1);
    const all = await findUnusedAssets(dir, { all: true });
    expect(all.unused.map((u) => u.path)).toEqual(["bgimage/never_used.png", "voice/v001.ogg"]);
  });

  it("作品の CSS、画面のテンプレートとその隣のファイル、パック、訳に名前が出てくる素材は候補に出さず、ほかの下書きのフォルダは見ない", async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    for (const name of ["frame_css", "in_template", "in_screen_js", "in_lang"]) file(join(dir, "assets", "image", `${name}.png`), 10);
    file(join(dir, "assets", "bgimage", "pack_bg.webp"), 10);
    file(join(dir, "assets", "bgimage", "only_in_draft.png"), 10);
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"));
    config.ui = { ...config.ui, css: ["ui/screens.css"], templates: { title: "ui/screens/title/title.html" } };
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(config));
    mkdirSync(join(dir, "ui", "screens", "title"), { recursive: true });
    writeFileSync(join(dir, "ui", "screens.css"), `.frame { background: url("../assets/image/frame_css.png"); }`);
    writeFileSync(join(dir, "ui", "screens", "title", "title.html"), `<template data-part="logo"><img src="assets/image/in_template.png"></template>`);
    writeFileSync(join(dir, "ui", "screens", "title", "title.js"), `export default () => "image/in_screen_js.png";`);
    mkdirSync(join(dir, "lang"), { recursive: true });
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify({ assets: { "image/x.png": "in_lang.png" } }));
    mkdirSync(join(dir, "packs", "after", "scenario"), { recursive: true });
    writeFileSync(join(dir, "packs", "after", "pack.json"), JSON.stringify({ id: "after" }));
    writeFileSync(join(dir, "packs", "after", "scenario", "after.lim"), "@bg pack_bg.webp\n");
    // 下書きや控えの台本（作品の CSS、テンプレート、パック、訳のどれでもないフォルダ）は数えない
    mkdirSync(join(dir, "output"), { recursive: true });
    writeFileSync(join(dir, "output", "old.lim"), "@bg only_in_draft.png\n");
    const r = await findUnusedAssets(dir);
    expect(r.unused.map((u) => u.path)).toEqual(["bgimage/only_in_draft.png"]);
  });
});

describe("書き出しの「使っている素材だけ」", () => {
  it("候補を外す。式で素材を指す命令があるフォルダは外さず、引数をそのまま渡すマクロは式に数えない", async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    file(join(dir, "assets", "bgimage", "bg_1.png"), 10);
    file(join(dir, "assets", "sound", "never_used.wav"), 20);
    file(join(dir, "assets", "voice", "v001.ogg"), 10);
    writeFileSync(join(dir, "scenario", "extra.lim"), ['@define show-bg(place: asset(bgimage))', "@bg (place)", "@end", "# a", "@show-bg hill_dusk.webp", ""].join("\n"));
    let r = await assetsToDropForBuild(dir);
    expect(r.drop.map((a) => a.path).sort()).toEqual(["bgimage/bg_1.png", "sound/never_used.wav"]);
    expect(r.kept).toEqual([]);
    // 名前の一部（"bg_" + n）を書かない式（名前の一部があれば、その名前の素材は候補にならない。asset-reference-forms.test.ts）
    writeFileSync(join(dir, "scenario", "extra.lim"), ['@let n = 1', "@bg (game.place)", ""].join("\n"));
    r = await assetsToDropForBuild(dir);
    expect(r.drop.map((a) => a.path)).toEqual(["sound/never_used.wav"]);
    expect(r.kept.map((k) => ({ folder: k.folder, files: k.files, file: k.uses[0]!.file, line: k.uses[0]!.line }))).toEqual([{ folder: "bgimage", files: 1, file: "extra", line: 2 }]);
  });

  it("素材の型でないパラメータを素材に渡すマクロと、式で書いた画像の選択肢は、式の素材に数える", async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    file(join(dir, "assets", "bgimage", "bg_1.png"), 10);
    file(join(dir, "assets", "image", "pic_1.png"), 10);
    writeFileSync(join(dir, "scenario", "extra.lim"), ['@define show-bg(place: string)', "@bg (place)", "@end", "# a", "@show-bg place=(game.place)", ""].join("\n"));
    let r = await assetsToDropForBuild(dir);
    expect(r.kept.map((k) => k.folder)).toContain("bgimage");
    expect(r.drop.map((a) => a.path)).toEqual(["image/pic_1.png"]);
    writeFileSync(join(dir, "scenario", "extra.lim"), ["# a", "@choice", "- 見る -> #a image=(game.pic)", "@end", ""].join("\n"));
    r = await assetsToDropForBuild(dir);
    expect(r.kept.map((k) => k.folder)).toEqual(["image"]);
  });
});

describe("書き出しの「使っている素材だけ」の確かめ直し", () => {
  it("外すと検査で問題が出る素材（@flipbook のコマ、無い素材）は戻す。問題の出ない素材は外す", async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    file(join(dir, "assets", "image", "fx", "cut_01.png"), 10);
    file(join(dir, "assets", "image", "fx", "cut_02.png"), 10);
    file(join(dir, "assets", "sound", "never_used.wav"), 10);
    writeFileSync(join(dir, "scenario", "extra.lim"), "# a\n@flipbook fx/cut_{nn}.png frames=2\n");
    const ctx = await loadContext(dir);
    // 外す判定が誤ってコマを外そうとしても、@flipbook の検査（flipbook-missing）が名指すので戻す
    const r = assetsNeededByCheck(ctx, ["image/fx/cut_01.png", "image/fx/cut_02.png", "sound/never_used.wav"]);
    expect(r.needed.sort()).toEqual(["image/fx/cut_01.png", "image/fx/cut_02.png"]);
    expect(r.problems.map((d) => d.code)).toEqual(["flipbook-missing"]);
    // 台本が使う素材も、無い素材の検査（missing-asset）が名指すので戻す
    expect(assetsNeededByCheck(ctx, ["bgimage/hill_dusk.webp"]).needed).toEqual(["bgimage/hill_dusk.webp"]);
    expect(assetsNeededByCheck(ctx, ["sound/never_used.wav"])).toEqual({ needed: [], problems: [] });
  });

  it("濁点などの合成だけが違う名前の素材は、台本に書いた形の名前で写す", () => {
    const nfd = "bgimage/ガード.webp".normalize("NFD");
    const nfc = "bgimage/ガード.webp".normalize("NFC");
    const files = [{ rel: nfd, file: "/x/ガード.webp" }, { rel: "bgimage/a.png", file: "/x/a.png" }];
    const r = alignAssetNames(files, [nfc, "bgimage/a.png"]);
    expect(r.files.map((f) => f.rel)).toEqual([nfc, "bgimage/a.png"]);
    expect(r.renamed).toEqual([{ rel: nfc, file: "/x/ガード.webp" }]);
    // 書いた形が二つあれば、ファイルの名前のまま
    expect(alignAssetNames(files, [nfc, nfd]).renamed).toEqual([]);
  });

  it("パック（packs/<フォルダ>/scenario）の台本が書いた形にもそろえる（書き出しはパックも入れ、パックの台本は本体の素材も使う。2026-11-19 の rest-p）", async () => {
    const nfd = "bgimage/ガード.webp".normalize("NFD");
    const nfc = "bgimage/ガード.webp".normalize("NFC");
    cpSync(TEMPLATE, dir, { recursive: true });
    mkdirSync(join(dir, "packs", "extra", "scenario"), { recursive: true });
    writeFileSync(join(dir, "packs", "extra", "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    writeFileSync(join(dir, "packs", "extra", "scenario", "bonus.lim"), `# bonus\n@bg ${nfc.slice("bgimage/".length)}\n`);
    const ctx = await loadContext(dir);
    const r = alignBuildAssetNames(ctx, [{ rel: nfd, file: "/x/ガード.webp" }]);
    expect(r.renamed).toEqual([{ rel: nfc, file: "/x/ガード.webp" }]);
  });
});
