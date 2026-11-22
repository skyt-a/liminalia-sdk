import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { contentTypeOf } from "./content-types.ts";

export interface FolderServer {
  server: Server;
  url: string;
  dir: string;
  close(): void;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 音声と動画の単一範囲。未対応の形式は通常の GET として扱う。 */
function byteRange(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return { start, end };
}

async function sendFile(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` && req.headers.host !== `localhost:${req.socket.localPort}`) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  } catch {
    // URL の不正なエンコードは、このリクエストにだけ 400 を返す。
    res.writeHead(400).end();
    return;
  }
  const requested = join(root, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
  // 消えたファイルや壊れたリンクは 404 にする。
  const file = inside(root, requested) ? await realpath(requested).catch(() => null) : null;
  if (!file || !inside(root, file)) {
    res.writeHead(404).end();
    return;
  }
  // 読み出しまでに消えた場合も 404。FIFO の open でワーカーを塞がない。
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) {
    res.writeHead(404).end();
    return;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const range = byteRange(req.headers.range, info.size);
    if (range && range.start > range.end) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": contentTypeOf(requested),
      "Cache-Control": "no-cache",
      "Accept-Ranges": "bytes",
      "Content-Length": range ? range.end - range.start + 1 : info.size,
      ...(range && { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` }),
    });
    if (req.method === "HEAD") res.end();
    else await pipeline(handle.createReadStream(range ?? {}), res);
  } finally {
    await handle.close();
  }
}

/** CLI と Studio で書き出したゲームを確認するためのループバック配信。 */
export async function serveFolder(dir: string): Promise<FolderServer> {
  const root = await realpath(dir);
  const server = createServer((req, res) => {
    // 配信途中の読み出し失敗や切断は、応答を終了して次のリクエストを受ける。
    void sendFile(root, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    dir: resolve(dir),
    url: `http://127.0.0.1:${port}/`,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
