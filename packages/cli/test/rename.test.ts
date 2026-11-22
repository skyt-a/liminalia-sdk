import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** lim rename（制作画面の名前の変更と同じ書き換え）。ひな形の写しで動かす。 */

const bin = new URL("../bin/lim.mjs", import.meta.url).pathname;
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-rename-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lim = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd: dir });
const scenario = (file: string) => readFileSync(join(dir, "scenario", `${file}.lim`), "utf8");

describe("lim rename", () => {
  it("変数: 台本と初期値を書き換える", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")), variables: { "game.looked": false } }, null, 2));
    const r = lim("rename", "variable", "game.looked", "game.watched");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("game.looked を game.watched に変更しました");
    expect(scenario("start")).not.toMatch(/game\.looked\b/);
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).variables).toEqual({ "game.watched": false });
  }, 60_000);

  it("シーン、ファイル、キャラクター、話者、素材、マクロ", () => {
    expect(lim("rename", "label", "start#night", "yoru").status).toBe(0);
    expect(scenario("start")).toMatch(/^# yoru$/m);
    expect(lim("rename", "file", "epilogue", "after").status).toBe(0);
    expect(existsSync(join(dir, "scenario", "after.lim"))).toBe(true);
    expect(scenario("start")).toContain("@jump after");
    expect(scenario("start")).not.toContain("@jump epilogue");
    expect(lim("rename", "character", "アカリ", "akari").status).toBe(0);
    expect(scenario("start")).toContain("@chara akari normal");
    expect(lim("rename", "speaker", "ソウ", "蒼").status).toBe(0);
    expect(scenario("start")).toMatch(/^蒼「/m);
    expect(lim("rename", "asset", "bgimage/hill_dusk.webp", "bgimage/dusk.webp").status).toBe(0);
    expect(existsSync(join(dir, "assets", "bgimage", "dusk.webp"))).toBe(true);
    expect(scenario("start")).toContain("@bg dusk.webp");
    writeFileSync(join(dir, "scenario", "parts.lim"), "@define card(text: string)\n@wait 1s\n@end\n\n# p\n@card text=a\n");
    const m = lim("rename", "macro", "card", "title-card");
    expect(m.status, m.stderr).toBe(0);
    expect(scenario("parts")).toBe("@define title-card(text: string)\n@wait 1s\n@end\n\n# p\n@title-card text=a\n");
  }, 120_000);

  it("台本のテストと章の設定も書き換え、名前を変えたあとも lim test が通る", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")), chapters: [{ id: "c1", title: "一", files: ["start"] }, { id: "c2", title: "二", files: ["epilogue"] }] }, null, 2));
    const file = lim("rename", "file", "epilogue", "last");
    expect(file.status, file.stderr).toBe(0);
    expect(file.stdout).toContain("テストも書き換えました（tests/start.limtest）");
    expect(file.stdout).toContain("chapters.c2.files");
    const variable = lim("rename", "variable", "game.looked", "game.peeked", "--lang", "en");
    expect(variable.status, variable.stderr).toBe(0);
    expect(variable.stdout).toContain("Also rewrote tests (tests/start.limtest)");
    const test = readFileSync(join(dir, "tests", "start.limtest"), "utf8");
    expect(test).toContain("expect reach last#dawn");
    expect(test).toContain("expect !game.peeked && game.wished");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).chapters[1].files).toEqual(["last"]);
    const run = lim("test");
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toContain("3 件中 3 件が通りました");
  }, 120_000);

  it("無い名前、使えない名前、知らない種類は 1 か 2 で終わり、理由を出す（--lang en で英語）", () => {
    const missing = lim("rename", "variable", "game.nothing", "game.x");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("game.nothing は台本と liminalia.json のどこにもありません");
    const bad = lim("rename", "character", "アカリ", "a b");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("名前として使えません");
    const en = lim("rename", "character", "アカリ", "a b", "--lang", "en");
    expect(en.stderr).toContain("Not a usable name");
    const kind = lim("rename", "colour", "a", "b");
    expect(kind.status).toBe(1);
    expect(kind.stderr).toContain("label、file、variable");
    expect(lim("rename", "variable", "game.x").status).toBe(2);
  }, 120_000);
});
