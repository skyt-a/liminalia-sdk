import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse, SCRIPT_FORMAT, translationKey, voiceLines } from "@liminalia/lang";
import { PROJECT_FILE_KINDS, type ProjectFileKind } from "@liminalia/project";
import { runFmt } from "../src/commands/fmt.ts";
import { runI18n } from "../src/commands/i18n.ts";
import { runMigrate } from "../src/commands/migrate.ts";
import { runNew } from "../src/commands/new.ts";
import { runProseExtract } from "../src/commands/proofread.ts";
import { runRename } from "../src/commands/rename.ts";
import { runProjectTests } from "../src/commands/test.ts";
import { runVoiceLock } from "../src/commands/voice-lock.ts";

/**
 * 作品を書き換える命令が、作品の中のどの種類のファイル（@liminalia/project の PROJECT_FILE_KINDS）も扱うことを、ひな形の写しで確かめる。
 * 命令ごとに、種類ごとの扱い（rewrites: 名前を書き換える、untouched: 変えない、stops: 何も書かずに止める）を表に書き、
 * 種類を足したのに表に書き足していなければ落ちる。書き換えたあとも lim test が通ることも確かめる。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const work = mkdtempSync(join(tmpdir(), "liminalia-files-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let count = 0;

/** 命令の出力を黙らせて、出した行を返す（投げたものは value に）。 */
async function quiet<T>(run: () => Promise<T> | T): Promise<{ value: T | Error; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    let value: T | Error;
    try {
      value = await run();
    } catch (e) {
      value = e instanceof Error ? e : new Error(String(e));
    }
    return { value, out: [...log.mock.calls, ...error.mock.calls].map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
}

const read = (dir: string, rel: string) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : "");
const config = (dir: string) => JSON.parse(read(dir, "liminalia.json")) as Record<string, unknown>;
const writeJson = (dir: string, rel: string, value: unknown) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
};

