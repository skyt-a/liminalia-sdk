import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubAnnotation, runCheck } from "../src/commands/check.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-check-ci-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function check(o: { github?: boolean; strict?: boolean }): Promise<{ ok: boolean; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const ok = await runCheck(dir, false, "ja", o);
    return { ok, lines: log.mock.calls.map((c) => String(c[0])) };
  } finally {
    log.mockRestore();
  }
}

describe("lim check の CI 向けの出力", () => {
  it("注釈の値の改行・%・区切りを逃がす", () => {
    expect(githubAnnotation({ severity: "warning", code: "x-y", message: "a%b\nc", file: "f", line: 3, column: 2, hint: "h" }, "scenario/a,b.lim")).toBe("::warning file=scenario/a%2Cb.lim,line=3,col=2,title=lim check x-y::a%25b%0Ac%0A→ h");
    expect(githubAnnotation({ severity: "info", code: "z", message: "m", file: "f", line: 1 }, "f")).toMatch(/^::notice /);
  });

  it("--github はシナリオの診断を、今のフォルダからの .lim のパスの注釈にする", async () => {
    const start = join(dir, "scenario", `${JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).entry.split("#")[0]}.lim`);
    writeFileSync(start, `${readFileSync(start, "utf8")}\n@jump nowhere_at_all\n`);
    const { ok, lines } = await check({ github: true });
    expect(ok).toBe(false);
    const annotation = lines.find((l) => l.startsWith("::error "));
    expect(annotation).toContain(`file=${relative(process.cwd(), start).split("\\").join("/").replace(/:/g, "%3A").replace(/,/g, "%2C")}`);
  });

  it("--strict は警告だけでも失敗にする（無ければ通る）", async () => {
    expect((await check({ strict: true })).ok).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { languages?: string[] };
    // 訳のファイルが無い言語は警告（missing-translation）
    config.languages = [...(config.languages ?? ["ja"]), "xx"];
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(config));
    expect((await check({})).ok).toBe(true);
    const strict = await check({ strict: true, github: true });
    expect(strict.ok).toBe(false);
    expect(strict.lines.some((l) => l.startsWith("::warning file=lang/xx.json") || l.includes("lang/xx.json"))).toBe(true);
    expect(strict.lines.at(-1)).toMatch(/^::error title=lim check::警告が \d+ 件あります/);
  });
});

describe("lim check の設定の JSON", () => {
  it("読めない liminalia.json は、その位置の誤りだけを出して失敗にする", async () => {
    writeFileSync(join(dir, "liminalia.json"), '{\n  "id": "x",\n  "title": "t",\n  "entry": "start",\n}\n');
    const { ok, lines } = await check({});
    expect(ok).toBe(false);
    expect(lines).toEqual(["liminalia.json:5:1 error [bad-config] JSON として読めません: 最後の項目のあとの , は書けません"]);
  });

  it("知らない項目は警告、variables の誤りはその項目だけのエラー（ほかの検査は続ける）", async () => {
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, titelScreen: false, variables: { "game.a": 1, "a b": 2 } }, null, 2));
    const { ok, lines } = await check({});
    expect(ok).toBe(false);
    expect(lines.filter((l) => l.startsWith("liminalia.json"))).toEqual([
      expect.stringMatching(/^liminalia\.json:\d+ warning \[unknown-config-key\] liminalia\.json の titelScreen は知らない項目のため、使われません\n    → titleScreen のことですか？$/),
      expect.stringMatching(/^liminalia\.json:\d+ error \[bad-config\] liminalia\.json の variables の a b は/),
    ]);
  });
});

describe("lim check の音の抜け（check.sound）", () => {
  it("ひな形には出ず、無音の長い区間、空振りの停止、ファイルをまたぐループを流れに沿って出す。check.sound で変えられる", async () => {
    expect((await check({})).lines.filter((l) => /\[(long-silence|redundant-stop|loop-across-files)\]/.test(l))).toEqual([]);
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `本文${i + 1}。`).join("\n");
    writeFileSync(join(dir, "scenario", "start.lim"), `@bg hill_dusk.webp\n@stop-bgm\n${lines(31)}\n@se rain.ogg loop=true channel=1\n@jump epilogue\n`);
    writeFileSync(join(dir, "scenario", "epilogue.lim"), "@bg hill_night.webp\n夜。\n@title-screen\n");
    const sound = (await check({})).lines.filter((l) => /\[(long-silence|redundant-stop|loop-across-files)\]/.test(l)).map((l) => l.split("\n")[0]);
    expect(sound).toEqual([
      "epilogue:2 info [loop-across-files] start:34 で鳴らしたループの効果音 rain.ogg（チャンネル 1）が、epilogue でも鳴り続けています",
      "start:2 info [redundant-stop] @stop-bgm の時点で BGM は鳴っていません（どの流れから来ても止める曲がありません）",
      "start:3 warning [long-silence] ここから BGM も環境音も鳴らないまま、本文が 31 行続きます（start:33 まで）",
    ]);
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, check: { sound: { silence: 40, carry: ["rain.ogg"], off: ["redundant-stop"] } } }));
    expect((await check({})).lines.filter((l) => /\[(long-silence|redundant-stop|loop-across-files|unknown-config-key)\]/.test(l))).toEqual([]);
  });
});

describe("lim check の素材の名前", () => {
  it("大文字と小文字だけが違う素材の名前を、フォルダの中身と突き合わせてエラーにする（Mac と Windows でも）", async () => {
    const start = join(dir, "scenario", "start.lim");
    writeFileSync(start, `${readFileSync(start, "utf8")}\n@bg Hill_Dusk.webp\n`);
    const { ok, lines } = await check({});
    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("[asset-case-mismatch] 素材 bgimage/Hill_Dusk.webp は、ファイルの名前と大文字と小文字が違います（ファイルは hill_dusk.webp。"))).toBe(true);
  });
});
