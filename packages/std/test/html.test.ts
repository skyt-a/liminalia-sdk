import { describe, expect, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { HeadlessHost, Runtime, type PresentEvent, type SaveData, type Value } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std, { htmlState as H, imageState as S } from "../src/commands/index.ts";

const { implementations, specs } = combinePlugins([std]);
const registry = createRegistry(CORE_COMMANDS, specs);

const pages = (host: HeadlessHost) => host.trace.flatMap((t) => (t.type === "page" ? [t.text] : []));

/** @html wait=true に答える描画側（answer が返す飛び先を押したことにする。null なら答えない＝画面なし）。 */
class Clicker extends HeadlessHost {
  readonly shown: Record<string, Value>[] = [];
  constructor(source: string, private readonly answer: (args: Record<string, Value>) => Promise<Value | void> | Value | void) {
    super({ loadSource: async () => source });
  }
  override async present(event: PresentEvent) {
    await super.present(event);
    if (event.type === "command" && event.name === "html") {
      this.shown.push(event.args);
      if (event.wait) return this.answer(event.args);
    }
  }
}

const SOURCE = [
  "@set game.day = 3",
  "@html card x=100 y=80 width=600 wait=true",
  '<div class="card">今日は {= game.day} 日目 {= "<b>"}</div>',
  '<button data-jump="#market">市場へ</button>',
  '<button data-jump="#home">家へ</button>',
  "@end",
  "通り過ぎた。",
  "# market",
  "市場に着いた。",
  "# home",
  "家に着いた。",
].join("\n");

describe("@html", () => {
  it("式を評価し、評価し終えた HTML を前景レイヤーの項目として持つ（値は HTML として読まれない文字にする）", async () => {
    const host = new Clicker(SOURCE, () => "#home");
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("a");
    const items = S.readExtra(runtime.state.stage.extra, "images")?.fg2 as unknown as H.HtmlItem[];
    expect(items).toEqual([
      {
        kind: "html",
        name: "card",
        html: '<div class="card">今日は 3 日目 &lt;b&gt;</div>\n<button data-jump="#market">市場へ</button>\n<button data-jump="#home">家へ</button>',
        x: 100,
        y: 80,
        width: 600,
        height: null,
      },
    ]);
    expect(host.shown[0]!.html).toBe(items[0]!.html);
  });

  it("wait=true は押した data-jump へ飛ぶ（選択肢と同じ）", async () => {
    const host = new Clicker(SOURCE, () => "#home");
    await new Runtime(host, { commands: implementations }).start("a");
    expect(pages(host)).toEqual(["家に着いた。"]);
  });

  it("画面なしで流すときは data-jump の要素を選択肢として選ばせる", async () => {
    const host = new HeadlessHost({ loadSource: async () => SOURCE, choices: [0] });
    await new Runtime(host, { commands: implementations }).start("a");
    expect(host.trace.filter((t) => t.type === "choice").map((t) => t.type === "choice" && t.options)).toEqual([["市場へ", "家へ"]]);
    expect(pages(host)).toEqual(["市場に着いた。", "家に着いた。"]);
  });

  it("wait=false は表示だけで次へ進む", async () => {
    const host = new Clicker(SOURCE.replace(" wait=true", ""), () => "#home");
    await new Runtime(host, { commands: implementations }).start("a");
    expect(pages(host)[0]).toBe("通り過ぎた。");
  });

  it("@html-hide は名前のものだけ、名前を省くとすべて消す。同じ名前の @html は置き換える", async () => {
    const run = async (src: string) => {
      const host = new HeadlessHost({ loadSource: async () => src });
      const runtime = new Runtime(host, { commands: implementations });
      await runtime.start("a");
      return (Object.values(S.readExtra(runtime.state.stage.extra, "images") ?? {}).flat() as unknown as H.HtmlItem[]).map((i) => `${i.name}:${i.html}`);
    };
    const three = "@html a\n<p>1</p>\n@end\n@html b layer=fg1\n<p>2</p>\n@end\n@html a\n<p>3</p>\n@end\n";
    expect(await run(`${three}本文`)).toEqual(["b:<p>2</p>", "a:<p>3</p>"]);
    expect(await run(`${three}@html-hide a\n本文`)).toEqual(["b:<p>2</p>"]);
    expect(await run(`${three}@html-hide\n本文`)).toEqual([]);
  });

  it("押すのを待っている間のセーブは、同じ表示に戻ってこの @html から再開する", async () => {
    let saved: SaveData | null = null;
    let runtime: Runtime;
    const first = new Clicker(SOURCE, () => {
      saved = runtime.save();
      return "#market";
    });
    runtime = new Runtime(first, { commands: implementations });
    await runtime.start("a");
    expect(S.readExtra(saved!.stage.extra, "images")?.fg2).toHaveLength(1);

    const second = new Clicker(SOURCE, () => "#home");
    const loaded = new Runtime(second, { commands: implementations });
    await loaded.load(saved!);
    // 項目は一つのまま（置き直しても増えない）、もう一度押すのを待ち、押した先へ飛ぶ
    expect(second.shown).toHaveLength(1);
    expect(S.readExtra(loaded.state.stage.extra, "images")?.fg2).toHaveLength(1);
    expect(pages(second)).toEqual(["家に着いた。"]);
  });

  it("命令の例は検査を通る", () => {
    for (const name of ["html", "html-hide"]) {
      const spec = registry.get(name)!;
      const src = `${spec.example}\n# market\n市場。\n`;
      // @html の例は data-jump のボタンを持つので wait=true を書く（書かないと html-jump-without-wait の警告になる）
      expect([name, check(parse(src, "t.lim"), { registry }).map((d) => d.code)]).toEqual([name, []]);
    }
  });
});
