import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * 「ここからテストプレイ」で、作品を開いている制作画面が無いときに立ち上げる方法（VS Code に触らない部分。extension.ts が使う）。
 * npm から別のものを取りに行かないよう、npx は使わない。次の順で探す:
 * - lim: 設定 liminalia.lim（lim.mjs などのスクリプトなら Node で動かす）、無ければ作品の node_modules の @liminalia/cli
 * - 制作アプリ: 設定 liminalia.studioApp、無ければよく入る場所（Mac の /Applications と ~/Applications、Windows の %LOCALAPPDATA%\Programs と Program Files）
 * 信頼していないワークスペースでは、作品の中の lim（node_modules と、作品の中を指す設定）を動かさず、立ち上げる lim studio も制限付き
 * （LIMINALIA_RESTRICTED=1。作品のプラグインを読まない）にする。
 */

/** 動かすもの。lim はターミナルで動かし、app は作品を開くよう制作アプリに渡す（ターミナルを使わない）。 */
export interface Launch {
  command: string;
  args: string[];
  /** 足す環境変数（VS Code の中の Node で lim を動かすときの ELECTRON_RUN_AS_NODE）。 */
  env?: Record<string, string>;
}

export interface LaunchContext {
  root: string;
  /** 設定 liminalia.lim（空なら探す）。 */
  limSetting: string;
  /** 設定 liminalia.studioApp（空なら探す）。 */
  appSetting: string;
  /** 設定 liminalia.node（空なら VS Code の中の Node。execPath を ELECTRON_RUN_AS_NODE で動かす）。 */
  node: string;
  execPath: string;
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  exists: (path: string) => boolean;
  /** ワークスペースを信頼しているか（vscode.workspace.isTrusted。省くと信頼している）。 */
  trusted?: boolean;
}

/** 制作アプリの名前（packages/studio-desktop の productName）。 */
export const STUDIO_APP_NAME = "Liminalia Studio";

const expand = (path: string, c: LaunchContext) => {
  const home = path.replace(/^~(?=$|[/\\])/, c.home);
  return isAbsolute(home) ? home : resolve(c.root, home);
};

/** Node で lim のスクリプトを動かす。 */
function viaNode(script: string, c: LaunchContext, args: readonly string[]): Launch {
  if (c.node !== "") return { command: c.node, args: [script, ...args] };
  return { command: c.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** 信頼していないワークスペースでは、作品のプラグインを読まない lim にする。 */
function restrict(launch: Launch, c: LaunchContext): Launch {
  return c.trusted === false ? { ...launch, env: { ...(launch.env ?? {}), LIMINALIA_RESTRICTED: "1" } } : launch;
}

/** lim を args で動かす方法（見つからなければ null。lim studio と、台本のテストの lim test が使う）。 */
export function limCommand(c: LaunchContext, args: readonly string[]): Launch | null {
  if (c.limSetting.trim() !== "") {
    const path = expand(c.limSetting.trim(), c);
    // 信頼していないワークスペースでは、作品の中を指す lim を動かさない
    if (c.trusted === false && !relative(c.root, path).startsWith("..") && !isAbsolute(relative(c.root, path))) return null;
    return restrict(/\.(?:mjs|cjs|js|ts)$/i.test(path) ? viaNode(path, c, args) : { command: path, args: [...args] }, c);
  }
  if (c.trusted === false) return null;
  const local = join(c.root, "node_modules", "@liminalia", "cli", "bin", "lim.mjs");
  return c.exists(local) ? viaNode(local, c, args) : null;
}

/** lim studio を動かす方法（見つからなければ null）。 */
export function limLaunch(c: LaunchContext): Launch | null {
  return limCommand(c, ["studio", "."]);
}

/** 制作アプリの場所（見つからなければ null）。 */
export function findStudioApp(c: LaunchContext): string | null {
  if (c.appSetting.trim() !== "") {
    const path = expand(c.appSetting.trim(), c);
    return c.exists(path) ? path : null;
  }
  const candidates =
    c.platform === "darwin"
      ? [join("/Applications", `${STUDIO_APP_NAME}.app`), join(c.home, "Applications", `${STUDIO_APP_NAME}.app`)]
      : c.platform === "win32"
        ? [c.env.LOCALAPPDATA, c.env.ProgramFiles].filter((d): d is string => !!d).map((d) => join(d, ...(d === c.env.LOCALAPPDATA ? ["Programs"] : []), STUDIO_APP_NAME, `${STUDIO_APP_NAME}.exe`))
        : [];
  return candidates.find((p) => c.exists(p)) ?? null;
}

/** 制作アプリで作品を開く方法（Mac は open -a、ほかはアプリの実行ファイルに作品のフォルダを渡す。動いているアプリがあればそちらが開く）。 */
export function appLaunch(c: LaunchContext): Launch | null {
  const app = findStudioApp(c);
  if (!app) return null;
  if (c.platform === "darwin" && app.endsWith(".app")) return { command: "open", args: ["-a", app, c.root] };
  return { command: app, args: [c.root] };
}
