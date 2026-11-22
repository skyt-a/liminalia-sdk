import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE } from "@liminalia/project";
import { projectCode, projectCodeLine } from "@liminalia/project/trust";
import { updateModule } from "../update.ts";
import { runNew, type NewOptions } from "./new.ts";

/**
 * lim new <フォルダ> --from <URL> — 人が配るひな形を、Git のリポジトリか zip の URL から取ってきて作る（取ったあとは --template と同じ手順）。
 *
 * - URL の書き方: `github:人/リポジトリ[#タグか枝]`、`https://…`（.zip で終われば zip、ほかは Git。`#タグか枝` を付けられる）、`file://…`（手元の Git）。
 *   暗号化しない `http://` は手元（localhost、127.0.0.1）だけ受ける（途中で中身を差し替えられないように）。
 * - Git は浅く取り（--depth 1）、サブモジュールを取らず、リポジトリのフックを使わない。zip は中の道筋を確かめて広げる（外へ出る名前は入れない）。
 * - ひな形の場所は、取ったものの中の liminalia.json のあるフォルダ（直下か、一つ下。GitHub のアーカイブの zip は一つのフォルダに入っている）。
 * - 作った作品にプラグインや署名のコマンドなど開くと動くコードがあれば、何があるかを一度だけ知らせる（開く前に中身を確かめられるように）。
 *   lim new 自身は、取ったものの中のコードを動かさない（liminalia.json を JSON として読み、ファイルを写すだけ）。
 */

export type TemplateSource = { kind: "git"; url: string; ref?: string } | { kind: "zip"; url: string };

/** 手元を指す名前（暗号化しない http を受ける所）。 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** --from に渡した URL を読む。読めない書き方なら例外。 */
export function parseTemplateSource(text: string): TemplateSource {
  const gh = /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.+))?$/.exec(text);
  if (gh) return { kind: "git", url: `https://github.com/${gh[1]}/${gh[2]}.git`, ...(gh[3] ? { ref: gh[3] } : {}) };
  if (text.startsWith("github:")) throw new Error(`github: は github:人/リポジトリ の形で書きます: ${text}`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`ひな形の URL として読めません: ${text}（github:人/リポジトリ、https の Git か zip の URL を書きます）`);
  }
  if (url.protocol === "file:") return { kind: "git", url: text };
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) throw new Error(`ひな形は https の URL から取ります（http は手元の名前だけ）: ${text}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`ひな形の URL は https か github: で書きます: ${text}`);
  const ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  url.hash = "";
  const bare = url.toString();
  if (/\.zip$/i.test(url.pathname)) return { kind: "zip", url: bare };
  return { kind: "git", url: bare, ...(ref ? { ref } : {}) };
}

/** 取ったものの中のひな形の場所（liminalia.json のあるフォルダ。直下か一つ下）。 */
function templateRoot(dir: string, shown: string): string {
  if (existsSync(join(dir, CONFIG_FILE))) return dir;
  const inner = readdirSync(dir)
    .filter((n) => !n.startsWith(".") && n !== "__MACOSX" && statSync(join(dir, n)).isDirectory())
    .filter((n) => existsSync(join(dir, n, CONFIG_FILE)));
  if (inner.length === 1) return join(dir, inner[0]!);
  if (inner.length > 1) throw new Error(`${shown} の中に作品が ${inner.length} つあります（${inner.join("、")}）。一つの作品のリポジトリか zip を指定します`);
  throw new Error(`${shown} の中に ${CONFIG_FILE} がありません（ひな形には作品のリポジトリか zip を指定します）`);
}

/** Git で浅く取る（フックとサブモジュールを使わず、尋ねない）。 */
function cloneGit(source: Extract<TemplateSource, { kind: "git" }>, into: string): void {
  const noHooks = process.platform === "win32" ? join(tmpdir(), "liminalia-no-hooks") : "/dev/null";
  const args = ["-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false", "clone", "--quiet", "--depth", "1", "--no-recurse-submodules", ...(source.ref ? ["--branch", source.ref] : []), source.url, into];
  const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.error) throw new Error(`git を動かせません（Git を入れます）: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ひな形を取れませんでした（git clone ${source.url}）\n${(r.stderr || r.stdout || "").trim()}`);
}

/** zip を取って広げる。 */
async function fetchZip(url: string, into: string, work: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new Error(`ひな形を取れませんでした（${url}）: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`ひな形を取れませんでした（${url}）: HTTP ${res.status}`);
  const zip = join(work, "template.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  try {
    updateModule.extractZip(zip, into);
  } catch (e) {
    throw new Error(`ひな形の zip を広げられませんでした（${url}）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** URL のひな形から作る（作ったら信頼を確かめる案内まで出す）。 */
export async function runNewFrom(dir: string, from: string, o: Omit<NewOptions, "template"> = {}, output: "ja" | "en" = "ja"): Promise<void> {
  const en = output === "en";
  const source = parseTemplateSource(from);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} はもうあり、空ではありません`);
  const work = mkdtempSync(join(tmpdir(), "liminalia-template-"));
  try {
    const fetched = join(work, "fetched");
    if (source.kind === "git") cloneGit(source, fetched);
    else await fetchZip(source.url, fetched, work);
    const src = templateRoot(fetched, from);
    runNew(dir, { ...o, template: src });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // 取ってきたものに開くと動くコードがあれば、何があるかを知らせる
  const code = projectCode(dir);
  if (code.length === 0) return;
  console.log("");
  console.log(en ? "This template has code that runs when the project is opened:" : "このひな形には、作品を開くと動くコードがあります:");
  for (const c of code) console.log(`  ${projectCodeLine(c, en ? "en" : "ja")}`);
  console.log(
    en
      ? "This code runs when you open the project, so check its contents first if you don't know who made it."
      : "作品を開くとこのコードが動きます。作った人が分からないときは、開く前に中身を確かめてください",
  );
}
