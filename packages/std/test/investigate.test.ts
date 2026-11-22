import { describe, expect, it } from "vitest";
import { checkData, CORE_COMMANDS, createRegistry, jsonLines, parse, scriptLabels } from "@liminalia/lang";
import { HeadlessHost, Runtime, type PresentEvent, type Value } from "@liminalia/runtime";
import { combinePlugins, runPluginChecks } from "@liminalia/sdk";
import std, { investigation as I } from "../src/commands/index.ts";
import { mapPanelRect } from "../src/commands/data-check.ts";

const { implementations, specs, commands } = combinePlugins([std]);
const registry = createRegistry(CORE_COMMANDS, specs);

const DATA = {
  places: {
    room: {
      title: "部屋を調べる",
      file: "a",
      done: "#done",
      views: [
        {
          id: "front",
          label: "正面",
          background: "room_h.png",
          spots: [
            { id: "window", label: "窓", rect: { x: 10, y: 10, width: 100, height: 100 }, target: "#window", required: false },
            { id: "shelf", label: "本棚", rect: { x: 200, y: 10, width: 100, height: 100 }, target: "#shelf", flag: "seen_shelf" },
          ],
        },
        {
          id: "back",
          label: "奥",
          background: "room_y.png",
          spots: [{ id: "eye", label: "目", rect: { x: 10, y: 300, width: 100, height: 100 }, target: "#eye", if: "game.seen_shelf" }],
        },
      ],
    },
  },
};

const SOURCE = ["@investigate room", "通り過ぎた", "@stop", "# window", "窓だ", "# shelf", "本棚だ", "# eye", "目がある", "# done", "調べ終えた"].join("\n");

const pages = (host: HeadlessHost) => host.trace.flatMap((t) => (t.type === "page" ? [t.text] : []));

/** 描画側の代わり。answers を順に返す（尽きたら答えない＝画面なしの選び方）。 */
class Player extends HeadlessHost {
  // 遊ぶ人の画面の答えを真似る（自動確認ではない）
  override automated = false;
  readonly shown: Record<string, Value>[] = [];
  constructor(private readonly answers: Value[]) {
    super({ loadSource: async () => SOURCE, loadData: async (name) => (name === "investigation.json" ? DATA : undefined) });
  }
  override async present(event: PresentEvent) {
    await super.present(event);
    if (event.type === "command" && event.name === "investigate") {
      this.shown.push(event.args);
      return this.answers.shift() ?? null;
    }
  }
}

describe("@investigate", () => {
  it("押した場所の場面を呼び、次のラベルで戻り、必須の場所を調べ終えたら done へ", async () => {
    const host = new Player([{ action: "spot", view: "front", spot: "window" }, { action: "spot", view: "front", spot: "shelf" }]);
    const runtime = new Runtime(host, { commands: implementations, cg: (folder, image) => folder === "bgimage" && image === "room_h.png" });
    await runtime.start("a");
    // 窓 → 本棚 → （本棚で目が出る）画面なしの既定で目 → 必須を調べ終えて done
    expect(pages(host)).toEqual(["窓だ", "本棚だ", "目がある", "調べ終えた"]);
    expect(runtime.state.game.seen_shelf).toBe(true);
    expect(runtime.state.game["@investigation"]).toEqual({ room: { window: true, shelf: true, eye: true } });
    expect(runtime.state.callStack).toEqual([]);
    // 二度目の画面では本棚を調べた印が付き、目は条件が真になって出る
    expect(host.shown[2]!.examined).toEqual(["window", "shelf"]);
    expect(host.shown[2]!.visible).toEqual({ front: ["window", "shelf"], back: ["eye"] });
    // 出した視点の背景を CG として解放する
    expect(runtime.system.cg_unlocked).toEqual({ "room_h.png": true });
  });

  it("画面なしでも、必須の場所を順に調べて先へ進む", async () => {
    const host = new Player([]);
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("a");
    expect(pages(host)).toEqual(["本棚だ", "目がある", "調べ終えた"]);
  });

  it("地図の矢印に、場所の場面と完了の飛び先を教える", () => {
    const def = commands.find((c) => c.name === "investigate")!;
    expect(def.targets!({ id: "room" }, () => DATA)).toEqual({ targets: ["a#window", "a#shelf", "a#eye", "a#done"], leaves: true });
  });

  it("宣言で data/investigation.json を確かめる", () => {
    const scripts = new Map([["a", parse(SOURCE, "a")]]);
    const bad = structuredClone(DATA) as { places: { room: { views: { spots: { target: string }[] }[] } } };
    bad.places.room.views[0]!.spots[0]!.target = "#nowhere";
    const d = checkData(I.INVESTIGATION_DATA, bad, { fileName: "data/investigation.json", labels: scriptLabels(scripts), assetExists: () => true });
    expect(d.map((x) => x.code)).toEqual(["data-unknown-scene"]);
    // lim check と同じ流れ（runPluginChecks）でも出る。本棚のフラグは目の条件が読むので、読まれないフラグにはならない
    const all = runPluginChecks([std], {
      root: "/",
      config: {},
      scripts,
      text: () => SOURCE,
      cast: {},
      speakers: [],
      registry,
      data: (name) => (name === "investigation.json" ? bad : undefined),
      assetExists: () => false,
    });
    expect(all.map((x) => x.code).sort()).toEqual(["data-missing-asset", "data-missing-asset", "data-unknown-scene"]);
  });
});