/** フォルダの下のファイル（作品のフォルダからのパス → 中身）。 */
function filesUnder(dir: string, sub: string, filter: (name: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (folder: string) => {
    if (!existsSync(folder)) return;
    for (const e of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, e.name);
      if (e.isDirectory()) walk(path);
      else if (filter(e.name)) out[relative(dir, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(join(dir, sub));
  return out;
}
const decoded = (files: Record<string, string>) => Object.entries(files).map(([k, v]) => `${k}\n${Buffer.from(v, "base64").toString("utf8")}`).join("\n");

/** UTF-8 で読めないシナリオ（Shift_JIS の「あ」82 A0 と、ASCII の部分に変数とジャンプ先）。 */
const SJIS = Buffer.concat([Buffer.from("# old\n@set game.looked = true\n"), Buffer.from([0x82, 0xa0]), Buffer.from("\n@jump epilogue#dawn\n")]);

/** 種類ごとの中身（比べるための字面）。 */
const EXTRACT: Record<ProjectFileKind, (dir: string) => string> = {
  script: (dir) => decoded(filesUnder(dir, "scenario", (n) => n.endsWith(".lim") && n !== "sjis.lim")),
  "script-not-utf8": (dir) => (existsSync(join(dir, "scenario", "sjis.lim")) ? readFileSync(join(dir, "scenario", "sjis.lim")).toString("base64") : ""),
  test: (dir) => decoded(filesUnder(dir, "tests")),
  "config-entry": (dir) => JSON.stringify([config(dir).entry, config(dir).afterLoad]),
  "config-chapters": (dir) => JSON.stringify(config(dir).chapters),
  "config-extra": (dir) => JSON.stringify(config(dir).extra),
  "config-scenes": (dir) => JSON.stringify([config(dir).scenes, (config(dir).check as { sound?: unknown } | undefined)?.sound]),
  "config-variables": (dir) => JSON.stringify(config(dir).variables),
  "config-format": (dir) => JSON.stringify([config(dir).format, config(dir).fmt]),
  // 先頭の $schema（lim new が書く、エディタ向けの印）は中身ではないので比べない
  cast: (dir) => {
    const { $schema: _schema, ...rest } = JSON.parse(read(dir, "cast.json")) as Record<string, unknown>;
    return JSON.stringify(rest);
  },
  translation: (dir) => decoded(filesUnder(dir, "lang")),
  data: (dir) => decoded(filesUnder(dir, "data")),
  "voice-lock": (dir) => read(dir, "voice-lock.json"),
};

/**
 * ひな形の写しに、どの種類も入れた作品を作る（sjis なら UTF-8 で読めないシナリオも）。ファイル epilogue、ラベル epilogue#dawn、
 * 変数 game.looked、キャラクター アカリ、話者 ソウ を、それぞれの種類の中で名指しする。
 */
async function fixture(o: { sjis?: boolean } = {}): Promise<string> {
  const dir = join(work, `p${++count}`);
  cpSync(TEMPLATE, dir, { recursive: true });
  const c = config(dir);
  Object.assign(c, {
    afterLoad: "epilogue#dawn",
    chapters: [
      { id: "c1", title: "一", files: ["start"] },
      { id: "c2", title: "二", files: ["epilogue"] },
    ],
    extra: { replay: [{ id: "r", title: "夜明け", target: "epilogue#dawn" }], flowchart: { titles: { "epilogue#dawn": "夜明け" } } },
    scenes: { "epilogue#dawn": { pov: "アカリ" } },
    check: { sound: { quiet: ["epilogue#dawn"] } },
    variables: { "game.looked": false },
    fmt: { indent: 2 },
  });
  writeJson(dir, "liminalia.json", c);
  writeFileSync(
    join(dir, "tests", "extra.limtest"),
    ["# 話者と変数とジャンプ先", "set game.looked = true", "choose 望遠鏡をのぞく", "expect game.looked", 'expect text "ソウ"', 'expect visits("epilogue#dawn") == 0', ""].join("\n"),
  );
  // 訳（鍵はファイルと原文から）と、ボイスの番号の固定（鍵はファイルと話者と原文から）
  expect((await quiet(() => runI18n(dir, "en"))).value).toBe(true);
  const speakers = (JSON.parse(read(dir, "cast.json")) as { speakers: string[] }).speakers;
  const say = voiceLines(parse(read(dir, "scenario/epilogue.lim"), "epilogue", { speakers })).find((v) => v.speaker === "ソウ")!;
  writeJson(dir, "voice-lock.json", { lines: { [say.key]: { speaker: say.speaker, n: 1, source: say.source } } });
  writeJson(dir, "data/notes.json", { memo: "epilogue#dawn を見直す" });
  if (o.sjis) writeFileSync(join(dir, "scenario", "sjis.lim"), SJIS);
  return dir;
}

type Handling = "rewrites" | "untouched" | "stops";

interface CommandCase {
  name: string;
  /** その命令のために作品に足すもの。 */
  prepare?(dir: string): void;
  /** 命令を流す。作品を新しく作る命令は、作った作品のフォルダを返す。 */
  run(dir: string): Promise<unknown>;
  /** 作った作品のフォルダ（省くと dir のまま）。 */
  result?(dir: string): string;
  /** 種類ごとの扱い（すべての種類を書く）。 */
  kinds: Record<ProjectFileKind, Handling>;
  /** rewrites の種類で、書き換えたあとの中身（EXTRACT の字面と、作品のフォルダ）を確かめる。 */
  check: Partial<Record<ProjectFileKind, (after: string, dir: string) => void>>;
}

/**
 * どの種類も変えない扱い（命令ごとに、ここから書き換えるものと止めるものを替える）。種類を足したら、ここに書き、
 * 下の命令ごとに書き換えるかを決める（書かなければ型の確認と、表を確かめるテストが落ちる）。
 */
const KEEP_ALL: Record<ProjectFileKind, Handling> = {
  script: "untouched",
  "script-not-utf8": "untouched",
  test: "untouched",
  "config-entry": "untouched",
  "config-chapters": "untouched",
  "config-extra": "untouched",
  "config-scenes": "untouched",
  "config-variables": "untouched",
  "config-format": "untouched",
  cast: "untouched",
  translation: "untouched",
  data: "untouched",
  "voice-lock": "untouched",
};
/** 書き換える命令の既定（UTF-8 で読めないシナリオがあれば止める。ほかは変えない）。 */
const base = (rewrites: readonly ProjectFileKind[]): Record<ProjectFileKind, Handling> => ({ ...KEEP_ALL, "script-not-utf8": "stops", ...Object.fromEntries(rewrites.map((k) => [k, "rewrites"])) });

const COMMANDS: CommandCase[] = [
  {
    name: "lim rename file epilogue last",
    run: (dir) => runRename(dir, "file", "epilogue", "last"),
    kinds: base(["script", "test", "config-entry", "config-chapters", "config-extra", "config-scenes", "translation", "voice-lock"]),
    check: {
      script: (t) => expect(t).toContain("@jump last"),
      test: (t) => {
        expect(t).toContain("expect reach last#dawn");
        expect(t).toContain('visits("last#dawn")');
      },
      "config-entry": (t) => expect(t).toContain("last#dawn"),
      "config-chapters": (t) => expect(JSON.parse(t)[1].files).toEqual(["last"]),
      "config-extra": (t) => expect(t).not.toContain("epilogue"),
      "config-scenes": (t) => expect(t).not.toContain("epilogue"),
      translation: (t) => expect(t).not.toContain('"epilogue:'),
      "voice-lock": (t) => expect(t).not.toContain('"epilogue:'),
    },
  },
  {
    name: "lim rename label epilogue#dawn morning",
    run: (dir) => runRename(dir, "label", "epilogue#dawn", "morning"),
    kinds: base(["script", "test", "config-entry", "config-extra", "config-scenes"]),
    check: {
      script: (t) => expect(t).toMatch(/^# morning$/m),
      test: (t) => {
        expect(t).toContain("expect reach epilogue#morning");
        expect(t).toContain('visits("epilogue#morning")');
      },
      "config-entry": (t) => expect(t).toContain("epilogue#morning"),
      "config-extra": (t) => expect(t).not.toContain("dawn"),
      "config-scenes": (t) => expect(t).not.toContain("dawn"),
    },
  },
  {
    name: "lim rename variable game.looked game.peeked",
    run: (dir) => runRename(dir, "variable", "game.looked", "game.peeked"),
    kinds: base(["script", "test", "config-variables"]),
    check: {
      script: (t) => expect(t).not.toMatch(/game\.looked\b/),
      test: (t) => {
        expect(t).not.toMatch(/game\.looked\b/);
        expect(t).toContain("set game.peeked = true");
      },
      "config-variables": (t) => expect(JSON.parse(t)).toEqual({ "game.peeked": false }),
    },
  },
  {
    name: "lim rename character アカリ akari",
    run: (dir) => runRename(dir, "character", "アカリ", "akari"),
    // キャラクター ID はテストにも訳の話者名にも出ない（話者名はそのまま）。本文の中の {@chara …} を書き換えた行の訳の鍵は付け替える
    kinds: base(["script", "cast", "translation"]),
    check: {
      script: (t) => expect(t).toContain("@chara akari normal"),
      cast: (t) => expect(Object.keys(JSON.parse(t).cast)).toContain("akari"),
      translation: (t) => expect(t).toContain("{@chara akari"),
    },
  },
  {
    name: "lim rename speaker ソウ 蒼",
    run: (dir) => runRename(dir, "speaker", "ソウ", "蒼"),
    kinds: base(["script", "test", "cast", "translation", "voice-lock"]),
    check: {
      script: (t) => expect(t).toMatch(/^蒼「/m),
      test: (t) => expect(t).toContain('expect text "蒼"'),
      cast: (t) => expect(JSON.parse(t).speakers).toContain("蒼"),
      translation: (t) => expect(t).toContain('"蒼"'),
      "voice-lock": (t) => expect(t).toContain('"speaker": "蒼"'),
    },
  },
  {
    name: "lim migrate",
    prepare(dir) {
      // 前の版の命令の名前と、ending= に文言を書いた前の書き方（訳つき）
      writeFileSync(join(dir, "scenario", "start.lim"), `${read(dir, "scenario/start.lim")}\n# old\n@show アカリ normal\n@title-screen ending="BAD END：沈黙"\n`);
      const en = JSON.parse(read(dir, "lang/en.json")) as { lines: Record<string, unknown> };
      en.lines[translationKey("start", "arg", "BAD END：沈黙")] = { source: "BAD END：沈黙", text: "BAD END: Silence", note: "@title-screen" };
      writeJson(dir, "lang/en.json", en);
      const c = config(dir);
      // 0.1.17 までの整形の設定（format の中）
      delete c.fmt;
      writeJson(dir, "liminalia.json", { ...c, format: { indent: 2, expressions: false } });
    },
    run: (dir) => runMigrate(dir, { check: false, json: false }),
    kinds: base(["script", "config-format", "translation"]),
    check: {
      script: (t) => expect(t).toContain('# old\n@chara アカリ normal\n@title-screen ending=bad title="沈黙"'),
      "config-format": (t) => expect(JSON.parse(t)).toEqual([SCRIPT_FORMAT, { indent: 2, expressions: false }]),
      // 名前の訳は title= の鍵へ（訳の頭の種類も外す）
      translation: (t) => expect(t).toContain('"source": "沈黙",\n      "text": "Silence"'),
    },
  },
  {
    name: "lim fmt",
    prepare: (dir) => writeFileSync(join(dir, "scenario", "start.lim"), `${read(dir, "scenario/start.lim")}\n# fmt\n@set game.wished=false\n`),
    run: (dir) => runFmt(dir, false),
    kinds: base(["script"]),
    check: { script: (t) => expect(t).toContain("@set game.wished = false") },
  },
  {
    name: "lim i18n --stamp-ids",
    run: (dir) => runI18n(dir, null, { stampIds: true }),
    kinds: base(["script", "translation", "voice-lock"]),
    check: {
      script: (t) => expect(t).toMatch(/ #line:\S+$/m),
      // 鍵は振った行 ID（`ファイル:l@ID`、`ファイル:v@ID`）
      translation: (t, dir) => {
        const ids = [...t.matchAll(/"epilogue:[lc]@([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(read(dir, "scenario/epilogue.lim")).toContain(`#line:${id}`);
      },
      "voice-lock": (t, dir) => {
        const id = /"epilogue:v@([A-Za-z0-9_-]+)"/.exec(t)?.[1];
        expect(read(dir, "scenario/epilogue.lim")).toContain(`#line:${id}`);
      },
    },
  },
  {
    name: "lim new --template",
    // 写した作品は、ひな形と同じ中身（UTF-8 で読めないシナリオも、そのままのバイト列で写す。読まないので壊さない）
    run: async (dir) => runNew(join(dir, "..", `${relative(work, dir)}-made`), { template: dir, id: "made" }),
    result: (dir) => join(dir, "..", `${relative(work, dir)}-made`),
    kinds: KEEP_ALL,
    check: {},
  },
];

describe("作品を書き換える命令は、作品のどの種類のファイルも扱う", () => {
  it("表はすべての命令に、すべての種類の扱いを書いている（種類を足したら表に書き足す）", () => {
    for (const c of COMMANDS) {
      expect(Object.keys(c.kinds).sort(), c.name).toEqual(Object.keys(PROJECT_FILE_KINDS).sort());
      for (const [kind, handling] of Object.entries(c.kinds)) if (handling === "rewrites") expect(c.check[kind as ProjectFileKind], `${c.name} ${kind}`).toBeTypeOf("function");
    }
  });

  for (const c of COMMANDS) {
    it(`${c.name}: 書き換えるものはすべて書き換え、ほかは変えず、そのあとも lim test が通る`, { timeout: 120_000 }, async () => {
      const dir = await fixture();
      c.prepare?.(dir);
      const before = Object.fromEntries(Object.entries(EXTRACT).map(([k, f]) => [k, f(dir)]));
      const r = await quiet(() => c.run(dir));
      expect(r.value instanceof Error ? r.value.message : r.value, `${c.name}\n${r.out}`).not.toBe(false);
      expect(r.value, r.out).not.toBeInstanceOf(Error);
      const after = c.result?.(dir) ?? dir;
      for (const kind of Object.keys(PROJECT_FILE_KINDS) as ProjectFileKind[]) {
        const now = EXTRACT[kind](after);
        if (c.kinds[kind] === "rewrites") {
          expect(now, `${c.name} は ${kind} を書き換える`).not.toBe(before[kind]);
          c.check[kind]!(now, after);
        } else expect(now, `${c.name} は ${kind} を変えない`).toBe(before[kind]);
      }
      const tests = await runProjectTests(after);
      const failed = tests.flatMap((f) => [...f.problems.map((p) => `${f.file}:${p.line} ${p.message}`), ...f.tests.filter((t) => !t.ok).map((t) => `${f.file} ${t.name}: ${t.failures.map((x) => x.ja).join(" / ")}`)]);
      expect(failed, c.name).toEqual([]);
      expect(tests.flatMap((f) => f.tests)).toHaveLength(4);
    });
  }

  for (const c of COMMANDS) {
    const handling = c.kinds["script-not-utf8"];
    it(`${c.name}: UTF-8 で読めないシナリオがあれば${handling === "stops" ? "何も書かずに止める" : "そのまま写す"}`, { timeout: 120_000 }, async () => {
      const dir = await fixture({ sjis: true });
      c.prepare?.(dir);
      const before = filesUnder(dir, ".");
      const r = await quiet(() => c.run(dir));
      if (handling === "stops") {
        // 止めたことを知らせる（throw は lim が終了の値 2、false は 1 にする）
        expect(r.value === false || r.value instanceof Error, c.name).toBe(true);
        expect(r.value instanceof Error ? r.value.message : r.out, c.name).toContain("UTF-8 で読めないシナリオファイルがあるため、何も書き換えませんでした: sjis.lim");
        expect(filesUnder(dir, "."), c.name).toEqual(before);
      } else {
        expect(r.value, r.out).not.toBeInstanceOf(Error);
        expect(EXTRACT["script-not-utf8"](c.result?.(dir) ?? dir)).toBe(SJIS.toString("base64"));
      }
    });
  }
});

describe("UTF-8 で読めないシナリオファイル（Shift_JIS）とほかの命令", () => {
  it("lim i18n <言語>、lim prose extract、lim voice-lock も止め、英語でも知らせる", { timeout: 120_000 }, async () => {
    const dir = await fixture({ sjis: true });
    const before = filesUnder(dir, ".");
    for (const [name, run] of [
      ["lim i18n en", () => runI18n(dir, "en")],
      ["lim prose extract", () => runProseExtract(dir, [], { out: join(dir, "prose.txt") })],
      ["lim voice-lock", () => runVoiceLock(dir, 1)],
    ] as const) {
      const r = await quiet(run);
      expect(r.value, name).toBeInstanceOf(Error);
      expect((r.value as Error).message, name).toContain("何も書き換えませんでした: sjis.lim");
      expect(filesUnder(dir, "."), name).toEqual(before);
    }
    const en = await quiet(() => runRename(dir, "file", "epilogue", "after", { lang: "en" }));
    expect(en.out).toContain("Nothing was rewritten because a script file isn't UTF-8: sjis.lim");
  });

  it("読むだけの命令は、そのファイルを流さなければ使える（lim test）", { timeout: 120_000 }, async () => {
    const dir = await fixture({ sjis: true });
    const files = await runProjectTests(dir);
    expect(files.flatMap((f) => f.tests).every((t) => t.ok)).toBe(true);
  });
});
