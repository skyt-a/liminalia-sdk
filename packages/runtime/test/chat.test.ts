import { describe, expect, it } from "vitest";
import { chatQuoteStripper, findRoute, readChat, Runtime, type ChatDialogue, type Host, type PresentEvent, type SaveData, type Value } from "../src/index.ts";

/** ふだんの台詞をチャットの列に積む（options.chatDialogue）。描くのは std だが、積むのは実行器なので、画面なしでも同じ列になる。 */

const speakers = ["ユイ", "ソウ"];

/** 最後まで流して、舞台の状態と描画側へ送ったものを返す。選択肢は pick 番目を選ぶ。 */
async function play(source: string, chatDialogue: ChatDialogue | undefined, pick = 0) {
  const events: PresentEvent[] = [];
  const host: Host = {
    loadSource: async () => source,
    present: async (event) => {
      events.push(structuredClone(event));
    },
    waitClick: async () => {},
    choose: async () => pick,
  };
  const runtime = new Runtime(host, { speakers, onError: "continue", ...(chatDialogue ? { chatDialogue } : {}) });
  await runtime.start("a");
  return { chat: readChat(runtime.state.stage.extra as Record<string, Value>), stage: runtime.state.stage, events };
}

const messages = (chat: ReturnType<typeof readChat>) => chat?.messages.map((m) => [m.note ? "note" : m.me ? "me" : "other", m.text]);

describe("ふだんの台詞をチャットの列に積む", () => {
  it("設定が無ければ何も積まない", async () => {
    const { chat, events } = await play("ユイ「はい」\n地の文。\n@choice\n- 甲 -> #a\n@end\n# a\n", undefined);
    expect(chat).toBeNull();
    expect(events.some((e) => e.type === "command" && e.name === "chat-chosen")).toBe(false);
  });

  it("読み終えた台詞・地の文・選んだ文を順に積み、自分の吹き出しを見分ける", async () => {
    const { chat, events } = await play("ユイ「はい」\n地の文。\nソウ「うん」\n@choice\n- 甲 -> #a\n- 乙 -> #a\n@end\n# a\nユイ「続き」\n", { me: "ソウ", title: "題" }, 1);
    expect(chat).toMatchObject({ title: "題", me: "ソウ", auto: true });
    expect(messages(chat)).toEqual([
      ["other", "「はい」"],
      ["note", "地の文。"],
      ["me", "「うん」"],
      ["me", "乙"],
      ["other", "「続き」"],
    ]);
    expect(events.filter((e) => e.type === "command" && e.name === "chat-chosen")).toHaveLength(1);
  });

  it("ルビと装飾は本文の一片のまま残す", async () => {
    const { chat } = await play("ユイ「{r 丘|おか}の{b 上}」\n", {});
    const parts = chat?.messages[0]?.parts ?? [];
    expect(parts.find((p) => "ruby" in p && p.ruby)).toMatchObject({ text: "丘", ruby: "おか" });
    expect(parts.find((p) => "text" in p && p.text === "上")).toMatchObject({ style: { bold: true } });
  });

  it("@nvl on の間は NVL の段落に積み、@clear は列も消す", async () => {
    const { chat, stage } = await play("ユイ「一」\n@nvl on\n二。\n", {});
    expect(messages(chat)).toEqual([["other", "「一」"]]);
    expect(stage.nvlPages).toHaveLength(1);
    expect(messages((await play("ユイ「一」\n@clear\nユイ「二」\n", {})).chat)).toEqual([["other", "「二」"]]);
  });

  it("@balloon on・@vertical on の間も積まない", async () => {
    expect((await play("@balloon on\nユイ「一」\n", {})).chat).toBeNull();
    expect((await play("@vertical on\nユイ「一」\n", {})).chat).toBeNull();
  });

  it("絵のボタン・押せる範囲は吹き出しにしない", async () => {
    const { chat } = await play('@choice\n- 甲 -> #a image="a.png"\n@end\n# a\n', {});
    expect(chat).toBeNull();
  });

  it("画面なしで流した道筋のセーブにも、着く前の列が入る（今のページはまだ入らない）", async () => {
    const source = "ユイ「一」\n二。\n@choice\n- 甲 -> #a\n@end\n# a\nユイ「三」\n";
    const found = await findRoute({
      loadSource: async () => source,
      runtime: { speakers, onError: "continue", chatDialogue: { me: "ソウ" } },
      start: "a",
      reached: (kind, at) => kind === "page" && at.line === 7,
    });
    const save = found!.save as SaveData;
    expect(messages(readChat(save.stage.extra))).toEqual([
      ["other", "「一」"],
      ["note", "二。"],
      ["me", "甲"],
    ]);
  });
});

