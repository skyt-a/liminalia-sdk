import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * 作品のコードを動かさずに読む（制限付き）かどうかと、作品を開くと動くものの一覧。
 *
 * 自分の作品を書くのが普通の使い方なので、作品を開くたびに信頼するかは尋ねない（ほかのノベルゲームのエンジンと同じ）。
 * 制限付きで読むのは、使う人が自分で選んだときだけ: lim の --restricted と LIMINALIA_RESTRICTED=1、VS Code の信頼していない
 * ワークスペース（vscode の studio-launch.ts が LIMINALIA_RESTRICTED=1 を置く）。制限付きでは作品のプラグインを読まず（標準の命令だけ）、
 * 書き出しを止める。どの道具も loadProject を通るので、loadProject が環境変数で決める（restrictedFromEnv）。
 * 動くものの一覧（projectCode）は、URL から取ってきたひな形で作品を作るとき（lim new --from）に、何が入っているかを見せるのに使う。
 */

/** 作品を開くと動くもの。 */
export interface ProjectCode {
  /** plugin: プラグイン、sign: Windows 版の署名のコマンド、wrap: Windows 版の実行ファイルを包むコマンド、store: デスクトップ版の店の口。 */
  kind: "plugin" | "sign" | "wrap" | "store";
  /** liminalia.json に書いたもの（プラグインの指定、コマンド、モジュールのパス）。 */
  name: string;
  /** プラグインの入口（commands、web、import、studio、studio-server）。読めなければ空。 */
  entries?: string[];
}

/** プラグインの入口の名前。 */
export const PLUGIN_ENTRIES = ["commands", "web", "import", "studio", "studio-server"] as const;

/** liminalia.json のうち、動くコードを書く所。 */
interface CodeConfig {
  plugins?: unknown;
  import?: { tyrano?: { profile?: unknown } };
  build?: { windows?: { sign?: { command?: unknown }; wrap?: unknown }; store?: { desktop?: { module?: unknown } } };
}

function readConfig(root: string): CodeConfig | null {
  try {
    return JSON.parse(readFileSync(join(root, "liminalia.json"), "utf8")) as CodeConfig;
  } catch {
    // liminalia.json が読めなければ、設定に書いた動くコードは無いものとして数える（読み込みの側で知らせる）
    return null;
  }
}

/** プラグインのフォルダ（"./x" は作品からの相対、ほかはパッケージの名前）。見つからなければ null。 */
function pluginDir(root: string, spec: string): string | null {
  if (spec.startsWith(".") || isAbsolute(spec)) return resolve(root, spec);
  try {
    return dirname(createRequire(join(root, "package.json")).resolve(`${spec}/package.json`));
  } catch {
    // 見つからないプラグインは動くコードとして数えない（読み込みの側で知らせる）
    return null;
  }
}

/** プラグインのパッケージの exports にある入口（読めなければ空）。 */
function pluginEntries(dir: string | null): string[] {
  if (!dir || !existsSync(join(dir, "package.json"))) return [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: Record<string, unknown> };
    return PLUGIN_ENTRIES.filter((e) => pkg.exports?.[`./${e}`] !== undefined);
  } catch {
    // package.json が無いか読めなければ、作品のコードの入口は無いものとして数える
    return [];
  }
}

const words = (v: unknown): string | null => (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? v.join(" ") : null);

/** 作品を開く・書き出すと動くもの（liminalia.json が読めなければ空）。config を渡せば読み直さない。 */
export function projectCode(root: string, config: CodeConfig | null = readConfig(root)): ProjectCode[] {
  if (!config) return [];
  const out: ProjectCode[] = [];
  const plugins = Array.isArray(config.plugins) ? config.plugins.filter((p): p is string => typeof p === "string") : [];
  for (const spec of plugins) out.push({ kind: "plugin", name: spec, entries: pluginEntries(pluginDir(root, spec)) });
  // 取り込みの設定（import.tyrano.profile）は plugins に無くても読む
  const profile = config.import?.tyrano?.profile;
  if (typeof profile === "string" && profile !== "" && !plugins.includes(profile)) out.push({ kind: "plugin", name: profile, entries: pluginEntries(pluginDir(root, profile)) });
  const sign = words(config.build?.windows?.sign?.command);
  if (sign) out.push({ kind: "sign", name: sign });
  const wrap = words(config.build?.windows?.wrap);
  if (wrap) out.push({ kind: "wrap", name: wrap });
  const store = config.build?.store?.desktop?.module;
  if (typeof store === "string" && store !== "") out.push({ kind: "store", name: store });
  return out;
}

const ENTRY_LABEL: Record<string, readonly [string, string]> = {
  commands: ["独自の命令", "custom commands"],
  web: ["描画", "rendering"],
  import: ["取り込み", "import"],
  studio: ["Studio の画面", "Studio panels"],
  "studio-server": ["Studio のサーバー", "Studio server"],
};

/** 動くものの一行（lim new --from の知らせ）。 */
export function projectCodeLine(c: ProjectCode, language: "ja" | "en" = "ja"): string {
  const en = language === "en";
  switch (c.kind) {
    case "plugin": {
      const entries = (c.entries ?? []).map((e) => ENTRY_LABEL[e]?.[en ? 1 : 0] ?? e);
      return en ? `Plugin ${c.name}${entries.length > 0 ? ` (${entries.join(", ")})` : ""}` : `プラグイン ${c.name}${entries.length > 0 ? `（${entries.join("、")}）` : ""}`;
    }
    case "sign":
      return en ? `Windows signing command: ${c.name}` : `Windows 版の署名のコマンド: ${c.name}`;
    case "wrap":
      return en ? `Command that wraps the Windows executable: ${c.name}` : `Windows 版の実行ファイルを包むコマンド: ${c.name}`;
    case "store":
      return en ? `Desktop store module: ${c.name}` : `デスクトップ版の店の口: ${c.name}`;
  }
}

/** 環境変数から、その作品を制限付きで読むかを決める（LIMINALIA_RESTRICTED=1 のときだけ。lim の --restricted もこれを置く）。 */
export function restrictedFromEnv(env: Readonly<Record<string, string | undefined>> = (typeof process === "undefined" ? undefined : process.env) ?? {}): boolean {
  return env.LIMINALIA_RESTRICTED === "1";
}

/** 制限付きで読んだ作品のプラグインの理由（制作画面の帯と lim の警告）。 */
export const RESTRICTED_PLUGIN_MESSAGE = "制限付きで開いているので、プラグインのコードを動かしません";
