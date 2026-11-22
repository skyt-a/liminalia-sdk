import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { buildPack, loadProject, type Project } from "@liminalia/project";
import { isTestBuild, testBuildProblem } from "../built.ts";
import { updateModule, type Notes, type UpdateFile, type UpdateManifest, type UpdatePack } from "../update.ts";
import { zipFolder } from "../zip.ts";
import { encryptPack } from "./pack.ts";

/**
 * lim update-manifest [プロジェクト] --base-url <URL> [--pack <パック>,…] [--app <OS>=<ファイル>,…] [--page <URL>]
 *                     [--notes <文> | --notes-file <ファイル>] [--version <版>] [--out <フォルダ>] [--fresh] [--sign-key <秘密鍵.pem>] [--allow-test]
 *
 * デスクトップ版のアップデートの確認（liminalia.json の build.update.url）が読むマニフェスト update.json と、配るファイルを out
 * （既定 dist/update/）に作る。out の中身を base-url の場所に置き、build.update.url を <base-url>update.json にする。
 * - パック: 作品の packs/<id>/（lim pack で書き出してから）、lim pack で書き出したフォルダ、またはその zip。<id>-<版>.zip にして sha256 を付ける。
 *   requires（どの本体の版に入れるか）は pack.json の requires、無ければ今の version
 * - 本体: OS（windows、mac、linux）ごとのファイル（インストーラーや zip）を写して sha256 を付ける。--page はダウンロードのページ。
 *   テスト版（lim build --feedback）の書き出しは止める（--allow-test で入れる）
 * - out に前の update.json があれば、今回作らなかったパック（ほかの本体の版向けのもの）は残す（--fresh なら残さない）
 * - --sign-key（か環境変数 LIMINALIA_UPDATE_SIGN_KEY）の秘密鍵で Ed25519 の署名を付ける。build.update.publicKey があれば必須
 */
export interface UpdateManifestOptions {
  baseUrl: string;
  packs?: string[];
  apps?: Partial<Record<"windows" | "mac" | "linux", string>>;
  page?: string;
  notes?: Notes;
  version?: string;
  out?: string;
  fresh?: boolean;
  /** 署名の秘密鍵（PEM）のファイル。省くと環境変数 LIMINALIA_UPDATE_SIGN_KEY。 */
  signKey?: string;
  /** テスト版（lim build --feedback）の本体も入れる。 */
  allowTest?: boolean;
}

/** --notes-file の中身（.json なら言語 → 文、ほかは文）。 */
export function readNotesFile(file: string): Notes {
  const text = readFileSync(file, "utf8");
  if (extname(file).toLowerCase() !== ".json") return text.trim();
  const json = JSON.parse(text) as unknown;
  if (typeof json === "string") return json;
  if (json && typeof json === "object" && !Array.isArray(json) && Object.values(json).every((v) => typeof v === "string")) return json as Record<string, string>;
  throw new Error(`${file} は文字列か、言語 → 文字列の JSON で書きます`);
}

/** --app windows=a.exe,mac=b.zip を読む。 */
export function parseApps(value: string): Partial<Record<"windows" | "mac" | "linux", string>> {
  const out: Partial<Record<"windows" | "mac" | "linux", string>> = {};
  for (const part of value.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(windows|mac|linux)=(.+)$/.exec(part);
    if (!m) throw new Error(`--app は windows=ファイル、mac=ファイル、linux=ファイル の形で書きます: ${part}`);
    out[m[1] as "windows" | "mac" | "linux"] = m[2]!;
  }
  return out;
}

