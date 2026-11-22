import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { backportProject, importTyrano, makeBackportBase, readTatieSettings, readTyranoConfig, TATIE_SETTINGS, writeTatieSettings } from "../src/node.ts";
import { readWindowAssignments } from "../src/js-literal.ts";
import { gitState } from "../src/project.ts";
import { isPlainRelative, unsafeWriteTarget, within } from "../src/safe-path.ts";

/**
 * 他人の TyranoScript のプロジェクトをインポートするときの安全の確かめ。
 * インポート元のファイルを実行しない、インポート元の外のファイルを読まない、書き戻しでリンクの先を上書きしない、
 * インポート元で git を呼んでもリポジトリの設定のコマンドを走らせない。
 */
const registry = createRegistry(CORE_COMMANDS);
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-safety-"));
  temps.push(dir);
  return dir;
};
const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
const canSymlink = process.platform !== "win32";
let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

describe("settings.js は実行せずにリテラルとして読む", () => {
  it("JavaScript のオブジェクトのリテラルの書き方（コメント、末尾のカンマ、引用符のないキー、単一引用符、数の書き方）を読む", () => {
    const src = [
      "\uFEFF// 立ち絵の設定",
      "/* 複数行の",
      "   コメント */",
      "window.A = {",
      "  schemaVersion: 2, // 行末のコメント",
      "  'single': 'it\\'s',",
      '  "double": "改行\\nと\\u3042と\\x41と\\u{1F600}",',
      "  list: [1, -2, +3, 0.5, .25, 1e3, 0x10, 1_000, true, false, null,],",
      "  nested: { 日本語のキー: { deep: [] }, 10: 'ten' },",
      "};",
      'window["B"] = [ ]',
      "window.C = 'no semicolon'",
    ].join("\n");
    const out = readWindowAssignments(src);
    expect(out.get("A")).toEqual({
      schemaVersion: 2,
      single: "it's",
      double: "改行\nとあとAと\u{1F600}",
      list: [1, -2, 3, 0.5, 0.25, 1000, 16, 1000, true, false, null],
      nested: { 日本語のキー: { deep: [] }, 10: "ten" },
    });
    expect(out.get("B")).toEqual([]);
    expect(out.get("C")).toBe("no semicolon");
  });

  it("関数の呼び出し、変数の参照、計算、テンプレート文字列、__proto__ のキーは読めない", () => {
    const bad = [
      'window.A = window.constructor.constructor("return process")();',
      "window.A = (function () { return {}; })();",
      "window.A = { a: foo };",
      "window.A = { a: 1 + 1 };",
      "window.A = { a: `x` };",
      "window.A = { __proto__: { polluted: true } };",
      'window.A = { "__proto__": 1 };',
      "window.A = { a: 1 }; alert(1);",
      "var x = 1;",
      "window.A = {",
      "window.A = { a: 1 } window.B = 2",
      "window.A = [1,,2]",
      "window.A = 012",
    ];
    for (const src of bad) expect(() => readWindowAssignments(src), src).toThrow(/行目: /);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("実行すると印のファイルを作る settings.js を読んでも、印は作られず、読めないと報告する", () => {
    const dir = temp();
    const source = join(dir, "tyrano");
    cpSync(fixture("tatie-project"), source, { recursive: true });
    const marker = join(dir, "marker");
    const payload = `window.TYRANO_TATIE_SETTINGS = (window.constructor.constructor("return process")().getBuiltinModule("fs").writeFileSync(${JSON.stringify(marker)}, "x"), {});\n`;
    writeFileSync(join(source, TATIE_SETTINGS), payload);
    const read = readTatieSettings(source);
    expect(read.cast).toEqual({});
    expect(read.notes).toEqual([expect.stringMatching(/^tatie の設定を読めません（1 行目: /)]);
    expect(() => writeTatieSettings(source, {}, { backupDir: join(dir, "backups") })).toThrow(/tatie の設定を読めません/);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(source, TATIE_SETTINGS), "utf8")).toBe(payload);
  });

  it("今までの settings.js（fixtures/tatie-project）はそのまま読めて、書き戻しも同じ形", () => {
    const dir = temp();
    const source = join(dir, "tyrano");
    cpSync(fixture("tatie-project"), source, { recursive: true });
    const cast = readTatieSettings(source).cast;
    expect(Object.keys(cast)).toEqual(["mio", "sora"]);
    writeTatieSettings(source, cast, { backupDir: join(dir, "backups") });
    expect(readTatieSettings(source).cast).toEqual(cast);
  });
});

