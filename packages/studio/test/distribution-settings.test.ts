import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { readSettings, setSettings, STEAM_INPUT_TARGETS } from "../src/server/manage.ts";
import { createRequire } from "node:module";

/** 配布の設定（署名・インストーラー・アップデート・ストア）を Studio のプロジェクトの設定から書けること。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-dist-settings-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"));
const problem = (build: object) => {
  try {
    setSettings(ws, { ...readSettings(ws), build });
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("配布の設定", () => {
  it("署名と公証の設定を書ける", () => {
    const build = {
      mac: { signIdentity: "Developer ID Application: A (T)", notaryProfile: "p", notarize: false },
      windows: { sign: { pfx: "c.pfx", passwordEnv: "PW", timestampUrl: "http://ts.example", ifMissing: "skip" } },
    };
    expect(problem(build)).toBe("");
    expect(config().build).toEqual(build);
    expect(problem({ windows: { sign: { command: ["jsign", "{file}"] } } })).toBe("");
  });

  it("署名の設定の誤りは書かない", () => {
    expect(problem({ mac: { notarize: "yes" } })).toContain("build.mac");
    expect(problem({ windows: { sign: { ifMissing: "later" } } })).toContain("build.windows.sign");
    expect(problem({ windows: { sign: { command: ["jsign"] } } })).toContain("{file}");
  });

  it("インストーラーは true か設定で書け、言語は ja と en だけ", () => {
    expect(problem({ windows: { installer: true } })).toBe("");
    expect(problem({ windows: { installer: { perMachine: true, languages: ["en"] } } })).toBe("");
    expect(config().build.windows.installer).toEqual({ perMachine: true, languages: ["en"] });
    expect(problem({ windows: { installer: { languages: ["fr"] } } })).toContain("build.windows.installer");
  });

  it("アップデートの確認は https の URL で書く", () => {
    expect(problem({ update: { url: "https://example.com/update.json", checkOnStartup: false } })).toBe("");
    expect(problem({ update: { url: "http://example.com/update.json" } })).toContain("build.update");
    expect(problem({ update: { checkOnStartup: true } })).toContain("build.update");
  });

  it("ストアの商品とプラグインとライブラリを書ける", () => {
    const store = { products: { full: { ios: "com.example.full", android: "full_unlock", steam: 480, gog: "123" } }, desktop: { module: "plugins/gog/store.cjs", options: { clientId: "x" } }, android: { libraries: ["libs/billing.aar"] } };
    expect(problem({ store })).toBe("");
    expect(config().build.store).toEqual(store);
    expect(problem({ store: { products: { full: { steam: "480" } } } })).toContain("build.store.products");
    expect(problem({ store: { desktop: { options: { a: 1 } } } })).toContain("build.store.desktop");
    expect(problem({ store: { android: { libraries: "a.aar" } } })).toContain("build.store.android");
  });

  it("Steam ワークショップと Steam Input を書ける。操作はデスクトップ版が受けるものだけ", () => {
    expect(problem({ steam: { appId: 480, workshop: true, input: { actionSet: "InGameControls", actions: { confirm: "a", menu_open: "start", auto_toggle: "auto" } } } })).toBe("");
    expect(problem({ steam: { appId: 480, input: { actions: { jump: "fly" } } } })).toContain("Steam Input");
    const { INPUT_TARGETS } = createRequire(import.meta.url)(resolve(import.meta.dirname, "../../desktop/store.cjs")) as { INPUT_TARGETS: string[] };
    expect([...STEAM_INPUT_TARGETS]).toEqual(INPUT_TARGETS);
  });
});
