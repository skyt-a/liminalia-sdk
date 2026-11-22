/**
 * 重さを測るための作品の形（ひな形 templates/default を写して足す）。dev/measure-studio.ts と確かめの道具が使う。作品には何も書かない。
 *
 * - long: 8,000 行級のファイル一つ（ひな形の本文を、ラベルとジャンプ先に番号を付けて複製する）
 * - many: 小さなファイル 300（フォルダ 10 に分け、それぞれ 10 シーン）、変数 3,000、構文チェックの警告 1,500、背景の素材 2,000
 * - branchy: 選択肢が 14 段続く迷路の先に、どのルートでも届かない行がある（届かない行の探索が 15 秒かかる）
 */
import { cpSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SHAPES = ["long", "many", "branchy"] as const;
export type Shape = (typeof SHAPES)[number];

/** その形で測る代表のファイルと行（ブロック表示で直す行・届かない行）。 */
export interface ShapeInfo {
  /** 開いて測るファイル。 */
  file: string;
  /** ブロック表示で一字足す本文の行。 */
  editLine: number;
  /** 今のルートで届かない行（無ければ null）。 */
  unreachable: number | null;
  /** 届かない行のファイル（省くと file）。 */
  reachFile?: string;
}

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

export function makeShape(shape: Shape, dir: string): ShapeInfo {
  cpSync(TEMPLATE, dir, { recursive: true });
  const scenario = join(dir, "scenario");
  if (shape === "long") {
    const src = readFileSync(join(scenario, "start.lim"), "utf8").split("\n");
    // 頭のコメント（最初のラベルの前）は最初の一回だけ
    const first = src.findIndex((l) => /^# /.test(l));
    const body = src.slice(first).filter((l) => !l.startsWith("@jump epilogue"));
    const out = src.slice(0, first);
    for (let k = 0; out.length < 8000; k++) {
      for (const l of body) out.push(l.replace(/^# (\S+)/, `# $1_${k}`).replace(/(-> |@jump |@call )#([a-z_]+)/g, (_m, p: string, n: string) => `${p}#${n}_${k}`));
    }
    writeFileSync(join(scenario, "big.lim"), out.join("\n"));
    const editLine = out.findIndex((l, i) => i > 4000 && l.startsWith("　")) + 1;
    return { file: "big", editLine, unreachable: null };
  }
  if (shape === "many") {
    const files: string[] = [];
    for (let f = 0; f < 300; f++) {
      const folder = `part${String(Math.floor(f / 30)).padStart(2, "0")}`;
      const name = `${folder}/ch${String(f).padStart(3, "0")}`;
      files.push(name);
      const lines: string[] = [];
      for (let s = 0; s < 10; s++) {
        lines.push(`# s${s}`, `@set game.v${f}_${s} = ${s}`, `@bg hill_dusk.webp`, `アカリ「${f} の ${s} の台詞です」`, `　${f} の ${s} の地の文です。`, `@chara ソウ normal at=right`, `ソウ「返事です」`);
        // 構文チェックの警告（無い素材）
        if (s < 5) lines.push(`@se missing_${f}_${s}.wav`);
        lines.push("");
      }
      lines.push(f < 299 ? `@jump ${`part${String(Math.floor((f + 1) / 30)).padStart(2, "0")}`}/ch${String(f + 1).padStart(3, "0")}` : "@stop");
      mkdirSync(join(scenario, folder), { recursive: true });
      writeFileSync(join(scenario, `${name}.lim`), lines.join("\n"));
    }
    // はじめからの最後に、たくさんのファイルの頭へ
    const start = join(scenario, "epilogue.lim");
    writeFileSync(start, readFileSync(start, "utf8").replace(/@stop\s*$/, "") + `\n@jump ${files[0]}\n`);
    const bg = join(dir, "assets/bgimage");
    for (let i = 0; i < 2000; i++) linkSync(join(bg, "hill_night.webp"), join(bg, `many_${String(i).padStart(4, "0")}.webp`));
    return { file: files[0]!, editLine: 4, unreachable: null };
  }
  // branchy: 14 段の選択肢（どれを選んでも次の段へ）。それぞれの段のあいだに本文のページを挟む
  const lines: string[] = ["# maze", "@bg hill_night.webp"];
  for (let d = 0; d < 14; d++) {
    for (let p = 0; p < 12; p++) lines.push(`　${d} 段目の ${p} ページ目の地の文です。`);
    lines.push("@choice", `  - 右へ ${d} -> #d${d}`, `  - 左へ ${d} -> #d${d}`, `  - まっすぐ ${d} -> #d${d}`, "@end", `# d${d}`);
  }
  lines.push("@if game.never == 1");
  const unreachable = lines.length + 1;
  lines.push("　どのルートでも届かない行です。", "@end", "@stop");
  writeFileSync(join(scenario, "maze.lim"), lines.join("\n"));
  const start = join(scenario, "start.lim");
  writeFileSync(start, readFileSync(start, "utf8").replace(/^# start\n/m, "# start\n@jump maze\n"));
  return { file: "maze", editLine: 3, unreachable };
}
