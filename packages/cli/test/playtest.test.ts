import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_SOURCE, latestBrowserBuild, printRun, serveFolder, type PlaytestRun } from "../src/commands/playtest.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-playtest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lim playtest", () => {
  it("書き出したフォルダを返すサーバーは範囲指定に答え、外のファイルは返さない", async () => {
    mkdirSync(join(dir, "web", "assets"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<p>");
    writeFileSync(join(dir, "web", "assets", "a.ogg"), "0123456789");
    writeFileSync(join(dir, "secret.txt"), "no");
    const { server, url } = await serveFolder(join(dir, "web"));
    try {
      const part = await fetch(`${url}assets/a.ogg`, { headers: { range: "bytes=2-4" } });
      expect(part.status).toBe(206);
      expect(await part.text()).toBe("234");
      expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
      const head = await fetch(`${url}assets/a.ogg`, { method: "HEAD", headers: { range: "bytes=-2" } });
      expect(head.headers.get("content-length")).toBe("2");
      expect(await head.text()).toBe("");
      const beyond = await fetch(`${url}assets/a.ogg`, { headers: { range: "bytes=15-" } });
      expect(beyond.status).toBe(416);
      expect(part.headers.get("content-type")).toBe("audio/ogg");
      expect((await fetch(url)).headers.get("content-type")).toContain("text/html");
      expect((await fetch(`${url}..%2Fsecret.txt`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("一番新しいブラウザ版を探し、送りの手順はそのままページで動く JavaScript", () => {
    mkdirSync(join(dir, "browser", "game"), { recursive: true });
    writeFileSync(join(dir, "browser", "game", "index.html"), "");
    mkdirSync(join(dir, "browser", "not-a-build"), { recursive: true });
    expect(latestBrowserBuild(dir)).toBe(join(dir, "browser", "game"));
    expect(latestBrowserBuild(join(dir, "none"))).toBeNull();
    // 書き換えで __name などが混ざらないこと（文字のままページに渡す）
    expect(() => new Function(`return (${DRIVE_SOURCE})`)()).not.toThrow();
    expect(DRIVE_SOURCE).not.toContain("__name");
  });

  it("結果は --lang en で英語で出す（既定は日本語）", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const stuck: PlaytestRun = { run: 1, outcome: "stuck", pages: 1, choices: ["Go"], at: "start:3", errors: ["boom"], seconds: 2.5, shot: "out/run-2.png" };
      printRun(stuck, dir, true);
      const { shot: _shot, ...rest } = stuck;
      printRun({ ...rest, run: 2, outcome: "ended", pages: 12, choices: [], errors: [], at: null }, dir, true);
      printRun(stuck, dir);
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        "Run 2: pages stopped advancing (1 page, 1 choice, 2.5 s)",
        "  Stopped at: start:3",
        "  Chose: Go",
        "  Error: boom",
        "  Screenshot: out/run-2.png",
        "Run 3: played to the end (12 pages, 0 choices, 2.5 s)",
        "2 通り目: ページが進まなくなりました（1 ページ、選択肢 1 回、2.5 秒）",
        "  止まった所: start:3",
        "  選んだもの: Go",
        "  エラー: boom",
        "  画面: out/run-2.png",
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
