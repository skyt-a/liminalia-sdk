import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonSyntaxError, lineColumn, placeConfigLines, readConfigJson } from "@liminalia/lang";
import { ConfigError, configSchema, loadProject, readCast, voiceLockProblem } from "../src/index.ts";
import { generateConfigSchemas, SCHEMA_OUTPUTS, VSCODE_SCHEMA_DIR, vscodeOnlySchemas } from "../scripts/config-schema-gen.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TEMPLATE = resolve(REPO, "templates/default");

describe("設定の JSON Schema", () => {
  it("型（ProjectConfig、CastEntry、TranslationFile）から作ったものと同じ（型を直したら scripts/config-schema.ts を流す）", { timeout: 60_000 }, () => {
    const schemas = generateConfigSchemas(REPO);
    for (const dir of SCHEMA_OUTPUTS) {
      for (const [name, schema] of Object.entries(schemas)) expect(JSON.parse(readFileSync(join(REPO, dir, name), "utf8")), `${dir}/${name}`).toEqual(schema);
    }
    for (const [name, schema] of Object.entries(vscodeOnlySchemas(schemas))) expect(JSON.parse(readFileSync(join(REPO, VSCODE_SCHEMA_DIR, name), "utf8")), name).toEqual(schema);
  });

  it("VS Code の lang/*.json の Schema は、Liminalia の訳のファイルの形（language と lines がある）のときだけ訳の Schema で確かめる", { timeout: 60_000 }, () => {
    const schemas = generateConfigSchemas(REPO);
    const file = vscodeOnlySchemas(schemas)["lang-file.schema.json"] as { if: unknown; then: Record<string, unknown> };
    // ほかの作品の lang/*.json（Web の訳など）には当てない
    expect(file.if).toEqual({ type: "object", required: ["language", "lines"] });
    const { $schema: _schema, title: _title, ...lang } = schemas["lang.schema.json"]!;
    expect(file.then).toEqual(lang);
  });

  it("VS Code の拡張機能が liminalia.json、cast.json、訳のファイル（lang/*.json）に Schema を当てる", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "packages/vscode/package.json"), "utf8")) as { contributes: { jsonValidation: { fileMatch: string; url: string }[] } };
    expect(pkg.contributes.jsonValidation).toEqual([
      { fileMatch: "liminalia.json", url: "./schemas/liminalia.schema.json" },
      { fileMatch: "cast.json", url: "./schemas/cast.schema.json" },
      { fileMatch: "lang/*.json", url: "./schemas/lang-file.schema.json" },
    ]);
    // 当てる Schema はどれも拡張機能に入れてある
    for (const { url } of pkg.contributes.jsonValidation) expect(existsSync(join(REPO, "packages/vscode", url)), url).toBe(true);
  });

  it("知らない項目を、近い名前の案と置き換える直し方つきで警告する（入れ子の項目と $schema も）", () => {
    const text = '{\n  "$schema": "./x.json",\n  "id": "a",\n  "title": "t",\n  "entry": "start",\n  "buidl": { "icon": "a.png" },\n  "build": { "iocn": "a.png" }\n}';
    const r = readConfigJson(text, "liminalia.json", configSchema("liminalia"));
    expect(r.diagnostics.map((d) => [d.line, d.code, d.hint, d.fix])).toEqual([
      [6, "unknown-config-key", "build のことですか？", { kind: "replace", find: '"buidl"', with: '"build"' }],
      [7, "unknown-config-key", "icon のことですか？", { kind: "replace", find: '"iocn"', with: '"icon"' }],
    ]);
    const cast = readConfigJson('{ "speakers": ["ユイ"], "cast": { "ユイ": { "appearances": {}, "colour": "#fff" } } }', "cast.json", configSchema("cast"));
    expect(cast.diagnostics.map((d) => d.hint)).toEqual(["color のことですか？"]);
  });
});

