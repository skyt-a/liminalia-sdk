import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { voiceLines, type VoiceLock } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { renameAsset, renameCast, renameScenario, renameVariable } from "../src/server/manage.ts";
import { renameLabel } from "../src/server/labels.ts";
import { readStudioState, writeStudioState } from "../src/server/studio-state.ts";
import { readReviews } from "../src/server/reviews.ts";

/** 名前の変更で一緒に移すもの（覚え書き・訳・ボイス・コメントなど）と、途中で書けなくなったときの元に戻し。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-rename-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;
const writeJson = (rel: string, value: unknown) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
};
const config = () => json<Record<string, unknown>>("liminalia.json");
const editConfig = (fn: (raw: Record<string, unknown>) => void) => {
  const raw = config();
  fn(raw);
  writeJson("liminalia.json", raw);
};
/** 台詞の鍵（voice-lock.json と同じ作り方）。 */
const voiceKeys = (file: string) => voiceLines(ws.script(file).script);

describe("シナリオのファイルの名前を変えると、ファイルの名前を持つものも移す", () => {
  it("覚え書き・コメント・訳と voice-lock の鍵・設定の飛び先・基準の画像", () => {
    writeStudioState(ws.project, {
      bookmarks: { start: [{ line: 3, text: "x" }], epilogue: [{ line: 1, text: "y" }] },
      breakpoints: [{ file: "start", line: 20, text: "a", hash: "h" }],
      lastOpen: { file: "start", line: 12 },
      mapPositions: { "start#night": { x: 1, y: 2 }, start: { x: 0, y: 0 }, "epilogue#dawn": { x: 5, y: 5 } },
    });
    writeJson("reviews/r1.json", { id: "r1", file: "start", line: 20, text: "a", hash: "h", resolved: false, comments: [{ id: "c1", author: "me", time: "2026-01-01T00:00:00.000Z", body: "見て" }] });
    const say = voiceKeys("start")[0]!;
    writeJson("voice-lock.json", { lines: { [say.key]: { speaker: say.speaker, n: 1, source: say.source } } });
    writeJson("lang/en.json", { language: "en", lines: { "start:labc": { source: "あ", text: "a" }, "epilogue:lzzz": { source: "い", text: "b" } } });
    editConfig((raw) => {
      raw.languages = ["ja", "en"];
      raw.extra = { replay: [{ id: "r", title: "夜", target: "start#night" }], flowchart: { titles: { "start#night": "夜" } } };
    });
    mkdirSync(join(dir, ".liminalia/regress/baseline"), { recursive: true });
    writeFileSync(join(dir, ".liminalia/regress/baseline/start_night.png"), "png");

    const r = renameScenario(ws, "start", "part1/opening");
    expect(r.entry).toBe(true);
    const st = readStudioState(ws.project);
    expect(st.bookmarks).toEqual({ "part1/opening": [{ line: 3, text: "x" }], epilogue: [{ line: 1, text: "y" }] });
    expect(st.breakpoints?.[0]?.file).toBe("part1/opening");
    expect(st.lastOpen).toEqual({ file: "part1/opening", line: 12 });
    expect(Object.keys(st.mapPositions ?? {}).sort()).toEqual(["epilogue#dawn", "part1/opening", "part1/opening#night"]);
    expect(readReviews(ws.project)[0]?.file).toBe("part1/opening");
    const lock = json<VoiceLock>("voice-lock.json");
    expect(Object.keys(lock.lines)).toEqual([`part1/opening:${say.key.slice("start:".length)}`]);
    expect(Object.keys(json<{ lines: object }>("lang/en.json").lines).sort()).toEqual(["epilogue:lzzz", "part1/opening:labc"]);
    const c = config() as { entry: string; extra: { replay: { target: string }[]; flowchart: { titles: Record<string, string> } } };
    expect(c.entry).toBe("part1/opening");
    expect(c.extra.replay[0]!.target).toBe("part1/opening#night");
    expect(c.extra.flowchart.titles).toEqual({ "part1/opening#night": "夜" });
    expect(existsSync(join(dir, ".liminalia/regress/baseline/part1_opening_night.png"))).toBe(true);
  });

  it("途中で書けなくなったら、書き終えたものを元に戻す", () => {
    const start = read("scenario/start.lim");
    const epilogue = read("scenario/epilogue.lim");
    writeJson("reviews/r1.json", { id: "r1", file: "start", line: 20, text: "a", hash: "h", resolved: false, comments: [{ id: "c1", author: "me", time: "2026-01-01T00:00:00.000Z", body: "見て" }] });
    // liminalia.json（entry）だけ書けないようにする（作品のフォルダに一時ファイルを作れない）
    chmodSync(dir, 0o555);
    let error: unknown;
    try {
      renameScenario(ws, "start", "opening");
    } catch (e) {
      error = e;
    }
    chmodSync(dir, 0o755);
    expect(error).toMatchObject({ status: 409 });
    expect(String((error as Error).message)).toMatch(/名前を変更できませんでした。.*書き換えた分は元に戻しました/);
    expect(read("scenario/start.lim")).toBe(start);
    expect(read("scenario/epilogue.lim")).toBe(epilogue);
    expect(existsSync(join(dir, "scenario/opening.lim"))).toBe(false);
    expect(readReviews(ws.project)[0]?.file).toBe("start");
    expect(ws.files()).toContain("start");
    expect(ws.files()).not.toContain("opening");
  });
});

