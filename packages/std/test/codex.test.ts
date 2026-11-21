import { describe, expect, it } from "vitest";
import { checkData, CORE_COMMANDS, createRegistry, parse, parseExpr } from "@liminalia/lang";
import { evaluate, HeadlessHost, Runtime, type Value } from "@liminalia/runtime";
import { combinePlugins, runPluginChecks } from "@liminalia/sdk";
import std, { codex as C, investigation as I } from "../src/commands/index.ts";

const { implementations, specs } = combinePlugins([std]);
const registry = createRegistry(CORE_COMMANDS, specs);

const DATA: C.CodexData = {
  categories: [
    { id: "people", label: "人物" },
    { id: "terms", label: "用語", sort: "reading" },
    { id: "items", label: "持ち物" },
  ],
  entries: [
    { id: "haru", category: "people", title: "ハル", if: 'game.n_haru == "true"', sections: [{ text: "天文部の部長。" }, { id: "past", text: "前は写真部。", if: "game.past" }, { id: "secret", text: "秘密。", locked: true }] },
    { id: "noise", category: "terms", title: "ノイズ", reading: "のいず", sections: [{ text: "雑音。" }] },
    { id: "key", category: "items", title: "古い鍵", item: "old_key" },
  ],
};

const scope = (game: Record<string, Value>) => (e: ReturnType<typeof parseExpr>) => evaluate(e, { lookup: (name: string) => (name === "game" ? game : undefined) } as never);

describe("図鑑", () => {
  it("条件の式・@codex-unlock・持ち物で開き、段ごとに少しずつ開く", () => {
    const game: Record<string, Value> = { n_haru: "true" };
    let shown = C.codexShown(DATA, { evaluate: scope(game), unlocked: {}, items: {} });
    expect(shown.map((s) => [s.entry.id, s.sections.map((x) => x.key)])).toEqual([["haru", ["haru#0"]]]);
    game.past = true;
    shown = C.codexShown(DATA, { evaluate: scope(game), unlocked: { noise: true, "haru#secret": true }, items: { old_key: 1 } });
    expect(shown.map((s) => [s.entry.id, s.sections.map((x) => x.key)])).toEqual([
      ["haru", ["haru#0", "haru#past", "haru#secret"]],
      ["noise", ["noise#0"]],
      ["key", []],
    ]);
    // 遊んでいない（おまけ）なら、記録に残っているものだけ
    expect(C.shownKeys(C.codexShown(DATA, { evaluate: null, unlocked: { haru: true, "haru#0": true } }))).toEqual(["haru", "haru#0"]);
  });

  it("@codex-unlock はこのプレイと全セーブ共通の記録に入れ、描画側に新しいかを渡す", async () => {
    const shown: Record<string, Value>[] = [];
    class H extends HeadlessHost {
      override async present(event: Parameters<HeadlessHost["present"]>[0]) {
        if (event.type === "command" && event.name === "codex-unlock") shown.push(event.args);
        return super.present(event);
      }
    }
    const host = new H({ loadSource: async () => "@codex-unlock noise\n@codex-unlock noise\n@codex-unlock haru section=secret", loadData: async () => DATA });
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("a");
    expect(shown.map((a) => a.fresh)).toEqual(["entry", "", "entry"]);
    expect(runtime.system.codex_unlocked).toEqual({ noise: true, haru: true, "haru#secret": true });
    expect((runtime.state.game["@codex"] as Record<string, Value>).unlocked).toEqual({ noise: true, haru: true, "haru#secret": true });
    // 一緒に開いた段（条件も伏せも無いもの）も知らせたことにする（見回りが「記録が増えた」と知らせ直さない）。条件の偽の段は入れない
    expect(Object.keys((runtime.state.game["@codex"] as Record<string, Record<string, Value>>).known!).sort()).toEqual(["haru", "haru#0", "haru#secret", "noise", "noise#0"]);
  });

  it("台本が指す項目と段が無ければ知らせる", () => {
    const src = "@codex-unlock haru section=nothing\n@codex nobody\n@codex-unlock noise\n@investigate room";
    const scripts = new Map([["a", parse(src, "a")]]);
    const d = runPluginChecks([std], { root: "/", config: {}, scripts, text: () => src, cast: {}, speakers: [], registry, data: (name) => (name === "codex.json" ? DATA : undefined), assetExists: () => true });
    expect(d.filter((x) => x.code.startsWith("unknown-")).map((x) => `${x.code}:${x.line}`)).toEqual(["unknown-data-key:4", "unknown-codex-entry:1", "unknown-codex-entry:2"]);
    // データの条件が読むのに、どの台本も立てないフラグ
    expect(d.filter((x) => x.code === "data-flag-unset").map((x) => x.message)).toEqual(["data/codex.json が読むフラグ game.n_haru を、どの台本の @set もデータも立てません", "data/codex.json が読むフラグ game.past を、どの台本の @set もデータも立てません"]);
  });
});

