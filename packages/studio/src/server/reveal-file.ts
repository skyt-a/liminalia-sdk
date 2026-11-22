import { dirname } from "node:path";

/** OS のファイル画面で対象を選ぶ。Linux は共通の選択方法がないため親フォルダを開く。 */
export function revealFileCommand(platform: NodeJS.Platform, file: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: ["-R", file] };
  if (platform === "win32") return { cmd: "explorer", args: [`/select,${file}`] };
  return { cmd: "xdg-open", args: [dirname(file)] };
}