describe("インポート元の外のファイルは読まない", () => {
  it.skipIf(!canSymlink)("[call storage=../…] と、外を指すシンボリックリンクのマクロ、画像、設定は読まずに報告する", async () => {
    const dir = temp();
    const source = join(dir, "tyrano");
    cpSync(fixture("chara-project"), source, { recursive: true });
    // インポート元の外にあるファイル
    writeFileSync(join(dir, "secret.ks"), '[macro name="leak_call"]外の秘密その一[p][endmacro]\n');
    writeFileSync(join(dir, "linked.ks"), '[macro name="leak_link"]外の秘密その二[p][endmacro]\n');
    mkdirSync(join(dir, "outside-images"));
    cpSync(join(source, "data/fgimage/chara/ren/normal.png"), join(dir, "outside-images/ren.png"));
    writeFileSync(join(dir, "Config.tjs"), ';System.title = "外のタイトル"\n');
    symlinkSync(join(dir, "linked.ks"), join(source, "data/scenario/system/linked.ks"));
    symlinkSync(join(dir, "outside-images"), join(source, "data/fgimage/outside"));
    mkdirSync(join(source, "data/system"), { recursive: true });
    symlinkSync(join(dir, "Config.tjs"), join(source, "data/system/Config.tjs"));
    appendFileSync(join(source, "data/scenario/system/chara_define.ks"), '[chara_new name="haru" storage="outside/ren.png" jname="ハル" width="300"]\n');
    appendFileSync(join(source, "data/scenario/scene1.ks"), '[call storage="../../../secret.ks"]\n[leak_call]\n[leak_link]\n');

    const out = join(dir, "out");
    const report = await importTyrano({
      source,
      scenarioOut: join(out, "scenario"),
      dataOut: join(out, "data"),
      castOut: join(out, "cast.json"),
      reportOut: join(out, "import-report.md"),
      registry,
      profile: { skipFiles: ["first"] },
    });
    const written = readdirSync(join(out, "scenario")).map((f) => readFileSync(join(out, "scenario", f), "utf8")).join("\n");
    expect(written).not.toContain("外の秘密");
    // 外の画像の大きさは読まないので、枠（width だけから縦横比で決める高さ）は無い
    const cast = JSON.parse(readFileSync(join(out, "cast.json"), "utf8")) as { cast: Record<string, { appearances: Record<string, { variants: Record<string, { frame?: unknown }> }> }> };
    expect(cast.cast.haru!.appearances.default!.variants.default!.frame).toBeUndefined();
    expect(cast.cast.ren!.appearances.default!.variants.default!.frame).toEqual({ width: 300, height: 600 });
    const outside = report.manual.filter((m) => m.includes("[outside-project]"));
    expect(outside.map((m) => m.split(" ")[0]).sort()).toEqual(["../secret.ks", "data/fgimage/outside/ren.png", "data/scenario/system/linked.ks"]);
    expect(report.ok).toBe(false);
    expect(report.markdown).toContain("インポート元のプロジェクトの外を指すため、読み込みません");
    // 外を指す Config.tjs も読まない
    expect(readTyranoConfig(source).title).not.toBe("外のタイトル");
  });

  it.skipIf(!canSymlink)("中を指すシンボリックリンクと、ふつうのプロジェクトは今までどおり読む", async () => {
    const dir = temp();
    const source = join(dir, "tyrano");
    cpSync(fixture("chara-project"), source, { recursive: true });
    mkdirSync(join(source, "shared"));
    writeFileSync(join(source, "shared/inner.ks"), '[macro name="inner"]中の文[p][endmacro]\n');
    symlinkSync(join(source, "shared/inner.ks"), join(source, "data/scenario/system/inner.ks"));
    appendFileSync(join(source, "data/scenario/scene2.ks"), "[inner]\n");
    const out = join(dir, "out");
    const report = await importTyrano({
      source,
      scenarioOut: join(out, "scenario"),
      dataOut: join(out, "data"),
      castOut: join(out, "cast.json"),
      reportOut: join(out, "import-report.md"),
      registry,
      profile: { skipFiles: ["first"] },
    });
    expect(report.manual).toEqual([]);
    expect(report.ok).toBe(true);
    expect(readFileSync(join(out, "scenario/macros.lim"), "utf8")).toContain("中の文");
  });
});

