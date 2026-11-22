import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { backportProject, backportTyrano, importTyrano, makeBackportBase, parseSourceMap, type BackportReport, type ImportSourceMap } from "../src/node.ts";
import { lex } from "../src/lexer.ts";
import { diffLines } from "../src/backport/line-diff.ts";
import { editTagBody, scanKsLine } from "../src/backport/ks-line.ts";
import { jsExpression } from "../src/backport/inverse.ts";
import { convertJsAssignments, convertJsExpression } from "../src/js-expr.ts";

/**
 * 書き戻し（lim backport）。合成の TyranoScript プロジェクトを取り込んだ .lim に手を入れ、
 * 書き戻した .ks を取り込み直すと手を入れた .lim と同じになるか、.ks の書き方（TyranoBuilder の囲み・話者の行・タグの書き方）が
 * 保たれるかを確かめる。
 */
const registry = createRegistry(CORE_COMMANDS);
const profile = { skipFiles: ["first"] };
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

/** fixture を取り込み、edit で .lim に手を入れて書き戻す。 */
async function backport(name: string, edit: (lim: Files) => void, o: { rewriteAll?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "liminalia-backport-test-"));
  temps.push(tmp);
  const source = fixture(name);
  await importTyrano({
    source,
    scenarioOut: join(tmp, "base/lim"),
    dataOut: join(tmp, "base/data"),
    castOut: join(tmp, "base/cast.json"),
    reportOut: join(tmp, "base/import-report.md"),
    sourceMapOut: join(tmp, "base/import-sourcemap.json"),
    registry,
    profile,
  });
  cpSync(join(tmp, "base/lim"), join(tmp, "cur"), { recursive: true });
  const files = new Files(join(tmp, "cur"));
  edit(files);
  const speakers = (JSON.parse(readFileSync(join(tmp, "base/cast.json"), "utf8")) as { speakers: string[] }).speakers;
  const report = await backportTyrano({
    baseKs: join(source, "data/scenario"),
    baseLim: join(tmp, "base/lim"),
    sourceMap: join(tmp, "base/import-sourcemap.json"),
    currentLim: join(tmp, "cur"),
    source,
    out: join(tmp, "out/scenario"),
    registry,
    profile,
    speakers: [...speakers, ...files.speakers],
    ...o,
  });
  const ks = (file: string) => readFileSync(join(tmp, "out/scenario", file), "utf8");
  const baseKs = (file: string) => readFileSync(join(source, "data/scenario", file), "utf8");
  /** 書き戻した .ks の、基準から変わった行（- 消えた行 / + 足した行）。 */
  const changes = (file: string) =>
    diffLines(baseKs(file).split("\n"), ks(file).split("\n")).flatMap((op) =>
      op.op === "delete" ? [`- ${baseKs(file).split("\n")[op.a]}`] : op.op === "insert" ? [`+ ${ks(file).split("\n")[op.b]}`] : [],
    );
  return { report, ks, changes, tmp };
}

/** .lim の写しに手を入れる道具。 */
class Files {
  speakers: string[] = [];
  constructor(readonly root: string) {}
  read(file: string) {
    return readFileSync(join(this.root, file), "utf8").replace(/\n$/, "").split("\n");
  }
  write(file: string, lines: string[]) {
    writeFileSync(join(this.root, file), lines.join("\n") + "\n");
  }
  /** match の行を with に置き換える。with が配列なら複数行に、null なら消す。 */
  replace(file: string, match: string, replacement: string | string[] | null) {
    const lines = this.read(file);
    const i = lines.findIndex((l) => l.trim() === match);
    if (i < 0) throw new Error(`${file} に ${match} がありません`);
    lines.splice(i, 1, ...(replacement === null ? [] : Array.isArray(replacement) ? replacement : [replacement]));
    this.write(file, lines);
  }
  /** match の行のあとに足す。 */
  after(file: string, match: string, added: string[]) {
    const lines = this.read(file);
    const i = lines.findIndex((l) => l.trim() === match);
    if (i < 0) throw new Error(`${file} に ${match} がありません`);
    lines.splice(i + 1, 0, ...added);
    this.write(file, lines);
  }
  remove(file: string) {
    rmSync(join(this.root, file));
  }
}

const ok = (report: BackportReport) => {
  expect(report.files.flatMap((f) => f.issues.filter((i) => i.severity === "error").map((i) => `${f.lim}:${i.limLine} ${i.message}`))).toEqual([]);
  expect(report.files.flatMap((f) => f.mismatches)).toEqual([]);
  expect(report.verified).toBe(true);
};

