import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { castProblems, type Cast } from "@liminalia/lang";
import { pluginEntry, resolvePackageDir, type Project } from "@liminalia/project";
import { TATIE_SETTINGS, writeTatieSettings, type TyranoImportProfile } from "@liminalia/ks-import/node";
import type { Plugin, ViteDevServer } from "vite";

/**
 * 立ち絵の位置調整画面の、開発サーバー側（lim dev のときだけ。書き出しには入らない）。
 *
 *   GET  /__liminalia/cast          画面（packages/web/caster.html）
 *   GET  /__liminalia/api/cast      cast.json と、画面サイズ・背景の一覧・取り込み元への書き戻し先
 *   POST /__liminalia/api/cast      { cast, speakers?, version, force? } を cast.json の cast（と speakers）に書く（ほかの項目は保つ）
 *   POST /__liminalia/api/fgimage?path=…&overwrite=1   本文の画像を assets/fgimage/ 以下に書く
 *
 * cast.json は書く前に castProblems で検査し、前の版をプロジェクトの .liminalia/backups/ に日時付きで残して
 * （最新 BACKUP_KEEP 件まで）、一時ファイルから rename して書く。読んだ後にほかで書き換えられていたら、force が無ければ書かない。
 * 取り込みで作る cast.json（liminalia.json に import.tyrano がある）なら、取り込み元にも書き戻す:
 * 取り込み設定（import.tyrano.profile の "./import"）に writeCast があればそれ、無ければ取り込み元の tatie の設定。
 * 書いたら、開いているプレイヤーに Vite の WebSocket でカスタムイベント CAST_EVENT を送る。
 */

export const CAST_EVENT = "liminalia:cast";
export const BACKUP_KEEP = 20;
const IMAGE_LIMIT = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** 取り込み元への書き戻し先。profile は取り込み設定の writeCast、tatie は取り込み元の settings.js、none は書き戻せない。 */
export type WriteBack = { kind: "profile"; target: string } | { kind: "tatie"; target: string } | { kind: "none"; target: string };

export interface CasterState {
  /** cast.json の中身（無ければ speakers と cast だけの空のもの）。 */
  file: { speakers: string[]; cast: Cast; [key: string]: unknown };
  /** cast.json の版（中身のハッシュ。無ければ空文字）。 */
  version: string;
  project: { title: string; screen: { width: number; height: number } };
  /** assets/bgimage/ 以下の画像。 */
  backgrounds: string[];
  /** 取り込みで作る cast.json でなければ null。 */
  writeBack: WriteBack | null;
}

export interface SaveResult {
  version: string;
  /** cast.json の前の版の写し（初めて書いたときは null）。 */
  backup: string | null;
  /** 取り込み元に書き戻したファイル。 */
  wroteBack: string[];
  /** 知らせること（書き戻せない差分・書き戻しの失敗など）。 */
  notes: string[];
}

export interface CasterServerOptions {
  /** 取り込み元へ書き戻さない（スマホ版。取り込み元のフォルダも、取り込み設定のコードを動かす口も無い）。 */
  noWriteBack?: boolean;
}

