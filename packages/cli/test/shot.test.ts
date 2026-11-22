import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { resolveShotTarget } from "../src/commands/shot.ts";

/**
 * lim shot の開始位置。無いファイルを渡すと開発サーバーが返す HTML を本文として撮ってしまっていたので、撮る前に確かめる。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

describe("lim shot の開始位置", () => {
  const project = loadProject(TEMPLATE);

  it("名前・拡張子付き・シナリオのフォルダからのパスのどれでも、シナリオの名前に直す", () => {
    expect(resolveShotTarget(project, "start")).toBe("start");
    expect(resolveShotTarget(project, "start.lim")).toBe("start");
    expect(resolveShotTarget(project, "scenario/start.lim")).toBe("start");
    expect(resolveShotTarget(project, "scenario/start.lim#start")).toBe("start#start");
  });

  it("無いファイル・ラベルは、あるものを挙げて止める", () => {
    expect(() => resolveShotTarget(project, "nothing.lim")).toThrow(/シナリオ nothing\.lim がありません（あるのは .*start/);
    expect(() => resolveShotTarget(project, "start#nothing")).toThrow(/start にラベル #nothing がありません（あるのは .*#start/);
  });
});