describe("取り込みの対応表", () => {
  it(".lim のすべての行に出どころがあり（空行・@use を除く）、本文の行の .ks の範囲にその文がある", async () => {
    for (const name of ["backport-project", "tyrano-text-flow", "chara-project"]) {
      const tmp = mkdtempSync(join(tmpdir(), "liminalia-sourcemap-"));
      temps.push(tmp);
      const report = await importTyrano({
        source: fixture(name),
        scenarioOut: join(tmp, "scenario"),
        dataOut: join(tmp, "data"),
        castOut: join(tmp, "cast.json"),
        reportOut: join(tmp, "import-report.md"),
        sourceMapOut: join(tmp, "import-sourcemap.json"),
        registry,
        profile,
      });
      const map: ImportSourceMap = parseSourceMap(readFileSync(join(tmp, "import-sourcemap.json"), "utf8"));
      expect(map).toEqual(JSON.parse(JSON.stringify(report.sourceMap)));
      for (const [lim, f] of Object.entries(map.files)) {
        if (f.source === null) continue;
        const text = readFileSync(join(tmp, "scenario", lim), "utf8").replace(/\n$/, "").split("\n");
        const ks = readFileSync(join(fixture(name), "data/scenario", f.source), "utf8").split("\n");
        expect(f.lines.length, lim).toBe(text.length);
        text.forEach((line, i) => {
          const o = f.lines[i];
          if (line.trim() === "" || line.startsWith("@use ")) return expect(o, `${lim}:${i + 1}`).toBeNull();
          expect(o, `${lim}:${i + 1} ${line}`).not.toBeNull();
          expect(o!.from).toBeLessThanOrEqual(o!.to);
          if (o!.kind === "text" && !/[{}\\]/.test(line)) {
            // 本文の最後の数文字が .ks の範囲にある
            const tail = [...line].slice(-3).join("");
            expect(ks.slice(o!.from - 1, o!.to).join("\n"), `${lim}:${i + 1}`).toContain(tail);
          }
        });
      }
    }
  });

  it("本文の行は .ks の行の範囲、命令の行は出どころのタグを持つ", async () => {
    const { tmp } = await backport("backport-project", () => {});
    const map = parseSourceMap(readFileSync(join(tmp, "base/import-sourcemap.json"), "utf8"));
    const lim = readFileSync(join(tmp, "base/lim/scene2.lim"), "utf8").replace(/\n$/, "").split("\n");
    const lines = map.files["scene2.lim"]!.lines;
    const at = (text: string) => lines[lim.indexOf(text)];
    expect(at("道は二つに分かれていた。{click}{br}どちらも暗い。")).toEqual({ kind: "text", from: 5, to: 6 });
    expect(at("@wait 500ms")).toEqual({ kind: "command", from: 7, to: 7, tags: [lex(readFileSync(join(fixture("backport-project"), "data/scenario/scene2.ks"), "utf8"), "scene2.ks").commands.findIndex((c) => c.name === "wait")] });
    expect(at("@script")).toMatchObject({ kind: "script", from: 8, to: 10 });
    expect(at("# start")).toMatchObject({ kind: "label", from: 1, to: 1 });
    const scene1 = readFileSync(join(tmp, "base/lim/scene1.lim"), "utf8").replace(/\n$/, "").split("\n");
    const m1 = map.files["scene1.lim"]!.lines;
    expect(m1[scene1.indexOf("@choice")]).toMatchObject({ kind: "choice", from: 27, to: 27 });
    expect(m1[scene1.indexOf("  - 北へ行く -> scene1#north")]).toMatchObject({ kind: "option", from: 24, to: 24 });
    expect(m1[scene1.indexOf("  - もう一度 -> scene1#north if=(game.met==1)")]).toMatchObject({ kind: "option", from: 26, to: 26 });
    expect(m1[scene1.indexOf("@if game.met==1")]).toMatchObject({ kind: "if", from: 38, to: 38 });
  });
});

