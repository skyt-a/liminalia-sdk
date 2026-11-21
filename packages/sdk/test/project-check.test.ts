import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, parse, type Diagnostic, type Script } from "@liminalia/lang";
import { packTranslationScope, parsePacks, projectDiagnostics, type ProjectCheckConfig, type ProjectCheckInput } from "../src/index.ts";

/**
 * 作品全体の検査（projectDiagnostics。lim check、制作画面、VS Code、MCP が同じものを使う）のうち、設定のファイルにかかわるもの。
 * cast.json の診断の行と話者ごとの黙らせ方。
 */

const registry = createRegistry(CORE_COMMANDS);
const speakers = ["ユイ", "カイ", "ミナ"];
const cast = { ユイ: { appearances: { default: { variants: { normal: { image: "yui/normal.png" } } } } } };
const castText = JSON.stringify({ speakers, cast }, null, 2);

function run(o: { config?: ProjectCheckConfig; configText?: string; cast?: Record<string, unknown>; castText?: string; more?: Partial<ProjectCheckInput> } = {}): Diagnostic[] {
  const text = "ユイ「はい」\n@stop";
  const config = { entry: "start", ...o.config };
  return projectDiagnostics({
    root: "/",
    files: new Map([["start", { script: parse(text, "start", { speakers }), text }]]),
    config,
    configText: o.configText ?? JSON.stringify(config, null, 2),
    cast: o.cast ?? cast,
    speakers,
    castText: o.castText ?? castText,
    registry,
    plugins: [],
    data: () => undefined,
    translations: [],
    assets: { exists: () => false },
    ...o.more,
  });
}
const at = (list: Diagnostic[], code: string) => list.filter((d) => d.code === code).map((d) => `${d.file}:${d.line} ${d.severity}`);

describe("cast.json の診断の行と、話者ごとの黙らせ方", () => {
  it("使われない話者は、cast.json の speakers のその話者の行を指す", () => {
    // 1 {、2 "speakers": [、3 "ユイ"、4 "カイ"、5 "ミナ"
    expect(at(run(), "unused-speaker")).toEqual(["cast.json:4 info", "cast.json:5 info"]);
  });

  it("無い立ち絵は、その人物の行を指し、キャラクターの画面を開ける", () => {
    const d = run().find((x) => x.code === "missing-asset")!;
    expect(d.line).toBe(castText.split("\n").findIndex((l) => l.includes('"ユイ": {')) + 1);
    expect(d.cast).toEqual({ who: "ユイ" });
  });

  it("liminalia.json の check.unusedSpeakers に書いた話者は、使われなくても知らせない", () => {
    expect(at(run({ config: { check: { unusedSpeakers: ["カイ"] } } as ProjectCheckConfig }), "unused-speaker")).toEqual(["cast.json:5 info"]);
  });

  it("check.unusedSpeakers の形の誤りと、speakers に無い名前を知らせる", () => {
    const config = { check: { unusedSpeakers: "カイ" } } as ProjectCheckConfig;
    const bad = run({ config }).filter((d) => d.code === "bad-config");
    expect(bad.map((d) => d.message)).toEqual(["check.unusedSpeakers は話者の名前の並びで書きます"]);
    expect(bad[0]!.line).toBeGreaterThan(1);
    const stale = run({ config: { check: { unusedSpeakers: ["ナナ"] } } as ProjectCheckConfig }).filter((d) => d.code === "bad-config");
    expect(stale.map((d) => [d.severity, d.message])).toEqual([["warning", "check.unusedSpeakers の ナナ は cast.json の speakers にありません"]]);
  });
});

