import type { IncomingMessage, ServerResponse } from "node:http";
import { importProject } from "@liminalia/ks-import/node";
import type { Project } from "@liminalia/project";
import { STUDIO_API, type ImportResult } from "@liminalia/studio/protocol";
import type { Plugin } from "vite";

/**
 * 開発サーバーの「再インポート」（POST /__liminalia/studio/api/import）。開発サーバーの Node 側だけで動き、書き出しには入らない。
 * 取り込み（@liminalia/ks-import）は制作画面のブラウザ側に入れない決まりなので、制作画面の口とは分けてここに置く。
 * 書き換わった .lim は制作画面のファイルの見張りが知らせる。同時に二つは走らせない。
 */
export function importServer(project: Project): Plugin {
  let running: Promise<ImportResult> | null = null;
  return {
    name: "liminalia-import",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== `${STUDIO_API}/import`) return next();
        if (req.method !== "POST") return json(res, 405, { error: "POST で送ってください" });
        if (!sameOrigin(req)) return json(res, 403, { error: "別のオリジンからは使えません" });
        if (!project.config.import?.tyrano) return json(res, 400, { error: "このプロジェクトは TyranoScript からインポートするプロジェクトではありません" });
        running ??= run(project.root).finally(() => {
          running = null;
        });
        running.then(
          (result) => json(res, 200, result),
          (e: unknown) => {
            server.config.logger.error(`インポートに失敗しました: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
            json(res, 500, { error: `インポートに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
          },
        );
      });
    },
  };
}

async function run(root: string): Promise<ImportResult> {
  const { report, reportPath } = await importProject(root);
  return {
    ok: report.ok,
    files: report.files,
    matched: report.fidelity.filter((f) => f.mismatch === null).length,
    unmapped: report.totals.generic,
    problems: [...report.manual, ...report.syntaxErrors, ...report.checkErrors].slice(0, 100),
    reportPath,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
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
