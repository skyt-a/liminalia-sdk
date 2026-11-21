import { describe, expect, it } from "vitest";
import type { PlaySweeps } from "@liminalia/editor/play-from";
import { buildPlayFrom, localSweeps, remoteSweeps, runtimeOptions, type LocalProject } from "../src/play-from.ts";
import { playerUrl, playUrl, type PlayAt } from "../src/play-launch.ts";
import { loadCommands, readProjectInfo } from "../src/project.ts";
import { FIXTURE, fixture } from "./helpers.ts";

/** 見本のプロジェクトを、言語サーバーが現在地を作るときの形にする。 */
async function local(): Promise<{ project: LocalProject; texts: Map<string, string> }> {
  const { project } = await fixture();
  const info = readProjectInfo(FIXTURE);
  const loaded = await loadCommands(info, { trusted: true, workspaceFolders: [FIXTURE], node: process.execPath });
  const scripts = new Map([...project.scripts()].map(([name, script]) => [name, { script, text: project.input.files.get(name)!.text }] as const));
  return {
    project: { scripts, registry: project.registry, speakers: project.input.speakers, cast: project.input.cast, implementations: loaded.implementations, config: info.config, data: () => undefined },
    texts: new Map([...scripts].map(([name, s]) => [name, s.text])),
  };
}

describe("ここから遊ぶのセーブ（言語サーバー）", () => {
  it("ほかのファイルで決めた背景と立ち絵を引き継いで、その行から始める", async () => {
    const { project, texts } = await local();
    const r = await buildPlayFrom({ file: "chapter2", text: texts.get("chapter2")!, speakers: project.speakers, line: 2, local: () => localSweeps(project) });
    expect(r).toMatchObject({ line: 2, basis: "line", source: "local" });
    // start.lim の @bg と @chara（chapter2.lim には無い）
    const stage = JSON.stringify(r!.save.stage);
    expect(stage).toContain("room_night.jpg");
    expect(stage).toContain("ユイカ");
    expect(r!.save.position.unit).toBe("chapter2");
  });

  it("今のルートで通らない行は道筋を探し、見つからなければ手前の行の状態から", async () => {
    const { project, texts } = await local();
    // @if game.trust >= 2 の真の枝（trust は初期値も決める行も無いので、条件は誤りになり偽として進み、届かない）
    const r = await buildPlayFrom({ file: "start", text: texts.get("start")!, speakers: project.speakers, line: 20, local: () => localSweeps(project) });
    expect(r).toMatchObject({ line: 20, noRoute: 20, source: "local" });
    expect(JSON.stringify(r!.save.stage)).toContain("room_night.jpg");
  });

  it("作品の自動配置の並べ方（liminalia.json の autoLayout）を実行器に渡す", async () => {
    const { project } = await local();
    expect(runtimeOptions(project).autoLayout).toBeUndefined();
    const ruled = { ...project, config: { ...project.config, autoLayout: { exit: "keep", enter: "nowhere" } } };
    // 知らない値は読まない（構文チェックが知らせる）
    expect(runtimeOptions(ruled).autoLayout).toEqual({ exit: "keep" });
  });

  it("マクロの中からは始められない", async () => {
    const { project, texts } = await local();
    expect(await buildPlayFrom({ file: "common", text: texts.get("common")!, speakers: project.speakers, line: 3, local: () => localSweeps(project) })).toBeNull();
  });

  it("制作画面の現在地を使い、引けなければ言語サーバーの中で作る", async () => {
    const { project, texts } = await local();
    const own = localSweeps(project);
    const calls: string[] = [];
    const studio: PlaySweeps = {
      sweep: async (file, range) => {
        calls.push(`sweep ${file} ${range.from}-${range.to}`);
        return own.sweep(file, range);
      },
      reach: own.reach,
    };
    const r = await buildPlayFrom({ file: "start", text: texts.get("start")!, speakers: project.speakers, line: 7, studio, local: () => own });
    expect(r).toMatchObject({ line: 7, source: "studio" });
    expect(calls).toEqual(["sweep start 1-407"]);
    const broken: PlaySweeps = {
      sweep: async () => {
        throw new Error("404");
      },
      reach: own.reach,
    };
    const logs: string[] = [];
    const back = await buildPlayFrom({ file: "start", text: texts.get("start")!, speakers: project.speakers, line: 7, studio: broken, local: () => own, log: (m) => logs.push(m) });
    expect(back).toMatchObject({ line: 7, source: "local" });
    expect(logs[0]).toContain("404");
  });

  it("開発サーバーの GET /sweep と GET /sweep/reach を引く", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ sweep: null, reason: "unreachable" }), { status: 200 });
    }) as typeof fetch;
    const sweeps = remoteSweeps("http://127.0.0.1:9", fake);
    await sweeps.sweep("part1/a", { from: 1, to: 10 });
    await sweeps.reach("a", 5, { from: 1, to: 10 });
    expect(urls).toEqual(["http://127.0.0.1:9/__liminalia/studio/api/sweep?file=part1%2Fa&from=1&to=10", "http://127.0.0.1:9/__liminalia/studio/api/sweep/reach?file=a&line=5&from=1&to=10"]);
    const missing = remoteSweeps("http://127.0.0.1:9", (async () => new Response("", { status: 404 })) as typeof fetch);
    await expect(missing.sweep("a", { from: 1, to: 2 })).rejects.toThrow("404");
  });
});

describe("ここから遊ぶの URL", () => {
  const at: PlayAt = { root: "/p", file: "start", start: "start#north_road", skip: 2 };
  const built = { save: { position: { unit: "start", index: 3 } } as never, line: 20, basis: "line" as const, source: "local" as const };

  it("組み立てたセーブを開発サーバーに預け、そのページを開く", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    }) as typeof fetch;
    const r = await playUrl({ url: "http://127.0.0.1:5" }, at, built, fake);
    expect(r).toEqual({ url: "http://127.0.0.1:5/__liminalia/studio/api/play-from?id=abc&start=start%23north_road&skip=2", handedOver: true });
    expect(sent).toEqual([{ url: "http://127.0.0.1:5/__liminalia/studio/api/play-from", body: { save: built.save, file: "start", line: 20 } }]);
  });

  it("預けられない（古い開発サーバー）・セーブが無いときは、シーンの頭から早送りする", async () => {
    const old = (async () => new Response("", { status: 404 })) as typeof fetch;
    const legacy = playerUrl({ url: "http://127.0.0.1:5" }, at);
    expect(legacy).toBe("http://127.0.0.1:5/?start=start%23north_road&skip=2");
    expect(await playUrl({ url: "http://127.0.0.1:5" }, at, built, old)).toEqual({ url: legacy, handedOver: false });
    expect(await playUrl({ url: "http://127.0.0.1:5" }, at, null, old)).toEqual({ url: legacy, handedOver: false });
  });
});
