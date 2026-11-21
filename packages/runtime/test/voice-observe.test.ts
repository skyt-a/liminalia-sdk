import { describe, expect, it } from "vitest";
import { parse, voiceLines, type Script } from "@liminalia/lang";
import { observeVoiceNumbers } from "../src/index.ts";

/**
 * 番号の固定を初めて作るときの写し取り（lim voice-lock と制作画面の「番号を固定」）。パックのどの組み合わせでも流す（2026-11-19 の rest-p）。
 */
const speakers = ["ユイ"];
const read = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([n, s]) => [n, parse(s, n, { speakers })]));
const pack = (files: Record<string, string>) => ({ scripts: read(files), source: (file: string) => files[file], files });
const read2 = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([n, s]) => [n, parse(s, n, { speakers: ["ユイ", "レン"] })]));

describe("初めての写し取りとパックの組み合わせ", () => {
  // 本体の start から a へ。本体の a は止めて c へ。パック A の a は止めずに c へ、B の a は止めて c へ、C が c を差し替える。
  // C の台詞は、A と C を入れて B を入れないときだけ鳴る（本体に一つずつ、すべての組では鳴らない）
  const mainFiles = { start: '@voice-auto ユイ pattern="y{n}.ogg"\nユイ「一」\n@jump a', a: "@voice-auto-off ユイ\n@jump c", c: "地の文。" };
  const main = read(mainFiles);
  const A = pack({ a: "ユイ「エー」\n@jump c" });
  const B = pack({ a: "@voice-auto-off ユイ\nユイ「ビー」\n@jump c" });
  const C = pack({ c: "ユイ「シー」" });
  const keyOf = (s: ReadonlyMap<string, Script>, file: string) => voiceLines(s.get(file)!)[0]!.key;

  it("A と C だけを入れた組で鳴る番号も写す。小さい組で写した台詞は、あとの組の番号を足さない", async () => {
    const seen = await observeVoiceNumbers({ scripts: main, entry: "start", loadSource: async (f) => {
        const text = mainFiles[f as keyof typeof mainFiles];
        if (text === undefined) throw new Error(`ファイル ${f}.lim が見つかりません`);
        return text;
      }, runtime: { speakers }, runs: 2, packs: [A, B, C] });
    expect(seen.get(keyOf(main, "start"))).toEqual(new Set([1]));
    expect(seen.get(keyOf(A.scripts, "a"))).toEqual(new Set([2]));
    // A と C の組でだけ鳴る
    expect(seen.get(keyOf(C.scripts, "c"))).toEqual(new Set([3]));
    // B の台詞は止めてから言うので鳴らない
    expect(seen.has(keyOf(B.scripts, "a"))).toBe(false);
  });

  it("連番の鳴らない台詞だけのパックは、組を増やして流さない（写す台詞が残らない組は流さない）", async () => {
    let starts = 0;
    const load = async (f: string) => {
      if (f === "start") starts++;
      const text = mainFiles[f as keyof typeof mainFiles];
      if (text === undefined) throw new Error(`ファイル ${f}.lim が見つかりません`);
      return text;
    };
    await observeVoiceNumbers({ scripts: main, entry: "start", loadSource: load, runtime: { speakers: ["ユイ", "レン"] }, runs: 2 });
    const alone = starts;
    starts = 0;
    // レンは連番を使わないので、パックの台詞はどの組でも鳴らない
    const quiet = [1, 2, 3].map((i) => pack({ [`n${i}`]: `レン「エヌ${i}」` }));
    await observeVoiceNumbers({ scripts: main, entry: "start", loadSource: load, runtime: { speakers: ["ユイ", "レン"] }, runs: 2, packs: quiet.map((p) => ({ scripts: read2(p.files), source: p.source })) });
    expect(starts).toBe(alone);
  });

  it("ほかのパックにだけある台本へ飛ぶパックは、その台本の無い組ではそこで終わる（止まらずにほかの組も流す）", async () => {
    // D は E にだけある e へ飛ぶ。D だけの組では e が無い
    const D = pack({ a: "ユイ「ディー」\n@jump e" });
    const E = pack({ e: "ユイ「イー」" });
    const seen = await observeVoiceNumbers({ scripts: main, entry: "start", loadSource: async (f) => mainFiles[f as keyof typeof mainFiles]!, runtime: { speakers }, runs: 2, packs: [D, E] });
    expect(seen.get(keyOf(D.scripts, "a"))).toEqual(new Set([2]));
    expect(seen.get(keyOf(E.scripts, "e"))).toEqual(new Set([3]));
  });
});