describe("図鑑の条件が読む変数", () => {
  const reads = (src: string) => [...C.exprReads(parseExpr(src))].sort();

  it("game.x・system.x・temp.x は頭から二つ、関数は持ち物・訪問・選択・ページ、局所変数は * にする", () => {
    expect(reads("game.met && game.a.b > 1")).toEqual(["game.a", "game.met"]);
    expect(reads('system.cleared["ep1"] || temp.t')).toEqual(["system.cleared", "temp.t"]);
    expect(reads("game[game.key] == 1")).toEqual(["game", "game.key"]);
    expect(reads('item("鍵") > 0 && visits("a#x") > 0 && chosen("右")')).toEqual(["chosen", "game.@items", "visits"]);
    expect(reads('read("a#x") || lang() == "en"')).toEqual(["page"]);
    expect(reads("x > 1")).toEqual(["*"]);
    expect([...C.codexReads(DATA)].sort()).toEqual(["game.@items", "game.n_haru", "game.past"]);
  });

  it("変わった変数が、読むものに関わるかを見る", () => {
    const r = new Set(["game.met", "chosen"]);
    expect(C.readsTouched(r, "game.met")).toBe(true);
    expect(C.readsTouched(r, "game.met.x")).toBe(true);
    expect(C.readsTouched(r, "game.other")).toBe(false);
    expect(C.readsTouched(r, "game")).toBe(true);
    expect(C.readsTouched(r, "system")).toBe(false);
    expect(C.readsTouched(r, "chosen")).toBe(true);
    expect(C.readsTouched(r, "visits")).toBe(false);
    expect(C.readsTouched(r, "x")).toBe(false);
    expect(C.readsTouched(new Set(["*"]), "x")).toBe(true);
  });

  it("実行器は @set・持ち物・選んだ選択肢・入った場面・setVariable・variablesChanged を知らせる", async () => {
    const src = '@set game.met = true\n@item-add 鍵\n@choice\n- 右 -> #r\n@end\n# r\n@clear-vars temp\n本文';
    const host = new HeadlessHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { commands: implementations });
    const seen: string[] = [];
    const off = runtime.onVariableChange((path) => seen.push(path));
    await runtime.start("a");
    runtime.setVariable("game.n", 1);
    runtime.variablesChanged("game.plugin");
    off();
    runtime.setVariable("game.after", 1);
    expect(seen.filter((p) => p !== "visits")).toEqual(["game.met", "game.@items", "chosen", "temp", "game.n", "game.plugin"]);
    expect(seen).toContain("visits");
  });
});

