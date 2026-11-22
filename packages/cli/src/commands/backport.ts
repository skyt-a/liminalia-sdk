import { relative } from "node:path";
import { backportProject, makeBackportBase } from "@liminalia/ks-import/node";

/**
 * lim backport [プロジェクト] --make-base <基準> --tyrano <TyranoScript のプロジェクト>
 *   書き戻しの基準（取り込んだ時点の .ks・.lim・対応表）を作る。.lim を正本に切り替える時点で一度だけ行う。
 *
 * lim backport [プロジェクト] --base <基準> [--tyrano <TyranoScript のプロジェクト>] [--out <フォルダ>] [--write [--force]]
 *   今の .lim の変更を .ks に書き戻した一式を --out（既定は .liminalia/backport/scenario）に作り、取り込み直して確かめる。
 *   --write のときだけ取り込み元の data/scenario に書く。--force が無ければ、書き戻せなかった箇所があるか確かめが一致しないときは
 *   何も書かず、取り込み元が基準から変わっているファイルは書かない。
 */
export async function runMakeBackportBase(dir: string, base: string, tyrano: string): Promise<boolean> {
  const { report, info, same, differs } = await makeBackportBase(dir, base, tyrano);
  console.log(`書き戻しの基準を作成しました: ${base}`);
  console.log(`- インポート: ${report.files} ファイル（本文の一致 ${report.fidelity.filter((f) => f.mismatch === null).length} / ${report.fidelity.length}）`);
  console.log(info.git ? `- インポート元: ${info.tyrano}（${info.git.branch} ${info.git.commit.slice(0, 8)}、data/scenario の未コミットの変更 ${info.git.dirty.length} 件）` : `- インポート元: ${info.tyrano}`);
  if (same) console.log("- 基準の .lim はプロジェクトの現在の .lim と同じです");
  else console.log(`- 基準の .lim がプロジェクトの現在の .lim と異なります（${differs.slice(0, 8).join(" ")}${differs.length > 8 ? ` ほか ${differs.length - 8} 件` : ""}）。切り替える前にプロジェクトの .lim を基準の lim/ に合わせてください`);
  return report.ok && same;
}

export async function runBackport(dir: string, o: { base: string; tyrano?: string; out?: string; write: boolean; force: boolean }): Promise<boolean> {
  const { report, out, tyrano, copied, refused, held } = await backportProject(dir, o);
  console.log(report.markdown.split("\n").slice(0, 7).join("\n"));
  console.log(`レポート: ${report.reportPath}`);
  console.log(`書き戻した .ks: ${out}`);
  if (held) {
    console.log("書き戻せなかった箇所があるか、照合の結果が一致しないため、インポート元には書き込んでいません（レポートを見て修正するか、--force で書き込みます）");
  } else if (o.write) {
    console.log(copied.length > 0 ? `${tyrano} の data/scenario に ${copied.length} ファイルを書き込みました（${copied.join(" ")}）` : `${tyrano} の data/scenario に ${copied.length} ファイルを書き込みました`);
    if (refused.length > 0) console.log(`インポート元が基準から変更されているため書き込まなかったファイル（--force で上書き）: ${refused.join(" ")}`);
  } else if (report.written.length > 0) {
    console.log(`インポート元（${relative(process.cwd(), tyrano) || "."}）には書き込んでいません。書き込むときは --write を付けてください`);
  }
  return report.verified && report.failed === 0 && refused.length === 0 && !held;
}
