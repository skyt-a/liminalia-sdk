/** 行の書き換え（プラグインの ctx.script.apply）。from〜to の行を text に（null なら行ごと消す。to = from - 1 なら from の前に足す）。 */
export interface LineEdit {
  from: number;
  to: number;
  expect: string;
  text: string | null;
  /** 書き換える前に確かめる行（足すときは expect で確かめられないので、基準の行をここで確かめる）。違えば changed。 */
  guard?: { line: number; text: string };
}

export type LineEditPlan =
  | { ok: true; changes: { from: number; to: number; insert: string }[] }
  | { ok: false; reason: "changed" | "invalid"; index: number };

/**
 * 書き換えを、文書の位置の変更（CodeMirror の changes。どれも書き換える前の文書の位置）にする。
 * 行の範囲が文書の外・重なっている・逆向きなら invalid、行が expect と違えば changed（どちらも何も変えない）。
 */
export function planLineEdits(doc: string, edits: readonly LineEdit[]): LineEditPlan {
  const lines = doc.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const n = lines.length;
  const lineEnd = (line: number) => starts[line - 1]! + lines[line - 1]!.length;

  const order = edits.map((e, index) => ({ e, index })).sort((a, b) => a.e.from - b.e.from || a.e.to - b.e.to);
  let last = 0;
  for (const { e, index } of order) {
    const insert = e.to === e.from - 1;
    if (!Number.isInteger(e.from) || !Number.isInteger(e.to) || e.from < 1 || (insert ? e.from > n + 1 : e.to < e.from || e.to > n)) return { ok: false, reason: "invalid", index };
    // 足すのは前の書き換えの後ろから、書き換えは前の書き換えと重ならない
    if (e.from <= last) return { ok: false, reason: "invalid", index };
    if (insert && e.text === null) return { ok: false, reason: "invalid", index };
    last = insert ? e.from - 1 : e.to;
  }
  for (const { e, index } of order) {
    if (e.guard && lines[e.guard.line - 1] !== e.guard.text) return { ok: false, reason: "changed", index };
    if (e.to === e.from - 1) {
      if (e.expect !== "") return { ok: false, reason: "changed", index };
    } else if (lines.slice(e.from - 1, e.to).join("\n") !== e.expect) return { ok: false, reason: "changed", index };
  }

  const changes = order.map(({ e }) => {
    if (e.to === e.from - 1) {
      // 末尾に足すときは前の行の後ろに改行から、ほかは from の行の頭に改行まで
      if (e.from === n + 1) return { from: doc.length, to: doc.length, insert: `\n${e.text}` };
      return { from: starts[e.from - 1]!, to: starts[e.from - 1]!, insert: `${e.text}\n` };
    }
    if (e.text !== null) return { from: starts[e.from - 1]!, to: lineEnd(e.to), insert: e.text };
    // 行ごと消す: 後ろに行があればその頭まで、最後の行なら前の行の末尾から
    if (e.to < n) return { from: starts[e.from - 1]!, to: starts[e.to]!, insert: "" };
    if (e.from > 1) return { from: lineEnd(e.from - 1), to: lineEnd(e.to), insert: "" };
    return { from: 0, to: doc.length, insert: "" };
  });
  return { ok: true, changes };
}
