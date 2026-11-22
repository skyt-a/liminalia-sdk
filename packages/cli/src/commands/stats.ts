import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toCsv, type Script, type StatsRow, type VariantGroup } from "@liminalia/lang";
import { LOCAL_VARIANTS_FILE, loadProject, packScenarioPlace, projectPackScripts, projectScripts, projectTextReport, readCast, readVoiceLock, type ProjectTextReport } from "@liminalia/project";
import { countEn } from "../english.ts";

/** 表記ゆれの種類の名前。 */
export const VARIANT_KIND_NAMES: Record<string, string> = { kana: "漢字とかな", okurigana: "送り仮名", symbol: "記号", width: "全角と半角", name: "キャラクター名", glossary: "用語集", custom: "辞書" };
/** 表記ゆれの種類の英語の名前（Studio の英語表示の stats.kinds と同じ）。 */
export const VARIANT_KIND_NAMES_EN: Record<string, string> = { kana: "Kanji and kana", okurigana: "Okurigana", symbol: "Symbols", width: "Full and half width", name: "Character names", glossary: "Glossary", custom: "Dictionary" };

export type StatsLanguage = "ja" | "en";

/**
 * 書き出すファイルの名前。日本語は前からの名前のまま（既に使っている人の手順や読み込みを壊さない）、--lang en は英語の名前にする。
 */
export const STATS_FILES: Record<StatsLanguage, { markdown: string; files: string; scenes: string; speakers: string; variants: string }> = {
  ja: { markdown: "統計.md", files: "ファイル別.csv", scenes: "シーン別.csv", speakers: "話者別.csv", variants: "表記ゆれ.csv" },
  en: { markdown: "stats.md", files: "files.csv", scenes: "scenes.csv", speakers: "speakers.csv", variants: "variants.csv" },
};

/** 表の見出し（CSV と統計.md の表）。 */
const HEAD = {
  ja: {
    rows: ["台詞の行", "台詞の文字数", "地の文の行", "地の文の文字数", "選択肢の数", "選択肢の文字数", "ボイス"],
    file: "ファイル",
    label: "ラベル",
    line: "行",
    speakers: ["話者", "台詞の行", "台詞の文字数", "ボイス"],
    variants: ["組", "種類", "書き方", "件数", "ファイル", "行", "抜き出し"],
  },
  en: {
    rows: ["Dialogue lines", "Dialogue characters", "Narration lines", "Narration characters", "Choices", "Choice characters", "Voiced"],
    file: "File",
    label: "Label",
    line: "Line",
    speakers: ["Speaker", "Dialogue lines", "Dialogue characters", "Voiced"],
    variants: ["Group", "Kind", "Form", "Count", "File", "Line", "Excerpt"],
  },
};

/**
 * lim stats [プロジェクト] [--out フォルダ] [--json] [--lang en]
 *
 * ファイル別、シーン別、話者別の台詞と地の文の行の数と文字数、ボイスの付いた台詞の数と、表記ゆれの候補を集計する。
 * パック（packs/<フォルダ>/scenario）の台本も数え、ファイルの名前は packs/<フォルダ>/scenario/<台本> で出す。
 * 合計は、パックが差し替える本体の台本も、パックの台本も足したもの（書いた分量。遊ぶときに出る分量ではない）。
 * 既定は exports/stats に 統計.md と CSV（ファイル別、シーン別、話者別、表記ゆれ）を書き、要約を出す。--json は JSON を出すだけ。
 * --lang en は、ファイルの名前（stats.md、files.csv など）と中身、要約を英語にする。
 * 表記ゆれの辞書は liminalia.json の stats.variants と .liminalia/variants.json。
 */
