import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { catalogPlugins, installPlugin, listPlugins } from "../src/server/manage.ts";
import { catalogDir, compareVersions, readCatalog } from "../src/server/catalog.ts";

/** 公式のプラグイン（同梱の一覧から入れる）。一覧とプラグインは作業用フォルダに作る。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let work: string;
let project: string;
let catalog: string;
let ws: StudioWorkspace;

/** 一覧のフォルダに置くプラグイン（src・test・node_modules を持つ）。 */
function writePlugin(dir: string, version: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "liminalia-ai", version, type: "module", exports: { "./studio": "./src/studio.ts", "./studio-server": "./src/studio-server.ts" } }));
  writeFileSync(join(dir, "src", "studio.ts"), `export default { name: "ai", version: "${version}" };\n`);
  writeFileSync(join(dir, "src", "studio-server.ts"), "export default {};\n");
  writeFileSync(join(dir, "test", "a.test.ts"), "");
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "");
}

function writeCatalog(plugins: unknown[]): void {
  writeFileSync(join(catalog, "catalog.json"), JSON.stringify({ plugins }));
}

const AI = { id: "ai", name: "AI 相談", nameEn: "AI consultation", description: "説明", descriptionEn: "About", folder: "ai" };

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "liminalia-catalog-"));
  project = join(work, "project");
  catalog = join(work, "catalog");
  cpSync(TEMPLATE, project, { recursive: true });
  mkdirSync(catalog);
  writePlugin(join(catalog, "ai"), "0.1.0");
  writeCatalog([AI]);
  ws = await StudioWorkspace.open(loadProject(project));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("一覧", () => {
  it("版と入口はフォルダの package.json から求める。入れていなければ installed は null", () => {
    expect(catalogPlugins(ws, catalog)).toEqual([
      { id: "ai", name: "AI 相談", nameEn: "AI consultation", description: "説明", descriptionEn: "About", version: "0.1.0", entries: ["studio", "studio-server"], installed: null, added: false, update: false },
    ]);
  });

  it("フォルダが無いものは error を付けて並べる。一覧が無ければ空", () => {
    writeCatalog([{ ...AI, folder: "missing", folderEnv: "LIMINALIA_TEST_NONE" }]);
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ id: "ai", error: expect.stringMatching(/LIMINALIA_TEST_NONE/) });
    expect(catalogPlugins(ws, null)).toEqual([]);
    expect(catalogPlugins(ws, join(work, "none"))).toEqual([]);
  });

  it("folderEnv の環境変数があればそのフォルダを使う。id の形が誤っていれば読まない", () => {
    writePlugin(join(work, "elsewhere"), "0.3.0");
    writeCatalog([{ ...AI, folder: "missing", folderEnv: "LIMINALIA_TEST_AI" }]);
    expect(readCatalog(catalog, { LIMINALIA_TEST_AI: join(work, "elsewhere") })[0]).toMatchObject({ dir: join(work, "elsewhere"), version: "0.3.0" });
    writeCatalog([{ ...AI, id: "../x" }]);
    expect(() => readCatalog(catalog)).toThrow(/使えません/);
  });

  it("一覧のフォルダは LIMINALIA_PLUGIN_CATALOG、無ければリポジトリの catalog/", () => {
    expect(catalogDir({ LIMINALIA_PLUGIN_CATALOG: catalog })).toBe(catalog);
    expect(catalogDir({})).toBe(resolve(import.meta.dirname, "../../../catalog"));
  });

  it("版は数として比べる", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
  });
});

describe("入れる", () => {
  it("plugins/<id> に写し（node_modules・test は写さない）、liminalia.json に足す", () => {
    expect(installPlugin(ws, catalog, "ai")).toEqual({ spec: "./plugins/ai", version: "0.1.0" });
    const dest = join(project, "plugins", "ai");
    expect(readdirSync(dest).sort()).toEqual(["package.json", "src"]);
    expect(JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")).plugins).toEqual(["./plugins/ai"]);
    expect(listPlugins(ws)).toMatchObject([{ spec: "./plugins/ai", name: "liminalia-ai", entries: ["studio", "studio-server"], local: true }]);
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ installed: "0.1.0", added: true, update: false });
  });

  it("新しい版があれば update。入れ直すと前の版を .liminalia/backups/plugins に残し、plugins は重ねない", () => {
    installPlugin(ws, catalog, "ai");
    writeFileSync(join(project, "plugins", "ai", "mine.txt"), "書き手のメモ");
    writePlugin(join(catalog, "ai"), "0.2.0");
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ version: "0.2.0", installed: "0.1.0", update: true });
    expect(installPlugin(ws, catalog, "ai").version).toBe("0.2.0");
    expect(readFileSync(join(project, "plugins", "ai", "src", "studio.ts"), "utf8")).toContain("0.2.0");
    expect(existsSync(join(project, "plugins", "ai", "mine.txt"))).toBe(false);
    const backups = readdirSync(join(project, ".liminalia", "backups", "plugins"));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(project, ".liminalia", "backups", "plugins", backups[0]!, "mine.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")).plugins).toEqual(["./plugins/ai"]);
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ installed: "0.2.0", update: false });
  });

  it("フォルダはあるが liminalia.json に無ければ added は false。入れると足す", () => {
    installPlugin(ws, catalog, "ai");
    writeFileSync(join(project, "liminalia.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")), plugins: undefined }));
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ installed: "0.1.0", added: false });
    installPlugin(ws, catalog, "ai");
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ added: true });
  });

  it("plugins/<id> に別のプラグインがあれば入れない。一覧に無い id も入れない", () => {
    mkdirSync(join(project, "plugins", "ai"), { recursive: true });
    writeFileSync(join(project, "plugins", "ai", "package.json"), JSON.stringify({ name: "my-ai", version: "1.0.0" }));
    expect(catalogPlugins(ws, catalog)[0]).toMatchObject({ installed: null, error: expect.stringMatching(/my-ai/) });
    expect(() => installPlugin(ws, catalog, "ai")).toThrow(/別のプラグイン/);
    expect(() => installPlugin(ws, catalog, "none")).toThrow(/ありません/);
  });
});