describe("プロトタイプをたどる変数", () => {
  it("[eval exp=\"f.__proto__.x=…\"] をインポートすると、書き出した .lim のチェックでエラーになる", async () => {
    const dir = temp();
    const source = join(dir, "tyrano");
    mkdirSync(join(source, "data/scenario"), { recursive: true });
    writeFileSync(join(source, "data/scenario/scene.ks"), '[eval exp="f.__proto__.polluted=1"]\n[eval exp="f.ok=1"]\n本文[p]\n');
    const out = join(dir, "out");
    const report = await importTyrano({
      source,
      scenarioOut: join(out, "scenario"),
      dataOut: join(out, "data"),
      castOut: join(out, "cast.json"),
      reportOut: join(out, "import-report.md"),
      registry,
    });
    expect(readFileSync(join(out, "scenario/scene.lim"), "utf8")).toContain("@set game.__proto__.polluted = 1");
    expect(report.checkErrors).toEqual([expect.stringContaining("scene.lim:1 [forbidden-property] __proto__ は変数の名前やキーに使えません")]);
    expect(report.ok).toBe(false);
  });
});

describe("書き戻しはインポート元の data/scenario の外に書かない", () => {
  it("パスの確かめ", () => {
    expect(isPlainRelative("scene1.ks")).toBe(true);
    expect(isPlainRelative("system/a.ks")).toBe(true);
    for (const bad of ["", "../a.ks", "system/../../a.ks", "/etc/a.ks", "C:\\a.ks", "\\\\server\\a.ks", "a\\..\\..\\b.ks"]) expect(isPlainRelative(bad), bad).toBe(false);
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/b", "/a/b/c")).toBe(true);
    expect(within("/a/b", "/a/bc")).toBe(false);
    expect(within("/a/b", "/a")).toBe(false);
  });

  it.skipIf(!canSymlink)("シンボリックリンクのファイルとフォルダ、../ には書かない", () => {
    const dir = temp();
    const root = join(dir, "scenario");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(dir, "victim.ks"), "元のまま");
    mkdirSync(join(dir, "victim-dir"));
    symlinkSync(join(dir, "victim.ks"), join(root, "link.ks"));
    symlinkSync(join(dir, "victim-dir"), join(root, "linkdir"));
    expect(unsafeWriteTarget(root, "a.ks")).toBeNull();
    expect(unsafeWriteTarget(root, "sub/a.ks")).toBeNull();
    expect(unsafeWriteTarget(root, "new/a.ks")).toBeNull();
    expect(unsafeWriteTarget(root, "link.ks")).toMatch(/シンボリックリンク/);
    expect(unsafeWriteTarget(root, "linkdir/a.ks")).toMatch(/シンボリックリンク/);
    expect(unsafeWriteTarget(root, "../victim.ks")).toMatch(/外/);
  });

  // 作品の基準を作り（バージョン管理のコマンドを起こす）、書き戻す
  it.skipIf(!canSymlink)("lim backport --write は、インポート元でシンボリックリンクになった .ks を書かずに refused にする", { timeout: 60_000 }, async () => {
    const dir = temp();
    const tyrano = join(dir, "tyrano");
    cpSync(fixture("backport-project"), tyrano, { recursive: true });
    const project = join(dir, "game");
    mkdirSync(project);
    writeFileSync(join(project, "liminalia.json"), JSON.stringify({ id: "t", title: "t", entry: "scene1", plugins: [] }));
    await importTyrano({
      source: tyrano,
      scenarioOut: join(project, "scenario"),
      dataOut: join(project, "data"),
      castOut: join(project, "cast.json"),
      reportOut: join(project, "import-report.md"),
      registry,
      profile: {},
    });
    const base = join(project, "tyrano-base");
    await makeBackportBase(project, base, tyrano);

    // 基準を作ったあとで、インポート元の scene1.ks を外のファイル（中身は同じ）へのリンクにすり替える
    const victim = join(dir, "victim.ks");
    const original = readFileSync(join(tyrano, "data/scenario/scene1.ks"), "utf8");
    writeFileSync(victim, original);
    rmSync(join(tyrano, "data/scenario/scene1.ks"));
    symlinkSync(victim, join(tyrano, "data/scenario/scene1.ks"));

    const lim = join(project, "scenario");
    writeFileSync(join(lim, "scene1.lim"), readFileSync(join(lim, "scene1.lim"), "utf8").replace("北の道を進んだ。", "北の道を歩いた。"));
    writeFileSync(join(lim, "scene2.lim"), readFileSync(join(lim, "scene2.lim"), "utf8").replace("どちらも暗い。", "どちらも明るい。"));
    const r = await backportProject(project, { base, tyrano, write: true, force: true });
    expect(r.refused).toEqual(["scene1.ks"]);
    expect(r.copied).toEqual(["scene2.ks"]);
    expect(readFileSync(victim, "utf8")).toBe(original);
    expect(readFileSync(join(tyrano, "data/scenario/scene2.ks"), "utf8")).toContain("どちらも明るい。");
  });
});

