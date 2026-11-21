import { join } from "node:path";
import type { ProjectInfo } from "./project.ts";

/**
 * シナリオでない診断の file（作品のフォルダからのパスか決まった名前）が指すファイル。設定、キャスト、訳、ボイスの番号の固定、作品のデータ
 * （プラグインの検査）、作品の CSS（ui.css）、画面のテンプレート（ui.templates）とその画面の JS。分からなければ null（VS Code には出さない）。
 */
export function diagnosticFilePath(file: string, info: Pick<ProjectInfo, "root" | "configFile" | "paths">, work: { castFile?: string; dataFolder?: string } = {}): string | null {
  const castFile = work.castFile ?? "cast.json";
  const dataFolder = work.dataFolder ?? "data";
  if (file === castFile) return info.paths.cast;
  if (file === "liminalia.json") return info.configFile;
  if (file === "voice-lock.json") return info.paths.voiceLock;
  if (file.startsWith("lang/")) return join(info.paths.lang, file.slice(5));
  if (file.startsWith(`${dataFolder}/`)) return join(info.paths.data, file.slice(dataFolder.length + 1));
  // 作品の CSS（ui.css）、画面のテンプレート（ui.templates）とその画面の JS（template-script-export など）。作品のフォルダからのパス
  if (/\.(css|html|js)$/i.test(file)) return join(info.root, ...file.split("/"));
  return null;
}
