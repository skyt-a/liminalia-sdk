import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { englishLine, englishText, installEnglishOutput } from "../src/english-output.ts";
import { langFlag, outputLanguage } from "../src/output-language.ts";
import { commandFlags, USAGE, usageCommands, usageOf } from "../src/usage.ts";

/**
 * lim の英語の出力（--lang en、LIMINALIA_LANG=en、端末の言語が英語）。
 * - 使い方、断り、経過の日本語の文が、すべて文言の表（src/messages-en.ts と、書き出しの経過の @liminalia/project の build-lines-en.ts）で
 *   英語になるか（日本語の文を足して英語を書き忘れると落ちる）
 * - どの命令も --lang を受け、使い方と断りを英語で出すか
 * - 英語の作品で、よく使う命令を実際のプロセスとして流して、日本語が出ないか
 */

const CLI = resolve(import.meta.dirname, "..");
const LIM = join(CLI, "bin/lim.mjs");
/** 日本語の字と、日本語の括弧と句読点。 */
const JAPANESE = /[぀-ヿ㐀-鿿（）「」『』、。]/;

/** 英語の環境（端末の言語を英語にし、ほかの言語の指定を外す）。 */
const EN_ENV = { ...process.env, LIMINALIA_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "en_US.UTF-8" };
/** 言語を決めない環境（日本語になる）。 */
const PLAIN_ENV = { ...process.env, LIMINALIA_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "" };

