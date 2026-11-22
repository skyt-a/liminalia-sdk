import { describe, expect, it } from "vitest";
import { PLAY_COMMANDS } from "../../lang/src/registry-play.ts";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { SCREENS } from "./e2e/game-screen-cases.ts";

/** 待つが、遊ぶ人の操作を待つ画面は出さない命令（演出や音の終わりを待つもの、システムの確かめ、店の画面）。 */
const NOT_SCREENS = [
  // 音と保存
  "wait-bgm",
  "wait-se",
  "wait-voice",
  "autosave",
  "autoload",
  // システムの確かめの枠（メニューの「終了」と同じもの）と、店やアプリの画面
  "quit",
  "check-update",
  "purchase",
  "restore-purchases",
  // クリックで戻すだけの演出
  "peek",
  // 演出の終わりを待つもの
  "image",
  "free-image",
  "blend",
  "blend-off",
  "chara-move",
  "movie",
  "stop-bg-movie",
  "wait-bg-movie",
  "stop-anim",
  "wait-anim",
  "transition",
  "wait-transition",
  "bg-place",
  "quake-decay",
  "layer-camera",
  "reset-layer-camera",
  "wait-camera",
  "layer-text",
  "motion-text",
  "html-hide",
  "chat",
  "staff-roll",
  "flipbook",
  "flash",
  "blink",
  "cutin",
  "cutin-hide",
  "chapter-card",
  "chapter-end",
];

describe("遊ぶ人の操作を待つ画面の一覧", () => {
  it("待つ命令はどれも、画面を出すもの（ブラウザで試す）か出さないものに分けてある", () => {
    const { specs } = combinePlugins([std]);
    const waiting = [...PLAY_COMMANDS, ...specs].filter((c) => c.waits).map((c) => c.name);
    const listed = new Set([...Object.keys(SCREENS), ...NOT_SCREENS]);
    // 新しく待つ命令を足したら、画面を出すなら SCREENS に出し方を書き、出さないなら NOT_SCREENS に足す
    expect(waiting.filter((n) => !listed.has(n))).toEqual([]);
    // もう無い命令を一覧に残さない
    expect([...listed].filter((n) => !waiting.includes(n))).toEqual([]);
  });
});
