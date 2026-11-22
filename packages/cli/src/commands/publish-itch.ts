import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { loadProject, type Project } from "@liminalia/project";
import { childPath } from "@liminalia/project/contained-path";
import { isTestBuild, testBuildProblem } from "../built.ts";
import { builtGameJson, latestDesktopBuild } from "./publish-steam.ts";

/**
 * lim publish [プロジェクト] itch [browser,windows,mac,linux] [--target 人/ゲーム] [--build 先=フォルダ,…] [--channel 先=名前,…]
 *                                 [--userversion 版] [--allow-test] [--dry-run]
 *
 * 書き出したゲームを itch.io へ butler で上げる（butler push）。上げる先のゲームは liminalia.json の build.itch.target（"人/ゲーム"）か
 * --target。チャンネルは既定でブラウザ版 html5、Windows 版 windows、Mac 版 mac、Linux 版 linux（itch.io がチャンネルの名前から
 * OS を決める。build.itch.channels か --channel で替える）。版はプロジェクトの version（--userversion で替える）。
 * 上げるものは、省くとブラウザ版は <out>/browser/<id>、ほかは <out>/<先>/ の一番新しい書き出し。書き出しの確かめの写真と、配る形の
 * zip、dmg、tar.gz は入れない。butler のログインは butler login か、環境変数 BUTLER_API_KEY（lim は鍵を受け取らない）。
 * テスト版（lim build --feedback）の書き出しは上げない（--allow-test で上げる）。
 */

export type ItchTarget = "browser" | "windows" | "mac" | "linux";
const TARGETS: ItchTarget[] = ["browser", "windows", "mac", "linux"];
const DEFAULT_CHANNELS: Record<ItchTarget, string> = { browser: "html5", windows: "windows", mac: "mac", linux: "linux" };
/** 上げないもの（butler push --ignore）。 */
const IGNORE = ["verify-title.png", "*.zip", "*.dmg", "*.tar.gz", ".DS_Store"];

export interface ItchPublishOptions {
  targets?: ItchTarget[];
  target?: string;
  builds?: Partial<Record<ItchTarget, string>>;
  channels?: Partial<Record<ItchTarget, string>>;
  userversion?: string;
  /** テスト版（lim build --feedback）の書き出しも上げる。 */
  allowTest?: boolean;
  dryRun?: boolean;
}

export interface ItchPlan {
  pushes: { what: ItchTarget; folder: string; channel: string; command: string[] }[];
  problems: string[];
}

/** 今のフォルダからのパス（外なら絶対パス）。 */
function shown(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r || ".";
}

