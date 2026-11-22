import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check.ts";

/** 校正の道具（lim script-export、lim prose extract / apply）と、整形（lim fmt --indent）、下書きと黙らせる書き方（lim check、lim build の前の検査）をプロセスとして確かめる。 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

function lim(args: string[], cwd?: string) {
  const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 60_000, ...(cwd ? { cwd } : {}) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const work = mkdtempSync(join(tmpdir(), "liminalia-proofread-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("校正と整形の道具", { timeout: 120_000 }, () => {
  it("lim script-export はファイルごとにテキストと HTML を書き出す", () => {
    const dir = join(work, "export");
    cpSync(TEMPLATE, dir, { recursive: true });
    expect(lim(["script-export", dir]).code).toBe(0);
    const text = readFileSync(join(dir, "exports/script/start.txt"), "utf8");
    expect(text).toContain("｜流星群《りゅうせいぐん》");
    expect(text).toContain("アカリ「着いた……っ。この坂、こんなに長かったっけ」");
    expect(text).not.toContain("@bg");
    expect(lim(["script-export", dir, "--format", "html", "--out", join(dir, "html")]).code).toBe(0);
    expect(readFileSync(join(dir, "html/start.html"), "utf8")).toContain("<ruby>流星群<rt>りゅうせいぐん</rt></ruby>");
    expect(existsSync(join(dir, "html/index.html"))).toBe(true);
  });

  it("lim prose extract で抜き出し、直した本文だけを書き戻す。本文以外を変えた行は書き戻さず 1 で終わる", () => {
    const dir = join(work, "prose");
    cpSync(TEMPLATE, dir, { recursive: true });
    const out = join(work, "prose.txt");
    expect(lim(["prose", "extract", "--out", out], dir).code).toBe(0);
    const doc = readFileSync(out, "utf8");
    expect(doc).toContain("// ruby: aozora");
    expect(doc).toMatch(/^\[start:\d+ [0-9a-f]{6}\] アカリ「着いた……っ。/m);
    writeFileSync(out, doc.replace("この坂、こんなに長かったっけ", "この坂、こんなに長かったかな").replace("ソウ「……お客さんか。めずらしいな」", "アカリ「……お客さんか。めずらしいな」"));
    const r = lim(["prose", dir, "apply", out]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("書き戻した行 1");
    expect(r.out).toMatch(/start\.lim:\d+: 本文以外/);
    const start = readFileSync(join(dir, "scenario/start.lim"), "utf8");
    expect(start).toContain("この坂、こんなに長かったかな");
    expect(start).toContain("ソウ「……お客さんか。めずらしいな」");
  });

  it("lim prose extract <プロジェクト> と lim prose <プロジェクト> extract は、どちらも作品の外から動く", () => {
    const dir = join(work, "prose-outside");
    cpSync(TEMPLATE, dir, { recursive: true });
    for (const [args, name] of [
      [["prose", "extract", dir], "a.txt"],
      [["prose", dir, "extract"], "b.txt"],
    ] as const) {
      const out = join(work, name);
      const r = lim([...args, "--out", out], work);
      expect(r.code, r.out + r.err).toBe(0);
      expect(readFileSync(out, "utf8")).toMatch(/^\[start:\d+ [0-9a-f]{6}\] アカリ「着いた……っ。/m);
    }
    // apply も同じ（直していないので書き戻す行は無い）
    const r = lim(["prose", "apply", dir, join(work, "a.txt"), "--check"], work);
    expect(r.code, r.out + r.err).toBe(0);
  });

  it("lim fmt --indent 2 はブロックの字下げをそろえ、--check は整っていなければ 1", () => {
    const dir = join(work, "fmt");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario/extra.lim"), "# extra\n@if game.a==1\n地の文\n@end\n");
    expect(lim(["fmt", dir, "--check"]).code).toBe(1);
    expect(lim(["fmt", dir, "--indent", "2"]).code).toBe(0);
    expect(readFileSync(join(dir, "scenario/extra.lim"), "utf8")).toBe("# extra\n@if game.a == 1\n  地の文\n@end\n");
  });

  it("lim fmt --check は直す所をファイルと行と、前と後の行で示す（多ければ数だけ）", () => {
    const dir = join(work, "fmt-check");
    cpSync(TEMPLATE, dir, { recursive: true });
    const many = Array.from({ length: 12 }, (_, i) => `@set game.n${i}=${i}`).join("\n");
    writeFileSync(join(dir, "scenario/extra.lim"), `# extra\n@if game.a!=1\n地の文\n@end\n${many}\n`);
    const r = lim(["fmt", dir, "--check"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("extra.lim:2");
    expect(r.out).toContain("- @if game.a!=1");
    expect(r.out).toContain("+ @if game.a != 1");
    expect(r.out).toContain("ほか 3 か所");
    expect(r.out).toContain("lim fmt");
    // 英語でも
    const en = lim(["fmt", dir, "--check", "--lang", "en"]);
    expect(en.out).toContain("extra.lim:2");
    expect(en.out).toContain("3 more places");
    expect(en.out).not.toMatch(/[぀-ヿ㐀-鿿]/);
  });

  it("lim check は lim-ignore と check.severity を当て、下書きへ移る行を警告する", () => {
    const dir = join(work, "check");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario/side.lim"), "// lim: draft\n# side\n書きかけ\n@jump #nowhere_yet\n");
    writeFileSync(join(dir, "scenario/extra.lim"), "# extra\n// lim-ignore unreachable-line\n@jump side\n届かない\n@jump side\nこれも…\n");
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, check: { severity: { "single-ellipsis": "off" } } }, null, 2));
    const r = lim(["check", dir, "--json"]);
    const json = JSON.parse(r.out) as { diagnostics: { file: string; line: number; code: string; severity: string }[] };
    const codes = json.diagnostics.filter((d) => d.file === "extra" || d.file === "side").map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`);
    // 下書きの中の無いラベルはエラーのまま（構文チェックはかける）。lim-ignore は次の行（@jump）に効くので、届かない行の警告は残る
    expect(codes).toEqual(["extra:2 info unused-ignore", "extra:3 warning draft-target", "extra:4 warning unreachable-line", "extra:5 warning draft-target", "side:4 error unknown-label"]);
  });

  it("書き出しの前の検査は、下書きの中の誤りを数えず、下書きへ移る行はエラーにする", async () => {
    const dir = join(work, "build-check");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario/side.lim"), "// lim: draft\n# side\n@jump #nowhere_yet\n");
    const log = console.log;
    console.log = () => undefined;
    try {
      expect(await runCheck(dir, false)).toBe(false);
      expect(await runCheck(dir, false, "ja", { build: true })).toBe(true);
      writeFileSync(join(dir, "scenario/extra.lim"), "# extra\n@jump side\n");
      expect(await runCheck(dir, false)).toBe(false);
      writeFileSync(join(dir, "scenario/side.lim"), "// lim: draft\n# side\n書きかけ\n");
      expect(await runCheck(dir, false)).toBe(true);
      expect(await runCheck(dir, false, "ja", { build: true })).toBe(false);
    } finally {
      console.log = log;
    }
  });
});
