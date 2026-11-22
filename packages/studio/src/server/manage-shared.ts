import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertScenariosUtf8, ScenarioEncodingError } from "@liminalia/project";
import type { PartRead, PartWrite } from "../protocol.ts";
import { textStep, type Step } from "./file-undo.ts";
import { HISTORY_DIR, hashText, StudioError, writeAtomic, type StudioWorkspace } from "./workspace.ts";
import { keepVersion } from "./versions.ts";

/**
 * UTF-8 で読めないシナリオファイル（Shift_JIS など）があれば、名前の変更を始めない（@liminalia/project の assertScenariosUtf8。lim fmt、lim migrate などと同じ）。
 * 化けた字面を書き戻すと元に戻せず、そのファイルの中の参照も確かめられないので、一つも書かずに止める。
 */
export function refuseNotUtf8(ws: StudioWorkspace): void {
  try {
    assertScenariosUtf8(ws.project.paths.scenario);
  } catch (e) {
    if (e instanceof ScenarioEncodingError) throw new StudioError(400, e.message);
    throw e;
  }
}

/** liminalia.json を before から今の中身にした手順（戻すのも変更履歴を通す）。 */
export function configStep(ws: StudioWorkspace, before: string): Step {
  const path = join(ws.project.root, "liminalia.json");
  return textStep("liminalia.json", path, before, readFileSync(path, "utf8"), (text) => {
    if (text === null) return;
    writeConfigText(ws, text);
    ws.variablesChanged();
    ws.targetsChanged();
  });
}

/**
 * liminalia.json を書き換える（ほかの項目と並びは保つ）。前の内容は変更履歴（.liminalia/history/@config/）に残し、書いたら作業場の変数を読み直す。
 * mutate が false を返せば書かない（中身が変わらないのに書くと、書き手の字面の整形が崩れる）。
 */
export function updateConfig(ws: StudioWorkspace, mutate: (raw: Record<string, unknown>) => void | false): void {
  const path = join(ws.project.root, "liminalia.json");
  const before = readFileSync(path, "utf8");
  const raw = JSON.parse(before) as Record<string, unknown>;
  if (mutate(raw) === false) return;
  writeConfigText(ws, `${JSON.stringify(raw, null, 2)}\n`);
  ws.variablesChanged();
}

/** liminalia.json を text にする（前の内容を変更履歴 .liminalia/history/@config/ に残す。同じなら書かない）。 */
export function writeConfigText(ws: StudioWorkspace, text: string): void {
  const path = join(ws.project.root, "liminalia.json");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (text === before) return;
  if (before !== null) keepVersion(join(ws.project.root, HISTORY_DIR, "@config"), ".json", before);
  writeAtomic(path, text);
}

/** liminalia.json の一部（ui・extra・基本と書き出しの項目）の hash。画面が読んだあとにその部分が変わったかを見る。 */
export function configPartHash(value: unknown): string {
  return hashText(JSON.stringify(value ?? null));
}

/**
 * liminalia.json の一部を書き換える（updateConfig）。part は raw からその部分を取り出す。baseHash を渡したときは、
 * 読んだあとにその部分がほかで変わっていれば書かずに今の中身を返す。書けたら（中身が同じで書かなかったときも）その部分の hash を返す。
 */
export function updateConfigPart<T>(ws: StudioWorkspace, part: (raw: Record<string, unknown>) => T, baseHash: string | undefined, mutate: (raw: Record<string, unknown>) => void): PartWrite<T> {
  const out: { conflict: PartRead<T> | null; hash: string | null } = { conflict: null, hash: null };
  updateConfig(ws, (raw) => {
    const before = part(raw);
    const hash = configPartHash(before);
    if (baseHash !== undefined && hash !== baseHash) {
      out.conflict = { value: before, hash };
      return false;
    }
    mutate(raw);
    out.hash = configPartHash(part(raw));
  });
  return out.conflict ? { ok: false, current: out.conflict } : { ok: true, hash: out.hash };
}
