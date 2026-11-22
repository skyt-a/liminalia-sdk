import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { announceStudio } from "@liminalia/studio/running";
import { afterAll, describe, expect, it } from "vitest";
import { addedErrors, mcpRoots, McpServer } from "../src/commands/mcp.ts";
import { lockedSettingsChanged, mergePatch } from "../src/commands/mcp-studio.ts";
import { imageInfoOf } from "../src/image-info.ts";
import { engineVersion } from "../src/version.ts";

/** 透明な地に、(x, y) から w×h だけ塗った RGBA の PNG（フィルタは行ごとに替える）。 */
function rgbaPng(width: number, height: number, x: number, y: number, w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: number[] = [];
  for (let r = 0; r < height; r++) {
    // 0（なし）か 2（上）で書く。上のフィルタは上の行との差
    const filter = r % 2;
    rows.push(filter === 1 ? 2 : 0);
    for (let c = 0; c < width; c++) {
      const on = c >= x && c < x + w && r >= y && r < y + h ? 255 : 0;
      const above = r > 0 && c >= x && c < x + w && r - 1 >= y && r - 1 < y + h ? 255 : 0;
      const px = [on, 0, 0, on];
      const up = [above, 0, 0, above];
      rows.push(...px.map((v, i) => (filter === 1 ? (v - up[i]! + 256) & 0xff : v)));
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const root = mkdtempSync(join(tmpdir(), "liminalia-mcp-test-"));
const server = new McpServer([root]);
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

let id = 0;
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await server.handle({ id: ++id, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { type: string; text?: string }[]; isError?: boolean } };
  return { text: r.result.content.map((c) => c.text ?? "").join("\n"), isError: r.result.isError === true };
}

describe("lim mcp", () => {
  it("初めのやり取りで道具の一覧を返す", async () => {
    const init = (await server.handle({ id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as { result: { capabilities: object; serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("liminalia");
    // MCP のサーバーが名乗る版はエンジンの版（lim --version と同じ）
    expect((init.result.serverInfo as { version?: string }).version).toBe(engineVersion());
    expect(await server.handle({ method: "notifications/initialized" })).toBeNull();
    const list = (await server.handle({ id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["create_project", "check", "trace", "screenshot", "command_reference", "write_scenario", "edit_scenario", "check_text", "scenario_guide", "build", "open_studio"]),
    );
  });

  it("道具と引数の説明は日本語の次の行に英語を書く", async () => {
    const list = (await server.handle({ id: 1, method: "tools/list" })) as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, { description?: string; items?: { properties?: Record<string, { description?: string }> } }> } }[] } };
    const japanese = /[ぁ-んァ-ヶ一-龠]/;
    const texts: [string, string][] = [];
    for (const t of list.result.tools) {
      texts.push([t.name, t.description]);
      for (const [k, p] of Object.entries(t.inputSchema.properties)) {
        if (p.description) texts.push([`${t.name}.${k}`, p.description]);
        for (const [k2, p2] of Object.entries(p.items?.properties ?? {})) if (p2.description) texts.push([`${t.name}.${k}.${k2}`, p2.description]);
      }
    }
    const init = (await server.handle({ id: 0, method: "initialize", params: {} })) as { result: { instructions: string } };
    texts.push(["instructions", init.result.instructions]);
    for (const [where, d] of texts) {
      const [ja, en, ...rest] = d.split("\n");
      expect({ where, ja: japanese.test(ja ?? ""), en: en !== undefined && en !== "" && !japanese.test(en), rest: rest.length }).toEqual({ where, ja: true, en: true, rest: 0 });
    }
    expect(list.result.tools.find((t) => t.name === "set_theme")!.description).toContain("default (Default)");
  });

  it("作品を作り、台本を書き、検査の誤りを返す", { timeout: 120_000 }, async () => {
    const made = await call("create_project", { name: "hoshi", title: "星の見本" });
    expect(made.isError).toBe(false);
    expect(existsSync(join(root, "hoshi", "liminalia.json"))).toBe(true);
    expect((await call("list_projects")).text).toContain("hoshi");
    expect((await call("check", { project: "hoshi" })).isError).toBe(false);

    // 書くと誤りが増える台本は、書かずに増える誤りを返す
    const refused = await call("write_scenario", { project: "hoshi", file: "extra", text: "@quake tim=1s\n" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("書いていません");
    expect(JSON.parse(refused.text.slice(refused.text.indexOf("{"))).addedErrors[0]).toMatchObject({ file: "extra", line: 1, code: "unknown-param" });
    expect(existsSync(join(root, "hoshi", "scenario", "extra.lim"))).toBe(false);
    // allowErrors なら書き、検査の誤りを返す（前の動き）
    const bad = await call("write_scenario", { project: "hoshi", file: "extra", text: "@quake tim=1s\n", allowErrors: true });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("extra.lim");
    expect(readFileSync(join(root, "hoshi", "scenario", "extra.lim"), "utf8")).toBe("@quake tim=1s\n");
    expect((await call("read_scenario", { project: "hoshi", file: "extra" })).text).toContain("@quake");
  });

  it("読んだあとでほかで直された台本は上書きせず、今の中身を返す。書く前の版は履歴に残す", { timeout: 120_000 }, async () => {
    const file = join(root, "hoshi", "scenario", "extra.lim");
    const read = await call("read_scenario", { project: "hoshi", file: "extra" });
    const hash = /hash: (\w+)/.exec(read.text)![1]!;
    // 制作画面などで直した
    writeFileSync(file, "@quake time=1s\n制作画面で直した行\n");
    const stale = await call("write_scenario", { project: "hoshi", file: "extra", text: "AI の案\n", baseHash: hash });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("制作画面で直した行");
    expect(readFileSync(file, "utf8")).toBe("@quake time=1s\n制作画面で直した行\n");
    // 既にある台本に baseHash なしでは書かない
    expect((await call("write_scenario", { project: "hoshi", file: "extra", text: "AI の案\n" })).isError).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("制作画面で直した行");
    // 今の hash なら書け、前の版が履歴に残る
    const fresh = /hash: (\w+)/.exec(stale.text)![1]!;
    const ok = await call("write_scenario", { project: "hoshi", file: "extra", text: "@quake time=1s\n制作画面で直した行\nAI が足した行", baseHash: fresh });
    expect(ok.isError).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("@quake time=1s\n制作画面で直した行\nAI が足した行\n");
    const history = join(root, "hoshi", ".liminalia", "history", "extra");
    const kept = readdirSync(history).map((f) => readFileSync(join(history, f), "utf8"));
    expect(kept).toContain("@quake time=1s\n制作画面で直した行\n");
    expect(ok.text).toContain(".liminalia/history/extra/");
  });

  it("一部の行を、書き換える前の行を確かめてから書き換える", { timeout: 120_000 }, async () => {
    const file = join(root, "hoshi", "scenario", "extra.lim");
    writeFileSync(file, "一行目\n二行目\n三行目\n");
    const numbered = await call("read_scenario", { project: "hoshi", file: "extra", numbered: true });
    expect(numbered.text).toContain("    2| 二行目");
    const ok = await call("edit_scenario", {
      project: "hoshi",
      file: "extra",
      edits: [
        { from: 1, to: 0, expect: "", text: "// 先頭に足す" },
        { from: 2, to: 2, expect: "二行目", text: "書き換えた二行目\n足した行" },
        { from: 3, to: 3, expect: "三行目", text: null },
      ],
    });
    expect(ok.isError).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("// 先頭に足す\n一行目\n書き換えた二行目\n足した行\n");
    // ほかで直された行は書き換えない
    writeFileSync(file, "一行目\n制作画面で直した\n");
    const changed = await call("edit_scenario", { project: "hoshi", file: "extra", edits: [{ from: 2, to: 2, expect: "二行目", text: "AI の案" }] });
    expect(changed.isError).toBe(true);
    expect(changed.text).toContain("    2| 制作画面で直した");
    expect(readFileSync(file, "utf8")).toBe("一行目\n制作画面で直した\n");
    // 行の範囲の誤り
    const invalid = await call("edit_scenario", { project: "hoshi", file: "extra", edits: [{ from: 9, to: 9, expect: "", text: "x" }] });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("範囲");
    expect((await call("edit_scenario", { project: "hoshi", file: "nothing", edits: [{ from: 1, to: 0, expect: "", text: "x" }] })).text).toContain("write_scenario");
  });

  it("書かずに台本の中身を検査して JSON で返し、作品全体の検査も JSON で返せる", { timeout: 120_000 }, async () => {
    const before = readFileSync(join(root, "hoshi", "scenario", "extra.lim"), "utf8");
    const r = await call("check_text", { project: "hoshi", file: "extra", text: "@quake tim=1s\n@jump nowhere#x\n" });
    expect(r.isError).toBe(true);
    const json = JSON.parse(r.text) as { file: string; errors: number; diagnostics: { line: number; code: string; severity: string }[] };
    expect(json.file).toBe("extra");
    expect(json.errors).toBeGreaterThan(0);
    expect(json.diagnostics.some((d) => d.line === 2)).toBe(true);
    expect(readFileSync(join(root, "hoshi", "scenario", "extra.lim"), "utf8")).toBe(before);
    expect((await call("check_text", { project: "hoshi", file: "new/scene", text: "# a\n地の文\n@jump start\n" })).isError).toBe(false);
    const all = await call("check", { project: "hoshi", format: "json" });
    expect(JSON.parse(all.text)).toHaveProperty("diagnostics");
  });

  it("台本の書き方の手引きを道具と resource で渡し、初めのやり取りで案内する", async () => {
    const guide = await call("scenario_guide");
    expect(guide.text).toContain("{r 漢字|かんじ}");
    expect(guide.text).toContain("## 式の関数");
    const init = (await server.handle({ id: ++id, method: "initialize", params: {} })) as { result: { instructions: string; capabilities: Record<string, unknown> } };
    expect(init.result.instructions).toContain("scenario_guide");
    expect(init.result.capabilities).toHaveProperty("resources");
    const list = (await server.handle({ id: ++id, method: "resources/list" })) as { result: { resources: { uri: string }[] } };
    const uri = list.result.resources[0]!.uri;
    const read = (await server.handle({ id: ++id, method: "resources/read", params: { uri } })) as { result: { contents: { text: string }[] } };
    expect(read.result.contents[0]!.text).toBe(guide.text);
    expect(((await server.handle({ id: ++id, method: "resources/read", params: { uri: "liminalia://nothing" } })) as { error?: object }).error).toBeDefined();
  });

  it("query は一覧と参照を JSON で返し、無い名前は誤りにする", async () => {
    const dir = join(root, "query-project");
    mkdirSync(join(dir, "scenario"), { recursive: true });
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "query", title: "参照", entry: "start" }));
    writeFileSync(join(dir, "scenario/start.lim"), "# intro\n@jump #intro\n");
    const inventory = await call("query", { project: "query-project", kind: "label" });
    expect(inventory.isError).toBe(false);
    expect(JSON.parse(inventory.text).items).toContainEqual({ name: "start#intro", definitions: 1, uses: 1 });
    const detail = await call("query", { project: "query-project", kind: "label", name: "start#intro" });
    expect(JSON.parse(detail.text)).toMatchObject({ found: true, uses: [expect.objectContaining({ role: "jump" })] });
    const missing = await call("query", { project: "query-project", kind: "var", name: "game.absent" });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.text).found).toBe(false);
  });

  it("作品の置き場の外と、scenario/ の外には触れない", async () => {
    const outside = mkdtempSync(join(tmpdir(), "liminalia-mcp-outside-"));
    try {
      expect((await call("check", { project: outside })).text).toContain("保存先");
      mkdirSync(join(root, "plain"));
      expect((await call("check", { project: "plain" })).isError).toBe(true);
      expect((await call("read_scenario", { project: "hoshi", file: "../liminalia.json" })).text).toContain("scenario/");
      expect((await call("create_project", { name: "../escape" })).isError).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("命令をやりたいことの言葉で引ける", async () => {
    const r = await call("command_reference", { query: "揺ら" });
    expect(r.text).toContain("@quake");
    expect(r.text).not.toContain("@bgm（");
  });

  it("命令を英語の言葉でも引ける", async () => {
    const r = await call("command_reference", { query: "fade to black" });
    expect(r.text).toContain("@mask（");
  });

  it("テーマを当て、公式のプラグインを入れ、素材を写す", { timeout: 60_000 }, async () => {
    expect((await call("set_theme", { project: "hoshi", theme: "night" })).isError).toBe(false);
    const config = () => JSON.parse(readFileSync(join(root, "hoshi", "liminalia.json"), "utf8")) as { ui?: { system?: { preset?: string } }; plugins?: string[] };
    expect(config().ui?.system?.preset).toBe("night");

    // 縦長専用のテーマは横長の作品に当てない（理由を返す。設定は変えない）
    const refused = await call("set_theme", { project: "hoshi", theme: "chat" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("縦長のプロジェクト専用");
    expect(config().ui?.system?.preset).toBe("night");

    const catalog = mkdtempSync(join(tmpdir(), "liminalia-mcp-catalog-"));
    const before = process.env.LIMINALIA_PLUGIN_CATALOG;
    process.env.LIMINALIA_PLUGIN_CATALOG = catalog;
    try {
      mkdirSync(join(catalog, "demo", "node_modules"), { recursive: true });
      writeFileSync(join(catalog, "demo", "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
      writeFileSync(join(catalog, "catalog.json"), JSON.stringify({ plugins: [{ id: "demo", name: "見本", nameEn: "Demo", description: "見本", descriptionEn: "Demo", folder: "demo" }] }));
      expect((await call("install_plugin", { project: "hoshi" })).text).toContain("demo: 見本");
      expect((await call("install_plugin", { project: "hoshi", id: "demo" })).isError).toBe(false);
      expect(existsSync(join(root, "hoshi", "plugins", "demo", "package.json"))).toBe(true);
      expect(existsSync(join(root, "hoshi", "plugins", "demo", "node_modules"))).toBe(false);
      expect(config().plugins).toEqual(["./plugins/demo"]);
    } finally {
      if (before === undefined) delete process.env.LIMINALIA_PLUGIN_CATALOG;
      else process.env.LIMINALIA_PLUGIN_CATALOG = before;
      rmSync(catalog, { recursive: true, force: true });
    }

    const src = join(root, "..", `liminalia-mcp-src-${process.pid}.png`);
    writeFileSync(src, "png");
    try {
      expect((await call("import_asset", { project: "hoshi", file: src, kind: "bgimage", name: "town/night.png" })).isError).toBe(false);
      expect(existsSync(join(root, "hoshi", "assets", "bgimage", "town", "night.png"))).toBe(true);
      expect((await call("import_asset", { project: "hoshi", file: src, kind: "bgimage", name: "../../escape.png" })).isError).toBe(true);
      // kind は enum の外を断る（.. で置き場の外へ書かせない。2026-11-20 の S1）
      for (const kind of ["../../..", "../x", "/tmp", "bgimage/../.."]) {
        expect((await call("import_asset", { project: "hoshi", file: src, kind, name: `escaped-${process.pid}.png` })).isError).toBe(true);
      }
      expect(existsSync(join(root, `escaped-${process.pid}.png`))).toBe(false);
      expect(existsSync(join(root, "..", `escaped-${process.pid}.png`))).toBe(false);
      // 素材でない種類のファイルと、隠しフォルダの中のファイルは写さない（S9）
      const secret = join(root, "..", `liminalia-mcp-secret-${process.pid}`);
      const hidden = join(root, "..", `.liminalia-mcp-hidden-${process.pid}`);
      writeFileSync(secret, "key");
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(hidden, "a.png"), "png");
      try {
        expect((await call("import_asset", { project: "hoshi", file: secret, kind: "others" })).isError).toBe(true);
        expect((await call("import_asset", { project: "hoshi", file: join(hidden, "a.png"), kind: "image" })).isError).toBe(true);
      } finally {
        rmSync(secret, { force: true });
        rmSync(hidden, { recursive: true, force: true });
      }
    } finally {
      rmSync(src, { force: true });
    }
  });

  it("PNG の透明でない部分を読む", () => {
    const info = imageInfoOf(rgbaPng(20, 30, 4, 6, 10, 20))!;
    expect(info.width).toBe(20);
    expect(info.bbox).toMatchObject({ left: 4, top: 6, width: 10, height: 20 });
    expect(imageInfoOf(rgbaPng(4, 4, 0, 0, 0, 0))!.bbox).toBeNull();
  });

  it("キャラクターを登録して立ち絵を結び、前の cast.json を残す", { timeout: 60_000 }, async () => {
    const src = mkdtempSync(join(tmpdir(), "liminalia-mcp-sprite-"));
    try {
      writeFileSync(join(src, "normal.png"), rgbaPng(400, 800, 100, 100, 200, 700));
      writeFileSync(join(src, "smile.png"), rgbaPng(400, 800, 100, 50, 200, 750));
      const r = await call("register_character", { project: "hoshi", id: "ミオ", color: "#3a7bd5", sprites: [{ file: join(src, "normal.png") }, { file: join(src, "smile.png"), variant: "笑う" }] });
      expect(r.isError).toBe(false);
      expect(r.text).toContain("@chara ミオ");
      const castFile = () => JSON.parse(readFileSync(join(root, "hoshi", "cast.json"), "utf8")) as { speakers: string[]; cast: Record<string, { color?: string; speaker?: string; appearances: Record<string, { variants: Record<string, { image: string; frame?: { height: number } }>; defaultVariant?: string }> }> };
      const mio = castFile().cast["ミオ"]!;
      expect(castFile().speakers).toContain("ミオ");
      expect(mio.color).toBe("#3a7bd5");
      expect(mio.appearances.default!.variants.normal!.image).toBe("ミオ/normal.png");
      expect(existsSync(join(root, "hoshi", "assets", "fgimage", "ミオ", "smile.png"))).toBe(true);
      // 二つ目の枠は一つ目に合わせる（人の背が高いので、枠は一つ目より少し小さい）
      const [first, second] = [mio.appearances.default!.variants.normal!.frame!, mio.appearances.default!.variants["笑う"]!.frame!];
      expect(first.height).toBeGreaterThan(0);
      expect(second.height).toBeLessThan(first.height);
      expect(readdirSync(join(root, "hoshi", ".liminalia", "backups")).some((f) => f.startsWith("cast-"))).toBe(true);
      // 話者名と基準の差分を変え、作品に置いた絵も使える
      const again = await call("register_character", { project: "hoshi", id: "ミオ", speaker: "澪", appearance: "制服", sprites: [{ file: "ミオ/smile.png", variant: "smile" }], defaultVariant: "smile" });
      expect(again.isError).toBe(false);
      expect(castFile().cast["ミオ"]!.speaker).toBe("澪");
      expect(castFile().speakers).toContain("澪");
      expect(castFile().cast["ミオ"]!.appearances["制服"]!.defaultVariant).toBe("smile");
      expect((await call("register_character", { project: "hoshi", id: "a b" })).isError).toBe(true);
      expect((await call("register_character", { project: "hoshi", id: "ミオ", sprites: [{ file: "nothing.png" }] })).isError).toBe(true);
      expect((await call("check", { project: "hoshi" })).text.split("\n").filter((l) => !l.includes("[unused-speaker]")).join("\n")).not.toContain("ミオ");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("作品の設定と変数の初期値を、読んだあとの変更を確かめて書き、履歴に残す", { timeout: 60_000 }, async () => {
    const read = JSON.parse((await call("read_settings", { project: "hoshi" })).text) as { settings: { title: string }; hash: string };
    expect(read.settings.title).toBe("星の見本");
    const ok = await call("update_settings", { project: "hoshi", settings: { version: "1.2.0", screen: { width: 1920, height: 1080 } }, baseHash: read.hash, variables: { "game.trust": 3 } });
    expect(ok.isError).toBe(false);
    const config = JSON.parse(readFileSync(join(root, "hoshi", "liminalia.json"), "utf8")) as { version: string; screen: { width: number }; variables: Record<string, unknown>; title: string };
    expect(config.version).toBe("1.2.0");
    expect(config.screen.width).toBe(1920);
    expect(config.title).toBe("星の見本");
    expect(config.variables["game.trust"]).toBe(3);
    expect(readdirSync(join(root, "hoshi", ".liminalia", "history", "@config")).length).toBeGreaterThan(0);
    // 古い hash では書かない
    const stale = await call("update_settings", { project: "hoshi", settings: { title: "別の題" }, baseHash: read.hash });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("1.2.0");
    // 形の誤りは理由を返す
    expect((await call("update_settings", { project: "hoshi", variables: { "temp.x": 1 } })).isError).toBe(true);
    expect((await call("update_settings", { project: "hoshi", settings: { screen: { width: 1280, height: 720 } }, variables: { "game.trust": null } })).isError).toBe(false);
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: [1] });
    // 外のコマンドを動かす設定と、置き場の外を指せる設定は MCP からは変えられない
    for (const settings of [
      { build: { windows: { wrap: ["/bin/sh", "-c", "touch /tmp/x #{file}"] } } },
      { build: { windows: { sign: { command: ["/bin/sh", "-c", "{file}"] } } } },
      { build: { store: { desktop: { module: "./evil.mjs" } } } },
      { paths: { scenario: "/tmp" } },
      { import: { tyrano: { source: "../x", profile: "./evil" } } },
      { allowScript: true },
    ]) {
      const r = await call("update_settings", { project: "hoshi", settings });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("MCP からは変えられません");
    }
    expect(readFileSync(join(root, "hoshi", "liminalia.json"), "utf8")).not.toContain("evil");
    // id は書き出したフォルダの名前になる（lim build browser はそのフォルダを消して置き直す）ので、置き場の外を指す id は書かない
    const badId = await call("update_settings", { project: "hoshi", settings: { id: "../../../../Documents" } });
    expect(badId.isError).toBe(true);
    expect(badId.text).toContain("id は英数字");
    expect(readFileSync(join(root, "hoshi", "liminalia.json"), "utf8")).not.toContain("Documents");
    expect(lockedSettingsChanged({ build: { windows: { wrap: ["a", "{file}"] } } }, { build: { windows: { wrap: ["a", "{file}"] }, browser: {} } })).toEqual([]);
  });

  it("制作画面の口で探し、地図・変数・文字数・全ルートテストを返し、ラベルの名前を変える", { timeout: 120_000 }, async () => {
    expect((await call("search", { project: "hoshi", query: "星", body: true })).text).toMatch(/start:\d+:/);
    expect((await call("search", { project: "hoshi", query: "(", regex: true })).isError).toBe(true);
    const map = await call("story_map", { project: "hoshi" });
    expect(map.text).toContain("はじめから: start");
    expect(map.text).toContain("選択肢");
    expect((await call("list_variables", { project: "hoshi" })).text).toContain("game.looked");
    expect((await call("text_stats", { project: "hoshi" })).text).toContain("全体: 台詞");
    const cov = await call("coverage", { project: "hoshi", runs: 2 });
    expect(cov.text).toMatch(/start: \d+\/\d+ 行/);
    writeFileSync(join(root, "hoshi", "scenario", "extra.lim"), "# 寄り道\n地の文\n@jump extra#寄り道\n");
    const renamed = await call("rename_label", { project: "hoshi", file: "extra", from: "寄り道", to: "回り道" });
    expect(renamed.isError).toBe(false);
    expect(readFileSync(join(root, "hoshi", "scenario", "extra.lim"), "utf8")).toBe("# 回り道\n地の文\n@jump extra#回り道\n");
    expect((await call("rename_label", { project: "hoshi", file: "extra", from: "無い", to: "x" })).isError).toBe(true);
  });

  it("書く前に読むもの: 人物の立ち絵セットと差分と立ち位置、マクロ、各行の舞台", { timeout: 120_000 }, async () => {
    const cast = JSON.parse((await call("read_cast", { project: "hoshi", who: "アカリ" })).text) as { speakers: string[]; cast: Record<string, { defaultAppearance: string; appearances: Record<string, { defaultVariant: string; variants: string[]; positions: string[] }> }> };
    expect(cast.speakers).toContain("アカリ");
    expect(Object.keys(cast.cast)).toEqual(["アカリ"]);
    expect(cast.cast.アカリ!.defaultAppearance).toBe("default");
    expect(cast.cast.アカリ!.appearances.default).toMatchObject({ defaultVariant: "normal", positions: expect.arrayContaining(["left", "center", "right", "auto"]) });
    expect(cast.cast.アカリ!.appearances.default!.variants).toEqual(expect.arrayContaining(["normal", "smile"]));
    expect((await call("read_cast", { project: "hoshi", who: "いない人" })).isError).toBe(true);
    // 自動配置の定位置（cast.json の side）と並べ方（liminalia.json の autoLayout）も返す
    const castPath = join(root, "hoshi", "cast.json");
    const castJson = JSON.parse(readFileSync(castPath, "utf8")) as { cast: Record<string, Record<string, unknown>> };
    castJson.cast.アカリ!.side = "left";
    writeFileSync(castPath, JSON.stringify(castJson));
    const configPath = join(root, "hoshi", "liminalia.json");
    writeFileSync(configPath, JSON.stringify({ ...(JSON.parse(readFileSync(configPath, "utf8")) as object), autoLayout: { enter: "start", byCount: { "3": { left: "center" } } } }));
    const placed = JSON.parse((await call("read_cast", { project: "hoshi", who: "アカリ" })).text) as { cast: Record<string, { side?: string }>; autoLayout?: unknown };
    expect(placed.cast.アカリ!.side).toBe("left");
    expect(placed.autoLayout).toEqual({ enter: "start", byCount: { "3": { left: "center" } } });

    writeFileSync(join(root, "hoshi", "scenario", "macros.lim"), "// 場面を変える\n@define change(place: asset(bgimage), time: duration = 1s)\n@content\n@end\n@with change place=x.png\n地の文\n@end\n");
    const macros = JSON.parse((await call("list_macros", { project: "hoshi" })).text) as { name: string; params: string[]; summary: string; content: boolean; calls: number }[];
    expect(macros.find((m) => m.name === "change")).toMatchObject({ params: ["place: asset(bgimage)", "time: duration = 1s"], summary: "場面を変える", content: true, calls: 1 });

    const start = readFileSync(join(root, "hoshi", "scenario", "start.lim"), "utf8").split("\n");
    const say = start.findIndex((l) => l.startsWith("アカリ「")) + 1;
    const state = JSON.parse((await call("line_state", { project: "hoshi", file: "start", line: say })).text) as { lines: { line: number; at: string; stage: { background: string | null; sprites?: { who: string }[] } }[] };
    expect(state.lines[0]).toMatchObject({ line: say, at: "before-page" });
    expect(state.lines[0]!.stage.background).toBeTruthy();
    expect((await call("line_state", { project: "hoshi", file: "start", from: 1, to: 80 })).isError).toBe(true);
  });

  it("fmt と coverage は、lim fmt と lim coverage と同じく、パック（packs/<フォルダ>/scenario）の台本も扱う（2026-11-19 の rest-p）", { timeout: 120_000 }, async () => {
    const pack = join(root, "hoshi", "packs", "extra");
    mkdirSync(join(pack, "scenario"), { recursive: true });
    writeFileSync(join(pack, "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    const bonus = join(pack, "scenario", "bonus.lim");
    writeFileSync(bonus, "# bonus\n@bg   x.png   time=1s\n地の文\n");
    try {
      const fmt = await call("fmt", { project: "hoshi" });
      expect(fmt.text).toContain("packs/extra/scenario/bonus");
      expect(readFileSync(bonus, "utf8")).toBe("# bonus\n@bg x.png time=1s\n地の文\n");
      // パックの台本だけを位置で選べる
      writeFileSync(bonus, "# bonus\n@bg   x.png\n地の文\n");
      expect((await call("fmt", { project: "hoshi", file: "packs/extra/scenario/bonus" })).text).toContain("packs/extra/scenario/bonus");
      expect(readFileSync(bonus, "utf8")).toBe("# bonus\n@bg x.png\n地の文\n");
      const cov = await call("coverage", { project: "hoshi", runs: 2 });
      expect(cov.text).toContain("packs/extra/scenario/bonus: 1/1 行");
    } finally {
      rmSync(join(root, "hoshi", "packs"), { recursive: true, force: true });
    }
  });

  it("台本を整え、直し方を当て、前の版に戻す（誤りが増えるなら書かない）", { timeout: 120_000 }, async () => {
    const file = join(root, "hoshi", "scenario", "fix.lim");
    writeFileSync(file, "@bg   x.png   time=1s\n");
    expect((await call("fmt", { project: "hoshi", file: "fix" })).text).toContain("fix");
    expect(readFileSync(file, "utf8")).toBe("@bg x.png time=1s\n");
    // 綴りの誤り（time → tme）を、直し方で直す
    writeFileSync(file, "@quake tme=1s\n");
    const fixed = await call("apply_fixes", { project: "hoshi", file: "fix" });
    expect(fixed.text).toContain("当てた直し方");
    expect(readFileSync(file, "utf8")).toBe("@quake time=1s\n");
    expect((await call("apply_fixes", { project: "hoshi", file: "fix" })).isError).toBe(true);
    // 一つ前の版（直す前）に戻すと誤りが増えるので戻さない。allowErrors なら戻す
    const refused = await call("restore_scenario", { project: "hoshi", file: "fix" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("addedErrors");
    expect(readFileSync(file, "utf8")).toBe("@quake time=1s\n");
    expect((await call("restore_scenario", { project: "hoshi", file: "fix", list: true })).text).toMatch(/^\d{8}-\d{6}-\d{3}/);
    const restored = await call("restore_scenario", { project: "hoshi", file: "fix", allowErrors: true });
    expect(restored.text).toContain("のバージョンに戻します");
    expect(readFileSync(file, "utf8")).toBe("@quake tme=1s\n");
    // edit_scenario も、誤りが増えるなら書かない
    writeFileSync(file, "地の文\n");
    const edit = await call("edit_scenario", { project: "hoshi", file: "fix", edits: [{ from: 1, to: 1, expect: "地の文", text: "@jump nowhere" }] });
    expect(edit.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("地の文\n");
  });

  it("同じ所に重なって当てなかった直し方の数を返事に出し、もう一度呼ぶと当てる（lim check --fix と同じ。2026-11-19 の X5）", { timeout: 120_000 }, async () => {
    const file = join(root, "hoshi", "scenario", "overlap.lim");
    // fade= の名前の直し（renamed-param）と、単位を足す直し（bad-value）が同じ所に重なる
    writeFileSync(file, "@bg hill_dusk.webp fade=300\n");
    // bad-value の文が引数の名前（fade: → time:）で変わり、増えた誤りに見えるので allowErrors で書く
    const first = await call("apply_fixes", { project: "hoshi", file: "overlap", allowErrors: true });
    expect(first.text).toContain("同じ所に重なる直し方が 1 件あり、当てませんでした");
    expect(readFileSync(file, "utf8")).toBe("@bg hill_dusk.webp time=300\n");
    const second = await call("apply_fixes", { project: "hoshi", file: "overlap" });
    expect(second.text).toContain("当てた直し方");
    expect(second.text).not.toContain("重なる直し方");
    expect(readFileSync(file, "utf8")).toBe("@bg hill_dusk.webp time=300ms\n");
  });

  it("訳を合わせ、未訳をページで読み、鍵ごとに書く（書き方の誤りは書かない）。ボイスの台本を返す", { timeout: 120_000 }, async () => {
    const synced = await call("i18n_sync", { project: "hoshi", language: "fr" });
    expect(synced.isError).toBe(false);
    const fr = JSON.parse(readFileSync(join(root, "hoshi", "lang", "fr.json"), "utf8")) as { ui: Record<string, { source: string; text: string }> };
    expect(fr.ui["title.start"]).toEqual({ source: "New Game", text: "" });
    const page = JSON.parse((await call("read_translation", { project: "hoshi", language: "fr", file: "start", limit: 2 })).text) as { hash: string; total: number; next: number; items: { key: string; kind: string; source: string; place: { file: string; line: number } }[] };
    expect(page.items).toHaveLength(2);
    expect(page.next).toBe(2);
    expect(page.items[0]!.place.file).toBe("start");
    const line = page.items.find((i) => i.kind === "line")!;
    const w = await call("write_translation", {
      project: "hoshi",
      language: "fr",
      baseHash: page.hash,
      entries: [
        { key: line.key, text: "Bonjour", source: line.source },
        { key: page.items.find((i) => i !== line)!.key, text: "{b cassé" },
        { key: "ui:title.start", text: "Nouvelle partie" },
      ],
    });
    expect(w.isError).toBe(true);
    const report = JSON.parse(w.text.slice(w.text.indexOf("{"))) as { applied: number; rejected: { entry: number }[] };
    expect(report.applied).toBe(2);
    expect(report.rejected.map((r) => r.entry)).toEqual([2]);
    const after = JSON.parse(readFileSync(join(root, "hoshi", "lang", "fr.json"), "utf8")) as { lines: Record<string, { text: string }>; ui: Record<string, { text: string }> };
    expect(after.lines[line.key]!.text).toBe("Bonjour");
    expect(after.ui["title.start"]!.text).toBe("Nouvelle partie");
    // 読んだあとで変わっていれば書かない
    expect((await call("write_translation", { project: "hoshi", language: "fr", baseHash: page.hash, entries: [{ key: line.key, text: "Salut" }] })).text).toContain("読み直して");
    const voices = JSON.parse((await call("voice_script", { project: "hoshi", limit: 3 })).text) as { total: number; rows: { speaker: string; file: string }[] };
    expect(voices.total).toBeGreaterThan(0);
    expect(voices.rows.length).toBeLessThanOrEqual(3);
  });

  it("開いている制作画面があれば、別の開発サーバーを立てずにそれを使い、その開発サーバーで撮る", { timeout: 30_000 }, async () => {
    const asked: unknown[] = [];
    const http = createServer((req, res) => {
      if (req.url === "/__liminalia/studio/api/server") return res.end(JSON.stringify({ root: join(root, "hoshi"), pid: process.pid }));
      if (req.url === "/__liminalia/studio/api/shot/play") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          asked.push(JSON.parse(body));
          res.setHeader("Content-Type", "image/png");
          res.end(Buffer.from("png!"));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const remove = announceStudio(join(root, "hoshi"), url, "desktop");
    try {
      const open = await call("open_studio", { project: "hoshi" });
      expect(open.isError).toBe(false);
      expect(open.text).toContain(`${url}/__liminalia/studio`);
      expect(open.text).toContain("Liminalia Studio");
      const r = (await server.handle({ id: ++id, method: "tools/call", params: { name: "screenshot", arguments: { project: "hoshi", start: "start", skip: 3 } } })) as { result: { content: { type: string; data?: string; text?: string }[] } };
      expect(r.result.content[0]).toMatchObject({ type: "image", data: Buffer.from("png!").toString("base64") });
      expect(asked).toEqual([{ start: "start", skip: 3 }]);
      // 言語を決めて撮る（lim shot の --lang）
      await server.handle({ id: ++id, method: "tools/call", params: { name: "screenshot", arguments: { project: "hoshi", title: true, lang: "en" } } });
      expect(asked.at(-1)).toEqual({ title: true, lang: "en" });
    } finally {
      remove();
      await new Promise((r) => http.close(r));
    }
  });

  it("台本のテスト、届く道、書式の移し、名前の変更、テストプレイの記録、録画の道具がある", { timeout: 240_000 }, async () => {
    expect((await call("create_project", { name: "kaze" })).isError).toBe(false);
    // ci なら GitHub Actions の検査のひな形も置く（lim new --ci）
    expect((await call("create_project", { name: "umi", ci: true })).isError).toBe(false);
    expect(existsSync(join(root, "umi", ".github", "workflows", "liminalia-check.yml"))).toBe(true);
    const list = (await server.handle({ id: ++id, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["run_tests", "reach", "migrate", "rename", "playtest", "read_playtest_log", "record_video", "read_crash_report"]));
    // 台本のテスト（lim test --json）
    const tests = await call("run_tests", { project: "kaze" });
    expect(tests.isError).toBe(false);
    expect(JSON.parse(tests.text)).toMatchObject({ ok: true, failed: 0 });
    expect((await call("run_tests", { project: "kaze", paths: ["../outside.limtest"] })).isError).toBe(true);
    // 届く道（lim reach --json）
    const reach = await call("reach", { project: "kaze", target: "start:141" });
    expect(reach.isError).toBe(false);
    expect(JSON.parse(reach.text)).toMatchObject({ ok: true, test: expect.stringContaining("expect reach start:141") });
    expect((await call("reach", { project: "kaze" })).isError).toBe(true);
    // 書式の移し（既定は確かめるだけ）
    const migrate = await call("migrate", { project: "kaze" });
    expect(migrate.isError).toBe(false);
    expect(JSON.parse(migrate.text)).toMatchObject({ ok: true, written: false });
    // 名前の変更（lim rename のすべての種類）
    const renamed = await call("rename", { project: "kaze", kind: "variable", from: "game.looked", to: "game.peeked" });
    expect(renamed.isError).toBe(false);
    expect(readFileSync(join(root, "kaze", "scenario", "start.lim"), "utf8")).toContain("game.peeked");
    expect((await call("rename", { project: "kaze", kind: "nothing", from: "a", to: "b" })).isError).toBe(true);
    // テストプレイの記録（lim playtest --log の dist/playtest/run-N.jsonl）
    expect((await call("read_playtest_log", { project: "kaze" })).isError).toBe(true);
    const logDir = join(root, "kaze", "dist", "playtest");
    mkdirSync(logDir, { recursive: true });
    const rows = [
      { kind: "page", n: 1, at: "start:20", name: "", text: "坂の上に", t: 10 },
      { kind: "choice", n: 2, at: "start:40", options: ["のぞく", "見上げる"], pick: 1, avoided: [], t: 20 },
      { kind: "page", n: 3, at: "start:45", name: "ソウ", text: "それもいい", t: 30 },
      { kind: "end", outcome: "stuck", pages: 3, at: "start:45", seconds: 1, t: 40 },
    ];
    writeFileSync(join(logDir, "run-1.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const log = await call("read_playtest_log", { project: "kaze" });
    expect(log.isError).toBe(false);
    const read = JSON.parse(log.text) as { runs: number[]; run: number; total: number; end: { outcome: string }; entries: { kind: string }[] };
    expect(read).toMatchObject({ runs: [1], run: 1, total: 3, end: { outcome: "stuck" } });
    expect(read.entries.map((e) => e.kind)).toEqual(["page", "choice", "page"]);
    const page = JSON.parse((await call("read_playtest_log", { project: "kaze", offset: 1, limit: 1 })).text) as { entries: { at: string }[] };
    expect(page.entries.map((e) => e.at)).toEqual(["start:40"]);
    // 止まったときの記録（lim crash --json）。合うソースマップが無くても台本の位置を返す
    writeFileSync(join(root, "kaze", "crash.json"), JSON.stringify({ message: "x", stack: "", kind: "error", at: "start:3", version: "1", build: "2026-01-01T00:00:00.000Z", date: "", userAgent: "" }));
    const crash = await call("read_crash_report", { project: "kaze", file: "crash.json" });
    expect(JSON.parse(crash.text)).toMatchObject({ ok: false, at: "start:3", maps: null });
    expect((await call("read_crash_report", { project: "kaze", file: "../crash.json" })).isError).toBe(true);
    // 録画の出力先は作品の書き出し先の中だけ
    expect((await call("record_video", { project: "kaze", start: "start", out: "../x.mp4" })).isError).toBe(true);
  });

  it("標準の画面の一覧を返し、撮る前に画面の名前、状態、向き、テーマを確かめる", { timeout: 120_000 }, async () => {
    const list = (await server.handle({ id: ++id, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_screens", "screen_shot"]));
    expect(list.result.tools.find((t) => t.name === "screen_shot")!.inputSchema.required).toEqual(["project", "screen"]);

    // 作品なしでも一覧を返す（部品の表、テーマの値、CSS の変数、差し替えの口）
    type Listed = { screens: { id: string; opens: boolean; states: string[]; why?: { ja: string }; theme: string[]; vars: string[]; replace: string[]; parts: { name: { ja: string; en: string }; selector: string; values: { path: string; var?: string }[] }[] }[]; systemVars: string[]; themes?: { id: string; portraitOnly?: true }[] };
    const all = await call("list_screens");
    expect(all.isError).toBe(false);
    const listed = JSON.parse(all.text) as Listed;
    expect(listed.screens.length).toBeGreaterThan(30);
    expect(listed.themes).toBeUndefined();
    expect(listed.systemVars).toContain("--lm-accent");
    const saveload = listed.screens.find((s) => s.id === "saveload")!;
    expect(saveload).toMatchObject({ opens: true, states: ["empty", "long"], replace: ["screens.saveload"] });
    expect(saveload.theme).toContain("saveSlots");
    expect(saveload.parts.find((p) => p.selector === ".lm-slots")!.values).toEqual([{ path: "saveSlots" }]);
    expect(saveload.parts.find((p) => p.selector === ".lm-slot-name")!.values).toEqual([{ path: "system.accent", var: "--lm-accent" }]);
    expect(listed.screens.find((s) => s.id === "gate")).toMatchObject({ opens: false, why: { ja: expect.any(String) } });

    // 作品を渡すと選べるテーマも返し、screen で一つに絞る
    expect((await call("create_project", { name: "mado" })).isError).toBe(false);
    const one = JSON.parse((await call("list_screens", { project: "mado", screen: "ending" })).text) as Listed;
    expect(one.screens.map((s) => s.id)).toEqual(["ending"]);
    expect(one.themes!.map((t) => t.id)).toEqual(expect.arrayContaining(["default", "night", "chat"]));
    expect(one.themes!.find((t) => t.id === "chat")!.portraitOnly).toBe(true);
    expect((await call("list_screens", { screen: "nothing" })).isError).toBe(true);

    // 撮る前の確かめ（Chromium を立てずに、選べるものを返す）
    const unknown = await call("screen_shot", { project: "mado", screen: "nothing" });
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining("saveload") });
    const gate = await call("screen_shot", { project: "mado", screen: "gate" });
    expect(gate).toMatchObject({ isError: true, text: expect.stringContaining("見本で開けません") });
    const noLong = await call("screen_shot", { project: "mado", screen: "config", state: "long" });
    expect(noLong).toMatchObject({ isError: true, text: expect.stringContaining("filled") });
    expect((await call("screen_shot", { project: "mado", screen: "saveload", state: "full" })).isError).toBe(true);
    expect((await call("screen_shot", { project: "mado", screen: "saveload", orientation: "sideways" })).isError).toBe(true);
    const noTheme = await call("screen_shot", { project: "mado", screen: "saveload", theme: "nothing" });
    expect(noTheme).toMatchObject({ isError: true, text: expect.stringContaining("night") });
    // 縦長専用のテーマは、横長の作品では縦長にして撮る
    const chat = await call("screen_shot", { project: "mado", screen: "saveload", theme: "chat" });
    expect(chat).toMatchObject({ isError: true, text: expect.stringContaining("--portrait") });
    expect((await call("screen_shot", { project: "mado" })).isError).toBe(true);
    expect((await call("screen_shot", { project: "nothing", screen: "saveload" })).isError).toBe(true);
  });

  it("標準の画面のテンプレートを写し、画面のファイルを読み書きし、標準との違いを見る（写す → 直す → 撮って確かめる）", { timeout: 120_000 }, async () => {
    const list = (await server.handle({ id: ++id, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["copy_screen", "read_screen_files", "write_screen_file", "diff_screen"]));
    expect((await call("create_project", { name: "waku" })).isError).toBe(false);
    const dir = join(root, "waku");

    // 写す前に読むと、標準のテンプレートと、決まりの置き場所を返す
    type Files = { screen: string; template: { file: string; registered: boolean; text: string | null }; standard: string; parts: string[]; script: { file: string; text: string | null }; css: { file: string; text: string | null }[] };
    const before = JSON.parse((await call("read_screen_files", { project: "waku", screen: "confirm" })).text) as Files;
    expect(before).toMatchObject({ screen: "confirm", template: { file: "ui/screens/confirm/confirm.html", registered: false, text: null }, parts: ["screen"], script: { file: "ui/screens/confirm/confirm.js", text: null } });
    expect(before.standard).toContain('data-part="screen"');

    // 写す（画面の JS の雛形も）。結果と、写した直後のテンプレートの検査（何も無い）
    const copied = await call("copy_screen", { project: "waku", screen: "confirm", js: true });
    expect(copied.isError).toBe(false);
    expect(JSON.parse(copied.text)).toMatchObject({ file: "ui/screens/confirm/confirm.html", parts: ["screen"], registered: true, script: "ui/screens/confirm/confirm.js", diagnostics: [] });
    expect((JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui: { templates: Record<string, string> } }).ui.templates).toEqual({ confirm: "ui/screens/confirm/confirm.html" });
    // あるファイルは force が無ければ書かない
    expect(await call("copy_screen", { project: "waku", screen: "confirm" })).toMatchObject({ isError: true, text: expect.stringContaining("もうあります") });
    expect((await call("copy_screen", { project: "waku", screen: "nothing" })).isError).toBe(true);
    expect((await call("copy_screen", { project: "waku", screen: "confirm", parts: ["row"], force: true })).isError).toBe(true);

    // テンプレートを書くと、書いたあとのテンプレートの検査を返す
    const html = (JSON.parse((await call("read_screen_files", { project: "waku", screen: "confirm" })).text) as Files).template.text!;
    const broken = await call("write_screen_file", { project: "waku", screen: "confirm", kind: "template", text: html.replace('data-role="ok"', 'data-role="okay"').replace('data-version="2"', 'data-version="0"') });
    const wrote = JSON.parse(broken.text) as { file: string; ok: boolean; diagnostics: { code: string; line: number }[] };
    expect(wrote.file).toBe("ui/screens/confirm/confirm.html");
    expect(wrote.ok).toBe(false);
    expect(wrote.diagnostics.map((d) => d.code).sort()).toEqual(["template-missing-role", "template-outdated", "template-unknown-value"]);
    expect(readFileSync(join(dir, "ui/screens/confirm/confirm.html"), "utf8")).toContain('data-role="okay"');

    // 標準との違い（作品の直しと、写した元の版から変わったところ）
    const diff = JSON.parse((await call("diff_screen", { project: "waku", screen: "confirm" })).text) as { parts: { part: string; authorDiff: string; standardChange: unknown }[]; text: string };
    expect(diff.parts[0]!.authorDiff).toContain('+      <button class="lm-button lm-primary" data-role="okay"');
    expect(diff.parts[0]!.standardChange).toMatchObject({ from: 0, now: 2 });
    expect(diff.text).toContain("作品のテンプレートと今の標準の違い");

    // 画面の JS と作品の CSS を書く（CSS は ui.css に登録が無ければ ui/screens.css に書いて登録する）
    const js = JSON.parse((await call("write_screen_file", { project: "waku", screen: "confirm", kind: "script", text: "export default (screen, api) => { api.answer(true); };\n" })).text) as { file: string; diagnostics: { code: string }[] };
    // 画面の検査はテンプレートと JS の両方を返す
    expect(js).toMatchObject({ file: "ui/screens/confirm/confirm.js", diagnostics: expect.arrayContaining([expect.objectContaining({ code: "template-script-unknown", file: "ui/screens/confirm/confirm.js" }), expect.objectContaining({ code: "template-missing-role" })]) });
    const css = JSON.parse((await call("write_screen_file", { project: "waku", screen: "confirm", kind: "css", text: ".lm-dialog { border-radius: 0; }\n" })).text) as { file: string; registered: boolean; diagnostics: unknown[] };
    expect(css).toEqual({ file: "ui/screens.css", registered: true, ok: true, diagnostics: [] });
    expect((JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui: { css: string[] } }).ui.css).toEqual(["ui/screens.css"]);
    const after = JSON.parse((await call("read_screen_files", { project: "waku", screen: "confirm" })).text) as Files;
    expect(after.css).toEqual([{ file: "ui/screens.css", text: ".lm-dialog { border-radius: 0; }\n" }]);
    expect(after.script.text).toContain("api.answer");
    expect((await call("write_screen_file", { project: "waku", screen: "confirm", kind: "css", file: "../x.css", text: "" })).isError).toBe(true);
    expect((await call("write_screen_file", { project: "waku", screen: "confirm", kind: "image", text: "" })).isError).toBe(true);
  });

  it("置き場は --root と環境変数から決まり、無ければ ~/Liminalia", () => {
    expect(mcpRoots(["/a"], "/b:/a")).toEqual(["/a", "/b"]);
    expect(mcpRoots([], undefined)[0]).toMatch(/Liminalia$/);
  });
});

describe("書くと増える誤り（addedErrors）", () => {
  const err = (code: string, message: string, line = 1) => ({ severity: "error" as const, code, message, file: "start", line });
  it("直し方を当てて同じ誤りの文だけが変わったときは、増えたと数えない（2026-11-20）", () => {
    // @bg … fade=300 に apply_fixes を当てると、bad-value の文が書いた名前（fade:）から今の名前（time:）に変わる
    expect(addedErrors([err("bad-value", "fade: 時間には単位が必要です")], [err("bad-value", "time: 時間には単位が必要です", 3)])).toEqual([]);
  });
  it("同じ種類でも数が増えれば、前に無い文のものを返す", () => {
    const before = [err("unknown-param", "@bg に x はありません")];
    const after = [err("unknown-param", "@bg に x はありません", 5), err("unknown-param", "@bg に y はありません", 6)];
    expect(addedErrors(before, after)).toEqual([after[1]]);
  });
  it("別の種類の誤りは、前の誤りが減っても増えたと数える", () => {
    expect(addedErrors([err("bad-value", "a")], [err("missing-param", "b")])).toEqual([err("missing-param", "b")]);
  });
});
