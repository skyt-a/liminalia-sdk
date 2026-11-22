import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "@liminalia/project";
import { describe, expect, it } from "vitest";
import { casterServer, type CasterServerOptions } from "../src/caster/server.ts";

type Handler = (req: unknown, res: unknown, next: () => void) => void;

/** 取り込みで作る cast.json の作品（取り込み元のフォルダは手元に無い）。 */
function importedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-caster-"));
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "t", title: "T", version: "1.0.0", entry: "start", import: { tyrano: { source: "../tyrano", profile: "./import-profile" } } }));
  mkdirSync(join(dir, "scenario"));
  writeFileSync(join(dir, "scenario/start.lim"), "一行目\n");
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ speakers: [], cast: {} }));
  mkdirSync(join(dir, "assets/bgimage/room"), { recursive: true });
  return dir;
}

/** 開発サーバーの口を、Node の req/res の最小の形で呼ぶ。 */
function call(dir: string, options: CasterServerOptions, method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let handler: Handler | null = null;
  const server = {
    middlewares: { use: (fn: Handler) => (handler = fn) },
    ws: { send() {} },
    // 取り込み設定のコードは動かせない（スマホ版と同じ）
    ssrLoadModule: () => Promise.reject(new Error("動かせません")),
  };
  (casterServer(loadProject(dir), "/web", options).configureServer as unknown as (s: typeof server) => void)(server);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end: (text: string) => resolve({ status: res.statusCode, body: JSON.parse(text) as Record<string, unknown> }),
    };
    const req = {
      method,
      url,
      headers: { host: "localhost", "content-type": "application/json" },
      on(event: string, fn: (v?: unknown) => void) {
        if (event === "data" && body !== undefined) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body))));
        if (event === "end") queueMicrotask(() => queueMicrotask(() => fn()));
        return req;
      },
    };
    handler!(req, res, () => reject(new Error(`口がありません: ${url}`)));
  });
}

describe("立ち絵の位置調整の口（書き戻せない環境）", () => {
  it("取り込みで作る cast.json でも読め、次の取り込みで上書きされることを知らせる", async () => {
    const dir = importedProject();
    const r = await call(dir, { noWriteBack: true }, "GET", "/__liminalia/api/cast");
    expect(r.status).toBe(200);
    expect(r.body.writeBack).toMatchObject({ kind: "none" });
  });

  it("保存は前の版を残し、書き戻さない理由を返す", async () => {
    const dir = importedProject();
    const { body: state } = await call(dir, { noWriteBack: true }, "GET", "/__liminalia/api/cast");
    const cast = { アカリ: { appearances: { default: { variants: {} } } } };
    const r = await call(dir, { noWriteBack: true }, "POST", "/__liminalia/api/cast", { cast, version: state.version });
    expect(r.status).toBe(200);
    expect(r.body.backup).toContain("cast-");
    expect(r.body.wroteBack).toEqual([]);
    expect(r.body.notes).toEqual([expect.stringContaining("上書きされます")]);
    expect(JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")).cast).toEqual(cast);
    expect(readdirSync(join(dir, ".liminalia/backups"))).toHaveLength(1);
  });

  it("書き戻せる環境では取り込み設定を読む（読めなければこれまでどおり断る）", async () => {
    const r = await call(importedProject(), {}, "GET", "/__liminalia/api/cast");
    expect(r.status).toBe(500);
  });
});