describe("書き戻し", () => {
  it("変更が無ければ、書き直しても .ks は一字一句同じ", async () => {
    for (const name of ["backport-project", "tyrano-text-flow", "chara-project"]) {
      const { report, ks } = await backport(name, () => {}, { rewriteAll: true });
      ok(report);
      expect(report.written).toEqual([]);
      for (const f of readdirSync(join(fixture(name), "data/scenario")).filter((f) => f.endsWith(".ks"))) {
        expect(ks(f)).toBe(readFileSync(join(fixture(name), "data/scenario", f), "utf8"));
      }
    }
  });

  it("本文の書き換えは、その本文だけを書き換える（話者の行・[p]・囲みは保つ）", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "ユイ「おはよう。今日は{r 早|はや}いのね」", "ユイ「おはよう。今日は少し{r 遅|おそ}いのね」");
      f.replace("scene1.lim", "窓の外では、雨が上がりかけていた。", "窓の外では、{b 雨}が上がりかけていた。");
    });
    ok(report);
    expect(changes("scene1.ks")).toEqual([
      "- 「おはよう。今日は｜早《はや》いのね」[p]",
      "+ 「おはよう。今日は少し｜遅《おそ》いのね」[p]",
      "- 窓の外では、雨が上がりかけていた。[p]",
      '+ 窓の外では、[font bold="true"]雨[resetfont]が上がりかけていた。[p]',
    ]);
  });

  it("行の終わりの固定の行 ID（#line:ID）は本文に入れず、.ks に戻さない", async () => {
    const { report, changes, ks } = await backport("backport-project", (f) => {
      const lines = f.read("scene1.lim").map((l) => {
        if (l.trim().startsWith("朝の光が")) return `${l} #line:a1b2c3d4`;
        if (l.trim().startsWith("ユイ「おはよう。")) return "ユイ「おはよう。今日は少し{r 遅|おそ}いのね」 #line:b2c3d4e5";
        if (l.trim().startsWith("- 北へ行く")) return `${l} #line:c3d4e5f6`;
        return l;
      });
      f.write("scene1.lim", lines);
    });
    ok(report);
    expect(ks("scene1.ks")).not.toContain("#line:");
    // ID を足しただけの行は変えず、書き換えた本文だけを戻す
    expect(changes("scene1.ks")).toEqual(["- 「おはよう。今日は｜早《はや》いのね」[p]", "+ 「おはよう。今日は少し｜遅《おそ》いのね」[p]"]);
  });

  it("ルビは基準の .ks の書き方に合わせる（｜親《ルビ》・[srb]・[ruby]）", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "ユイ「{r 今朝|けさ}は雨だったから」", "ユイ「{r 今朝|けさ}は{r 霧|きり}だったから」");
      f.replace("scene2.lim", "ユイ「ここが{r 町|ま}の入り口」", "ユイ「ここが{r 町|まち}の{r 門|もん}」");
    });
    ok(report);
    expect(changes("scene1.ks")).toEqual(['- 「[srb text="けさ"]今朝[erb]は雨だったから」[p]', '+ 「[srb text="けさ"]今朝[erb]は[srb text="きり"]霧[erb]だったから」[p]']);
    expect(changes("scene2.ks")).toEqual(["- 「ここが[ruby text=ま]町の入り口」[p]", '+ 「ここが[ruby text="まち"]町の[ruby text="もん"]門」[p]']);
  });

  it("行をまたぐ本文（[l][r]）は、同じタグのあとで行を分ける", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.replace("scene2.lim", "道は二つに分かれていた。{click}{br}どちらも暗い。", "道は三つに分かれていた。{click}{br}どれも暗い。");
    });
    ok(report);
    expect(changes("scene2.ks")).toEqual(["- 道は二つに分かれていた。[l][r]", "- どちらも暗い。[p]", "+ 道は三つに分かれていた。[l][r]", "+ どれも暗い。[p]"]);
  });

  it("英語の台詞（話者名の後ろの引用符）は、話者の行と引用符から始まる本文にする（空白は書かない）", async () => {
    const { report, ks } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "レン「あとで話す」", 'レン "Later."');
      f.after("scene1.lim", "朝の光が差し込んでいた。", ["ユイ“Morning.”"]);
    });
    ok(report);
    expect(ks("scene1.ks")).toContain(["朝の光が差し込んでいた。[p]", "# ユイ", "“Morning.”[p]"].join("\n"));
    expect(ks("scene1.ks")).toContain(["# レン", "「大事な話がある」[p]", '"Later."[p]'].join("\n"));
  });

  it("話者の変更・本文の追加と削除は、TyranoBuilder の話者の行を足して合わせる", async () => {
    const { report, ks } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "レン「あとで話す」", "ユイ「あとで話す」");
      f.after("scene1.lim", "朝の光が差し込んでいた。", ["鳥が鳴いた。", "レン「起きてたのか」"]);
      f.replace("scene1.lim", "ユイ「おはよう。今日は{r 早|はや}いのね」", null);
    });
    ok(report);
    expect(ks("scene1.ks")).toContain(
      [
        "[tb_start_text mode=1 ]",
        "#",
        "朝の光が差し込んでいた。[p]",
        "鳥が鳴いた。[p]",
        "# レン",
        "「起きてたのか」[p]",
        "# ユイ",
        '「[srb text="けさ"]今朝[erb]は雨だったから」[p]',
        "#",
        "窓の外では、雨が上がりかけていた。[p]",
        "[_tb_end_text]",
      ].join("\n"),
    );
    expect(ks("scene1.ks")).toContain(["# レン", "「大事な話がある」[p]", "# ユイ", "「あとで話す」[p]", "[_tb_end_text]"].join("\n"));
  });

  it("動かしただけの本文は、元の .ks の行をそのまま使う", async () => {
    const { report, ks } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "ユイ「{r 今朝|けさ}は雨だったから」", null);
      f.after("scene1.lim", "北の道を進んだ。", ["ユイ「{r 今朝|けさ}は雨だったから」"]);
    });
    ok(report);
    expect(ks("scene1.ks")).toContain(["#", "北の道を進んだ。[p]", "# ユイ", '「[srb text="けさ"]今朝[erb]は雨だったから」[p]', "[_tb_end_text]"].join("\n"));
  });

  it("命令の書き換えは、元のタグの引数だけを書き換える（書き方・変換しない引数は保つ）", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "@bg room.jpg time=1s", "@bg street.jpg time=500ms");
      f.replace("scene1.lim", "@chara yui smile at=auto time=500ms wait=true if-hidden=true", "@chara yui sad at=auto time=500ms wait=true if-hidden=true");
      f.replace("scene1.lim", "@set game.met = 1", "@set game.met = 2");
      f.replace("scene1.lim", "@bgm theme.ogg", "@bgm theme2.ogg time=2s");
    });
    ok(report);
    expect(changes("scene1.ks")).toEqual([
      '- [bg  time="1000"  method="crossfade"  storage="room.jpg"  ]',
      '+ [bg  time="500"  method="crossfade"  storage="street.jpg"  ]',
      '- [chara_show  name="yui"  face="smile"  time="500"  ]',
      '+ [chara_show  name="yui"  face="sad"  time="500"  ]',
      '- [tb_eval  exp="f.met=1"  name="met"  cmd="="  op="t"  val="1"  val_2="undefined"  ]',
      '+ [tb_eval  exp="f.met=2"  name="met"  cmd="="  op="t"  val="2"  val_2="undefined"  ]',
      '- [playbgm  volume="100"  time="1000"  loop="true"  storage="theme.ogg"  ]',
      '+ [playbgm  volume="100"  time="2000"  loop="true"  storage="theme2.ogg"  fadein="true"  ]',
    ]);
  });

  it("@chara の z= は [chara_show] の zindex に書き戻す", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "@chara yui smile at=auto time=500ms wait=true if-hidden=true", "@chara yui smile at=auto z=3 time=500ms wait=true if-hidden=true");
    });
    ok(report);
    expect(changes("scene1.ks")).toEqual(['- [chara_show  name="yui"  face="smile"  time="500"  ]', '+ [chara_show  name="yui"  face="smile"  time="500"  zindex="3"  ]']);
  });

  it("命令の追加・削除。本文の間に足した命令は、テキストブロックを閉じてから置く", async () => {
    const { report, ks, changes } = await backport("backport-project", (f) => {
      f.after("scene1.lim", "レン「大事な話がある」", ["@wait 300ms"]);
      f.after("scene1.lim", "@bg room.jpg time=1s", ["@bgm morning.ogg"]);
      f.replace("scene1.lim", "@window show", null);
      f.after("scene2.lim", "@wait 500ms", ["@bg night.jpg"]);
    });
    ok(report);
    expect(ks("scene1.ks")).toContain(["# レン", "「大事な話がある」[p]", "[_tb_end_text]", "[wait time=300]", "[tb_start_text mode=1 ]", "「あとで話す」[p]"].join("\n"));
    expect(changes("scene1.ks")).toContain('+ [playbgm  volume="100"  time="1000"  loop="true"  storage="morning.ogg"  ]');
    expect(changes("scene1.ks")).toContain("- [tb_show_message_window  ]");
    expect(changes("scene2.ks")).toEqual(['+ [bg  time="0"  method="crossfade"  storage="night.jpg"  ]']);
  });

  it("命令の行の if=(式) は .ks の cond= にする（タグが二つ以上なら [if] で囲む）", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.after("scene2.lim", "@wait 500ms", ["@bg night.jpg if=(game.night == 1)", "@jump scene1 if=(game.night == 2)"]);
    });
    ok(report);
    expect(changes("scene2.ks")).toEqual(['+ [bg  time="0"  method="crossfade"  storage="night.jpg"  cond="f.night == 1"  ]', '+ @jump storage=scene1.ks target="" cond="f.night == 2"']);
  });

  it("開いて書き戻す命令（@scene-change）の if= は、開いたどのタグにも cond= を付ける", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.after("scene2.lim", "@wait 500ms", ["@scene-change night.jpg if=(game.night == 1)"]);
    });
    ok(report);
    const added = changes("scene2.ks");
    expect(added.length).toBeGreaterThan(1);
    for (const line of added) expect(line).toContain('cond="f.night == 1"');
  });

  it("@open-screen は標準の画面なら [showsave] などに戻し、作品の画面（defineScreen の名前）は書き戻せないと報告する", async () => {
    const saved = await backport("backport-project", (f) => {
      f.after("scene2.lim", "@wait 500ms", ["@open-screen save"]);
    });
    ok(saved.report);
    expect(saved.changes("scene2.ks")).toEqual(["+ [showsave]"]);
    const custom = await backport("backport-project", (f) => {
      f.after("scene2.lim", "@wait 500ms", ["@open-screen demo.map"]);
    });
    expect(custom.report.failed).toBeGreaterThan(0);
    expect(custom.report.markdown).toContain("@open-screen demo.map");
  });

  it("選択肢の文言・飛び先の変更と、選択肢の追加・削除", async () => {
    const { report, changes } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "- 北へ行く -> scene1#north", "- 北の道へ行く -> scene1#north");
      f.replace("scene1.lim", "- 南へ行く -> scene1#south", ["- 南へ行く -> scene2#start", "- 戻る -> scene1#north"]);
    });
    ok(report);
    expect(changes("scene1.ks")).toEqual([
      '- [glink  color="black"  storage="scene1.ks"  target="*north"  text="北へ行く"  width="700"  ]',
      '- [glink  color="black"  storage="scene1.ks"  target="*south"  text="南へ行く"  width="700"  ]',
      '+ [glink  color="black"  storage="scene1.ks"  target="*north"  text="北の道へ行く"  width="700"  ]',
      '+ [glink  color="black"  storage="scene2.ks"  target="*start"  text="南へ行く"  width="700"  ]',
      '+ [glink  color="black"  storage="scene1.ks"  target="*north"  text="戻る"  width="700"  ]',
    ]);
  });

  it("選択肢の行の if=(式) は、その [glink] の cond（足す・変える・消す）", async () => {
    const changed = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "- 北へ行く -> scene1#north", '- 北へ行く -> scene1#north if=(game.met == 2 && temp.name != "a")');
      f.replace("scene1.lim", "- もう一度 -> scene1#north if=(game.met==1)", "- もう一度 -> scene1#north if=(game.met >= 1)");
    });
    ok(changed.report);
    expect(changed.changes("scene1.ks")).toEqual([
      '- [glink  color="black"  storage="scene1.ks"  target="*north"  text="北へ行く"  width="700"  ]',
      '+ [glink  color="black"  storage="scene1.ks"  target="*north"  text="北へ行く"  width="700"  cond="f.met == 2 && tf.name != \'a\'"  ]',
      '- [glink  color="black"  storage="scene1.ks"  target="*north"  text="もう一度"  width="700"  cond="f.met==1"  ]',
      '+ [glink  color="black"  storage="scene1.ks"  target="*north"  text="もう一度"  width="700"  cond="f.met >= 1"  ]',
    ]);
    const removed = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "- もう一度 -> scene1#north if=(game.met==1)", ["- もう一度 -> scene1#north", "- 待つ -> scene1#south if=(game.met == 0)"]);
    });
    ok(removed.report);
    expect(removed.changes("scene1.ks")).toEqual([
      '- [glink  color="black"  storage="scene1.ks"  target="*north"  text="もう一度"  width="700"  cond="f.met==1"  ]',
      '+ [glink  color="black"  storage="scene1.ks"  target="*north"  text="もう一度"  width="700"  ]',
      '+ [glink  color="black"  storage="scene1.ks"  target="*south"  text="待つ"  width="700"  cond="f.met == 0"  ]',
    ]);
  });

  it("新しい選択肢・ラベル・@if・@jump を足し、ラベルの名前と条件を書き換える", async () => {
    const { report, ks } = await backport("backport-project", (f) => {
      f.replace("scene1.lim", "# south", "# south_road");
      f.replace("scene1.lim", "@if game.met==1", "@if game.met >= 1");
      f.after("scene2.lim", "道は二つに分かれていた。{click}{br}どちらも暗い。", ["@if game.met == 2", "もう一度会った。", "@else", "誰もいない。", "@end", "@choice", "  - 進む -> #go", "  - 戻る -> scene1#north", "@end", "", "# go", "進んだ。", "@jump scene1#south_road"]);
      f.replace("scene1.lim", "- 南へ行く -> scene1#south", "- 南へ行く -> scene1#south_road");
    });
    ok(report);
    expect(ks("scene1.ks")).toContain("*south_road\n");
    expect(ks("scene1.ks")).toContain('[if exp="f.met >= 1"]');
    expect(ks("scene2.ks")).toContain(
      ['[if exp="f.met == 2"]', "もう一度会った。[p]", "[else]", "誰もいない。[p]", "[endif]"].join("\n"),
    );
    expect(ks("scene2.ks")).toContain("*go\n進んだ。[p]\n");
  });

  it("足した行のあいだに基準の空行が挟まっても、足した順のまま書き戻す（@if を落とさない）", async () => {
    // 本文の直後に、ラベルと @if（ここで一つの塊）・基準と同じ空行・@if の中の本文と @end（別の塊）を足す。
    // 二つの塊は同じ基準の行のあとに置かれるが、前は先頭の行の種類（本文かどうか）で置き場所を決めていたので、
    // 本文の塊が先に書かれ、[endif] が [if] より前に出ていた
    // （実際の作品の取り込みで起きていた。[endif] が先に出て、取り込み直しが落ちていた）
    const { report, ks } = await backport("backport-insert", (f) => {
      const lines = f.read("scene.lim");
      const at = lines.indexOf("二行目。");
      expect(lines.slice(at, at + 3)).toEqual(["二行目。", "", "# next"]);
      lines.splice(at + 2, 0, "  寄り道の文。", "@end");
      lines.splice(at + 1, 0, "# extra", "@if game.met == 0");
      f.write("scene.lim", lines);
    });
    ok(report);
    const text = ks("scene.ks");
    const order = ["二行目。[p]", "*extra", '[if exp="f.met == 0"]', "寄り道の文。[p]", "[endif]", "*next"].map((s) => text.indexOf(s));
    expect(order.every((x) => x >= 0), text).toBe(true);
    expect([...order].sort((a, b) => a - b), text).toEqual(order);
  });

  it("[link] の選択肢と、装飾・[lr] を含む本文（fixtures/tyrano-text-flow）", async () => {
    const { report, changes } = await backport("tyrano-text-flow", (f) => {
      f.replace("chapter1.lim", "- 北の道 -> #north", "- 北の小道 -> #north");
      f.replace("chapter1.lim", "- 南の道 -> chapter2#south", ["- 南の道 -> chapter2#east", "- 西の道 -> #north"]);
      f.replace("chapter1.lim", "レン「{b {size 32 大事な}}話がある」{click}{br}「{mark #ffff66 今日}のうちに」", "レン「{b {size 32 大事な}}話をしよう」{click}{br}「{mark #ffff66 明日}までに」");
    });
    ok(report);
    expect(changes("chapter1.ks")).toEqual([
      '- 「[font size=32 bold=true]大事な[resetfont]話がある」[lr]',
      '- 「[mark color=0xffff66]今日[endmark]のうちに」[p]',
      '+ 「[font size="32" bold="true"]大事な[resetfont]話をしよう」[lr]',
      '+ 「[mark color="0xffff66"]明日[endmark]までに」[p]',
      '- [link target="*north"]北の道[endlink][r]',
      '- [link storage="chapter2.ks" target="*south"]南の道[endlink]',
      '+ [link target="*north"]北の小道[endlink][r]',
      // 足した選択肢の前の行は、ほかの選択肢と同じく改行で終える
      '+ [link storage="chapter2.ks" target="*east"]南の道[endlink][r]',
      '+ [link target="*north"]西の道[endlink][r]',
    ]);
  });

  it("行の最後の {noclick} は [p] を付けずに書き戻し、外したら [p] を付ける", async () => {
    const kept = await backport("tyrano-text-flow", (f) => f.replace("chapter1.lim", "どちらへ行く？{br}{noclick}", "どっちへ行く？{br}{noclick}"));
    ok(kept.report);
    // 問いかけの行末の [r] は取り込みで {br} として残しているので、文を書き換えても [r] が戻る
    expect(kept.changes("chapter1.ks")).toEqual(["- どちらへ行く？[r]", "+ どっちへ行く？[r]"]);
    const removed = await backport("tyrano-text-flow", (f) => f.replace("chapter1.lim", "どちらへ行く？{br}{noclick}", "どちらへ行く？"));
    expect(removed.changes("chapter1.ks")).toEqual(["- どちらへ行く？[r]", "+ どちらへ行く？[p]"]);
  });

  it("[link] の選択肢の if=(式) は [link] の cond", async () => {
    const { report, changes } = await backport("tyrano-text-flow", (f) => {
      f.replace("chapter1.lim", "- 北の道 -> #north", "- 北の道 -> #north if=(game.x == 1)");
    });
    ok(report);
    expect(changes("chapter1.ks")).toEqual(['- [link target="*north"]北の道[endlink][r]', '+ [link target="*north" cond="f.x == 1"]北の道[endlink][r]']);
  });

  it("改行が CRLF の .ks は CRLF のまま書き戻す", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-backport-crlf-"));
    temps.push(tmp);
    cpSync(fixture("backport-project"), join(tmp, "src"), { recursive: true });
    const file = join(tmp, "src/data/scenario/scene1.ks");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    await importTyrano({ source: join(tmp, "src"), scenarioOut: join(tmp, "lim"), dataOut: join(tmp, "data"), castOut: join(tmp, "cast.json"), reportOut: join(tmp, "r.md"), sourceMapOut: join(tmp, "map.json"), registry, profile });
    cpSync(join(tmp, "lim"), join(tmp, "cur"), { recursive: true });
    const cur = join(tmp, "cur/scene1.lim");
    writeFileSync(cur, readFileSync(cur, "utf8").replace("北の道を進んだ。", "北の道を進んだ。\n鳥が鳴いた。\n@wait 100ms").replace("@bg room.jpg time=1s", "@bg street.jpg time=1s"));
    const report = await backportTyrano({ baseKs: join(tmp, "src/data/scenario"), baseLim: join(tmp, "lim"), sourceMap: join(tmp, "map.json"), currentLim: join(tmp, "cur"), source: join(tmp, "src"), out: join(tmp, "out"), registry, profile });
    ok(report);
    const ks = readFileSync(join(tmp, "out/scene1.ks"), "utf8");
    expect(ks.split("\n").slice(0, -1).every((l) => l.endsWith("\r"))).toBe(true);
    expect(ks).toContain("北の道を進んだ。[p]\r\n鳥が鳴いた。[p]\r\n[_tb_end_text]\r\n");
  });

  it("新しい .lim は新しい .ks に、消した .lim は消す候補として報告する", async () => {
    const { report, ks } = await backport("backport-project", (f) => {
      f.write("scene3.lim", ["@bg room.jpg", "", "ユイ「三つめの場面」", "地の文。", "@jump scene1"]);
      f.remove("scene2.lim");
    });
    ok(report);
    expect(report.files.find((x) => x.lim === "scene2.lim")?.status).toBe("deleted");
    expect(report.files.find((x) => x.lim === "scene3.lim")?.status).toBe("new");
    expect(report.markdown).toContain("scene2.lim → scene2.ks");
    // プロジェクトの書き方（TyranoBuilder の囲み・話者の行）で書く
    expect(ks("scene3.ks")).toBe(
      ['[bg  time="0"  method="crossfade"  storage="room.jpg"  ]', "[tb_start_text mode=1 ]", "# ユイ", "「三つめの場面」[p]", "#", "地の文。[p]", "[_tb_end_text]", '[jump  storage="scene1.ks"  target=""  ]', ""].join("\n"),
    );
  });

  it("サブフォルダの .lim は同じフォルダの .ks に書き戻し、新しいサブフォルダの .lim も .ks にする", async () => {
    const { report, ks } = await backport("subfolder-project", (f) => {
      f.replace("part1/chapter2/scene2.lim", "扉を開けて中に入った。", "扉をそっと開けて中に入った。");
      mkdirSync(join(f.root, "part2"), { recursive: true });
      f.write("part2/epilogue.lim", ["それから一年がたった。", "@jump part1/end"]);
    });
    ok(report);
    expect(report.files.find((x) => x.lim === "part1/chapter2/scene2.lim")).toMatchObject({ ks: "part1/chapter2/scene2.ks", status: "changed" });
    expect(report.files.find((x) => x.lim === "part2/epilogue.lim")).toMatchObject({ ks: "part2/epilogue.ks", status: "new" });
    expect(report.written.sort()).toEqual(["part1/chapter2/scene2.ks", "part2/epilogue.ks"]);
    expect(ks("part1/chapter2/scene2.ks")).toContain("扉をそっと開けて中に入った。[p]");
    expect(ks("part2/epilogue.ks")).toContain('[jump storage="part1/end.ks"]');
  });

  it("書き戻せないもの（@define・@script の書き換え）は報告し、確かめで違いとして出る", async () => {
    const { report, ks } = await backport("backport-project", (f) => {
      f.replace("scene2.lim", "tf.count = 1;", "  tf.count = 2;");
      f.after("scene2.lim", "@wait 500ms", ["@define greet(who: string)", "  ユイ「やあ」", "@end"]);
    });
    expect(report.failed).toBeGreaterThan(0);
    expect(report.verified).toBe(false);
    expect(report.markdown).toContain("## 書き戻せなかった箇所");
    // @script は元のまま
    expect(ks("scene2.ks")).toContain("[iscript]\ntf.count = 1;\n[endscript]");
  });

  it("基準を作ったときから取り込みの変換が変わっていれば、報告で知らせる", async () => {
    const { tmp } = await backport("backport-project", () => {});
    const report = await backportTyrano({
      baseKs: join(fixture("backport-project"), "data/scenario"),
      baseLim: join(tmp, "base/lim"),
      sourceMap: join(tmp, "base/import-sourcemap.json"),
      currentLim: join(tmp, "cur"),
      source: fixture("backport-project"),
      out: join(tmp, "out-drift/scenario"),
      registry,
      // [wait] の変換が変わった
      profile: { ...profile, tags: { wait: () => ({ name: "wait", positional: ["1s"], named: [] }) } },
    });
    expect(report.markdown).toContain("取り込みの変換（エンジン・取り込み設定）が変わっている");
    expect(report.markdown).toContain("scene2.lim");
  });

  it("基準が対応表と合わなければ止める", async () => {
    const { tmp } = await backport("backport-project", () => {});
    writeFileSync(join(tmp, "base/lim/scene1.lim"), "変えた\n");
    await expect(
      backportTyrano({
        baseKs: join(fixture("backport-project"), "data/scenario"),
        baseLim: join(tmp, "base/lim"),
        sourceMap: join(tmp, "base/import-sourcemap.json"),
        currentLim: join(tmp, "cur"),
        source: fixture("backport-project"),
        out: join(tmp, "out2/scenario"),
        registry,
        profile,
      }),
    ).rejects.toThrow(/対応表を作ったときの .lim と違います/);
  });
});

