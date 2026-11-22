import { describe, expect, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { HeadlessHost, Runtime, type SaveData, type TraceEntry } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "../src/commands/index.ts";

/** @notify when=scene-break（場面の切れ目まで待って出す）。待っている間のセーブとロードで消えず、二度も出ない。 */

const { implementations, specs } = combinePlugins([std]);
const registry = createRegistry([...CORE_COMMANDS, ...specs]);

/** 本文と通知の並び（"本文" か "!通知の文"）。 */
const order = (trace: readonly TraceEntry[]) =>
  trace.flatMap((e) => (e.type === "page" ? [e.text] : e.type === "command" && e.name === "notify" ? [`!${String(e.args.text)}`] : e.type === "choice" ? ["?"] : []));

/** files を流す。saveAt 回目のクリック待ちでセーブを取る。 */
async function play(files: Record<string, string>, o: { saveAt?: number; choices?: number[]; load?: SaveData } = {}) {
  const host = new HeadlessHost({ loadSource: async (f) => files[f] ?? "", ...(o.choices ? { choices: o.choices } : {}) });
  const runtime = new Runtime(host, { commands: implementations });
  let clicks = 0;
  let saved: SaveData | null = null;
  host.waitClick = async () => {
    if (++clicks === o.saveAt) saved = JSON.parse(JSON.stringify(runtime.save())) as SaveData;
  };
  const result = o.load ? await runtime.load(o.load) : await runtime.start("a");
  return { trace: order(host.trace), result, saved: saved as SaveData | null, stage: runtime.state.stage };
}

describe("@notify when=scene-break", () => {
  it("場面の切れ目を過ぎた次の本文の前に出す（すぐ出すものはそのまま）", async () => {
    const { trace, stage } = await play({ a: "@notify 今 \n@notify 後で when=scene-break\n一\n二\n@scene-change\n三\n四" });
    expect(trace).toEqual(["!今", "一", "二", "!後で", "三", "四"]);
    expect(stage.sceneWait).toBeUndefined();
  });

  it("切れ目: 別の絵への @bg、@mask、@jump と選択肢でほかのファイルへ。同じ絵の @bg と @call は切れ目にしない", async () => {
    const bg = await play({ a: "@bg room.png\n@notify A when=scene-break\n一\n@bg room.png\n二\n@bg street.png\n三" });
    expect(bg.trace).toEqual(["一", "二", "!A", "三"]);
    const mask = await play({ a: "@notify A when=scene-break\n一\n@mask\n@mask-off\n二" });
    expect(mask.trace).toEqual(["一", "!A", "二"]);
    const files = { a: "@notify A when=scene-break\n一\n@call c\n二\n@jump b", b: "三", c: "呼んだ先\n@return" };
    expect((await play(files)).trace).toEqual(["一", "呼んだ先", "二", "!A", "三"]);
    const choice = await play({ a: "@notify A when=scene-break\n一\n@choice\n- 同じファイル -> #x\n- ほか -> b\n@end\n# x\nここ\n@choice\n- ほか -> b\n@end", b: "三" }, { choices: [0, 0] });
    expect(choice.trace).toEqual(["一", "?", "ここ", "?", "!A", "三"]);
  });

  it("切れ目のあとに待たせたものは、次の切れ目まで待つ", async () => {
    const { trace } = await play({ a: "@notify A when=scene-break\n一\n@jump b", b: "@notify B when=scene-break\n二\n@scene-change\n三" });
    expect(trace).toEqual(["一", "!A", "二", "!B", "三"]);
  });

  it("切れ目の後が選択肢なら、選択肢の前に出す", async () => {
    const { trace } = await play({ a: "@notify A when=scene-break\n一\n@scene-change\n@choice\n- 行く -> #x\n@end\n# x\n二" });
    expect(trace).toEqual(["一", "!A", "?", "二"]);
  });

  it("待っている間にセーブしてロードしても消えず、切れ目で一度だけ出す", async () => {
    const files = { a: "@notify A when=scene-break\n一\n二\n@scene-change\n三\n四" };
    // 二のページでセーブ（まだ待っている）
    const first = await play(files, { saveAt: 2 });
    expect(first.saved!.stage.sceneWait?.commands.map((c) => c.args.text)).toEqual(["A"]);
    const loaded = await play(files, { load: first.saved! });
    expect(loaded.trace).toEqual(["二", "!A", "三", "四"]);
  });

  it("出したあとのページでセーブしてロードしても、もう出さない", async () => {
    const files = { a: "@notify A when=scene-break\n一\n@scene-change\n三\n四" };
    const first = await play(files, { saveAt: 2 });
    expect(first.trace).toEqual(["一", "!A", "三", "四"]);
    expect(first.saved!.stage.sceneWait).toBeUndefined();
    const loaded = await play(files, { load: first.saved! });
    expect(loaded.trace).toEqual(["三", "四"]);
  });

  it("引数の型は検査が知っている", () => {
    const codes = (src: string) => check(parse(src, "a.lim"), { registry }).filter((d) => d.severity === "error").map((d) => d.code);
    expect(codes("@notify 手帳に新しい頁が加わった when=scene-break")).toEqual([]);
    expect(codes("@notify 手帳に新しい頁が加わった when=later")).toEqual(["bad-value"]);
  });
});
