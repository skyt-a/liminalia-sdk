import { parse, type Script, type Statement } from "@liminalia/lang";
import { listPackScenarioFiles, readScenarioFile } from "@liminalia/project";
import type { SearchLine, SearchRequest, SearchResult } from "../protocol.ts";
import { bodyRanges, lineMatcher, SearchPatternError } from "../search.ts";
import { hashText, StudioError, type StudioWorkspace } from "./workspace.ts";

/** 返す行の上限（これより多く当たったら、そこでやめて truncated を立てる）。 */
export const SEARCH_LINE_LIMIT = 5000;
/** 正規表現が重いときにやめるまで（ミリ秒）。 */
const SEARCH_TIME_LIMIT = 3000;

/** 探すファイルか（scope がファイル名ならそのファイル、"/" で終わればそのフォルダの下のファイルすべて、無ければすべて）。 */
export function inScope(file: string, scope: string | undefined): boolean {
  if (!scope) return true;
  return scope.endsWith("/") ? file.startsWith(scope) : file === scope;
}

/**
 * 全体の検索（POST /search）。シナリオのフォルダのすべての .lim（サブフォルダも）を、解析を使い回して開発サーバーの中で探す
 * （画面がファイルを一つずつ取りに行かない。スマホ版では Service Worker の中で動く）。探し方は ../search.ts。
 * 本文だけのときは、解析で台詞と地の文の行を選び、その中の本文の字（bodyRanges）だけを見る。
 * scope で探すファイル（開いているファイル、フォルダ）を、speaker でその話者の台詞の行だけに絞る。
 * 開いているファイルのまだ保存していない内容（req.open）は、ディスクの代わりにそれを探す。
 * req.packs なら、本体の台本のあとにパック（packs/<フォルダ>/scenario）の台本も探す（packs/<フォルダ>/scenario/<台本> の名前で、pack にパックのフォルダ。
 * パックの cast.json の話者も足して読む。UTF-8 で読めない台本は飛ばす）。
 */
export function searchProject(ws: StudioWorkspace, req: SearchRequest): SearchResult {
  let match;
  try {
    match = lineMatcher(req);
  } catch (e) {
    if (e instanceof SearchPatternError) throw new StudioError(400, `正規表現として読めません: ${e.message}`);
    throw e;
  }
  const out: SearchResult = { files: [], count: 0, truncated: false };
  if (!match) return out;
  const started = Date.now();
  let found = 0;
  /** 一つのファイルを探す。打ち切ったら false。 */
  const searchFile = (file: string, text: string, hash: string, read: () => Script, pack?: string): boolean => {
    const rows = text.split("\n");
    const script = req.body || req.speaker ? read() : null;
    const body = req.body ? bodyStarts(script!.body, rows) : null;
    const said = req.speaker ? speakerLines(script!.body, req.speaker) : null;
    const lines: SearchLine[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (said && !said.has(i + 1)) continue;
      const from = body?.get(i + 1);
      if (body && from === undefined) continue;
      let spans = match(row);
      // 本文の範囲は、行のどこかに当たったときだけ求める（範囲は当たったものを絞るだけなので、結果は同じ）
      if (from !== undefined && spans.length > 0) {
        const ranges = bodyRanges(row, from);
        spans = spans.filter((s) => ranges.some(([a, b]) => a <= s.at && s.at + s.length <= b));
      }
      if (spans.length > 0) {
        lines.push({ line: i + 1, text: row, spans });
        out.count += spans.length;
        found++;
      }
      if (found >= SEARCH_LINE_LIMIT || ((i & 255) === 0 && Date.now() - started > SEARCH_TIME_LIMIT)) {
        out.truncated = true;
        break;
      }
    }
    if (lines.length > 0) out.files.push({ file, hash, lines, ...(pack ? { pack } : {}) });
    return !out.truncated;
  };
  for (const file of ws.files()) {
    if (!inScope(file, req.scope)) continue;
    const open = req.open?.file === file ? req.open.text : null;
    const text = open ?? ws.script(file).text;
    const hash = open === null ? ws.script(file).hash : hashText(open);
    if (!searchFile(file, text, hash, () => (open === null ? ws.script(file).script : parse(open, file, { speakers: ws.castFile.speakers })))) return out;
  }
  if (!req.packs) return out;
  for (const f of listPackScenarioFiles(ws.project.root)) {
    if (!inScope(f.place, req.scope)) continue;
    const { text, encoding } = readScenarioFile(f.path);
    if (encoding) continue;
    const speakers = [...new Set([...ws.castFile.speakers, ...f.speakers])];
    if (!searchFile(f.place, text, hashText(text), () => parse(text, f.name, { speakers }), f.pack)) return out;
  }
  return out;
}

/** その話者の台詞の行（@if・@define の中も）。 */
function speakerLines(statements: readonly Statement[], speaker: string): Set<number> {
  const out = new Set<number>();
  const visit = (list: readonly Statement[]) => {
    for (const s of list) {
      if (s.kind === "say" && s.speaker === speaker) out.add(s.line);
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(statements);
  return out;
}

/** 本文の行（台詞と地の文。@if・@define の中も）→ その行の本文の始まり（台詞なら話者の名前の後ろ）。 */
function bodyStarts(statements: readonly Statement[], rows: readonly string[]): Map<number, number> {
  const out = new Map<number, number>();
  const visit = (list: readonly Statement[]) => {
    for (const s of list) {
      if (s.kind === "say" || s.kind === "prose") {
        const indent = /^[ \t]*/.exec(rows[s.line - 1] ?? "")![0].length;
        out.set(s.line, indent + (s.kind === "say" ? s.speaker.length : 0));
      } else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(statements);
  return out;
}
