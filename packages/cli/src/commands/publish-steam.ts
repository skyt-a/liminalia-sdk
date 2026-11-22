import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, relative, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import { loadProject, type Project } from "@liminalia/project";
import { isTestBuild, testBuildProblem } from "../built.ts";

/**
 * lim publish [プロジェクト] steam [--build os=フォルダ,…] [--app-id N] [--depot os=N,…] [--desc 文] [--branch 名前] [--preview]
 *                                  [--login 名前] [--allow-test] [--dry-run]
 *
 * 書き出したデスクトップ版（lim build mac,windows,linux --steam …）を Steam へ上げる。SteamPipe の app_build と depot_build の
 * VDF を <out>/steam/ に作り、steamcmd の run_app_build で上げる。ログインは steamcmd が尋ねる（パスワードと Steam Guard は人が打つ。
 * lim はパスワードを受け取らない）。--dry-run なら VDF を作って、動かすコマンドを出すだけ。
 *
 * どの OS をどのデポに上げるかは liminalia.json の build.steam.depots（OS → デポ ID。Steamworks の「SteamPipe → デポ」で作る）。
 * 上げるものは、省くと <out>/<OS>/ の一番新しい書き出し（Windows・Linux はゲームのフォルダ、Mac はアプリの入ったフォルダ）。
 * テスト版（lim build --feedback）の書き出しは上げない（--allow-test で上げる）。
 */

export type SteamOs = "windows" | "mac" | "linux";
const OSES: SteamOs[] = ["windows", "mac", "linux"];

export interface SteamPublishOptions {
  builds?: Partial<Record<SteamOs, string>>;
  appId?: number;
  depots?: Partial<Record<SteamOs, number>>;
  desc?: string;
  branch?: string;
  preview?: boolean;
  login?: string;
  /** テスト版（lim build --feedback）の書き出しも上げる。 */
  allowTest?: boolean;
  dryRun?: boolean;
}

/** 今のフォルダからのパス（外なら絶対パス）。 */
function shown(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r || ".";
}

/** VDF の値（" と \ を逃がす）。 */
const q = (v: string | number) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** デポに上げる VDF（ContentRoot の中をすべて。書き出しの確かめの写真と、配る形の zip・dmg・tar.gz は入れない）。 */
export function depotBuildVdf(depot: number, contentRoot: string): string {
  return `"DepotBuild"
{
\t"DepotID" ${q(depot)}
\t"ContentRoot" ${q(contentRoot)}
\t"FileMapping"
\t{
\t\t"LocalPath" "*"
\t\t"DepotPath" "."
\t\t"Recursive" "1"
\t}
\t"FileExclusion" "verify-title.png"
\t"FileExclusion" "*.zip"
\t"FileExclusion" "*.dmg"
\t"FileExclusion" "*.tar.gz"
\t"FileExclusion" ".DS_Store"
}
`;
}

/** アプリのビルドの VDF。depots はデポ ID → depot_build の VDF のファイル名。 */
export function appBuildVdf(o: { appId: number; desc: string; output: string; depots: Record<number, string>; branch?: string; preview?: boolean }): string {
  return `"AppBuild"
{
\t"AppID" ${q(o.appId)}
\t"Desc" ${q(o.desc)}
\t"BuildOutput" ${q(o.output)}${o.branch ? `\n\t"SetLive" ${q(o.branch)}` : ""}${o.preview ? `\n\t"Preview" "1"` : ""}
\t"Depots"
\t{
${Object.entries(o.depots)
  .map(([id, file]) => `\t\t${q(id)} ${q(file)}`)
  .join("\n")}
\t}
}
`;
}

