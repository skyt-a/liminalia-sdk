import type { Args, CommandContext } from "@liminalia/runtime";
import { t, type CommandDefinition, type ParamDefinition } from "@liminalia/sdk";

/**
 * 章の扉と章末の演出（@chapter-card・@chapter-end）。番号と題と副題は、省くと今の章（liminalia.json の chapters）から補う。
 * 見た目はテーマの色と書体（--lm-title-bg、--lm-fg、--lm-accent、--lm-text-font）に合わせ、作品の CSS で .lim-chapter を上書きできる。
 * 一回きりの演出で状態には残さないが、leave=mask なら終わったところで暗転（stage.mask）を残し、次の @mask-off で開く。
 */

/** 演出の終わりに暗転を残すか（演出の命令に共通の引数）。mask は黒で覆ったまま次へ進み、次の @mask-off で開く。 */
export const leaveParam = (def: "none" | "mask"): ParamDefinition =>
  t.enum(["none", "mask"], "終わったあと（mask は黒で覆ったまま次へ進み、次の @mask-off で開く。none は元の画面に戻す）", def);

/** 暗転を残すときの色。 */
export const LEAVE_COLOR = "#000000";

/**
 * leave=mask の命令の実行: 演出を待ち、待ったなら暗転を状態に残す（ロードしても覆ったまま）。覆っているあいだの本文は捨てる
 * （@mask と同じく、次の本文は新しいページから）。待たない呼び出しでは覆わない。
 */
export async function presentLeaving(args: Args, ctx: CommandContext, wait: boolean): Promise<void> {
  await ctx.present(args, wait);
  if (wait && args.leave === "mask") {
    ctx.state.stage.mask = LEAVE_COLOR;
    delete ctx.state.stage.nvlPages;
    delete ctx.state.stage.noclickPage;
  }
}

/** 省いた番号・題・副題を、今の章から補う。 */
function withChapter(args: Args, ctx: CommandContext): Args {
  const chapter = ctx.runtime.chapter;
  if (!chapter) return args;
  const out: Args = { ...args };
  const fill = (key: string, value: unknown) => {
    if ((out[key] === undefined || out[key] === "") && typeof value === "string" && value !== "") out[key] = value;
  };
  fill("number", chapter.number);
  fill("title", chapter.title);
  fill("subtitle", chapter.subtitle);
  return out;
}

const shared = {
  number: t.text("章の番号の表記（第一章、EPISODE 01 など）。省くと今の章の number"),
  title: t.text("題。省くと今の章の title"),
  subtitle: t.text("副題や英題。省くと今の章の subtitle"),
  image: t.asset("bgimage", "後ろに敷く絵（省くとテーマの地の色。CG なら解放する）", { cg: true }),
};

const chapterCardCommand: CommandDefinition = {
  name: "chapter-card",
  summary: "章の扉として、番号、題、副題を画面いっぱいに出し、しばらく置いて消す。省いたものは今の章（liminalia.json の chapters）から出す。leave=mask なら暗転を残す",
  params: {
    ...shared,
    time: t.duration("出しておく時間（出し終えてから消し始めるまで）", "2500ms"),
    fade: t.duration("出す時間と消す時間", "800ms"),
    leave: leaveParam("none"),
    wait: t.bool("消し終わるまで次に進まない（false なら待たず、暗転も残さない）", true),
    skip: t.skip(),
  },
  example: "@chapter-card leave=mask",
  waits: true,
  run: (args, ctx) => presentLeaving(withChapter(args, ctx), ctx, args.wait !== false),
};

const chapterEndCommand: CommandDefinition = {
  name: "chapter-end",
  summary: "章末の演出として、章の番号と題に終わりの表記を添えて出し、暗転して終える。省いたものは今の章から出す。既定で暗転を残し、次の @mask-off で開く",
  params: {
    ...shared,
    text: t.text("終わりの表記（省くと「完」。英語で遊んでいれば End）"),
    time: t.duration("出しておく時間", "3s"),
    fade: t.duration("出す時間と消す時間", "1s"),
    leave: leaveParam("mask"),
    wait: t.bool("終わるまで次に進まない（false なら待たず、暗転も残さない）", true),
    skip: t.skip(),
  },
  example: "@chapter-end",
  waits: true,
  run: (args, ctx) => presentLeaving(withChapter(args, ctx), ctx, args.wait !== false),
};

export const COMMANDS: CommandDefinition[] = [chapterCardCommand, chapterEndCommand];