describe.skipIf(!hasGit || process.platform === "win32")("インポート元で git を呼んでも、リポジトリの設定のコマンドを走らせない", () => {
  // git を何度も起こすので、テストを並べて走らせて重いときは 5 秒を超える
  it("core.fsmonitor、フィルタ、フックに書いたコマンドは走らず、状態は読める", { timeout: 30_000 }, () => {
    const dir = temp();
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "data/scenario"), { recursive: true });
    writeFileSync(join(repo, "data/scenario/a.ks"), "一\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    // 走ったら印のファイルを作るだけのコマンドを、リポジトリの設定に書く（設定を書くだけでは走らない）。
    // 編集器や探索の見張りが新しいリポジトリを裏で除くことがあり、その git が設定のコマンドをいつ走らせるかは制御できないので、
    // 印には「走らせた git のコマンド行」を記して、私たちの呼び方（-c core.hooksPath=…liminalia-git-hooks-… が必ずある）に
    // よるものだけを誤りとする
    const mark = (name: string) => {
      const path = join(dir, name);
      return `sh -c 'ppid=$(ps -o ppid= -p $PPID | tr -d " "); ps -o args= -p $PPID >> ${path}; ps -o args= -p $ppid >> ${path}; exit 1'`;
    };
    appendFileSync(
      join(repo, ".git/config"),
      `\n[core]\n\tfsmonitor = ${JSON.stringify(mark("fsmonitor"))}\n[filter "mark"]\n\tclean = ${JSON.stringify(`${mark("filter")}; cat`)}\n\tprocess = ${JSON.stringify(mark("process"))}\n\trequired = true\n`,
    );
    writeFileSync(join(repo, ".gitattributes"), "*.ks filter=mark\n");
    writeFileSync(join(repo, ".git/hooks/post-index-change"), `#!/bin/sh\n${mark("hook")}\n`, { mode: 0o755 });
    // 長さが同じ変更（git は中身を比べるため、フィルタの clean を通す）
    writeFileSync(join(repo, "data/scenario/a.ks"), "二\n");

    const state = gitState(repo, "data/scenario");
    expect(state).not.toBeNull();
    expect(state!.dirty).toEqual(["data/scenario/a.ks"]);
    expect(state!.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const name of ["fsmonitor", "filter", "process", "hook"]) {
      const path = join(dir, name);
      // 見張りが走らせた分は私たちのコマンド行を持たないので誤りにしない。私たちの git なら、runGit が必ず付ける
      // -c core.hooksPath=…liminalia-git-hooks-… がコマンド行に残る（打ち消しに失敗して走ったら、その行が印に記される）
      if (existsSync(path)) expect(readFileSync(path, "utf8"), name).not.toContain("liminalia-git-hooks-");
    }
  });
});
