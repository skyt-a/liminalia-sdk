import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, LONG_FRAME, PerfMonitor, resourceKind } from "../src/perf-watch.ts";

describe("重さの計測", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("素材の種類は assets/ のフォルダか拡張子で決める", () => {
    expect(resourceKind("http://localhost:5180/assets/bgimage/room.png")).toBe("image");
    expect(resourceKind("/assets/voice/yui/001.ogg?v=abc")).toBe("audio");
    expect(resourceKind("/assets/others/fonts/a.woff2")).toBe("font");
    expect(resourceKind("/assets/video/op.webm")).toBe("video");
    expect(resourceKind("/assets/image/%E7%B5%B5.webp")).toBe("image");
    expect(resourceKind("/data/notes.txt")).toBe("other");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("フレームを数え、長いフレームと一番長いものを出す。reset で 0 に戻す", () => {
    const callbacks: ((t: number) => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => callbacks.push(cb));
    vi.stubGlobal("document", { getElementsByTagName: () => ({ length: 42 }) });
    const m = new PerfMonitor();
    m.start("test");
    let t = 1000;
    const frame = (delta: number) => {
      t += delta;
      callbacks.shift()!(t);
    };
    frame(0);
    for (let i = 0; i < 60; i++) frame(16);
    frame(LONG_FRAME + 30);
    const s = m.snapshot();
    expect(s.frames).toEqual({ count: 61, long: 1, longest: LONG_FRAME + 30 });
    expect(s.fps).toBeGreaterThan(50);
    expect(s.dom).toBe(42);
    m.reset();
    expect(m.snapshot().frames).toEqual({ count: 0, long: 0, longest: 0 });
    m.stop("test");
    expect(m.snapshot().fps).toBeNull();
  });
});