describe("図鑑の年表・相関図・地図", () => {
  const TYPED: C.CodexData = {
    categories: [
      { id: "years", label: "年表", type: "timeline" },
      { id: "people", label: "相関図", type: "relations" },
      { id: "town", label: "地図", type: "map", map: "maps/town.png" },
    ],
    entries: [
      { id: "late", category: "years", title: "後の出来事", date: "1925年", order: 2 },
      { id: "early", category: "years", title: "先の出来事", date: "1923年", order: 1 },
      { id: "haru", category: "people", title: "ハル", x: 20, y: 50, links: [{ to: "yuika", label: "友人", tone: "positive" }, { to: "rival", label: "宿敵", tone: "negative", if: "game.met_rival" }] },
      { id: "yuika", category: "people", title: "ユイカ", x: 80, y: 50 },
      { id: "rival", category: "people", title: "敵", if: "game.met_rival" },
      { id: "station", category: "town", title: "駅", x: 30, y: 40 },
    ],
  };

  it("年表は order の順、相関図の線は両端が開いていて条件が真のものだけ。線の鍵も記録に入る", () => {
    const game: Record<string, Value> = {};
    const unlocked = { early: true, late: true, haru: true, yuika: true, station: true };
    let shown = C.codexShown(TYPED, { evaluate: scope(game), unlocked });
    expect(C.timelineOrder(shown.filter((s) => s.entry.category === "years"), TYPED.entries).map((s) => s.entry.id)).toEqual(["early", "late"]);
    expect(shown.find((s) => s.entry.id === "haru")!.links.map((l) => l.key)).toEqual(["haru>yuika"]);
    game.met_rival = true;
    shown = C.codexShown(TYPED, { evaluate: scope(game), unlocked });
    expect(shown.find((s) => s.entry.id === "haru")!.links.map((l) => l.key)).toEqual(["haru>yuika", "haru>rival"]);
    expect(C.shownKeys(shown)).toContain("haru>rival");
    // おまけ（遊んでいない）では、条件のある線は記録に残っているときだけ
    const extra = C.codexShown(TYPED, { evaluate: null, unlocked: { haru: true, yuika: true, rival: true, "haru>yuika": true } });
    expect(extra.find((s) => s.entry.id === "haru")!.links.map((l) => l.key)).toEqual(["haru>yuika"]);
    // 線の条件が読む変数も見回しの対象
    expect([...C.codexReads(TYPED)]).toContain("game.met_rival");
  });

  it("形の宣言は見せ方・地図の絵・日付・位置・線を確かめる", () => {
    const bad = structuredClone(TYPED) as unknown as { categories: { type: string }[]; entries: { links?: { to: string }[] }[] };
    bad.categories[0]!.type = "tree";
    bad.entries[2]!.links![0]!.to = "nobody";
    const d = checkData(C.CODEX_DATA, bad, { fileName: "data/codex.json", labels: new Map(), assetExists: () => true });
    expect(d.map((x) => x.code).sort()).toEqual(["data-type", "data-unknown-ref"]);
  });

  it("地図の絵は、地図の選択（data/investigation.json の maps）と同じく bgimage から探し、前の置き場所（image）も読む", () => {
    const data = { categories: [{ id: "town", label: "地図", type: "map", map: "maps/town.png" }], entries: [] };
    const missing = (exists: (folder: string, path: string) => boolean) =>
      checkData(C.CODEX_DATA, data, { fileName: "data/codex.json", labels: new Map(), assetExists: exists })
        .filter((x) => x.code === "data-missing-asset")
        .map((x) => x.message);
    expect(missing((folder) => folder === "bgimage")).toEqual([]);
    expect(missing((folder) => folder === "image")).toEqual([]);
    expect(missing(() => false)).toEqual([expect.stringContaining("bgimage/maps/town.png")]);
    // 地図の選択の地図も、前に image へ置いたものを読む
    const maps = { maps: { town: { background: "maps/town.png", spots: [] } } };
    const mapMissing = (exists: (folder: string, path: string) => boolean) =>
      checkData(I.INVESTIGATION_DATA, maps, { fileName: "data/investigation.json", labels: new Map(), assetExists: exists }).filter((x) => x.code === "data-missing-asset").length;
    expect([mapMissing((folder) => folder === "bgimage"), mapMissing((folder) => folder === "image"), mapMissing(() => false)]).toEqual([0, 0, 1]);
  });
});
