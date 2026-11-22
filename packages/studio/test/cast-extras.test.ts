import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { castBackup, castBackups, castUsage } from "../src/server/manage.ts";
import { readStudioState, writeStudioState } from "../src/server/studio-state.ts";

/** キャラクターの画面の材料: 差分ごとの使った回数、cast.json の変更履歴、メモ。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-cast-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("差分ごとの使った回数", () => {
  it("差分を書いた行を数え、立ち絵セットを省いた行は既定の立ち絵セットに数える", () => {
    writeFileSync(join(dir, "scenario/extra.lim"), "# extra\n@chara アカリ smile at=left\n@chara アカリ smile appearance=default\n@chara アカリ at=right\n@chara アカリ nope\n@chara-hide アカリ\n");
    const usage = castUsage(ws);
    const text = ["start", "epilogue"].map((f) => readFileSync(join(dir, `scenario/${f}.lim`), "utf8")).join("\n");
    const inStart = (variant: string) => text.split("\n").filter((l) => new RegExp(`^\\s*@chara アカリ ${variant}(\\s|$)`).test(l)).length;
    expect(usage.variants?.["アカリ"]?.["default"]?.["smile"]).toBe(inStart("smile") + 2);
    expect(usage.variants?.["アカリ"]?.["default"]?.["normal"]).toBe(inStart("normal"));
    // cast.json に無い差分は数えない
    expect(usage.variants?.["アカリ"]?.["default"]?.["nope"]).toBeUndefined();
  });
});

describe("cast.json の変更履歴", () => {
  it("新しい順に並べ、一つずつ読める。current は今の cast.json", () => {
    const backups = join(dir, ".liminalia/backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "cast-20260101-090000-000.json"), '{"cast":{}}\n');
    writeFileSync(join(backups, "cast-20260102-090000-000.json"), '{"cast":{"a":{}}}\n');
    writeFileSync(join(backups, "tatie-settings-20260103-090000-000.js"), "x");
    const list = castBackups(ws);
    expect(list.map((e) => e.id)).toEqual(["20260102-090000-000", "20260101-090000-000"]);
    expect(new Date(list[0]!.time).getDate()).toBe(2);
    expect(castBackup(ws, list[1]!.id).text).toBe('{"cast":{}}\n');
    expect(castBackup(ws, "current").text).toBe(readFileSync(join(dir, "cast.json"), "utf8"));
    expect(() => castBackup(ws, "../liminalia")).toThrow(/ありません/);
  });
});

describe("キャラクターのメモ", () => {
  it("制作画面の覚え書きに置き、空のものは残さない", () => {
    writeStudioState(ws.project, { castNotes: { アカリ: "声: 未定", ソウ: "  " } });
    expect(readStudioState(ws.project).castNotes).toEqual({ アカリ: "声: 未定" });
  });
});
