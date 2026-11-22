import { relative, resolve } from "node:path";
import { assertScenariosUtf8, exportVoiceScript } from "@liminalia/project";
import { loadContext } from "../context.ts";
import { countEn } from "../english.ts";

/**
 * lim voice-script [プロジェクト] [--out フォルダ] [--lang en] — 収録用の台本を CSV で書き出す（@liminalia/project の exportVoiceScript）。
 * 全体.csv・話者ごとの <話者>.csv・集計.csv。ボイスのファイルは台詞の前の @voice か、番号の固定（lim voice-lock）と @voice-auto の pattern から。
 * --lang en は all.csv・<話者>.csv・summary.csv に英語の見出しで書き、経過も英語。
 */
export async function runVoiceScript(dir: string, out?: string, language: "ja" | "en" = "ja"): Promise<boolean> {
  const { project } = await loadContext(dir);
  // 化けた台詞を収録用の台本に書き出さない
  assertScenariosUtf8(project.paths.scenario, language);
  const r = exportVoiceScript(project, out ? resolve(out) : undefined, language);
  if (language === "en") {
    console.log(`${relative(process.cwd(), r.folder) || "."}: wrote ${countEn(r.lines, "line")} (${countEn(r.speakers, "speaker")})`);
    if (r.missing > 0) console.log(`  ${countEn(r.missing, "line")} ${r.missing === 1 ? "has" : "have"} no voice file yet (set it with @voice, or with the pattern of @voice-auto and lim voice-lock)`);
    return true;
  }
  console.log(`${relative(process.cwd(), r.folder) || "."}: 台詞 ${r.lines} 件（話者 ${r.speakers} 人）を出力しました`);
  if (r.missing > 0) console.log(`  ボイスのファイルが決まっていない台詞が ${r.missing} 件あります（@voice か、@voice-auto の pattern と lim voice-lock で決まります）`);
  return true;
}
