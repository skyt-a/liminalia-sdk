import { describe, expect, it } from "vitest";
import { check, parse } from "@liminalia/lang";
import { HeadlessHost, Runtime, type TraceEntry } from "../src/index.ts";

/**
 * 条件の式が誤りになったとき（初期値の無い変数を数と比べたなど）。どの条件でも誤りを知らせて偽として進み、真の枝へ黙って入らない。
 * 実行を止める設定（onError: "stop"）でなければ、その先へ進む（書き出したゲームと全ルートテストは止めない）。
 */
function run(src: string, choices: number[] = []) {
  const host = new HeadlessHost({ loadSource: async () => src, choices, whenChoicesRunOut: "first" });
  const runtime = new Runtime(host, { onError: "continue" });
  return { host, done: runtime.start("a") };
}

const pages = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "page" ? [t.text] : []));
const errors = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "diagnostic" ? [`${t.diagnostic.code} ${t.diagnostic.line} ${t.diagnostic.message}`] : []));
const shown = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "choice" ? [t.options] : []));

describe("条件の式の誤り", () => {
  it("@if の式が誤りなら偽として @else へ進み、誤りを知らせる", async () => {
    const { host, done } = run("@if game.n >= 2\n真の枝\n@else\n偽の枝\n@end\nその後");
    await done;
    expect(pages(host.trace)).toEqual(["偽の枝", "その後"]);
    expect(errors(host.trace)).toEqual(["runtime 1 条件の式を計算できないため、偽として扱いました（>= は同じ型の数値か文字列にだけ使えます（null >= 数値 2））"]);
  });

  it("@elif の式が誤りなら次の枝へ進む（else が無ければ @end の後へ）", async () => {
    const { host, done } = run("@set game.a = 0\n@if game.a == 1\nA\n@elif game.n > 0\nB\n@elif game.a == 0\nC\n@end\n@if game.n < 0\nD\n@end\nE");
    await done;
    expect(pages(host.trace)).toEqual(["C", "E"]);
    expect(errors(host.trace).map((e) => e.split(" ").slice(0, 2).join(" "))).toEqual(["runtime 4", "runtime 9"]);
  });

  it("@while の式が誤りなら一度も回さない（@for も同じ）", async () => {
    const { host, done } = run("@while game.n < 3\n回った\n@set game.n += 1\n@end\n@for x in game.list\n{= x}\n@end\n終わり");
    await done;
    expect(pages(host.trace)).toEqual(["終わり"]);
    expect(errors(host.trace).length).toBeGreaterThanOrEqual(2);
  });

  it("行の if=(式) が誤りなら、その行を飛ばす", async () => {
    const { host, done } = run("@jump #good if=(game.n >= 2)\n飛ばなかった\n@jump #end\n# good\n飛んだ\n# end");
    await done;
    expect(pages(host.trace)).toEqual(["飛ばなかった"]);
    expect(errors(host.trace)[0]).toMatch(/^runtime 1 条件の式を計算できないため/);
  });

  it("選択肢の if= が誤りならその選択肢を出さず、locked= と call= は偽にする", async () => {
    const src = ["@choice", "- 隠す -> #a if=(game.n > 0)", "- 押せる -> #b locked=(game.n > 0)", "- 呼ばない -> #c call=(game.n > 0)", "@end", "# a", "A", "# b", "B", "# c", "C"].join("\n");
    const { host, done } = run(src, [1]);
    expect(await done).toMatchObject({ reason: "end" });
    expect(shown(host.trace)).toEqual([["押せる", "呼ばない"]]);
    expect(pages(host.trace)).toEqual(["C"]);
    expect(errors(host.trace).map((e) => e.split(" ").slice(0, 2).join(" "))).toEqual(["runtime 2", "runtime 3", "runtime 4"]);
  });

  it("+= はまだ値の無い変数を 0 として計算する（比べる式は 0 とみなさない）", async () => {
    const { host, done } = run("@set game.n += 1\n@if game.n >= 1\n足した\n@end");
    await done;
    expect(pages(host.trace)).toEqual(["足した"]);
    expect(errors(host.trace)).toEqual([]);
  });
});

describe("実行時に知らせる構文チェックの診断", () => {
  it("書き方の提案（立ち絵のちらつき）は、読み込んだファイルの診断として知らせない。構文の誤りは知らせる", async () => {
    const reshow = ["@chara ユイ normal", "ユイ「a」", "@chara-hide ユイ", "@chara ユイ smile", "ユイ「b」"].join("\n");
    // 構文チェックは知らせる
    expect(check(parse(reshow, "a", { speakers: ["ユイ"] })).map((d) => d.code)).toContain("chara-reshow");
    const host = new HeadlessHost({ loadSource: async (f) => (f === "a" ? reshow : "@jump #nowhere") });
    const runtime = new Runtime(host, { onError: "continue", speakers: ["ユイ"] });
    await runtime.start("a");
    await runtime.start("b");
    const codes = host.trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.code] : []));
    expect(codes).not.toContain("chara-reshow");
    expect(codes).toContain("unknown-label");
  });

  it("前の名前の fade=（renamed-param）は、time= として動くので知らせない（2026-11-19 の O1）", async () => {
    const source = "@chara-hide-all fade=1s\n　本文。\n";
    expect(check(parse(source, "a")).map((d) => d.code)).toContain("renamed-param");
    const host = new HeadlessHost({ loadSource: async () => source });
    await new Runtime(host, { onError: "continue" }).start("a");
    expect(host.trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.code] : []))).toEqual([]);
  });
});
