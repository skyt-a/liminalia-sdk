import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { readScenes, setCheckSeverity, setSceneInfo } from "../src/server/check-config.ts";
import { readSettings, setSettings } from "../src/server/manage.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

describe("検査の設定とシーンの情報を liminalia.json に書く", () => {
  let dir: string;
  let ws: StudioWorkspace;
  const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown> & { check?: Record<string, unknown>; scenes?: Record<string, unknown> };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-check-config-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario/extra.lim"), "# extra\nそれは…\n@jump side\n");
    writeFileSync(join(dir, "scenario/side.lim"), "// lim: draft\n# side\n書きかけ\n");
    ws = await StudioWorkspace.open(loadProject(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("「この種類を出さない」は check.severity に off を書き、チェックの結果から外れる。null で外し、空になれば check も外す", () => {
    expect(ws.check().diagnostics.some((d) => d.code === "single-ellipsis")).toBe(true);
    setCheckSeverity(ws, "single-ellipsis", "off");
    expect(config().check).toEqual({ severity: { "single-ellipsis": "off" } });
    expect(ws.check().diagnostics.some((d) => d.code === "single-ellipsis")).toBe(false);
    expect(ws.projectInfo().severity).toEqual({ "single-ellipsis": "off" });
    setCheckSeverity(ws, "single-ellipsis", null);
    expect(config().check).toBeUndefined();
    expect(() => setCheckSeverity(ws, "Bad Code", "off")).toThrow();
    expect(() => setCheckSeverity(ws, "x", "quiet")).toThrow();
  });

  it("下書きのファイルの印と、下書きへ移る行の警告", () => {
    expect(ws.projectInfo().files.find((f) => f.file === "side")?.draft).toBe(true);
    expect(ws.projectInfo().files.find((f) => f.file === "extra")?.draft).toBeUndefined();
    expect(ws.check().diagnostics.filter((d) => d.code === "draft-target").map((d) => `${d.file}:${d.line}`)).toEqual(["extra:3"]);
  });

  it("シーンの情報は pov、date、place を書き、ほかの項目は残し、空にすると外す。無いシーンは断る", () => {
    setSceneInfo(ws, "extra#extra", { pov: "アカリ", date: " 8/12 ", place: "" });
    expect(readScenes(ws)).toEqual({ "extra#extra": { pov: "アカリ", date: "8/12" } });
    const raw = config();
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...raw, scenes: { "extra#extra": { pov: "アカリ", era: "past" } } }, null, 2));
    setSceneInfo(ws, "extra#extra", { pov: "", date: "", place: "丘" });
    expect(config().scenes).toEqual({ "extra#extra": { era: "past", place: "丘" } });
    setSceneInfo(ws, "extra", { pov: "ソウ" });
    expect(Object.keys(config().scenes!)).toEqual(["extra#extra", "extra"]);
    expect(() => setSceneInfo(ws, "extra#nowhere", { pov: "x" })).toThrow();
    expect(() => setSceneInfo(ws, "nothing", { pov: "x" })).toThrow();
  });

  it("作品の設定の check と format は形を確かめ、起動し直さなくても効く", () => {
    const base = readSettings(ws);
    expect(setSettings(ws, { ...base, check: { severity: { "single-ellipsis": "off" } }, fmt: { indent: 2 } })).toMatchObject({ ok: true, restart: false });
    expect(config().fmt).toEqual({ indent: 2 });
    expect(ws.projectInfo().formatIndent).toBe(2);
    expect(() => setSettings(ws, { ...base, check: { severity: { x: "quiet" } } })).toThrow();
    expect(() => setSettings(ws, { ...base, fmt: { indent: 12 } })).toThrow();
  });

  it("色調の名前の引数（@tone、@bg の tone=）の候補に、作品の ui.tones で決めた名前を足す", () => {
    const suggest = (command: string) => (ws.projectInfo().commands.find((c) => c.name === command)?.params.tone?.type as { suggest?: string[] } | undefined)?.suggest ?? [];
    expect(suggest("tone")).not.toContain("dusk");
    const raw = config();
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...raw, ui: { ...(raw.ui as object), tones: { dusk: { color: "#c08040", amount: 0.4 } } } }, null, 2));
    expect(suggest("tone")).toEqual(expect.arrayContaining(["sepia", "none", "dusk"]));
    expect(suggest("bg")).toContain("dusk");
    expect(suggest("scene-change")).toContain("dusk");
  });

  it("NVL の見た目の名前の引数（@nvl on style=）の候補に、作品の ui.nvlStyles の名前を入れる", () => {
    const suggest = () => (ws.projectInfo().commands.find((c) => c.name === "nvl")?.params.style?.type as { suggest?: string[] } | undefined)?.suggest ?? [];
    expect(suggest()).toEqual([]);
    const raw = config();
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...raw, ui: { ...(raw.ui as object), nvlStyles: { letter: { color: "#302010" }, terminal: { font: "monospace" } } } }, null, 2));
    expect(suggest()).toEqual(["letter", "terminal"]);
  });

  it("チェックに、設定の JSON の読めない所（行と桁）、型に無い項目、UTF-8 で読めない台本を出す（lim check と同じ）", () => {
    const text = readFileSync(join(dir, "liminalia.json"), "utf8");
    writeFileSync(join(dir, "liminalia.json"), text.replace(/"title":/, '"titel": "x",\n  "title":'));
    let found = ws.check().diagnostics;
    expect(found.find((d) => d.code === "unknown-config-key")).toMatchObject({ file: "liminalia.json", line: 3 });
    writeFileSync(join(dir, "liminalia.json"), text.replace(/\n}\s*$/, ",\n}\n"));
    found = ws.check().diagnostics;
    expect(found.find((d) => d.code === "bad-config")).toMatchObject({ file: "liminalia.json", line: text.trimEnd().split("\n").length });
    writeFileSync(join(dir, "liminalia.json"), text);
    // 「あいう」の Shift_JIS
    writeFileSync(join(dir, "scenario/sjis.lim"), Buffer.from([0x23, 0x20, 0x61, 0x0a, 0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x0a]));
    found = ws.check().diagnostics.filter((d) => d.file === "sjis");
    expect(found.map((d) => d.code)).toEqual(["bad-encoding"]);
  });
});
