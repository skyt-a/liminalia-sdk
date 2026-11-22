import { relative } from "node:path";
import { loadProject } from "@liminalia/project";
import { playwrightProvider } from "@liminalia/studio/browser";
import { mb, measureProfile, profileUrl, writeProfileReport } from "@liminalia/studio/profile";
import { resolveShotTarget } from "@liminalia/studio/target";
import { startPlayerServer } from "../web.ts";
import { countEn } from "../english.ts";

// 計測の中身は制作画面（チェックの「重さを計る」）と共有する（@liminalia/studio の server/profile.ts）
export { profileMarkdown } from "@liminalia/studio/profile";
export type { ProfileReport, ProfileSample } from "@liminalia/studio/protocol";

export interface ProfileOptions {
  /** 始める位置（ファイル[#ラベル]）。省くと liminalia.json の entry。 */
  target?: string;
  /** 進めるページの数。 */
  pages: number;
  /** ページを出し切ってから次へ進めるまで待つミリ秒（その間のフレームレートを計る）。 */
  wait: number;
  /** 選択肢で選ぶ番号（0 始まり）を順に。使い切ったら最初の選択肢。 */
  choose: number[];
  /** 書き出すフォルダ（プロジェクトからのパス。既定 exports/profile）。 */
  out?: string;
  json: boolean;
  /** en なら、書き出すファイルの名前（profile.md、profile.json）と中身、経過と要約を英語にする。 */
  language?: "ja" | "en";
}

/**
 * lim profile [プロジェクト] [ファイル[#ラベル]] [--pages 30] [--wait 500] [--choose 0,1] [--out フォルダ] [--json] [--lang en]
 *
 * 開発サーバーのプレイヤーを Chromium で開き、決めたページ数を進めながら重さを計る（ゲームの画面の F10 と同じ数値）。
 * ページを出し切ってから wait ミリ秒待ってフレームレートなどを取り、次へ送る（選択肢は --choose の番号、使い切ったら最初）。
 * exports/profile に 計測.md と 計測.json を書き、要約を出す（--json は JSON を出すだけ）。--lang en は profile.md と profile.json に英語で書き、要約も英語。
 */
export async function runProfile(dirArg: string, o: ProfileOptions): Promise<boolean> {
  const en = o.language === "en";
  const project = loadProject(dirArg);
  const target = o.target === undefined ? project.config.entry : resolveShotTarget(project, o.target);
  const { server, url } = await startPlayerServer(project, 0, true);
  let report;
  try {
    const page = await playwrightProvider.open(profileUrl(url, target), project.screen);
    try {
      report = await measureProfile(page, target, {
        pages: o.pages,
        wait: o.wait,
        choose: o.choose,
        progress: (n, total, at) => {
          if (!o.json) process.stdout.write(`\r${en ? "Measuring" : "計測"} ${n} / ${total} ${at.padEnd(30)}`);
        },
      });
    } finally {
      await page.close();
    }
    if (!o.json) process.stdout.write("\n");
  } finally {
    await server.close();
  }
  if (o.json) {
    console.log(JSON.stringify(report, null, 2));
    return true;
  }
  const folder = writeProfileReport(project.root, report, o.out, en ? "en" : "ja");
  const sm = report.summary;
  if (en) {
    console.log(`${countEn(report.pages, "page")}: frame rate ${sm.fps.average ?? "—"} fps on average (lowest ${sm.fps.min ?? "—"}), long frames ${sm.frames.long} / ${sm.frames.count} (longest ${sm.frames.longest} ms)`);
    console.log(`JS memory ${mb(sm.memory.start)} → ${mb(sm.memory.end)} (highest ${mb(sm.memory.max)}), DOM elements up to ${sm.dom.max}`);
    console.log(`Assets loaded: ${countEn(sm.resources.image.count, "image")}, ${mb(sm.resources.image.bytes)}; ${countEn(sm.resources.audio.count, "audio file")}, ${mb(sm.resources.audio.bytes)}`);
    console.log(`Wrote to ${relative(process.cwd(), folder) || "."}`);
    return true;
  }
  console.log(`${report.pages} ページ: フレームレート 平均 ${sm.fps.average ?? "—"} fps（最低 ${sm.fps.min ?? "—"}）、長いフレーム ${sm.frames.long} / ${sm.frames.count}（一番長いもの ${sm.frames.longest} ms）`);
  console.log(`JS のメモリ ${mb(sm.memory.start)} → ${mb(sm.memory.end)}（最大 ${mb(sm.memory.max)}）、DOM の要素 最大 ${sm.dom.max}`);
  console.log(`読み込んだ素材: 画像 ${sm.resources.image.count} 個 ${mb(sm.resources.image.bytes)}、音 ${sm.resources.audio.count} 個 ${mb(sm.resources.audio.bytes)}`);
  console.log(`書き出したフォルダ: ${relative(process.cwd(), folder) || "."}`);
  return true;
}
