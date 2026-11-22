import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_COMMANDS, createRegistry, withCommandDefaults, type Registry, type VoiceLock } from "@liminalia/lang";
import { CONFIG_FILE, loadCommandPlugins, loadProject, projectDataReader, readCast, readVoiceLock, type CastFile, type Project } from "@liminalia/project";
import { projectRuntimeOptions, type CommandImpl, type ProjectRuntimeOptions } from "@liminalia/runtime";
import { combinePlugins, type CommandPlugin } from "@liminalia/plugin-host";

/** lim に --restricted を付けたか（main.ts が LIMINALIA_RESTRICTED=1 にするときに覚える。書き出しの断りで、環境変数で制限したときと分ける）。 */
let restrictedFlag = false;

/** --restricted を付けたと覚える（main.ts）。 */
export function markRestrictedFlag(): void {
  restrictedFlag = true;
}

/**
 * 制限付きで読んだ作品を書き出さないときの断り。制限した理由で直し方を分ける（--restricted と LIMINALIA_RESTRICTED=1）。
 */
export function restrictedBuildMessage(env: Readonly<Record<string, string | undefined>> = process.env, byFlag = restrictedFlag): string {
  if (byFlag) return "--restricted を付けたので書き出しません（作品のプラグインを読まずに書き出すと、別のゲームになります）。--restricted を外すと書き出せます";
  if (env.LIMINALIA_RESTRICTED === "1") return "環境変数 LIMINALIA_RESTRICTED=1 で制限付きにしているので書き出しません。LIMINALIA_RESTRICTED を外すと書き出せます";
  return "制限付きで開いているので書き出しません（作品のプラグインを読まずに書き出すと、別のゲームになります）";
}

/** CLI のどのコマンドも使う、プロジェクトとプラグインを読み込んだもの。 */
export interface Context {
  project: Project;
  cast: CastFile;
  plugins: CommandPlugin[];
  /** 組み込みとプラグインのコマンドの仕様に、作品の既定値（commandDefaults）を重ねたもの。 */
  registry: Registry;
  implementations: CommandImpl[];
  combined: ReturnType<typeof combinePlugins>;
}

/**
 * 画面なしで流すときの実行器の設定（lim trace、lim test、lim coverage、lim reach、lim build --seed、lim voice-lock）。遊ぶ側と同じく
 * @liminalia/runtime の projectRuntimeOptions で作品の設定から作る（言語は原文の言語、訳は無し）。流し方で変えるもの（上限、
 * エラーで止めるか、乱数の種など）は呼ぶ側が足す。
 */
export function runtimeOptionsOf(ctx: Context): ProjectRuntimeOptions {
  return projectRuntimeOptions({
    config: ctx.project.config,
    speakers: ctx.cast.speakers,
    commands: ctx.implementations,
    cast: ctx.cast.cast,
    voiceLock: voiceLockOf(ctx.project),
    // 作品のデータで動く命令（図鑑・調べる場所など）の ctx.data
    loadData: projectDataReader(ctx.project),
  });
}

/** 連番のボイスの番号の固定（voice-lock.json）。無い・読めなければ null（遊ぶ側と同じ。読めないことは lim check が知らせる）。 */
function voiceLockOf(project: Project): VoiceLock | null {
  try {
    return readVoiceLock(project);
  } catch {
    // 読めない固定は無いものとして流す（遊ぶ側の player-info.ts と同じ。JSON の誤りは検査が bad-voice-lock で知らせる）
    return null;
  }
}

export async function loadContext(dir: string): Promise<Context> {
  const project = loadProject(dir);
  const plugins = await loadCommandPlugins(project);
  const combined = combinePlugins(plugins);
  return {
    project,
    cast: readCast(project),
    plugins,
    // 作品の既定値（commandDefaults）を重ねたもの。検査・lim trace などが省いたパラメータをこの値として見る
    registry: withCommandDefaults(createRegistry(CORE_COMMANDS, combined.specs), project.config.commandDefaults),
    implementations: combined.implementations,
    combined,
  };
}

/**
 * 引数の先頭がプロジェクトのフォルダ（liminalia.json がある）ならそれを、なければ今のフォルダを使う。
 * optional なら、どちらにも無いとき null を返す。
 */
export function takeProjectDir(args: string[]): string;
export function takeProjectDir(args: string[], o: { optional: true }): string | null;
export function takeProjectDir(args: string[], o?: { optional: true }): string | null {
  const first = args[0];
  if (first !== undefined && !first.startsWith("--") && existsSync(join(first, CONFIG_FILE))) {
    args.shift();
    return first;
  }
  if (existsSync(CONFIG_FILE)) return ".";
  if (o?.optional) return null;
  throw new Error(`プロジェクトが見つかりません。${CONFIG_FILE} のあるフォルダを指定してください`);
}

export { loadImportProfile, loadPluginImports } from "@liminalia/ks-import/node";

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export interface Flags {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["count", "update", "json", "settle", "title", "intro", "no-import", "no-verify", "seed-overwrite", "write", "force", "check", "fresh", "zip", "dmg", "github", "strict", "dry-run", "all", "aab", "archive", "upload", "preview", "rebuild", "require-endings", "clear-rerecord", "assets", "no-assets", "fast", "log", "shots", "untranslated", "changed", "stamp-ids", "lines", "feedback", "only-used", "resume", "no-audio", "auto", "endings", "screens", "portrait", "landscape", "line"]);

/** booleans は値を取らない旗の名前（既定は lim の各コマンドのもの。lim new の --title は値を取る）。 */
export function parseFlags(argv: string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS): Flags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=", 2);
      if (eq >= 0) {
        // --旗=値 の形（--min-lines=80 など。書かなければ旗の名前に = まで付いて、値も次の位置引数も飲まれる）。
        // 値を取らない旗は、消す値（false・0・no・off）なら付けず、ほかなら付ける（--write=false で上書きしないように）
        const key = a.slice(2, eq);
        if (booleans.has(key)) {
          if (!/^(?:false|0|no|off)$/i.test(a.slice(eq + 1))) flags.set(key, true);
        } else {
          flags.set(key, a.slice(eq + 1));
        }
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!booleans.has(name) && next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function str(flags: Flags, name: string): string | undefined {
  const v = flags.flags.get(name);
  return typeof v === "string" ? v : undefined;
}
