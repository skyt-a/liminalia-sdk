import { execFileSync, spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * 書き出しの素材の写し。同じディスクの中なら複製（Mac の APFS の clonefile、Linux の btrfs や XFS の reflink）にして中身を共有し、
 * 空きをほとんど使わない。複製できないときだけ中身を写す。
 *
 * Node の copyFileSync(…, COPYFILE_FICLONE) は、Mac では複製にならない。Node が使う libuv（Node 22 では 1.51）は、複製を Linux の
 * FICLONE（ioctl）でしか試さないので、Mac では COPYFILE_FICLONE を付けても黙って中身を写し、COPYFILE_FICLONE_FORCE は ENOSYS で失敗する。
 * そこで、まず COPYFILE_FICLONE_FORCE を試し（Linux と、Node が Mac でも複製するようになったとき）、Mac で効かなければ cp -c（clonefile(2)）に頼る。
 * cp -c は複製できないと黙って中身を写すので、複製できるか（元と同じ APFS のディスクか）は先に確かめる。
 */

export interface CopyPair {
  from: string;
  to: string;
}

/** 写し方。clone は Node の COPYFILE_FICLONE_FORCE、cp は Mac の cp -c（どちらも複製）、copy は中身を写す。 */
export type CopyMethod = "clone" | "cp" | "copy";

/** 写す前に確かめた結果。needed は写すのに要る空き（複製なら 0。足りるかは free と比べる）、free は行き先のディスクの空き。 */
export interface CopyPlan {
  /** 元のファイルのディスク（statSync の dev）→ 写し方。 */
  methods: ReadonlyMap<number, CopyMethod>;
  needed: number;
  free: number;
  /** 行き先（在る一番近いフォルダ）。 */
  dir: string;
  /** 空きが足りるか。 */
  enough: boolean;
}

/** 中身を写すときに、素材のほかに残しておく空き（エンジン・台本・データと、写している間のゆとり）。 */
export const SPACE_RESERVE = 64 * 1024 * 1024;

/** 写し方と空きを調べる道具（テストで差し替える）。 */
export interface CopyProbe {
  method(from: string, toDir: string): CopyMethod;
  /** dir のあるディスクの空きと、ファイルを置く単位（ブロック）の大きさ。 */
  space(dir: string): { free: number; block: number };
  size(file: string): number;
  device(file: string): number;
}

const DEFAULT_PROBE: CopyProbe = {
  method: (from, toDir) => copyMethod(from, toDir),
  space: (dir) => {
    const s = statfsSync(dir);
    return { free: s.bavail * s.bsize, block: s.bsize || 4096 };
  },
  size: (file) => statSync(file).size,
  device: (file) => statSync(file).dev,
};

/** path が在ればそれ、無ければ在る一番近い親のフォルダ。 */
export function existingDir(path: string): string {
  let p = path;
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return p;
}

/** from（ファイル）を toDir（無くてよい）の中へ写すときの写し方。 */
export function copyMethod(from: string, toDir: string, platform: NodeJS.Platform = process.platform): CopyMethod {
  const dir = existingDir(toDir);
  const probe = join(dir, `.liminalia-clone-${process.pid}-${Date.now().toString(36)}`);
  try {
    copyFileSync(from, probe, constants.COPYFILE_FICLONE_FORCE);
    return "clone";
  } catch {
    // 複製できない（Mac の Node は ENOSYS。別のディスク、複製の無いファイルシステム）
  } finally {
    rmSync(probe, { force: true });
  }
  if (platform === "darwin" && statSync(from).dev === statSync(dir).dev && isApfs(dir)) return "cp";
  return "copy";
}

/** dir が APFS のディスクの上にあるか（df -T apfs は、ほかのファイルシステムなら何も出さずに 1 で終わる）。 */
function isApfs(dir: string): boolean {
  const r = spawnSync("/bin/df", ["-T", "apfs", dir], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().split("\n").length > 1;
}

/**
 * pairs を toDir（行き先のファイルがすべて入るフォルダ）へ写すときの写し方と、要る空き。元のディスクごとに一度だけ確かめる。
 * 複製できるものは空きを数えない。中身を写すものは、ブロックの単位に切り上げた大きさの合計に SPACE_RESERVE を足す。
 */
export function planCopy(pairs: readonly CopyPair[], toDir: string, probe: CopyProbe = DEFAULT_PROBE): CopyPlan {
  const dir = existingDir(toDir);
  const methods = new Map<number, CopyMethod>();
  const { free, block } = probe.space(dir);
  let bytes = 0;
  for (const p of pairs) {
    const dev = probe.device(p.from);
    let method = methods.get(dev);
    if (!method) {
      method = probe.method(p.from, toDir);
      methods.set(dev, method);
    }
    if (method === "copy") bytes += Math.ceil(probe.size(p.from) / block) * block;
  }
  const needed = bytes > 0 ? bytes + SPACE_RESERVE : 0;
  return { methods, needed, free, dir, enough: needed <= free };
}

/** plan の写し方で pairs を写す（行き先のフォルダは作る）。 */
export function copyFiles(pairs: readonly CopyPair[], plan: Pick<CopyPlan, "methods">, device: (file: string) => number = DEFAULT_PROBE.device): void {
  for (const d of new Set(pairs.map((p) => dirname(p.to)))) mkdirSync(d, { recursive: true });
  const viaCp: CopyPair[] = [];
  for (const p of pairs) {
    const method = plan.methods.get(device(p.from)) ?? "copy";
    if (method === "cp") viaCp.push(p);
    else copyOne(p, method);
  }
  if (viaCp.length > 0) cpClone(viaCp);
}

function copyOne(p: CopyPair, method: CopyMethod): void {
  if (method === "clone") {
    try {
      copyFileSync(p.from, p.to, constants.COPYFILE_FICLONE_FORCE);
      return;
    } catch {
      // このファイルだけ複製できない（別のディスクへのリンクなど）。中身を写す
    }
  }
  copyFileSync(p.from, p.to, constants.COPYFILE_FICLONE);
}

/** 一度の cp に渡す引数の上限（Mac の ARG_MAX は 1 MB。環境変数の分を残す）。 */
const CP_ARGS_BYTES = 256 * 1024;
const CP_ARGS_FILES = 1000;

/**
 * cp -c で写す。行き先のフォルダごとに、名前の変わらないものをまとめて一度の cp にする（ファイルごとにプロセスを立てると、
 * 何千もの素材で遅くなる）。名前の変わるものは一つずつ。
 */
function cpClone(pairs: readonly CopyPair[]): void {
  const groups = new Map<string, string[]>();
  for (const p of pairs) {
    if (basename(p.from) !== basename(p.to)) {
      cp([p.from, p.to]);
      continue;
    }
    const dir = dirname(p.to);
    const list = groups.get(dir) ?? [];
    list.push(p.from);
    groups.set(dir, list);
  }
  for (const [dir, files] of groups) {
    let chunk: string[] = [];
    let size = 0;
    for (const f of files) {
      if (chunk.length > 0 && (chunk.length >= CP_ARGS_FILES || size + f.length + 1 > CP_ARGS_BYTES)) {
        cp([...chunk, `${dir}/`]);
        chunk = [];
        size = 0;
      }
      chunk.push(f);
      size += f.length + 1;
    }
    if (chunk.length > 0) cp([...chunk, `${dir}/`]);
  }
}

function cp(args: string[]): void {
  try {
    execFileSync("/bin/cp", ["-c", "--", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    throw new Error(`cp -c: ${(err.stderr?.toString().trim() || err.message).split("\n").slice(0, 5).join("\n")}`);
  }
}