describe("素材の名前を変えると、設定と頭の印も移す", () => {
  it("ui・extra の参照と、立ち絵の頭の印（heads）", () => {
    editConfig((raw) => {
      raw.ui = { title: { background: "hill_dusk.webp", logo: "hill_dusk.webp" }, message: { background: "hill_dusk.webp" } };
      raw.extra = { cg: [{ id: "a", images: ["hill_dusk.webp"] }] };
    });
    writeStudioState(ws.project, { heads: { "akari/normal.webp": { chinX: 1, chinY: 2, top: 3, width: 4, imageWidth: 5, imageHeight: 6 } } });
    const r = renameAsset(ws, "bgimage", "hill_dusk.webp", "dusk.webp");
    const c = config() as { ui: { title: { background: string; logo: string }; message: { background: string } }; extra: { cg: { images: string[] }[] } };
    // 背景の参照だけを書き換える（logo は image の素材、message.background は色の文字列なので替えない）
    expect(c.ui.title.background).toBe("dusk.webp");
    expect(c.ui.title.logo).toBe("hill_dusk.webp");
    expect(c.ui.message.background).toBe("hill_dusk.webp");
    expect(c.extra.cg[0]!.images).toEqual(["dusk.webp"]);
    expect(r.config?.sort()).toEqual(["extra.cg a", "ui.title.background"]);
    expect(r.left).toEqual([]);

    renameAsset(ws, "fgimage", "akari", "akari2");
    expect(Object.keys(readStudioState(ws.project).heads ?? {})).toEqual(["akari2/normal.webp"]);
  });

  it("途中で書けなくなったら、素材の名前と台本を元に戻す", () => {
    editConfig((raw) => {
      raw.ui = { title: { background: "hill_dusk.webp" } };
    });
    const start = read("scenario/start.lim");
    chmodSync(dir, 0o555);
    expect(() => renameAsset(ws, "bgimage", "hill_dusk.webp", "dusk/hill.webp")).toThrow(/元に戻しました/);
    chmodSync(dir, 0o755);
    expect(existsSync(join(dir, "assets/bgimage/hill_dusk.webp"))).toBe(true);
    expect(existsSync(join(dir, "assets/bgimage/dusk"))).toBe(false);
    expect(read("scenario/start.lim")).toBe(start);
  });
});

