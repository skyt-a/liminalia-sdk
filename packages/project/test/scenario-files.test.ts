import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPackSources, listScenarioFiles, loadProject, projectFlow, projectScripts } from "../src/index.ts";

describe("台本の一覧", () => {
  const dirs: string[] = [];
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-scenario-files-"));
    dirs.push(dir);
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "t", title: "t", entry: "start" }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, "scenario", name, ".."), { recursive: true });
      writeFileSync(join(dir, "scenario", name), text);
    }
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("サブフォルダの台本も、/ 区切りで拡張子のない名前で集める（. で始まるものと .lim でないものは見ない）", () => {
    const dir = project({
      "start.lim": "あ\n",
      "part1/chapter2.lim": "い\n",
      "part1/deep/end.lim": "う\n",
      "part1/memo.txt": "メモ",
      ".trash/old.lim": "え\n",
      "part1/.draft.lim": "お\n",
    });
    const files = listScenarioFiles(join(dir, "scenario"));
    expect(files.map((f) => f.name)).toEqual(["part1/chapter2", "part1/deep/end", "start"]);
    expect(files[0]!.path).toBe(join(dir, "scenario", "part1", "chapter2.lim"));
    expect(listScenarioFiles(join(dir, "none"))).toEqual([]);
  });

  it("projectScripts とフローチャートもサブフォルダの台本を読む", async () => {
    const dir = project({
      "start.lim": "はじめ\n@jump part1/chapter2#top\n",
      "part1/chapter2.lim": "# top\nつづき\n",
    });
    const p = loadProject(dir);
    expect([...projectScripts(p).keys()]).toEqual(["part1/chapter2", "start"]);
    const flow = await projectFlow(p);
    // サブフォルダの台本の本文もページとして数える
    expect(flow.pages["part1/chapter2"]).toEqual([2]);
  });
});

describe("listPackSources（パックの台本と訳。2026-11-19 の r1）", () => {
  it("遊ぶ側と同じ並び（pack.json の order、id の順）で、台本、訳、話者を読む。pack.json の無いフォルダは読まない", () => {
    const root = mkdtempSync(join(tmpdir(), "liminalia-packs-"));
    try {
      const pack = (folder: string, manifest: Record<string, unknown> | null, files: Record<string, string>) => {
        mkdirSync(join(root, "packs", folder), { recursive: true });
        if (manifest) writeFileSync(join(root, "packs", folder, "pack.json"), JSON.stringify(manifest));
        for (const [rel, text] of Object.entries(files)) {
          mkdirSync(join(root, "packs", folder, rel, ".."), { recursive: true });
          writeFileSync(join(root, "packs", folder, rel), text);
        }
      };
      pack("a-late", { id: "zeta", order: 2 }, { "scenario/x.lim": "# x\n" });
      pack("b-early", { id: "beta", order: 1 }, { "scenario/sub/y.lim": "# y\n", "lang/en.json": "{}", "cast.json": JSON.stringify({ speakers: ["ミオ"] }) });
      pack("c-same", { id: "alpha", order: 1 }, {});
      pack("d-none", null, { "scenario/z.lim": "# z\n" });
      const list = listPackSources(root);
      expect(list.map((p) => [p.dir, p.id])).toEqual([
        ["packs/c-same", "alpha"],
        ["packs/b-early", "beta"],
        ["packs/a-late", "zeta"],
      ]);
      expect([...list[1]!.scripts.keys()]).toEqual(["sub/y"]);
      expect([...list[1]!.translations.keys()]).toEqual(["en"]);
      expect(list[1]!.speakers).toEqual(["ミオ"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
