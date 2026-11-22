import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_ID_SHAPE } from "@liminalia/lang";
import { childPath, plainName } from "../src/contained-path.ts";
import { ConfigError, loadProject } from "../src/index.ts";
import { PROJECT_ID_MAX, PROJECT_ID_PATTERN, unsafeProjectId } from "../src/project-id.ts";

/**
 * 作品の ID（liminalia.json の id）は書き出したフォルダの名前になる（lim build browser は <書き出し先>/browser/<id> を消して置き直す）。
 * パスとして危ない ID（区切り、制御文字、. と ..）は読み込みで止め、作る所の形（PROJECT_ID_PATTERN）に合わないだけの ID は検査で知らせる。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

describe("作品の ID の読み込み", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-id-"));
    cpSync(TEMPLATE, dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeId = (id: string) => {
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, id }, null, 2));
  };

  it("区切り、. と ..、制御文字を含む ID は読み込みで止める", () => {
    for (const id of ["../../../../Documents", "a/b", "a\\b", "..", ".", " .. ", "a\u0000b", "a\nb", "/abs"]) {
      writeId(id);
      expect(() => loadProject(dir), JSON.stringify(id)).toThrow(ConfigError);
      expect(() => loadProject(dir), JSON.stringify(id)).toThrow("書き出したフォルダの名前に使えません");
    }
  });

  it("作る所の形に合わないだけの ID は開け、検査で知らせる", () => {
    for (const id of ["my.game", "星の丘", "My Game", "_x", "a".repeat(PROJECT_ID_MAX + 1)]) {
      writeId(id);
      const project = loadProject(dir);
      expect(project.config.id).toBe(id);
      expect(project.problems?.map((p) => [p.severity, p.code])).toEqual([["warning", "bad-config"]]);
      expect(project.problems?.[0]?.line).toBe(2);
    }
    writeId("hoshi_wo_matsu_oka");
    expect(loadProject(dir).problems).toBeUndefined();
  });

  it("unsafeProjectId は危ないものだけを拾う", () => {
    expect(["..", ".", "...", "a/b", "a\\b", "a\u0007"].map(unsafeProjectId)).toEqual([true, true, true, true, true, true]);
    expect(["my.game", "..x", "星", "a b", "a:b"].map(unsafeProjectId)).toEqual([false, false, false, false, false]);
  });

  it("lang の ID の形は project-id.ts と同じ", () => {
    for (const id of ["a", "a_b-c", "_a", "-a", "a.b", "a".repeat(PROJECT_ID_MAX), "a".repeat(PROJECT_ID_MAX + 1), "Ａ", ""]) {
      expect(PROJECT_ID_SHAPE.test(id), id).toBe(PROJECT_ID_PATTERN.test(id) && id.length <= PROJECT_ID_MAX);
    }
  });
});

describe("書き出しの名前を一区切りに限る", () => {
  it("区切り、. と ..、制御文字の名前は使えない", () => {
    expect(["g", "g-test", "G_1.0.0_Setup.exe", "星の丘", "..x"].every(plainName)).toBe(true);
    expect(["", ".", "..", "../x", "a/b", "a\\b", "a\u0000"].some(plainName)).toBe(false);
  });

  it("childPath は親の直下だけを返す", () => {
    const parent = resolve(tmpdir(), "out", "browser");
    expect(childPath(parent, "g")).toBe(join(parent, "g"));
    for (const name of ["", ".", "..", "../mac", "../../x", "a/b", "/abs"]) expect(childPath(parent, name), name).toBeNull();
  });
});
