import { parseCredits } from "@liminalia/lang";
import { t, type CommandDefinition } from "@liminalia/plugin-host";
import { leaveParam, presentLeaving } from "./chapter.ts";

/**
 * スタッフロール（流れる文字）。@staff-roll の行と @end の行のあいだに中身を書くか、file= で data/ の JSON（文字列の配列）を指す。
 * 中身の書き方は @liminalia/lang の credits.ts（`# 見出し`、空の行、`{img パス}`、それ以外は文字）。
 * 下から上へ time の時間で流し、流し終えるまで次に進まない。クリックで終わりまで飛ばせ（skip=false なら飛ばせない）、スキップ中は流さない。
 * 状態には残さない（流している途中のセーブは、この命令の次から再開する）。
 */
const staffRollCommand: CommandDefinition = {
  name: "staff-roll",
  summary: "スタッフロール（下から上へ流れる文字）を出し、流し終えるまで待つ。@staff-roll の行と @end の行のあいだに中身を書くか、file= で data の JSON を指す",
  positional: [],
  params: {
    file: t.string("中身の JSON（data フォルダからのパス。拡張子を省くと .json。文字列の配列で、@end までの中身と同じ書き方）。書けば @end は要らない"),
    time: t.duration("流し終えるまでの時間", "60s"),
    bg: t.color("後ろに敷く色（#000000cc などで透かせる。省くと敷かない）"),
    fade: t.duration("出し始めと流し終えたあとのフェードにかける時間", "1s"),
    leave: leaveParam("none"),
    skip: t.skip(),
  },
  example: "@staff-roll time=90s bg=#000000\n# シナリオ\nユイ\n\n# 音楽\nレン\n@end",
  waits: true,
  async run(args, ctx) {
    // 中身は描画側へ行の並びで渡す（file= なら描画側が data から読む）
    const lines = ctx.body !== undefined ? parseCredits(ctx.body.split("\n")) : null;
    await presentLeaving({ ...args, ...(lines ? { lines: lines as unknown as never } : {}) }, ctx, true);
  },
};

export const COMMANDS: CommandDefinition[] = [staffRollCommand];
