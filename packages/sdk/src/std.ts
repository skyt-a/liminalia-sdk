import { t, type ParamDefinition } from "./command.ts";
import { forwardFunction } from "./host.ts";
import type * as Std from "@liminalia/std/commands";

/** 標準の命令（@liminalia/std）の部品のうち、プラグインの命令でも使えるもの。 */

/** 演出の終わりに暗転を残すか（演出の命令に共通の引数）。mask は黒で覆ったまま次へ進み、次の @mask-off で開く。 */
export const leaveParam = (def: "none" | "mask"): ParamDefinition =>
  t.enum(["none", "mask"], "終わったあと（mask は黒で覆ったまま次へ進み、次の @mask-off で開く。none は元の画面に戻す）", def);

/** leave=mask の命令の実行: 演出を待ち、待ったなら暗転を状態に残す（標準の命令と同じ動き）。 */
export const presentLeaving = forwardFunction<typeof Std.presentLeaving>("std", "presentLeaving");