/** butler の場所（LIMINALIA_BUTLER → PATH）。無ければ null。 */
export function findButler(env: Record<string, string | undefined> = process.env): string | null {
  if (env.LIMINALIA_BUTLER) return existsSync(env.LIMINALIA_BUTLER) ? env.LIMINALIA_BUTLER : null;
  const names = process.platform === "win32" ? ["butler.exe"] : ["butler"];
  for (const dir of (env.PATH ?? "").split(delimiter)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return null;
}

/** butler が無いときの案内。 */
export const BUTLER_HOW_TO = "butler（itch.io のアップロードツール）が見つかりません。https://itchio.itch.io/butler からインストールして PATH に置き、butler login でログインしてください（場所は環境変数 LIMINALIA_BUTLER でも指定できます。CI では BUTLER_API_KEY に API キーを置きます）";

/** 上げる段取り（どのフォルダをどのチャンネルへ上げるか）。足りないものは problems に。 */
export function planItchPublish(project: Project, o: ItchPublishOptions, butler: string | null = findButler()): ItchPlan {
  const itch = project.config.build?.itch;
  const problems: string[] = [];
  const target = o.target ?? itch?.target;
  if (!target) problems.push('上げる先のゲームがありません（liminalia.json の build.itch.target に "人の名前/ゲームの名前"（itch.io のゲームのページの URL の形）か --target）');
  else if (!/^[^/\s:]+\/[^/\s:]+$/.test(target)) problems.push(`上げる先のゲームは "人の名前/ゲームの名前" の形で書きます: ${target}`);
  const out = project.paths.out;
  const latest = (what: ItchTarget): string | null => {
    if (what === "browser") {
      // id が書き出し先の外を指していても、外のフォルダを上げない（<書き出し先>/browser の直下だけ）
      const dir = childPath(join(out, "browser"), project.config.id);
      return dir && existsSync(join(dir, "index.html")) ? dir : null;
    }
    return latestDesktopBuild(out, what);
  };
  // 先を書かなければ、書き出してあるものを全部
  const wanted = o.targets ?? TARGETS.filter((t) => o.builds?.[t] || latest(t));
  if (wanted.length === 0) problems.push("上げる書き出しがありません（lim build browser,windows,mac,linux で書き出すか、--build browser=フォルダ）");
  const version = o.userversion ?? process.env.LIMINALIA_VERSION ?? project.config.version;
  const pushes: ItchPlan["pushes"] = [];
  for (const what of wanted) {
    const given = o.builds?.[what];
    const folder = given ? resolve(given) : latest(what);
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
      problems.push(given ? `${what} の書き出し ${given} がありません` : `${what} の書き出しがありません（lim build ${what} で書き出すか、--build ${what}=フォルダ）`);
      continue;
    }
    if (what === "browser" && !existsSync(join(folder, "index.html"))) problems.push(`${shown(folder)} の一番上に index.html がありません（ブラウザ版の書き出しのフォルダを選んでください）`);
    if (!o.allowTest && isTestBuild(folder, out)) problems.push(testBuildProblem(shown(folder)));
    if (what !== "browser") {
      const game = builtGameJson(folder);
      if (game?.steam) problems.push(`${shown(folder)} は Steam につなぐ書き出しです（itch.io では Steam が無いと動かないので、lim build ${what} --steam off で書き出してください）`);
    }
    const channel = o.channels?.[what] ?? itch?.channels?.[what] ?? DEFAULT_CHANNELS[what];
    const command = [butler ?? "butler", "push", folder, `${target ?? "<人>/<ゲーム>"}:${channel}`, ...(version ? ["--userversion", version] : []), ...IGNORE.flatMap((p) => ["--ignore", p])];
    pushes.push({ what, folder, channel, command });
  }
  if (!butler && !o.dryRun) problems.push(BUTLER_HOW_TO);
  return { pushes, problems };
}

export function runPublishItch(dir: string, o: ItchPublishOptions): boolean {
  const project = loadProject(dir);
  const plan = planItchPublish(project, o);
  for (const p of plan.problems) console.error(`  ${p}`);
  if (plan.problems.length > 0 && !o.dryRun) {
    console.error("\nitch.io へ上げるのをやめました");
    return false;
  }
  console.log("itch.io へ上げるもの:");
  for (const p of plan.pushes) console.log(`  ${p.what}: ${p.channel} ← ${shown(p.folder)}`);
  const line = (c: string[]) => c.map((a) => (/[\s*]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  if (o.dryRun) {
    console.log("\n--dry-run のため、動かすコマンドを出すだけにしました:");
    for (const p of plan.pushes) console.log(line(p.command));
    return plan.problems.length === 0;
  }
  for (const p of plan.pushes) {
    console.log(`\n${line(p.command)}`);
    const r = spawnSync(p.command[0]!, p.command.slice(1), { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`\nbutler が失敗しました（${p.what}、終了の値 ${r.status}）。ログインしていなければ butler login を動かしてください`);
      return false;
    }
  }
  console.log("\nitch.io へ上げました。ゲームの編集の画面で、チャンネルごとの OS の種類とブラウザで遊ぶ設定を確かめてください");
  return true;
}

/** --build browser=a,windows=b や --channel windows=win を読む。 */
export function parseTargetMap(value: string, what: string): Partial<Record<ItchTarget, string>> {
  const out: Partial<Record<ItchTarget, string>> = {};
  for (const part of value.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(browser|windows|mac|linux)=(.+)$/.exec(part);
    if (!m) throw new Error(`${what} は browser=…、windows=…、mac=…、linux=… の形で書きます: ${part}`);
    out[m[1] as ItchTarget] = m[2]!;
  }
  return out;
}

/** 上げる先の並び（"browser,windows"）を読む。 */
export function parseItchTargets(value: string): ItchTarget[] {
  const list = value.split(",").map((x) => x.trim()).filter(Boolean);
  for (const t of list) if (!(TARGETS as string[]).includes(t)) throw new Error(`itch.io へ上げる先は browser、windows、mac、linux から選びます: ${t}`);
  return list as ItchTarget[];
}