export function casterServer(project: Project, webRoot: string, options: CasterServerOptions = {}): Plugin {
  return {
    name: "liminalia-caster",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = `${req.method ?? "GET"} ${url.pathname.replace(/\/$/, "")}`;
        const handle = async () => {
          if (route === "GET /__liminalia/cast") {
            const html = readFileSync(join(webRoot, "caster.html"), "utf8");
            return send(res, 200, await server.transformIndexHtml(url.pathname, html), "text/html; charset=utf-8");
          }
          if (!url.pathname.startsWith("/__liminalia/api/")) return next();
          if (!sameOrigin(req)) return json(res, 403, { error: "別のオリジンからは使えません" });
          if (route === "GET /__liminalia/api/cast") return json(res, 200, await readState(project, server, options));
          if (route === "POST /__liminalia/api/cast") {
            if (!(req.headers["content-type"] ?? "").includes("application/json")) return json(res, 415, { error: "application/json で送ってください" });
            const body = JSON.parse((await readBody(req, IMAGE_LIMIT)).toString("utf8")) as { cast?: unknown; speakers?: unknown; version?: string; force?: boolean };
            if (!body.cast || typeof body.cast !== "object" || Array.isArray(body.cast)) return json(res, 400, { error: "cast がありません" });
            if (body.speakers !== undefined && (!Array.isArray(body.speakers) || body.speakers.some((s) => typeof s !== "string" || s.trim() === ""))) {
              return json(res, 400, { error: "speakers は話者の名前の配列で送ってください" });
            }
            const problems = castProblems(body.cast as Record<string, unknown>);
            if (problems.length > 0) return json(res, 400, { error: "キャラクターの設定に誤りがあります", problems });
            const current = currentVersion(project);
            if (!body.force && body.version !== current) return json(res, 409, { error: "cast.json がほかで変更されています", conflict: true });
            const result = await saveCast(project, body.cast as Cast, (entry) => server.ssrLoadModule(entry), body.speakers as string[] | undefined, options);
            server.ws.send({ type: "custom", event: CAST_EVENT, data: { version: result.version } });
            return json(res, 200, result);
          }
          if (route === "POST /__liminalia/api/fgimage") {
            if (req.headers["x-liminalia"] !== "1") return json(res, 400, { error: "X-Liminalia ヘッダーがありません" });
            const rel = url.searchParams.get("path") ?? "";
            const file = fgimagePath(project, rel);
            if (!file) return json(res, 400, { error: `画像のパスとして使えません: ${rel}` });
            if (existsSync(file) && url.searchParams.get("overwrite") !== "1") return json(res, 409, { error: `${rel} はすでにあります`, exists: true });
            writeAtomic(file, await readBody(req, IMAGE_LIMIT));
            return json(res, 200, { path: rel.split(sep).join("/") });
          }
          return json(res, 404, { error: `${route} はありません` });
        };
        handle().catch((e: Error) => json(res, 500, { error: e.message }));
      });
    },
  };
}

/** 画面が最初に読むもの。 */
async function readState(project: Project, server: ViteDevServer, options: CasterServerOptions): Promise<CasterState> {
  const text = existsSync(project.paths.cast) ? readFileSync(project.paths.cast, "utf8") : "";
  const parsed = (text ? JSON.parse(text) : {}) as Partial<CasterState["file"]>;
  const bgDir = join(project.paths.assets, "bgimage");
  return {
    file: { ...parsed, speakers: parsed.speakers ?? [], cast: parsed.cast ?? {} },
    version: text ? hash(text) : "",
    project: { title: project.config.title, screen: project.screen },
    backgrounds: existsSync(bgDir)
      ? readdirSync(bgDir, { recursive: true, encoding: "utf8" })
          .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
          .map((f) => f.split(sep).join("/"))
          .sort()
      : [],
    writeBack: options.noWriteBack ? noWriteBackTarget(project) : await writeBackTarget(project, (entry) => server.ssrLoadModule(entry)),
  };
}

/** 取り込み元のフォルダ。取り込みで作る cast.json でなければ null。 */
function importSource(project: Project): string | null {
  const tyrano = project.config.import?.tyrano;
  return tyrano ? resolve(project.root, tyrano.source) : null;
}

/** 取り込み設定のモジュールを読む（開発サーバーでは ssrLoadModule、MCP では import）。 */
export type ModuleLoader = (entry: string) => Promise<unknown>;

/** liminalia.json の import.tyrano.profile の "./import"（packages/cli/src/context.ts の loadPluginImports と同じ読み方）。 */
async function loadImportProfile(project: Project, load: ModuleLoader): Promise<TyranoImportProfile | null> {
  const spec = project.config.import?.tyrano?.profile;
  // 制限付きで開いた作品では、作品の取り込み設定を読まない
  if (!spec || project.restricted) return null;
  const entry = pluginEntry(resolvePackageDir(project.root, spec), "import");
  if (!entry) throw new Error(`${spec} に "./import" のエントリーポイントがありません`);
  const mod = (await load(entry)) as { default?: TyranoImportProfile };
  if (!mod.default) throw new Error(`${entry} がインポート設定を default export していません`);
  return mod.default;
}

