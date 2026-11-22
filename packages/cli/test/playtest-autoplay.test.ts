import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlaytestRun } from "../src/commands/playtest.ts";

/**
 * lim playtest と lim shot の自動確認。作品のプラグインの画面（examples/stamp-plugin の @stamp-pick）、@investigate、@text-input、
 * 飛ばせない @movie を、命令の autoplay で止まらずに進める（描画側の画面を出さず、行き先を選ぶ画面は選択肢になって選び方を変えられる）。
 * lim shot は、開始位置の直後の操作待ちの画面と選択肢を描かせて撮り、撮る所より前の選択肢では待たずに失敗する。
 * 書き出しと Chromium が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const LIM = join(ROOT, "packages/cli/bin/lim.mjs");
const FIXTURES = join(ROOT, "packages/web/test/e2e/fixtures");

const SCENARIO = `# start
はじまり。
@movie m.webm
動画のあと。
@text-input game.name initial="ユイ"
名前は{= game.name}。
@investigate room
調べ終えた。
@stamp-pick images=stamps/ok.png,stamps/ng.png
選んだのは{= game.stamp}。
@jump #fin
# desk
机を調べた。
# fin
おわり。
`;

/** 開始位置の直後が操作待ちの画面か選択肢の所（lim shot がその画面で止まって撮る）。 */
const SHOT_SCENARIO = `# pick
@stamp-pick images=stamps/ok.png,stamps/ng.png
選んだ。
# menu
@choice
- 右へ -> #fin
- 左へ -> #fin
@end
# fin
おわり。
`;

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("自動確認（命令の autoplay）", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-autoplay-"));
    cpSync(join(ROOT, "templates/default"), dir, { recursive: true });
    for (const part of ["package.json", "src"]) cpSync(join(ROOT, "examples/stamp-plugin", part), join(dir, "plugins/stamp", part), { recursive: true });
    writeFileSync(join(dir, "scenario/a.lim"), SCENARIO);
    writeFileSync(join(dir, "scenario/b.lim"), SHOT_SCENARIO);
    mkdirSync(join(dir, "assets/video"), { recursive: true });
    cpSync(join(FIXTURES, "test-movie.webm"), join(dir, "assets/video/m.webm"));
    mkdirSync(join(dir, "assets/image/stamps"), { recursive: true });
    for (const name of ["ok", "ng"]) cpSync(join(FIXTURES, "stripes.png"), join(dir, `assets/image/stamps/${name}.png`));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data/investigation.json"), JSON.stringify({ places: { room: { file: "a", views: [{ id: "v", label: "部屋", background: "hill_night.webp", spots: [{ id: "desk", label: "机", rect: { x: 100, y: 100, width: 200, height: 200 }, target: "#desk" }] }] } } }));
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...cfg, entry: "a", plugins: ["./plugins/stamp"] }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lim playtest は、プラグインの画面と調べる場所と文字の入力と動画で止まらず、実行ごとに選び方を変える", () => {
    // 2 秒の動画を流せば、1.5 秒進まないので止まった扱いになる
    const r = spawnSync(process.execPath, [LIM, "playtest", dir, "--rebuild", "--runs", "2", "--stuck", "1.5", "--max-pages", "200", "--timeout", "120", "--json"], { encoding: "utf8", timeout: 400_000 });
    const json = r.stdout.slice(r.stdout.lastIndexOf("\n{") + 1);
    const result = JSON.parse(json) as { ok: boolean; runs: PlaytestRun[] };
    expect(result.runs.map((run) => [run.outcome, run.errors]), json).toEqual([
      ["ended", []],
      ["ended", []],
    ]);
    expect(r.status).toBe(0);
    // 調べる場所と、プラグインの画面（スタンプ）は選択肢になる。2 通り目は 2 番目のスタンプを選ぶ
    expect(result.runs.map((run) => run.choices)).toEqual([
      ["机", "stamps/ok.png"],
      ["机", "stamps/ng.png"],
    ]);
  }, 400_000);

  it("lim shot は、撮る所までの文字の入力と動画を autoplay で進める", () => {
    const out = join(dir, "shot.png");
    // 3 ページ目は「名前は ユイ。」（動画と @text-input のあと）
    const r = spawnSync(process.execPath, [LIM, "shot", dir, "a", "--skip", "3", "--out", out], { encoding: "utf8", timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("a:6");
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
  }, 150_000);
  it("lim shot は、開始位置の直後の操作待ちの画面（プラグインの画面）を autoplay で進めずに描かせて撮る", () => {
    const out = join(dir, "pick.png");
    const r = spawnSync(process.execPath, [LIM, "shot", dir, "b#pick", "--out", out, "--eval", "document.querySelectorAll('.stamp-pick button, .stamp-pick img').length"], { encoding: "utf8", timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(/eval: 0\b/);
    expect(r.stdout).toMatch(/eval: [1-9]/);
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
  }, 150_000);

  it("lim shot は、開始位置の直後の選択肢で止まって撮る", () => {
    const out = join(dir, "menu.png");
    const r = spawnSync(process.execPath, [LIM, "shot", dir, "b#menu", "--out", out, "--eval", "window.__liminalia.host.choosing"], { encoding: "utf8", timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("eval: true");
  }, 150_000);

  it("lim shot は、撮る所より前の選択肢で止まったら、時間切れを待たずに分かる文で失敗する", () => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [LIM, "shot", dir, "b#menu", "--skip", "3", "--out", join(dir, "never.png")], { encoding: "utf8", timeout: 120_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("3 ページ目より前の選択肢で止まりました");
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 150_000);
});
