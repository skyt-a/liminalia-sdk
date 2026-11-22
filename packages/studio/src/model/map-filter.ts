import type { MapNode, Script, Statement, StoryMap } from "@liminalia/lang";
import { matchesMark, type SceneMarks } from "./scene-marks.ts";

/**
 * フローチャートの絞り込み（画面なし）。シーンごとの話者は開発サーバーが GET /map/cast で返す（sceneSpeakers）。
 * 絞り込みは並べ方を変えず、当てはまらないシーンを薄くする（全体を表示は当てはまるシーンに合わせる）。
 */

/** シーン（地図の id）→ 台詞の話者（書いた順に一つずつ）。 */
export type SceneCast = Record<string, string[]>;

export function sceneSpeakers(map: StoryMap, scripts: ReadonlyMap<string, Script>): SceneCast {
  const out: SceneCast = {};
  const byFile = new Map<string, MapNode[]>();
  for (const n of map.nodes) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
  for (const [file, nodes] of byFile) {
    const script = scripts.get(file);
    if (!script) continue;
    const says: { line: number; who: string }[] = [];
    const visit = (body: readonly Statement[]) => {
      for (const s of body) {
        if (s.kind === "say" && s.speaker) says.push({ line: s.line, who: s.speaker });
        if (s.kind === "if") for (const b of s.branches) visit(b.body);
      }
    };
    visit(script.body);
    for (const n of nodes) {
      const who: string[] = [];
      for (const s of says) if (s.line >= n.line && s.line <= n.end && !who.includes(s.who)) who.push(s.who);
      if (who.length > 0) out[n.id] = who;
    }
  }
  return out;
}

export interface MapFilter {
  /** このファイルのシーンだけ（空なら全部）。 */
  file: string;
  /** この人物が話すシーンだけ（空なら全部）。 */
  who: string;
  /** 全ルートテストで到達しなかったシーンだけ。 */
  unreached: boolean;
  /** プレイの終わるシーンだけ。 */
  endings: boolean;
  /** タグ、色、状態（"" ならすべて。model/scene-marks.ts の matchesMark）。 */
  mark: string;
}

export const NO_FILTER: MapFilter = { file: "", who: "", unreached: false, endings: false, mark: "" };

export const filtering = (f: MapFilter): boolean => f.file !== "" || f.who !== "" || f.unreached || f.endings || f.mark !== "";

/** シーンが絞り込みに当てはまるか。unreached は全ルートテストで通らなかった行（未実行なら null）、marks はシーンのタグ、色、状態。 */
export function matchesFilter(n: MapNode, f: MapFilter, cast: SceneCast, unreached: ReadonlyMap<string, ReadonlySet<number>> | null, marks: SceneMarks = {}): boolean {
  if (f.mark !== "" && !matchesMark(marks[n.id], f.mark)) return false;
  if (f.file !== "" && n.file !== f.file && !n.file.startsWith(`${f.file}/`)) return false;
  if (f.who !== "" && !(cast[n.id] ?? []).includes(f.who)) return false;
  if (f.unreached && unreached?.get(n.file)?.has(n.anchor) !== true) return false;
  if (f.endings && (n.ends === undefined || n.ends === "return")) return false;
  return true;
}

/** フォルダの名前（`part1/chapter2/a` → `part1`・`part1/chapter2`）。ファイルの絞り込みでフォルダごとにも選べるようにする。 */
export function folderNames(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