describe("キャラクターの名前を変えると、名前を持つものも移す", () => {
  it("キャラクター ID: 顔の切り出しと覚え書き、システムボイスの担当", () => {
    writeStudioState(ws.project, { faces: { アカリ: { x: 1, y: 2, size: 300 } }, castNotes: { アカリ: "声: 未定" } });
    editConfig((raw) => {
      raw.ui = { systemVoice: { title: [{ file: "a.ogg", character: "アカリ" }] } };
    });
    renameCast(ws, { kind: "cast", from: "アカリ", to: "akari" });
    const st = readStudioState(ws.project);
    expect(st.faces).toEqual({ akari: { x: 1, y: 2, size: 300 } });
    expect(st.castNotes).toEqual({ akari: "声: 未定" });
    expect((config() as { ui: { systemVoice: { title: { character: string }[] } } }).ui.systemVoice.title[0]!.character).toBe("akari");
  });

  it("話者名: 訳の話者名と、voice-lock.json の鍵と話者", () => {
    const say = voiceKeys("start").find((v) => v.speaker === "アカリ")!;
    writeJson("voice-lock.json", { lines: { [say.key]: { speaker: "アカリ", n: 7, source: say.source } } });
    writeJson("lang/en.json", { language: "en", speakers: { アカリ: "Akari" }, lines: { "start:l1": { source: "x", text: "y", speaker: "アカリ" } } });
    renameCast(ws, { kind: "speaker", from: "アカリ", to: "明里" });
    const lang = json<{ speakers: Record<string, string>; lines: Record<string, { speaker: string }> }>("lang/en.json");
    expect(lang.speakers).toEqual({ 明里: "Akari" });
    expect(lang.lines["start:l1"]!.speaker).toBe("明里");
    const now = voiceKeys("start").find((v) => v.line === say.line)!;
    expect(now.key).not.toBe(say.key);
    expect(json<VoiceLock>("voice-lock.json").lines).toEqual({ [now.key]: { speaker: "明里", n: 7, source: say.source } });
  });

  it("途中で書けなくなったら、台本と cast.json を元に戻す", () => {
    const start = read("scenario/start.lim");
    const cast = read("cast.json");
    editConfig((raw) => {
      raw.ui = { systemVoice: { title: [{ file: "a.ogg", character: "アカリ" }] } };
    });
    chmodSync(dir, 0o555);
    expect(() => renameCast(ws, { kind: "cast", from: "アカリ", to: "akari" })).toThrow(/元に戻しました/);
    chmodSync(dir, 0o755);
    expect(read("scenario/start.lim")).toBe(start);
    expect(read("cast.json")).toBe(cast);
  });
});

describe("変数の名前を変えると、設定の条件とブレークポイントの条件も書き換える", () => {
  it("ui の if と、制作画面のブレークポイントの条件", () => {
    editConfig((raw) => {
      raw.ui = { title: { variants: [{ if: "game.looked && !game.lookedx", background: "hill_night.webp" }] } };
    });
    writeStudioState(ws.project, { breakpoints: [{ file: "start", line: 20, text: "a", hash: "h", cond: "game.looked == true" }] });
    renameVariable(ws, "game.looked", "game.seen");
    expect((config() as { ui: { title: { variants: { if: string }[] } } }).ui.title.variants[0]!.if).toBe("game.seen && !game.lookedx");
    expect(readStudioState(ws.project).breakpoints?.[0]?.cond).toBe("game.seen == true");
  });
});

