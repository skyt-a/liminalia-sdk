import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STUDIO_API } from "../src/protocol.ts";
import { announceStudio, findRunningStudio, RUNNING_FILE, studioPageUrl } from "../src/server/running.ts";

/** 開いている制作画面の控え（.liminalia/studio-server.json）。開発サーバーは名乗るだけの偽物。 */
describe("開いている制作画面", () => {
  const root = mkdtempSync(join(tmpdir(), "liminalia-running-"));
  let http: Server;
  let url: string;
  let answerRoot = root;
  beforeAll(async () => {
    http = createServer((req, res) => {
      if (req.url === `${STUDIO_API}/server`) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ root: answerRoot, pid: process.pid }));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => http.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it("書いた開発サーバーが同じ作品だと答えれば見つけ、消せば無い", async () => {
    expect(await findRunningStudio(root)).toBeNull();
    const remove = announceStudio(root, `${url}/`, "desktop");
    const found = await findRunningStudio(root);
    expect(found).toMatchObject({ url, app: "desktop", pid: process.pid });
    expect(studioPageUrl(found!.url)).toBe(`${url}/__liminalia/studio`);
    // 違う作品を開いている開発サーバー（番号を使い回した）は無いものとする
    answerRoot = join(root, "other");
    expect(await findRunningStudio(root)).toBeNull();
    answerRoot = root;
    remove();
    expect(existsSync(join(root, RUNNING_FILE))).toBe(false);
  });

  it("プロセスが無い・答えない控えは無いものとし、あとから書いた別の開発サーバーの控えは消さない", async () => {
    writeFileSync(join(root, RUNNING_FILE), JSON.stringify({ url, pid: 2 ** 22 + 12345, app: "cli", root, started: "" }));
    expect(await findRunningStudio(root)).toBeNull();
    writeFileSync(join(root, RUNNING_FILE), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, app: "cli", root, started: "" }));
    expect(await findRunningStudio(root, 500)).toBeNull();
    const remove = announceStudio(root, url, "cli");
    const other = { url: "http://127.0.0.1:1", pid: process.pid, app: "desktop", root, started: "" };
    writeFileSync(join(root, RUNNING_FILE), JSON.stringify(other));
    remove();
    expect(JSON.parse(readFileSync(join(root, RUNNING_FILE), "utf8"))).toEqual(other);
  });
});
