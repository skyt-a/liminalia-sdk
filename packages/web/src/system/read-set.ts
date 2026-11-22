/**
 * 既読のページの集合。全セーブ共通で、Storage の "read" に保存する。
 *
 * ページはファイルとページの鍵（@liminalia/lang の pageKeys。話者と原文と一つ前のページから作る）で覚える。
 * 行の番号で覚えると、シナリオを直して行がずれたときに既読がずれ、新しく足した行が既読スキップで飛ばされるため。
 *
 * 前のバージョンは { ファイル: [行, …] } で保存していた。読み込んだ行はファイルごとに「移していない行」として持ち、
 * そのファイルのシナリオを読んだときに（adopt）今のシナリオの鍵に移す。移すまでは、行でも既読かを見る。
 */
export interface ReadSetJson {
  version: 2;
  /** ファイル → ページの鍵。 */
  pages: Record<string, string[]>;
  /** 前のバージョンが行で覚えていて、まだ鍵に移していない既読（ファイル → 行）。 */
  lines?: Record<string, number[]>;
}

/** 既読かを見るページ。key が無ければ（鍵の分からないページ）行で見る。 */
export interface PageRef {
  file: string;
  line: number;
  key?: string | undefined;
}

export class ReadSet {
  private readonly files = new Map<string, Set<string>>();
  /** 鍵に移していない、行で覚えた既読。 */
  private readonly legacy = new Map<string, Set<number>>();
  /** 最後に保存してから増えたか。 */
  dirty = false;

  /** 保存したもの（今の形か、前のバージョンの { ファイル: [行, …] }）から作る。壊れたところは捨てる。 */
  static from(json: unknown): ReadSet {
    const set = new ReadSet();
    if (!json || typeof json !== "object" || Array.isArray(json)) return set;
    const o = json as Record<string, unknown>;
    if (o.version === 2) {
      for (const [file, keys] of entries(o.pages)) for (const k of keys) if (typeof k === "string" && k !== "") set.keysOf(file).add(k);
      for (const [file, lines] of entries(o.lines)) set.addLines(file, lines);
    } else {
      for (const [file, lines] of entries(o)) set.addLines(file, lines);
    }
    return set;
  }

  has(page: PageRef): boolean {
    if (page.key && this.files.get(page.file)?.has(page.key)) return true;
    return this.legacy.get(page.file)?.has(page.line) ?? false;
  }

  /** 既読にする。新しく既読になったら true。鍵の分からないページは覚えない。 */
  add(page: PageRef): boolean {
    if (!page.key) return false;
    const s = this.keysOf(page.file);
    if (s.has(page.key)) return false;
    s.add(page.key);
    this.dirty = true;
    return true;
  }

  /** 鍵か行で覚えた既読を足す（セーブデータのインポート。数は前のバージョンの行、文字は鍵）。 */
  merge(file: string, values: readonly unknown[]): void {
    for (const v of values) {
      if (typeof v === "string" && v !== "") {
        if (!this.keysOf(file).has(v)) this.dirty = true;
        this.keysOf(file).add(v);
      } else if (typeof v === "number" && Number.isInteger(v) && !this.legacy.get(file)?.has(v)) {
        this.addLines(file, [v]);
        this.dirty = true;
      }
    }
  }

  /** そのファイルに、鍵に移していない行の既読があるか。 */
  hasLegacy(file: string): boolean {
    return this.legacy.has(file);
  }

  /** 鍵に移していない行の既読があるファイル。 */
  get legacyFiles(): string[] {
    return [...this.legacy.keys()];
  }

  /**
   * 行で覚えた既読を、今のシナリオの鍵に移す（keys は行 → 鍵。@liminalia/lang の pageKeys）。
   * 今のシナリオでその行が本文でなければ捨てる（前のバージョンのまま作品を更新していたら、行はもうずれているため）。
   */
  adopt(file: string, keys: ReadonlyMap<number, string>): void {
    const lines = this.legacy.get(file);
    if (!lines) return;
    this.legacy.delete(file);
    const s = this.keysOf(file);
    for (const line of lines) {
      const key = keys.get(line);
      if (key) s.add(key);
    }
    this.dirty = true;
  }

  get size(): number {
    let n = 0;
    for (const s of this.files.values()) n += s.size;
    for (const s of this.legacy.values()) n += s.size;
    return n;
  }

  toJSON(): ReadSetJson {
    const pages: Record<string, string[]> = {};
    // 並べ替えない（覚えた順のまま）。新しいページを読むたびに書くので、全体を並べ替えると読むほど重くなる
    for (const [file, s] of this.files) if (s.size > 0) pages[file] = [...s];
    const out: ReadSetJson = { version: 2, pages };
    if (this.legacy.size > 0) out.lines = Object.fromEntries([...this.legacy].map(([file, s]) => [file, [...s].sort((a, b) => a - b)]));
    return out;
  }

  private keysOf(file: string): Set<string> {
    let s = this.files.get(file);
    if (!s) this.files.set(file, (s = new Set()));
    return s;
  }

  private addLines(file: string, lines: readonly unknown[]): void {
    const s = this.legacy.get(file) ?? new Set<number>();
    for (const l of lines) if (typeof l === "number" && Number.isInteger(l)) s.add(l);
    if (s.size > 0) this.legacy.set(file, s);
  }
}

/** ファイル → 並び の形のものだけを取り出す。 */
function entries(value: unknown): [string, unknown[]][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
}
