import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { imageSize, readLoopTags } from "@liminalia/lang";

const run = promisify(execFile);

/**
 * 素材の再圧縮（liminalia.json の build.mobile・build.browser.compress・build.desktop.compress。劣化を伴うので既定は何もしない）。
 * - 音（bgm・sound・voice）: ffmpeg で AAC（.m4a）か Opus（.ogg）に。ビットレートを決める
 * - 画像（bgimage・fgimage・image）: cwebp で WebP に。品質を決める
 * 名前（拡張子）が変わるので、元の名前 → 新しい名前の表を返す（遊ぶ側は project/assets-renamed.json で引き直す）。
 * 縮めた結果が元より大きければ元のまま使う。作ったものは cacheDir に中身と設定の鍵で残し、次の書き出しで使い回す。
 *
 * 画像の解像度（images.scale）: 0 より大きく 1 より小さい数なら、scaleFolders（既定は背景と立ち絵の bgimage・fgimage）の画像の縦横をその倍率に
 * 縮める（スマホは画面の画素が少ないので、背景と立ち絵を半分ほどにしても見た目はほとんど変わらず、容量と描画の重さが減る）。
 * 遊ぶ側は project/assets-scale.json（元の名前 → [元の幅, 元の高さ, 縮めた幅, 縮めた高さ]）を読み、元の大きさの絵として出す
 * （@liminalia/web の asset-scale.ts）。部品の画像（image）は、枠の角の大きさ（imageSlice）を画素で書くので既定では縮めない。
 *
 * ループの位置: OGG に埋め込んだ LOOPSTART・LOOPLENGTH・LOOPEND（標本の数）は、AAC（.m4a）にすると消え、Opus にすると
 * 標本の速さが 48000 に変わって数がずれる。そこで元の音から秒で読んで loops に返し（遊ぶ側は project/audio-loops.json を
 * 埋め込みのタグより先に使う）、Opus にするときは 48000 の標本の数に数え直したタグを書く。
 */
export interface MobileCompression {
  audio?: { format?: "m4a" | "opus"; bitrate?: string; folders?: string[] };
  images?: { format?: "webp"; quality?: number; folders?: string[]; scale?: number; scaleFolders?: string[] };
}

/** 解像度を下げる画像の既定のフォルダ（背景と立ち絵）。 */
export const SCALE_FOLDERS = ["bgimage", "fgimage"];

/** ループの位置（秒）。 */
export interface LoopPoints {
  start?: number;
  end?: number;
}

export interface CompressResult {
  /** 縮めた素材のフォルダ（渡した assetsDir）。 */
  dir: string;
  /** "voice/a.ogg" → "voice/a.m4a"（assets からのパス）。 */
  renamed: Record<string, string>;
  /** 縮めた音のうち、元の音にループの位置が埋め込まれていたもの（元の名前 "bgm/a.ogg" → 元の音から読んだ秒）。 */
  loops: Record<string, LoopPoints>;
  /** 解像度を下げた画像（元の名前 "fgimage/a.png" → [元の幅, 元の高さ, 縮めた幅, 縮めた高さ]）。 */
  scaled: Record<string, [number, number, number, number]>;
  audio: { files: number; before: number; after: number };
  images: { files: number; before: number; after: number };
}

