import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import type { ViteDevServer } from "vite";
import { CHROMIUM_MISSING_STATUS, STUDIO_API, type ProfileEvent, type ShotResult, type StreamLine } from "../src/protocol.ts";
import { ChromiumMissingError, findChromium, setBrowserProvider, type BrowserPage, type BrowserProvider } from "../src/server/browser.ts";
import { studioServer } from "../src/server/index.ts";
import { measureProfile, profileEvents } from "../src/server/profile.ts";
import { readShot, saveShot, shotBaseName, uniqueShotName } from "../src/server/shot.ts";
import { resolveShotTarget } from "../src/server/target.ts";

/**
 * 画面写真（POST /shot）と重さの計測（POST /profile）の開発サーバー側。ブラウザ（server/browser.ts の BrowserProvider）は偽物に差し替える。
 * 本物の Chromium・Electron で撮る・計るのは、画面での確かめ（docs/studio.md）で行う。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
/** 1×1 の PNG。 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let dir: string;
let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "liminalia-shot-"));
  dir = join(work, "p");
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => setBrowserProvider(null));

describe("画面写真の名前", () => {
  it("ファイルと行から作り、入れ子のフォルダと使えない文字は _ にする", () => {
    expect(shotBaseName("start", 33)).toBe("start-33");
    expect(shotBaseName("part1/chapter2", 5)).toBe("part1_chapter2-5");
    expect(shotBaseName('a:b*c?"d', 1)).toBe("a_b_c__d-1");
    expect(shotBaseName("../x", 2)).toBe("__x-2");
  });

  it("あるものは上書きせず、-2・-3… を付ける", () => {
    const d = join(work, "names");
    mkdirSync(d, { recursive: true });
    expect(uniqueShotName(d, "start-3")).toBe("start-3.png");
    writeFileSync(join(d, "start-3.png"), "");
    expect(uniqueShotName(d, "start-3")).toBe("start-3-2.png");
    writeFileSync(join(d, "start-3-2.png"), "");
    expect(uniqueShotName(d, "start-3")).toBe("start-3-3.png");
  });

  it("exports/shots に書き、二度目は別の名前にする（前のものはそのまま）", () => {
    const root = join(work, "save");
    const a = saveShot(root, "start", 10, PNG);
    const b = saveShot(root, "start", 10, Buffer.from("second"));
    expect(a.path).toBe("exports/shots/start-10.png");
    expect(b.path).toBe("exports/shots/start-10-2.png");
    expect(readFileSync(join(root, a.path))).toEqual(PNG);
    expect(readShot(root, "start-10.png")).toEqual(PNG);
    expect(() => readShot(root, "../liminalia.json")).toThrow(/名前/);
    expect(() => readShot(root, "nothing.png")).toThrow(/見つかりません/);
  });
});

describe("開始位置", () => {
  it("ファイル・ラベルを確かめ、無ければ 400 で、あるものを挙げる", () => {
    const project = loadProject(TEMPLATE);
    expect(resolveShotTarget(project, "start.lim")).toBe("start");
    expect(resolveShotTarget(project, "scenario/start.lim#start")).toBe("start#start");
    let error: unknown = null;
    try {
      resolveShotTarget(project, "nothing");
    } catch (e) {
      error = e;
    }
    expect((error as { status?: number }).status).toBe(400);
    expect((error as Error).message).toMatch(/シナリオ nothing がありません（あるのは .*start/);
  });
});

describe("Chromium を探す", () => {
  it("LIMINALIA_CHROMIUM が無いファイルなら、入れ方を添えて断る（424）", () => {
    const before = process.env.LIMINALIA_CHROMIUM;
    process.env.LIMINALIA_CHROMIUM = join(work, "no-such-chrome");
    try {
      expect(() => findChromium()).toThrow(ChromiumMissingError);
      expect(() => findChromium()).toThrow(/npx playwright install chromium-headless-shell/);
      expect(new ChromiumMissingError("x").status).toBe(CHROMIUM_MISSING_STATUS);
    } finally {
      if (before === undefined) delete process.env.LIMINALIA_CHROMIUM;
      else process.env.LIMINALIA_CHROMIUM = before;
    }
  });
});

// ---- 計測の進め方（ページの中で呼ぶ関数を、偽のゲームの window で動かす） ----

/** ページを送ると進む偽のゲーム（3 ページ目で選択肢、6 ページで終わり）。 */
function fakeGame() {
  let pages = 1;
  let choosing = false;
  const game = {
    __liminalia: {
      ended: false,
      host: { waiting: true, advance: () => step() },
      system: { status: { choosing: false } },
      pages: () => pages,
      runtime: () => ({ at: { file: "start", line: 20 + pages } }),
    },
    __liminaliaPerf: {
      reset: () => {},
      start: () => {},
      snapshot: () => ({
        elapsed: 0,
        fps: 60 - pages,
        frames: { count: pages * 30, long: pages > 4 ? 1 : 0, longest: 40 },
        longTasks: null,
        memory: { used: pages * 1_000_000, total: 0, limit: 4_000_000_000 },
        resources: { image: { count: pages, bytes: 100 }, audio: { count: 1, bytes: 10 }, video: { count: 0, bytes: 0 }, font: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } },
        slowest: [{ name: "bgimage/a.webp", kind: "image" as const, ms: 12, bytes: 100 }],
        dom: 80 + pages,
      }),
    },
  };
  const step = () => {
    if (pages >= 6) {
      game.__liminalia.ended = true;
      return;
    }
    pages++;
    choosing = pages === 3;
    game.__liminalia.system.status.choosing = choosing;
  };
  const document = {
    querySelectorAll: () => [{ click: () => ((choosing = false), (game.__liminalia.system.status.choosing = false), step()) }],
  };
  return { game, document };
}

