import { readBody } from "./request-body.ts";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { COMMAND_META, type Cast } from "@liminalia/lang";
import { pluginEntry, pluginErrorReason, pluginLoadMessage, STD_PLUGIN, type Project } from "@liminalia/project";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { STUDIO_PLUGIN_HEADER, type StudioEvent } from "../protocol.ts";
import { StudioServerError, type StudioRequest, type StudioServerContext, type StudioServerPlugin } from "../server-plugin.ts";
import { STUDIO_PLUGIN_API_VERSION } from "../plugin-version.ts";
import type { DataStore } from "./data-store.ts";
import { closeSignal, statusOf, streamLines } from "./stream.ts";
import { StudioError, type StudioWorkspace } from "./workspace.ts";
import { localizedError } from "./errors-en.ts";

/** プラグインの名前（口の場所になる）。 */
const NAME = /^[a-z][a-z0-9-]*$/;

export interface PluginHostDeps {
  project: Project;
  workspace: () => Promise<StudioWorkspace>;
  data: DataStore;
  /** "./studio-server" を読む（開発サーバーでは Vite の ssrLoadModule）。 */
  load: (entry: string) => Promise<Record<string, unknown>>;
  /** 画面に知らせる（Vite の WebSocket）。 */
  send: (event: StudioEvent) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

interface Loaded {
  plugin: StudioServerPlugin;
  ctx: StudioServerContext;
}

/**
 * 作品のプラグインの "./studio-server" を読み、STUDIO_API/plugin/<name>/… の要求をその口に渡す。
 * はじめて要求が来たときに一度だけすべて読む。読めないプラグインは記録に出し、その名前への要求には理由を返す。
 */
export class PluginHost {
  /** 口を呼ぶ前に読んだ作品（「更新」で読み直したら新しいもの）。 */
  private ws: StudioWorkspace | null = null;
  private loading: Promise<{ plugins: Map<string, Loaded>; errors: string[] }> | null = null;

  constructor(private readonly deps: PluginHostDeps) {}

  /** rest は STUDIO_PLUGIN_API より後ろ（"/<name>/<path>"）。 */
  async handle(req: IncomingMessage, res: ServerResponse, rest: string, query: URLSearchParams): Promise<void> {
    if (req.headers[STUDIO_PLUGIN_HEADER] !== "1") return json(res, 403, { error: `プラグインの API は ${STUDIO_PLUGIN_HEADER} ヘッダーを付けて呼びます（ctx.server、ctx.stream が付けます）` });
    const m = /^\/([^/]+)(\/.*)?$/.exec(rest);
    const name = m?.[1] ?? "";
    const path = m?.[2] ?? "/";
    this.ws = await this.deps.workspace();
    const { plugins, errors } = await (this.loading ??= this.loadAll());
    const loaded = plugins.get(name);
    if (!loaded) {
      const why = errors.length > 0 ? `（読み込めなかったプラグイン: ${errors.join(" / ")}）` : "";
      return json(res, 404, { error: `プラグイン ${name} は開発サーバー側の API（"./studio-server"）を持っていません${why}` });
    }
    const method = req.method ?? "GET";
    const route = loaded.plugin.routes[`${method} ${path}`];
    if (!route) return json(res, 404, { error: `${name} に ${method} ${path} はありません` });

    // 応答を書き終える前に画面が切った（取り消した）ら止める
    const signal = closeSignal(res);
    let body: Promise<Buffer> | null = null;
    const raw = () => (body ??= readBody(req));
    const request: StudioRequest = {
      method,
      path,
      query,
      async json<T>() {
        const b = await raw();
        if (b.length === 0) return null as T;
        try {
          return JSON.parse(b.toString("utf8")) as T;
        } catch {
          throw new StudioServerError(400, "JSON として読み込めません");
        }
      },
      text: async () => (await raw()).toString("utf8"),
      signal,
    };

    let result: unknown;
    try {
      result = await route(request, loaded.ctx);
    } catch (e) {
      return fail(res, e, name, this.deps.error);
    }
    if (isAsyncIterable(result)) return stream(res, result, signal, name, this.deps.error);
    if (result instanceof Response) return respond(res, result);
    if (result === undefined) {
      res.statusCode = 204;
      res.end();
      return;
    }
    return json(res, 200, result);
  }

  /** 読んだプラグインの dispose を呼ぶ（開発サーバーを閉じるとき）。 */
  async dispose(): Promise<void> {
    if (!this.loading) return;
    const { plugins } = await this.loading;
    for (const { plugin } of plugins.values()) {
      try {
        await plugin.dispose?.();
      } catch (e) {
        this.deps.error(`プラグイン ${plugin.name} を閉じられません: ${message(e)}`);
      }
    }
  }