export async function runStats(dir: string, o: { out?: string; json: boolean; language?: StatsLanguage }): Promise<boolean> {
  const lang = o.language ?? "ja";
  const project = loadProject(dir);
  const cast = readCast(project);
  const scripts = statsScripts(project);
  let lock = null;
  try {
    lock = readVoiceLock(project);
  } catch {
    // 番号の固定が読めなければ、固定していない台本として数える（読めないことは lim check が知らせる）
    lock = null;
  }
  const r = projectTextReport({ root: project.root, config: project.config, scripts, speakers: cast.speakers, lock });
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return true;
  }
  const folder = resolve(project.root, o.out ?? "exports/stats");
  mkdirSync(folder, { recursive: true });
  const bom = "﻿";
  const names = STATS_FILES[lang];
  const head = HEAD[lang];
  const kinds = lang === "en" ? VARIANT_KIND_NAMES_EN : VARIANT_KIND_NAMES;
  writeFileSync(join(folder, names.markdown), statsMarkdown(r, lang));
  writeFileSync(join(folder, names.files), bom + toCsv([[head.file, ...head.rows], ...r.stats.files.map((f) => [f.file, ...cells(f)])]));
  writeFileSync(join(folder, names.scenes), bom + toCsv([[head.file, head.label, head.line, ...head.rows], ...r.stats.scenes.map((s) => [s.file, s.label ?? "", s.line, ...cells(s)])]));
  writeFileSync(join(folder, names.speakers), bom + toCsv([head.speakers, ...r.stats.speakers.map((s) => [s.speaker, s.say.lines, s.say.chars, s.voiced])]));
  writeFileSync(
    join(folder, names.variants),
    bom + toCsv([head.variants, ...r.variants.flatMap((g) => g.forms.flatMap((f) => f.occurrences.map((x) => [g.id, kinds[g.kind] ?? g.kind, f.label, f.count, `${x.file}.lim`, x.line, x.excerpt])))]),
  );
  const t = r.stats.total;
  const sample = r.variants.slice(0, 5).map((g) => g.forms.map((f) => `${f.label} ${f.count}`).join(lang === "en" ? " / " : "／"));
  if (lang === "en") {
    console.log(`Dialogue: ${countEn(t.say.lines, "line")}, ${countEn(t.say.chars, "character")}; narration: ${countEn(t.prose.lines, "line")}, ${countEn(t.prose.chars, "character")}; choices: ${t.choice.lines}, ${countEn(t.choice.chars, "character")}`);
    console.log(`Voiced dialogue: ${countEn(t.voiced, "line")}; ${countEn(r.stats.speakers.length, "speaker")}; ${countEn(r.stats.scenes.length, "scene")}`);
    console.log(`Spelling variants: ${countEn(r.variants.length, "group")}${r.variants.length > 0 ? ` (${sample.join(", ")}${r.variants.length > 5 ? " and more" : ""})` : ""}`);
    console.log(`Wrote to ${folder}`);
    if (r.variants.length > 0) console.log(`To hide a group, add its name to stats.variants.ignore in liminalia.json (or to ${LOCAL_VARIANTS_FILE} for this computer only)`);
    return true;
  }
  console.log(`台詞 ${t.say.lines} 行 ${t.say.chars} 文字、地の文 ${t.prose.lines} 行 ${t.prose.chars} 文字、選択肢 ${t.choice.lines} 個 ${t.choice.chars} 文字`);
  console.log(`ボイスの付いた台詞 ${t.voiced} 行、話者 ${r.stats.speakers.length} 人、シーン ${r.stats.scenes.length} 個`);
  console.log(r.variants.length === 0 ? "表記ゆれの候補 0 組" : r.variants.length > 5 ? `表記ゆれの候補 ${r.variants.length} 組（${sample.join("、")} ほか ${r.variants.length - 5} 組）` : `表記ゆれの候補 ${r.variants.length} 組（${sample.join("、")}）`);
  console.log(`書き出したフォルダ: ${folder}`);
  if (r.variants.length > 0) console.log(`出さない組は liminalia.json の stats.variants.ignore（手元だけなら ${LOCAL_VARIANTS_FILE}）に組の名前を書きます`);
  return true;
}

/** 数える台本（本体の台本、続けてパックの台本。パックの台本の名前は packs/<フォルダ>/scenario/<台本>。台詞の鍵は台本の名前で作るので、番号の固定はそのまま引ける）。 */
export function statsScripts(project: Parameters<typeof projectScripts>[0]): Map<string, Script> {
  const out = new Map([...projectScripts(project)].map(([name, s]) => [name, s.script] as const));
  for (const pack of projectPackScripts(project)) for (const [name, s] of pack.scripts) out.set(packScenarioPlace(pack.dir, name), s.script);
  return out;
}

const cells = (r: StatsRow) => [r.say.lines, r.say.chars, r.prose.lines, r.prose.chars, r.choice.lines, r.choice.chars, r.voiced];

