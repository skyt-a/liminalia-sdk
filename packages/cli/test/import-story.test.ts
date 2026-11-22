import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** lim import-ink / import-yarn / import-renpy / import-twine をプロセスとして動かし、取り込んだ結果を lim check で確かめる。 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const FIXTURES = resolve(import.meta.dirname, "../../story-import/test/fixtures");

/** lim check --json の診断（取り込んだ台本が参照する素材は作者が後から入れるので、無い素材だけは出る）。 */
function checkDiagnostics(dir: string): string[] {
  const r = lim(["check", dir, "--json"]);
  return (JSON.parse(r.out) as { diagnostics: { file: string; line: number; code: string; message: string }[] }).diagnostics.map((d) => `${d.file}:${d.line} ${d.code} ${d.message}`);
}

function lim(args: string[]) {
  const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const work = mkdtempSync(join(tmpdir(), "liminalia-import-story-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("lim import-ink / import-yarn / import-renpy / import-twine", { timeout: 60_000 }, () => {
  it("Ink を取り込み、lim check で出るのは無い素材だけ", () => {
    const dir = join(work, "ink");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = lim(["import-ink", dir, join(FIXTURES, "lighthouse.ink")]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("書き出したファイル: lighthouse.lim");
    expect(existsSync(join(dir, "scenario/lighthouse.lim"))).toBe(true);
    expect(existsSync(join(dir, "ink-import-report.md"))).toBe(true);
    expect(checkDiagnostics(dir)).toEqual([
      "lighthouse:3 missing-asset 素材 bgimage/shore_evening.png がありません",
      "lighthouse:8 missing-asset 素材 bgm/waves.ogg がありません",
      "lighthouse:9 missing-asset 素材 voice/keeper/001.ogg がありません",
    ]);
    const trace = lim(["trace", dir, "lighthouse", "--choose", "1"]);
    expect(trace.out).toContain("灯台守「はじめまして。」");
  });

  it("Yarn Spinner のフォルダを取り込み、lim check で出るのは無い素材だけ（対応表に無いコマンドがあれば 1 で終わる）", () => {
    const dir = join(work, "yarn");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = lim(["import-yarn", dir, FIXTURES, "--end", "stop"]);
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out).toContain("| generic | 1 |");
    expect(readFileSync(join(dir, "scenario/ending.lim"), "utf8")).toContain("@stop");
    // 背景のある market から移る ending の初めに背景が無いのは、書き方の提案（情報）
    expect(checkDiagnostics(dir)).toEqual(["ending:3 scene-start-no-bg シーン Ending の初めに背景を決める命令がありません（ほかのファイル market から飛んできます）。前のファイルの画面のまま始まり、途中から再生したときと画面が変わります", "market:4 missing-asset 素材 bgimage/market.png がありません"]);
  });

  it("Ren'Py を取り込み、lim check で出るのは無い素材だけ", () => {
    const dir = join(work, "renpy");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = lim(["import-renpy", dir, join(FIXTURES, "cafe.rpy")]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("書き出したファイル: cafe.lim");
    expect(existsSync(join(dir, "renpy-import-report.md"))).toBe(true);
    expect(checkDiagnostics(dir).every((d) => d.includes("missing-asset")), checkDiagnostics(dir).join("\n")).toBe(true);
    const trace = lim(["trace", dir, "cafe", "--choose", "3"]);
    expect(trace.out).toContain("エイル「何にする？」");
  });

  it("Ren'Py の game/ を取り込み、使う画像と音を写して名前の対応表を作り、tl/ の translate を lang/<言語>.json にする", () => {
    const dir = join(work, "renpy-game");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = lim(["import-renpy", dir, join(FIXTURES, "renpy-game/game")]);
    expect(r.code, r.out + r.err).toBe(0);
    // tl/ の訳だけのファイルは台本にしない
    expect(r.out).toContain("書き出したファイル: script.lim");
    expect(r.out).toContain("素材 4 件をコピーしました");
    const lim0 = readFileSync(join(dir, "scenario/script.lim"), "utf8");
    // Ren'Py が名前を決めた画像は本当のファイル名に、引用符なしの音（audio. の名前）は game/audio のファイルに
    expect(lim0).toContain('@bg "bg room.png" time=1s');
    expect(lim0).toContain('@bgm "main theme.ogg" time=1s');
    expect(lim0).toContain("@se bell.ogg");
    for (const f of ["bgimage/bg room.png", "fgimage/eileen happy.png", "bgm/main theme.ogg", "sound/bell.ogg"]) expect(existsSync(join(dir, "assets", f)), f).toBe(true);
    // 使っていない画像は写さない
    expect(existsSync(join(dir, "assets/bgimage/unused picture.png"))).toBe(false);
    const report = readFileSync(join(dir, "renpy-import-report.md"), "utf8");
    expect(report).toContain("| eileen happy | fgimage/eileen happy.png |");
    expect(report).toContain("english → lang/en.json");
    // 訳: 台詞と地の文、選択肢、話者の名前。選択肢の問いかけの {noclick} も残す
    const en = JSON.parse(readFileSync(join(dir, "lang/en.json"), "utf8")) as { speakers?: Record<string, string>; lines: Record<string, { source: string; text: string }> };
    const texts = Object.fromEntries(Object.values(en.lines).map((l) => [l.source, l.text]));
    expect(texts["部屋は静かだった。"]).toBe("The room was quiet.");
    expect(texts["「おはよう。」"]).toBe('"Good morning."');
    expect(texts["「どうする？」{noclick}"]).toBe('"What should we do?"{noclick}');
    expect(texts["出かける"]).toBe("Go out");
    expect(en.speakers?.["エイル"]).toBe("Eil");
    expect((JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { languages?: string[] }).languages).toEqual(["ja", "en"]);
    expect(checkDiagnostics(dir).filter((d) => !d.includes("untranslated")), checkDiagnostics(dir).join("\n")).toEqual([]);
  });

  it("Ren'Py の訳は、UTF-8 で読めない台本があれば化けた原文で書かずに、取り込まなかった理由を報告に出す（lim i18n と同じ）", () => {
    const dir = join(work, "renpy-game-sjis");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario/old.lim"), Buffer.concat([Buffer.from("# old\n"), Buffer.from([0x82, 0xa0]), Buffer.from("\n@stop\n")]));
    const r = lim(["import-renpy", dir, join(FIXTURES, "renpy-game/game")]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(readFileSync(join(dir, "renpy-import-report.md"), "utf8")).toContain("english: UTF-8 で読めないシナリオファイルがあるので、訳を取り込みませんでした（old.lim）");
    expect(existsSync(join(dir, "lang/en.json"))).toBe(false);
  });

  it("Ren'Py の --no-assets は素材を写さず、使う名前だけを報告に出す", () => {
    const dir = join(work, "renpy-no-assets");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = lim(["import-renpy", dir, join(FIXTURES, "renpy-game/game"), "--no-assets"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(existsSync(join(dir, "assets/fgimage/eileen happy.png"))).toBe(false);
    expect(readFileSync(join(dir, "renpy-import-report.md"), "utf8")).toContain("eileen happy → fgimage/eileen happy.png");
  });

  it("Twine（Twee 3）を取り込み、lim check のエラーも警告も無い", () => {
    const dir = join(work, "twine");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = lim(["import-twine", dir, join(FIXTURES, "station.twee")]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(existsSync(join(dir, "scenario/station.lim"))).toBe(true);
    expect(checkDiagnostics(dir)).toEqual([]);
  });

  it("引数の誤りは使い方を示して止まる", () => {
    const dir = join(work, "bad");
    cpSync(TEMPLATE, dir, { recursive: true });
    expect(lim(["import-ink", dir]).err).toContain("取り込む .ink のファイルを指定してください");
    expect(lim(["import-yarn", dir, FIXTURES, "--end", "later"]).err).toContain("--end には");
  });
});
