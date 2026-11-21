import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STUDIO_API, STUDIO_PAGE } from "./protocol.ts";

/**
 * 作品の制作画面がどこで開いているか（開発サーバーの URL）を、作品の .liminalia/studio-server.json に書いておく。
 * 書くのは制作アプリ（packages/studio-desktop の engine/run.ts）と lim studio（packages/cli の commands/studio.ts）。
 * AI の MCP（lim mcp）が読み、開いている制作画面があれば、別の開発サーバーを立てずにそれを使う（open_studio）、その画面で撮る（screenshot）。
 *
 * 書いたプロセスが終わると消す。落ちて残ったものは、プロセスが無い・開発サーバーが答えない・違う作品を開いていれば無いものとする。
 * ゲームのデータでも制作画面の覚え書きでもなく、git にも入れない（.liminalia/ の中）。
 */

/** 作品のフォルダからの場所。 */
export const RUNNING_FILE = ".liminalia/studio-server.json";

/** 開発サーバーが自分を名乗る口（GET。ほかの口と違い、作品の読み込みを待たずに答える）。 */
export const SERVER_INFO_ROUTE = "/server";

export interface RunningStudio {
  /** 開発サーバーの URL（http://127.0.0.1:20431 など。末尾の / なし）。 */
  url: string;
  /** 開発サーバーを動かしているプロセス。 */
  pid: number;
  /** desktop は制作アプリ、cli は lim studio。 */
  app: "desktop" | "cli";
  root: string;
  started: string;
}

/** GET STUDIO_API/server の返事。 */
export interface ServerInfo {
  root: string;
  pid: number;
}

const fileOf = (root: string) => join(root, RUNNING_FILE);
const trimUrl = (url: string) => url.replace(/\/+$/, "");

/** 制作画面の URL（開発サーバーの URL から）。 */
export const studioPageUrl = (url: string) => `${trimUrl(url)}${STUDIO_PAGE}`;

/**
 * 開いたことを書く。消す関数を返す（同じプロセスが書いたものだけを消す。あとから別の開発サーバーが書いていれば残す）。
 * プロセスが終わるときにも消す。
 */
export function announceStudio(root: string, url: string, app: RunningStudio["app"]): () => void {
  const file = fileOf(root);
  const info: RunningStudio = { url: trimUrl(url), pid: process.pid, app, root: resolve(root), started: new Date().toISOString() };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // 書けない作品（読み取り専用の場所など）でも制作画面は開く。AI からは見つからないだけ
  }
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    process.off("exit", remove);
    try {
      const now = JSON.parse(readFileSync(file, "utf8")) as Partial<RunningStudio>;
      if (now.pid === info.pid && now.url === info.url) rmSync(file, { force: true });
    } catch {
      // 無い・読めない
    }
  };
  process.on("exit", remove);
  return remove;
}

/** プロセスが生きているか。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // 権限が無いだけなら生きている
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * その作品を開いている制作画面。書いてあるものを、プロセスが生きていて、開発サーバーが同じ作品だと答えるときだけ返す。
 * 無ければ null。
 */
export async function findRunningStudio(root: string, timeoutMs = 2000): Promise<RunningStudio | null> {
  const file = fileOf(root);
  if (!existsSync(file)) return null;
  let info: RunningStudio;
  try {
    info = JSON.parse(readFileSync(file, "utf8")) as RunningStudio;
  } catch {
    return null;
  }
  if (typeof info.url !== "string" || !Number.isInteger(info.pid) || !alive(info.pid)) return null;
  try {
    const res = await fetch(`${info.url}${STUDIO_API}${SERVER_INFO_ROUTE}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const me = (await res.json()) as Partial<ServerInfo>;
    return typeof me.root === "string" && resolve(me.root) === resolve(root) ? info : null;
  } catch {
    return null;
  }
}
