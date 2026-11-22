import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProject, CORE_COMMANDS, createRegistry, parse, type Script } from "@liminalia/lang";
import { HeadlessHost, Runtime, type TraceEntry } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { importTyrano, type ImportReport } from "../src/node.ts";

/**
 * 合成の TyranoScript プロジェクト（fixtures/tyrano-text-flow）を取り込み、
 * マクロ（system/ 下とプラグインの init.ks）・本文の書き方・選択肢・入力・一時的な寄り道を通して確かめる。
 */
const plugins = combinePlugins([std]);
const registry = createRegistry(CORE_COMMANDS, plugins.specs);

describe("本文の流れの取り込み（fixtures/tyrano-text-flow）", () => {
  let out = "";
  let report: ImportReport;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "liminalia-text-flow-"));
    report = await importTyrano({
      source: join(import.meta.dirname, "fixtures", "tyrano-text-flow"),
      scenarioOut: join(out, "scenario"),
      dataOut: join(out, "data"),
      castOut: join(out, "cast.json"),
      reportOut: join(out, "import-report.md"),
      registry,
    });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const read = (file: string) => readFileSync(join(out, "scenario", `${file}.lim`), "utf8");
  const speakers = () => (JSON.parse(readFileSync(join(out, "cast.json"), "utf8")) as { speakers: string[] }).speakers;

  it("未対応が 0 で、手作業はプラグインの JS だけ。本文は一字一句同じ", () => {
    expect(report.totals.generic).toBe(0);
    expect(report.manual.map((m) => m.replace(/\] .*$/, "]"))).toEqual(["first.ks:3 [plugin-js]"]);
    expect(report.syntaxErrors).toEqual([]);
    expect(report.checkErrors).toEqual([]);
    expect(report.fidelity.filter((f) => f.mismatch !== null)).toEqual([]);
    expect(report.fidelity.map((f) => f.file)).toEqual(["macros.lim（マクロ）", "chapter1.ks", "chapter2.ks", "extra.ks", "first.ks"]);
    expect(report.library).toBe("macros");
    expect(report.macros).toBe(5);
    expect([...report.unsupported]).toEqual([]);
  });

  it("マクロは型の付いた引数を持つ @define になり、system/ とプラグインのものも一つのファイルに集まる", () => {
    expect(read("macros")).toContain("@define pause-beat(time: duration = 400ms)\n  @wait (time)\n@end");
    // * で渡す引数は、呼び出し側が渡している名前
    expect(read("macros")).toContain('@define scene-bg(storage: string = "")\n  @bg (storage) time=600ms\n@end');
    expect(read("macros")).toContain('@define mood-line(mood: string = "", name: string = "")\n  @if mood == "happy"\n    ユイ「{= name}、おはよう」');
    // 標準の命令 @flash と重なるマクロは、名前に -macro を付ける
    expect(read("macros")).toContain("@define flash-macro(color: color = #ffffff, time: duration = 200ms)\n  @mask color=(color) time=(time)\n  @mask-off time=(time)\n@end");
  });

  it("本文の書き方・選択肢・入力・寄り道", () => {
    expect(read("chapter1")).toBe(
      [
        "@use macros",
        "",
        "# start",
        "@scene-bg storage=room.jpg",
        "@bgm theme.ogg",
        "ユイ「おはよう。今日は{r 早|はや}いのね」",
        "窓の外では、{c #3366cc 雨}が上がりかけていた。",
        "@mood-line name=レン mood=happy",
        "@pause-beat time=300ms",
        "@narrate text=時計の針が進む。",
        "@flash-macro",
        "レン「{b {size 32 大事な}}話がある」{click}{br}「{mark #ffff66 今日}のうちに」",
        "{speed 0ms 一気に出る文。}ゆっくり出る文。",
        "名前を入れてください。",
        "@text-input game.name initial=ハル max=8",
        "@jump #named",
        "",
        "# named",
        "@clear",
        "{= game.name}、と呼ぶことにした。",
        "どちらへ行く？{br}{noclick}",
        "",
        "@choice",
        "  - 北の道 -> #north",
        "  - 南の道 -> chapter2#south",
        "@end",
        "",
        "# north",
        "",
        "@choice",
        "  - -> #rest image=button/rest.png hover=button/rest_on.png x=100 y=200",
        "  - -> #door x=600 y=300 width=200 height=120",
        "@end",
        "",
        "# rest",
        "@sleep-game extra#gallery",
        "休んだあとで、扉を開けた。",
        "",
        "# door",
        "@pause-bgm",
        "@bgm-volume 50 time=500ms",
        "@resume-bgm",
        "@dialog 先へ進みますか？ type=confirm target=#go cancel-target=#go",
        "",
        "# go",
        "@if !(game.skip_tutorial)",
        "  説明はここまで。",
        "@end",
        "@jump chapter2",
        "",
      ].join("\n"),
    );
    expect(read("first")).toBe("@window-title テキストの流れ\n@jump chapter1\n@stop\n");
  });

  it("JS の入っていない [html] 〜 [endhtml] は @html になる（left・top は x・y）", () => {
    expect(read("chapter2")).toContain('@html x=100 y=100\n<div class="note">メモ</div>\n@end\n');
  });

  it("書き出した .lim はプロジェクト全体の検査を通る", () => {
    const files = readdirSync(join(out, "scenario")).map((f) => basename(f, ".lim"));
    const scripts = new Map<string, Script>(files.map((f) => [f, parse(read(f), f, { speakers: speakers() })]));
    expect(checkProject(scripts, { registry }).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("取り込んだものを画面なしで最後まで流せる（マクロ・入力・寄り道・巻き戻し）", async () => {
    const host = new HeadlessHost({ loadSource: async (f) => read(f) });
    const runtime = new Runtime(host, { speakers: speakers(), commands: plugins.implementations });
    const result = await runtime.start("first");
    expect(result.reason).toBe("end");
    const pages = host.trace.flatMap((t: TraceEntry) => (t.type === "page" ? [`${t.speaker ?? ""}:${t.text}`] : []));
    expect(pages).toEqual([
      "ユイ:「おはよう。今日は早いのね」",
      ":窓の外では、雨が上がりかけていた。",
      "ユイ:「レン、おはよう」",
      ":時計の針が進む。",
      "レン:「大事な話がある」\n「今日のうちに」",
      ":一気に出る文。ゆっくり出る文。",
      ":名前を入れてください。",
      ":ハル、と呼ぶことにした。",
      ":どちらへ行く？\n",
      // 北の道 → 画像のボタン（休む）→ 鑑賞の部屋へ寄り道して戻る
      ":ここは鑑賞の部屋。",
      ":休んだあとで、扉を開けた。",
      ":説明はここまで。",
      // @checkpoint へ一度巻き戻す
      "ユイ:「ここからが本番」",
      "ユイ:「ここからが本番」",
      ":記録しない文。",
      ":終わり。",
    ]);
    expect(host.trace.filter((t) => t.type === "diagnostic")).toEqual([]);
    expect(host.trace.filter((t) => t.type === "choice").map((t) => t.type === "choice" && t.options)).toEqual([
      ["北の道", "南の道"],
      ["button/rest.png", ""],
    ]);
    expect(runtime.state.game).toEqual({ name: "ハル", retry: 1, skip_tutorial: null });
    expect(runtime.state.sleep).toBeNull();
    expect(runtime.state.stage.ui).toEqual({ menuButton: true, shortcuts: true, backlog: true });
  });
});
