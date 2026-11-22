import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { writeAtomic } from "./versions.ts";

/**
 * ファイルを動かす・書き換える操作（テーマの適用、素材の追加・名前の変更・ごみ箱、キャラクターの名前の変更など）を、
 * 制作画面の ⌘Z・⇧⌘Z で元に戻し・やり直すための控え（一つの操作 = 一つの控え。開発サーバーが動いている間だけ覚える）。
 *
 * 画面は操作の返事の undo（控えの id）を覚え、戻すときは今の様子が操作のあとのままかを確かめてから（state が "applied"）、
 * POST /undo/apply で戻す。設定（liminalia.json）と cast.json と台本だけでなく、素材のファイルも前と同じ場所と中身に戻す
 * （前はテーマの適用を戻すと liminalia.json だけが戻り、ごみ箱へ移した前のテーマの素材は戻らなかった）。
 *
 * 一つの控えは書き換えの並び（Step）。戻すときは新しい順に undo、やり直すときは古い順に redo。
 * 戻してよいかは、同じもの（key）を書き換えた最後の一つが「あと」のままか（isAfter）で、やり直してよいかは最初の一つが「前」のままか（isBefore）で見る。
 *
 * 消したものと上書きしたものは、控えの置き場（.liminalia/undo/<開発サーバーごと>/）へ動かしておき、戻すときにそこから戻す。
 * 置き場は開発サーバーが替わると使わなくなるので、次に開いたときに消す。
 */

export interface Step {
  /** 戻せなかったときに書き手に挙げる名前。 */
  name: string;
  /** 同じものを書き換える手順をまとめる鍵（ファイルのパスなど）。 */
  key: string;
  undo(): void;
  redo(): void;
  /** 今が書いたあとのままか。 */
  isAfter(): boolean;
  /** 今が書く前のままか。 */
  isBefore(): boolean;
}

/** 控えの今の様子。applied は操作のあとのまま、undone は戻したまま、changed はそのあとでほかに変わった、gone は覚えていない。 */
export type JournalState = "applied" | "undone" | "changed" | "gone";

/** 覚えておく控えの数（古いものから忘れる）。 */
const KEEP = 200;
/** 控えの置き場。 */
export const UNDO_DIR = join(".liminalia", "undo");

export class Journals {
  private readonly items = new Map<string, { steps: Step[]; applied: boolean; after?: () => void }>();
  private seq = 0;
  private stashSeq = 0;
  /** この開発サーバーの置き場（.liminalia/undo/<id>）。 */
  readonly stashDir: string;

  constructor(root: string) {
    const pid = typeof process !== "undefined" && typeof process.pid === "number" ? process.pid : 0;
    this.stashDir = join(root, UNDO_DIR, `${Date.now().toString(36)}-${pid}`);
    sweepStashes(join(root, UNDO_DIR));
  }

  /** 操作の書き換えを一つの控えにする。書き換えが無ければ null。after は戻した・やり直したあとに呼ぶ（素材の一覧を捨てるなど）。 */
  add(steps: readonly Step[], after?: () => void): string | null {
    if (steps.length === 0) return null;
    const id = `u${++this.seq}`;
    this.items.set(id, { steps: [...steps], applied: true, ...(after ? { after } : {}) });
    while (this.items.size > KEEP) this.items.delete(this.items.keys().next().value!);
    return id;
  }

  state(id: string): JournalState {
    const item = this.items.get(id);
    if (!item) return "gone";
    // ほかの口で戻したもの（素材の画面の「元に戻す」でごみ箱から戻したなど）も、戻したものとして扱う
    const after = lastOfEach(item.steps).every((s) => s.isAfter());
    const before = firstOfEach(item.steps).every((s) => s.isBefore());
    if (after && before) return item.applied ? "applied" : "undone";
    return after ? "applied" : before ? "undone" : "changed";
  }

  /** to の様子にする（"undone" で戻す、"applied" でやり直す）。今がもう to なら何もしない。戻せなければ理由を返す。 */
  apply(id: string, to: "undone" | "applied"): { ok: true } | { ok: false; state: JournalState } {
    const item = this.items.get(id);
    const now = this.state(id);
    if (now === to) return { ok: true };
    if (!item || now === "changed" || now === "gone") return { ok: false, state: now };
    const steps = to === "undone" ? [...item.steps].reverse() : item.steps;
    const done: Step[] = [];
    try {
      for (const s of steps) {
        if (to === "undone") s.undo();
        else s.redo();
        done.push(s);
      }
    } catch (e) {
      // 途中で書けなくなったら、そこまでを元へ戻す（戻せないものは記録へ）
      for (const s of done.reverse()) {
        try {
          if (to === "undone") s.redo();
          else s.undo();
        } catch (back) {
          console.error(`Studio: 元に戻す途中で書き戻せませんでした: ${s.name}`, back);
        }
      }
      item.after?.();
      throw e;
    }
    item.applied = to === "applied";
    item.after?.();
    return { ok: true };
  }

  /** 控えの置き場の新しいパス（消したもの・上書きされたものを置く）。 */
  stashPath(): string {
    return join(this.stashDir, String(++this.stashSeq));
  }
}

function lastOfEach(steps: readonly Step[]): Step[] {
  const by = new Map<string, Step>();
  for (const s of steps) by.set(s.key, s);
  return [...by.values()];
}

function firstOfEach(steps: readonly Step[]): Step[] {
  const by = new Map<string, Step>();
  for (const s of steps) if (!by.has(s.key)) by.set(s.key, s);
  return [...by.values()];
}