async function writeBackTarget(project: Project, load: ModuleLoader): Promise<WriteBack | null> {
  const source = importSource(project);
  if (!source) return null;
  const profile = await loadImportProfile(project, load);
  if (profile?.writeCast) return { kind: "profile", target: project.config.import!.tyrano!.profile! };
  const tatie = join(source, TATIE_SETTINGS);
  if (existsSync(tatie)) return { kind: "tatie", target: tatie };
  return { kind: "none", target: source };
}

/** 書き戻せない環境での書き戻し先（取り込みで作る cast.json なら、次の取り込みで上書きされることを画面に出す）。 */
function noWriteBackTarget(project: Project): WriteBack | null {
  const source = importSource(project);
  return source ? { kind: "none", target: source } : null;
}

/**
 * cast.json の cast を書き換え、取り込み元にも書き戻す（検査と版の確かめは呼ぶ側。AI の MCP の register_character もこれを使う）。
 */
export async function saveCast(project: Project, cast: Cast, load: ModuleLoader, speakers: string[] | undefined, options: CasterServerOptions): Promise<SaveResult> {
  const file = project.paths.cast;
  const backupDir = join(project.root, ".liminalia", "backups");
  const previous = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : { speakers: [] };
  const backup = existsSync(file) ? backupFile(file, backupDir, "cast") : null;
  const text = JSON.stringify({ ...previous, ...(speakers ? { speakers: [...new Set(speakers)] } : {}), cast }, null, 2) + "\n";
  writeAtomic(file, text);

  const wroteBack: string[] = [];
  const notes: string[] = [];
  const source = importSource(project);
  if (source && options.noWriteBack) {
    notes.push("インポート元に書き戻す先がありません。次の lim import で cast.json は上書きされます");
  } else if (source) {
    try {
      const profile = await loadImportProfile(project, load);
      if (profile?.writeCast) {
        wroteBack.push(...((await profile.writeCast({ source, cast, backupDir })) ?? []));
      } else {
        const r = writeTatieSettings(source, cast, { backupDir, keep: BACKUP_KEEP });
        if (r) {
          wroteBack.push(r.file);
          if (r.skipped.length > 0) notes.push(`位置とサイズが未設定の差分は Tyrano Tatie の設定に書き込めないため、書き戻していません: ${r.skipped.join("、")}`);
        } else {
          notes.push("インポート元に書き戻す先がありません。次の lim import で cast.json は上書きされます");
        }
      }
    } catch (e) {
      notes.push(`インポート元への書き戻しに失敗しました: ${(e as Error).message}`);
    }
  }
  return { version: hash(text), backup, wroteBack, notes };
}

/** cast.json の版（中身のハッシュ。無ければ空文字）。書く前に、読んだときの版と比べる。 */
export function currentVersion(project: Project): string {
  return existsSync(project.paths.cast) ? hash(readFileSync(project.paths.cast, "utf8")) : "";
}

/** assets/fgimage/ の中の画像のパス。外に出るもの・画像でないものは null。 */
function fgimagePath(project: Project, rel: string): string | null {
  if (rel === "" || isAbsolute(rel) || !IMAGE_EXTENSIONS.has(extname(rel).toLowerCase())) return null;
  const dir = join(project.paths.assets, "fgimage");
  const file = normalize(join(dir, rel));
  const r = relative(dir, file);
  return r === "" || r.startsWith("..") || isAbsolute(r) ? null : file;
}

/** ページと同じオリジンからの要求か（Origin が無い要求は通す）。 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** file を dir に「prefix-日時.拡張子」で写し、同じ prefix の古いものを BACKUP_KEEP 件まで減らす。 */
function backupFile(file: string, dir: string, prefix: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(file);
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const out = join(dir, `${prefix}-${stamp}${ext}`);
  copyFileSync(file, out);
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(ext))
    .sort()
    .reverse()
    .slice(BACKUP_KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return out;
}

function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("データが大きすぎます"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}
