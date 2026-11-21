import { describe, expect, it } from "vitest";
import { applyFix, applyLinesFix, check, CORE_COMMANDS, createRegistry, parse, withCommandDefaults, type CommandDefaults, type Diagnostic } from "../src/index.ts";

const run = (text: string, defaults?: CommandDefaults): Diagnostic[] => {
  const registry = withCommandDefaults(createRegistry(CORE_COMMANDS), defaults);
  return check(parse(text, "a"), { registry }).filter((d) => d.code === "same-as-default" || d.code === "scene-change-candidate" || d.code === "scene-change-sprite-overlap");
};

/** 直し方を当てた台本。 */
function fixed(text: string, d: Diagnostic): string {
  const rows = text.split("\n");
  const fix = d.fix!;
  if (fix.kind === "replace-lines") {
    const r = applyLinesFix(rows, d.line - 1, fix)!;
    rows.splice(d.line - 1, r.count, r.text);
    return rows.join("\n");
  }
  const r = applyFix(rows[d.line - 1]!, fix, d.column);
  if (!r || r.remove) throw new Error("当てられません");
  rows[d.line - 1] = r.text;
  return rows.join("\n");
}

describe("作品の既定値と同じパラメータ（same-as-default）", () => {
  const defaults: CommandDefaults = { bg: { fade: "500ms" }, chara: { fade: "400ms", appearance: "uniform" } };

  it("commandDefaults と同じ値を情報で知らせ、外す直し方を付ける（0.5s と 500ms は同じ）", () => {
    const text = "@bg room.jpg time=0.5s\n@bg room.jpg time=1s\n@chara yui time=400ms";
    const found = run(text, defaults);
    expect(found.map((d) => `${d.line} ${d.severity}`)).toEqual(["1 info", "3 info"]);
    expect(fixed(text, found[0]!).split("\n")[0]).toBe("@bg room.jpg");
    expect(fixed(text, found[1]!).split("\n")[2]).toBe("@chara yui");
  });

  it("組み込みの既定値と同じ値は知らせない（作品の既定値だけ）。式も見ない", () => {
    expect(run("@bg room.jpg time=0ms\n@bg room.jpg time=(1)", { bg: { fade: "1ms" } })).toEqual([]);
    expect(run("@bg room.jpg time=0ms")).toEqual([]);
  });
});