/** steamcmd の場所（LIMINALIA_STEAMCMD → PATH → よくある置き場）。無ければ null。 */
export function findSteamcmd(env: Record<string, string | undefined> = process.env): string | null {
  if (env.LIMINALIA_STEAMCMD) return existsSync(env.LIMINALIA_STEAMCMD) ? env.LIMINALIA_STEAMCMD : null;
  const names = process.platform === "win32" ? ["steamcmd.exe"] : ["steamcmd", "steamcmd.sh"];
  for (const dir of (env.PATH ?? "").split(delimiter)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  const home = homedir();
  const guesses = [join(home, "Steam", "steamcmd.sh"), join(home, "steamcmd", "steamcmd.sh"), join(home, "Library", "Application Support", "Steam", "steamcmd.sh"), "C:\\steamcmd\\steamcmd.exe"];
  return guesses.find((p) => existsSync(p)) ?? null;
}

/** <out>/<OS>/ の一番新しい書き出しの、デポに上げるフォルダ。 */
export function latestDesktopBuild(out: string, os: SteamOs): string | null {
  const dir = join(out, os);
  if (!existsSync(dir)) return null;
  const stamped = readdirSync(dir)
    .filter((n) => /_\d{8}_\d{6}$/.test(n) && statSync(join(dir, n)).isDirectory())
    .sort((a, b) => b.slice(-15).localeCompare(a.slice(-15)));
  if (stamped.length === 0) return null;
  const folder = join(dir, stamped[0]!);
  if (os === "mac") return folder;
  // Windows・Linux は日時のフォルダの中のゲームのフォルダ（zip・tar.gz と並ぶもの）
  const inner = readdirSync(folder).filter((n) => statSync(join(folder, n)).isDirectory());
  return inner.length === 1 ? join(folder, inner[0]!) : folder;
}

/** 書き出したゲームの game.json（Steam につなぐ版かを見る）。読めなければ null。 */
export function builtGameJson(folder: string): { steam?: { appId: number } } | null {
  const asars: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 5) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "app.asar") asars.push(join(dir, e.name));
      else if (e.isDirectory() && !e.isSymbolicLink() && !e.name.endsWith(".framework")) visit(join(dir, e.name), depth + 1);
    }
  };
  visit(folder, 0);
  for (const a of asars) {
    try {
      return JSON.parse(extractFile(a, "game.json").toString("utf8")) as { steam?: { appId: number } };
    } catch {
      // 次へ
    }
  }
  return null;
}

export interface SteamPlan {
  appId: number;
  files: { app: string; depots: { os: SteamOs; depot: number; root: string; vdf: string }[] };
  command: string[];
  problems: string[];
}

