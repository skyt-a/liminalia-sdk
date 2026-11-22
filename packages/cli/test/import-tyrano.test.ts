import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** lim new --from-tyrano と lim import --assets をプロセスとして動かす（制作アプリの「TyranoScript／TyranoBuilder の作品から」と同じ処理）。 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const BUILDER = resolve(import.meta.dirname, "../../ks-import/test/fixtures/builder-project");

function lim(args: string[]) {
  const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 90_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const work = mkdtempSync(join(tmpdir(), "liminalia-import-tyrano-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("TyranoScript の作品から作る", { timeout: 90_000 }, () => {
  it("lim new --from-tyrano は、台本の取り込み、素材の写し、「はじめから」の設定までを一度に行う", () => {
    const dir = join(work, "rainy");
    const r = lim(["new", dir, "--from-tyrano", BUILDER]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("シナリオ 1 ファイルを取り込みました（本文の一致 1 / 1 ファイル）");
    expect(r.out).toContain("「はじめから」: room.lim");
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { title: string; entry: string; screen: { width: number; height: number }; import?: unknown };
    // 題名と画面の大きさは TyranoScript の設定から。一度だけの取り込みなので import.tyrano は書かない
    expect(config).toMatchObject({ title: "雨の日の部屋", entry: "room", screen: { width: 1024, height: 768 } });
    expect(config.import).toBeUndefined();
    // 起動とタイトル画面の .ks は取り込まず、白紙の台本も残さない
    expect(existsSync(join(dir, "scenario/first.lim"))).toBe(false);
    expect(existsSync(join(dir, "scenario/title_screen.lim"))).toBe(false);
    expect(existsSync(join(dir, "scenario/start.lim"))).toBe(false);
    // タイトル画面の .ks への jump は、Liminalia のタイトル画面へ戻る @title-screen になる
    expect(readFileSync(join(dir, "scenario/room.lim"), "utf8")).toContain("@title-screen");
    for (const f of ["bgimage/room.png", "bgm/morning.ogg", "fgimage/chara/akari/normal.png"]) expect(existsSync(join(dir, "assets", f)), f).toBe(true);
    const report = readFileSync(join(dir, "import-report.md"), "utf8");
    expect(report).toContain("## 新しいプロジェクト");
    expect(report).toContain("素材 3 件をコピーしました");
    // そのまま点検が通る（素材も揃っている）
    const check = lim(["check", dir]);
    expect(check.code, check.out + check.err).toBe(0);
    const trace = lim(["trace", dir, "room"]);
    expect(trace.out).toContain("アカリ「おはよう」");
  });

  it("--ci は CI のひな形と、はじめから終わりまで流れるテストを置く（黙って無視しない）", () => {
    const dir = join(work, "rainy-ci");
    const r = lim(["new", dir, "--from-tyrano", BUILDER, "--ci"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain(".github/workflows/liminalia-check.yml");
    expect(readFileSync(join(dir, ".github/workflows/liminalia-check.yml"), "utf8")).toContain("lim.mjs test . --github");
    expect(readFileSync(join(dir, "tests/start.limtest"), "utf8")).toContain("expect end");
    // 取り込んだシナリオ（entry は room）で流れる
    const test = lim(["test", dir]);
    expect(test.code, test.out + test.err).toBe(0);
    // --ci が無ければ置かない
    const plain = join(work, "rainy-plain");
    expect(lim(["new", plain, "--from-tyrano", BUILDER]).code).toBe(0);
    expect(existsSync(join(plain, ".github"))).toBe(false);
    expect(existsSync(join(plain, "tests"))).toBe(false);
  });

  it("TyranoScript の作品でないフォルダは理由を言って止まる", () => {
    const r = lim(["new", join(work, "none"), "--from-tyrano", TEMPLATE]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("TyranoScript の作品のフォルダではありません");
  });

  it("lim import --assets は、取り込みのあとに素材も写す（写す先にあるものは上書きしない）", () => {
    const dir = join(work, "managed");
    cpSync(TEMPLATE, dir, { recursive: true });
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, import: { tyrano: { source: BUILDER } } }));
    const plain = lim(["import", dir]);
    expect(plain.out).not.toContain("素材");
    expect(existsSync(join(dir, "assets/bgimage/room.png"))).toBe(false);
    const r = lim(["import", dir, "--assets"]);
    expect(r.out, r.err).toContain("素材 3 件をコピーしました");
    expect(existsSync(join(dir, "assets/bgimage/room.png"))).toBe(true);
    expect(lim(["import", dir, "--assets", "--lang", "en"]).out).toContain("Copied 0 assets (0.0 MB), 3 already there");
  });
});
