import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyticsAskable, analyticsConsent, PlayAnalytics, setAnalyticsConsent, type AnalyticsBatch } from "../src/analytics.ts";
import { CrashTrail, crashRecord, TRAIL_SIZE } from "../src/crash.ts";

/** 遊ばれ方の統計（任意。既定は送らない）と、止まったときの記録の中身。 */

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}

const saved = globalThis.localStorage;
beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true });
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: saved, configurable: true });
});

describe("遊ばれ方の統計", () => {
  it("遊ぶ人が答えるまで、送らないと答えたら、何も送らない", () => {
    const sent: string[] = [];
    let consent = analyticsConsent("g") === true;
    const a = new PlayAnalytics({ url: "https://example.com/a", projectId: "g", version: "1.0", platform: "browser", language: () => "", consent: () => consent, send: (_u, body) => sent.push(body) });
    expect(analyticsConsent("g")).toBeNull();
    a.choice({ file: "start", line: 3 }, 0, 2, "start#north");
    a.leave({ file: "start", line: 9 });
    expect(sent).toEqual([]);
    setAnalyticsConsent("g", false);
    consent = analyticsConsent("g") === true;
    a.choice({ file: "start", line: 3 }, 1, 2, null);
    a.leave({ file: "start", line: 9 });
    expect(sent).toEqual([]);
    expect(analyticsConsent("g")).toBe(false);
  });

  it("送ると答えたら、選んだ選択肢とやめた場面をまとめて送る（名前の入る本文は送らない）", () => {
    const sent: { url: string; body: AnalyticsBatch }[] = [];
    setAnalyticsConsent("g", true);
    let t = 1_000_000;
    const a = new PlayAnalytics({ url: "https://example.com/a", projectId: "g", version: "1.0", platform: "desktop", language: () => "en", consent: () => analyticsConsent("g") === true, send: (url, body) => sent.push({ url, body: JSON.parse(body) as AnalyticsBatch }), now: () => t });
    a.choice({ file: "start", line: 3 }, 1, 3, "start#south");
    t += 65_000;
    a.leave({ file: "chapter1", line: 40 });
    // 閉じたときの二つ目の知らせ（pagehide）は、同じ場面なら送らない
    a.leave({ file: "chapter1", line: 40 });
    expect(sent).toHaveLength(1);
    const batch = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://example.com/a");
    expect(batch).toMatchObject({ project: "g", version: "1.0", platform: "desktop", language: "en" });
    expect(batch.session).toMatch(/\S{8,}/);
    expect(batch.events).toEqual([
      { type: "choice", at: "start:3", option: 1, options: 3, target: "start#south", time: 0 },
      { type: "leave", at: "chapter1:40", time: 65 },
    ]);
  });

  it("自動の確かめ（ブラウザの自動操作、自動で進める遊び方）では尋ねず送らない", () => {
    expect(analyticsAskable({ automated: true })).toBe(false);
    expect(analyticsAskable({ automated: false })).toBe(typeof navigator === "undefined" || !navigator.webdriver);
  });
});

describe("止まったときの記録", () => {
  it("何が起きたか（例外とプログラムの位置）と、どの行か（ページ、実行中の命令、直前のページと診断）を残す", () => {
    const trail = new CrashTrail();
    for (let i = 1; i <= TRAIL_SIZE + 2; i++) trail.page({ file: "start", line: i });
    trail.page({ file: "start", line: TRAIL_SIZE + 2 });
    trail.diagnostic({ file: "start", line: 5, code: "missing-asset", message: "素材 bg/a.png がありません" });
    const r = crashRecord({ version: "1.2.0", where: () => "start:12", context: () => ({ step: "start:14", trail, language: "en", build: "2026-11-07T00:00:00.000Z", engine: "0.2.0" }) }, { message: "x is undefined", stack: "TypeError: x is undefined\n    at f (engine/index-abc.js:1:200)", kind: "error", source: "engine/index-abc.js:1:200" });
    expect(r).toMatchObject({ message: "x is undefined", at: "start:12", step: "start:14", kind: "error", source: "engine/index-abc.js:1:200", version: "1.2.0", language: "en", build: "2026-11-07T00:00:00.000Z", engine: "0.2.0" });
    expect(r.trail).toHaveLength(TRAIL_SIZE);
    expect(r.trail!.at(-1)).toBe(`start:${TRAIL_SIZE + 2}`);
    expect(r.diagnostics).toEqual(["start:5 [missing-asset] 素材 bg/a.png がありません"]);
    expect(r.platform).toBe("browser");
  });

  it("様子を集められなくても例外の文は残し、ページと同じ命令の位置は書かない", () => {
    const r = crashRecord({ version: "", where: () => "start:3", context: () => ({ step: "start:3" }) }, { message: "m", stack: "", kind: "rejection" });
    expect(r.step).toBeUndefined();
    const broken = crashRecord({ version: "", where: () => "", context: () => { throw new Error("x"); } }, { message: "m", stack: "", kind: "error" });
    expect(broken.message).toBe("m");
  });
});