function fakePage(sim: ReturnType<typeof fakeGame>, log: string[] = []): BrowserPage {
  const g = globalThis as Record<string, unknown>;
  const run = async <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
    g.window = sim.game;
    g.document = sim.document;
    try {
      return await fn(arg);
    } finally {
      delete g.window;
      delete g.document;
    }
  };
  return {
    evaluate: run,
    waitFor: async (fn, arg) => {
      if (!(await run(fn, arg))) throw new Error("待ちが解けない");
    },
    screenshot: async () => PNG,
    close: async () => void log.push("close"),
  };
}

describe("重さの計測", () => {
  it("ページを送りながら取り、選択肢は選んで進み、ページの数で止める", async () => {
    const progress: string[] = [];
    const r = await measureProfile(fakePage(fakeGame()), "start", { pages: 4, wait: 0, choose: [], progress: (p, n, at) => progress.push(`${p}/${n} ${at}`) });
    expect(r.samples.map((s) => s.page)).toEqual([1, 2, 3, 4]);
    expect(progress.at(-1)).toBe("4/4 start:24");
    expect(r.summary.fps).toEqual({ average: 58, min: 56 });
    expect(r.summary.dom.max).toBe(84);
    expect(r.summary.slowest[0]!.name).toBe("bgimage/a.webp");
  });

  it("終わりまで来たら、ページの数に足りなくても止める", async () => {
    const r = await measureProfile(fakePage(fakeGame()), "start", { pages: 30, wait: 0, choose: [] });
    expect(r.samples.at(-1)!.page).toBe(6);
  });

  it("profileEvents: 進み具合と結果を出し、計測.md・計測.json を exports/profile に書いて、ページを閉じる", async () => {
    const root = join(work, "events");
    const log: string[] = [];
    const opened: string[] = [];
    const provider: BrowserProvider = {
      open: async (url) => {
        opened.push(url);
        return fakePage(fakeGame(), log);
      },
    };
    const events: ProfileEvent[] = [];
    for await (const e of profileEvents({ provider, base: "http://127.0.0.1:5180", root, size: { width: 1280, height: 720 }, target: "start#start", pages: 3, signal: new AbortController().signal })) events.push(e);
    expect(opened).toEqual(["http://127.0.0.1:5180/?start=start%23start&autostart=1"]);
    // 選択肢で選んだあとの同じページも知らせる（計り終わりはページの数で止める）
    expect([...new Set(events.filter((e) => e.type === "progress").map((e) => e.type === "progress" && e.page))]).toEqual([1, 2, 3]);
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.type === "done" && done.folder).toBe("exports/profile");
    expect(readFileSync(join(root, "exports/profile/計測.md"), "utf8")).toContain("# パフォーマンス計測（start#start から ");
    expect(JSON.parse(readFileSync(join(root, "exports/profile/計測.json"), "utf8")).target).toBe("start#start");
    expect(log).toContain("close");
  });

  it("profileEvents: 止めたら何も書かずに終わる", async () => {
    const root = join(work, "cancel");
    const abort = new AbortController();
    const provider: BrowserProvider = { open: async () => fakePage(fakeGame()) };
    const events: ProfileEvent[] = [];
    for await (const e of profileEvents({ provider, base: "http://x", root, size: { width: 1, height: 1 }, target: "start", pages: 5, signal: abort.signal })) {
      events.push(e);
      abort.abort();
    }
    expect(events.length).toBeLessThanOrEqual(2);
    expect(existsSync(join(root, "exports/profile"))).toBe(false);
  });
});

// ---- 開発サーバーの口 ----

