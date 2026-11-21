import { describe, expect, it } from "vitest";
import { checkVoiceLock, PACK_COMBINATION_LIMIT, parse, playSets, skippedPlaySets, updateVoiceLock, voiceLines, voiceScriptRows, type Script } from "../src/index.ts";

const speakers = ["ユイ", "レン"];
const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([n, s]) => [n, parse(s, n, { speakers })]));
const auto = new Set(["ユイ"]);
const head = '@voice-auto ユイ pattern="y{n}.ogg"\n';
const numbers = (lock: { lines: Record<string, { source: string; n: number }> }) => Object.fromEntries(Object.values(lock.lines).map((e) => [e.source, e.n]));

describe("ボイスの番号の固定", () => {
  it("台詞の鍵はファイル・話者・原文。同じ台詞は何度目かで分ける", () => {
    const keys = voiceLines(scripts({ a: "ユイ「うん」\nレン「うん」\nユイ「うん」" }).get("a")!).map((l) => l.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(`${keys[0]}-2`);
  });

  it("初めは流して見た番号を写し、届かなかった台詞には次の番号を振る", () => {
    const s = scripts({ a: head + "ユイ「一」\nユイ「二」\nレン「三」\nユイ「四」" });
    const [k1, k2, , k4] = voiceLines(s.get("a")!).map((l) => l.key);
    const r = updateVoiceLock(null, s, auto, new Map([[k1!, new Set([5])], [k2!, new Set([6, 7])]]));
    expect(numbers(r.lock)).toEqual({ "「一」": 5, "「二」": 6, "「四」": 7 });
    expect(r).toMatchObject({ captured: 2, added: 1 });
    expect(r.varied.map((l) => l.key)).toEqual([k2]);
    expect(k4).toBeDefined();
  });

  it("固定があれば変えず、書き換えた台詞は前の番号を引き継ぎ、消した台詞の番号は使わない", () => {
    const first = updateVoiceLock(null, scripts({ a: head + "ユイ「朝の光が窓から差しこんでいた」\nユイ「犬が鳴いた」\nユイ「雨」" }), auto).lock;
    expect(numbers(first)).toEqual({ "「朝の光が窓から差しこんでいた」": 1, "「犬が鳴いた」": 2, "「雨」": 3 });
    const r = updateVoiceLock(first, scripts({ a: head + "ユイ「新しい台詞」\nユイ「朝の光が窓から差しこんでいる」\nユイ「雨」" }), auto);
    expect(numbers(r.lock)).toEqual({ "「新しい台詞」": 4, "「朝の光が窓から差しこんでいる」": 1, "「雨」": 3 });
    expect(r).toMatchObject({ kept: 1, carried: 1, added: 1 });
    expect(Object.values(r.lock.retired!).map((e) => [e.source, e.n])).toEqual([["「犬が鳴いた」", 2]]);
    // 消した台詞を戻すと、前の番号に戻る
    const back = updateVoiceLock(r.lock, scripts({ a: head + "ユイ「新しい台詞」\nユイ「朝の光が窓から差しこんでいる」\nユイ「犬が鳴いた」\nユイ「雨」" }), auto);
    expect(numbers(back.lock)["「犬が鳴いた」"]).toBe(2);
    expect(back.lock.retired).toBeUndefined();
  });

  it("検査: 固定に無い台詞・同じ番号・無いファイル・今のシナリオに無い台詞", () => {
    const s = scripts({ a: head + "ユイ「一」\nユイ「二」\nユイ「三」" });
    const lock = updateVoiceLock(null, scripts({ a: head + "ユイ「一」\nユイ「消えた」\nユイ「三」" }), auto).lock;
    const [one, , three] = voiceLines(s.get("a")!).map((l) => l.key);
    lock.lines[three!]!.n = lock.lines[one!]!.n;
    const ds = checkVoiceLock(lock, s, (_folder, path) => path === "y1.ogg");
    expect(ds.map((d) => `${d.severity} ${d.code}${d.line > 1 ? `:${d.line}` : ""}`)).toEqual(["warning voice-unlocked:3", "error voice-lock-duplicate", "warning missing-voice", "warning voice-lock-outdated"]);
  });

  it("検査: 今のシナリオに無い台詞の番号は、ほかの台詞と同じ番号でも重なりにしない（鳴らないので。今のシナリオに無いことだけを知らせる）", () => {
    // lim migrate が、本体とパックの同じ名前の台本の移らなかった側のために残した前の鍵（lim check は本体の台本だけを見る）など
    const s = scripts({ a: head + "ユイ「一」" });
    const lock = updateVoiceLock(null, s, auto).lock;
    lock.lines.previous = { speaker: "ユイ", n: 1, source: "「前の一」" };
    const ds = checkVoiceLock(lock, s, () => true);
    expect(ds.map((d) => `${d.severity} ${d.code}`)).toEqual(["warning voice-lock-outdated"]);
  });

  it("番号を振るのは @voice-auto が効いていて @voice の無い台詞だけ（実行器と同じ）", () => {
    const s = scripts({
      start: ["ユイ「設定の前」", head.trim(), "ユイ「一」", "@voice extra.ogg", "ユイ「@voice の台詞」", "@voice-auto-off ユイ", "ユイ「止めた後」", "@voice-auto ユイ", "ユイ「再開」", "@jump b"].join("\n"),
      // 飛んだ先のファイルは、飛ぶ所の状態（効いている）で始まる
      b: "ユイ「別のファイル」\n@voice-auto-off\n@jump c",
      // 止めた状態で飛ばれたファイル
      c: "ユイ「止めたまま」",
    });
    const r = updateVoiceLock(null, s, auto, undefined, { entry: "start" });
    expect(Object.values(r.lock.lines).map((e) => e.source)).toEqual(["「別のファイル」", "「一」", "「再開」"]);
    // 鳴らない台詞は、番号が無くても voice-unlocked にしない
    expect(checkVoiceLock({ lines: {} }, s, () => true, { entry: "start" }).filter((d) => d.code === "voice-unlocked").map((d) => `${d.file}:${d.line}`)).toEqual(["start:3", "start:9", "b:1"]);
  });

  it("@if の枝は両方を合わせ、マクロの中の @voice-auto も読む", () => {
    const s = scripts({
      start: ["@define start-voice()", head.trim(), "@end", "@if (game.x)", "@start-voice", "@end", "ユイ「どちらかで鳴る」"].join("\n"),
    });
    expect(Object.values(updateVoiceLock(null, s, auto, undefined, { entry: "start" }).lock.lines).map((e) => e.source)).toEqual(["「どちらかで鳴る」"]);
  });

  it("収録用の台本に鳴らない理由と要再収録を付ける", () => {
    const text = [head.trim(), "ユイ「一」", "@voice-auto-off ユイ", "ユイ「止めた後」", "@voice-auto ユイ", "ユイ「新しい」"].join("\n");
    const s = scripts({ start: text });
    const lock = updateVoiceLock(null, scripts({ start: [head.trim(), "ユイ「一」"].join("\n") }), auto, undefined, { entry: "start" }).lock;
    lock.lines[Object.keys(lock.lines)[0]!]!.rerecord = true;
    const rows = voiceScriptRows(new Map([["start", { script: s.get("start")!, text }]]), lock, { entry: "start" });
    expect(rows.map((r) => [r.text, r.voice, r.silent ?? "", r.rerecord ?? false])).toEqual([
      ["「一」", "y1.ogg", "", true],
      ["「止めた後」", "", "no-auto", false],
      ["「新しい」", "", "unlocked", false],
    ]);
  });

  it("書き換える前の台詞から引き継いだ番号は「要再収録」として残す", () => {
    const first = updateVoiceLock(null, scripts({ a: head + "ユイ「朝の光が窓から差しこんでいた」" }), auto).lock;
    const r = updateVoiceLock(first, scripts({ a: head + "ユイ「朝の光が窓から差しこんでいる」" }), auto);
    expect(r.rerecord.map((l) => l.source)).toEqual(["「朝の光が窓から差しこんでいる」"]);
    expect(Object.values(r.lock.lines)[0]).toMatchObject({ n: 1, rerecord: true });
    // 次に作り直しても印は残る
    expect(Object.values(updateVoiceLock(r.lock, scripts({ a: head + "ユイ「朝の光が窓から差しこんでいる」" }), auto).lock.lines)[0]).toMatchObject({ rerecord: true });
  });

  describe("パック（packs/<id>/scenario）の台本も数える（2026-11-19 の r1）", () => {
    // 本体の start から side へ飛ぶ。パック extra は side を差し替え（同じ名前の台本）、bonus を足す
    const main = scripts({ start: head + "ユイ「本体の一」\n@jump side", side: "ユイ「本体の脇」" });
    const pack = scripts({ side: "ユイ「パックの脇」\n@jump bonus", bonus: "ユイ「おまけ」" });
    const key = (s: Map<string, Script>, file: string, source: string) => voiceLines(s.get(file)!).find((l) => l.source === source)!.key;

    it("lim voice-lock はパックの台詞にも番号を振り、作り直してもパックの台詞の番号を retired に移さない", () => {
      const first = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [pack] });
      expect(numbers(first.lock)).toEqual({ "「本体の脇」": 1, "「本体の一」": 2, "「おまけ」": 3, "「パックの脇」": 4 });
      const again = updateVoiceLock(first.lock, main, auto, undefined, { entry: "start", packs: [pack] });
      expect(again.lock).toEqual(first.lock);
      expect(again.lock.retired).toBeUndefined();
      expect(again.lock.lines[key(pack, "bonus", "「おまけ」")]?.n).toBe(3);
    });

    it("検査は、パックの台本だけが使う番号を「今のシナリオに無い」にしない", () => {
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [pack] }).lock;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs: [pack] })).toEqual([]);
      // パックを数えなければ、前と同じく知らせる
      expect(checkVoiceLock(lock, main, () => true, { entry: "start" }).map((d) => d.code)).toEqual(["voice-lock-outdated"]);
    });

    it("同じ番号の重なりは、一緒に遊ばれる台本どうし（本体だけ、本体にそのパックを重ねたもの）で数える", () => {
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [pack] }).lock;
      // パックが差し替える本体の side と、パックの side は一緒に遊ばれないので、同じ番号でもよい（lim migrate が写した鍵など）
      lock.lines[key(pack, "side", "「パックの脇」")]!.n = lock.lines[key(main, "side", "「本体の脇」")]!.n;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs: [pack] })).toEqual([]);
      // パックを入れたときに一緒に鳴る本体の start と、パックの bonus が同じ番号なら重なり
      lock.lines[key(pack, "bonus", "「おまけ」")]!.n = lock.lines[key(main, "start", "「本体の一」")]!.n;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs: [pack] }).map((d) => d.code)).toEqual(["voice-lock-duplicate"]);
    });

    it("収録用の台本はパックの台詞も並べ（本体の行のあと。pack にパックのフォルダ）、本体にパックを重ねて鳴るかと番号を決める", () => {
      const withText = (m: Map<string, Script>, texts: Record<string, string>) => new Map([...m].map(([n, sc]) => [n, { script: sc, text: texts[n]! }]));
      const mainTexts = { start: head + "ユイ「本体の一」\n@jump side", side: "ユイ「本体の脇」" };
      const packTexts = { side: "ユイ「パックの脇」\n@jump bonus", bonus: "ユイ「おまけ」" };
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [pack] }).lock;
      const rows = voiceScriptRows(withText(main, mainTexts), lock, { entry: "start", packs: [{ dir: "packs/extra", scripts: withText(pack, packTexts) }] });
      expect(rows.map((r) => [r.pack ?? "", r.file, r.text, r.voice, r.silent ?? ""])).toEqual([
        ["", "start", "「本体の一」", "y2.ogg", ""],
        ["", "side", "「本体の脇」", "y1.ogg", ""],
        ["packs/extra", "side", "「パックの脇」", "y4.ogg", ""],
        ["packs/extra", "bonus", "「おまけ」", "y3.ogg", ""],
      ]);
    });

    it("二つのパックを同時に入れて遊ぶ組（本体にすべてのパックを並びの順に重ねたもの）でも重なりを数える", () => {
      const other = scripts({ extra: "ユイ「もう一つのおまけ」" });
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [pack, other] }).lock;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs: [pack, other] })).toEqual([]);
      // パックごとの組では一緒に鳴らないが、両方を入れると一緒に鳴る二つの台詞が同じ番号
      lock.lines[key(other, "extra", "「もう一つのおまけ」")]!.n = lock.lines[key(pack, "bonus", "「おまけ」")]!.n;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs: [pack, other] }).map((d) => d.code)).toEqual(["voice-lock-duplicate"]);
      expect(playSets(main, [pack, other])).toHaveLength(4);
      // 後ろのパックの同じ名前の台本が勝つ（遊ぶ側の並びと同じ）
      const last = playSets(main, [pack, scripts({ side: "ユイ「後ろのパックの脇」" })]).at(-1)!;
      expect(voiceLines(last.get("side")!)[0]!.source).toBe("「後ろのパックの脇」");
    });
  });

  describe("パックのどの組み合わせ（部分集合）でも数える（2026-11-19 の rest-p）", () => {
    // 本体の start から a へ飛ぶ。本体の a は連番を止めて c へ。パック A の a は止めずに c へ、B の a は止めて c へ、C が c を足す
    const main = scripts({ start: `${head}ユイ「本体の一」\n@jump a`, a: "@voice-auto-off ユイ\n@jump c" });
    const A = scripts({ a: "ユイ「エーの台詞」\n@jump c" });
    const B = scripts({ a: "@voice-auto-off ユイ\nユイ「ビーの台詞」\n@jump c" });
    const C = scripts({ c: "ユイ「シーの台詞」" });
    const key = (s: Map<string, Script>, file: string, source: string) => voiceLines(s.get(file)!).find((l) => l.source === source)!.key;

    it("playSets は、本体だけ、一つずつ、二つずつ…の順に、すべての組み合わせを並べる（台本の無いパックは数えない）", () => {
      const sets = playSets(main, [A, B, C, new Map()]);
      expect(sets).toHaveLength(8);
      expect(sets.map((s) => [...s.keys()].sort().join(" "))).toEqual(["a start", "a start", "a start", "a c start", "a start", "a c start", "a c start", "a c start"]);
      // 組の中は遊ぶ側の並び（後ろのパックの同じ名前が勝つ）
      expect(voiceLines(sets[4]!.get("a")!)[0]!.source).toBe("「ビーの台詞」");
      expect(skippedPlaySets([A, B, C])).toBe(0);
    });

    it("パックの組み合わせ（A と C だけを入れたとき）でだけ連番が鳴る台詞にも番号を振る", () => {
      const r = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [A, B, C] });
      expect(r.lock.lines[key(C, "c", "「シーの台詞」")]).toBeDefined();
      expect(r.skippedSets).toBe(0);
    });

    it("番号の重なりは、パックのどの組み合わせで一緒に鳴る台詞どうしかで決める（すべての組み合わせを並べたときと同じ）", () => {
      const packs = [A, B, C];
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs }).lock;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs })).toEqual([]);
      // すべての組み合わせを重ねて、一緒に出る鍵の組を数える（答え合わせ）
      const all = [main, ...packs];
      const together = (k1: string, k2: string) => {
        for (let mask = 0; mask < 1 << packs.length; mask++) {
          const set = new Map(main);
          packs.forEach((p, i) => {
            if (mask & (1 << i)) for (const [n, s] of p) set.set(n, s);
          });
          const keys = new Set([...set.values()].flatMap((s) => voiceLines(s).map((l) => l.key)));
          if (keys.has(k1) && keys.has(k2)) return true;
        }
        return false;
      };
      const keys = [...new Set(all.flatMap((s) => [...s.values()].flatMap((sc) => voiceLines(sc).map((l) => l.key))))];
      expect(keys.length).toBeGreaterThanOrEqual(4);
      for (const k1 of keys) {
        for (const k2 of keys) {
          if (k1 >= k2) continue;
          const copy = structuredClone(lock);
          for (const k of [k1, k2]) copy.lines[k] ??= { speaker: "ユイ", n: 0, source: "" };
          copy.lines[k2]!.n = copy.lines[k1]!.n;
          const dup = checkVoiceLock(copy, main, () => true, { entry: "start", packs }).some((d) => d.code === "voice-lock-duplicate");
          expect([k1, k2, dup]).toEqual([k1, k2, together(k1, k2)]);
        }
      }
    });

    it("収録用の台本は、パックのどれかの組み合わせで連番が鳴る台詞を「鳴らない」にしない（A と C の組でだけ鳴る台詞にもボイスのファイルを出す）", () => {
      const packs = [A, B, C];
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs }).lock;
      const withText = (m: Map<string, Script>) => new Map([...m].map(([n, sc]) => [n, { script: sc, text: "" }]));
      const rows = voiceScriptRows(withText(main), lock, { entry: "start", packs: packs.map((p, i) => ({ dir: `packs/${"abc"[i]}`, scripts: withText(p) })) });
      const c = rows.find((r) => r.pack === "packs/c")!;
      expect([c.text, c.voice === "", c.silent ?? ""]).toEqual(["「シーの台詞」", false, ""]);
      // 番号を固定する前も「連番が効いていない」にしない
      const before = voiceScriptRows(withText(main), null, { entry: "start", packs: packs.map((p, i) => ({ dir: `packs/${"abc"[i]}`, scripts: withText(p) })) });
      expect(before.find((r) => r.pack === "packs/c")!.silent).toBeUndefined();
      // B の台詞は、どの組でも止めてから言うので鳴らない
      expect(before.find((r) => r.pack === "packs/b")!.silent).toBe("no-auto");
    });

    it("A と C だけを入れたときに一緒に鳴る台詞が同じ番号なら重なり（本体に一つずつ、すべての組では一緒に鳴らない）", () => {
      const packs = [A, B, C];
      const lock = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs }).lock;
      lock.lines[key(C, "c", "「シーの台詞」")]!.n = lock.lines[key(A, "a", "「エーの台詞」")]!.n;
      expect(checkVoiceLock(lock, main, () => true, { entry: "start", packs }).map((d) => d.code)).toEqual(["voice-lock-duplicate"]);
    });

    it("台本のあるパックが上限を超えたら、本体だけ、本体に一つずつ、本体にすべての組だけを並べ、並べなかった組の数を返す", () => {
      const many = Array.from({ length: PACK_COMBINATION_LIMIT + 1 }, (_, i) => scripts({ [`p${i}`]: `ユイ「${i}」` }));
      expect(playSets(main, many)).toHaveLength(1 + many.length + 1);
      expect(skippedPlaySets(many)).toBe(2 ** many.length - (many.length + 2));
      const r = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: many });
      expect(r.skippedSets).toBe(2 ** many.length - (many.length + 2));
    });

    it("書き換えた台詞と番号が変わった台詞に、パックの台詞ならパックのフォルダを添える（lim voice-lock の出力の位置）", () => {
      const first = updateVoiceLock(null, main, auto, undefined, { entry: "start", packs: [A, C], packDirs: ["packs/a", "packs/c"] }).lock;
      const C2 = scripts({ c: "ユイ「シーの台詞だよ」" });
      const r = updateVoiceLock(first, main, auto, undefined, { entry: "start", packs: [A, C2], packDirs: ["packs/a", "packs/c"] });
      expect(r.rerecord.map((l) => [l.pack ?? "", l.file, l.line])).toEqual([["packs/c", "c", 1]]);
      // 本体の台詞には付けない
      const main2 = scripts({ start: `${head}ユイ「本体の一だ」\n@jump a`, a: "@voice-auto-off ユイ\n@jump c" });
      const m = updateVoiceLock(first, main2, auto, undefined, { entry: "start", packs: [A, C], packDirs: ["packs/a", "packs/c"] });
      expect(m.rerecord.map((l) => [l.pack ?? "", l.file])).toEqual([["", "start"]]);
    });
  });
});
