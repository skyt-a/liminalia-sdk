import { importStoryProject, type EndMode, type StoryKind } from "@liminalia/story-import/node";
import { assetCopySummary } from "@liminalia/project/asset-copy";
import { loadContext } from "../context.ts";

/**
 * lim import-ink  [プロジェクト] <ファイル.ink> [--name 名前] [--end title|stop|return] [--force]
 * lim import-yarn [プロジェクト] <ファイル.yarn かフォルダ…> [--name 名前] [--end title|stop|return] [--force]
 * lim import-renpy [プロジェクト] <ファイル.rpy かフォルダ…> [--name 名前] [--end title|stop|return] [--force]
 * lim import-twine [プロジェクト] <ファイル.twee かフォルダ…> [--name 名前] [--end title|stop|return] [--force]
 *
 * Ink・Yarn Spinner・Ren'Py・Twine（Twee 3）のシナリオを .lim にしてシナリオのフォルダに書き、話者を cast.json に、変数の初期値を liminalia.json に足す。
 * タグ・コマンドは組み込みの対応表と liminalia.json の import.ink.commands / import.yarn.commands で .lim のコマンドにし（Ink と Yarn）、
 * 対応表に無いものと変換しない構文はコメントにして報告（<ink|yarn|renpy|twine>-import-report.md）に出す。
 */
export async function runImportStory(dir: string, kind: StoryKind, inputs: string[], o: { name?: string; end?: string; force: boolean; assets?: boolean }): Promise<boolean> {
  if (o.end !== undefined && !["title", "stop", "return"].includes(o.end)) throw new Error("--end には title、stop、return のどれかを指定してください");
  if (inputs.length === 0) throw new Error(MISSING_INPUT[kind]);
  const ctx = await loadContext(dir);
  const r = importStoryProject(dir, kind, inputs, {
    registry: ctx.registry,
    force: o.force,
    ...(o.assets === false ? { assets: false } : {}),
    ...(o.name ? { name: o.name } : {}),
    ...(o.end ? { end: o.end as EndMode } : {}),
  });
  console.log(r.report.split("\n").slice(0, 14).join("\n"));
  if (r.written.length > 0) console.log(`書き出したファイル: ${r.written.join("、")}`);
  if (r.refused.length > 0) console.log(`上書きしなかったファイル: ${r.refused.join("、")}（--force で上書きします）`);
  if (r.assets) console.log(assetCopySummary(r.assets));
  for (const t of r.translations) console.log(`訳: ${t.file}（${t.total} 項目のうち ${t.filled} 項目）`);
  console.log(`詳細: ${r.reportPath}`);
  return r.ok;
}

const MISSING_INPUT: Record<StoryKind, string> = {
  ink: "取り込む .ink のファイルを指定してください（lim import-ink story.ink）",
  yarn: "取り込む .yarn のファイルかフォルダを指定してください（lim import-yarn dialogue/）",
  renpy: "取り込む .rpy のファイルかフォルダを指定してください（lim import-renpy game/）",
  twine: "取り込む .twee のファイルかフォルダを指定してください（lim import-twine story.twee）",
};