const AUDIO_EXT = new Set([".ogg", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".opus"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** assetsDir（assets/<種類>/…）の中を、その場で縮める。 */
export async function compressAssets(assetsDir: string, o: MobileCompression, cacheDir: string): Promise<CompressResult> {
  const result: CompressResult = { dir: assetsDir, renamed: {}, loops: {}, scaled: {}, audio: { files: 0, before: 0, after: 0 }, images: { files: 0, before: 0, after: 0 } };
  mkdirSync(cacheDir, { recursive: true });
  type Job = { file: string; kind: "audio" | "images"; ext: string; args: (input: string, output: string) => [string, string[]]; key: string; loop?: LoopPoints; size?: [number, number, number, number] };
  const jobs: Job[] = [];
  if (o.audio) {
    const format = o.audio.format ?? "m4a";
    const bitrate = o.audio.bitrate ?? (format === "opus" ? "48k" : "64k");
    const ext = format === "opus" ? ".ogg" : ".m4a";
    const codec = format === "opus" ? "libopus" : "aac";
    for (const folder of o.audio.folders ?? ["bgm", "sound", "voice"]) {
      for (const file of walk(join(assetsDir, folder))) {
        if (!AUDIO_EXT.has(extname(file).toLowerCase())) continue;
        const loop = loopOf(file);
        // Opus は 48000 の標本の数でタグを書き直す（元のタグは元の速さの数のまま写るため）。控えの鍵も分ける
        const tags = format === "opus" && loop ? opusLoopTags(loop) : [];
        const key = `${format}-${bitrate}${tags.length > 0 ? "-loop48k" : ""}`;
        jobs.push({ file, kind: "audio", ext, key, ...(loop ? { loop } : {}), args: (i, out) => ["ffmpeg", ["-y", "-v", "error", "-i", i, "-vn", "-c:a", codec, "-b:a", bitrate, ...tags, out]] });
      }
    }
  }
  if (o.images) {
    const quality = o.images.quality ?? 80;
    const scale = o.images.scale;
    if (scale !== undefined && !(scale > 0 && scale <= 1)) throw new Error(`images.scale は 0 より大きく 1 以下の数で書きます: ${scale}`);
    const scaleFolders = new Set(o.images.scaleFolders ?? SCALE_FOLDERS);
    for (const folder of o.images.folders ?? ["bgimage", "fgimage", "image"]) {
      for (const file of walk(join(assetsDir, folder))) {
        const ext = extname(file).toLowerCase();
        // WebP は解像度を下げるときだけ作り直す（縮めるだけなら、作り直しで画質が落ちるだけなので触らない）
        const resizable = scale !== undefined && scale < 1 && scaleFolders.has(folder);
        if (!IMAGE_EXT.has(ext) && !(ext === ".webp" && resizable)) continue;
        // 解像度を下げるもの（縦横の画素の数を倍率で丸める。変わらなければ下げない）
        const size = resizable ? imageSize(readFileSync(file)) : null;
        const to = size ? ([Math.max(1, Math.round(size.width * scale!)), Math.max(1, Math.round(size.height * scale!))] as const) : null;
        const resize = size && to && (to[0] !== size.width || to[1] !== size.height) ? { size: [size.width, size.height, to[0], to[1]] as [number, number, number, number] } : {};
        if (ext === ".webp" && !resize.size) continue;
        const extra = resize.size ? ["-resize", String(resize.size[2]), String(resize.size[3])] : [];
        jobs.push({ file, kind: "images", ext: ".webp", key: `webp-${quality}${resize.size ? `-${resize.size[2]}x${resize.size[3]}` : ""}`, ...resize, args: (i, out) => ["cwebp", ["-quiet", "-q", String(quality), "-alpha_q", "100", ...extra, i, "-o", out]] });
      }
    }
  }
  // 同時に動かす数は CPU の数まで
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const before = statSync(job.file).size;
      const hash = createHash("sha1").update(readFileSync(job.file)).digest("hex");
      const cached = join(cacheDir, `${hash}-${job.key}${job.ext}`);
      if (!existsSync(cached)) {
        const tmp = `${cached}.tmp${job.ext}`;
        const [cmd, args] = job.args(job.file, tmp);
        try {
          await run(cmd, args);
        } catch (e) {
          rmSync(tmp, { force: true });
          throw new Error(`${relative(assetsDir, job.file)} を圧縮できませんでした（${cmd}）: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`);
        }
        renameSync(tmp, cached);
      }
      const after = statSync(cached).size;
      const stat = result[job.kind];
      stat.files++;
      stat.before += before;
      const target = join(dirname(job.file), `${basename(job.file, extname(job.file))}${job.ext}`);
      // 縮めて大きくなったもの・同じ名前の別の素材（a.png と a.jpg）があるものは元のまま
      if (after >= before || (target !== job.file && existsSync(target))) {
        stat.after += before;
        continue;
      }
      stat.after += after;
      if (target !== job.file) rmSync(job.file);
      copyFileSync(cached, target);
      const rel = (p: string) => relative(assetsDir, p).split(sep).join("/");
      if (target !== job.file) result.renamed[rel(job.file)] = rel(target);
      if (job.loop) result.loops[rel(job.file)] = job.loop;
      if (job.size) result.scaled[rel(job.file)] = job.size;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cpus().length) }, worker));
  return result;
}

/** 音に埋め込まれたループの位置（OGG の LOOPSTART など。@liminalia/lang の readLoopTags。秒）。無ければ undefined。 */
function loopOf(file: string): LoopPoints | undefined {
  // タグは頭にあるので、頭だけを読む（readLoopTags も頭の 256KB だけを見る）
  const head = new Uint8Array(256 * 1024);
  const fd = openSync(file, "r");
  try {
    const n = readSync(fd, head, 0, head.length, 0);
    return readLoopTags(head.buffer.slice(0, n)) ?? undefined;
  } finally {
    closeSync(fd);
  }
}

/** Opus（48000）のループのタグを書く ffmpeg の引数。元の LOOPEND は消して、LOOPSTART と LOOPLENGTH にする。 */
export function opusLoopTags(loop: LoopPoints): string[] {
  const at = (seconds: number) => String(Math.round(seconds * 48000));
  const start = loop.start ?? 0;
  return [
    "-metadata:s:a:0",
    `LOOPSTART=${at(start)}`,
    "-metadata:s:a:0",
    `LOOPLENGTH=${loop.end !== undefined ? at(loop.end - start) : ""}`,
    "-metadata:s:a:0",
    "LOOPEND=",
  ];
}

/** 縮めるのに要る道具（ffmpeg・cwebp）が無ければ、その名前。 */
export async function missingTools(o: MobileCompression): Promise<string[]> {
  const out: string[] = [];
  const has = async (cmd: string, args: string[]) => {
    try {
      await run(cmd, args);
      return true;
    } catch {
      // 動かせなければ入っていないとみなす（呼ぶ側が入れ方を出す）
      return false;
    }
  };
  if (o.audio && !(await has("ffmpeg", ["-version"]))) out.push("ffmpeg");
  if (o.images && !(await has("cwebp", ["-version"]))) out.push("cwebp");
  return out;
}
