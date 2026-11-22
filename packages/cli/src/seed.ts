import { parse, type Script, type Statement } from "@liminalia/lang";
import { loadScenarioSource } from "@liminalia/project";
import { findRoute, type SaveData } from "@liminalia/runtime";
import { runtimeOptionsOf, type Context } from "./context.ts";

/**
 * 書き出しに同梱するテスト用セーブ（途中の場面から遊べるセーブ）を作る。
 *
 * - successful_route: 開始位置から画面なしで流し、指定した場所の最初のページに着いた時点の状態を保存する。
 *   選択肢は後戻りの探索で決める（着かなければ最後の選択を次の番号に変えてやり直す）。
 *   外れの選択でバッドエンドに行った道筋は捨て、着けた最初の道筋を使う。
 * - fresh: 指定した場所から何もない状態で始め、最初のページの状態を保存する（意図して初期状態で飛ぶとき用）。
 * 実際に流して作るので、変数だけでなく演出の状態（背景・立ち絵・音）も正しく入る。
 * 道筋の探索は @liminalia/runtime の findRoute（制作画面の現在地と共有）。
 */
export interface SeedRequest {
  file: string;
  label: string | null;
  mode: "successful_route" | "fresh";
}

export async function buildSeedSave(ctx: Context, req: SeedRequest): Promise<SaveData> {
  // 台本は lim test、lim reach と同じ読み方（無いか、UTF-8 で読めなければ止める）
  const source = (file: string) => loadScenarioSource(ctx.project.paths.scenario, file);

  // 着いたと見なすのは、指定ファイルの（ラベルがあればその行より後の）最初のページ
  let labelLine = 0;
  if (req.label) {
    labelLine = labelLineOf(parse(source(req.file), req.file, { speakers: ctx.cast.speakers }), req.label);
    if (labelLine === 0) throw new Error(`ラベル #${req.label} が ${req.file}.lim にありません`);
  }

  // ページの途中のセーブは、そのページから再開する位置になる（findRoute が着いた時点で runtime.save() する）
  const target = req.label ? `${req.file}#${req.label}` : req.file;
  const found = await findRoute({
    loadSource: async (f) => source(f),
    // セーブの版は、書き出したゲームの版（project/build.json の version。環境変数 LIMINALIA_VERSION があればそれ）と同じにする
    runtime: { ...runtimeOptionsOf(ctx), ...(process.env.LIMINALIA_VERSION ? { gameVersion: process.env.LIMINALIA_VERSION } : {}), onError: "continue", maxSteps: 500_000 },
    start: req.mode === "fresh" ? target : ctx.project.config.entry,
    reached: (kind, at) => kind === "page" && at.file === req.file && at.line > labelLine,
    // fresh は道筋を探さず、一回流すだけ
    ...(req.mode === "fresh" ? { attempts: 1 } : {}),
  });
  if (found) return found.save;
  if (req.mode === "fresh") throw new Error(`${target} から始めても本文のページに到達しません`);
  throw new Error(`${ctx.project.config.entry} から ${target} に到達するルートが見つかりません。初期状態でジャンプする場合は --seed-mode fresh を指定してください`);
}

/**
 * 台本のラベルの行（1 から。@if、@while、@with、@define の中も見て、書いた順の最初のもの）。無ければ 0。
 * 解析したラベルで探すので、@html の中身や選択肢の行のようにラベルでない行は拾わない。
 */
export function labelLineOf(script: Script, label: string): number {
  const find = (body: readonly Statement[]): number => {
    for (const s of body) {
      if (s.kind === "label" && s.name === label) return s.line;
      const inner = s.kind === "if" ? s.branches.map((b) => b.body) : s.kind === "define" ? [s.body] : [];
      for (const b of inner) {
        const line = find(b);
        if (line) return line;
      }
    }
    return 0;
  };
  return find(script.body);
}
