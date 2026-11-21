import { describe, expect, it } from "vitest";
import type { Host, PresentEvent } from "../src/host.ts";
import { HeadlessHost, Runtime, type CommandImpl, type Value } from "../src/index.ts";

/**
 * 自動確認（Host.automated）での命令の autoplay。描画側の画面を待つ命令は、自動確認のときだけ描かせずに autoplay の答えで進む。
 * 答えが無ければ ctx.pick がふつうの選択肢にして選ぶ（lim playtest と全ルートテストが選び方を変えられる）。
 */

const SRC = `@door
@jump #end
# left
左の扉。
@jump #end
# right
右の扉。
# end
おわり。
`;

/** 扉を選ぶ画面の命令（描画側は押された扉の名前を返す。答えが無ければ ctx.pick で選ぶ）。 */
const door = (autoplay?: CommandImpl["autoplay"]): CommandImpl => ({
  spec: { name: "door", summary: "扉を選ぶ", positional: [], params: {}, example: "@door", waits: true },
  run: async (args, ctx) => {
    const answer = await ctx.present(args, true);
    const outcomes = [
      { label: "左", target: "a#left", value: "left" },
      { label: "右", target: "a#right", value: "right" },
    ];
    const picked = await ctx.pick(outcomes, answer === "left" || answer === "right" ? answer : null);
    if (picked) await ctx.runtime.jump(`#${picked}`);
  },
  ...(autoplay ? { autoplay } : {}),
});

/** 画面のある描画側の代わり。扉の命令には answer を返し、選択肢は 0 番を選ぶ。 */
class ScreenHost implements Host {
  readonly events: PresentEvent[] = [];
  readonly texts: string[] = [];
  choices = 0;
  constructor(
    readonly automated: boolean,
    private readonly answer: Value,
  ) {}
  loadSource = async () => SRC;
  async present(event: PresentEvent): Promise<Value | void> {
    this.events.push(event);
    if (event.type === "text") this.texts.push(event.text);
    if (event.type === "command" && event.name === "door" && !event.autoplay) return this.answer;
  }
  async waitClick(): Promise<void> {}
  async choose(): Promise<number | null> {
    this.choices++;
    return 0;
  }
}

describe("自動確認の命令の autoplay", () => {
  it("遊ぶ人の画面では描画側の答えで進み、autoplay は呼ばない", async () => {
    const host = new ScreenHost(false, "right");
    let called = 0;
    await new Runtime(host, { commands: [door(() => void called++)] }).start("a");
    expect(host.texts.join("")).toContain("右の扉");
    expect(called).toBe(0);
    expect(host.choices).toBe(0);
  });

  it("自動確認では描かせずに（autoplay の印を付けて知らせるだけ）、答えが無ければ ctx.pick の選択肢で選ぶ", async () => {
    const host = new ScreenHost(true, "right");
    await new Runtime(host, { commands: [door(() => undefined)] }).start("a");
    const command = host.events.find((e) => e.type === "command" && e.name === "door");
    expect(command).toMatchObject({ autoplay: true });
    expect(host.choices).toBe(1);
    expect(host.texts.join("")).toContain("左の扉");
  });

  it("自動確認でなければ、autoplay を持つ命令に操作待ちの画面の印（interactive）を付けて描かせ、持たない命令には付けない", async () => {
    const host = new ScreenHost(false, "right");
    await new Runtime(host, { commands: [door(() => undefined)] }).start("a");
    expect(host.events.find((e) => e.type === "command" && e.name === "door")).toMatchObject({ interactive: true });
    const plain = new ScreenHost(false, "right");
    await new Runtime(plain, { commands: [door()] }).start("a");
    expect(plain.events.find((e) => e.type === "command" && e.name === "door")).not.toHaveProperty("interactive");
  });

  it("自動確認かどうかは命令ごとに読み直す（lim shot は撮る所に着いたら外して、その画面を描かせる）", async () => {
    const src = "@door\n# left\n左。\n@door\n# right\n右。\n";
    const events: PresentEvent[] = [];
    let automated = true;
    const host: Host = {
      get automated() {
        return automated;
      },
      loadSource: async () => src,
      present: async (e) => {
        events.push(e);
        if (e.type === "text") automated = false;
        if (e.type === "command" && e.name === "door" && !e.autoplay) return "right";
      },
      waitClick: async () => {},
      choose: async () => 0,
    };
    await new Runtime(host, { commands: [door(() => undefined)] }).start("a");
    expect(events.flatMap((e) => (e.type === "command" && e.name === "door" ? [[e.autoplay ?? false, e.interactive ?? false]] : []))).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("autoplay が答えを返せば、それを描画側の答えの代わりにする", async () => {
    const host = new ScreenHost(true, "left");
    await new Runtime(host, { commands: [door((args) => (args.name === undefined ? "right" : "left"))] }).start("a");
    expect(host.choices).toBe(0);
    expect(host.texts.join("")).toContain("右の扉");
  });

  it("autoplay の無い命令は、自動確認でも描画側へ描かせる", async () => {
    const host = new ScreenHost(true, "right");
    await new Runtime(host, { commands: [door()] }).start("a");
    expect(host.events.find((e) => e.type === "command" && e.name === "door")).not.toHaveProperty("autoplay");
    expect(host.texts.join("")).toContain("右の扉");
  });

  it("画面なしで流す（全ルートテスト・lim trace）ときも autoplay を使い、記録には命令を残す", async () => {
    const host = new HeadlessHost({ loadSource: async () => SRC, choices: [1] });
    expect(host.automated).toBe(true);
    await new Runtime(host, { commands: [door(() => undefined)] }).start("a");
    expect(host.trace.some((t) => t.type === "command" && t.name === "door")).toBe(true);
    expect(host.trace.some((t) => t.type === "page" && t.text.includes("右の扉"))).toBe(true);
  });

  it("組み込みの @text-input と @dialog も、自動確認では描かせずに画面なしと同じ答え（initial、OK）で進む", async () => {
    const src = '@text-input game.name initial="ユイ"\n@dialog "続けますか" type=confirm target=#yes\nいいえ。\n# yes\n名前は{= game.name}。\n';
    const events: PresentEvent[] = [];
    const host: Host = {
      automated: true,
      loadSource: async () => src,
      present: async (e) => {
        events.push(e);
        if (e.type === "command" && !e.autoplay) return false;
      },
      waitClick: async () => {},
      choose: async () => 0,
    };
    const rt = new Runtime(host, {});
    await rt.start("a");
    expect(rt.state.game.name).toBe("ユイ");
    expect(events.flatMap((e) => (e.type === "command" && e.name !== "window" ? [[e.name, e.autoplay]] : []))).toEqual([
      ["text-input", true],
      ["dialog", true],
    ]);
    expect(events.some((e) => e.type === "text" && e.text.includes("名前は"))).toBe(true);
  });
});
