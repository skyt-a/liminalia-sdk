/** 行の並びの差分（Myers の O((N+M)D)）。共通の前後を先に切り落とす。 */
export type DiffOp = { op: "equal"; a: number; b: number } | { op: "delete"; a: number } | { op: "insert"; b: number };

export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: "equal", a: i, b: i });
  ops.push(...myers(a, b, start, endA, start, endB));
  for (let i = 0; i < a.length - endA; i++) ops.push({ op: "equal", a: endA + i, b: endB + i });
  return ops;
}

function myers(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): DiffOp[] {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0) return Array.from({ length: m }, (_, i) => ({ op: "insert", b: b0 + i }) as DiffOp);
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ op: "delete", a: a0 + i }) as DiffOp);
  const max = n + m;
  const offset = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    // 違いが大きすぎるとき（ファイルを書き直したときなど）は、全部消して全部足す
    if (d > 4000) return [...Array.from({ length: n }, (_, i) => ({ op: "delete", a: a0 + i }) as DiffOp), ...Array.from({ length: m }, (_, i) => ({ op: "insert", b: b0 + i }) as DiffOp)];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  trace.push(v.slice());
  // 後ろからたどる
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: "equal", a: a0 + x, b: b0 + y });
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ op: "insert", b: b0 + y - 1 });
    else ops.push({ op: "delete", a: a0 + x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: "equal", a: a0 + x, b: b0 + y });
  }
  return ops.reverse();
}
