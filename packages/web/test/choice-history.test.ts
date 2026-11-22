import { describe, expect, it } from "vitest";
import { HeadlessHost, type PresentEvent, Runtime } from "@liminalia/runtime";
import { ChoiceHistory, findChoiceAhead, unreadAhead } from "../src/system/choice-history.ts";

/** 位置とセーブだけを持つ実行器のまね。 */
const at = (unit: string, index: number) => ({ state: { position: { unit, index } }, save: () => ({ unit, index }) }) as unknown as Runtime;

describe("前の選択肢へ（ChoiceHistory）", () => {
  it("出した選択肢を控え、同じ選択肢を出し直したときは控えない。上限を超えたら古いものを捨てる", () => {
    const h = new ChoiceHistory(3);
    h.remember(at("a", 3), 2);
    h.remember(at("a", 3), 2);
    h.remember(at("a", 9), 5);
    expect(h.points.map((p) => p.at)).toEqual(["a:3", "a:9"]);
    h.remember(at("b", 1), 8);
    h.remember(at("b", 4), 9);
    expect(h.points.map((p) => p.at)).toEqual(["a:9", "b:1", "b:4"]);
  });

  it("戻り先は最後の選択肢（選んでいる最中ならその一つ前）と、それより前の控え", () => {
    const h = new ChoiceHistory();
    h.remember(at("a", 3), 2);
    h.remember(at("a", 9), 5);
    expect(h.previous(false)).toMatchObject({ point: { at: "a:9" }, before: [{ at: "a:3" }] });
    expect(h.previous(true)).toMatchObject({ point: { at: "a:3" }, before: [] });
    h.replace(h.previous(true)!.before);
    expect(h.previous(false)).toBeNull();
  });

  it("セーブに入れる分は新しいものから、履歴の件数は入れない分を引いて数え直す。形の崩れたものは戻さない", () => {
    const h = new ChoiceHistory();
    h.remember(at("a", 3), 2);
    h.remember(at("a", 9), 5);
    h.remember(at("a", 12), 7);
    expect(h.forSave(4, 2).map((p) => [p.at, p.log])).toEqual([
      ["a:9", 1],
      ["a:12", 3],
    ]);
    h.replace([{ save: {}, log: 1, at: "a:1" }, { log: 2 }, null]);
    expect(h.points.map((p) => p.at)).toEqual(["a:1"]);
  });
});

describe("次の選択肢へ（findChoiceAhead）", () => {
  // @guard: 作品のデータ（ctx.data）を読み、読めなければ流れを止める（調べる画面のように、データで中身を決める命令）
  const guard = {
    spec: { name: "guard", summary: "", positional: [], params: {}, example: "@guard" },
    run: async (_a: unknown, ctx: { data(name: string): Promise<unknown>; runtime: Runtime }) => {
      if (!(await ctx.data("spots"))) ctx.runtime.stop();
    },
  };
  const source = "はじめ\n@guard\nつぎ\n@choice\n  - 右 -> #r\n  - 左 -> #l\n@end\n# r\n右へ\n# l\n左へ";
  const spots = (name: string) => (name === "spots.json" ? { a: 1 } : undefined);
  /** loadData は先流しに渡すもの、live は遊んでいる実行器を作ったときに渡すもの。 */
  const ahead = async (loadData?: (name: string) => unknown, live?: (name: string) => unknown) => {
    // 先頭のページで止めた実行（遊んでいる途中の位置）から探す
    let stopped = false;
    const host = new HeadlessHost({ loadSource: async () => source });
    const runtime = new Runtime(host, { commands: [guard as never], ...(live ? { loadData: live } : {}) });
    const present = host.present.bind(host);
    host.present = async (event: PresentEvent) => {
      const r = await present(event);
      if (event.type === "page" && !stopped) {
        stopped = true;
        runtime.stop();
      }
      return r;
    };
    await runtime.start("a");
    return findChoiceAhead({ runtime, loadSource: async () => source, ...(loadData ? { loadData } : {}) });
  };

  it("データを読む命令を挟んでも、作品のデータを渡せば先の選択肢を見つける", async () => {
    const jump = await ahead(spots);
    expect(jump?.kind).toBe("choice");
  });

  it("渡さなければ、遊んでいる実行器を作ったときのデータの読み方を使う", async () => {
    expect((await ahead(undefined, spots))?.kind).toBe("choice");
  });

  it("どちらにも無ければ、データを読む命令で流れが止まり、見つからない", async () => {
    expect(await ahead()).toBeNull();
  });
});

describe("先へ流すときの今のページ（findChoiceAhead、unreadAhead）", () => {
  const source = "一。\n@wait 100ms\n二。\n三。\n@choice\n  - 甲 -> #e\n@end\n# e\n終わり。";
  /** 遊んでいる途中の実行器。page なら一。のクリック待ち、wait なら一。のあとの @wait の途中で止まったまま待たせる。 */
  const playing = async (where: "page" | "wait") => {
    const host = new HeadlessHost({ loadSource: async () => source });
    let reached!: () => void;
    const there = new Promise<void>((r) => (reached = r));
    const never = new Promise<never>(() => undefined);
    if (where === "page") {
      host.waitClick = () => {
        reached();
        return never;
      };
    } else {
      const present = host.present.bind(host);
      host.present = async (event: PresentEvent) => {
        if (event.type === "command" && event.name === "wait") {
          reached();
          return never;
        }
        return present(event);
      };
    }
    const runtime = new Runtime(host);
    void runtime.start("a");
    await there;
    return runtime;
  };
  const pagesSeen = async (where: "page" | "wait", isRead?: (at: { line: number }) => boolean) => {
    const runtime = await playing(where);
    const pages: number[] = [];
    const jump = await findChoiceAhead({
      runtime,
      loadSource: async () => source,
      present: (event) => {
        if (event.type === "page") pages.push(event.at.line);
      },
      ...(isRead ? { isRead } : {}),
    });
    runtime.dispose();
    return { pages, kind: jump?.kind };
  };

  it("ページのクリック待ちから流すと、そのページを出し直す分は渡さない", async () => {
    expect(await pagesSeen("page")).toEqual({ pages: [3, 4], kind: "choice" });
  });

  it("ページの後の @wait の途中から流すと、最初のページは次のページなので渡し、未読も数える", async () => {
    expect(await pagesSeen("wait")).toEqual({ pages: [3, 4], kind: "choice" });
    expect(await pagesSeen("wait", (at) => at.line !== 3)).toEqual({ pages: [3], kind: "unread" });
    const runtime = await playing("wait");
    expect(await unreadAhead({ runtime, loadSource: async () => source, isRead: (at) => at.line !== 3 })).toBe("unread");
    runtime.dispose();
  });

  it("ページのクリック待ちから流すと、今のページは未読でも数えない", async () => {
    const runtime = await playing("page");
    expect(await unreadAhead({ runtime, loadSource: async () => source, isRead: (at) => at.line !== 1 })).toBe("choice");
    runtime.dispose();
  });
});
