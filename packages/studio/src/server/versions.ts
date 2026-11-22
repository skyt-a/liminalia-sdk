import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 変更履歴（書く前の内容）の置き場。シナリオ（.liminalia/history/<ファイル>/）、作品のデータ（@data）、訳（@lang）、
 * liminalia.json（@config）が使う。名前は書いた日時（versionStamp）と拡張子。
 *
 * 書くたびに丸ごと写すので、直近は細かく、古いほど粗く間引いて残す（thinVersions）。
 * - 新しいものから HISTORY_RECENT 件はそのまま
 * - 10 分前までは 1 分ごとに一つ、24 時間前までは 1 時間ごとに一つ、それより前は 1 日ごとに一つ（どれもその区切りの最後のもの）
 * - 合わせて HISTORY_KEEP 件、HISTORY_BYTES バイトまで。超えた分は古いものから消す（いちばん新しいものは必ず残す）
 */

export const BACKUP_DIR = join(".liminalia", "backups");

export const HISTORY_KEEP = 50;
export const HISTORY_BYTES = 16 * 1024 * 1024;
export const HISTORY_RECENT = 5;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface VersionInfo {
  id: string;
  /** 書いた日時（ミリ秒）。 */
  time: number;
  bytes: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 履歴の id の日時の部分（20260101-093000-123。並べ替えると古い順）。 */
export function versionStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})/;

/** id の日時（手元の時刻。読めなければ null）。 */
export function versionTime(id: string): number | null {
  const m = STAMP.exec(id);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
}

/** 履歴の id（日時、同じ時刻なら -番号）を古い順に並べる比較。 */
export function compareVersionIds(a: string, b: string): number {
  const [ta, na] = splitId(a);
  const [tb, nb] = splitId(b);
  return ta < tb ? -1 : ta > tb ? 1 : na - nb;
}

function splitId(id: string): [string, number] {
  const m = /^(.*?-\d{3})(?:-(\d+))?$/.exec(id);
  return m ? [m[1]!, Number(m[2] ?? 0)] : [id, 0];
}

/** 区切りの名前（手元の時刻の分・時・日）。 */
function bucket(time: number, size: "minute" | "hour" | "day"): string {
  const d = new Date(time);
  const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (size === "day") return day;
  return size === "hour" ? `${day} ${d.getHours()}` : `${day} ${d.getHours()}:${d.getMinutes()}`;
}

/** 残す版の id。entries は新しい順。 */
export function thinVersions(entries: readonly VersionInfo[], now: number): Set<string> {
  const picked: VersionInfo[] = [];
  const seen = { minute: new Set<string>(), hour: new Set<string>(), day: new Set<string>() };
  entries.forEach((e, i) => {
    if (i < HISTORY_RECENT) {
      picked.push(e);
      return;
    }
    const age = now - e.time;
    const size = age < 10 * MINUTE ? "minute" : age < DAY ? "hour" : "day";
    const key = bucket(e.time, size);
    if (seen[size].has(key)) return;
    seen[size].add(key);
    picked.push(e);
  });
  const keep = new Set<string>();
  let bytes = 0;
  for (const e of picked) {
    if (keep.size >= HISTORY_KEEP) break;
    bytes += e.bytes;
    if (keep.size > 0 && bytes > HISTORY_BYTES) break;
    keep.add(e.id);
  }
  return keep;
}

/** dir の中の版（新しい順）。ext は ".lim" など。日時の読めない名前は入れない。 */
export function listVersions(dir: string, ext: string): VersionInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext) && STAMP.test(e.name))
    .map((e) => e.name.slice(0, -ext.length))
    .sort(compareVersionIds)
    .reverse()
    .map((id) => {
      const st = statSync(join(dir, `${id}${ext}`));
      return { id, time: versionTime(id) ?? st.mtimeMs, bytes: st.size };
    });
}

/** dir の版を間引く（thinVersions で残さないものを消す）。 */
export function pruneVersions(dir: string, ext: string, now = Date.now()): void {
  const all = listVersions(dir, ext);
  const keep = thinVersions(all, now);
  for (const v of all) if (!keep.has(v.id)) rmSync(join(dir, `${v.id}${ext}`), { force: true });
}

/** text を dir に新しい版として残し、間引く。版の id を返す。 */
export function keepVersion(dir: string, ext: string, text: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const base = versionStamp(now);
  let id = base;
  for (let i = 1; existsSync(join(dir, `${id}${ext}`)); i++) id = `${base}-${i}`;
  writeAtomic(join(dir, `${id}${ext}`), text);
  pruneVersions(dir, ext, now.getTime());
  return id;
}

/** 一時ファイルに書いてから置き換える（途中で止まっても半端なファイルを残さない）。 */
export function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