describe("POST /shot・POST /profile", () => {
  let http: Server;
  let base: string;
  beforeAll(async () => {
    type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
    let middleware: Middleware | null = null;
    const fake = {
      watcher: { add: () => {}, on: () => {} },
      middlewares: { use: (fn: Middleware) => (middleware = fn) },
      ws: { send: () => {} },
      transformIndexHtml: async (_url: string, html: string) => html,
      config: { logger: { error: () => {}, info: () => {} } },
    };
    const plugin = studioServer(loadProject(dir), dir);
    (plugin.configureServer as (s: ViteDevServer) => void)(fake as unknown as ViteDevServer);
    http = createServer((req, res) => middleware!(req, res, () => ((res.statusCode = 404), res.end())));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => http.close(r));
  });
  const post = (path: string, body: unknown) => fetch(`${base}${STUDIO_API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const still = { type: "liminalia:stage-still", stage: { bg: null } } as const;

  it("舞台に頼んだものをそのまま頼み、作品の大きさで開いて撮り、名前を重ねずに書く", async () => {
    const calls: { url: string; size: unknown; args: unknown[] } = { url: "", size: null, args: [] };
    setBrowserProvider({
      open: async (url, size) => {
        calls.url = url;
        calls.size = size;
        return { evaluate: async (_fn, arg) => void calls.args.push(arg) as never, waitFor: async () => {}, screenshot: async () => PNG, close: async () => {} };
      },
    });
    const a = (await (await post("/shot", { file: "start", line: 12, show: still })).json()) as ShotResult;
    const b = (await (await post("/shot", { file: "start", line: 12, show: still })).json()) as ShotResult;
    expect(calls.url).toBe(`${base}/?studio=1`);
    expect(calls.size).toEqual({ width: 1280, height: 720 });
    expect(calls.args).toContainEqual({ file: "start", line: 12, show: still });
    expect([a.path, b.path]).toEqual(["exports/shots/start-12.png", "exports/shots/start-12-2.png"]);
    expect(a.width).toBe(1280);
    const file = await fetch(`${base}${STUDIO_API}/shots/file?name=start-12.png`);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it("頼み方が違えば 400、Chromium が無ければ 424", async () => {
    expect((await post("/shot", { file: "start", line: 1, show: { type: "liminalia:stage-pause" } })).status).toBe(400);
    setBrowserProvider({
      open: async () => {
        throw new ChromiumMissingError("テスト");
      },
    });
    const r = await post("/shot", { file: "start", line: 1, show: still });
    expect(r.status).toBe(CHROMIUM_MISSING_STATUS);
  });

  it("POST /shot/play は lim shot と同じ開き方で撮って PNG を返し、ファイルには書かない。GET /server は作品を名乗る", async () => {
    const opened: { url: string; size: unknown; waits: unknown[] }[] = [];
    setBrowserProvider({
      open: async (url, size) => {
        const o = { url, size, waits: [] as unknown[] };
        opened.push(o);
        return { evaluate: async () => undefined as never, waitFor: async (_fn, arg) => void o.waits.push(arg), screenshot: async () => PNG, close: async () => {} };
      },
    });
    const r = await post("/shot/play", { start: "start.lim#start", skip: 2 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG);
    expect((await post("/shot/play", { title: true })).status).toBe(200);
    expect((await post("/shot/play", { title: true, lang: "en" })).status).toBe(200);
    expect(opened.map((o) => o.url)).toEqual([`${base}/?start=start%23start&skip=2&autostart=1&autoplay=shot`, `${base}/?autostart=1`, `${base}/?autostart=1&lang=en`]);
    expect(opened[0]!.size).toEqual({ width: 1280, height: 720 });
    // 進めるページの数まで待つ
    expect(opened[0]!.waits).toContain(2);
    expect(existsSync(join(dir, "exports/shots/start-0.png"))).toBe(false);
    expect((await post("/shot/play", {})).status).toBe(400);
    expect((await post("/shot/play", { title: true, lang: 1 })).status).toBe(400);
    expect((await post("/shot/play", { start: "nothing" })).status).toBe(400);
    // 撮る所より前の選択肢で止まったら、待たずに断る（撮影は選択肢を選ばない）
    setBrowserProvider({
      open: async () => ({ evaluate: async () => ({ blocked: "choice", pages: 1 }) as never, waitFor: async () => {}, screenshot: async () => PNG, close: async () => {} }),
    });
    const blocked = await post("/shot/play", { start: "start", skip: 3 });
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { error: string }).error).toContain("3 ページ目より前の選択肢で止まりました");
    const me = (await (await fetch(`${base}${STUDIO_API}/server`)).json()) as { root: string; pid: number };
    expect(me).toEqual({ root: loadProject(dir).root, pid: process.pid });
  });

  it("POST /profile は進み具合と結果を一行ずつ流す。開始位置が無ければ 400", async () => {
    setBrowserProvider({ open: async () => fakePage(fakeGame()) });
    const r = await post("/profile", { pages: 2, target: "start" });
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as StreamLine);
    const events = lines.map((l) => ("event" in l ? (l.event as ProfileEvent).type : "error"));
    expect(events).toEqual(["progress", "progress", "done"]);
    expect(existsSync(join(dir, "exports/profile/計測.md"))).toBe(true);
    const bad = await post("/profile", { pages: 2, target: "nothing" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/シナリオ nothing がありません/);
    expect((await post("/profile", { pages: 0 })).status).toBe(400);
  });
});