describe("cast.json の model を描くもの", () => {
  const withModel = (model: Record<string, unknown>, variant?: Record<string, unknown>) => ({
    ユイ: { model, appearances: { default: { variants: { normal: { image: "yui/normal.png", ...(variant ? { model: variant } : {}) } } } } },
  });
  const models = (model: Record<string, unknown>, o: { plugins?: string[]; configPlugins?: string[]; variant?: Record<string, unknown> } = {}) => {
    const c = withModel(model, o.variant);
    return run({
      cast: c,
      castText: JSON.stringify({ speakers, cast: c }, null, 2),
      ...(o.configPlugins ? { config: { plugins: o.configPlugins } as ProjectCheckConfig } : {}),
      more: { plugins: (o.plugins ?? []).map((name) => ({ name, commands: [] })) },
    }).filter((d) => d.code === "model-plugin-missing");
  };

  it("Live2D と Spine のプラグインが無ければ、その人物の行に一度だけ警告する（遊ぶ画面では画像の立ち絵で出る）", () => {
    const d = models({ type: "live2d", src: "" }, { variant: { type: "live2d", expression: "f01" } });
    expect(d.map((x) => [x.severity, x.message, x.cast])).toEqual([["warning", "ユイ の model の Live2D（type live2d）を描くプラグインが入っていません（遊ぶ画面では画像の立ち絵で出ます）", { who: "ユイ" }]]);
    expect(d[0]!.line).toBeGreaterThan(1);
    expect(d[0]!.hint).toBe("制作画面の「プラグイン」の「公式のプラグイン」で Live2D をインストールします。使わないなら model を消します");
    expect(models({ type: "spine", src: "a.skel" }).map((x) => x.message)).toEqual(["ユイ の model の Spine（type spine）を描くプラグインが入っていません（遊ぶ画面では画像の立ち絵で出ます）"]);
  });

  it("プラグインを読み込んだか、liminalia.json の plugins に書いてあれば知らせない（src の誤りはプラグインの検査が知らせる）", () => {
    expect(models({ type: "live2d", src: "" }, { plugins: ["live2d"] })).toEqual([]);
    expect(models({ type: "live2d", src: "" }, { configPlugins: ["plugins/live2d"] })).toEqual([]);
  });

  it("組み込みの sway と、作品のプラグインが描く知らない種類は知らせない。綴りの近い種類は案を出す", () => {
    expect(models({ type: "sway" })).toEqual([]);
    expect(models({ type: "puppet" })).toEqual([]);
    const typo = models({ type: "Live2D" });
    expect(typo.map((x) => [x.message, x.hint])).toEqual([["ユイ の model の type Live2D を描くものがありません（遊ぶ画面では画像の立ち絵で出ます）", "live2d のことですか？"]]);
  });
});

describe("パックの訳で出る台本（packTranslationScope。2026-11-19 の rest-p）", () => {
  // 並びは A、B、C、D。A、C、D は en の訳を持ち、B は持たない。同じ名前の台本を持つものがある
  const packs = parsePacks(
    [
      { dir: "packs/a", speakers: [], scripts: new Map([["side", "ユイ「エーの脇」"], ["a", "ユイ「エー」"]]), translations: new Map([["en", "{}"]]) },
      { dir: "packs/b", speakers: [], scripts: new Map([["side", "ユイ「ビーの脇」"], ["b", "ユイ「ビー」"]]), translations: new Map() },
      { dir: "packs/c", speakers: [], scripts: new Map([["side", "ユイ「シーの脇」"], ["c", "ユイ「シー」"]]), translations: new Map([["en", "{}"]]) },
      { dir: "packs/d", speakers: [], scripts: new Map([["a", "ユイ「ディーのエー」"], ["d", "ユイ「ディー」"]]), translations: new Map([["en", "{}"]]) },
    ],
    speakers,
  );
  const main = new Map([["start", parse("ユイ「本体」", "start", { speakers })], ["side", parse("ユイ「本体の脇」", "side", { speakers })]]);

  it("訳のファイルごとに、その訳で出る台本は、その訳が使われるパックの組み合わせすべてで出る台本と同じ", () => {
    for (const owner of [undefined, ...packs.filter((p) => p.translations.has("en"))]) {
      // 答え合わせ: その訳が使われる組（owner を入れ、owner より後ろに en の訳を持つパックを入れない）を重ねて、出る台本を集める
      const want = new Set<Script>();
      for (let mask = 0; mask < 1 << packs.length; mask++) {
        const chosen = packs.filter((_p, i) => mask & (1 << i));
        const last = [...chosen].reverse().find((p) => p.translations.has("en"));
        if (last !== owner) continue;
        const set = new Map(main);
        for (const p of chosen) for (const [n, sc] of p.scripts) set.set(n, sc);
        for (const sc of set.values()) want.add(sc);
      }
      const scope = packTranslationScope(packs, "en", owner);
      const own = owner ? new Map([...main, ...owner.scripts]) : main;
      const shown = new Set([...own.values(), ...scope.alsoShown.flatMap((m) => [...m.values()])]);
      expect([owner?.dir, [...shown].map((sc) => voiceText(sc)).sort()]).toEqual([owner?.dir, [...want].map((sc) => voiceText(sc)).sort()]);
      // 出ない台本も、使われているには数える（どの組で入っても訳を消さない）
      const used = new Set([...shown, ...scope.alsoUsedBy.flatMap((m) => [...m.values()])]);
      expect(used.size).toBe([...main.values(), ...packs.flatMap((p) => [...p.scripts.values()])].length - (owner ? [...main.keys()].filter((n) => owner.scripts.has(n)).length : 0));
    }
  });
});

const voiceText = (sc: Script) => JSON.stringify(sc.body[0] && "content" in sc.body[0] ? sc.body[0].content : sc.file);