const DATA2 = {
  places: {
    room: {
      title: "部屋",
      opening: "はじめの部屋",
      file: "b",
      finish: "button",
      incomplete: "#giveup",
      hitScale: 0.5,
      views: [
        {
          id: "haru",
          label: "ハル",
          face: "faces/haru.png",
          background: "room_h.png",
          spots: [{ id: "desk", label: "机", rect: { x: 0, y: 0, width: 100, height: 100 }, target: "#desk", again: "#desk2" }],
        },
        {
          id: "yuika",
          label: "ユイカ",
          background: "room_y.png",
          enter: "#yuika_in",
          enterFlag: "yuika_in",
          end: "#yuika_end",
          spots: [{ id: "bed", label: "寝台", rect: { x: 200, y: 0, width: 100, height: 100 }, target: "#bed" }],
        },
      ],
    },
  },
  maps: {
    town: {
      file: "b",
      background: "town.png",
      spots: [
        { id: "station", label: "駅", rect: { x: 0, y: 0, width: 50, height: 50 }, target: "#station", desc: "人が多い。" } as Record<string, unknown>,
        { id: "park", label: "公園", rect: { x: 100, y: 0, width: 50, height: 50 }, locked: "!game.key" },
        { id: "home", label: "家", rect: { x: 200, y: 0, width: 50, height: 50 }, if: "game.key" },
      ],
    },
  },
};

const SOURCE2 = [
  "@investigate room",
  "@stop",
  "# desk",
  "@if temp.first_visit",
  "初めての机",
  "@else",
  "また机",
  "@end",
  "# desk2",
  "二度目の机",
  "# yuika_in",
  "ユイカの目に替わった",
  "# bed",
  "寝台だ",
  "# yuika_end",
  "まだ早い",
  "@stop",
  "# giveup",
  "あきらめた",
  "@stop",
  "# map",
  "@map-choice town result=temp.where",
  "地図のあと",
  "@stop",
  "# station",
  "駅に着いた",
].join("\n");

class Player2 extends HeadlessHost {
  // 人が画面で選んだ答えを返す描画側の代わり（自動確認の autoplay では進めない）
  override automated = false;
  readonly shown: { name: string; args: Record<string, Value> }[] = [];
  constructor(
    private readonly answers: Value[],
    data: unknown = DATA2,
  ) {
    super({ loadSource: async () => SOURCE2, loadData: async (name) => (name === "investigation.json" ? data : undefined) });
  }
  override async present(event: PresentEvent) {
    await super.present(event);
    if (event.type === "command" && (event.name === "investigate" || event.name === "map-choice")) {
      this.shown.push({ name: event.name, args: event.args });
      return this.answers.shift() ?? null;
    }
  }
}

describe("@investigate の視点・初回と再訪・調べ足りないまま終える", () => {
  it("初めて入る視点の場面を呼んで同じ視点で戻り、二度目の場所は again、扉の題は初めの一度だけ", async () => {
    const host = new Player2([
      { action: "spot", view: "haru", spot: "desk" },
      { action: "spot", view: "haru", spot: "desk" },
      { action: "enter", view: "yuika" },
      { action: "finish", view: "yuika" },
    ]);
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("b");
    expect(pages(host)).toEqual(["初めての机", "二度目の机", "ユイカの目に替わった", "まだ早い"]);
    // 扉の題は初めて開いたときだけ。入った視点と、場面から戻ったときの視点
    expect(host.shown.map((s) => s.args.openingTitle ?? "")).toEqual(["はじめの部屋", "", "", ""]);
    expect(host.shown[3]!.args.view).toBe("yuika");
    expect(host.shown[3]!.args.entered).toEqual(["yuika"]);
    expect(runtime.state.game.yuika_in).toBe(true);
    // 調べ足りないまま終えたら、場所の様子（最後の視点・扉の題）は消す
    expect((runtime.state.game["@investigation-state"] as Record<string, Record<string, Value>>).room).toEqual({ entered: { yuika: true } });
  });

  it("視点の end が無ければ場所の incomplete へ。終える前でも「調べ終える」を答えにできる", async () => {
    const host = new Player2([{ action: "finish", view: "haru" }]);
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("b");
    expect(pages(host)).toEqual(["あきらめた"]);
  });

  it("地図の矢印に二度目の場面・初めて入る場面・終わりの飛び先も入れ、当たり判定を縮める", () => {
    const def = commands.find((c) => c.name === "investigate")!;
    expect(def.targets!({ id: "room" }, () => DATA2).targets.sort()).toEqual(["b#bed", "b#desk", "b#desk2", "b#giveup", "b#yuika_end", "b#yuika_in"]);
    // 完了の飛び先が無いと、調べ終えたあとは次の行へ進める（incomplete・視点の end だけでは leaves にならない）
    expect(def.targets!({ id: "room" }, () => DATA2).leaves).toBe(false);
    const done = structuredClone(DATA2);
    (done.places.room as Record<string, unknown>).done = "#clear";
    expect(def.targets!({ id: "room" }, () => done).leaves).toBe(true);
    expect(I.hitRect({ x: 0, y: 0, width: 100, height: 40 }, 0.5)).toEqual({ x: 25, y: 10, width: 50, height: 20 });
    expect(I.hitRect({ x: 0, y: 0, width: 100, height: 40 }, undefined)).toEqual({ x: 0, y: 0, width: 100, height: 40 });
  });
});

