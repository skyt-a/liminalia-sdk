import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { makeUpdateManifest, parseApps } from "../src/commands/update-manifest.ts";
import { updateFor } from "../src/commands/build.ts";
import { updateModule as u, type UpdateManifest } from "../src/update.ts";
import { zipFolder } from "../src/zip.ts";

const SHA = "a".repeat(64);
/** マニフェスト（誤りを含むものも作れるよう、形は問わない）。 */
const manifest = (o: Record<string, unknown> = {}) => ({ format: "liminalia-update", formatVersion: 1, ...o });

describe("アップデートのマニフェスト", () => {
  it("版を数として比べる（- の後ろは無いものより前）", () => {
    expect(u.compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(u.compareVersions("1.2", "1.2.0")).toBe(0);
    expect(u.compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(u.compareVersions("v2.0.0", "1.9.9")).toBe(1);
  });

  it("形を確かめ、相対の URL をマニフェストの場所から絶対にする", () => {
    const r = u.validateManifest(manifest({ app: { version: "1.1.0", page: "https://example.com/dl", files: { windows: { url: "Game_Setup.exe", sha256: SHA.toUpperCase(), size: 10 } } }, packs: [{ id: "patch1", version: "1.0.1", requires: "1.0.0", url: "patch1.zip", sha256: SHA }] }), "https://example.com/updates/update.json");
    expect(r.problems).toEqual([]);
    expect(r.manifest?.app?.files?.windows).toEqual({ url: "https://example.com/updates/Game_Setup.exe", sha256: SHA, size: 10 });
    expect(r.manifest?.packs?.[0]?.url).toBe("https://example.com/updates/patch1.zip");
  });

  it("https でない URL、sha256 の無いもの、id の誤り、何も無いものは受けない", () => {
    expect(u.validateManifest(manifest({ packs: [{ id: "a", version: "1", url: "http://example.com/a.zip", sha256: SHA }] })).problems.join()).toContain("https");
    expect(u.validateManifest(manifest({ packs: [{ id: "a", version: "1", url: "https://e.com/a.zip" }] })).problems.join()).toContain("sha256");
    expect(u.validateManifest(manifest({ packs: [{ id: "../a", version: "1", url: "https://e.com/a.zip", sha256: SHA }] })).problems.join()).toContain("id");
    expect(u.validateManifest(manifest()).problems.join()).toContain("app か packs");
    expect(u.validateManifest({ format: "other" }).problems.join()).toContain("format");
    // 確かめ用の localhost は http でもよい
    expect(u.validateManifest(manifest({ packs: [{ id: "a", version: "1", url: "http://localhost:8080/a.zip", sha256: SHA }] })).problems).toEqual([]);
  });

  it("本体の版に合い、入っていないか新しいパックと、新しい本体を選ぶ", () => {
    const m = u.validateManifest(
      manifest({
        app: { version: "1.1.0", files: { mac: { url: "https://e.com/a.zip", sha256: SHA } } },
        packs: [
          { id: "patch", version: "1.0.2", requires: "1.0.0", url: "https://e.com/p.zip", sha256: SHA },
          { id: "patch", version: "1.1.1", requires: "1.1.0", url: "https://e.com/p2.zip", sha256: SHA },
          { id: "dlc", version: "1.0.0", url: "https://e.com/d.zip", sha256: SHA },
        ],
      }),
    ).manifest!;
    const plan = u.planUpdate(m, { appVersion: "1.0.0", platform: "mac", installed: { patch: "1.0.1", dlc: "1.0.0" } });
    expect(plan.app?.version).toBe("1.1.0");
    expect(plan.app?.file?.url).toBe("https://e.com/a.zip");
    expect(plan.packs.map((p) => `${p.id}@${p.version}`)).toEqual(["patch@1.0.2"]);
    // この OS のファイルもページも無い本体の更新は知らせない
    expect(u.planUpdate(m, { appVersion: "1.0.0", platform: "windows", installed: {} }).app).toBeNull();
    expect(u.planUpdate(m, { appVersion: "1.1.0", platform: "mac", installed: { patch: "1.1.1", dlc: "1.0.0" } })).toEqual({ app: null, packs: [] });
  });

  it("説明は遊ぶ人の言語のもの（無ければ英語）", () => {
    expect(u.pickNotes({ ja: "修正", en: "Fixes" }, "ja-JP")).toBe("修正");
    expect(u.pickNotes({ ja: "修正", en: "Fixes" }, "fr")).toBe("Fixes");
    expect(u.pickNotes("同じ", "en")).toBe("同じ");
  });
});

describe("パックの取り寄せと差し替え", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-update-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** packs/<id>/ の形のパックを zip にする。 */
  async function packZip(id: string, version: string, text: string, packId = id): Promise<string> {
    const src = join(dir, "src", id);
    rmSync(src, { recursive: true, force: true });
    mkdirSync(join(src, "scenario"), { recursive: true });
    writeFileSync(join(src, "pack.json"), JSON.stringify({ id: packId, version }));
    writeFileSync(join(src, "scenario", "extra.lim"), text);
    const zip = join(dir, `${id}-${version}-${Math.random()}.zip`);
    await zipFolder(join(dir, "src"), id, zip);
    return zip;
  }
  const fakeFetch = (file: string) => (async () => new Response(readFileSync(file))) as unknown as typeof fetch;

  it("取り寄せたものの sha256 と大きさを確かめ、合わなければ残さない", async () => {
    const zip = await packZip("patch", "1.0.1", "本文");
    const sha256 = u.sha256File(zip);
    const dest = join(dir, "dl", "patch.zip");
    await u.download(fakeFetch(zip), "https://e.com/patch.zip", dest, { sha256 });
    expect(u.sha256File(dest)).toBe(sha256);
    await expect(u.download(fakeFetch(zip), "https://e.com/patch.zip", join(dir, "dl", "bad.zip"), { sha256: SHA })).rejects.toThrow(/sha256/);
    expect(existsSync(join(dir, "dl", "bad.zip"))).toBe(false);
    expect(existsSync(join(dir, "dl", "bad.zip.part"))).toBe(false);
    await expect(u.download(fakeFetch(zip), "https://e.com/patch.zip", join(dir, "dl", "small.zip"), { sha256, size: 3 })).rejects.toThrow(/大きさ/);
    await expect(u.download(fakeFetch(zip), "http://e.com/patch.zip", join(dir, "dl", "x.zip"), { sha256 })).rejects.toThrow(/https/);
  });

  it("保存先の packs/<id> に入れ、前のものと差し替える。id が違えば前のものを残す", async () => {
    const packs = join(dir, "packs");
    const v1 = await packZip("patch", "1.0.1", "一つ目");
    expect(u.installPack(v1, packs, "patch")).toMatchObject({ id: "patch", version: "1.0.1" });
    expect(readFileSync(join(packs, "patch", "scenario", "extra.lim"), "utf8")).toBe("一つ目");
    const v2 = await packZip("patch", "1.0.2", "二つ目");
    u.installPack(v2, packs, "patch");
    expect(readFileSync(join(packs, "patch", "scenario", "extra.lim"), "utf8")).toBe("二つ目");
    const wrong = await packZip("patch", "1.0.3", "違う", "other");
    expect(() => u.installPack(wrong, packs, "patch")).toThrow(/id/);
    expect(readFileSync(join(packs, "patch", "scenario", "extra.lim"), "utf8")).toBe("二つ目");
    // 作業用のフォルダは残さない
    expect(existsSync(join(packs, ".patch.new"))).toBe(false);
    expect(existsSync(join(packs, ".patch.old"))).toBe(false);
  });

  it("展開先の外を指す名前は受けない", () => {
    expect(u.safeEntryPath("a/b.lim")).toBe("a/b.lim");
    expect(u.safeEntryPath("../evil")).toBeNull();
    expect(u.safeEntryPath("a/../../evil")).toBeNull();
    expect(u.safeEntryPath("/etc/passwd")).toBeNull();
    expect(u.safeEntryPath("C:\\Windows\\x")).toBeNull();
  });
});

describe("lim update-manifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-update-manifest-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    mkdirSync(join(dir, "packs", "patch1", "scenario"), { recursive: true });
    writeFileSync(join(dir, "packs", "patch1", "pack.json"), JSON.stringify({ id: "patch1", title: "修正 1", version: "1.0.1" }));
    writeFileSync(join(dir, "packs", "patch1", "scenario", "patch_note.lim"), "　修正しました。\n");
    writeFileSync(join(dir, "Game_Setup.exe"), "MZ setup");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("パックを zip にし、本体のファイルを写して sha256 を付け、遊ぶ側がそれを入れられる", async () => {
    const project = loadProject(dir);
    const r = await makeUpdateManifest(project, { baseUrl: "https://example.com/game/updates", packs: ["packs/patch1"], apps: { windows: "Game_Setup.exe" }, page: "https://example.com/game", notes: { ja: "修正", en: "Fixes" }, version: "1.1.0" });
    const written = JSON.parse(readFileSync(join(r.out, "update.json"), "utf8")) as UpdateManifest;
    expect(written).toEqual(r.manifest);
    expect(written.app).toMatchObject({ version: "1.1.0", page: "https://example.com/game", files: { windows: { url: "https://example.com/game/updates/Game_Setup.exe", size: 8 } } });
    const pack = written.packs![0]!;
    expect(pack).toMatchObject({ id: "patch1", version: "1.0.1", requires: "1.1.0", title: "修正 1", url: "https://example.com/game/updates/patch1-1.0.1.zip" });
    expect(u.sha256File(join(r.out, basename(new URL(pack.url).pathname)))).toBe(pack.sha256);

    // 遊ぶ側: 確かめ → 取り寄せ → 入れる
    const plan = u.planUpdate(u.validateManifest(written, "https://example.com/game/updates/update.json").manifest!, { appVersion: "1.1.0", platform: "windows", installed: {} });
    expect(plan.packs.map((p) => p.id)).toEqual(["patch1"]);
    const fetchFromOut = (async (url: string) => new Response(readFileSync(join(r.out, decodeURIComponent(basename(new URL(url).pathname)))))) as unknown as typeof fetch;
    const zip = await u.download(fetchFromOut, pack.url, join(dir, "dl", "patch1.zip"), pack);
    u.installPack(zip, join(dir, "user-packs"), "patch1");
    const installed = JSON.parse(readFileSync(join(dir, "user-packs", "patch1", "pack.json"), "utf8")) as { files: { scenario: string[] } };
    expect(installed.files.scenario).toEqual(["patch_note"]);
    expect(existsSync(join(dir, "user-packs", "patch1", "flow.json"))).toBe(true);
  });

  it("前のマニフェストのほかの本体の版向けのパックは残し、--fresh なら残さない", async () => {
    const project = loadProject(dir);
    await makeUpdateManifest(project, { baseUrl: "https://example.com/u/", packs: ["packs/patch1"], version: "1.0.0" });
    writeFileSync(join(dir, "packs", "patch1", "pack.json"), JSON.stringify({ id: "patch1", version: "1.1.1" }));
    const r = await makeUpdateManifest(project, { baseUrl: "https://example.com/u/", packs: ["packs/patch1"], version: "1.1.0" });
    expect(r.manifest.packs?.map((p) => `${p.version}>${p.requires}`)).toEqual(["1.1.1>1.1.0", "1.0.1>1.0.0"]);
    const fresh = await makeUpdateManifest(project, { baseUrl: "https://example.com/u/", packs: ["packs/patch1"], version: "1.1.0", fresh: true });
    expect(fresh.manifest.packs).toHaveLength(1);
  });

  it("置き先で同じ名前になる本体のファイルは受けない", async () => {
    const project = loadProject(dir);
    mkdirSync(join(dir, "win"));
    mkdirSync(join(dir, "mac"));
    writeFileSync(join(dir, "win", "game.zip"), "windows");
    writeFileSync(join(dir, "mac", "game.zip"), "mac");
    await expect(makeUpdateManifest(project, { baseUrl: "https://example.com/u/", apps: { windows: "win/game.zip", mac: "mac/game.zip" } })).rejects.toThrow(/同じ名前/);
  });

  it("版の無いパックと https でない場所は受けない", async () => {
    const project = loadProject(dir);
    writeFileSync(join(dir, "packs", "patch1", "pack.json"), JSON.stringify({ id: "patch1" }));
    await expect(makeUpdateManifest(project, { baseUrl: "https://example.com/u/", packs: ["packs/patch1"] })).rejects.toThrow(/version/);
    await expect(makeUpdateManifest(project, { baseUrl: "http://example.com/u/", packs: ["packs/patch1"] })).rejects.toThrow(/https/);
    expect(parseApps("windows=a.exe,mac=b.zip")).toEqual({ windows: "a.exe", mac: "b.zip" });
    expect(() => parseApps("ps5=a")).toThrow();
  });
});

describe("書き出しのアップデートの設定（game.json の update）", () => {
  it("Steam につなぐ版は steam: true のときだけ入れ、環境変数が優先する", () => {
    expect(updateFor({ url: "https://e.com/u.json" }, null, {})).toEqual({ url: "https://e.com/u.json", startup: true });
    expect(updateFor({ url: "https://e.com/u.json", checkOnStartup: false }, null, {})).toEqual({ url: "https://e.com/u.json", startup: false });
    expect(updateFor({ url: "https://e.com/u.json" }, { appId: 1 }, {})).toBeNull();
    expect(updateFor({ url: "https://e.com/u.json", steam: true }, { appId: 1 }, {})).not.toBeNull();
    expect(updateFor({ url: "https://e.com/u.json" }, null, { LIMINALIA_UPDATE_URL: "off" })).toBeNull();
    expect(updateFor(undefined, null, { LIMINALIA_UPDATE_URL: "https://beta.e.com/u.json" })?.url).toBe("https://beta.e.com/u.json");
    expect(() => updateFor({ url: "http://e.com/u.json" }, null, {})).toThrow(/https/);
  });
});
