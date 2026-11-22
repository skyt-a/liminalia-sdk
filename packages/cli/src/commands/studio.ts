import { loadProject } from "@liminalia/project";
import { STUDIO_PAGE } from "@liminalia/studio/protocol";
import { announceStudio } from "@liminalia/studio/running";
import { StartupTimes, startPlayerServer } from "../web.ts";

/**
 * lim studio [プロジェクト] [--port 5180] — lim dev と同じ開発サーバーを立て、制作画面の URL を出す。
 * 開いていることを作品の .liminalia/studio-server.json に書き（終わると消す）、AI の MCP がこの開発サーバーを使えるようにする。
 */
export async function runStudio(dir: string, port: number): Promise<void> {
  const times = new StartupTimes();
  // 読み込めないプラグインは抜いて起動する（制作画面の上の帯とチェックの「プラグイン」の分類に出す）
  const project = loadProject(dir, { skipBrokenPlugins: true });
  times.mark("設定の読み込み");
  const { url } = await startPlayerServer(project, port, false, {}, times);
  announceStudio(project.root, url, "cli");
  // Ctrl+C でも消す（Node は SIGINT では exit を出さずに終わる）
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(130));
  // 確かめの道具から立てたときは、道具が打ち切られて（止める処理が動かずに）いなくなったら一緒に終わる。残るとポートをふさぐ
  if (process.env.LIMINALIA_EXIT_WITH_PARENT === "1") {
    const parent = process.ppid;
    setInterval(() => {
      try {
        process.kill(parent, 0);
        if (process.ppid === parent) return;
      } catch {
        // 親はもういない
      }
      process.exit(0);
    }, 1000).unref();
  }
  console.log(`Studio: ${new URL(STUDIO_PAGE.slice(1), url).href}`);
  console.log(`プレイヤー: ${url}`);
  if (project.config.import?.tyrano) console.log("  このプロジェクトの .lim は lim import で作られるため、Studio で編集しても次のインポートで上書きされます");
  console.log("  Studio で保存した .lim の変更履歴は .liminalia/history/ に残ります");
}
