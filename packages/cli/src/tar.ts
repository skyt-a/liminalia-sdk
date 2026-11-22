import { createReadStream, createWriteStream, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/**
 * フォルダを tar.gz にする（Linux 版の配る形。tar コマンドを使わない）。
 * - 持ち主は root（uid と gid を 0、名前を root）にする。tar コマンドのままでは作った人の番号と名前が入り、root で展開すると
 *   その番号の知らない人の持ち物になる
 * - 実行の許可を保つ。Windows で書き出すとファイルに実行の許可が無いので、executable が true を返すものを 755 にする
 * - 形は ustar。名前が ustar に入らなければ PAX の拡張の見出しで書く（GNU tar と bsdtar が読める）
 */
export interface TarOptions {
  /** 実行できるファイルか（entry からの "/" 区切りのパス）。Windows で書き出すときに使う（ほかの OS ではファイルの許可を使う）。 */
  executable?: (path: string) => boolean;
}

const BLOCK = 512;

/** 8 進の数（size 桁、終わりは NUL）。 */
function octal(n: number, size: number): string {
  return `${n.toString(8).padStart(size - 1, "0")}\0`;
}

function writeString(buf: Buffer, at: number, size: number, text: string): void {
  buf.write(text, at, size, "utf8");
}

/** ustar の名前（100 バイト）と頭（155 バイト）に分ける。入らなければ null。 */
function splitName(name: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest !== "") return { name: rest, prefix };
  }
  return null;
}

interface HeaderInput {
  name: string;
  type: "0" | "2" | "5" | "x";
  mode: number;
  size: number;
  mtime: number;
  link?: string;
}

function header(h: HeaderInput, split: { name: string; prefix: string }): Buffer {
  const buf = Buffer.alloc(BLOCK);
  writeString(buf, 0, 100, split.name);
  writeString(buf, 100, 8, octal(h.mode & 0o7777, 8));
  writeString(buf, 108, 8, octal(0, 8));
  writeString(buf, 116, 8, octal(0, 8));
  writeString(buf, 124, 12, octal(h.size, 12));
  writeString(buf, 136, 12, octal(h.mtime, 12));
  buf.fill(0x20, 148, 156);
  writeString(buf, 156, 1, h.type);
  if (h.link) writeString(buf, 157, 100, h.link);
  writeString(buf, 257, 6, "ustar\0");
  writeString(buf, 263, 2, "00");
  writeString(buf, 265, 32, "root");
  writeString(buf, 297, 32, "root");
  writeString(buf, 345, 155, split.prefix);
  let sum = 0;
  for (const b of buf) sum += b;
  writeString(buf, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return buf;
}

const pad = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** PAX の一行（"長さ 鍵=値\n"。長さは自分の桁も含む）。 */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let n = Buffer.byteLength(body) + 1;
  while (String(n).length + Buffer.byteLength(body) !== n) n = String(n).length + Buffer.byteLength(body);
  return `${n}${body}`;
}

/** 一つのものの見出し（名前か結ぶ先が ustar に入らなければ、前に PAX の見出しを置く）。 */
function headers(h: HeaderInput): Buffer[] {
  const split = splitName(h.name);
  const longLink = h.link !== undefined && Buffer.byteLength(h.link) > 100;
  if (split && !longLink) return [header(h, split)];
  const records = Buffer.from((split ? "" : paxRecord("path", h.name)) + (longLink ? paxRecord("linkpath", h.link!) : ""), "utf8");
  const short = (s: string) => Buffer.from(s).subarray(0, 99).toString("utf8").replace(/\uFFFD+$/, "");
  return [
    header({ name: "PaxHeader", type: "x", mode: 0o644, size: records.length, mtime: h.mtime }, { name: short(`PaxHeaders/${h.name.split("/").at(-1)}`), prefix: "" }),
    records,
    pad(records.length),
    header({ ...h, ...(longLink ? { link: short(h.link!) } : {}) }, split ?? { name: short(h.name.split("/").at(-1)!), prefix: "" }),
  ];
}

async function* archive(base: string, entry: string, o: TarOptions): AsyncGenerator<Buffer> {
  const windows = process.platform === "win32";
  const visit = async function* (rel: string): AsyncGenerator<Buffer> {
    const abs = join(base, ...rel.split("/"));
    const st = lstatSync(abs);
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (st.isSymbolicLink()) {
      yield* headers({ name: rel, type: "2", mode: 0o777, size: 0, mtime, link: readlinkSync(abs).split("\\").join("/") });
      return;
    }
    // 許可は 755（フォルダと実行できるもの）か 644 にそろえる（作業の一時のフォルダの 700 のまま入れると、root で展開したとき
    // ほかの利用者が開けない。setuid なども入れない）
    if (st.isDirectory()) {
      yield* headers({ name: `${rel}/`, type: "5", mode: 0o755, size: 0, mtime });
      for (const name of readdirSync(abs).sort()) yield* visit(`${rel}/${name}`);
      return;
    }
    const mode = o.executable?.(rel) || (!windows && (st.mode & 0o111) !== 0) ? 0o755 : 0o644;
    yield* headers({ name: rel, type: "0", mode, size: st.size, mtime });
    for await (const chunk of createReadStream(abs)) yield chunk as Buffer;
    yield pad(st.size);
  };
  yield* visit(entry);
  yield Buffer.alloc(BLOCK * 2);
}

/** base の中の entry（フォルダ）を、entry/ から始まる tar.gz にする。 */
export async function tarGz(base: string, entry: string, out: string, o: TarOptions = {}): Promise<void> {
  await pipeline(Readable.from(archive(base, entry, o)), createGzip(), createWriteStream(out));
}