/** 前の開発サーバーの置き場を消す（動いているほかの開発サーバーのものは残す）。 */
function sweepStashes(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const pid = Number(/-(\d+)$/.exec(name)?.[1] ?? Number.NaN);
    if (Number.isInteger(pid) && pid > 0 && running(pid)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (e) {
      // 消せなくても開ける（次に開いたときにまた消す）
      console.warn(`Studio: 前の元に戻すの控えを消せませんでした: ${name}`, e);
    }
  }
}

function running(pid: number): boolean {
  if (typeof process === "undefined" || typeof process.kill !== "function") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // 動いていない（か、確かめられない）なら消してよい
    return false;
  }
}

// ---- 書き換えの手順 ----

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

/**
 * テキストのファイルを before から after にした（null は無いこと）。write は書き方（省けばそのまま書く。台本・設定・cast.json は
 * それぞれの書き方で書き、変更履歴と知らせを通す）。
 */
export function textStep(name: string, path: string, before: string | null, after: string | null, write: (text: string | null) => void = writeOrRemove(path)): Step {
  return {
    name,
    key: path,
    undo: () => write(before),
    redo: () => write(after),
    isAfter: () => readText(path) === after,
    isBefore: () => readText(path) === before,
  };
}

/** そのまま書く（null なら消す）。 */
export function writeOrRemove(path: string): (text: string | null) => void {
  return (text) => {
    if (text === null) rmSync(path, { force: true });
    else writeAtomic(path, text);
  };
}

/**
 * ファイルかフォルダを from から to へ動かし、その手順を返す。top は、戻したあとに空になったフォルダを片付ける上限
 * （素材の種類のフォルダなど。その中の、動かしたときに作ったフォルダだけを消す）。move は動かし方（別のディスクへは写して消す）。
 */
export function moveFile(name: string, from: string, to: string, top: string | null, move: (a: string, b: string) => void = renameSync): Step {
  const made = mkdirSync(dirname(to), { recursive: true }) ?? null;
  move(from, to);
  return moveStep(name, from, to, top !== null ? made : null, move);
}

/** すでに動かした from → to の手順。made は動かすときに作ったフォルダ（戻したあと、空なら消す）。 */
export function moveStep(name: string, from: string, to: string, made: string | null, move: (a: string, b: string) => void = renameSync): Step {
  return {
    name,
    key: `move:${from}\n${to}`,
    undo: () => {
      mkdirSync(dirname(from), { recursive: true });
      move(to, from);
      if (made) removeEmptyUpTo(dirname(to), made);
    },
    // やり直すときは、動かす前の場所のフォルダはそのまま残す（前もあった）
    redo: () => {
      mkdirSync(dirname(to), { recursive: true });
      move(from, to);
    },
    isAfter: () => existsSync(to) && !existsSync(from),
    isBefore: () => existsSync(from) && !existsSync(to),
  };
}

/**
 * ファイルを書いて置き（素材の追加、テーマの素材の写し）、その手順を返す。前に同じ名前のものがあれば、先に控えの置き場へ動かしてから書く。
 * 戻すと書いたものを置き場へ動かして前のものを戻し、やり直すと置き場から戻す。中身が前と同じなら何もしない（手順も無い）。
 * top は、戻したあとに空になったフォルダを片付ける上限。
 */
export function putFile(journals: Journals, name: string, path: string, data: string | Uint8Array, top: string | null): Step[] {
  const before = existsSync(path) ? readFileSync(path) : null;
  if (before !== null && Buffer.from(data).equals(before)) return [];
  const steps: Step[] = [];
  const old = before === null ? null : journals.stashPath();
  if (old) {
    mkdirSync(dirname(old), { recursive: true });
    renameSync(path, old);
    steps.push({
      name,
      key: `old:${path}`,
      // 戻すときは、書いたもの（新しい順で先に置き場へ動いている）の場所へ前のものを戻す
      undo: () => renameSync(old, path),
      redo: () => {
        mkdirSync(dirname(old), { recursive: true });
        renameSync(path, old);
      },
      isAfter: () => existsSync(old),
      isBefore: () => !existsSync(old) && existsSync(path),
    });
  }
  const made = before === null && top !== null ? (mkdirSync(dirname(path), { recursive: true }) ?? null) : null;
  writeAtomic(path, typeof data === "string" ? data : Buffer.from(data));
  const stash = journals.stashPath();
  steps.push({
    name,
    key: path,
    undo: () => {
      mkdirSync(dirname(stash), { recursive: true });
      renameSync(path, stash);
      if (made) removeEmptyUpTo(dirname(path), made);
    },
    redo: () => {
      mkdirSync(dirname(path), { recursive: true });
      renameSync(stash, path);
    },
    isAfter: () => existsSync(path) && !existsSync(stash),
    // 上書きしたものは、戻すと前のものが同じ場所にある
    isBefore: () => existsSync(stash) && (old !== null || !existsSync(path)),
  });
  return steps;
}

/** 空のフォルダを消し、その手順を返す（空でなければ消さずに null）。戻すと作り直し、やり直すと空なら消す。 */
export function removeEmptyDir(name: string, dir: string): Step | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory() || readdirSync(dir).length > 0) return null;
  rmdirSync(dir);
  return {
    name,
    key: `dir:${dir}`,
    undo: () => void mkdirSync(dir, { recursive: true }),
    redo: () => {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    },
    isAfter: () => !existsSync(dir),
    isBefore: () => existsSync(dir) && statSync(dir).isDirectory(),
  };
}

/** dir から made まで、空のフォルダを消す。 */
function removeEmptyUpTo(dir: string, made: string): void {
  for (let d = dir; d.length >= made.length && relative(made, d).split(sep)[0] !== ".."; d = dirname(d)) {
    try {
      if (!existsSync(d) || readdirSync(d).length > 0) return;
      rmdirSync(d);
    } catch {
      // 消せないフォルダは残す（中に何か置かれた）
      return;
    }
    if (d === made) return;
  }
}
