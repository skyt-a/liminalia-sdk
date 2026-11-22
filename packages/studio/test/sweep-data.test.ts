import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";

/**
 * 現在地を作るとき（はじめからの道筋の探索）に、命令が作品のデータ（ctx.data）を読めること。
 * 読めないと、データで行き先を決める命令（@investigate やプラグインの調べる画面）の先へ進めず、後のファイルの道筋が見つからなかった。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-sweep-data-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  rmSync(join(dir, "scenario"), { recursive: true, force: true });
  mkdirSync(join(dir, "scenario"));
  writeFileSync(join(dir, "scenario/a.lim"), "@window show\nはじまり。\n@investigate room\n@stop\n");
  writeFileSync(join(dir, "scenario/b.lim"), "窓の向こう。\n@stop\n");
  const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, entry: "a" }, null, 2));
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(
    join(dir, "data/investigation.json"),
    JSON.stringify({
      places: {
        room: {
          title: "部屋",
          file: "a",
          views: [{ id: "main", label: "部屋", background: "hill_dusk.webp", spots: [{ id: "window", label: "窓", rect: { x: 0, y: 0, width: 100, height: 100 }, target: "b" }] }],
        },
      },
    }),
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("現在地の探索と作品のデータ", () => {
  it("データで行き先を決める @investigate の先のファイルにも、はじめからの道筋が見つかる", async () => {
    const ws = await StudioWorkspace.open(loadProject(dir));
    const { sweep } = await ws.sweep("b");
    expect(sweep.how).toBe("entry");
    expect(sweep.route.length).toBeGreaterThan(0);
  });
});
