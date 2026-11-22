import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import { loadProject } from "@liminalia/project";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appBuildVdf, depotBuildVdf, parseOsMap, planSteamPublish } from "../src/commands/publish-steam.ts";
import { BUTLER_HOW_TO, parseItchTargets, parseTargetMap, planItchPublish } from "../src/commands/publish-itch.ts";
import { makeUpdateManifest } from "../src/commands/update-manifest.ts";
import { browserBuildDir, browserBuildName, exportPathNames, recordBuild, unsafeExportNames } from "../src/commands/build.ts";
import { builtInfo, isTestBuild } from "../src/built.ts";
import { findBundletool } from "../src/mobile/android.ts";
import { appStoreConnectKey, exportOptionsPlist } from "../src/mobile/ios.ts";

describe("App Store（Archive と書き出し）", () => {
  it("ExportOptions.plist の method は Xcode の版で書き分け、--upload なら上げる形にする", () => {
    const now = exportOptionsPlist({ method: "app-store", team: "ABCDE12345", xcode: [26, 2] });
    expect(now).toContain("<string>app-store-connect</string>");
    expect(now).toContain("<string>ABCDE12345</string>");
    expect(now).toContain("<string>export</string>");
    expect(exportOptionsPlist({ method: "ad-hoc", team: "T", xcode: [15, 2] })).toContain("<string>ad-hoc</string>");
    expect(exportOptionsPlist({ method: "ad-hoc", team: "T", xcode: [15, 3] })).toContain("<string>release-testing</string>");
    expect(exportOptionsPlist({ method: "development", team: "T", xcode: [16, 0] })).toContain("<string>debugging</string>");
    expect(exportOptionsPlist({ method: "app-store", team: "T", upload: true })).toContain("<string>upload</string>");
  });

  it("App Store Connect の API キーは LIMINALIA_ASC_*、無ければ公証の LIMINALIA_NOTARY_KEY* を使う", () => {
    expect(appStoreConnectKey({})).toBeNull();
    expect(appStoreConnectKey({ LIMINALIA_ASC_KEY: "/k.p8", LIMINALIA_ASC_KEY_ID: "ID", LIMINALIA_ASC_ISSUER: "IS" })).toEqual({ path: "/k.p8", id: "ID", issuer: "IS" });
    expect(appStoreConnectKey({ LIMINALIA_NOTARY_KEY: "/n.p8", LIMINALIA_NOTARY_KEY_ID: "N", LIMINALIA_NOTARY_ISSUER: "I" })).toEqual({ path: "/n.p8", id: "N", issuer: "I" });
    expect(appStoreConnectKey({ LIMINALIA_ASC_KEY: "/k.p8" })).toBeNull();
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-publish-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Steam へ上げる（lim publish steam）", () => {
  /** 書き出したゲームのにせもの（app.asar の中の game.json）。 */
  async function fakeBuild(folder: string, game: object): Promise<void> {
    const src = join(dir, `src-${Math.random()}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "game.json"), JSON.stringify(game));
    mkdirSync(join(folder, "resources"), { recursive: true });
    await createPackage(src, join(folder, "resources", "app.asar"));
    writeFileSync(join(folder, "Game.exe"), "");
  }

  it("VDF は値の \" と \\ を逃がし、公開するブランチとプレビューを書き分ける", () => {
    const app = appBuildVdf({ appId: 480, desc: 'v1 "初回"', output: "C:\\out", depots: { 481: "depot_build_481.vdf" }, branch: "beta", preview: true });
    expect(app).toContain('"Desc" "v1 \\"初回\\""');
    expect(app).toContain('"BuildOutput" "C:\\\\out"');
    expect(app).toContain('"SetLive" "beta"');
    expect(app).toContain('"Preview" "1"');
    expect(app).toContain('"481" "depot_build_481.vdf"');
    expect(appBuildVdf({ appId: 1, desc: "d", output: "/o", depots: {} })).not.toContain("SetLive");
    expect(depotBuildVdf(481, "/games/Game")).toContain('"ContentRoot" "/games/Game"');
  });

  it("一番新しい書き出しを Steam につなぐ版か確かめて VDF を作り、足りないものを出す", async () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", version: "1.2.0", entry: "start", build: { steam: { appId: 480, depots: { windows: 481, linux: 483 } } } }));
    await fakeBuild(join(dir, "dist", "windows", "G_20260101_000000", "G"), { steam: { appId: 480 } });
    await fakeBuild(join(dir, "dist", "windows", "G_20260301_000000", "G"), { steam: { appId: 480 } });
    await fakeBuild(join(dir, "dist", "linux", "G_20260301_000000", "G"), { title: "G" });
    const plan = planSteamPublish(loadProject(dir), { dryRun: true });
    expect(plan.files.depots.map((d) => [d.os, d.depot, d.root.slice(dir.length + 1)])).toEqual([
      ["windows", 481, "dist/windows/G_20260301_000000/G"],
      ["linux", 483, "dist/linux/G_20260301_000000/G"],
    ]);
    expect(plan.problems.join("\n")).toMatch(/Steam につながない書き出し/);
    const vdf = readFileSync(plan.files.app, "utf8");
    expect(vdf).toContain('"AppID" "480"');
    expect(vdf).toContain('"Desc" "G 1.2.0"');
    expect(readFileSync(join(dir, "dist", "steam", "depot_build_481.vdf"), "utf8")).toContain('"FileExclusion" "*.zip"');
    expect(plan.command.slice(1)).toEqual(["+login", "<Steam のアカウント名>", "+run_app_build", plan.files.app, "+quit"]);
    expect(planSteamPublish(loadProject(dir), { dryRun: true, branch: "default" }).problems.join("\n")).toMatch(/default/);
    expect(planSteamPublish(loadProject(dir), { appId: 999, depots: { windows: 1000 }, dryRun: true }).problems.join("\n")).toMatch(/App ID 480 の書き出し/);
  });

  it("--build・--depot の書き方を読む", () => {
    expect(parseOsMap("windows=a, mac=b", "--build")).toEqual({ windows: "a", mac: "b" });
    expect(() => parseOsMap("ios=a", "--build")).toThrow(/windows=/);
  });
});

describe("Google Play（App Bundle）", () => {
  it("bundletool は LIMINALIA_BUNDLETOOL（jar かコマンド）、PATH の順に探し、無ければ入れ方を出す", () => {
    const jar = join(dir, "bundletool-all-1.17.2.jar");
    writeFileSync(jar, "");
    expect(findBundletool({ LIMINALIA_BUNDLETOOL: jar })).toEqual(["java", "-jar", jar]);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bundletool"), "#!/bin/sh\n");
    chmodSync(join(bin, "bundletool"), 0o755);
    expect(findBundletool({ PATH: bin })).toEqual([join(bin, "bundletool")]);
    expect(() => findBundletool({ LIMINALIA_BUNDLETOOL: join(dir, "none.jar") })).toThrow(/ありません/);
    // ~/.liminalia/tools に置いていない手元では、入れ方を出す
    try {
      findBundletool({ PATH: join(dir, "empty") });
    } catch (e) {
      expect(String(e)).toMatch(/brew install bundletool/);
    }
  });
});

describe("itch.io へ上げる（lim publish itch）", () => {
  it("書き出してあるものを butler push のチャンネルへ、版を付け、確かめの写真と配る形の包みを除いて上げる", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", version: "1.2.0", entry: "start", build: { itch: { target: "me/game", channels: { linux: "linux-beta" } } } }));
    mkdirSync(join(dir, "dist", "browser", "g"), { recursive: true });
    writeFileSync(join(dir, "dist", "browser", "g", "index.html"), "");
    mkdirSync(join(dir, "dist", "linux", "G_20261101_000000", "G"), { recursive: true });
    const plan = planItchPublish(loadProject(dir), {}, "/bin/butler");
    expect(plan.problems).toEqual([]);
    expect(plan.pushes.map((p) => `${p.what} ${p.channel}`)).toEqual(["browser html5", "linux linux-beta"]);
    expect(plan.pushes[0]!.command).toEqual(["/bin/butler", "push", join(dir, "dist", "browser", "g"), "me/game:html5", "--userversion", "1.2.0", "--ignore", "verify-title.png", "--ignore", "*.zip", "--ignore", "*.dmg", "--ignore", "*.tar.gz", "--ignore", ".DS_Store"]);
    expect(plan.pushes[1]!.folder).toBe(join(dir, "dist", "linux", "G_20261101_000000", "G"));
    // 先を選ぶと、それだけ。書き出しが無ければ知らせる
    const only = planItchPublish(loadProject(dir), { targets: ["windows"], target: "me/other", userversion: "2.0.0" }, "/bin/butler");
    expect(only.problems).toEqual(["windows の書き出しがありません（lim build windows で書き出すか、--build windows=フォルダ）"]);
  });

  it("上げる先の書き間違い、butler が無いとき、Steam につなぐ書き出しは止める", async () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start" }));
    mkdirSync(join(dir, "dist", "browser", "g"), { recursive: true });
    writeFileSync(join(dir, "dist", "browser", "g", "index.html"), "");
    expect(planItchPublish(loadProject(dir), {}, "/bin/butler").problems[0]).toContain("build.itch.target");
    expect(planItchPublish(loadProject(dir), { target: "https://me.itch.io/game" }, "/bin/butler").problems[0]).toContain('"人の名前/ゲームの名前" の形');
    expect(planItchPublish(loadProject(dir), { target: "me/game" }, null).problems).toEqual([BUTLER_HOW_TO]);
    expect(planItchPublish(loadProject(dir), { target: "me/game", dryRun: true }, null).problems).toEqual([]);
    const steam = join(dir, "dist", "windows", "G_20261101_000000", "G");
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "game.json"), JSON.stringify({ steam: { appId: 480 } }));
    mkdirSync(join(steam, "resources"), { recursive: true });
    await createPackage(src, join(steam, "resources", "app.asar"));
    expect(planItchPublish(loadProject(dir), { target: "me/game", targets: ["windows"] }, "/bin/butler").problems[0]).toContain("Steam につなぐ書き出し");
    expect(() => parseItchTargets("browser,ios")).toThrow("browser、windows、mac、linux");
    expect(parseTargetMap("browser=a,windows=b", "--build")).toEqual({ browser: "a", windows: "b" });
  });

  it("id が書き出し先の外を指していても、外のフォルダを上げない", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { itch: { target: "me/game" } } }));
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "outside", "index.html"), "");
    const project = loadProject(dir);
    // 読み込みは区切りのある id を止めるので、読んだあとに差し替えて出口の守りだけを確かめる
    project.config.id = "../../outside";
    const plan = planItchPublish(project, { targets: ["browser"] }, "/bin/butler");
    expect(plan.pushes).toEqual([]);
    expect(plan.problems[0]).toContain("browser の書き出しがありません");
  });
});

describe("書き出しの名前（id、版、エディション）で書き出し先の外を指さない", () => {
  it("ブラウザ版のフォルダは <書き出し先>/browser の直下だけ", () => {
    const out = join(dir, "dist");
    expect(browserBuildDir(out, "g", "demo", true)).toBe(join(out, "browser", "g-demo-test"));
    for (const [id, variant] of [["..", undefined], [".", undefined], ["../../x", undefined], ["g", "../../../x"], ["a/b", undefined]] as const) {
      expect(browserBuildDir(out, id, variant, false), `${id} ${variant}`).toBeNull();
    }
  });

  it("フォルダやファイルの名前にならないものを挙げる", () => {
    expect(unsafeExportNames(["g", "G_1.0.0_Setup.exe", "星の丘_demo", "g.desktop"])).toEqual([]);
    expect(unsafeExportNames(["g", "G_../../x_Setup.exe", "..", "a\\b"])).toEqual(["G_../../x_Setup.exe", "..", "a\\b"]);
  });

  it("見るのは書き出す先の分だけ（題名に / がある作品もブラウザ版は書き出せる）", () => {
    const base = { id: "g", variant: undefined, feedback: false, fileSafeName: "A/B", version: "1.0.0", linuxExe: "g" };
    expect(unsafeExportNames(exportPathNames({ ...base, targets: ["browser"] }))).toEqual([]);
    expect(unsafeExportNames(exportPathNames({ ...base, targets: ["browser", "windows"] }))).toEqual(["A/B", "A/B_1.0.0_Setup.exe"]);
    expect(unsafeExportNames(exportPathNames({ ...base, fileSafeName: "G", version: "../1", targets: ["mac"] }))).toEqual([]);
    expect(unsafeExportNames(exportPathNames({ ...base, fileSafeName: "G", version: "../1", targets: ["windows"] }))).toEqual(["G_../1_Setup.exe"]);
    expect(unsafeExportNames(exportPathNames({ ...base, fileSafeName: "G", variant: "../x", targets: ["browser"] }))).toEqual(["g-../x"]);
  });
});

describe("テスト版の書き出し（lim build --feedback）を上げない", () => {
  /** 書き出したデスクトップ版のにせもの（app.asar の中の game.json と web/project/build.json）。 */
  async function fakeDesktop(folder: string, build: object): Promise<void> {
    const src = join(dir, `src-${Math.random()}`);
    mkdirSync(join(src, "web", "project"), { recursive: true });
    writeFileSync(join(src, "game.json"), JSON.stringify({ title: "G", steam: { appId: 480 } }));
    writeFileSync(join(src, "web", "project", "build.json"), JSON.stringify(build));
    mkdirSync(join(folder, "resources"), { recursive: true });
    await createPackage(src, join(folder, "resources", "app.asar"));
    writeFileSync(join(folder, "G.exe"), "");
  }
  /** 書き出したブラウザ版のにせもの。 */
  function fakeBrowser(folder: string, build: object): void {
    mkdirSync(join(folder, "project"), { recursive: true });
    writeFileSync(join(folder, "index.html"), "");
    writeFileSync(join(folder, "project", "build.json"), JSON.stringify(build));
  }

  it("テスト版はブラウザ版を <id>-test に、デスクトップ版を名前に _test を付けて書き出すので、製品の書き出しと分かれる", () => {
    expect(browserBuildName("g", undefined, false)).toBe("g");
    expect(browserBuildName("g", undefined, true)).toBe("g-test");
    expect(browserBuildName("g", "demo", true)).toBe("g-demo-test");
  });

  it("build.json の feedback を見て止め、--allow-test なら上げる（itch.io と Steam）", async () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", version: "1.0.0", entry: "start", build: { itch: { target: "me/game" }, steam: { appId: 480, depots: { windows: 481 } } } }));
    // 前の版のテスト版は製品と同じ所に書いていた（build.json にだけ印がある）
    fakeBrowser(join(dir, "dist", "browser", "g"), { id: "g", version: "1.0.0", feedback: true });
    await fakeDesktop(join(dir, "dist", "windows", "G_test_20261107_120000", "G_test"), { id: "g", feedback: true });
    const itch = planItchPublish(loadProject(dir), { targets: ["browser"] }, "/bin/butler");
    expect(itch.problems).toEqual([expect.stringContaining("はテスト版の書き出しです")]);
    expect(itch.problems[0]).toContain("--allow-test");
    expect(planItchPublish(loadProject(dir), { targets: ["browser"], allowTest: true }, "/bin/butler").problems).toEqual([]);
    const steam = planSteamPublish(loadProject(dir), { dryRun: true });
    expect(steam.problems.join("\n")).toMatch(/G_test はテスト版の書き出しです/);
    expect(planSteamPublish(loadProject(dir), { dryRun: true, allowTest: true }).problems).toEqual([]);
    // 製品を書き出し直せば上げる
    fakeBrowser(join(dir, "dist", "browser", "g"), { id: "g", version: "1.0.0" });
    await fakeDesktop(join(dir, "dist", "windows", "G_20261107_130000", "G"), { id: "g" });
    expect(planItchPublish(loadProject(dir), { targets: ["browser"] }, "/bin/butler").problems).toEqual([]);
    expect(planSteamPublish(loadProject(dir), { dryRun: true }).problems).toEqual([]);
  });

  it("配る形のファイル（zip、インストーラー）は横の書き出しを見る。build.json が読めなければ書き出しの記録を見る", async () => {
    const out = join(dir, "dist");
    const stamped = join(out, "windows", "G_test_20261107_120000");
    await fakeDesktop(join(stamped, "G_test"), { id: "g", feedback: true });
    writeFileSync(join(stamped, "G_test_1.0.0_Setup.exe"), "");
    expect(isTestBuild(join(stamped, "G_test_1.0.0_Setup.exe"), out)).toBe(true);
    expect(builtInfo(join(stamped, "G_test"), out)).toMatchObject({ id: "g", feedback: true });
    // 中身の読めないもの（暗号にした build.json など）は、記録で、その出力を書いた一番新しい書き出しを見る
    const zip = join(out, "browser", "g.zip");
    mkdirSync(join(out, "browser"), { recursive: true });
    writeFileSync(zip, "");
    expect(isTestBuild(zip, out)).toBe(false);
    recordBuild(out, { id: "g", version: "1.0.0", engine: "0.1.0", targets: ["browser"], feedback: true, outputs: [zip] });
    expect(isTestBuild(zip, out)).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "build-history.jsonl"), "utf8").trim()).feedback).toBe(true);
    recordBuild(out, { id: "g", version: "1.0.1", engine: "0.1.0", targets: ["browser"], outputs: [zip] });
    expect(isTestBuild(zip, out)).toBe(false);
  });

  it("lim update-manifest もテスト版の本体を入れない（--allow-test なら入れる）", async () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", version: "1.0.0", entry: "start" }));
    const stamped = join(dir, "dist", "windows", "G_test_20261107_120000");
    await fakeDesktop(join(stamped, "G_test"), { id: "g", feedback: true });
    writeFileSync(join(stamped, "G_test.zip"), "zip");
    const app = { windows: "dist/windows/G_test_20261107_120000/G_test.zip" };
    await expect(makeUpdateManifest(loadProject(dir), { baseUrl: "https://example.com/u/", apps: app, out: join(dir, "u1") })).rejects.toThrow(/テスト版の書き出しです/);
    const r = await makeUpdateManifest(loadProject(dir), { baseUrl: "https://example.com/u/", apps: app, out: join(dir, "u2"), allowTest: true });
    expect(Object.keys(r.manifest.app?.files ?? {})).toEqual(["windows"]);
  });
});

describe("作品の CI のひな形（templates/ci/*.yml）", () => {
  const root = join(import.meta.dirname, "../../..");
  const templates = readdirSync(join(root, "templates/ci"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ file: f, text: readFileSync(join(root, "templates/ci", f), "utf8") }));
  /** actions/checkout の段（with: の中身と一緒に）。 */
  const checkouts = (text: string) => [...text.matchAll(/- uses: actions\/checkout@[0-9a-f]{40}(?: # [^\n]*)?\n((?: {8,}\S.*\n)*)/g)].map((m) => m[0]);

  it("三つとも置いてある", () => {
    expect(templates.map((t) => t.file).sort()).toEqual(["liminalia-check.yml", "liminalia-export.yml", "liminalia-publish.yml"]);
  });

  it("作品のチェックアウトは Git LFS の素材も取る（制作画面で LFS に入れた素材がポインタのまま検査と書き出しに渡らないように）", () => {
    for (const t of templates) {
      const own = checkouts(t.text).filter((c) => !c.includes("repository:"));
      expect(own.length, t.file).toBe(1);
      expect(own[0], t.file).toContain("lfs: true");
    }
  });

  it("ソースを使う CI のひな形はエンジンのリポジトリを参照する", () => {
    for (const t of templates) {
      expect(t.text, t.file).not.toContain("OWNER");
      expect(t.text, t.file).toContain("repository: skyt-a/liminalia");
    }
  });

  it("使う actions の版を、エンジンのリポジトリのワークフローとそろえる", () => {
    const used = new Map<string, Set<string>>();
    for (const f of readdirSync(join(root, ".github/workflows")).filter((x) => x.endsWith(".yml"))) {
      for (const m of readFileSync(join(root, ".github/workflows", f), "utf8").matchAll(/uses: (actions\/[a-z-]+)@([0-9a-f]{40})/g)) used.set(m[1]!, (used.get(m[1]!) ?? new Set()).add(m[2]!));
    }
    for (const t of templates) {
      for (const m of t.text.matchAll(/uses: (actions\/[a-z-]+)@([0-9a-f]{40})/g)) {
        const repo = used.get(m[1]!);
        if (repo) expect([...repo], `${t.file} の ${m[1]}@${m[2]}`).toContain(m[2]);
      }
    }
  });
});

describe("書き出して配る CI のひな形（templates/ci/liminalia-publish.yml）", () => {
  const template = readFileSync(join(import.meta.dirname, "../../../templates/ci/liminalia-publish.yml"), "utf8");

  it("エンジンの版はそのときの版のタグで固定してあり、消して空にしたら止める", () => {
    expect(template).toMatch(/^ {2}LIMINALIA_ENGINE_REF: v\d+\.\d+\.\d+/m);
    expect(template).toContain("if: env.LIMINALIA_ENGINE_REF == ''");
    expect(template).toContain("ref: ${{ env.LIMINALIA_ENGINE_REF }}");
  });

  // CI のひな形の段を bash で何度か動かす
  it("版のタグで動いたときは、タグと liminalia.json の version が違えば止める", { skip: process.platform === "win32", timeout: 30_000 }, () => {
    const step = /- name: 作品の版を確かめる\n {8}if: github\.ref_type == 'tag'\n {8}run: \|\n((?: {10}.*\n)+)/.exec(template);
    expect(step).not.toBeNull();
    const script = step![1]!.replace(/^ {10}/gm, "");
    const dir = mkdtempSync(join(tmpdir(), "liminalia-publish-ci-"));
    try {
      const run = (version: string | undefined, tag: string) => {
        writeFileSync(join(dir, "liminalia.json"), JSON.stringify(version === undefined ? {} : { version }));
        return spawnSync("bash", ["-e", "-c", script], { cwd: dir, env: { ...process.env, LC_ALL: "C.UTF-8", GITHUB_REF_NAME: tag }, encoding: "utf8" });
      };
      expect(run("1.0.1", "v1.0.1").status).toBe(0);
      const wrong = run("1.0.0", "v1.0.1");
      expect(wrong.status).toBe(1);
      expect(wrong.stdout).toContain("::error::タグ v1.0.1 と liminalia.json の version（1.0.0）が違います");
      expect(run(undefined, "v1.0.1").status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
