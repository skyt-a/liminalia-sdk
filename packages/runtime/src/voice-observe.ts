import { autoVoicedLines, packCombinations, voiceLines, type Script } from "@liminalia/lang";
import { explore } from "./route.ts";
import type { RuntimeOptions } from "./runtime.ts";

/** 一回の流しで出すページの上限（終わらない作りでも止める）。 */
const MAX_PAGES = 200_000;

/**
 * 「はじめから」を画面なしで何通りか流し、台詞の鍵（voiceLines）→ 鳴った連番を集める（lim voice-lock と制作画面の「番号を固定」）。
 * 固定がまだ無いときに、今の数え方で鳴る番号をそのまま固定するために使う。選び方は、まだ試していないものへ広げていく
 * （全ルートテストと同じ。route.ts の explore）。runs は流す回数の上限で、選び方を試し終えたら早く止める。
 * 数え方の番号を見るので、渡した設定に番号の固定（voiceLock）があっても使わない（使うと、固定に無い台詞が鳴らない）。
 */
export async function observeVoiceNumbers(o: {
  scripts: ReadonlyMap<string, Script>;
  entry: string;
  loadSource(file: string): Promise<string>;
  runtime: RuntimeOptions;
  runs: number;
  /**
   * パック（packs/<フォルダ>/scenario）の台本と、その中身を返す口（パックの台本だけ。無ければ undefined で、本体の台本を読む）。
   * 遊ぶ人はパックのどの組み合わせでも入れうるので、本体にパックを一つずつ、二つずつ…重ねても流し（@liminalia/lang の packCombinations。
   * 遊ぶ側と同じく、同じ名前の台本は後ろのパックのもの）、パックの台本にしか無い台詞の番号を集める（本体にもある台詞は、本体だけで流した番号）。
   * 小さい組から流し、前の組で鳴った台詞には、あとの組で鳴った番号を足さない（組み合わせで番号が変わったと出さないため）。
   * 写す台詞（その組で連番が鳴りうるもの。autoVoicedLines）が残っていない組は流さない。台本のあるパックが PACK_COMBINATION_LIMIT を超えたら、本体に一つずつとすべての組だけ。
   */
  packs?: readonly { scripts: ReadonlyMap<string, Script>; source(file: string): string | undefined }[];
}): Promise<Map<string, Set<number>>> {
  const seen = await observeOnce(o.scripts, o.entry, (file) => o.loadSource(file), o.runtime, o.runs);
  const mainKeys = new Set([...o.scripts.values()].flatMap((script) => voiceLines(script).map((l) => l.key)));
  const packs = (o.packs ?? []).filter((p) => p.scripts.size > 0);
  const packKeys = packs.map((p) => new Set([...p.scripts.values()].flatMap((script) => voiceLines(script).map((l) => l.key)).filter((k) => !mainKeys.has(k))));
  for (const combo of packCombinations(packs.length)) {
    if (combo.length === 0) continue;
    const chosen = combo.map((i) => packs[i]!);
    const set = new Map([...o.scripts, ...chosen.flatMap((p) => [...p.scripts])]);
    // 写す台詞: この組で連番が鳴りうる（autoVoicedLines。番号を振る updateVoiceLock と同じ）、この組のパックにしか無い、まだ写していない台詞
    const voiced = autoVoicedLines(set, { entry: o.entry });
    const wanted = new Set<string>();
    for (const [name, script] of set) {
      if (!chosen.some((p) => p.scripts.get(name) === script)) continue;
      for (const l of voiceLines(script)) if (voiced.has(`${l.file}:${l.line}`) && combo.some((i) => packKeys[i]!.has(l.key)) && !seen.has(l.key)) wanted.add(l.key);
    }
    if (wanted.size === 0) continue;
    const source = async (file: string) => {
      // その組に無い台本（ほかのパックにだけある台本へ飛ぶパックなど）は、そこで終わる空の台本にする（組み合わせによっては無いのが正しい）
      if (!set.has(file)) return "";
      for (const p of [...chosen].reverse()) {
        const text = p.source(file);
        if (text !== undefined) return text;
      }
      return o.loadSource(file);
    };
    const observed = await observeOnce(set, o.entry, source, o.runtime, o.runs);
    for (const [key, numbers] of observed) if (wanted.has(key)) for (const n of numbers) (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(n);
  }
  return seen;
}

/** scripts（一緒に遊ばれる台本）を「はじめから」何通りか流し、台詞の鍵 → 鳴った連番を集める。 */
async function observeOnce(scripts: ReadonlyMap<string, Script>, entry: string, loadSource: (file: string) => Promise<string>, options: RuntimeOptions, runs: number): Promise<Map<string, Set<number>>> {
  const o = { scripts, entry, loadSource, runtime: options, runs };
  const keys = new Map<string, Map<number, string>>();
  for (const [file, script] of o.scripts) keys.set(file, new Map(voiceLines(script).map((l) => [l.line, l.key])));
  const seen = new Map<string, Set<number>>();
  const { onStep: _onStep, onAssign: _onAssign, ...runtime } = o.runtime;
  let pages = 0;
  await explore({
    start: o.entry,
    runs: o.runs,
    loadSource: (file) => o.loadSource(file),
    runtime: { onError: "continue", maxSteps: 5_000_000, ...runtime, voiceLock: null },
    begin: () => {
      pages = 0;
    },
    present: (e, w) => {
      if (e.type !== "page") return;
      if (++pages >= MAX_PAGES) w.runtime.stop();
      if (e.voice?.n === undefined) return;
      const key = keys.get(e.at.file)?.get(e.at.line);
      if (key) (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(e.voice.n);
    },
  });
  return seen;
}