/** 上げる段取り（VDF を書き、steamcmd のコマンドを決める）。足りないものは problems に。 */
export function planSteamPublish(project: Project, o: SteamPublishOptions): SteamPlan {
  const steam = project.config.build?.steam;
  const problems: string[] = [];
  const appId = o.appId ?? steam?.appId;
  if (!appId) problems.push("App ID がありません（liminalia.json の build.steam.appId か --app-id）");
  const depots = { ...(steam?.depots ?? {}), ...(o.depots ?? {}) } as Partial<Record<SteamOs, number>>;
  if (Object.keys(depots).length === 0) problems.push('上げる先のデポがありません（liminalia.json の build.steam.depots に { "windows": デポ ID, "mac": …, "linux": … } か --depot windows=ID）');
  if (o.branch === "default") problems.push("default のブランチは steamcmd から公開できません。Steamworks のビルドの画面で公開してください（--branch を外すと公開せずに上げます）");
  const dir = join(project.paths.out, "steam");
  const out = join(dir, "output");
  const entries: SteamPlan["files"]["depots"] = [];
  for (const os of OSES) {
    const depot = depots[os];
    if (!depot) continue;
    const given = o.builds?.[os];
    const root = given ? resolve(given) : latestDesktopBuild(project.paths.out, os);
    if (!root || !existsSync(root)) {
      problems.push(given ? `${os} の書き出し ${given} がありません` : `${os} の書き出しがありません（lim build ${os} --steam で書き出すか、--build ${os}=フォルダ）`);
      continue;
    }
    const game = builtGameJson(root);
    if (!game) problems.push(`${shown(root)} の中に書き出したゲーム（app.asar の game.json）が見つかりません`);
    else if (!game.steam) problems.push(`${shown(root)} は Steam につながない書き出しです（build.steam を書いて lim build ${os} で書き出し直してください）`);
    else if (appId && game.steam.appId !== appId) problems.push(`${shown(root)} は App ID ${game.steam.appId} の書き出しです（上げる先は ${appId}）`);
    if (!o.allowTest && isTestBuild(root, project.paths.out)) problems.push(testBuildProblem(shown(root)));
    entries.push({ os, depot, root, vdf: join(dir, `depot_build_${depot}.vdf`) });
  }
  const app = join(dir, `app_build_${appId ?? 0}.vdf`);
  const desc = o.desc ?? `${project.config.title} ${project.config.version ?? ""}`.trim();
  const login = o.login ?? process.env.LIMINALIA_STEAM_LOGIN ?? "";
  if (!login && !o.dryRun) problems.push("steamcmd でログインする Steam のアカウント名がありません（--login 名前 か環境変数 LIMINALIA_STEAM_LOGIN。パスワードは steamcmd が尋ねます）");
  const steamcmd = findSteamcmd();
  if (!steamcmd && !o.dryRun) problems.push("steamcmd が見つかりません（Steamworks SDK の tools/ContentBuilder/builder_osx/steamcmd.sh など。環境変数 LIMINALIA_STEAMCMD に場所を指定するか、PATH に置いてください）");
  if (problems.length === 0 || o.dryRun) {
    mkdirSync(out, { recursive: true });
    for (const e of entries) writeFileSync(e.vdf, depotBuildVdf(e.depot, e.root));
    writeFileSync(app, appBuildVdf({ appId: appId ?? 0, desc, output: out, depots: Object.fromEntries(entries.map((e) => [e.depot, basename(e.vdf)])), ...(o.branch ? { branch: o.branch } : {}), ...(o.preview ? { preview: true } : {}) }));
  }
  return { appId: appId ?? 0, files: { app, depots: entries }, command: [steamcmd ?? "steamcmd", "+login", login || "<Steam のアカウント名>", "+run_app_build", app, "+quit"], problems };
}

export function runPublishSteam(dir: string, o: SteamPublishOptions): boolean {
  const project = loadProject(dir);
  const plan = planSteamPublish(project, o);
  for (const p of plan.problems) console.error(`  ${p}`);
  if (plan.problems.length > 0 && !o.dryRun) {
    console.error("\nSteam へ上げるのをやめました");
    return false;
  }
  console.log(`App ID ${plan.appId} へ上げるもの:`);
  for (const d of plan.files.depots) console.log(`  ${d.os}: デポ ${d.depot} ← ${shown(d.root)}`);
  console.log(o.branch ? `VDF: ${shown(plan.files.app)}（上げたあと ${o.branch} のブランチで公開）` : `VDF: ${shown(plan.files.app)}（公開はしない。Steamworks のビルドの画面でブランチに出す）`);
  if (o.preview) console.log("プレビュー: 実際には上げない");
  console.log(`\n${plan.command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  if (o.dryRun) {
    console.log("\n--dry-run のため、VDF を作るだけにしました（上のコマンドで上げられます）");
    return plan.problems.length === 0;
  }
  console.log("\nsteamcmd を動かします（パスワードと Steam Guard のコードは steamcmd が尋ねます）\n");
  const r = spawnSync(plan.command[0]!, plan.command.slice(1), { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nsteamcmd が失敗しました（終了の値 ${r.status}）。記録は ${shown(join(project.paths.out, "steam", "output"))} にあります`);
    return false;
  }
  console.log("\nSteam へ上げました。Steamworks の「SteamPipe → ビルド」で確かめ、ブランチに出してください");
  return true;
}

/** --build windows=a,mac=b や --depot windows=1,mac=2 を読む。 */
export function parseOsMap(value: string, what: string): Partial<Record<SteamOs, string>> {
  const out: Partial<Record<SteamOs, string>> = {};
  for (const part of value.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(windows|mac|linux)=(.+)$/.exec(part);
    if (!m) throw new Error(`${what} は windows=…、mac=…、linux=… の形で書きます: ${part}`);
    out[m[1] as SteamOs] = m[2]!;
  }
  return out;
}
