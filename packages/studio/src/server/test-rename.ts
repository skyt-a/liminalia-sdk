import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { renameInScenarioTests, type ScenarioTestRename } from "@liminalia/lang";
import { projectTestFiles } from "@liminalia/project";
import type { TestRenameResult } from "../protocol.ts";
import type { Remember } from "./undo.ts";
import { writeAtomic } from "./versions.ts";
import { textStep } from "./file-undo.ts";
import type { StudioWorkspace } from "./workspace.ts";

/**
 * 名前の変更で、台本のテスト（tests/*.limtest）の中の名前も書き換える（@liminalia/lang の renameInScenarioTests）。
 * from と expect reach の場所、set と expect の式（変数、visits と read の飛び先）、話者名と比べる expect text。
 * 書いたものは remember で控え、名前の変更が途中で書けなくなったら元に戻す。書き換えたファイルも書き換えられなかった行も無ければ undefined。
 */
export function renameInTests(ws: StudioWorkspace, change: ScenarioTestRename, remember: Remember): TestRenameResult | undefined {
  const files: string[] = [];
  const left: TestRenameResult["left"] = [];
  for (const path of projectTestFiles(ws.project.root)) {
    const name = relative(ws.project.root, path).split(sep).join("/");
    const before = readFileSync(path, "utf8");
    const r = renameInScenarioTests(before, change);
    left.push(...r.left.map((line) => ({ file: name, line })));
    if (r.text === before) continue;
    writeAtomic(path, r.text);
    const step = textStep(name, path, before, r.text);
    remember(name, () => writeAtomic(path, before), step);
    files.push(name);
  }
  return files.length > 0 || left.length > 0 ? { files, left } : undefined;
}