describe("@mask の塊を @scene-change に（scene-change-candidate）", () => {
  it("暗転前の全消し・暗転・待機・明転を、同時に消す場面転換へまとめる", () => {
    const text = ["ユイカ「……うん」", "返事。", "@chara-hide-all time=300ms", "@mask time=1500ms", "@wait 500ms", "@mask-off time=1500ms"].join("\n");
    const [d] = run(text);
    expect(d).toMatchObject({ line: 3, severity: "info", code: "scene-change-candidate" });
    expect(fixed(text, d!)).toBe(["ユイカ「……うん」", "返事。", "@scene-change time=1500ms hold=500ms hide-window-at=covered hide-chara-at=start hide-fade=300ms"].join("\n"));
    expect(run(fixed(text, d!))).toEqual([]);
  });

  it("全消しと直後の場面転換も、フェードを保って一行にする", () => {
    const text = "@chara-hide-all time=300ms\n@scene-change time=1s hold=500ms hide-window=true";
    const [d] = run(text);
    expect(d).toMatchObject({ line: 1, severity: "info", code: "scene-change-candidate" });
    expect(fixed(text, d!)).toBe("@scene-change time=1s hold=500ms hide-window=true hide-chara-at=start hide-fade=300ms");
    expect(run(fixed(text, d!))).toEqual([]);
    expect(run("@chara-hide-all time=300ms wait=true\n@scene-change time=1s")).toEqual([]);
    expect(run("@chara-hide-all time=300ms\n@scene-change hide-who=ユイ")).toEqual([]);
    expect(run("@chara-hide-all time=300ms\n@scene-change hide-chara=false")).toEqual([]);
  });

  it("同じ一人を消す場面転換なら退場とまとめ、ほかの人物も消す場合はまとめない", () => {
    const text = "@chara-hide ユイ time=300ms\n@scene-change time=1s hide-who=ユイ";
    const [d] = run(text);
    expect(d).toMatchObject({ line: 1, severity: "info", code: "scene-change-candidate" });
    expect(fixed(text, d!)).toBe("@scene-change time=1s hide-who=ユイ hide-chara-at=start hide-fade=300ms");
    expect(run("@chara-hide ユイ time=300ms\n@scene-change time=1s")).toEqual([]);
    expect(run("@chara-hide ユイ time=300ms\n@scene-change time=1s hide-who=レン")).toEqual([]);
  });

  it("待機のスキップや場面転換の既定値で挙動が変わる場合はまとめない", () => {
    const base = ["@chara-hide-all time=300ms", "@mask time=1500ms", "@wait 500ms", "@mask-off time=1500ms"];
    expect(run(base.join("\n"), { wait: { skip: "false" } })).toEqual([]);
    expect(run(base.join("\n"), { "scene-change": { "bg-color": "#ffffff" } })).toEqual([]);
    expect(run([...base.slice(0, 2), "@wait 500ms skip=false", base[3]!].join("\n"))).toEqual([]);
    expect(run(base.slice(1).join("\n"))).toEqual([]);
    const retained = ["@chara ユイ", "@scene-change hide-who=レン", "@mask time=1500ms", "@wait 500ms", "@mask-off time=1500ms"].join("\n");
    expect(run(retained)).toEqual([]);
    expect(run(retained.replace("hide-who=レン", "hide-chara=false"))).toEqual([]);
  });
  it("暗転、立ち絵の全消去、背景、明転の塊を一行にする（待つ時間は hold、既定値と同じ値は書かない）", () => {
    const text = ["地の文", "@mask time=1s", "@chara-hide-all time=300ms wait=true", "@bg street.jpg time=500ms", "@mask-off time=1s", "次の地の文"].join("\n");
    const [d] = run(text);
    expect(d).toMatchObject({ line: 2, severity: "info", code: "scene-change-candidate" });
    expect(fixed(text, d!)).toBe(["地の文", "@scene-change street.jpg hold=800ms hide-window-at=covered", "次の地の文"].join("\n"));
  });

  it("時間が違えば fade-out と fade-in、BGM は暗転の直後なら bgm と bgm-fade、hide-window も写す", () => {
    const text = ["@mask time=600ms color=#000 hide-window=false", "@bgm night.ogg time=1s volume=60", "@chara-hide-all", "@bg room.jpg", "@mask-off time=2s"].join("\n");
    const [d] = run(text);
    expect(fixed(text, d!)).toBe("@scene-change room.jpg fade-out=600ms fade-in=2s bgm=night.ogg bgm-volume=60 bgm-fade=1s hide-window=false");
  });

  it("条件の合わない塊は置き換えない", () => {
    const cases = [
      // 背景も全消去も無い
      ["@mask time=1s", "@wait 1s", "@mask-off time=1s"],
      // ほかの命令を挟む
      ["@mask time=1s", "@chara-hide-all", "@bg a.jpg", "@window hide", "@mask-off"],
      // 動き方を指定している
      ["@mask time=1s method=wipe-right", "@chara-hide-all", "@bg a.jpg", "@mask-off"],
      // 黒でない暗転（白い光で照らす演出など）
      ["@mask color=#ffffff time=1s", "@chara-hide-all", "@bg a.jpg", "@mask-off time=1s"],
      // 背景の後ろで BGM を替える
      ["@mask", "@chara-hide-all", "@bg a.jpg time=1s", "@bgm b.ogg", "@mask-off"],
      // 間にコメント
      ["@mask", "@chara-hide-all", "// 背景", "@bg a.jpg", "@mask-off"],
      // 立ち絵が出ているかもしれない（全消去が無い）
      ["@chara yui", "@mask", "@bg a.jpg", "@mask-off"],
    ];
    for (const c of cases) expect(run(c.join("\n")), c.join(" / ")).toEqual([]);
  });

  it("明転中にも前の立ち絵が消え続ける場合は警告し、消し方が変わる候補を出す", () => {
    const text = ["@chara ユイ", "@mask time=2s", "@bg room.png time=100ms", "@chara-hide-all time=100ms", "@mask-off time=2s"].join("\n");
    const [d] = run(text);
    expect(d).toMatchObject({ line: 2, severity: "warning", code: "scene-change-sprite-overlap" });
    expect(d!.hint).toContain("元の消え方は変わります");
    expect(fixed(text, d!)).toBe("@chara ユイ\n@scene-change room.png time=2s hold=100ms hide-window-at=covered");
    expect(run(fixed(text, d!))).toEqual([]);
    expect(run(text.replace("time=100ms\n@mask-off", "time=100ms wait=true\n@mask-off")).some((x) => x.code === "scene-change-sprite-overlap")).toBe(false);
    expect(run(text.replace("@mask-off time=2s", "@mask-off time=0ms"))[0]).toMatchObject({ code: "scene-change-sprite-overlap", severity: "warning" });
    expect(run(text.replace("@bg room.png time=100ms", "@bg room.png time=100ms wait=false"))).toEqual([]);
    expect(run(text.replace("@chara ユイ", "@chara-hide-all")).some((x) => x.code === "scene-change-sprite-overlap")).toBe(false);
  });

  it("全消去の無い塊は、同じ流れの前で立ち絵をすべて消してから出していないときだけ", () => {
    const text = ["@chara-hide-all", "地の文", "@mask time=1s", "@bg a.jpg", "@mask-off time=1s"].join("\n");
    const [d] = run(text);
    expect(fixed(text, d!).split("\n").at(-1)).toBe("@scene-change a.jpg hide-window-at=covered");
    expect(run(["# start", "@mask time=1s", "@bg a.jpg", "@mask-off time=1s"].join("\n"))).toEqual([]);
  });

  it("作品の既定値を重ねて読み、書く値もその既定値と比べる", () => {
    const text = ["@mask time=500ms", "@chara-hide-all", "@bg a.jpg", "@mask-off time=500ms"].join("\n");
    // @bg の既定の fade が 400ms なら、覆っている間の 400ms を hold に
    const [d] = run(text, { bg: { fade: "400ms" }, "scene-change": { fade: "500ms" } });
    expect(fixed(text, d!)).toBe("@scene-change a.jpg hold=400ms hide-window-at=covered");
    const [timing] = run(text, { "scene-change": { "hide-at": "start", "hide-fade": "300ms" } });
    expect(fixed(text, timing!)).toContain("hide-at=covered hide-fade=0ms");
    expect(run(text, { "scene-change": { "hide-who": "ユイ" } })).toEqual([]);
    const [defaults] = run(text, { "scene-change": { "hide-chara": "false", "hide-window-at": "start" } });
    expect(fixed(text, defaults!)).toContain("hide-chara=true");
    expect(fixed(text, defaults!)).toContain("hide-window-at=covered");
  });

  it("書いたあとに行が変わっていれば当てない", () => {
    const text = ["@mask time=1s", "@chara-hide-all", "@bg a.jpg", "@mask-off time=1s"].join("\n");
    const [d] = run(text);
    const rows = text.split("\n");
    rows[2] = "@bg b.jpg";
    expect(applyLinesFix(rows, 0, d!.fix as Extract<Diagnostic["fix"], { kind: "replace-lines" }>)).toBeNull();
    // 空白や書き方の違いだけなら当てる
    rows[2] = "@bg   a.jpg";
    rows[0] = '@mask time="1s"';
    expect(applyLinesFix(rows, 0, d!.fix as Extract<Diagnostic["fix"], { kind: "replace-lines" }>)).toBeNull();
    rows[0] = "  @mask   time=1s";
    expect(applyLinesFix(rows, 0, d!.fix as Extract<Diagnostic["fix"], { kind: "replace-lines" }>)).toEqual({ count: 4, text: "  @scene-change a.jpg hide-window-at=covered" });
  });
});
