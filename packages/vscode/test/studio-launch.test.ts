import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appLaunch, limLaunch, type LaunchContext } from "../src/studio-launch.ts";

/** 「ここからテストプレイ」で制作画面を立ち上げる方法（npx は使わない）。 */

const base = (o: Partial<LaunchContext> = {}): LaunchContext => ({
  root: "/work/game",
  limSetting: "",
  appSetting: "",
  node: "",
  execPath: "/vscode/Electron",
  platform: "darwin",
  home: "/Users/me",
  env: {},
  exists: () => false,
  ...o,
});

describe("lim studio の立ち上げ方", () => {
  it("設定の lim の場所。スクリプトは Node で動かし、Node の設定が空なら VS Code の中の Node を使う", () => {
    expect(limLaunch(base({ limSetting: "~/engine/packages/cli/bin/lim.mjs" }))).toEqual({ command: "/vscode/Electron", args: ["/Users/me/engine/packages/cli/bin/lim.mjs", "studio", "."], env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(limLaunch(base({ limSetting: "tools/lim.mjs", node: "/usr/local/bin/node" }))).toEqual({ command: "/usr/local/bin/node", args: ["/work/game/tools/lim.mjs", "studio", "."] });
    expect(limLaunch(base({ limSetting: "/usr/local/bin/lim" }))).toEqual({ command: "/usr/local/bin/lim", args: ["studio", "."] });
  });

  it("設定が空なら作品の node_modules の @liminalia/cli。無ければ null（npx は使わない）", () => {
    const local = "/work/game/node_modules/@liminalia/cli/bin/lim.mjs";
    expect(limLaunch(base({ exists: (p) => p === local }))).toMatchObject({ args: [local, "studio", "."] });
    expect(limLaunch(base())).toBeNull();
    expect(readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8")).not.toMatch(/\bnpx /);
  });

  it("信頼していないワークスペースでは、作品の中の lim を動かさず、立ち上げる lim studio を制限付きにする", () => {
    const local = "/work/game/node_modules/@liminalia/cli/bin/lim.mjs";
    expect(limLaunch(base({ trusted: false, exists: (p) => p === local }))).toBeNull();
    expect(limLaunch(base({ trusted: false, limSetting: "tools/lim.mjs" }))).toBeNull();
    expect(limLaunch(base({ trusted: false, limSetting: "/usr/local/bin/lim" }))).toEqual({ command: "/usr/local/bin/lim", args: ["studio", "."], env: { LIMINALIA_RESTRICTED: "1" } });
    expect(limLaunch(base({ trusted: false, limSetting: "~/engine/packages/cli/bin/lim.mjs" }))).toEqual({ command: "/vscode/Electron", args: ["/Users/me/engine/packages/cli/bin/lim.mjs", "studio", "."], env: { ELECTRON_RUN_AS_NODE: "1", LIMINALIA_RESTRICTED: "1" } });
    // 信頼していれば前と同じ
    expect(limLaunch(base({ trusted: true, exists: (p) => p === local }))).toMatchObject({ args: [local, "studio", "."] });
    // ワークスペースの設定（.vscode/settings.json）の lim の場所は、信頼していないあいだ VS Code が読まない
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } } };
    expect(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations).toEqual(expect.arrayContaining(["liminalia.lim", "liminalia.node", "liminalia.studioApp"]));
  });
});

describe("制作アプリで開く", () => {
  it("Mac は /Applications と ~/Applications を探して open -a、設定があればその場所", () => {
    expect(appLaunch(base({ exists: (p) => p === "/Users/me/Applications/Liminalia Studio.app" }))).toEqual({ command: "open", args: ["-a", "/Users/me/Applications/Liminalia Studio.app", "/work/game"] });
    expect(appLaunch(base({ appSetting: "/Apps/Studio.app", exists: (p) => p === "/Apps/Studio.app" }))).toEqual({ command: "open", args: ["-a", "/Apps/Studio.app", "/work/game"] });
    expect(appLaunch(base({ appSetting: "/Apps/missing.app" }))).toBeNull();
    expect(appLaunch(base())).toBeNull();
  });

  it("Windows は %LOCALAPPDATA%\\Programs の実行ファイルに作品のフォルダを渡す", () => {
    const win = base({ platform: "win32", root: "C:\\game", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, exists: (p) => p.endsWith("Liminalia Studio.exe") });
    const r = appLaunch(win);
    expect(r?.args).toEqual(["C:\\game"]);
    expect(r?.command).toMatch(/Programs.Liminalia Studio.Liminalia Studio\.exe$/);
  });
});
