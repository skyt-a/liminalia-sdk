/**
 * 現在地（GET /sweep）と持続の帯（GET /sweep/stage）の大きさと、作るのにかかる時間を測る（画面の開発用。作品には何も書かない）。
 *   npx tsx packages/studio/dev/measure.ts <プロジェクト> [ファイル…]
 * ファイルを省くと全部。大きい順に、JSON の大きさ・gzip したあとの大きさ・作る時間と、行の状態の項目ごとの内訳を出す。
 * 「前の形」は、行の状態が stage・game を重ねて持ち、変数とその出どころ・ファイルの中で選んだ選択肢を毎行全部持っていたとき
 * （差分にする前）の大きさ。
 */
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { lineAssigned, lineChoices, lineSave } from "../src/protocol.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";

const [dir, ...only] = process.argv.slice(2);
if (!dir) {
  console.error("使い方: tsx packages/studio/dev/measure.ts <プロジェクト> [ファイル…]");
  process.exit(1);
}
const ws = await StudioWorkspace.open(loadProject(resolve(dir)));
const files = only.length > 0 ? only : ws.files();
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)}MB`;
const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
const rows: { file: string; ms: number; lines: number; json: number; gz: number; old: number; oldGz: number; track: number; trackGz: number; fields: Record<string, number> }[] = [];
for (const file of files) {
  const t0 = performance.now();
  const r = await ws.sweep(file);
  const ms = performance.now() - t0;
  const fields: Record<string, number> = {};
  for (const state of Object.values(r.sweep.lines)) {
    for (const [k, v] of Object.entries(state)) {
      if (k === "save") for (const [sk, sv] of Object.entries(v as object)) fields[`save.${sk}`] = (fields[`save.${sk}`] ?? 0) + JSON.stringify(sv ?? null).length;
      else fields[k] = (fields[k] ?? 0) + JSON.stringify(v ?? null).length;
    }
  }
  const track = JSON.stringify(await ws.stageTrack(file));
  const oldLines: Record<string, unknown> = {};
  for (const [line, state] of Object.entries(r.sweep.lines)) {
    const save = lineSave(r.sweep, state);
    oldLines[line] = { save, stage: save.stage, game: save.game, temp: state.temp, assigned: lineAssigned(r.sweep, state), choices: lineChoices(r.sweep, state) };
  }
  const { base: _base, runs: _runs, ...rest } = r.sweep;
  const old = JSON.stringify({ ...rest, lines: oldLines });
  rows.push({
    file,
    ms,
    lines: Object.keys(r.sweep.lines).length,
    json: Buffer.byteLength(r.json),
    gz: (await r.gz()).length,
    old: Buffer.byteLength(old),
    oldGz: gzipSync(old).length,
    track: Buffer.byteLength(track),
    trackGz: gzipSync(track).length,
    fields,
  });
}
rows.sort((a, b) => b.json - a.json);
let total = 0;
let totalGz = 0;
let totalOld = 0;
let totalOldGz = 0;
for (const r of rows) {
  total += r.json;
  totalGz += r.gz;
  totalOld += r.old;
  totalOldGz += r.oldGz;
  const top = Object.entries(r.fields)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k} ${mb(v)}`)
    .join("・");
  console.log(`${r.file}: ${r.lines} 行の状態・${mb(r.json)}（gzip ${mb(r.gz)}）・前の形 ${mb(r.old)}（gzip ${mb(r.oldGz)}）・${Math.round(r.ms)}ms・帯 ${kb(r.track)}（gzip ${kb(r.trackGz)}）\n    ${top}`);
}
console.log(`合計 ${mb(total)}（gzip ${mb(totalGz)}）・前の形 ${mb(totalOld)}（gzip ${mb(totalOldGz)}）`);
