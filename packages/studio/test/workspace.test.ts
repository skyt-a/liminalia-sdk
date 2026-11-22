import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { hashText, StudioWorkspace } from "../src/server/workspace.ts";
import { HISTORY_RECENT } from "../src/server/versions.ts";

/** 制作画面の開発サーバーの中身。ひな形の写しを作業用フォルダに作って使う。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-studio-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const scenario = (file: string) => join(dir, "scenario", `${file}.lim`);
const disk = (file: string) => readFileSync(scenario(file), "utf8");

describe("読む口", () => {
  it("作品の情報: ファイル・ラベル・話者・キャスト・命令", () => {
    const info = ws.projectInfo();
    expect(info).toMatchObject({ id: "hoshi_wo_matsu_oka", title: "星を待つ丘", entry: "start", screen: { width: 1280, height: 720 }, importManaged: false });
    expect(info.files.map((f) => f.file)).toEqual(["epilogue", "start"]);
    const start = info.files.find((f) => f.file === "start")!;
    expect(start.speakerCounts).toBeDefined();
    expect(Object.values(start.speakerCounts!).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(start.hash).toBe(hashText(disk("start")));
    expect(start.lines).toBe(disk("start").split("\n").length);
    expect(start.labels.slice(0, 3)).toEqual([
      { name: "start", line: 15 },
      { name: "night", line: 43 },
      { name: "menu", line: 51 },
    ]);
    expect(info.speakers).toEqual(["アカリ", "ソウ", "ラジオ"]);
    expect(Object.keys(info.cast)).toEqual(["アカリ", "ソウ"]);
    const names = info.commands.map((c) => c.name);
    expect(names).toContain("bg"); // 組み込み
    expect(names).toContain("image"); // 標準の命令
  });

  it("素材の一覧: 決まったフォルダと命令の探し先ごとのパス（. で始まるものは入れない）", () => {
    writeFileSync(join(dir, "assets", "bgimage", ".DS_Store"), "");
    const { assets } = ws.projectInfo();
    expect(Object.keys(assets).sort()).toEqual(["bgimage", "bgm", "fgimage", "image", "others", "sound", "video", "voice"]);
    expect(assets.bgimage).toEqual(["hill_dusk.webp", "hill_morning.webp", "hill_night.webp"]);
    expect(assets.fgimage!.every((p) => p.includes("/"))).toBe(true);
    expect(assets.image).toEqual([]);
    // 増えたら知らせ、一覧を作り直す。関わらないファイルは知らせない
    writeFileSync(join(dir, "assets", "bgimage", "sea.png"), "");
    expect(ws.assetsChanged(join(dir, "assets", "bgimage", "sea.png"))).toEqual({ type: "assets-changed" });
    expect(ws.projectInfo().assets.bgimage).toContain("sea.png");
    expect(ws.assetsChanged(join(dir, "assets", "readme.txt"))).toBeNull();
    expect(ws.assetsChanged(join(dir, "assets", "bgimage", ".DS_Store"))).toBeNull();
    expect(ws.assetsChanged(join(dir, "scenario", "start.lim"))).toBeNull();
  });

  it("取り込みで作る作品なら importManaged", async () => {
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, import: { tyrano: { source: "../tyrano" } } }));
    expect((await StudioWorkspace.open(loadProject(dir))).projectInfo().importManaged).toBe(true);
  });

  it("ファイルの名前はシナリオのフォルダの中だけ", () => {
    for (const bad of ["../liminalia", "/etc/passwd", "a/../../b", ".hidden", "a\\b", ""]) expect(() => ws.fileText(bad), bad).toThrow();
    expect(() => ws.fileText("nothing")).toThrow("nothing.lim がありません");
  });

  it("フォルダの中の .lim も part/name の名前で読む", () => {
    writeFileSync(join(dir, "scenario", "x.tmp"), "");
    cpSync(scenario("epilogue"), join(dir, "scenario", "part1", "after.lim"));
    expect(ws.files()).toEqual(["epilogue", "part1/after", "start"]);
    expect(ws.fileText("part1/after").text).toBe(disk("epilogue"));
  });
});

describe("書き込み口", () => {
  it("base が合えば書き、前の版を履歴に残し、そのファイルの検査を返す", () => {
    const before = ws.fileText("epilogue");
    const text = before.text.replace("気がつくと", "目を開けると");
    const r = ws.write("epilogue", text, before.hash);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toMatchObject({ file: "epilogue", hash: hashText(text), diagnostics: [] });
    expect(disk("epilogue")).toBe(text);
    // 一時ファイルを残さない
    expect(readdirSync(join(dir, "scenario")).sort()).toEqual(["epilogue.lim", "start.lim"]);
    const history = ws.history("epilogue");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: r.result.history, bytes: Buffer.byteLength(before.text) });
    expect(ws.historyItem("epilogue", r.result.history!)).toEqual(before);
    expect(existsSync(join(dir, ".liminalia/history/epilogue", `${r.result.history}.lim`))).toBe(true);
  });

  it("ディスクが base と違えば書かずに 409 の中身（今の内容）を返す", () => {
    const base = ws.fileText("epilogue");
    writeFileSync(scenario("epilogue"), base.text + "\n外で書き足した行。\n");
    const r = ws.write("epilogue", base.text.replace("夜明け", "朝"), base.hash);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflict.current.text).toContain("外で書き足した行。");
    expect(r.conflict.current.hash).toBe(hashText(disk("epilogue")));
    expect(disk("epilogue")).toContain("外で書き足した行。");
    expect(ws.history("epilogue")).toEqual([]);
  });

  it("内容が同じなら書かず、履歴も作らない", () => {
    const base = ws.fileText("start");
    const r = ws.write("start", base.text, base.hash);
    expect(r.ok && r.result.history).toBe(null);
    expect(ws.history("start")).toEqual([]);
  });

  it("新しいファイルは baseHash を null にして作る。あるファイルに null なら 409", () => {
    const created = ws.write("part2/side", "寄り道。\n", null);
    expect(created.ok && created.result.history).toBe(null);
    expect(readFileSync(join(dir, "scenario/part2/side.lim"), "utf8")).toBe("寄り道。\n");
    expect(ws.write("start", "上書き", null).ok).toBe(false);
    expect(() => ws.write("gone", "x", "0123456789abcdef")).toThrow("ありません");
  });

  it("書いたあとの検査は一度だけ行い、そのファイルの診断と全体を返す", () => {
    const start = ws.fileText("start");
    expect(ws.write("start", `${start.text}\n@nosuch-start\n`, start.hash, false)).toMatchObject({ ok: true, result: { diagnostics: [] } });
    const base = ws.fileText("epilogue");
    const r = ws.write("epilogue", `${base.text}\n@nosuch\n`, base.hash);
    if (!r.ok) throw new Error("conflict");
    expect(r.result.diagnostics.map((d) => [d.code, d.file])).toEqual([["unknown-command", "epilogue"]]);
    // 全体（POST /check と同じもの）も添える。画面はこれを使い、検査をし直さない
    expect(r.result.check!.diagnostics.map((d) => [d.code, d.file, d.category])).toEqual(ws.check().diagnostics.map((d) => [d.code, d.file, d.category]));
    // start の終わりの命令は前の行から届かない（情報）
    expect(r.result.check!.diagnostics.filter((d) => d.severity !== "info").map((d) => d.file).sort()).toEqual(["epilogue", "start"]);
    expect(r.result.check!.counts.command).toBe(2);
  });

  it("liminalia.json は字面が変わったときだけ読み直す", () => {
    const first = ws.readConfig();
    expect(ws.readConfig()).toBe(first);
    expect(ws.readUi()).toBe(first.ui);
    const path = join(dir, "liminalia.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, variables: { "game.x": 3 } }));
    expect(ws.readConfig()).not.toBe(first);
    expect(ws.readVariables()).toEqual({ "game.x": 3 });
    writeFileSync(path, "{ 読めない");
    expect(ws.readConfig()).toBe(ws.project.config);
  });

  it(`続けて書いた履歴は、新しい ${HISTORY_RECENT} 件のほかは 1 分に一つまで間引く`, () => {
    let base = ws.fileText("epilogue").hash;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = ws.write("epilogue", `版 ${i}\n`, base);
      if (!r.ok) throw new Error("conflict");
      base = r.result.hash;
      ids.push(r.result.history!);
    }
    const history = ws.history("epilogue");
    // 書いている間に分が替われば、替わる前の分の最後のものも残る
    expect(history.length).toBeGreaterThanOrEqual(HISTORY_RECENT + 1);
    expect(history.length).toBeLessThanOrEqual(HISTORY_RECENT + 2);
    expect(history.slice(0, HISTORY_RECENT).map((h) => h.id)).toEqual(ids.slice(-HISTORY_RECENT).reverse());
    expect(readdirSync(join(dir, ".liminalia/history/epilogue"))).toHaveLength(history.length);
    expect(ws.historyItem("epilogue", history[0]!.id).text).toBe("版 18\n");
    expect(Date.parse(history[0]!.time)).toBeGreaterThan(Date.now() - 60_000);
    expect(() => ws.historyItem("epilogue", "../start")).toThrow();
    expect(ws.history("start")).toEqual([]);
  });
});

describe("外の変更", () => {
  it("自分の書き込みは知らせず、外の変更・追加・削除・cast.json の変更を知らせる", () => {
    const base = ws.fileText("epilogue");
    const r = ws.write("epilogue", base.text + "\n書き足し。\n", base.hash);
    expect(r.ok).toBe(true);
    expect(ws.changed(scenario("epilogue"))).toBeNull();

    writeFileSync(scenario("epilogue"), "外で書いた。\n");
    expect(ws.changed(scenario("epilogue"))).toEqual({ type: "file-changed", file: "epilogue", hash: hashText("外で書いた。\n") });
    // 同じ内容の知らせが重なっても一度だけ
    expect(ws.changed(scenario("epilogue"))).toBeNull();

    writeFileSync(scenario("extra"), "足した。\n");
    expect(ws.changed(scenario("extra"))).toEqual({ type: "file-added", file: "extra" });
    unlinkSync(scenario("extra"));
    expect(ws.changed(scenario("extra"))).toEqual({ type: "file-removed", file: "extra" });

    expect(ws.changed(join(dir, "cast.json"))).toEqual({ type: "cast-changed" });
    expect(ws.changed(join(dir, "scenario", "note.txt"))).toBeNull();
    expect(ws.changed(join(dir, "other.lim"))).toBeNull();
  });
});

describe("点検", () => {
  it("ひな形は検査で何も出ない", () => {
    const r = ws.check();
    expect(r.diagnostics).toEqual([]);
    expect(r.counts).toEqual({ syntax: 0, command: 0, cast: 0, target: 0, asset: 0, plugin: 0 });
  });

  it("文法・命令・キャスト・飛び先・素材に分ける", () => {
    writeFileSync(
      scenario("broken"),
      ["{r 閉じない", "@nosuch", "@bg (1 +", "@chara ダレ normal", "@chara アカリ nosuch", "@jump start#nowhere", "@jump nofile", "@bg missing.png", "@choice", "- 画像 -> #a image=nosuch.png", "@end", "# a"].join("\n"),
    );
    const r = ws.check();
    expect(r.diagnostics.every((d) => d.file === "broken")).toBe(true);
    expect(r.counts.syntax).toBe(2); // { と ( の閉じ忘れ
    expect(r.counts.command).toBe(2); // 無い命令と、式が壊れて欠けた引数
    expect(r.counts.cast).toBe(2);
    expect(r.counts.target).toBe(3); // 無いラベルと無いファイルと、@jump の後の届かない行
    expect(r.counts.asset).toBe(2);
    expect(r.counts.plugin).toBe(0);
    // 診断ごとに分類を持ち、件数と合う
    for (const k of ["syntax", "command", "cast", "target", "asset", "plugin"] as const) expect(r.diagnostics.filter((d) => d.category === k).length, k).toBe(r.counts[k]);
    expect(r.diagnostics.find((d) => d.code === "unknown-label")?.category).toBe("target");
    expect(r.diagnostics.filter((d) => d.code === "missing-asset").map((d) => [d.line, d.message])).toEqual([
      [8, "素材 bgimage/missing.png がありません"],
      [10, "素材 image/nosuch.png がありません"],
    ]);
  });

  it("キャストの定義の立ち絵が無ければ素材の欠け、形の誤りはキャスト", () => {
    const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, { appearances: Record<string, { variants: Record<string, { image: string }> }> }> };
    cast.cast["アカリ"]!.appearances.default!.variants.normal!.image = "akari/none.png";
    (cast.cast as Record<string, unknown>)["ソウ"] = { outfits: {} };
    writeFileSync(join(dir, "cast.json"), JSON.stringify(cast));
    ws.changed(join(dir, "cast.json"));
    const r = ws.check();
    // 型に無い項目（outfits）は、lim check と同じく unknown-config-key でも知らせる
    expect(r.diagnostics.filter((d) => d.file === "cast.json").map((d) => d.code).sort()).toEqual(["bad-cast", "missing-asset", "unknown-config-key"]);
    expect(r.counts.asset).toBe(1);
    expect(r.counts.cast).toBeGreaterThanOrEqual(1);
  });

  it("画面なしで流した網羅（lim coverage と同じ）", async () => {
    const r = await ws.coverage();
    expect(r.files.map((f) => f.file)).toEqual(["epilogue", "start"]);
    const start = r.files.find((f) => f.file === "start")!;
    expect(start.reached).toBe(start.lines - start.unreached.length);
    expect(start.reached / start.lines).toBeGreaterThan(0.9);
    expect(r.diagnostics).toEqual([]);
  });

  it("覚えた全ルートテストの結果は、エンジンの版か設定が変わっていれば古い結果として返す", async () => {
    const path = join(dir, ".liminalia", "coverage.json");
    const r = await ws.coverage();
    expect(r.engine).toBe(JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).version);
    expect(ws.lastCoverage()).toEqual(r);
    expect(ws.lastCoverage()!.outdated).toBeUndefined();
    // 版を覚える前の制作画面が書いた結果（engine が無い）と、ほかの版の結果は、今の結果としては返さない
    const { engine: _, ...old } = r;
    writeFileSync(path, JSON.stringify(old));
    expect(ws.lastCoverage()).toMatchObject({ at: r.at, outdated: "engine" });
    writeFileSync(path, JSON.stringify({ ...r, engine: "0.0.1" }));
    expect(ws.lastCoverage()!.outdated).toBe("engine");
    // 書いてある outdated は信じない（今と比べ直す）
    writeFileSync(path, JSON.stringify({ ...r, outdated: "engine" }));
    expect(ws.lastCoverage()!.outdated).toBeUndefined();
    // 実行後に cast.json、liminalia.json、作品のデータが変わったら、設定の変わった古い結果
    writeFileSync(path, JSON.stringify(r));
    const castText = readFileSync(join(dir, "cast.json"), "utf8");
    writeFileSync(join(dir, "cast.json"), castText.replace("{", '{ "speakers": ["ほかの人"],'));
    expect(ws.lastCoverage()!.outdated).toBe("settings");
    writeFileSync(join(dir, "cast.json"), castText);
    expect(ws.lastCoverage()!.outdated).toBeUndefined();
    const config = readFileSync(join(dir, "liminalia.json"), "utf8");
    writeFileSync(join(dir, "liminalia.json"), config.replace("{", '{ "variables": { "game.外": 1 },'));
    expect(ws.lastCoverage()!.outdated).toBe("settings");
    writeFileSync(join(dir, "liminalia.json"), config);
    mkdirSync(join(dir, "data", "places"), { recursive: true });
    writeFileSync(join(dir, "data", "places", "room.json"), "{}");
    expect(ws.lastCoverage()!.outdated).toBe("settings");
    // 流し直せば今の結果
    const again = await ws.coverage();
    expect(ws.lastCoverage()).toEqual(again);
  });

  it("全ルートテストは、分岐の見本（選択肢の入れ子、合流、変数で分かれる結末）の本文をすべて通る", async () => {
    // packages/runtime/test/fixtures/branching。どの選択肢でも同じ番号を選び続ける流し方では、二つの結末の行に届かなかった
    const own = mkdtempSync(join(tmpdir(), "liminalia-studio-branching-"));
    try {
      cpSync(resolve(import.meta.dirname, "../../runtime/test/fixtures/branching"), own, { recursive: true });
      const branching = await StudioWorkspace.open(loadProject(own));
      const progress: number[] = [];
      const r = await branching.coverage(undefined, (p) => progress.push(p.done));
      expect(r.files.map((f) => [f.file, f.reached, f.lines, f.unreached])).toEqual([
        ["epilogue", 1, 1, []],
        ["start", 11, 11, []],
      ]);
      expect(r.diagnostics).toEqual([]);
      // 選び方を試し終えたら上限（ファイルごとに 8 回）より前に止める（epilogue は 1 回、start は 7 通り）。経過の数は上限の分まで進める
      expect(progress).toHaveLength(8);
      expect(progress.every((d, i) => i === 0 || d > progress[i - 1]!)).toBe(true);
      expect(progress.at(-1)).toBeLessThanOrEqual(16);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe("現在地", () => {
  it("覚えておき、.lim が変わったら作り直す", async () => {
    const a = await ws.sweep("start");
    const b = await ws.sweep("start");
    expect(b.sweep).toBe(a.sweep);
    expect(a.sweep.hash).toBe(hashText(disk("start")));
    expect(JSON.parse(a.json)).toEqual(JSON.parse(JSON.stringify(a.sweep)));
    expect((await a.gz()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    const base = ws.fileText("epilogue");
    ws.write("epilogue", base.text + "\n書き足し。\n", base.hash);
    const c = await ws.sweep("start");
    expect(c.sweep).not.toBe(a.sweep);
    expect(c.sweep.hash).toBe(a.sweep.hash);

    writeFileSync(scenario("start"), disk("start").replace("小さな天文台がある。", "古い天文台がある。"));
    ws.changed(scenario("start"));
    const d = await ws.sweep("start");
    expect(d.sweep.hash).not.toBe(a.sweep.hash);
  });

  it("持続の帯は現在地から抜き出し、現在地と一緒に覚えておく", async () => {
    const t = await ws.stageTrack("start");
    expect(t.hash).toBe(hashText(disk("start")));
    expect(await ws.stageTrack("start")).toBe(t);
    const { sweep } = await ws.sweep("start");
    expect(Object.keys(t.lines)).toEqual(Object.keys(sweep.lines));
    expect(t.states[t.lines[23]!]!.background).toBe("hill_dusk.webp");
    writeFileSync(scenario("start"), disk("start").replace("小さな天文台がある。", "古い天文台がある。"));
    ws.changed(scenario("start"));
    const u = await ws.stageTrack("start");
    expect(u).not.toBe(t);
    expect(u.hash).toBe(hashText(disk("start")));
  });

  it("liminalia.json の autoLayout を書き換えると、作品の情報と現在地と持続の帯の立ち位置が新しい並べ方になる", async () => {
    writeFileSync(scenario("al"), "@chara アカリ normal auto-layout\n@chara ソウ normal auto-layout\n本文。\n");
    ws.changed(scenario("al"));
    const at = async () => {
      const t = await ws.stageTrack("al");
      return Object.fromEntries(Object.entries(t.states[t.lines[3]!]!.sprites).map(([who, m]) => [who, m.at]));
    };
    expect(await at()).toEqual({ アカリ: "left", ソウ: "right" });
    expect(ws.projectInfo().autoLayout).toBeUndefined();
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"));
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, autoLayout: { positions: { "2": ["30%", "70%"] }, enter: "start" } }));
    expect(ws.variablesChanged()).toBe(true);
    expect(ws.variablesChanged()).toBe(false);
    expect(ws.projectInfo().autoLayout).toEqual({ positions: { "2": ["30%", "70%"] }, enter: "start" });
    // 入れる場所が左の端なので、あとから来たソウが左
    expect(await at()).toEqual({ アカリ: "70%", ソウ: "30%" });
  });

  it("同時に頼まれても一つずつ作る", async () => {
    const [a, b] = await Promise.all([ws.sweep("epilogue"), ws.sweep("epilogue")]);
    expect(a.sweep).toBe(b.sweep);
    expect(a.sweep.route.length).toBeGreaterThan(0);
  });
});

describe("台本のフォルダの外へのリンク（2026-11-20 の S19）", () => {
  it("台本の下のフォルダが作品の外へのリンクなら、その先へ書かない", async () => {
    const victim = mkdtempSync(join(tmpdir(), "liminalia-victim-"));
    try {
      symlinkSync(victim, join(dir, "scenario", "part"), "dir");
      const fresh = await StudioWorkspace.open(loadProject(dir));
      expect(() => fresh.write("part/start", "書かれては困る。\n", null)).toThrow(/リンクの先/);
      expect(readdirSync(victim)).toEqual([]);
      // 作品の中のファイルはそのまま書ける
      expect(fresh.write("extra", "ふつうの台本。\n", null).ok).toBe(true);
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });

  it("台本のフォルダそのものが作品の外へのリンクなら、その先へ書かない", async () => {
    const victim = mkdtempSync(join(tmpdir(), "liminalia-victim-"));
    try {
      rmSync(join(dir, "scenario"), { recursive: true, force: true });
      symlinkSync(victim, join(dir, "scenario"), "dir");
      const fresh = await StudioWorkspace.open(loadProject(dir));
      expect(() => fresh.write("start", "書かれては困る。\n", null)).toThrow(/リンクの先/);
      expect(readdirSync(victim)).toEqual([]);
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });
});

describe("現在地の控えの数（2026-11-20 の P7）", () => {
  it("覚えるファイルの数に上限があり、古く使ったものから捨てて、頼まれたら作り直す", async () => {
    for (let i = 0; i < 10; i++) writeFileSync(scenario(`p${i}`), `ページ${i}。\n`);
    const fresh = await StudioWorkspace.open(loadProject(dir));
    const first = await fresh.sweep("p0");
    for (let i = 1; i < 10; i++) await fresh.sweep(`p${i}`);
    const cache = (fresh as unknown as { sweeps: Map<string, unknown> }).sweeps;
    expect(cache.size).toBe(8);
    expect(cache.has("p0")).toBe(false);
    // 捨てたものは作り直す（中身は同じ）
    expect((await fresh.sweep("p0")).json).toBe(first.json);
    // 新しく使ったものは残る
    await fresh.sweep("p9");
    await fresh.sweep("p1");
    expect(cache.has("p9")).toBe(true);
  });
});
