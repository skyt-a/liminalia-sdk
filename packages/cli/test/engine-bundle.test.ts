import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPackage } from "@electron/asar";
import { parseAst } from "rollup/parseAst";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineBundle } from "../src/commands/size.ts";
import { squeezeTemplates, stripDocs } from "../src/strip-docs.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
/**
 * エンジンの束（ひな形の作品を書き出したときの engine/*.js と *.css）のうち、遊び始める前に読むものの、gzip で縮めた大きさの目安。超えたらこのテストが落ちる。
 * 大きくなるのが正しいとき（新しい機能）は、増えた分を確かめてから目安を上げる。
 */
// 2026-11-07: 遊ぶ側で使わない台本の検査、部品の見本の表、英語の命令の表を外して 244 KB から 231 KB にしたあと、止まったときの記録、統計の確認、
// 常駐のボタン、立ち絵の部品の口などを足して 230.4 KB になったので、目安を 240 KB に上げた（内訳は scripts/bundle-breakdown.mjs で見る）
// 2026-11-08: 標準の命令の描画を部品に分け、作品が使わない部品は始めに読まないようにした（ひな形は部品を使わないので、始めに読むのは 222 KB）。
// 部品を含めたすべては、ファイルごとに縮めるので 247 KB になる。すべての目安は 260 KB
// 2026-11-09: 0.4.0 の段 f2 でセーブとロード、履歴、タイトル画面をテンプレートで書き直す前に、すべてが 259.7 KB で目安までの残りが無かったので、
// 利用者が決めてすべての目安を 270 KB に上げた（書き直したあとは 260.9 KB）。遊び始める前に読む分の目安 240 KB は変えない
// 段 f3 でコンフィグをテンプレートで書き直したあとは、遊び始める前に読むものが 227.4 KB から 226.7 KB、すべてが 260.9 KB から 261.6 KB
// 2026-11-22: @define・@with の中のラベルへ飛んだときのエラーを足したらすべてが 270.1 KB になったので、すべての目安を 272 KB に上げた
const ENGINE_GZIP_BUDGET = 240 * 1024;
// 2026-11-22: プラグインとの約束（@liminalia/sdk）を約束だけにし、描画の部品を sdk へ登録する口（web の index.ts）を足したら、
// ゲームが使っていない描画の部品も束に残るようになり 273.2 KB になったので、すべての目安を 276 KB に上げた
const ENGINE_ALL_GZIP_BUDGET = 276 * 1024;

const strip = (code: string, table = false) => stripDocs(code, parseAst(code), table);