describe("台詞の鉤括弧を外す", () => {
  const strip = (...chunks: string[]) => {
    const take = chatQuoteStripper();
    return chunks.map((c) => take(c));
  };

  it("外側の括弧だけを外し、切れ目をまたいでも数える", () => {
    expect(strip("「はい」")).toEqual(["はい"]);
    expect(strip("「彼は「はい」と", "言った」")).toEqual(["彼は「はい」と", "言った"]);
    expect(strip("『一』")).toEqual(["一"]);
  });

  it("（…）と括弧で始まらない本文はそのまま", () => {
    expect(strip("（心の声）")).toEqual(["（心の声）"]);
    expect(strip("それは「愛」だった")).toEqual(["それは「愛」だった"]);
  });
});

describe("言語を替えたときの吹き出し", () => {
  it("読み終えた台詞と選んだ文に訳の元を持たせ、retranslate で今の言語の文と名前にする（訳が無ければ原文に戻す）", async () => {
    const { parseInline } = await import("@liminalia/lang");
    const source = "ユイ「{r 丘|おか}へ」\n地の文。\n@choice\n- 甲 -> #a\n@end\n# a\n";
    const host: Host = { loadSource: async () => source, present: async () => {}, waitClick: async () => {}, choose: async () => 0 };
    const runtime = new Runtime(host, { speakers, chatDialogue: { me: "ソウ" } });
    await runtime.start("a");
    const chat = () => readChat(runtime.state.stage.extra as Record<string, Value>)!;
    expect(chat().messages.map((m) => [m.text, m.label ?? null])).toEqual([
      ["「丘へ」", null],
      ["地の文。", null],
      ["甲", null],
    ]);
    const words: Record<string, string> = { "「{r 丘|おか}へ」": "“To the {b hill}”", "地の文。": "Prose.", 甲: "A" };
    runtime.translator = {
      line: (_f, s) => (words[s] ? parseInline(words[s]).content : null),
      option: (_f, s) => (words[s] ? parseInline(words[s]).content : null),
      speaker: (n) => (n === "ユイ" ? "Yui" : null),
    };
    expect(runtime.retranslate()).toBe(true);
    expect(chat().messages.map((m) => [m.text, m.label ?? null])).toEqual([
      ["“To the hill”", "Yui"],
      ["Prose.", null],
      ["A", null],
    ]);
    expect(chat().messages[0]!.parts!.find((p) => "text" in p && p.text === "hill")).toMatchObject({ style: { bold: true } });
    // 二度目は変わらない
    expect(runtime.retranslate()).toBe(false);
    runtime.translator = null;
    expect(runtime.retranslate()).toBe(true);
    expect(chat().messages.map((m) => [m.text, m.label ?? null])).toEqual([
      ["「丘へ」", null],
      ["地の文。", null],
      ["甲", null],
    ]);
    expect(chat().messages[0]!.parts!.find((p) => "ruby" in p && p.ruby)).toMatchObject({ text: "丘", ruby: "おか" });
  });

  it("別の言語でロードすると、置いたままの吹き出しを今の言語にしてから組み立て直させる", async () => {
    const { parseInline } = await import("@liminalia/lang");
    const restored: unknown[] = [];
    const host: Host = {
      loadSource: async () => "ユイ「はい」\n二。\n",
      present: async (e) => {
        if (e.type === "command" && e.name === "restore") restored.push(readChat(e.stage.extra as Record<string, Value>)?.messages.map((m) => m.text));
      },
      waitClick: async () => {},
      choose: async () => 0,
    };
    const first = new Runtime(host, { speakers, chatDialogue: {} });
    await first.start("a");
    const save: SaveData = first.save();
    const second = new Runtime(host, { speakers, chatDialogue: {} });
    second.translator = { line: (_f, s) => (s === "「はい」" ? parseInline("“Yes”").content : null), option: () => null, speaker: () => null };
    await second.load(save);
    expect(restored.at(-1)).toEqual(["“Yes”", "二。"]);
  });
});
