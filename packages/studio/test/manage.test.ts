import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceArgumentValue } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { configListHash, configPartHash, createPlugin, listPlugins, listVariables, partHistory, partHistoryItem, readPartFile, updatePlugin, readSettings, readTranslation, renameVariable, restartNeeded, setExtra, setSettings, setLanguages, setPlugins, setUi, setVariable, translationStatus, writePartFile, writeTranslation } from "../src/server/manage.ts";
import { assetFolderToReveal, assetFileToReveal, scenarioFileToReveal, assetUsage, castUsage, createScenario, duplicateScenario, listAssets, listTrash, makeAssetFolder, moveAcross, renameAsset, renameCast, renameMacro, renameScenario, restoreTrash, trashAsset, trashAssets, trashScenario } from "../src/server/manage.ts";
import { revealFileCommand } from "../src/server/reveal-file.ts";
import { collectTranslatable, parse, PLUGIN_API_VERSION, updateTranslation, type TranslationFile } from "@liminalia/lang";

/** 素材とキャラクターの管理。ひな形の写しを作業用フォルダに作って使う。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-manage-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const scenario = (file: string) => readFileSync(join(dir, "scenario", `${file}.lim`), "utf8");
const castJson = () => JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers: string[]; cast: Record<string, { speaker?: string; appearances: Record<string, { variants: Record<string, { image: string }> }> }> };

describe("台本・素材のファイルを選んで表示", () => {
  it("指定した台本を返し、存在しない名前や不正なパスは拒否する", () => {
    createScenario(ws, "part/chapter");
    expect(scenarioFileToReveal(ws, "start")).toBe(join(dir, "scenario/start.lim"));
    expect(scenarioFileToReveal(ws, "part/chapter")).toBe(join(dir, "scenario/part/chapter.lim"));
    expect(() => scenarioFileToReveal(ws, "missing")).toThrow();
    expect(() => scenarioFileToReveal(ws, "../secret")).toThrow();
  });

  it("プロジェクトで変更したシナリオの置き場所に従う", async () => {
    const path = join(dir, "liminalia.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.paths = { ...config.paths, scenario: "custom/scenes" };
    writeFileSync(path, JSON.stringify(config));
    mkdirSync(join(dir, "custom/scenes/sub"), { recursive: true });
    writeFileSync(join(dir, "custom/scenes/sub/chapter.lim"), "本文。\n");
    const custom = await StudioWorkspace.open(loadProject(dir));
    expect(scenarioFileToReveal(custom, "sub/chapter")).toBe(join(dir, "custom/scenes/sub/chapter.lim"));
  });

  it("素材の正しいファイルを返し、欠けた素材・外へのパス・リンクは拒否する", () => {
    expect(assetFileToReveal(ws, "bgimage", "hill_dusk.webp")).toBe(join(dir, "assets/bgimage/hill_dusk.webp"));
    expect(() => assetFileToReveal(ws, "bgimage", "missing.webp")).toThrow();
    expect(() => assetFileToReveal(ws, "bgimage", "../outside")).toThrow();
    expect(() => assetFileToReveal(ws, "../outside", "file")).toThrow();
    symlinkSync(join(dir, "scenario"), join(dir, "assets/bgimage/link"));
    expect(() => assetFileToReveal(ws, "bgimage", "link/start.lim")).toThrow();
  });

  it("Mac と Windows は対象ファイルを選び、Linux は親フォルダを開く", () => {
    const path = "/a folder/場面.png";
    expect(revealFileCommand("darwin", path)).toEqual({ cmd: "open", args: ["-R", path] });
    expect(revealFileCommand("win32", path)).toEqual({ cmd: "explorer", args: [`/select,${path}`] });
    expect(revealFileCommand("linux", path)).toEqual({ cmd: "xdg-open", args: ["/a folder"] });
  });
});

describe("引数の値の書き換え", () => {
  it("キーはそのまま、空白を含む値は囲む。今の値が違えば書き換えない", () => {
    expect(replaceArgumentValue("@bg room.png time=1s", 5, "hall.png", "room.png")).toBe("@bg hall.png time=1s");
    expect(replaceArgumentValue("@image file=a.png at=left", 8, "b c.png")).toBe('@image file="b c.png" at=left');
    expect(replaceArgumentValue('@bg "a b.png" time=1s', 5, "c.png", "a b.png")).toBe("@bg c.png time=1s");
    expect(replaceArgumentValue("@bg room.png", 5, "x.png", "other.png")).toBeNull();
  });
});

describe("素材", () => {
  it("一覧はフォルダごとのファイルと大きさ、中のフォルダ", () => {
    const fg = listAssets(ws).find((f) => f.kind === "fgimage")!;
    expect(fg.dirs).toEqual(["akari", "sou"]);
    expect(fg.files.map((f) => f.path)).toContain("akari/normal.webp");
    expect(fg.files.every((f) => f.bytes > 0)).toBe(true);
  });

  it("使っている場所: 台本の行とキャスト", () => {
    const usage = assetUsage(ws);
    expect(usage["bgimage/hill_dusk.webp"]).toContainEqual({ in: "script", file: "start", line: 19 });
    expect(usage["fgimage/akari/normal.webp"]).toEqual([{ in: "cast", who: "アカリ" }]);
  });

  it("名前を変えると、台本の行とキャストも書き換え、台本の前の版は履歴に残る", () => {
    const r = renameAsset(ws, "bgimage", "hill_dusk.webp", "dusk/hill.png");
    expect(r).toMatchObject({ moved: ["dusk/hill.png"], files: ["start"], cast: false, left: [] });
    expect(existsSync(join(dir, "assets", "bgimage", "dusk", "hill.png"))).toBe(true);
    expect(scenario("start").split("\n")[18]).toBe("@bg dusk/hill.png");
    expect(ws.history("start")).toHaveLength(1);

    const f = renameAsset(ws, "fgimage", "akari", "akari2");
    expect(f.cast).toBe(true);
    expect(f.moved).toContain("akari2/normal.webp");
    expect(castJson().cast["アカリ"]!.appearances.default!.variants.normal!.image).toBe("akari2/normal.webp");
    expect(readdirSync(join(dir, ".liminalia", "backups")).some((n) => n.startsWith("cast-"))).toBe(true);
  });

  it("ごみ箱へ動かし、戻せる。戻す先が埋まっていれば戻さない", () => {
    const t = trashAsset(ws, "fgimage", "sou");
    expect(t.moved).toContain("sou/normal.webp");
    expect(existsSync(join(dir, "assets", "fgimage", "sou"))).toBe(false);
    expect(restoreTrash(ws, t.id).restored).toEqual(["fgimage/sou"]);
    expect(existsSync(join(dir, "assets", "fgimage", "sou", "normal.webp"))).toBe(true);

    const one = trashAsset(ws, "bgimage", "hill_night.webp");
    makeAssetFolder(ws, "bgimage", "hill_night.webp");
    expect(() => restoreTrash(ws, one.id)).toThrow(/同じ名前/);
  });

  it("外を指すパスは受けない", () => {
    expect(() => trashAsset(ws, "bgimage", "../cast.json")).toThrow();
    expect(() => renameAsset(ws, "bgimage", "hill_dusk.webp", "../x.png")).toThrow();
    expect(() => makeAssetFolder(ws, "../x", "a")).toThrow();
  });

  it("開くフォルダは素材の中に用意し、外へのパスやリンクを拒む", () => {
    expect(assetFolderToReveal(ws, "fgimage", "akari")).toBe(join(dir, "assets", "fgimage", "akari"));
    const created = assetFolderToReveal(ws, "fgimage", "new/nested");
    expect(existsSync(created)).toBe(true);
    expect(assetFolderToReveal(ws, "fgimage", "")).toBe(join(dir, "assets", "fgimage"));
    expect(() => assetFolderToReveal(ws, "fgimage", "../outside")).toThrow();
    expect(() => assetFolderToReveal(ws, "../outside", "")).toThrow();
    symlinkSync(dir, join(dir, "assets", "fgimage", "link"), "dir");
    expect(() => assetFolderToReveal(ws, "fgimage", "link/nested")).toThrow();
  });
});

describe("キャラクター", () => {
  it("使っている場所: キャスト名の行と話者の台詞の数", () => {
    const u = castUsage(ws);
    expect(u.cast["アカリ"]).toContainEqual({ file: "start", line: 26 });
    expect(u.speakers["アカリ"]).toBeGreaterThan(0);
  });

  it("キャスト名を変えると、台本のキャストの引数と cast.json のキーを書き換え、話者名は保つ", () => {
    const r = renameCast(ws, { kind: "cast", from: "アカリ", to: "akari" });
    expect(r.files.sort()).toEqual(["epilogue", "start"]);
    expect(scenario("start").split("\n")[25]).toBe("@chara akari normal at=center time=400ms");
    // 台詞の行はそのまま
    expect(scenario("start").split("\n")[26]).toMatch(/^アカリ「/);
    const c = castJson();
    expect(Object.keys(c.cast)).toEqual(["akari", "ソウ"]);
    expect(c.cast.akari!.speaker).toBe("アカリ");
    expect(ws.castFile.cast).toHaveProperty("akari");
  });

  it("話者名を変えると、台詞の行の頭と speakers を書き換え、キャストとのつながりを保つ", () => {
    const r = renameCast(ws, { kind: "speaker", from: "アカリ", to: "明里" });
    expect(r.lines).toBeGreaterThan(0);
    expect(scenario("start").split("\n")[26]).toMatch(/^明里「/);
    const c = castJson();
    expect(c.speakers).toEqual(["明里", "ソウ", "ラジオ"]);
    expect(c.cast["アカリ"]!.speaker).toBe("明里");
    expect(() => renameCast(ws, { kind: "speaker", from: "明里", to: "ソウ" })).toThrow(/すでに/);
  });

  it("キャスト名を変えると、本文の中の {@chara …} も書き換え、その行の訳の鍵を新しい鍵へ付け替える", () => {
    const line = 114;
    const scripts = new Map(ws.files().map((f) => [f, ws.script(f).script] as const));
    const made = updateTranslation(null, "en", scripts, ws.castFile.speakers).file;
    const key = collectTranslatable(ws.script("start").script).find((t) => t.line === line)!.key;
    made.lines![key]!.text = "Three times? {click}{@chara アカリ surprised at=left}Too fast!";
    mkdirSync(join(dir, "lang"), { recursive: true });
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify(made, null, 2));
    renameCast(ws, { kind: "cast", from: "アカリ", to: "akari" });
    expect(scenario("start").split("\n")[line - 1]).toContain("{@chara akari surprised at=left}");
    const after = JSON.parse(readFileSync(join(dir, "lang", "en.json"), "utf8")) as TranslationFile;
    const next = collectTranslatable(parse(scenario("start"), "start", { speakers: ws.castFile.speakers })).find((t) => t.line === line)!.key;
    expect(next).not.toBe(key);
    expect(after.lines![key]).toBeUndefined();
    expect(after.lines![next]!.text).toBe("Three times? {click}{@chara アカリ surprised at=left}Too fast!");
  });
});

describe("マクロ", () => {
  it("名前を変えると、@define と呼び出し（行の命令、本文の中、@with）と commandDefaults の鍵を書き換える", () => {
    createScenario(ws, "parts", "// 見出し\n@define title-card(text: string)\n@wait 1s\n@end\n\n@define frame()\n@content\n@end\n");
    createScenario(ws, "macro-use", "@use parts\n# a\n@title-card text=始まり\nアカリ「見て{@title-card text=途中}」\n@with frame\n@title-card text=中\n@end\n");
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"));
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, commandDefaults: { ...(config.commandDefaults ?? {}), "title-card": { text: "x" } } }, null, 2));
    const r = renameMacro(ws, "title-card", "heading");
    expect(r.files.sort()).toEqual(["macro-use", "parts"]);
    expect(r.lines).toBe(4);
    expect(r.config).toBe(true);
    expect(scenario("parts")).toContain("@define heading(text: string)");
    expect(scenario("macro-use")).toBe("@use parts\n# a\n@heading text=始まり\nアカリ「見て{@heading text=途中}」\n@with frame\n@heading text=中\n@end\n");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).commandDefaults).toHaveProperty("heading");
    renameMacro(ws, "frame", "framed");
    expect(scenario("macro-use")).toContain("@with framed\n");
  });

  it("使えない名前、組み込みの命令と同じ名前、ほかのマクロと同じ名前は断る", () => {
    createScenario(ws, "parts", "@define one()\n@end\n@define two()\n@end\n");
    expect(() => renameMacro(ws, "one", "Bad")).toThrow(/英小文字/);
    expect(() => renameMacro(ws, "one", "bg")).toThrow(/組み込み/);
    expect(() => renameMacro(ws, "one", "if")).toThrow(/予約語/);
    expect(() => renameMacro(ws, "one", "two")).toThrow(/すでに/);
    expect(() => renameMacro(ws, "none", "x")).toThrow(/ありません/);
  });

  it("同じ名前のマクロが二つのファイルにあれば、選んだファイルの @define と、それを呼ぶファイルだけを書き換える（S-F4）", () => {
    createScenario(ws, "a", "@define mark()\n@wait 1s\n@end\n# a\n@mark\n");
    createScenario(ws, "b", "@define mark()\n@wait 2s\n@end\n# b\n@mark\n");
    createScenario(ws, "use-a", "@use a\n# x\n@mark\n　見て{@mark}。\n");
    createScenario(ws, "use-b", "@use b\n# y\n@mark\n");
    // 先に @use したファイルのマクロを呼ぶ（b）
    createScenario(ws, "use-ba", "@use b\n@use a\n# z\n@mark\n");
    // 自分の @define が先（a を @use していても）
    createScenario(ws, "own", "@use a\n@define mark()\n@end\n# w\n@mark\n");
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"));
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, commandDefaults: { ...(config.commandDefaults ?? {}), mark: { time: "1s" } } }, null, 2));
    expect(() => renameMacro(ws, "mark", "stamp")).toThrow(/a\.lim/);
    expect(() => renameMacro(ws, "mark", "stamp", "use-a")).toThrow(/ありません/);
    const r = renameMacro(ws, "mark", "stamp", "a");
    expect(r.files.sort()).toEqual(["a", "use-a"]);
    expect(r.lines).toBe(4);
    expect(scenario("a")).toBe("@define stamp()\n@wait 1s\n@end\n# a\n@stamp\n");
    expect(scenario("use-a")).toBe("@use a\n# x\n@stamp\n　見て{@stamp}。\n");
    expect(scenario("b")).toContain("@define mark()");
    expect(scenario("use-b")).toContain("@mark\n");
    expect(scenario("use-ba")).toContain("@mark\n");
    expect(scenario("own")).toContain("@define mark()\n@end\n# w\n@mark\n");
    // もう一方がまだ使うので、commandDefaults は新しい名前へ写し、元の鍵も残す
    const defaults = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).commandDefaults;
    expect(defaults.mark).toEqual({ time: "1s" });
    expect(defaults.stamp).toEqual({ time: "1s" });
    // 一つだけになれば、ファイルを選ばずに変えられる
    expect(renameMacro(ws, "stamp", "seal").files.sort()).toEqual(["a", "use-a"]);
  });
});

describe("シナリオのファイル", () => {
  it("作る・写す。同じ名前があれば作らない", () => {
    createScenario(ws, "chapter/two");
    expect(scenario("chapter/two")).toBe("# two\n");
    expect(() => createScenario(ws, "start")).toThrow(/すでに/);
    duplicateScenario(ws, "epilogue", "epilogue_copy");
    expect(scenario("epilogue_copy")).toBe(scenario("epilogue"));
  });

  it("名前を変えると、ほかのファイルの飛び先と履歴も移す", () => {
    ws.write("epilogue", scenario("epilogue") + "\n", ws.fileText("epilogue").hash);
    expect(ws.history("epilogue")).toHaveLength(1);
    const r = renameScenario(ws, "epilogue", "ending/after");
    expect(r).toEqual({ files: ["start"], entry: false, tests: { files: ["tests/start.limtest"], left: [] } });
    expect(scenario("start").split("\n")[152]).toBe("@jump ending/after");
    expect(existsSync(join(dir, "scenario", "epilogue.lim"))).toBe(false);
    expect(ws.history("ending/after")).toHaveLength(1);
  });

  it("名前を変えると、本文の中の {@…} の飛び先と、式の visits()・read() の文字も書き換える", () => {
    const text = [
      "# extra",
      "@if visits(\"epilogue#end\") > 0 && !read(\"epilogue\")",
      "  　読み終えた。{@sleep-game epilogue#end}",
      "@end",
      "@set game.seen = visits( \"epilogue\" )",
      "　{= visits(\"epilogue_x#a\")}回。",
      "// visits(\"epilogue#end\") はコメントなので変えない",
      "",
    ].join("\n");
    createScenario(ws, "extra", text);
    renameScenario(ws, "epilogue", "ending/after");
    expect(scenario("extra").split("\n")).toEqual([
      "# extra",
      "@if visits(\"ending/after#end\") > 0 && !read(\"ending/after\")",
      "  　読み終えた。{@sleep-game ending/after#end}",
      "@end",
      "@set game.seen = visits( \"ending/after\" )",
      "　{= visits(\"epilogue_x#a\")}回。",
      "// visits(\"epilogue#end\") はコメントなので変えない",
      "",
    ]);
  });

  it("「はじめから」のファイルの名前を変えると entry も書き換える。消すことはできない", () => {
    expect(() => trashScenario(ws, "start")).toThrow(/はじめから/);
    expect(renameScenario(ws, "start", "opening").entry).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).entry).toBe("opening");
  });

  it("ごみ箱へ動かし、戻せる", () => {
    const t = trashScenario(ws, "epilogue");
    expect(existsSync(join(dir, "scenario", "epilogue.lim"))).toBe(false);
    expect(restoreTrash(ws, t.id).restored).toEqual(["@scenario/epilogue.lim"]);
    expect(existsSync(join(dir, "scenario", "epilogue.lim"))).toBe(true);
  });

  it("ごみ箱の一覧: 何を、いつ入れたかを新しい順に出し、戻したものは消える", () => {
    expect(listTrash(ws)).toEqual([]);
    const file = trashScenario(ws, "epilogue");
    const folder = trashAsset(ws, "fgimage", "sou");
    const many = trashAssets(ws, [
      { kind: "bgimage", path: "hill_night.webp" },
      { kind: "bgimage", path: "hill_dusk.webp" },
    ]);
    // 一覧を書く前に入れた（.items.json の無い）ものも、中のいちばん上を出す
    rmSync(join(dir, ".liminalia/trash", folder.id, ".items.json"));
    const list = listTrash(ws);
    expect(list.map((e) => e.id)).toEqual([many.id, folder.id, file.id]);
    expect(list[0]).toMatchObject({ items: [{ kind: "bgimage", path: "hill_night.webp" }, { kind: "bgimage", path: "hill_dusk.webp" }], total: 2 });
    expect(list[1]).toMatchObject({ items: [{ kind: "fgimage", path: "sou", folder: true }], total: 1 });
    expect(list[2]).toMatchObject({ items: [{ kind: "@scenario", path: "epilogue.lim" }], total: 1 });
    expect(Date.parse(list[2]!.time)).toBeGreaterThan(Date.now() - 60_000);
    // 一覧のファイルは戻すものに数えない
    expect(restoreTrash(ws, many.id).restored.sort()).toEqual(["bgimage/hill_dusk.webp", "bgimage/hill_night.webp"]);
    expect(listTrash(ws).map((e) => e.id)).toEqual([folder.id, file.id]);
  });
});

describe("変数", () => {
  it("台本で使っている変数と、読む・書く行", () => {
    const vars = listVariables(ws);
    const looked = vars.find((v) => v.path === "game.looked")!;
    expect(looked.scope).toBe("game");
    expect(looked.writes.length).toBeGreaterThan(0);
    expect(looked.reads.length).toBeGreaterThan(0);
  });

  it("初期値を決めて外せる（liminalia.json の variables）。現在地も初期値で流す", async () => {
    setVariable(ws, "game.score", 10, false);
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).variables).toEqual({ "game.score": 10 });
    expect(listVariables(ws).find((v) => v.path === "game.score")?.initial).toBe(10);
    const sweep = (await ws.sweep("start")).sweep;
    expect(sweep.base.game.score).toBe(10);
    setVariable(ws, "game.score", null, true);
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).variables).toBeUndefined();
    expect(() => setVariable(ws, "temp.x", 1, false)).toThrow();
  });

  it("追加では既存の初期値を上書きせず、409 を返す", () => {
    for (const initial of [10, false, null]) {
      setVariable(ws, "game.score", initial, false);
      const before = readFileSync(join(dir, "liminalia.json"), "utf8");
      expect(() => setVariable(ws, "game.score", 99, false, true)).toThrow(expect.objectContaining({ status: 409 }));
      expect(readFileSync(join(dir, "liminalia.json"), "utf8")).toBe(before);
    }
  });

  it("追加は新しい変数と台本だけの変数に初期値を決められ、通常の保存は上書きできる", () => {
    expect(listVariables(ws).find((v) => v.path === "game.looked")?.initial).toBeUndefined();
    setVariable(ws, "game.score", 10, false, true);
    setVariable(ws, "game.looked", false, false, true);
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).variables).toEqual({ "game.score": 10, "game.looked": false });
    setVariable(ws, "game.score", 99, false);
    expect(listVariables(ws).find((v) => v.path === "game.score")?.initial).toBe(99);
  });

  it("名前を変えると台本と初期値を書き換える", () => {
    setVariable(ws, "game.looked", false, false);
    const r = renameVariable(ws, "game.looked", "game.watched");
    expect(r.files).toContain("start");
    expect(scenario("start")).not.toMatch(/game\.looked\b/);
    expect(scenario("start")).toMatch(/game\.watched/);
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).variables).toEqual({ "game.watched": false });
    expect(() => renameVariable(ws, "game.watched", "game.wished")).toThrow(/すでに/);
  });

  it("本文の中の {= 変数} を書き換えた行は、訳の鍵を付け替え、訳文の中の変数も替える", () => {
    const line = 159;
    const scripts = new Map(ws.files().map((f) => [f, ws.script(f).script] as const));
    const made = updateTranslation(null, "en", scripts, ws.castFile.speakers).file;
    const key = collectTranslatable(ws.script("start").script).find((t) => t.line === line)!.key;
    made.lines![key]!.text = "This is the hill town station.{br}{= temp.news}";
    mkdirSync(join(dir, "lang"), { recursive: true });
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify(made, null, 2));
    renameVariable(ws, "temp.news", "temp.report");
    const after = JSON.parse(readFileSync(join(dir, "lang", "en.json"), "utf8")) as TranslationFile;
    const next = collectTranslatable(parse(scenario("start"), "start", { speakers: ws.castFile.speakers })).find((t) => t.line === line)!.key;
    expect(after.lines![next]!.text).toBe("This is the hill town station.{br}{= temp.report}");
  });
});

describe("作品（おまけ・翻訳・プラグイン）", () => {
  const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"));

  it("おまけの一覧を書き、空なら外す", () => {
    setExtra(ws, { music: [{ file: "quiet_night.wav", title: "静かな夜" }], cg: [] });
    expect(config().extra).toEqual({ music: [{ file: "quiet_night.wav", title: "静かな夜" }] });
    setExtra(ws, { music: [] });
    expect(config().extra).toBeUndefined();
  });

  it("作品の設定（基本と書き出し）を読み書きする。足す項目は決まった並びに入れ、起動し直しが要るかを返す", () => {
    const settings = readSettings(ws);
    expect(settings).toMatchObject({ id: "hoshi_wo_matsu_oka", entry: "start", screen: { width: 1280, height: 720 } });
    // 書き出しの設定だけなら起動し直さない。空の値は外す
    expect(setSettings(ws, { ...settings, build: { bundleId: "com.example.hoshi", exclude: ["drafts/"], mobile: { audio: {} } } })).toMatchObject({ ok: true, restart: false });
    expect(config().build).toEqual({ bundleId: "com.example.hoshi", exclude: ["drafts/"] });
    // 作者は version の後ろに入る。題名を変えたら起動し直す
    const before = readSettings(ws);
    expect(setSettings(ws, { ...readSettings(ws), author: "わたし", title: "新しい題" })).toMatchObject({ ok: true, restart: true });
    expect(restartNeeded(ws, config())).toBe(true);
    expect(Object.keys(config()).slice(0, 5)).toEqual(["id", "title", "version", "author", "entry"]);
    // 起動したときの値に戻せば（元に戻すなど）、起動し直さなくてよい（プロジェクトの画面の帯を消す）
    expect(setSettings(ws, before)).toMatchObject({ ok: true, restart: false });
    expect(restartNeeded(ws, config())).toBe(false);
    // 送らなかった項目は外す。ほかの項目（ui など）は残す
    setSettings(ws, { id: "hoshi_wo_matsu_oka", title: "星を待つ丘", entry: "start" });
    expect(config().build).toBeUndefined();
    expect(config().version).toBeUndefined();
  });

  it("作品の設定の誤りは書かない（必須の項目・始まりの位置・形）", () => {
    const base = readSettings(ws);
    const problem = (s: object) => {
      try {
        setSettings(ws, s);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(problem({ ...base, title: "" })).toContain("title");
    expect(problem({ ...base, entry: "nope" })).toContain("entry のファイル nope");
    expect(problem({ ...base, entry: "start#nope" })).toContain("#nope");
    expect(problem({ ...base, screen: { width: 0, height: 720 } })).toContain("screen");
    expect(problem({ ...base, saves: { location: "cloud" } })).toContain("saves");
    expect(problem({ ...base, build: { android: { keystore: "k.jks" } } })).toContain("Android");
    expect(problem({ ...base, build: { steam: { achievements: { a: "A" } } } })).toContain("Steam");
    // 実行ファイル名は、どの OS でも使える名前だけ
    expect(problem({ ...base, build: { executableName: "星: 丘" } })).toContain("build.executableName");
    expect(problem({ ...base, build: { executableName: "CON" } })).toContain("予約");
    expect(problem({ ...base, build: { executableName: "星を待つ丘" } })).toBe("");
    expect(config().title).toBe("星を待つ丘");
  });

  it("id は書き出したフォルダの名前になるので、変えるときは英数字、_、- だけ。版にも区切りを書けない", () => {
    const base = readSettings(ws);
    const problem = (s: object) => {
      try {
        setSettings(ws, s);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    for (const id of ["../../../../Documents", "a/b", "..", "My Game", "_x", "a".repeat(41)]) expect(problem({ ...base, id }), id).toContain("id は英数字");
    expect(problem({ ...base, version: "../1.0" })).toContain("version");
    expect(config().id).toBe("hoshi_wo_matsu_oka");
    expect(problem({ ...base, id: "hoshi-2" })).toBe("");
    expect(config().id).toBe("hoshi-2");
    // 手で書いた形の違う id（読み込みは警告だけで開く）は、変えなければほかの設定を書ける
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config(), id: "my.game" }, null, 2));
    expect(problem({ ...readSettings(ws), title: "別の題" })).toBe("");
    expect(config()).toMatchObject({ id: "my.game", title: "別の題" });
  });

  it("CG の自動の登録（cgAuto）は残し、自動で足したもの（auto）は書かない。シナリオが出す画像を読める", () => {
    setExtra(ws, { cgAuto: { folder: "stills" }, cg: [{ id: "a", images: ["a.png"] }, { id: "auto:b.png", images: ["b.png"], auto: true }] });
    expect(config().extra).toEqual({ cgAuto: { folder: "stills" }, cg: [{ id: "a", images: ["a.png"] }] });
    setExtra(ws, { cgAuto: { folder: "stills" }, cg: [{ id: "auto:b.png", images: ["b.png"], auto: true }] });
    expect(config().extra).toEqual({ cgAuto: { folder: "stills" } });
    expect(ws.shownImages().length).toBeGreaterThan(0);
  });

  it("作品のデータ（data/*.json の訳す欄）の文も lim i18n と同じく並べて数え、訳を書ける。英語は英語の欄のあるものを除く", () => {
    setLanguages(ws, ["ja", "en", "ko"]);
    const before = translationStatus(ws).status.ko!.total;
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "codex.json"), JSON.stringify({ categories: [{ id: "people", label: "人物" }], entries: [{ id: "a", category: "people", title: "アカリ", titleEn: "Akari", summary: "丘の上に住む。" }] }));
    expect(translationStatus(ws).status.ko!.total).toBe(before + 3);
    const view = readTranslation(ws, "ko");
    const data = Object.entries(view.file.lines ?? {}).filter(([k]) => k.startsWith("data/codex.json:"));
    expect(data.map(([, e]) => e.source).sort()).toEqual(["アカリ", "丘の上に住む。", "人物"].sort());
    expect(data.find(([, e]) => e.source === "アカリ")![1].note).toBe("data/codex.json /entries/0/title");
    const [key, entry] = data.find(([, e]) => e.source === "アカリ")!;
    writeTranslation(ws, "ko", { ...view.file, lines: { ...view.file.lines, [key]: { ...entry, text: "아카리" } } }, view.hash);
    expect(readTranslation(ws, "ko").file.lines![key]!.text).toBe("아카리");
    expect(translationStatus(ws).status.ko).toMatchObject({ translated: 1 });
    // 英語は英語の欄（titleEn）のある文を並べない
    const en = Object.values(readTranslation(ws, "en").file.lines ?? {}).filter((e) => e.note?.startsWith("data/"));
    expect(en.map((e) => e.source).sort()).toEqual(["丘の上に住む。", "人物"].sort());
  });

  it("言語を足すと、訳すものが台本から集まり、訳を書ける", () => {
    setLanguages(ws, ["ja", "en"]);
    expect(config().languages).toEqual(["ja", "en"]);
    const status = translationStatus(ws);
    expect(status.status.en).toMatchObject({ translated: 0, exists: false });
    expect(status.status.en!.total).toBeGreaterThan(10);
    const view = readTranslation(ws, "en");
    const [key, entry] = Object.entries(view.file.lines!)[0]!;
    expect(view.where[key]).toMatchObject({ file: expect.any(String), line: expect.any(Number) });
    writeTranslation(ws, "en", { ...view.file, lines: { ...view.file.lines, [key]: { ...entry, text: "Hello" } } });
    expect(translationStatus(ws).status.en).toMatchObject({ translated: 1, exists: true });
    expect(() => setLanguages(ws, ["ja", "ja"])).toThrow();
    // 原文の言語だけでも、日本語でなければ残す（英語だけの作品）。日本語だけは書かないときと同じなので消す
    setLanguages(ws, ["en"]);
    expect(config().languages).toEqual(["en"]);
    setLanguages(ws, ["ja"]);
    expect(config()).not.toHaveProperty("languages");
    expect(() => readTranslation(ws, "../x")).toThrow();
  });

  it("台本の名前を変えても訳は使われ続ける", () => {
    setLanguages(ws, ["ja", "en"]);
    const view = readTranslation(ws, "en");
    const key = Object.keys(view.file.lines!).find((k) => k.startsWith("epilogue:"))!;
    writeTranslation(ws, "en", { ...view.file, lines: { ...view.file.lines, [key]: { ...view.file.lines![key]!, text: "After" } } });
    renameScenario(ws, "epilogue", "ending/after");
    const moved = readTranslation(ws, "en");
    expect(moved.file.lines![`ending/after${key.slice(key.indexOf(":"))}`]!.text).toBe("After");
    expect(moved.outdated).toBe(false);
  });

  it("読めない訳があれば、台本の名前を変えずに止める（その訳だけ古い鍵のまま残さない）", () => {
    setLanguages(ws, ["ja", "en"]);
    mkdirSync(join(dir, "lang"), { recursive: true });
    writeFileSync(join(dir, "lang", "en.json"), "{ 壊れた");
    expect(() => renameScenario(ws, "epilogue", "ending/after")).toThrow(/lang\/en\.json を読めない/);
    // 書きかけたものは戻してある
    expect(existsSync(join(dir, "scenario", "epilogue.lim"))).toBe(true);
    expect(existsSync(join(dir, "scenario", "ending", "after.lim"))).toBe(false);
    expect(readFileSync(join(dir, "lang", "en.json"), "utf8")).toBe("{ 壊れた");
  });

  it("プラグインは見つかるものだけ書ける", () => {
    expect(listPlugins(ws)).toEqual([]);
    expect(() => setPlugins(ws, ["./plugins/none"])).toThrow(/見つかりません|package.json/);
  });

  it("作品の外のフォルダは絶対パスで足せ、作品の中のものとしては扱わない", () => {
    const outside = mkdtempSync(join(tmpdir(), "liminalia-outside-plugin-"));
    try {
      writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "outside-ai", version: "0.1.0", exports: { "./studio": "./src/studio.ts", "./studio-server": "./src/studio-server.ts" } }));
      setPlugins(ws, [outside]);
      expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).plugins).toEqual([outside]);
      expect(listPlugins(ws)).toMatchObject([{ spec: outside, name: "outside-ai", entries: ["studio", "studio-server"], local: false }]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("英語の制作画面から作ると、要約、例の文、コメントが英語になる", () => {
    createPlugin(ws, "my-en", ["web", "studio"], "en");
    const text = ["commands.ts", "web.ts", "studio.ts"].map((f) => readFileSync(join(dir, "plugins/my-en/src", f), "utf8")).join("\n");
    expect(text).toContain('summary: "Show a short text on the screen (an example)"');
    expect(text).toContain('t.string("Text to show", "Hello")');
    expect(text).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  it("新しく作ると plugins/<名前> に例を置いて足し、名前と説明を直せる", () => {
    expect(createPlugin(ws, "my-fx", ["web"])).toBe("./plugins/my-fx");
    expect(readdirSync(join(dir, "plugins/my-fx/src")).sort()).toEqual(["commands.ts", "web.ts"]);
    const pkg = JSON.parse(readFileSync(join(dir, "plugins/my-fx/package.json"), "utf8"));
    expect(pkg.exports).toEqual({ "./commands": "./src/commands.ts", "./web": "./src/web.ts" });
    // 合うエンジンの宣言（今の口の版から）
    expect(pkg.engines).toEqual({ liminalia: `>=${PLUGIN_API_VERSION}` });
    expect(readFileSync(join(dir, "plugins/my-fx/src/commands.ts"), "utf8")).toContain('name: "my-fx-hello"');
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).plugins).toEqual(["./plugins/my-fx"]);
    expect(listPlugins(ws)).toMatchObject([{ spec: "./plugins/my-fx", name: "my-fx", entries: ["commands", "web"], local: true, loaded: false }]);
    // 同じ名前・使えない名前は作らない
    expect(() => createPlugin(ws, "my-fx", [])).toThrow(/すでにあります/);
    expect(() => createPlugin(ws, "My FX", [])).toThrow(/使えません/);
    updatePlugin(ws, "./plugins/my-fx", { name: "my-effects", description: "画面の演出" });
    expect(listPlugins(ws)).toMatchObject([{ name: "my-effects", description: "画面の演出" }]);
    expect(JSON.parse(readFileSync(join(dir, "plugins/my-fx/package.json"), "utf8")).exports["./web"]).toBe("./src/web.ts");
    expect(() => updatePlugin(ws, "./plugins/my-fx", { name: "Bad Name" })).toThrow(/使えません/);
    expect(() => updatePlugin(ws, "./plugins/none", { description: "x" })).toThrow(/ありません/);
  });
});

describe("読んだあとに変わっていたら書かない（設定と訳）", () => {
  const configText = () => readFileSync(join(dir, "liminalia.json"), "utf8");
  const history = (sub: string) => (existsSync(join(dir, ".liminalia/history", sub)) ? readdirSync(join(dir, ".liminalia/history", sub)) : []);

  it("言語の並び: 読んだときの hash が今と違えば書かずに今の並びを返す。書くときは変更履歴に残す", () => {
    const hash = translationStatus(ws).hash;
    expect(hash).toBe(configPartHash([]));
    const first = setLanguages(ws, ["ja", "en"], hash);
    if (!first.ok) throw new Error("conflict");
    expect(translationStatus(ws).hash).toBe(first.hash);
    expect(history("@config")).toHaveLength(1);
    const before = configText();
    expect(setLanguages(ws, ["ja", "fr"], hash)).toEqual({ ok: false, current: { value: ["ja", "en"], hash: first.hash } });
    expect(configText()).toBe(before);
    expect(setLanguages(ws, ["ja", "en", "fr"], first.hash!).ok).toBe(true);
  });

  it("プラグインの並び: 読んだときの hash が今と違えば書かない", () => {
    createPlugin(ws, "my-a", []);
    const hash = configListHash(ws, "plugins");
    expect(setPlugins(ws, [], configPartHash([]))).toMatchObject({ ok: false, current: { value: ["./plugins/my-a"] } });
    expect(setPlugins(ws, [], hash)).toEqual({ ok: true, hash: configPartHash([]) });
    expect(listPlugins(ws)).toEqual([]);
  });

  it("ゲームの設定: 読んだときの hash が今と違えば書かずに今の ui を返す。書くときは前の liminalia.json を変更履歴に残す", () => {
    const hash = configPartHash(ws.readUi() ?? {});
    const first = setUi(ws, { text: { color: "#112233" } }, hash);
    if (!first.ok) throw new Error("conflict");
    expect(first.hash).toBe(configPartHash({ text: { color: "#112233" } }));
    expect(history("@config")).toHaveLength(1);
    // 古い写し（前の hash）では書かない
    const before = configText();
    expect(setUi(ws, { text: { color: "#445566" } }, hash)).toEqual({ ok: false, current: { value: { text: { color: "#112233" } }, hash: first.hash } });
    expect(configText()).toBe(before);
    // 同じ中身なら書かない（履歴も増えない）
    expect(setUi(ws, { text: { color: "#112233" } }, first.hash!)).toEqual({ ok: true, hash: first.hash });
    expect(history("@config")).toHaveLength(1);
  });

  it("おまけと作品の設定も、読んだあとに変わっていれば書かない", () => {
    const extraHash = configPartHash({});
    expect(setExtra(ws, { music: [{ file: "a.ogg", title: "A" }] }, extraHash)).toMatchObject({ ok: true });
    expect(setExtra(ws, { music: [{ file: "b.ogg", title: "B" }] }, extraHash)).toMatchObject({ ok: false, current: { value: { music: [{ file: "a.ogg", title: "A" }] } } });
    const settings = readSettings(ws);
    const hash = configPartHash(settings);
    expect(setSettings(ws, { ...settings, author: "わたし" }, hash)).toMatchObject({ ok: true });
    expect(setSettings(ws, { ...settings, author: "あなた" }, hash)).toMatchObject({ ok: false, current: { value: { author: "わたし" } } });
    expect(readSettings(ws).author).toBe("わたし");
    expect(history("@config")).toHaveLength(2);
  });

  it("訳: 読んだときの hash を添えて書き、変わっていれば今の訳を返す。前の訳は変更履歴に残す", () => {
    setLanguages(ws, ["ja", "en"]);
    const view = readTranslation(ws, "en");
    expect(view.hash).toBeNull();
    const [key, entry] = Object.entries(view.file.lines!)[0]!;
    const first = writeTranslation(ws, "en", { ...view.file, lines: { ...view.file.lines, [key]: { ...entry, text: "Hello" } } }, view.hash);
    if (!first.ok) throw new Error("conflict");
    // 開いたときの写し（ファイルが無かった）のまま書こうとすると断り、今の訳を返す
    const stale = writeTranslation(ws, "en", view.file, view.hash);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.current.value.file.lines![key]!.text).toBe("Hello");
    const again = readTranslation(ws, "en");
    expect(again.hash).toBe(first.hash);
    expect(writeTranslation(ws, "en", { ...again.file, lines: { ...again.file.lines, [key]: { ...entry, text: "Hi" } } }, again.hash).ok).toBe(true);
    expect(history("@lang/en")).toHaveLength(1);
    expect(readTranslation(ws, "en").file.lines![key]!.text).toBe("Hi");
  });
});

describe("設定のファイルそのもの（元に戻すと変更履歴の欄）", () => {
  it("liminalia.json: 前の中身を読んだときの hash で書き戻し、戻す前の中身を変更履歴に残す。ほかで変わっていれば書かない", () => {
    const before = readPartFile(ws, "@config");
    const ui = setUi(ws, { text: { color: "#112233" } }, configPartHash(ws.readUi() ?? {}));
    expect(ui.ok).toBe(true);
    const after = readPartFile(ws, "@config");
    expect(after.text).not.toBe(before.text);
    expect(partHistory(ws, "@config")).toHaveLength(1);
    expect(partHistoryItem(ws, "@config", partHistory(ws, "@config")[0]!.id).text).toBe(before.text);
    expect(partHistoryItem(ws, "@config", "current").text).toBe(after.text);
    // 古い写しの hash では書かない
    expect(writePartFile(ws, "@config", before.text, before.hash)).toMatchObject({ ok: false, current: { text: after.text } });
    // 元に戻す
    expect(writePartFile(ws, "@config", before.text, after.hash)).toEqual({ ok: true, hash: before.hash, restart: false });
    expect(ws.readUi() ?? {}).toEqual({});
    expect(partHistory(ws, "@config")).toHaveLength(2);
    // 変数の初期値は書き戻したらすぐ作業場に効く
    setVariable(ws, "game.mood", 3, false);
    const withVar = readPartFile(ws, "@config");
    expect(writePartFile(ws, "@config", before.text, withVar.hash).ok).toBe(true);
    expect(listVariables(ws).find((v) => v.path === "game.mood")?.initial).toBeUndefined();
  });

  it("liminalia.json: 起動し直さないと効かない項目が起動したときと違えば restart。JSON のオブジェクトでなければ書かない", () => {
    const now = readPartFile(ws, "@config");
    const raw = JSON.parse(now.text) as Record<string, unknown>;
    const resized = `${JSON.stringify({ ...raw, screen: { width: 640, height: 480 } }, null, 2)}\n`;
    expect(writePartFile(ws, "@config", resized, now.hash)).toMatchObject({ ok: true, restart: true });
    const next = readPartFile(ws, "@config");
    expect(writePartFile(ws, "@config", now.text, next.hash)).toMatchObject({ ok: true, restart: false });
    expect(() => writePartFile(ws, "@config", "[1]", now.hash)).toThrow(/オブジェクト/);
    expect(() => writePartFile(ws, "@config", "{", now.hash)).toThrow(/読めません/);
    expect(() => readPartFile(ws, "../x" as never)).toThrow(/扱えません/);
  });

  it("訳: 無かったファイルは空の文字として読み、空の文字に戻すとファイルを外す（前の中身は変更履歴に残す）", () => {
    setLanguages(ws, ["ja", "en"]);
    const empty = readPartFile(ws, "@lang/en");
    expect(empty.text).toBe("");
    const view = readTranslation(ws, "en");
    expect(writeTranslation(ws, "en", view.file, view.hash).ok).toBe(true);
    const written = readPartFile(ws, "@lang/en");
    expect(written.text).not.toBe("");
    expect(writePartFile(ws, "@lang/en", "", written.hash)).toMatchObject({ ok: true, restart: false });
    expect(existsSync(join(dir, "lang", "en.json"))).toBe(false);
    expect(partHistory(ws, "@lang/en")).toHaveLength(1);
    expect(() => readPartFile(ws, "@lang/../x" as never)).toThrow(/言語コード/);
  });
});

describe("作品の外の素材のフォルダ（paths.assets）", () => {
  it("一覧、ごみ箱、戻す、フォルダで見せるが、外のフォルダで働く", async () => {
    const shared = mkdtempSync(join(tmpdir(), "liminalia-shared-assets-"));
    try {
      cpSync(join(dir, "assets"), shared, { recursive: true });
      rmSync(join(dir, "assets"), { recursive: true });
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...cfg, paths: { ...(cfg.paths as object), assets: shared } }));
      const outside = await StudioWorkspace.open(loadProject(dir));
      expect(assetFileToReveal(outside, "bgimage", "hill_dusk.webp")).toBe(join(shared, "bgimage/hill_dusk.webp"));
      expect(listAssets(outside).find((f) => f.kind === "bgimage")!.files.map((f) => f.path)).toContain("hill_dusk.webp");
      expect(outside.check().diagnostics.filter((d) => d.code === "missing-asset")).toEqual([]);
      const t = trashAsset(outside, "bgimage", "hill_dusk.webp");
      expect(existsSync(join(shared, "bgimage", "hill_dusk.webp"))).toBe(false);
      expect(existsSync(join(dir, ".liminalia", "trash", t.id, "bgimage", "hill_dusk.webp"))).toBe(true);
      expect(restoreTrash(outside, t.id).restored).toEqual(["bgimage/hill_dusk.webp"]);
      expect(existsSync(join(shared, "bgimage", "hill_dusk.webp"))).toBe(true);
      expect(assetFolderToReveal(outside, "bgimage", "")).toBe(join(shared, "bgimage"));
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("別のディスクへは、写してから元を消す", () => {
    const from = join(dir, "move-from");
    const to = join(dir, "move-to");
    writeFileSync(from, "x");
    const exdev = () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    };
    moveAcross(from, to, exdev);
    expect([existsSync(from), readFileSync(to, "utf8")]).toEqual([false, "x"]);
    const enoent = () => {
      throw Object.assign(new Error("no"), { code: "ENOENT" });
    };
    expect(() => moveAcross(join(dir, "none"), join(dir, "x"), enoent)).toThrow("no");
  });
});
