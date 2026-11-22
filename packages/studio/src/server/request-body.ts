import type { IncomingMessage } from "node:http";
import { StudioServerError } from "../server-plugin.ts";

/** 上限を超えた本文は捨て、呼び出し元が同じ接続で 413 を返せるようにする。 */
export function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function accept(chunk: Buffer): void {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      req.off("data", accept);
      req.resume();
      reject(new StudioServerError(413, "データが大きすぎます"));
    }
    req.on("data", accept);
    req.once("error", reject);
    req.once("end", () => resolve(Buffer.concat(chunks)));
  });
}
