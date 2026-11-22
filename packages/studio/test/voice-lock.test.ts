import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { lockVoices } from "../src/server/voice-lock.ts";
import { readRegressImage, regressFileOf } from "../src/server/regress.ts";

/** ボイスの画面の「番号を固定」（POST /voice-lock）と、見た目の確かめの画像の読み出し（GET /regress/file）。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-voice-lock-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("番号を固定", () => {
  it("@voice-auto の話者がいなければ何も書かない", async () => {
    const r = await lockVoices(ws);
    expect(r.speakers).toEqual([]);
    expect(existsSync(join(dir, "voice-lock.json"))).toBe(false);
  });

  it("流して鳴る番号を固定し、足した台詞には新しい番号を振る（前の内容は変更履歴に残す）", async () => {
    const start = ws.fileText("start");
    ws.write("start", `@voice-auto アカリ pattern="akari/{n:3}.ogg"\n${start.text}\nアカリ「足した台詞」\n`, start.hash);
    const first = await lockVoices(ws, 2);
    expect(first.speakers).toEqual(["アカリ"]);
    expect(first.path).toBe("voice-lock.json");
    expect(first.total).toBeGreaterThan(0);
    expect(first.captured + first.added).toBe(first.total);
    const lock = JSON.parse(readFileSync(join(dir, "voice-lock.json"), "utf8")) as { lines: Record<string, { n: number }> };
    expect(Object.keys(lock.lines)).toHaveLength(first.total);
    const again = ws.fileText("start");
    ws.write("start", `${again.text}アカリ「もう一行」\n`, again.hash);
    const second = await lockVoices(ws, 2);
    expect(second).toMatchObject({ kept: first.total, added: 1, total: first.total + 1 });
    expect(readdirSync(join(dir, ".liminalia/history/@voice-lock"))).toHaveLength(1);
  });
});

describe("番号を固定とパック（2026-11-19 の r1）", () => {
  it("パック（packs/<フォルダ>/scenario）の台詞にも番号を振り、作り直してもパックの台詞の番号を retired に移さない（lim voice-lock と同じ）", async () => {
    const start = ws.fileText("start");
    ws.write("start", `@voice-auto アカリ pattern="akari/{n:3}.ogg"\n${start.text}`, start.hash);
    mkdirSync(join(dir, "packs/extra/scenario"), { recursive: true });
    writeFileSync(join(dir, "packs/extra/pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    writeFileSync(join(dir, "packs/extra/scenario/bonus.lim"), '@voice-auto アカリ pattern="akari/{n:3}.ogg"\nアカリ「おまけの台詞」\n');
    const first = await lockVoices(ws, 2);
    const lock = () => JSON.parse(readFileSync(join(dir, "voice-lock.json"), "utf8")) as { lines: Record<string, { n: number; source: string }>; retired?: Record<string, unknown> };
    const bonus = () => Object.values(lock().lines).find((e) => e.source === "「おまけの台詞」");
    expect(bonus()?.n).toBeGreaterThan(0);
    const n = bonus()!.n;
    const again = await lockVoices(ws, 2);
    expect(again).toMatchObject({ kept: first.total, added: 0, total: first.total });
    expect(bonus()?.n).toBe(n);
    expect(lock().retired).toBeUndefined();
  });
});

describe("番号を固定とパック: 初めて作るとき", () => {
  it("パックの台詞の番号は、本体にパックを重ねて遊んだときに鳴る番号を写す（lim voice-lock と同じ）", async () => {
    writeFileSync(join(dir, "scenario/start.lim"), '# start\n@voice-auto アカリ pattern="akari/{n:3}.ogg"\nアカリ「一」\n@jump side\n');
    writeFileSync(join(dir, "scenario/side.lim"), "# side\nアカリ「本体の脇」\n");
    rmSync(join(dir, "scenario/epilogue.lim"), { force: true });
    mkdirSync(join(dir, "packs/extra/scenario"), { recursive: true });
    writeFileSync(join(dir, "packs/extra/pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    writeFileSync(join(dir, "packs/extra/scenario/side.lim"), "# side\nアカリ「パックの脇一」\nアカリ「パックの脇二」\n@jump bonus\n");
    writeFileSync(join(dir, "packs/extra/scenario/bonus.lim"), "# bonus\nアカリ「おまけ」\n");
    const fresh = await StudioWorkspace.open(loadProject(dir));
    await lockVoices(fresh, 2);
    const lock = JSON.parse(readFileSync(join(dir, "voice-lock.json"), "utf8")) as { lines: Record<string, { n: number; source: string }> };
    const n = (source: string) => Object.values(lock.lines).find((e) => e.source === source)?.n;
    expect([n("「一」"), n("「本体の脇」"), n("「パックの脇二」"), n("「おまけ」")]).toEqual([1, 2, 3, 4]);
  });
});

describe("見た目の確かめの画像", () => {
  it("置き場の中の PNG だけを読む", () => {
    expect(regressFileOf("start#opening")).toBe("start_opening.png");
    const project = loadProject(dir);
    expect(() => readRegressImage(project, "diff", "start_opening.png")).toThrow(/ありません/);
    expect(() => readRegressImage(project, "other", "a.png")).toThrow();
    expect(() => readRegressImage(project, "diff", "../x.png")).toThrow();
    const folder = join(dir, ".liminalia/regress/diff");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "start_opening.png"), "png");
    expect(readRegressImage(project, "diff", "start_opening.png").toString()).toBe("png");
  });
});
