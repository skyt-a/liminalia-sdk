import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STD_MAPPINGS, STD_UNSUPPORTED_TAGS } from "@liminalia/ks-import";
import { CORE_COMMANDS } from "@liminalia/lang";
import std from "@liminalia/std/commands";
import { SAMPLE_ASSETS_NOTE } from "../src/commands/new.ts";

// LIMINALIA_E2E_OUT を指定すると、撮った画面写真をその場所に残す。
const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");

function lim(args: string[], cwd?: string, timeout = 60_000) {
  const r = spawnSync(process.execPath, [LIM, ...args], { cwd, encoding: "utf8", timeout });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("ひな形をブラウザで動かす", () => {
  let work: string;
  let dir: string;
  let shots: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "liminalia-template-browser-"));
    dir = join(work, "browser");
    const r = lim(["new", "browser", "--id", "e2e_template", "--title", "星を待つ丘"], work);
    if (r.code !== 0) throw new Error(r.err);
    shots = process.env.LIMINALIA_E2E_OUT ? resolve(process.env.LIMINALIA_E2E_OUT) : join(work, "shots");
    mkdirSync(shots, { recursive: true });
  });
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("ブラウザ版に書き出し、タイトル画面まで起動する", () => {
    const r = lim(["build", dir, "browser"], undefined, 300_000);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toContain("タイトル画面まで進みました");
    expect(existsSync(join(dir, "dist/browser/e2e_template/index.html"))).toBe(true);
    expect(existsSync(join(dir, "dist/browser/e2e_template/assets/bgm/quiet_night.wav"))).toBe(true);
    expect(existsSync(join(dir, SAMPLE_ASSETS_NOTE))).toBe(true);
    const names = files(join(dir, "dist/browser/e2e_template")).map((file) => basename(file));
    // 外部の部品のライセンスだけを配り、素材の説明は入れない。
    expect(names.filter((name) => (name.endsWith(".txt") && name !== "THIRD_PARTY_LICENSES.txt") || name === SAMPLE_ASSETS_NOTE)).toEqual([]);
  }, 300_000);

  it("書き出したエンジンに TyranoScript の取り込みと立ち絵の位置調整画面と制作画面が入っていない", () => {
    const out = join(dir, "dist/browser/e2e_template");
    const js = files(out)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(js.length).toBeGreaterThan(0);
    // 取り込み元の .ks のタグ名（.lim の命令名と同じ綴りのもの、[image] など、は除く）と取り込みの診断の文
    const commands = new Set([...CORE_COMMANDS, ...std.commands].map((c) => c.name));
    // frame はエンジンの設定の名前（ui のシステム画面の画像の frame）と同じ綴りなので、タグ名としては探さない
    const words = new Set(["frame"]);
    const tags = [...STD_MAPPINGS.flatMap((m) => m.tags), ...Object.keys(STD_UNSUPPORTED_TAGS)].filter((t) => !commands.has(t) && !words.has(t));
    expect(tags.filter((t) => js.includes(`"${t}"`) || js.includes(`'${t}'`))).toEqual([]);
    for (const marker of ["tb_", "は変換していません", "unsupported-tag", "swallowStop", "__liminalia/cast", "立ち絵の位置調整", "__liminalia/studio", "liminalia:stage-show", "Liminalia Studio"]) expect(js.includes(marker), marker).toBe(false);
    expect(existsSync(join(out, "caster.html"))).toBe(false);
    expect(existsSync(join(out, "studio.html"))).toBe(false);
  });

  it("タイトル画面と本文の画面写真を撮れる", () => {
    for (const [args, name] of [
      [["--title"], "title.png"],
      [["start", "--skip", "6", "--wait", "1500"], "dusk.png"],
      [["start#night", "--skip", "3", "--wait", "1500"], "night.png"],
      [["epilogue", "--skip", "4", "--wait", "1500"], "dawn.png"],
    ] as const) {
      const out = join(shots, name);
      const r = lim(["shot", dir, ...args, "--out", out], undefined, 120_000);
      expect(r.code, `${r.out}\n${r.err}`).toBe(0);
      // 撮影のあとに出るのは、ページのエラーと警告だけ
      expect(r.out.trim().split("\n").slice(1), r.out).toEqual([]);
      expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
    }
  }, 300_000);
});