  private async loadAll(): Promise<{ plugins: Map<string, Loaded>; errors: string[] }> {
    const plugins = new Map<string, Loaded>();
    const errors: string[] = [];
    for (const dir of this.deps.project.plugins) {
      if (dir === STD_PLUGIN) continue;
      let entry: string | null = null;
      try {
        entry = pluginEntry(dir, "studio-server");
        if (!entry) continue;
        const plugin = (await this.deps.load(entry)).default as StudioServerPlugin | undefined;
        if (!plugin || typeof plugin !== "object" || !plugin.routes) throw new Error(`${entry} が StudioServerPlugin を default export していません`);
        if (!NAME.test(plugin.name)) throw new Error(`名前 ${plugin.name} は使えません（英小文字で始め、英小文字、数字、- だけを使います）`);
        if (plugins.has(plugin.name)) throw new Error(`開発サーバー側の API の名前 ${plugin.name} がほかのプラグインと重複しています`);
        plugins.set(plugin.name, { plugin, ctx: this.context(plugin.name) });
      } catch (e) {
        const text = pluginLoadMessage({ spec: relative(this.deps.project.root, dir).split(sep).join("/") || ".", message: pluginErrorReason(e, dir, entry) });
        errors.push(text);
        this.deps.error(`[プラグイン] ${text}`);
      }
    }
    return { plugins, errors };
  }

  private context(name: string): StudioServerContext {
    const { project, data, send } = this.deps;
    const workspace = () => this.ws!;
    return {
      root: project.root,
      paths: project.paths,
      stateDir() {
        const dir = join(project.root, ".liminalia", "plugins", name);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      readScript(file) {
        try {
          return workspace().fileText(file);
        } catch (e) {
          if (e instanceof StudioError && e.status === 404) return null;
          throw e;
        }
      },
      writeScript(file, text, baseHash) {
        // 書いたことは StudioWorkspace の announce がすべての画面へ知らせる（ファイルの見張りは自分で書いたものを知らせない）
        const r = workspace().write(file, text, baseHash, false);
        if (!r.ok) return { ok: false, current: r.conflict.current };
        return { ok: true, hash: r.result.hash };
      },
      readData(name) {
        try {
          return data.read(name);
        } catch (e) {
          if (e instanceof StudioError && e.status === 404) return null;
          throw e;
        }
      },
      writeData(dataName, text, baseHash) {
        const r = data.write(dataName, text, baseHash);
        if (r.ok) send({ type: "data-changed", name: dataName });
        return r;
      },
      commands() {
        return [...workspace().commands.values()].map((c) => {
          const keywords = c.keywords ?? COMMAND_META[c.name]?.keywords;
          return keywords ? { ...c, keywords } : c;
        });
      },
      check(file, text) {
        return workspace().checkText(file, text);
      },
      log: (text) => this.deps.log(`[${name}] ${text}`),
      apiVersion: STUDIO_PLUGIN_API_VERSION,
      cast: () => workspace().castFile.cast as Cast,
      speakers() {
        const c = workspace().castFile;
        const own = Object.values(c.cast).flatMap((e) => (e && typeof e === "object" && typeof (e as { speaker?: unknown }).speaker === "string" ? [(e as { speaker: string }).speaker] : []));
        return [...new Set([...c.speakers, ...own])];
      },
      assets: () => workspace().assets(),
      scripts: () => workspace().files(),
      parse(file, text) {
        const w = workspace();
        if (text !== undefined) return w.parseText(file, text);
        try {
          return w.script(file).script;
        } catch (e) {
          if (e instanceof StudioError && e.status === 404) return null;
          throw e;
        }
      },
    };
  }
}

/** 出したものを一行ずつ流す（stream.ts）。500 番台の失敗は、プラグインの名前を付けて記録に残す。 */
function stream(res: ServerResponse, items: AsyncIterable<unknown>, signal: AbortSignal, name: string, error: (m: string) => void): Promise<void> {
  return streamLines(res, items, signal, (e) => error(`[${name}] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
}

async function respond(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((value, key) => res.setHeader(key, value));
  if (!r.body) return void res.end();
  Readable.fromWeb(r.body as NodeReadableStream).pipe(res);
}

function fail(res: ServerResponse, e: unknown, name: string, error: (m: string) => void): void {
  const status = statusOf(e);
  if (status >= 500) error(`[${name}] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  json(res, status, { error: message(e) });
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === "object" && v !== null && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const b = body as { error?: unknown } | null;
  res.end(JSON.stringify(b && typeof b === "object" && typeof b.error === "string" ? { ...b, error: localizedError(res, b.error) } : body));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