describe("@map-choice", () => {
  it("選んだ地点の id を result に入れて飛ぶ。押せない地点と条件で出さない地点は選べない", async () => {
    const host = new Player2(["park"]);
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("b#map");
    // park は押せない（答えにならない）ので、画面なしの既定（押せる最初）の station
    expect(host.shown[0]!.args.visible).toEqual(["station", "park"]);
    expect(host.shown[0]!.args.locked).toEqual(["park"]);
    expect(pages(host)).toEqual(["駅に着いた"]);
    expect(runtime.state.temp.where).toBe("station");
  });

  it("説明の欄の下に入って押せない地点を、構文チェックが警告する（欄の位置と作品の画面の大きさで見る）", () => {
    const at = (x: number, y: number) => ({ x: x - 25, y: y - 25, width: 50, height: 50 });
    let lines = new Map<string, number>();
    const data = (panel: string | undefined, screen?: { width: number; height: number }) => {
      const map = {
        file: "b",
        background: "town.png",
        ...(panel ? { panel } : {}),
        spots: [
          { id: "west", label: "西", rect: at(100, 300) },
          { id: "east", label: "東", rect: at(1000, 300) },
          { id: "south", label: "南", rect: at(640, 650) },
        ],
      };
      const text = JSON.stringify({ maps: { town: map } }, null, 2);
      lines = jsonLines(text);
      const scripts = new Map([["b", parse("@map-choice town\n@stop", "b")]]);
      return runPluginChecks([std], {
        root: "/",
        config: screen ? { screen } : {},
        scripts,
        text: () => "",
        cast: {},
        speakers: [],
        registry,
        data: (name) => (name === "investigation.json" ? JSON.parse(text) : undefined),
        dataText: (name) => (name === "investigation.json" ? text : undefined),
        assetExists: () => true,
      })
        .filter((d) => d.code === "map-spot-hidden")
        .map((d) => `${d.file}:${d.line} ${d.message}`);
    };
    // 既定（右）: x=1000 の地点は欄（右から 24px、幅 30%）の下
    expect(data(undefined)).toEqual([`data/investigation.json:${lines.get("/maps/town/spots/1")} 地図 town の地点 east（東）が説明の欄の下に入り、押せません`]);
    expect(data("left").map((x) => x.replace(/:\d+ /, " "))).toEqual(["data/investigation.json 地図 town の地点 west（西）が説明の欄の下に入り、押せません"]);
    expect(data("bottom").map((x) => x.replace(/:\d+ /, " "))).toEqual(["data/investigation.json 地図 town の地点 south（南）が説明の欄の下に入り、押せません"]);
    // 画面が大きい作品は、欄の余白も同じ割合で大きい（1920×1080 では x=1500 が欄の下、x=1000 は外）
    expect(data(undefined, { width: 1920, height: 1080 })).toEqual([]);
    // 縦長の作品は panel によらず下に左右いっぱい（中身の高さは多くて 40%）。右の欄なら下に入る南（y=650）も、下の欄の上なので押せる
    const portrait = { width: 720, height: 1280 };
    expect(mapPanelRect("right", portrait)).toEqual({ x: 24, y: 1280 - 24 - (1280 * 0.4 + 41), width: 720 - 48, height: 1280 * 0.4 + 41 });
    expect(mapPanelRect(undefined, portrait)).toEqual(mapPanelRect("left", portrait));
    expect(data("right", portrait)).toEqual([]);
  });

  it("飛び先の無い地点は次の行へ進み、地図の矢印は飛び先のある地点だけ", async () => {
    const data = structuredClone(DATA2);
    delete data.maps.town.spots[0]!.target;
    const def = commands.find((c) => c.name === "map-choice")!;
    expect(def.targets!({ id: "town" }, () => DATA2)).toEqual({ targets: ["b#station"], leaves: false });
    const host = new Player2(["station"], data);
    const runtime = new Runtime(host, { commands: implementations });
    await runtime.start("b#map");
    expect(pages(host)).toEqual(["地図のあと"]);
    expect(runtime.state.temp.where).toBe("station");
  });
});
