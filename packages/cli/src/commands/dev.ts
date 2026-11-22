import { loadProject } from "@liminalia/project";
import { STUDIO_PAGE } from "@liminalia/studio/protocol";
import { StartupTimes, startPlayerServer } from "../web.ts";

/** lim dev [プロジェクト] [--port 5180] — プレイヤーの開発サーバーを立てる（立ち絵の位置調整画面つき）。 */
export async function runDev(dir: string, port: number): Promise<void> {
  const times = new StartupTimes();
  const project = loadProject(dir);
  times.mark("設定の読み込み");
  const { url } = await startPlayerServer(project, port, false, {}, times);
  console.log(`プレイヤー: ${url}`);
  console.log("  ?start=ファイル[#ラベル] でそこから開始、?skip=N で N ページ目までスキップ");
  console.log(`立ち絵の位置調整: ${new URL("__liminalia/cast", url).href}`);
  console.log("  保存すると cast.json に書き込み（変更前のファイルは .liminalia/backups/）、開いているプレイヤーの立ち絵を再描画します");
  console.log(`Studio: ${new URL(STUDIO_PAGE.slice(1), url).href}（lim studio でも開けます）`);
}
