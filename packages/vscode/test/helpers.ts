import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Position } from "vscode-languageserver";
import { LimProject } from "../src/model.ts";
import { buildInput, listAssets, loadCommands, readCastFile, readProjectInfo, type LoadedCommands } from "../src/project.ts";

/** テストの見本のプロジェクト（scenario/ に start・common・chapter2、plugins/demo に @glint）。 */
export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixture");

let commands: Promise<LoadedCommands> | null = null;

/**
 * 見本のプロジェクトを読む。overlay は保存前の中身（プロジェクトからのパス → 中身）。
 * 中身に ‸ があれば、そこをカーソルの位置にして取り除く。
 */
export async function fixture(overlay: Record<string, string> = {}): Promise<{ project: LimProject; pos: Position }> {
  const info = readProjectInfo(FIXTURE);
  commands ??= loadCommands(info, { trusted: true, workspaceFolders: [FIXTURE], node: process.execPath });
  const { speakers, cast } = readCastFile(info.paths.cast);
  let pos: Position = { line: 0, character: 0 };
  const texts = new Map<string, string>();
  for (const [path, raw] of Object.entries(overlay)) {
    const i = raw.indexOf("‸");
    if (i >= 0) {
      const before = raw.slice(0, i).split("\n");
      pos = { line: before.length - 1, character: before.at(-1)!.length };
    }
    texts.set(path, raw.replace("‸", ""));
  }
  const textOf = (path: string) => texts.get(relative(FIXTURE, path).split(sep).join("/")) ?? (existsSync(path) ? readFileSync(path, "utf8") : null);
  const project = new LimProject(buildInput(info, { commands: await commands, speakers, cast }, textOf, (folder) => listAssets(join(info.paths.assets, folder))));
  return { project, pos };
}

/** start.lim を text（‸ がカーソル）に置き換えたプロジェクト。 */
export function start(text: string) {
  return fixture({ "scenario/start.lim": text });
}
