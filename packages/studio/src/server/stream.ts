import type { ServerResponse } from "node:http";
import type { StreamLine } from "../protocol.ts";
import { localizedError } from "./errors-en.ts";

/**
 * 長くかかる口の応答を、出したものから一行ずつ流す（application/x-ndjson。一行は StreamLine）。
 * 作品のプラグインの流す口（plugin-host.ts）と、重さの計測（POST /profile）が使う。画面は api.ts の readStream で読む。
 */

/** 応答を書き終える前に画面が切った（取り消した）ら止まる合図。 */
export function closeSignal(res: ServerResponse): AbortSignal {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  return abort.signal;
}

/**
 * 例外の状態の番号。status（400〜599 の整数）を持つものはそれを使い、ほかは 500。
 * @liminalia/studio を読まずに書いた作品の外のプラグインも、status を付けた Error を投げれば同じに扱う。
 */
export function statusOf(e: unknown): number {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

/** 出したものを一行ずつ流す。画面が切ったらイテレーターを閉じる（finally が走る）。失敗は error の行で終え、500 番台は onError にも渡す。 */
export async function streamLines(res: ServerResponse, items: AsyncIterable<unknown>, signal: AbortSignal, onError: (e: unknown) => void): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const line = (l: StreamLine) => res.write(`${JSON.stringify(l)}\n`);
  const it = items[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const next = await it.next();
      if (next.done) break;
      line({ event: next.value });
    }
  } catch (e) {
    if (!signal.aborted) {
      const status = statusOf(e);
      if (status >= 500) onError(e);
      line({ error: localizedError(res, e instanceof Error ? e.message : String(e)), status });
    }
  } finally {
    if (signal.aborted) await it.return?.().catch(() => undefined);
    res.end();
  }
}