describe("lim backport（作品の基準を作って書き戻す）", () => {
  // 取り込みを二度流し、作品の基準を作って（バージョン管理のコマンドを起こす）書き戻す
  it("--make-base で基準を作り、--write は取り込み元が基準のままのファイルだけに書く", { timeout: 60_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-backport-project-"));
    temps.push(tmp);
    const tyrano = join(tmp, "tyrano");
    cpSync(fixture("backport-project"), tyrano, { recursive: true });
    const project = join(tmp, "game");
    mkdirSync(project);
    writeFileSync(join(project, "liminalia.json"), JSON.stringify({ id: "t", title: "t", entry: "scene1", plugins: [] }));
    // 作品の .lim は、取り込んだもの（切り替えの時点）
    await importTyrano({
      source: tyrano,
      scenarioOut: join(project, "scenario"),
      dataOut: join(project, "data"),
      castOut: join(project, "cast.json"),
      reportOut: join(project, "import-report.md"),
      registry,
      profile: {},
    });
    const base = join(project, "tyrano-base");
    const made = await makeBackportBase(project, base, tyrano);
    expect(made.same).toBe(true);
    expect(existsSync(join(base, "ks/scene1.ks"))).toBe(true);
    expect(existsSync(join(base, "import-sourcemap.json"))).toBe(true);

    // .lim を直し、取り込み元の scene2.ks も（切り替えのあとに）直したことにする
    const lim = join(project, "scenario");
    writeFileSync(join(lim, "scene1.lim"), readFileSync(join(lim, "scene1.lim"), "utf8").replace("北の道を進んだ。", "北の道を歩いた。"));
    writeFileSync(join(lim, "scene2.lim"), readFileSync(join(lim, "scene2.lim"), "utf8").replace("どちらも暗い。", "どちらも明るい。"));
    writeFileSync(join(tyrano, "data/scenario/scene2.ks"), readFileSync(join(tyrano, "data/scenario/scene2.ks"), "utf8") + ";あとで足した\n");

    const r = await backportProject(project, { base, write: true });
    expect(r.report.verified).toBe(true);
    expect(r.copied).toEqual(["scene1.ks"]);
    expect(r.refused).toEqual(["scene2.ks"]);
    expect(readFileSync(join(tyrano, "data/scenario/scene1.ks"), "utf8")).toContain("北の道を歩いた。[p]");
    expect(readFileSync(join(tyrano, "data/scenario/scene2.ks"), "utf8")).not.toContain("明るい");
    expect(existsSync(join(project, ".liminalia/backport/backport-report.md"))).toBe(true);
  });
});

