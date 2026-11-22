import { forwardClass, forwardFunction } from "./host.ts";
import type * as Running from "@liminalia/editor/running";
import type * as Server from "@liminalia/studio/server-plugin";

/**
 * 制作画面の開発サーバーのプラグイン（作品のプラグインの "./studio-server"）の約束。定義の関数と型はここにあり、
 * StudioServerError と findRunningStudio は開発サーバーの実装を使う。
 */

/** 開発サーバーのプラグインを定義する（型を付けるだけ）。 */
export function defineStudioServerPlugin(plugin: Server.StudioServerPlugin): Server.StudioServerPlugin {
  return plugin;
}

/** 口の処理で投げると、その状態と文で答える断り。 */
export const StudioServerError = forwardClass<typeof Server.StudioServerError>("studio-server", "StudioServerError");
/** 作品を開いている制作画面（開発サーバー）を探す。 */
export const findRunningStudio = forwardFunction<typeof Running.findRunningStudio>("studio-server", "findRunningStudio");

export type { StudioRequest, StudioRoute, StudioServerContext, StudioServerPlugin } from "@liminalia/studio/server-plugin";
export type { RunningStudio } from "@liminalia/editor/running";