function lim(args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(process.execPath, [LIM, ...args], { cwd: o.cwd, env: o.env ?? EN_ENV, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

/** 日本語を含む行（無ければ空）。 */
const japaneseLines = (text: string) => text.split("\n").filter((l) => JAPANESE.test(l));

// ---- 原文の文を集める ----

/** 英語の表で読み替えずに、命令ごとに英語を持つもの（AI のアシスタント向けの MCP、lim explain の解説）。 */
const SKIP_FILES = [/^commands\/mcp/, /^commands\/explain\.ts$/, /^diagnostic-docs/, /^diagnostic-examples/];
/** 出力に渡る関数（console と、書き出しの経過の step と fail、名前の変更の say、録画の経過の note、あとで出す断りと行を積む push）。 */
const OUTPUT_CALLEES = new Set(["console.log", "console.error", "console.warn", "console.info", "process.stdout.write", "process.stderr.write", "Error", "step", "fail", "say", "note", "problems.push", "warnings.push", "out.push", "lines.push", "writeProgress"]);
/** 中の文がすべて出力に渡るファイル（lim doctor の表）。 */
const ALL_OUTPUT_FILES = new Set(["commands/doctor.ts"]);
/** 中の文がすべて出力の一部になる関数（録画の止まり方と、かかる時間の書き方）。 */
const ALL_OUTPUT_FUNCTIONS = new Set(["stopText", "formatDuration"]);
/**
 * 一行を組み立てる途中の部品（組み立てた行は、書き出しの経過の表 @liminalia/project の build-lines-en.ts にある。
 * packages/project/test/build-lines-en.test.ts が組み立てた形を確かめる）。
 */
const PARTS = new Set(["（公証して staple する）", "（公証の認証情報が無いため署名だけ。ダウンロードして開くと Gatekeeper に止められます）", "外部のコマンド（X）", "。開発用の鍵で署名しました。ストアで公開するときは build.android に署名の鍵を指定してください", "版 X の本体に入れる", "前の書き出しの版が分からないため、どの版にも入る", "。前の書き出しと同じ鍵で暗号化", "、キャスト", "、訳 X"]);

function sourceFiles(dir = join(CLI, "src")): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

/** 条件が英語の出力かを見る式（language === "en"、en、english など）。 */
const ENGLISH_CONDITION = /(?:^|[^\w])(?:en|english|isEnglish)(?:[^\w]|$)|["']en["']/;

/** 英語の出力を出し終えて抜ける if（if (en) { …英語…; return; }）。続く文は日本語の出力だけになる。 */
function englishThenReturn(n: ts.Statement): boolean {
  if (!ts.isIfStatement(n) || n.elseStatement || !ENGLISH_CONDITION.test(n.expression.getText()) || /^\s*!/.test(n.expression.getText())) return false;
  const then = n.thenStatement;
  const last = ts.isBlock(then) ? then.statements.at(-1) : then;
  return !!last && ts.isReturnStatement(last);
}

/**
 * 出力に渡る、日本語を含む文字列。テンプレートの ${…} は X に置き換える。英語で出し分けている三項演算子（en ? 英語 : 日本語）は、
 * 英語の側だけを見る（日本語の側は英語の出力では出ない）。英語を出して抜ける if のあとの文も見ない。
 */
function japaneseOutputs(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const path of sourceFiles()) {
    const rel = relative(join(CLI, "src"), path).split("\\").join("/");
    if (SKIP_FILES.some((re) => re.test(rel))) continue;
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const strings = (n: ts.Node): void => {
      if (ts.isConditionalExpression(n)) {
        const cond = n.condition.getText();
        if (ENGLISH_CONDITION.test(cond)) {
          const negated = /^\s*!/.test(cond) || /!==\s*["']en["']/.test(cond);
          return strings(negated ? n.whenFalse : n.whenTrue);
        }
        return [n.whenTrue, n.whenFalse].forEach(strings);
      }
      if (ts.isBinaryExpression(n)) return [n.left, n.right].forEach(strings);
      if (ts.isParenthesizedExpression(n)) return strings(n.expression);
      const text = ts.isStringLiteralLike(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => `X${s.literal.text}`).join("") : null;
      if (text !== null && JAPANESE.test(text)) out.push({ where: where(n), text });
      if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) strings(s.expression);
    };
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && ALL_OUTPUT_FUNCTIONS.has(n.name.text)) {
        const all = (m: ts.Node): void => {
          if (ts.isStringLiteralLike(m) || ts.isTemplateExpression(m)) strings(m);
          else ts.forEachChild(m, all);
        };
        all(n);
        return;
      }
      if (ALL_OUTPUT_FILES.has(rel) && (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n))) {
        strings(n);
        return;
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const e = n.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `${e.expression.getText()}.${e.name.text}` : "";
        if (OUTPUT_CALLEES.has(name)) n.arguments?.forEach(strings);
      }
      // if (en) { 英語 } else { 日本語 } は英語の側だけ（if (!en) なら else の側だけ）
      if (ts.isIfStatement(n) && n.elseStatement && ENGLISH_CONDITION.test(n.expression.getText())) {
        const negated = /^\s*!/.test(n.expression.getText()) || /!==\s*["']en["']/.test(n.expression.getText());
        walk(negated ? n.elseStatement : n.thenStatement);
        return;
      }
      if (ts.isBlock(n) || ts.isSourceFile(n)) {
        for (const s of n.statements) {
          walk(s);
          if (englishThenReturn(s)) break;
        }
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

describe("出力の言語の決め方", () => {
  it("--lang、LIMINALIA_LANG、端末の言語（LC_ALL、LC_MESSAGES、LANG）の順に決め、どれも無ければ日本語", () => {
    expect(outputLanguage(undefined, {})).toBe("ja");
    expect(outputLanguage("en", {})).toBe("en");
    expect(outputLanguage("ja", { LIMINALIA_LANG: "en" })).toBe("ja");
    expect(outputLanguage(undefined, { LIMINALIA_LANG: "en", LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(outputLanguage(undefined, { LANG: "en_US.UTF-8" })).toBe("en");
    expect(outputLanguage(undefined, { LANG: "ja_JP.UTF-8" })).toBe("ja");
    expect(outputLanguage(undefined, { LC_ALL: "ja_JP.UTF-8", LANG: "en_US.UTF-8" })).toBe("ja");
    expect(outputLanguage(undefined, { LC_MESSAGES: "fr_FR.UTF-8", LANG: "ja_JP.UTF-8" })).toBe("en");
    // C と POSIX（CI の既定）は言語を選んでいない
    expect(outputLanguage(undefined, { LANG: "C.UTF-8" })).toBe("ja");
    expect(outputLanguage(undefined, { LANG: "POSIX" })).toBe("ja");
    // 遊ぶ言語の ko（lim shot --lang ko）は出力の言語を決めない
    expect(outputLanguage("ko", { LANG: "en_US.UTF-8" })).toBe("en");
    expect(langFlag(["check", ".", "--lang", "en"])).toBe("en");
    expect(langFlag(["check", "--lang=en"])).toBe("en");
    expect(langFlag(["check", "--lang"])).toBeUndefined();
    // 二つ書いたときは最後のものを使う（parseFlags の str と同じ）
    expect(langFlag(["check", "--lang", "ja", "--lang=en"])).toBe("en");
    expect(langFlag(["check", "--lang=ja", "--lang", "en"])).toBe("en");
  });
});

describe("文言の表", () => {
  it("出力に渡る日本語の文が、すべて英語の表に当てはまる（日本語の文を足したら src/messages-en.ts に英語を書く）", () => {
    const found = japaneseOutputs();
    expect(found.length).toBeGreaterThan(300);
    // 「、」だけの文字（並べる区切り）は、差し込む所で英語の区切りにする
    // 「、」で始まる部品（前の文に続けるもの）は、続ける中身を見る
    const missing = found.filter(({ text }) => !PARTS.has(text) && !/^[\s、]*$/.test(text) && JAPANESE.test(englishText(text)) && JAPANESE.test(englishText(text.replace(/^、/, "")))).map(({ where, text }) => `${where} ${text}`);
    expect(missing).toEqual([]);
  });

  it("使い方の全体と、命令ごとの使い方を英語で出せる", () => {
    expect(japaneseLines(englishText(USAGE))).toEqual([]);
    for (const command of usageCommands()) expect(japaneseLines(englishText(usageOf(command))), command).toEqual([]);
  });

  it("どの命令も --lang を受ける", () => {
    expect(usageCommands().filter((c) => !commandFlags(c).has("lang"))).toEqual([]);
  });

  it("組み立てた行も英語にする（差し込んだ言葉、並べたもの、続けた文）", () => {
    expect(englishText("動画: v.mp4（3 ページ、5.1 秒、プレイが終わりました）")).toBe("Video: v.mp4 (3 pages, 5.1 seconds; the play ended)");
    expect(englishText("動画: v.mp4（1 ページ、5.1 秒）")).toBe("Video: v.mp4 (1 page, 5.1 seconds)");
    expect(englishText("見込み: 約 1 分 5 秒、1 MB（3 ページ。分かれ道はどれも通るものとして数えます）。空き: 2 GB")).toBe("Estimate: about 1 min 5 s, 1 MB (3 pages, counting every branch as played). Free space: 2 GB");
    expect(englishText("終了の理由: end 1 / 別ファイルへ 2")).toBe("Why the runs ended: end 1 / to another file 2");
    expect(englishText("lim fmt: 余分な引数があります: a b")).toBe("lim fmt: Too many arguments: a b");
    expect(englishText("::error title=lim coverage::到達した本文が 50.0% で、--min-lines 80 より低い")).toBe("::error title=lim coverage::Only 50.0% of the text was reached, below --min-lines 80");
    expect(englishText("  dist/browser/game（2.2 MB）")).toBe("  dist/browser/game (2.2 MB)");
    // 前に空けた行（console.log(`\n…`)）は、まとまりで訳したときも残す
    expect(englishText("\n--dry-run のため、VDF を作るだけにしました（上のコマンドで上げられます）")).toBe("\nBecause of --dry-run, only the VDF files were made (the command above uploads them)");
    // lim coverage の届いたエンディング（名前のある結末は 種類「名前」（場所））
    expect(englishText("    good「The Way Home」（start:39）: 2 回")).toBe('    good "The Way Home" (start:39): 2 times');
    expect(englishText("    bad「沈黙」: 1 回")).toBe('    bad "沈黙": 1 time');
    expect(englishText("    good: 3 回")).toBe("    good: 3 times");
    // lim clean のソースマップの控えの数（差し込みは空のときもある）
    expect(englishText("片付ける書き出しはありません（dist の中で、名前ごとに新しい 1 件（ソースマップの控えは 3 件）を残します）")).toBe("No exports to clean up (in dist, the newest 1 for each name are kept (3 for the source map backups))");
    expect(englishText("片付ける書き出しはありません（dist の中で、名前ごとに新しい 2 件を残します）")).toBe("No exports to clean up (in dist, the newest 2 for each name are kept)");
    // lim publish steam --dry-run の steamcmd の行（アカウント名の場所。planSteamPublish の command を publish-steam.ts と同じに並べたもの）
    expect(englishText('/opt/steam/steamcmd.sh +login "<Steam のアカウント名>" +run_app_build /p/out/steam/app_build_0.vdf +quit')).toBe('/opt/steam/steamcmd.sh +login "<Steam account name>" +run_app_build /p/out/steam/app_build_0.vdf +quit');
    // 作品のプラグインを読むときの警告（@liminalia/project）
    expect(englishText("[プラグイン] プラグイン ./x.ts を読み込めません（not found）。このプラグインを抜いて続けます")).toBe("[Plugin] Can't load the plugin ./x.ts (not found). Continuing without it");
  });

  it("作品の本文や名前の日本語は、そのまま残す（「、」も英語の区切りにしない）", () => {
    expect(englishLine("アカリ「こんにちは、元気？」")).toBe("アカリ「こんにちは、元気？」");
    expect(englishText("ok\nno japanese")).toBe("ok\nno japanese");
    expect(englishText('{\n  "message": "日本語"\n}')).toBe('{\n  "message": "日本語"\n}');
  });

  it("console の文を出す直前に英語にする（オブジェクトはそのまま）", () => {
    const lines: unknown[][] = [];
    const fake = { log: (...a: unknown[]) => lines.push(a), info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    installEnglishOutput(fake);
    fake.log("すべて整形済みです");
    fake.log({ a: 1 });
    expect(lines).toEqual([["All files are formatted"], [{ a: 1 }]]);
  });
});

describe("lim の使い方と断り（英語）", () => {
  it("lim --help --lang en と、LIMINALIA_LANG=en の命令ごとの --help", () => {
    const r = lim(["--help", "--lang", "en"], { env: PLAIN_ENV });
    expect(r.code).toBe(0);
    expect(r.out).toContain("lim check");
    expect(japaneseLines(r.all)).toEqual([]);
    const c = lim(["check", "--help"], { env: { ...PLAIN_ENV, LIMINALIA_LANG: "en" } });
    expect(c.code).toBe(0);
    expect(c.out).toContain("lim check");
    expect(japaneseLines(c.all)).toEqual([]);
  });

  it("端末の言語が英語なら、知らない命令、知らない旗、余分な引数も英語で断る", () => {
    const unknown = lim(["no-such-command"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("no-such-command");
    expect(japaneseLines(unknown.all)).toEqual([]);
    const flag = lim(["coverage", "--lang", "en", "--nope"], { cwd: resolve(CLI, "../../templates/default") });
    expect(flag.code).toBe(2);
    expect(flag.err).toContain("--nope");
    expect(japaneseLines(flag.all)).toEqual([]);
    const extra = lim(["fmt", resolve(CLI, "../../templates/default"), "a", "b"]);
    expect(extra.code).toBe(2);
    expect(japaneseLines(extra.all)).toEqual([]);
    const missing = lim(["new"]);
    expect(missing.code).toBe(2);
    expect(japaneseLines(missing.all)).toEqual([]);
  });

  it("--lang ja は端末の言語より先に効き、言語を決めない環境では日本語のまま", () => {
    expect(lim(["--help", "--lang", "ja"]).out).toContain("使い方");
    expect(lim(["--help"], { env: PLAIN_ENV }).out).toContain("使い方");
  });
});

describe("英語の作品で lim を流す", { timeout: 240_000 }, () => {
  let work: string;
  let dir: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "liminalia-english-"));
    dir = join(work, "my-story");
    // 英語の端末で --lang を付けずに作ると、英語の見本の物語になる
    const r = lim(["new", dir, "--ci"]);
    expect(r.code, r.all).toBe(0);
    expect(japaneseLines(r.all)).toEqual([]);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const commands: string[][] = [
    ["check"],
    ["test"],
    ["fmt", "--check"],
    ["coverage", "--runs", "2"],
    ["stats"],
    ["unused"],
    ["migrate", "--check"],
    ["doctor", "--target", "browser"],
    ["clean", "--dry-run"],
    ["i18n", "fr", "--count"],
    ["voice-script"],
    ["reach", "epilogue#dawn"],
    ["reach", "start#wish"],
    ["trace", "start", "--choose", "0,2,0"],
    ["voice-lock"],
  ];
  for (const args of commands) {
    it(`lim ${args.join(" ")}`, () => {
      const r = lim([args[0]!, dir, ...args.slice(1)]);
      expect(japaneseLines(r.all), r.all).toEqual([]);
    });
  }

  it("lim publish steam --dry-run は、steamcmd のコマンドの行（ログインする名前の欄）も英語で出す", () => {
    const file = join(dir, "liminalia.json");
    const before = readFileSync(file, "utf8");
    try {
      const config = JSON.parse(before) as { build?: Record<string, unknown> };
      config.build = { ...(config.build ?? {}), steam: { appId: 1234560, depots: { mac: 1234562 } } };
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      // ログインする名前を決めていない（steamcmd のコマンドには名前の欄を出す）
      const r = lim(["publish", dir, "steam", "--dry-run"], { env: { ...EN_ENV, LIMINALIA_STEAM_LOGIN: "" } });
      expect(r.out).toContain("+run_app_build");
      // コマンドの行と、--dry-run の断りの前は、日本語の出力と同じく一行空ける
      expect(r.out).toMatch(/\n\n[^\n]*\+login "<Steam account name>" \+run_app_build [^\n]*\n\nBecause of --dry-run/);
      expect(japaneseLines(r.all), r.all).toEqual([]);
    } finally {
      writeFileSync(file, before);
    }
  });

  it("lim test は、選ぶ選択肢が無いときも、そのとき選べた選択肢を英語で並べる", () => {
    const story = join(work, "choices");
    expect(lim(["new", story, "--blank"]).code).toBe(0);
    writeFileSync(join(story, "scenario/start.lim"), "# start\n@choice\n- Go north -> #north\n- Go south -> #south\n@end\n# north\nNorth.\n# south\nSouth.\n");
    mkdirSync(join(story, "tests"), { recursive: true });
    writeFileSync(join(story, "tests/start.limtest"), "# Picks a missing option\nchoose Go west\nexpect end\n");
    const r = lim(["test", story]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Go north / Go south");
    expect(japaneseLines(r.all), r.all).toEqual([]);
  });
});