describe("書き戻しの道具", () => {
  it("行の差分（Myers）は、たどると元の並びと新しい並びになる", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rand() * 30) }, () => String(Math.floor(rand() * 6)));
      const b = Array.from({ length: Math.floor(rand() * 30) }, () => String(Math.floor(rand() * 6)));
      const ops = diffLines(a, b);
      expect(ops.flatMap((o) => (o.op === "insert" ? [] : [a[o.a]]))).toEqual(a);
      expect(ops.flatMap((o) => (o.op === "delete" ? [] : [b[o.b]]))).toEqual(b);
      for (const o of ops) if (o.op === "equal") expect(a[o.a]).toBe(b[o.b]);
    }
  });

  it("タグの引数の書き換えは、元の区切りと引用符を保つ", () => {
    expect(editTagBody('bg  time="1000"  storage="a.jpg"  ', { storage: "b.jpg", time: null, method: "crossfade" })).toBe('bg  storage="b.jpg"  method="crossfade"  ');
    expect(editTagBody("jump storage=a.ks target=*x", { target: "*y z" })).toBe('jump storage=a.ks target="*y z"');
    expect(editTagBody("cm  ", { time: "1" })).toBe('cm  time="1"  ');
  });

  it("一行の中のタグと地の文の範囲は、字句解析と同じ数に分かれる", () => {
    for (const row of ["「[ruby text=ま]町の入り口」[p]", "a\\[b[r]c[l][p]", '[glink text="a]b"  target=*x][s]', "_  字下げ[p]", "@jump storage=a.ks"]) {
      expect(scanKsLine(row).length, row).toBe(lex(row, "t.ks").commands.length);
    }
  });

  it(".lim の式を TyranoScript の式に戻す", () => {
    expect(jsExpression('game.a == "x" && temp.b > 1')).toBe("f.a == 'x' && tf.b > 1");
    expect(jsExpression("system.read.game.x")).toBe("sf.read.game.x");
    // 書き逃しの要る文字列は "…" にして、タグの引数（"…"）の字句解析に合わせて \ と " を書き逃す
    expect(jsExpression('game.a = "x\\ny"')).toBe('f.a = \\"x\\\\ny"');
    // ' " ` [ ] があって書き逃しも要る文字列は、どの読み方でも壊れない String.fromCodePoint にする
    // （タグの外側の読み取りは書き逃しを知らず、"…" の中の ' や ] でタグがずれる）
    expect(jsExpression('game.a = "it\'s"')).toBe("f.a = String.fromCodePoint(105,116,39,115)");
    expect(jsExpression('game.a = "a\\"b"')).toBe("f.a = String.fromCodePoint(97,34,98)");
    // ' " ` [ ] だけなら '…' で書ける（外側の読み取りでは " の中の字なのでずれない）
    expect(jsExpression('game.a = "x]y"')).toBe("f.a = 'x]y'");
    // 辞書の見出しでは […] にする（裸の呼び出しは見出しに書けない）。値や添字の中はそのまま
    expect(jsExpression('game.d = {"it\'s": 1}')).toBe("f.d = {[String.fromCodePoint(105,116,39,115)]: 1}");
    expect(jsExpression('game.d = {a: "it\'s"}')).toBe("f.d = {a: String.fromCodePoint(105,116,39,115)}");
    expect(jsExpression('game.d["it\'s"]')).toBe("f.d[String.fromCodePoint(105,116,39,115)]");
    // 書いた行をそのまま lex で読み直しても、exp の値と次の行が壊れない
    const emitted = jsExpression('game.a = "it\'s"');
    const { commands, diagnostics } = lex(`[eval exp="${emitted}"]\n本文`, "t.ks");
    expect(diagnostics).toEqual([]);
    expect(commands.find((c) => c.name === "eval")?.pm?.exp).toBe(emitted);
    expect(commands.find((c) => c.name === "text")?.val).toBe("本文");
    // 書き戻した String.fromCodePoint も .lim の式に戻せる（書き戻しの検証・再取り込みが通る）
    expect(convertJsAssignments("f.a = String.fromCodePoint(105,116,39,115)")).toEqual(['@set game.a = "it\'s"']);
    expect(convertJsAssignments("f.d = {[String.fromCodePoint(105,116,39,115)]: 1}")).toEqual(['@set game.d = {"it\'s": 1}']);
    expect(convertJsExpression("f.d[String.fromCodePoint(105,116,39,115)]")).toBe('game.d["it\'s"]');
    // 文字列の中の String.fromCodePoint は呼び出しではないのでそのまま残す
    expect(convertJsAssignments("f.a = 'String.fromCodePoint(65)'")).toEqual(['@set game.a = "String.fromCodePoint(65)"']);
    // 三項演算子の真側の […] は配列（辞書の見出しではない）なので残す
    expect(convertJsAssignments("f.b = f.c ? [String.fromCodePoint(88)] : f.d")).toEqual(['@set game.b = game.c ? ["X"] : game.d']);
    // 添字の文字列に = が入ると .lim の @set が読めないので、変換せず手作業に回す
    expect(convertJsAssignments("f.d[String.fromCodePoint(61)] = 1")).toBeNull();
    // 数字でない引数は解決できない（落ちないで変換できないと分かる）
    expect(convertJsExpression("String.fromCodePoint(f.x)")).toBeNull();
    expect(convertJsAssignments("f.a = String.fromCodePoint(f.x)")).toBeNull();
  });
});