describe("設定の JSON の読めない所", () => {
  it("行と桁と分かる文で示す", () => {
    const at = (text: string) => {
      const e = jsonSyntaxError(text)!;
      return { ...lineColumn(text, e.offset), reason: e.reason };
    };
    expect(at('{\n  "a": 1,\n}')).toEqual({ line: 3, column: 1, reason: "最後の項目のあとの , は書けません" });
    expect(at('{\n  "a": 1\n  "b": 2\n}')).toEqual({ line: 3, column: 3, reason: "値のあとに , か } が必要です（前の行の終わりの , を忘れていませんか）" });
    expect(at('{\n  // メモ\n  "a": 1\n}').reason).toBe("JSON にはコメントを書けません");
    expect(at('{"a": tru}').reason).toBe('値として読めません（文字列は "…" で囲みます）');
    expect(at('{"a": 1').reason).toBe("途中で終わっています（閉じ括弧か値が足りません）");
    expect(jsonSyntaxError('{"a": [1, 2], "b": {"c": null}}')).toBeNull();
  });
});

describe("liminalia.json と cast.json の読み込み", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-config-"));
    cpSync(TEMPLATE, dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;

  it("読めない JSON は、位置つきの ConfigError", () => {
    const original = config();
    writeFileSync(join(dir, "liminalia.json"), '{\n  "id": "a",\n}\n');
    expect(() => loadProject(dir)).toThrow(ConfigError);
    expect(() => loadProject(dir)).toThrow("liminalia.json:3:1 JSON として読めません: 最後の項目のあとの , は書けません");
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(original));
    writeFileSync(join(dir, "cast.json"), '{ "speakers": ["ユイ"] "cast": {} }');
    expect(() => readCast(loadProject(dir))).toThrow("cast.json:1:22 JSON として読めません: 値のあとに , か } が必要です");
  });

  it("variables の一つの誤りで全体を止めず、その項目を使わずに知らせる", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config(), variables: { "game.ok": 1, "bad name": 2 }, saves: { location: "desk" } }, null, 2));
    const project = loadProject(dir);
    expect(project.config.variables).toEqual({ "game.ok": 1 });
    expect(project.config.saves?.location).toBeUndefined();
    expect(project.problems?.map((p) => [p.code, p.message])).toEqual([
      ["bad-config", 'liminalia.json の variables の bad name は "game.名前" か "system.名前" で書きます'],
      ["bad-config", 'liminalia.json の saves.location は "user" か "portable" です'],
    ]);
  });
});

describe("設定の形の誤りの行", () => {
  const text = ["{", '  "id": "a",', '  "commandDefaults": {', '    "bg": {', '      "fade": "(1)"', "    }", "  },", '  "ui": {', '    "window": {', '      "padding": "x"', "    }", "  },", '  "chapters": []', "}", ""].join("\n");
  const at = (code: string, message: string, file = "liminalia.json") => placeConfigLines([{ severity: "error", code, message, file, line: 1 }], text, "liminalia.json")[0]!.line;

  it("文の中の設定の道、@命令 の パラメータ、code の項目の行へ移す", () => {
    expect(at("bad-ui", "ui.window.padding は数で書きます")).toBe(10);
    expect(at("bad-ui", "ui.window.nothing は数で書きます")).toBe(9);
    expect(at("bad-command-defaults", "@bg の fade の既定値に式は書けません")).toBe(5);
    expect(at("bad-chapters", "章の id が重なっています")).toBe(13);
    // 項目の無いもの、ほかのファイル、1 行目でないものはそのまま
    expect(at("bad-items", "items はオブジェクトで書きます")).toBe(1);
    expect(at("bad-ui", "ui.window.padding は数で書きます", "cast.json")).toBe(1);
  });

  it("voice-lock.json の JSON の書き方の誤りに、行と桁を付ける", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-voice-lock-"));
    try {
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "voice-lock.json"), '{\n  "lines": {\n    "a": 1,\n  }\n}\n');
      const project = loadProject(dir);
      expect(voiceLockProblem(project, new Error("x"))).toMatchObject({ code: "bad-voice-lock", file: "voice-lock.json", line: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
