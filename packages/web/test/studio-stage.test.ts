import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerGate, type Timers } from "../src/studio-stage.ts";

/** vitest の偽の時計に、requestAnimationFrame（16ms ごと）を足したもの。 */
function fakeTimers(): Timers {
  return {
    setTimeout: (h, ms, ...args) => setTimeout(h, ms, ...args) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (h, ms, ...args) => setInterval(h, ms, ...args) as unknown as number,
    clearInterval: (id) => clearInterval(id),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
}

describe("止められるタイマー", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("動いている間はそのまま呼ぶ", () => {
    const gate = new TimerGate(fakeTimers(), () => 0);
    const calls: string[] = [];
    gate.timers.setTimeout((a) => calls.push(String(a)), 100, "x");
    vi.advanceTimersByTime(100);
    expect(calls).toEqual(["x"]);
  });

  it("止めている間に時刻の来た呼び出しは控え、再開で来た順に呼ぶ", () => {
    const gate = new TimerGate(fakeTimers(), () => 42);
    const calls: string[] = [];
    gate.timers.setTimeout(() => calls.push("文字送り"), 300);
    gate.timers.setTimeout(() => calls.push("オート"), 100);
    gate.timers.requestAnimationFrame((t) => calls.push(`描画 ${t}`));
    gate.pause();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
    expect(gate.pending).toBe(3);
    gate.resume();
    expect(calls).toEqual(["描画 42", "オート", "文字送り"]);
    expect(gate.pending).toBe(0);
  });

  it("控えたものも取り消せる", () => {
    const gate = new TimerGate(fakeTimers(), () => 0);
    const calls: string[] = [];
    const a = gate.timers.setTimeout(() => calls.push("a"), 10);
    gate.timers.setTimeout(() => calls.push("b"), 10);
    const f = gate.timers.requestAnimationFrame(() => calls.push("f"));
    gate.pause();
    vi.advanceTimersByTime(50);
    gate.timers.clearTimeout(a);
    gate.timers.cancelAnimationFrame(f);
    gate.resume();
    expect(calls).toEqual(["b"]);
  });

  it("繰り返しは止めている間の回を飛ばす", () => {
    const gate = new TimerGate(fakeTimers(), () => 0);
    let n = 0;
    gate.timers.setInterval(() => n++, 100);
    vi.advanceTimersByTime(300);
    gate.pause();
    vi.advanceTimersByTime(1000);
    gate.resume();
    expect(n).toBe(3);
    vi.advanceTimersByTime(100);
    expect(n).toBe(4);
  });

  it("包む前のタイマーは止まらない", () => {
    const gate = new TimerGate(fakeTimers(), () => 0);
    let fired = false;
    gate.pause();
    gate.real.setTimeout(() => (fired = true), 10);
    vi.advanceTimersByTime(10);
    expect(fired).toBe(true);
  });

  it("再開で呼んだものが止め直したら、残りはまた控える。投げても残りは呼ぶ", () => {
    const gate = new TimerGate(fakeTimers(), () => 0);
    const calls: string[] = [];
    gate.timers.setTimeout(() => {
      calls.push("投げる");
      throw new Error("x");
    }, 10);
    gate.timers.setTimeout(() => {
      calls.push("止め直す");
      gate.pause();
    }, 20);
    gate.timers.setTimeout(() => calls.push("残り"), 30);
    gate.pause();
    vi.advanceTimersByTime(50);
    gate.resume();
    expect(calls).toEqual(["投げる", "止め直す"]);
    expect(gate.pending).toBe(1);
    gate.resume();
    expect(calls).toEqual(["投げる", "止め直す", "残り"]);
    // 投げたものは、あとで投げ直す
    expect(() => vi.runOnlyPendingTimers()).toThrow("x");
  });
});