/** 統計.md（--lang en なら stats.md）の中身。 */
export function statsMarkdown(r: ProjectTextReport, lang: StatsLanguage = "ja"): string {
  const en = lang === "en";
  const t = r.stats.total;
  const pct = (a: number, b: number) => (b === 0 ? "0%" : `${Math.round((a / b) * 100)}%`);
  const out: string[] = [en ? "# Text counts and spelling variants" : "# 文字数と表記ゆれ", ""];
  out.push(en ? "| | Lines | Characters |" : "| | 行 | 文字数 |", "|---|---:|---:|");
  out.push(
    `| ${en ? "Dialogue" : "台詞"} | ${t.say.lines} | ${t.say.chars} |`,
    `| ${en ? "Narration" : "地の文"} | ${t.prose.lines} | ${t.prose.chars} |`,
    `| ${en ? "Choices" : "選択肢"} | ${t.choice.lines} | ${t.choice.chars} |`,
  );
  out.push(`| ${en ? "Total" : "合計"} | ${t.say.lines + t.prose.lines + t.choice.lines} | ${t.say.chars + t.prose.chars + t.choice.chars} |`, "");
  out.push(en ? `Voiced dialogue: ${countEn(t.voiced, "line")} (${pct(t.voiced, t.say.lines)} of dialogue)` : `ボイスの付いた台詞: ${t.voiced} 行（台詞の ${pct(t.voiced, t.say.lines)}）`, "");
  const table = (head: string, rows: [string, StatsRow][]) => {
    out.push(
      en ? `| ${head} | Dialogue lines | Dialogue characters | Narration lines | Narration characters | Choices | Voiced |` : `| ${head} | 台詞の行 | 台詞の文字数 | 地の文の行 | 地の文の文字数 | 選択肢 | ボイス |`,
      "|---|---:|---:|---:|---:|---:|---:|",
    );
    for (const [name, x] of rows) out.push(`| ${name} | ${x.say.lines} | ${x.say.chars} | ${x.prose.lines} | ${x.prose.chars} | ${x.choice.lines} | ${x.voiced} |`);
    out.push("");
  };
  out.push(en ? "## By file" : "## ファイル別", "");
  table(en ? "File" : "ファイル", r.stats.files.map((f) => [`${f.file}.lim`, f]));
  out.push(en ? "## By scene" : "## シーン別", "");
  table(en ? "Scene" : "シーン", r.stats.scenes.map((s) => [s.label === null ? (en ? `${s.file}.lim (start)` : `${s.file}.lim（先頭）`) : `${s.file}.lim #${s.label}`, s]));
  out.push(en ? "## By speaker" : "## 話者別", "", en ? "| Speaker | Dialogue lines | Characters | Voiced |" : "| 話者 | 台詞の行 | 文字数 | ボイス |", "|---|---:|---:|---:|");
  for (const s of r.stats.speakers) out.push(`| ${s.speaker} | ${s.say.lines} | ${s.say.chars} | ${s.voiced} |`);
  out.push("", en ? "## Spelling variants" : "## 表記ゆれの候補", "");
  if (r.variants.length === 0) out.push(en ? "None." : "ありません。");
  for (const g of r.variants) out.push(...variantMarkdown(g, lang));
  return `${out.join("\n")}\n`;
}

function variantMarkdown(g: VariantGroup, lang: StatsLanguage): string[] {
  const en = lang === "en";
  const kind = (en ? VARIANT_KIND_NAMES_EN : VARIANT_KIND_NAMES)[g.kind] ?? g.kind;
  const out = [
    `### ${g.forms.map((f) => (en ? `${f.label} (${f.count})` : `${f.label}（${f.count}）`)).join(en ? " / " : "／")}`,
    "",
    en ? `${kind}. Group name: \`${g.id}\`` : `${kind}。組の名前: \`${g.id}\``,
    "",
  ];
  // 多い書き方は件数だけ、少ない書き方は場所を並べる（直す候補）
  for (const f of g.forms.slice(1)) for (const x of f.occurrences.slice(0, 20)) out.push(`- ${f.label}: ${x.file}.lim:${x.line} ${x.excerpt}`);
  out.push("");
  return out;
}
