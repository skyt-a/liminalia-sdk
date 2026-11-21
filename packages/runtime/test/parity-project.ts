import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, voiceLines, type VoiceLock } from "@liminalia/lang";

/**
 * 遊ぶ側と画面なしの流し（lim trace、lim test、lim coverage、lim build --seed、制作画面の現在地と全ルートテスト、VS Code の
 * 「ここからテストプレイ」）が同じ結果になるかを確かめる作品。作品の設定のそれぞれが、流れか状態に見える違いを作る。
 * - 自動配置（commandDefaults の chara の auto-layout と autoLayout の enter）: 立ち絵の枠（stage.sprites の autoSlot）
 * - 言語（languages の先頭）、章（chapters）、版（version）、変数の初期値（variables）: @if で分かれる本文の行
 * - 台詞の括弧（ui.text.quotes）: 台詞のページの文
 * - ボイスの番号の固定（voice-lock.json）: 鳴る番号（stage.voice の next）
 * - CG（extra.cg）、数を数える実績（extra.achievements の goal）: @if で分かれる本文の行と system
 * - エンディングの種類（endingKinds）と見た数で進める実績（extra.achievements の endings）: system.achievements
 * 遊ぶ側（ブラウザ）で流すと、PARITY_PAGES の本文をこの順に出し、PARITY_STATE の状態で終わる（web/test/e2e/headless-parity.test.ts）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

export const PARITY_SCENARIO = [
  "# top",
  "@bg hill_dusk.webp time=0ms",
  "@window show time=0ms",
  '@voice-auto アカリ pattern="akari/{n:3}.ogg"',
  "@chara アカリ time=0ms",
  "@chara ソウ time=0ms",
  "はじまり。",
  '@if lang() == "ja"',
  "日本語の道。",
  "@end",
  '@if chapter() == "c1"',
  "一章の道。",
  "@end",
  '@if save.version == "1.0.0"',
  "版の道。",
  "@end",
  "@if game.flag",
  "初期値の道。",
  "@end",
  "アカリ「括弧の台詞。」",
  "アカリ「二つ目の台詞。」",
  "@bg hill_night.webp time=0ms",
  '@if system.cg_unlocked["hill_night.webp"] == true',
  "CG の道。",
  "@end",
  "@achieve-progress star add=2",
  '@if system.achievements["star"] != null',
  "実績の道。",
  "@end",
  "おわり。",
  "@title-screen ending=special",
  "",
  "# after",
  "@set temp.loaded = true",
  "@return",
  "",
].join("\n");

/** 遊ぶ側が出す本文（話者のある台詞は、括弧を外した文）。 */
export const PARITY_PAGES = ["はじまり。", "日本語の道。", "一章の道。", "版の道。", "初期値の道。", "括弧の台詞。", "二つ目の台詞。", "CG の道。", "実績の道。", "おわり。"];

/** ボイスの番号の固定（数えた番号の 1 と 2 ではなく、7 と 12）。 */
export const PARITY_VOICES = [7, 12];

/** 遊ぶ側で流し終えた状態（立ち絵の枠、鳴らした次のボイスの番号、CG と実績）。 */
export const PARITY_STATE = {
  slots: { アカリ: { index: 1, count: 2 }, ソウ: { index: 0, count: 2 } },
  nextVoice: 13,
  cg: { "hill_night.webp": true },
  achievements: ["ends", "star"],
};

/** 作品の設定（ひな形の liminalia.json に重ねる）。 */
export const PARITY_CONFIG = {
  entry: "xa",
  version: "1.0.0",
  languages: ["ja", "en"],
  chapters: [{ id: "c1", title: "一章", files: ["xa"] }],
  commandDefaults: { chara: { "auto-layout": true } },
  autoLayout: { enter: "start" },
  ui: { text: { quotes: "strip" } },
  variables: { "game.flag": true },
  afterLoad: "xa#after",
  endingKinds: { special: "特別" },
  extra: {
    cg: [{ id: "night", images: ["hill_night.webp"] }],
    achievements: [
      { id: "star", title: "星", goal: 2 },
      { id: "ends", title: "特別な終わり", endings: "special", goal: 1 },
    ],
  },
};

/** 台本のテスト（遊ぶ側が出したものを期待に書いたもの）。 */
export const PARITY_TEST = [
  "# 遊ぶ側と同じ",
  "from xa",
  ...PARITY_PAGES.map((p) => `expect text "${p}"`),
  'expect not text "「括弧の台詞。」"',
  "expect ending special",
  'expect system.achievements["ends"] != null',
  "",
].join("\n");

/** ひな形の写しに、確かめの台本と設定とボイスの番号の固定を書いた作品を dir に作る（ひな形の台本とテストは除く）。 */
export function writeParityProject(dir: string): void {
  cpSync(TEMPLATE, dir, { recursive: true });
  rmSync(join(dir, "scenario"), { recursive: true, force: true });
  rmSync(join(dir, "tests"), { recursive: true, force: true });
  mkdirSync(join(dir, "scenario"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "scenario", "xa.lim"), PARITY_SCENARIO);
  writeFileSync(join(dir, "tests", "xa.limtest"), PARITY_TEST);
  const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  const defaults = (config.commandDefaults ?? {}) as Record<string, unknown>;
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, ...PARITY_CONFIG, commandDefaults: { ...defaults, ...PARITY_CONFIG.commandDefaults } }, null, 2));
  const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers: string[] };
  const lines = voiceLines(parse(PARITY_SCENARIO, "xa", { speakers: cast.speakers })).filter((l) => l.speaker === "アカリ");
  const lock: VoiceLock = { lines: Object.fromEntries(lines.map((l, i) => [l.key, { speaker: l.speaker, n: PARITY_VOICES[i]!, source: l.source }])) };
  writeFileSync(join(dir, "voice-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}
