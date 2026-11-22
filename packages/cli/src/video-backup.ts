import { constants, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { PROGRESS_FILE, type SegmentRecord } from "./video-plan.ts";

/** 再開で上書きする区切りと記録を、削除する前に別フォルダへ控える。失敗したら元を変更しない。 */
export function backupResume(folder: string, segments: readonly SegmentRecord[]): string {
  const names = segments.map((segment) => segment.file);
  if (names.some((name) => typeof name !== "string" || basename(name) !== name || name === "." || name === "..")) {
    throw new Error("録画の記録に使えないファイル名があります。再開せず記録を確認してください");
  }
  const backup = mkdtempSync(join(folder, "resume-backup-"));
  try {
    for (const name of [PROGRESS_FILE, ...new Set(names)]) {
      const src = join(folder, name);
      if (!existsSync(src)) {
        if (name === PROGRESS_FILE) throw new Error("録画の記録がありません");
        continue;
      }
      copyFileSync(src, join(backup, name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    return backup;
  } catch (error) {
    rmSync(backup, { recursive: true, force: true });
    throw error;
  }
}