export async function runUpdateManifest(dir: string, o: UpdateManifestOptions): Promise<boolean> {
  const project = loadProject(dir);
  try {
    const r = await makeUpdateManifest(project, o);
    console.log(`${relative(process.cwd(), join(r.out, "update.json"))}:`);
    if (r.manifest.signature) console.log("  署名: Ed25519");
    if (r.manifest.app) {
      const files = Object.keys(r.manifest.app.files ?? {});
      console.log(files.length > 0 ? `  本体 ${r.manifest.app.version}（${files.join("、")}）` : `  本体 ${r.manifest.app.version}（ダウンロードのページだけ）`);
    }
    for (const p of r.manifest.packs ?? []) {
      const size = p.size !== undefined ? ` ${(p.size / 1024 / 1024).toFixed(1)} MB` : "";
      console.log(p.requires ? `  パック ${p.id} ${p.version}（本体 ${p.requires} 向け）${size}` : `  パック ${p.id} ${p.version}${size}`);
    }
    console.log(`\n${relative(process.cwd(), r.out)} の中身を ${o.baseUrl} に置き、liminalia.json の build.update.url を ${new URL("update.json", r.base).toString()} にしてください`);
    return true;
  } catch (e) {
    console.error(`マニフェストを作れませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 秘密鍵があればマニフェストに署名する。作品に公開鍵（build.update.publicKey）があるのに秘密鍵が無いとき、
 * 秘密鍵がその公開鍵のどれとも組にならないときは止める（署名の無い・合わないマニフェストは、公開鍵を入れたゲームが受けない）。
 */
export function signIfAsked(manifest: UpdateManifest, publicKey: string | string[] | undefined, keyFile: string | undefined): UpdateManifest {
  const keys = publicKey === undefined ? [] : Array.isArray(publicKey) ? publicKey : [publicKey];
  if (!keyFile) {
    if (keys.length > 0) throw new Error("liminalia.json の build.update.publicKey があるので、署名の秘密鍵が要ります（--sign-key か環境変数 LIMINALIA_UPDATE_SIGN_KEY に、lim update-key で作った .pem のパス）");
    return manifest;
  }
  if (!existsSync(keyFile)) throw new Error(`署名の秘密鍵 ${keyFile} がありません`);
  const pem = readFileSync(keyFile, "utf8");
  const signed = updateModule.signManifest(manifest, pem);
  if (keys.length > 0 && !updateModule.verifyManifestSignature(signed, keys).ok) {
    throw new Error(`秘密鍵 ${keyFile}（公開鍵 ${updateModule.publicKeyOf(pem)}）が、liminalia.json の build.update.publicKey と組になっていません`);
  }
  return signed;
}

/** マニフェストと配るファイルを作る。 */
export async function makeUpdateManifest(project: Project, o: UpdateManifestOptions): Promise<{ manifest: UpdateManifest; out: string; base: string }> {
  const cfg = project.config;
  const base = o.baseUrl.endsWith("/") ? o.baseUrl : `${o.baseUrl}/`;
  if (!updateModule.allowedUrl(new URL("x", base).toString())) throw new Error(`--base-url は https:// の URL で書きます: ${o.baseUrl}`);
  const version = o.version ?? cfg.version;
  if (!version) throw new Error("本体のバージョンがありません（liminalia.json の version か --version）");
  const out = resolve(o.out ?? join(project.paths.out, "update"));
  mkdirSync(out, { recursive: true });
  const fileEntry = (file: string): UpdateFile => ({ url: new URL(encodeURIComponent(basename(file)), base).toString(), sha256: updateModule.sha256File(file), size: statSync(file).size });
  const work = mkdtempSync(join(tmpdir(), "liminalia-update-"));
  try {
    // out に置いた名前 → 何のファイル（パックの zip と本体が同じ名前に重ならないようにする）
    const placed = new Map<string, string>();

    // ---- パック ----
    const packs: UpdatePack[] = [];
    for (const spec of o.packs ?? []) {
      const path = resolve(project.root, spec);
      if (!existsSync(path)) throw new Error(`パック ${spec} がありません`);
      let folder: string;
      if (statSync(path).isFile()) {
        // zip: 中の pack.json を読むために一度展開する
        folder = join(work, `unzip-${packs.length}`);
        updateModule.extractZip(path, folder);
        if (!existsSync(join(folder, "pack.json"))) {
          const only = readdirSync(folder).filter((d) => !d.startsWith("."));
          if (only.length === 1 && existsSync(join(folder, only[0]!, "pack.json"))) folder = join(folder, only[0]!);
        }
      } else folder = path;
      if (!existsSync(join(folder, "pack.json"))) throw new Error(`${spec} に pack.json がありません`);
      let pack = JSON.parse(readFileSync(join(folder, "pack.json"), "utf8")) as { id: string; version?: string; requires?: string; title?: string; files?: unknown };
      if (!pack.files && statSync(path).isDirectory()) {
        // 作品の packs/<id>/（まだ書き出していないもの）は lim pack と同じに書き出す
        const built = join(work, "built", pack.id);
        const r = await buildPack(project, folder, built);
        if (r.problems.length > 0) throw new Error(`パック ${pack.id} のシナリオにエラーがあります\n${r.problems.join("\n")}`);
        // 本体を暗号にして書き出す作品（build.encrypt）は、配るパックも同じ鍵で暗号にする（アップデートはデスクトップ版だけ）
        if (cfg.build?.encrypt) encryptPack(project, built, "desktop");
        folder = built;
        pack = JSON.parse(readFileSync(join(folder, "pack.json"), "utf8")) as typeof pack;
      }
      if (!pack.version) throw new Error(`パック ${pack.id} の pack.json に version がありません（アップデートは version で新しいかを比べます）`);
      const zip = join(out, `${pack.id}-${pack.version}.zip`);
      placed.set(basename(zip), `パック ${pack.id}`);
      if (statSync(path).isFile() && folder.startsWith(work)) copyFileSync(path, zip);
      else {
        // zip の中は <id>/… にする（遊ぶ側はただ一つのフォルダの中の pack.json も読む）
        const stage = join(work, "stage", pack.id);
        cpSync(folder, stage, { recursive: true });
        rmSync(zip, { force: true });
        await zipFolder(join(work, "stage"), pack.id, zip);
        rmSync(join(work, "stage"), { recursive: true, force: true });
      }
      packs.push({ id: pack.id, version: pack.version, requires: pack.requires ?? version, ...(pack.title ? { title: pack.title } : {}), ...fileEntry(zip) });
    }

    // ---- 本体 ----
    let app: UpdateManifest["app"];
    if (o.page || (o.apps && Object.keys(o.apps).length > 0)) {
      const files: NonNullable<NonNullable<UpdateManifest["app"]>["files"]> = {};
      for (const [os, spec] of Object.entries(o.apps ?? {}) as ["windows" | "mac" | "linux", string][]) {
        const file = resolve(project.root, spec);
        if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`本体の更新のファイル ${spec} がありません（フォルダではなく、インストーラーや zip を指定します）`);
        if (!o.allowTest && isTestBuild(file, project.paths.out)) throw new Error(testBuildProblem(spec));
        const dest = join(out, basename(file));
        // 違うファイルが同じ名前になると、あとに写したもので上書きされて前の sha256 と中身が食い違うので受けない
        const earlier = placed.get(basename(file));
        if (earlier !== undefined && earlier !== file) throw new Error(`本体の更新のファイル ${spec} は、置き先でほかのファイルと同じ名前（${basename(file)}）になります。どちらかのファイルの名前を替えてください`);
        placed.set(basename(file), file);
        if (resolve(file) !== dest) copyFileSync(file, dest);
        files[os] = fileEntry(dest);
      }
      app = { version, ...(o.page ? { page: o.page } : {}), ...(o.notes !== undefined ? { notes: o.notes } : {}), ...(Object.keys(files).length > 0 ? { files } : {}) };
    }
    // パックの説明は、本体の更新が無ければパックに付ける
    if (!app && o.notes !== undefined) for (const p of packs) p.notes = o.notes;

    // ---- 前のマニフェストのパック（ほかの本体の版向け）を残す ----
    const previous = join(out, "update.json");
    if (!o.fresh && existsSync(previous)) {
      const old = updateModule.validateManifest(JSON.parse(readFileSync(previous, "utf8")) as unknown, base).manifest;
      for (const p of old?.packs ?? []) if (!packs.some((n) => n.id === p.id && (n.requires ?? "") === (p.requires ?? ""))) packs.push(p);
    }

    let manifest: UpdateManifest = { format: "liminalia-update", formatVersion: 1, ...(app ? { app } : {}), ...(packs.length > 0 ? { packs } : {}) };
    const { problems } = updateModule.validateManifest(manifest, base);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    manifest = signIfAsked(manifest, cfg.build?.update?.publicKey, o.signKey ?? process.env.LIMINALIA_UPDATE_SIGN_KEY);
    writeFileSync(previous, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, out, base };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
