import { describe, expect, it } from "vitest";
import { HeadlessHost, readChat, Runtime, type Translator, type Value } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/sdk";
import std, { imageState as S } from "../src/commands/index.ts";

/** 置いたままの文字（@layer-text・@chat）を、言語を替えたときと別の言語でロードしたときに今の言語で出し直す（Runtime.retranslate）。 */

const { implementations } = combinePlugins([std]);
const WORDS: Record<string, string> = { "第一章": "Chapter 1", "いまどこ？": "Where are you?", 題: "Title", 二章: "Chapter 2" };
const english: Translator = { line: () => null, option: () => null, speaker: (n) => (n === "ユイ" ? "Yui" : null), arg: (_f, s) => WORDS[s] ?? null };

const texts = (runtime: Runtime) => (S.readExtra(runtime.state.stage.extra, "images")?.fg0 ?? []).map((i) => (i as unknown as { text: string }).text);
const bubbles = (runtime: Runtime) => readChat(runtime.state.stage.extra as Record<string, Value>)?.messages.map((m) => [m.label ?? m.speaker, m.text]);

describe("置いたままの文字の訳し直し", () => {
  it("@layer-text の字面の文字は訳の元を持ち、言語を替えると今の言語の文字になる（式の文字はそのまま）", async () => {
    const host = new HeadlessHost({ loadSource: async () => '@set game.n = "名前"\n@layer-text "第一章" name=c\n@layer-text (game.n)\n本文' });
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("a");
    expect(texts(runtime)).toEqual(["第一章", "名前"]);
    runtime.translator = english;
    expect(runtime.retranslate()).toBe(true);
    expect(texts(runtime)).toEqual(["Chapter 1", "名前"]);
    runtime.translator = null;
    runtime.retranslate();
    expect(texts(runtime)).toEqual(["第一章", "名前"]);
  });

  it("@layer-text overwrite=true で書き換えた文字は、書き換えた文字の訳になる", async () => {
    const host = new HeadlessHost({ loadSource: async () => '@layer-text "第一章" name=c\n@layer-text "二章" name=c overwrite=true\n本文' });
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("a");
    runtime.translator = english;
    runtime.retranslate();
    expect(texts(runtime)).toEqual(["Chapter 2"]);
  });

  it("@chat の吹き出しと @chat-open の題は、言語を替えると今の言語の文と名前になる", async () => {
    const host = new HeadlessHost({ loadSource: async () => '@chat-open 題 me=ソウ\n@chat ユイ text="いまどこ？"\n本文' });
    const runtime = new Runtime(host, { speakers: ["ユイ", "ソウ"], commands: implementations });
    await runtime.start("a");
    expect(bubbles(runtime)).toEqual([["ユイ", "いまどこ？"]]);
    runtime.translator = english;
    runtime.retranslate();
    expect(bubbles(runtime)).toEqual([["Yui", "Where are you?"]]);
    expect(readChat(runtime.state.stage.extra as Record<string, Value>)?.title).toBe("Title");
  });

  it("ほかの言語でセーブしたものを原文の言語でロードすると、原文に戻る", async () => {
    const host = new HeadlessHost({ loadSource: async () => '@layer-text "第一章"\n@chat ユイ text="いまどこ？"\n本文' });
    const first = new Runtime(host, { speakers: ["ユイ"], commands: implementations });
    first.translator = english;
    await first.start("a");
    expect(texts(first)).toEqual(["Chapter 1"]);
    const second = new Runtime(host, { speakers: ["ユイ"], commands: implementations });
    await second.load(first.save());
    expect(texts(second)).toEqual(["第一章"]);
    expect(bubbles(second)).toEqual([["ユイ", "いまどこ？"]]);
  });
});
