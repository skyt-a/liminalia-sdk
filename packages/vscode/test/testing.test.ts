import { describe, expect, it } from "vitest";
import { limCommand, type LaunchContext } from "../src/studio-launch.ts";
import { limTestLaunch, parseLimTestJson, projectRootOf, testItemsOf } from "../src/testing.ts";

/** VS Code の Testing の口に載せる、台本のテスト（tests/*.limtest）の一覧と、lim test --json の結果の読み方。 */

const ctx = (o: Partial<LaunchContext> = {}): LaunchContext => ({
  root: "/work/game",
  limSetting: "",
  appSetting: "",
  node: "",
  execPath: "/vscode/electron",
  platform: "darwin",
  home: "/Users/me",
  env: {},
  exists: (p) => p === "/work/game/node_modules/@liminalia/cli/bin/lim.mjs",
  ...o,
});

describe("台本のテストの一覧", () => {
  it("# の行ごとにテストを並べ、読めない行を知らせる", () => {
    const text = ["// 見本", "# 北の道", "choose 北の道を行く", "expect game.trust == 2", "", "# 南の道", "choose 2", "expect game.x ==", ""].join("\n");
    const r = testItemsOf(text, "tests/roads.limtest");
    expect(r.tests).toEqual([
      { name: "北の道", line: 2 },
      { name: "南の道", line: 6 },
    ]);
    expect(r.problems.map((p) => p.line)).toEqual([8]);
  });
});

describe("lim test を動かす", () => {
  it("lim の場所は lim studio と同じ探し方で、test と --json を渡す（信頼していなければプラグインを読まない）", () => {
    expect(limTestLaunch(ctx(), ["/work/game/tests/a.limtest"])).toEqual({
      command: "/vscode/electron",
      args: ["/work/game/node_modules/@liminalia/cli/bin/lim.mjs", "test", "/work/game", "/work/game/tests/a.limtest", "--json"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(limTestLaunch(ctx({ limSetting: "/opt/lim", trusted: false }), [])).toEqual({ command: "/opt/lim", args: ["test", "/work/game", "--json"], env: { LIMINALIA_RESTRICTED: "1" } });
    // 信頼していないワークスペースでは作品の中の lim を動かさない
    expect(limTestLaunch(ctx({ trusted: false }), [])).toBeNull();
    expect(limCommand(ctx({ node: "/usr/bin/node" }), ["studio", "."])).toEqual({ command: "/usr/bin/node", args: ["/work/game/node_modules/@liminalia/cli/bin/lim.mjs", "studio", "."] });
  });

  it("lim test --json の結果を、ファイルとテストの行で引ける形にする（前に出た経過の行は飛ばす）", () => {
    const json = {
      ok: false,
      tests: 2,
      failed: 1,
      files: [
        {
          file: "tests/roads.limtest",
          problems: [{ line: 9, message: "読めません" }],
          tests: [
            { name: "北の道", line: 2, ok: true, failures: [], pages: 12, end: "ended" },
            { name: "南の道", line: 6, ok: false, failures: [{ line: 8, message: "通りませんでした" }], pages: 3, end: "choice" },
          ],
        },
      ],
    };
    const r = parseLimTestJson(`警告: 何か\n${JSON.stringify(json, null, 2)}\n`)!;
    expect(r.ok).toBe(false);
    expect(r.files.get("tests/roads.limtest")!.tests.get(6)).toMatchObject({ ok: false, failures: [{ line: 8, message: "通りませんでした" }] });
    expect(r.files.get("tests/roads.limtest")!.problems).toEqual([{ line: 9, message: "読めません" }]);
    expect(parseLimTestJson("lim test: 何かの誤り")).toBeNull();
  });

  it("テストのファイルから作品のフォルダ（liminalia.json のあるところ）を探す", () => {
    const has = new Set(["/work/game/liminalia.json"]);
    expect(projectRootOf("/work/game/tests/sub/a.limtest", (p) => has.has(p))).toBe("/work/game");
    expect(projectRootOf("/elsewhere/a.limtest", (p) => has.has(p))).toBeNull();
  });
});