describe("書き出すエンジンから命令の説明文を外す", () => {
  it("命令の表は説明、例、探す言葉を空にし、名前、型、既定の値と実行の中身は残す", () => {
    const code = `const duration = (doc, def) => ({ type: { kind: "duration" }, default: def, doc });
export const COMMANDS = [{
  name: "bg",
  summary: "背景を切り替える",
  summaryEn: \`Change\`,
  positional: ["image"],
  params: { image: { type: { kind: "asset" }, required: true, doc: "背景の画像" }, fade: duration("切り替える時間", "500ms"), text: t.text("見せる文字", ""), mode: t.enum(["a", "b"], "動き", "a") },
  example: "@bg a.png",
  keywords: ["背景", "場面"],
  preview: { lines: ["@bg {bg}"], reset: ["@bg {bg2}"] },
  run(args) { return { summary: args.summary, message: "実行の中の文" }; },
}];`;
    const out = strip(code);
    expect(out).not.toMatch(/背景を切り替える|Change|背景の画像|切り替える時間|見せる文字|動き|@bg a.png|場面|\{bg\}/);
    expect(out).toContain('name: "bg"');
    expect(out).toContain('positional: ["image"]');
    expect(out).toContain('default: def, doc })');
    expect(out).toContain('duration("", "500ms")');
    expect(out).toContain('t.enum(["a", "b"], "", "a")');
    expect(out).toContain('message: "実行の中の文"');
    expect(out).toContain("summary: args.summary");
    // 変えたあとも JS として読める
    expect(() => parseAst(out)).not.toThrow();
  });

  it("説明と見出しの引数を持つ部品（function の宣言も）と、中に式のある説明も外す", () => {
    const code = `function filterParam(doc, required = false) { return { filter: { type: { kind: "enum" }, doc: \`\${doc}（muffled こもった音）\` } }; }
const L = (label, labelEn, doc, docEn) => ({ label, labelEn, doc, docEn });
export const SPEC = { params: { ...filterParam("このボイスのフィルター") }, data: d.record({ x: d.string(L("見出し", "Label", "説明", "Doc")) }), key: t.dataKey(FILE, "places", "場所の名前") };`;
    const out = strip(code);
    expect(out).not.toMatch(/こもった音|このボイスのフィルター|見出し|Label|説明|"Doc"|場所の名前/);
    expect(out).toContain('"places"');
    expect(() => parseAst(out)).not.toThrow();
  });

  it("英語の表は、export した表を中身ごと空にし、ほかの値の文字列もすべて外す", () => {
    const out = strip(`const FADE = "Fade-in time";\nconst SHARED = { fade: FADE };\nexport const EN = { bg: { summary: "Change the background", params: { fade: FADE, image: "Background image" }, keywords: ["background"] } };\nexport function f(t) { return t[0]; }`, true);
    expect(out).not.toMatch(/Fade-in time|Change the background|Background image|background"/);
    expect(out).toContain("export const EN = {}");
    // export していない表は中の文字列だけを外す。関数はそのまま
    expect(out).toContain("const SHARED = { fade: FADE }");
    expect(out).toContain('const FADE = ""');
    expect(out).toContain("export function f(t) { return t[0]; }");
    expect(() => parseAst(out)).not.toThrow();
  });
});

describe("書き出すエンジンの、標準の画面のテンプレート", () => {
  it("要素の間の、改行を含む空白だけを外す（文の中の空白と、改行の無い空白は残す）", () => {
    const code = "const T = `<template data-part=\"screen\">\n<div class=\"a\">\n  <b>名前</b> <i>説明</i>\n  <p>二つ\n目</p>\n</div>\n</template>\n`;";
    expect(squeezeTemplates(code)).toBe("const T = `<template data-part=\"screen\"><div class=\"a\"><b>名前</b> <i>説明</i><p>二つ\n目</p></div></template>\n`;");
  });
});

describe("エンジンの束の大きさ", { timeout: 300_000 }, () => {
  let root: string;
  let web: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-engine-bundle-"));
    cpSync(TEMPLATE, join(root, "game"), { recursive: true });
    // lim と同じく別のプロセスで書き出す（開発サーバーの設定とプラグインは tsx で読む）
    const r = spawnSync(process.execPath, [LIM, "build", join(root, "game"), "browser", "--no-verify", "--no-import"], { encoding: "utf8", timeout: 280_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    web = join(root, "game", "dist", "browser", "hoshi_wo_matsu_oka");
  }, 300_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(`ひな形の作品のエンジンの束は、遊び始める前に読むものが gzip で ${ENGINE_GZIP_BUDGET / 1024} KB まで、すべてで ${ENGINE_ALL_GZIP_BUDGET / 1024} KB まで。命令の説明文は入らない`, () => {
    const engine = engineBundle(web)!;
    expect(engine.files).toBeGreaterThan(0);
    expect(engine.initial.files).toBeGreaterThan(0);
    expect(engine.initial.gzip, `遊び始める前に読むエンジンの束が gzip で ${Math.round(engine.initial.gzip / 1024)} KB になった`).toBeLessThanOrEqual(ENGINE_GZIP_BUDGET);
    expect(engine.gzip, `エンジンの束が gzip で ${Math.round(engine.gzip / 1024)} KB になった`).toBeLessThanOrEqual(ENGINE_ALL_GZIP_BUDGET);
    // 標準の命令の描画のうち、ひな形が使わない部品（図鑑など）は始めに読まない
    expect(engine.initial.bytes).toBeLessThan(engine.bytes);
    // 標準の画面の型（メニュー、選択肢など）は初めて開くときに読む別の束。確認の画面の型は始めに読む束にある
    const page = readFileSync(join(web, "index.html"), "utf8");
    const files = readdirSync(join(web, "engine"));
    const lazy = files.filter((f) => /^lazy-screens-[\w-]+\.js$/.test(f));
    expect(lazy).toHaveLength(1);
    // セーブとロード、履歴、タイトル画面の型（0.4.0 の段 f2）とコンフィグの型（段 f3）も同じ束
    const lazyCode = readFileSync(join(web, "engine", lazy[0]!), "utf8");
    const core = files.filter((f) => /^core-[\w-]+\.js$/.test(f)).map((f) => readFileSync(join(web, "engine", f), "utf8")).join("\n");
    for (const mark of ['class="lm-screen lm-menu"', 'class="lm-screen lm-saveload"', 'class="lm-screen lm-backlog"', 'class="lm-title-menu"', 'class="lm-screen lm-config"']) {
      expect(lazyCode, mark).toContain(mark);
      expect(core, mark).not.toContain(mark);
    }
    expect(core).toContain('class="lm-dialog-backdrop"');
    // 標準の画面のテンプレート（@liminalia/screens）は、要素の間の改行と字下げを外して入る
    expect(lazyCode).toContain('<div class="lm-screen lm-menu"><div class="lm-menu-panel">');
    expect(lazyCode).not.toMatch(/class="lm-screen lm-menu">\s*\n/);
    expect(page).not.toContain("lazy-screens");
    const js = readdirSync(join(web, "engine"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(web, "engine", f), "utf8"))
      .join("\n");
    for (const doc of ["背景を切り替える", "Change the background", "チャットアプリ風の画面を開く", "@chat-open ユイ me=ソウ"]) expect(js, doc).not.toContain(doc);
    // 命令の名前は残る
    expect(js).toContain("chat-open");
  });

  it("デスクトップ版の app.asar の中の束も数える", async () => {
    const src = join(root, "app-src");
    mkdirSync(join(src, "web", "engine"), { recursive: true });
    writeFileSync(join(src, "web", "engine", "index-a.js"), "x".repeat(1000));
    writeFileSync(join(src, "main.cjs"), "");
    const app = join(root, "Game", "resources");
    mkdirSync(app, { recursive: true });
    await createPackage(src, join(app, "app.asar"));
    expect(engineBundle(join(root, "Game"))).toMatchObject({ bytes: 1000, files: 1 });
  });
});