describe("名前の変更は、台本のテストと章の設定と場面の情報も書き換える", () => {
  const test = () => read("tests/start.limtest");

  it("ファイル: テストの場所、chapters の files、scenes の鍵、check.sound.quiet。ワイルドカードが外れるなら知らせる", () => {
    editConfig((raw) => {
      raw.chapters = [
        { id: "c1", title: "一", files: ["start"] },
        { id: "c2", title: "二", files: ["epilogue"] },
      ];
      raw.scenes = { "epilogue#dawn": { pov: "ソウ" }, start: { place: "丘" } };
      raw.check = { sound: { quiet: ["epilogue"] } };
      raw.extra = { replay: [{ id: "r", title: "夜明け", target: "epilogue#dawn" }] };
    });
    const r = renameScenario(ws, "epilogue", "last");
    expect(test()).toContain("expect reach last#dawn");
    expect(test()).not.toContain("epilogue");
    expect(r.tests).toEqual({ files: ["tests/start.limtest"], left: [] });
    const c = config() as { chapters: { files: string[] }[]; scenes: Record<string, unknown>; check: { sound: { quiet: string[] } }; extra: { replay: { target: string }[] } };
    expect(c.chapters.map((x) => x.files)).toEqual([["start"], ["last"]]);
    expect(Object.keys(c.scenes)).toEqual(["last#dawn", "start"]);
    expect(c.check.sound.quiet).toEqual(["last"]);
    expect(c.extra.replay[0]!.target).toBe("last#dawn");
    expect(r.config).toEqual(expect.arrayContaining(["chapters.c2.files", "scenes", "check.sound.quiet", "extra.replay.r"]));
    expect(r.left).toBeUndefined();

    editConfig((raw) => {
      raw.chapters = [
        { id: "c1", title: "一", files: ["start"] },
        { id: "c2", title: "二", files: ["la*"] },
      ];
    });
    const w = renameScenario(ws, "last", "epilogue");
    expect(w.left).toEqual(["chapters.c2.files: la*"]);
    expect((config() as { chapters: { files: string[] }[] }).chapters[1]!.files).toEqual(["la*"]);
  });

  it("変数: テストの set と expect の式（消えた変数が null になって誤って通らないように）", () => {
    writeFileSync(join(dir, "tests/start.limtest"), `${test()}\n# 値を入れて始める\nset game.looked = true\nexpect game.looked\n`);
    const r = renameVariable(ws, "game.looked", "game.peeked");
    expect(test()).not.toMatch(/game\.looked\b/);
    expect(test()).toContain("expect !game.peeked && game.wished");
    expect(test()).toContain("set game.peeked = true");
    expect(r.tests?.files).toEqual(["tests/start.limtest"]);
  });

  it("シーンと話者名: テストの `ファイル#ラベル` と、話者名と比べる expect text", () => {
    writeFileSync(join(dir, "tests/start.limtest"), `${test()}\n# 話者\nexpect text "ソウ"\nexpect visits("#dawn") == 0\n`);
    const r = renameLabel(ws, "epilogue", "dawn", "morning");
    expect(test()).toContain("expect reach epilogue#morning");
    expect(r.tests?.left).toEqual([{ file: "tests/start.limtest", line: test().split("\n").indexOf('expect visits("#dawn") == 0') + 1 }]);
    renameCast(ws, { kind: "speaker", from: "ソウ", to: "蒼" });
    expect(test()).toContain('expect text "蒼"');
  });

  it("テストを書けなければ、書き終えたシナリオと設定を元に戻す", () => {
    const before = test();
    const start = read("scenario/start.lim");
    chmodSync(join(dir, "tests"), 0o555);
    expect(() => renameScenario(ws, "epilogue", "last")).toThrow(/元に戻しました/);
    chmodSync(join(dir, "tests"), 0o755);
    expect(test()).toBe(before);
    expect(read("scenario/start.lim")).toBe(start);
    expect(existsSync(join(dir, "scenario/epilogue.lim"))).toBe(true);
    expect(existsSync(join(dir, "scenario/last.lim"))).toBe(false);
  });
});

describe("UTF-8 で読めないシナリオファイルがあれば、名前の変更も保存もしない", () => {
  it("名前の変更は一つも書かずに止め、そのファイルは化けた字面で上書きしない", () => {
    // Shift_JIS の「あ」（82 A0）と、ASCII の変数の参照
    const sjis = Buffer.concat([Buffer.from("# old\n@set game.looked = true\n"), Buffer.from([0x82, 0xa0]), Buffer.from("\n")]);
    writeFileSync(join(dir, "scenario/old.lim"), sjis);
    const start = read("scenario/start.lim");
    const message = /UTF-8 で読めないシナリオファイルがあるため、何も書き換えませんでした: old\.lim/;
    expect(() => renameVariable(ws, "game.looked", "game.seen")).toThrow(message);
    expect(() => renameScenario(ws, "epilogue", "after")).toThrow(message);
    expect(() => renameLabel(ws, "start", "night", "yoru")).toThrow(message);
    expect(() => renameCast(ws, { kind: "cast", from: "アカリ", to: "akari" })).toThrow(message);
    expect(read("scenario/start.lim")).toBe(start);
    expect(existsSync(join(dir, "scenario/epilogue.lim"))).toBe(true);
    expect(readFileSync(join(dir, "scenario/old.lim")).equals(sjis)).toBe(true);
    // 開いた字面（化けたもの）を保存しようとしても書かない（整形、置換、編集も同じ口を通る）
    const shown = ws.fileText("old");
    expect(() => ws.write("old", shown.text.replace("game.looked", "game.seen"), shown.hash)).toThrow(message);
    expect(readFileSync(join(dir, "scenario/old.lim")).equals(sjis)).toBe(true);
  });
});
