import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryKind, queryProject } from "../src/commands/query.ts";

let root: string;
function put(file: string, text: string) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lim-query-"));
  put("liminalia.json", JSON.stringify({ id: "query", title: "参照", entry: "start#intro", afterLoad: "start#intro", variables: { "game.count": 0 }, scenes: { "start#intro": { title: "入口" } }, extra: { replay: [{ id: "intro", title: "入口", target: "start#intro" }] }, ui: { title: { background: "room.png" } } }, null, 2));
  put("cast.json", JSON.stringify({ speakers: [], cast: {} }));
  put("scenario/start.lim", "# intro\n@set game.count += 1\n{= game.count.value}\n@bg room.png\n@bg (game.background)\n@call #intro\n@choice\n- 戻る -> #intro\n@end\n@jump start#intro\n@set temp.image = \"bgimage/guess.png\"\n@bg missing.png\n");
  put("assets/bgimage/room.png", "image");
  put("assets/bgimage/guess.png", "image");
  put("tests/story.limtest", "# test\nfrom start#intro\nset game.count = 2\nexpect game.count == 2\nexpect reach start#intro\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lim query", () => {
  it("マクロの variable 引数への書き込みを集める", async () => {
    put("scenario/start.lim", "@define save(into: variable)\n@end\n@save into=game.saved\n");
    expect(await queryProject(root, "var", "game.saved")).toMatchObject({ found: true, uses: [expect.objectContaining({ file: "scenario/start.lim", line: 3, role: "write" })] });
  });
  it("他のファイルのマクロは @use したファイルだけに適用する", async () => {
    put("scenario/lib.lim", "@define bg(image: asset(fgimage))\n@end\n@define sleep-game(target: string)\n@end\n@define save(into: variable)\n@end\n");
    put("scenario/start.lim", "# intro\n@bg room.png\n@bg (game.image)\n@sleep-game target=#intro\n");
    put("scenario/imported.lim", "@use lib\n@bg image=room.png\n@bg image=(game.image)\n@save into=game.imported\n");
    put("scenario/own.lim", "@define bg(image: asset(image))\n@end\n@bg image=room.png\n");
    put("scenario/transitive.lim", "@use imported\n@save into=game.hidden\n");
    expect(await queryProject(root, "asset", "bgimage/room.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "scenario/start.lim", line: 2, role: "asset" })]), dynamic: [expect.objectContaining({ file: "scenario/start.lim", line: 3 })] });
    expect(await queryProject(root, "asset", "fgimage/room.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "scenario/imported.lim", line: 2, role: "asset" })]), dynamic: [expect.objectContaining({ file: "scenario/imported.lim", line: 3 })] });
    expect(await queryProject(root, "asset", "image/room.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "scenario/own.lim", line: 3, role: "asset" })]) });
    expect(await queryProject(root, "label", "start#intro")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "scenario/start.lim", line: 4, role: "target" })]) });
    expect(await queryProject(root, "var", "game.imported")).toMatchObject({ found: true, uses: [expect.objectContaining({ file: "scenario/imported.lim", line: 4, role: "write" })] });
    expect(await queryProject(root, "var", "game.hidden")).toMatchObject({ found: false });
  });
  it("ラベルの定義、ジャンプ・呼出・選択肢と設定・テストの参照を集める", async () => {
    const r = await queryProject(root, "label", "start#intro");
    if (!("found" in r)) throw new Error("detail expected");
    expect(r.found).toBe(true);
    expect(r.definitions).toEqual([expect.objectContaining({ file: "scenario/start.lim", line: 1, role: "def" })]);
    expect(r.uses.map((s) => s.role)).toEqual(expect.arrayContaining(["jump", "call", "choice", "config", "test"]));
    expect(r.uses.filter((s) => s.role === "config")).toHaveLength(4);
    expect(await queryProject(root, "label", "intro")).toEqual(r);
    expect(await queryProject(root, "label", "start")).toMatchObject({ found: true });
  });
  it("変数の初期値、複合代入の読み書き、入れ子とテストを数える", async () => {
    const r = await queryProject(root, "var", "game.count.value");
    if (!("found" in r)) throw new Error("detail expected");
    expect(r).toMatchObject({ found: true, name: "game.count", definitions: [expect.objectContaining({ file: "liminalia.json", role: "def" })] });
    expect(r.uses).toEqual(expect.arrayContaining([expect.objectContaining({ line: 2, role: "write" }), expect.objectContaining({ line: 2, role: "read" }), expect.objectContaining({ line: 3, role: "read" }), expect.objectContaining({ file: "tests/story.limtest", role: "read" })]));
  });
  it("素材の実在、静的参照・設定・推測・動的な候補を区別する", async () => {
    put("cast.json", JSON.stringify({ speakers: [], cast: { person: { appearances: { normal: { variants: { normal: { image: "person.png" } } } } } } }, null, 2));
    put("assets/fgimage/person.png", "image");
    const r = await queryProject(root, "asset", "bgimage/room.png");
    expect(r).toMatchObject({ found: true, exists: true, definitions: [expect.objectContaining({ role: "def" })], uses: expect.arrayContaining([expect.objectContaining({ role: "asset" }), expect.objectContaining({ role: "config" })]), dynamic: [expect.objectContaining({ role: "dynamic" })] });
    expect(await queryProject(root, "asset", "bgimage/guess.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ role: "guess" })]) });
    expect(await queryProject(root, "asset", "bgimage/missing.png")).toMatchObject({ found: true, exists: false, definitions: [] });
    expect(await queryProject(root, "asset", "fgimage/person.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "cast.json", role: "cast" })]) });
  });
  it("ドットを含む設定の素材キーも実際の JSON の行を指す", async () => {
    put("liminalia.json", JSON.stringify({ id: "query", title: "参照", entry: "start", ui: { backgroundTones: { "room.png": "warm" }, nvlStyles: { "dark.mode/~": { image: "frame.png" } }, help: { pages: [{ image: "help.png" }] } } }, null, 2));
    expect(await queryProject(root, "asset", "bgimage/room.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "liminalia.json", line: 7, role: "config", text: '"room.png": "warm"' })]) });
    expect(await queryProject(root, "asset", "image/frame.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "liminalia.json", line: 11, role: "config", text: '"image": "frame.png"' })]) });
    expect(await queryProject(root, "asset", "image/help.png")).toMatchObject({ uses: expect.arrayContaining([expect.objectContaining({ file: "liminalia.json", line: 17, role: "config", text: '"image": "help.png"' })]) });
  });
  it("一覧は名前順、無い名前には候補を返す", async () => {
    for (const kind of ["label", "var", "asset"] as const) {
      const r = await queryProject(root, kind);
      if (!("items" in r)) throw new Error("inventory expected");
      expect(r.items.map((s) => s.name)).toEqual(r.items.map((s) => s.name).sort((a, b) => a.localeCompare(b, "en")));
    }
    expect(await queryProject(root, "var", "game.coun")).toMatchObject({ found: false, definitions: [], uses: [], candidates: ["game.count"] });
    expect(await queryProject(root, "label", "start#intr")).toMatchObject({ found: false, candidates: expect.arrayContaining(["start#intro"]) });
    expect(await queryProject(root, "asset", "bgimage/rom.png")).toMatchObject({ found: false, candidates: expect.arrayContaining(["bgimage/room.png"]) });
    expect(queryKind("variables")).toBe("var");
    expect(() => queryKind("wrong")).toThrow("label | var | asset");
  });
  it("空の作品の一覧と読めない作品を扱う", async () => {
    put("scenario/start.lim", "本文\n");
    put("liminalia.json", JSON.stringify({ id: "query", title: "参照", entry: "start" }));
    put("tests/story.limtest", "");
    expect(await queryProject(root, "var")).toEqual({ kind: "var", items: [] });
    await expect(queryProject(join(root, "missing"), "label")).rejects.toThrow();
  });
  it("CLI は文字・JSON・終了コードと英語の案内を返す", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve("packages/cli/bin/lim.mjs"), "query", root, ...args], { encoding: "utf8" });
    const text = run("var", "game.count");
    expect(text.status).toBe(0); expect(text.stdout).toContain("read");
    const json = run("label", "start#intro", "--json");
    expect(json.status).toBe(0); expect(JSON.parse(json.stdout)).toMatchObject({ kind: "label", found: true });
    const missing = run("var", "game.coun", "--lang", "en");
    expect(missing.status).toBe(1); expect(missing.stdout).toContain("Not found"); expect(missing.stdout).toContain("game.count");
    expect(run("bad").status).toBe(2);
  });
});
