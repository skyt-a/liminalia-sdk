// @ts-check
/**
 * 書き出したデスクトップ版の、ウィンドウの位置と大きさの記憶（main.cjs が使い、テストもこのファイルを読む）。
 * 閉じるときと、動かしたり大きさを変えたりしたときに保存先の window.json に書き、次の起動でウィンドウを出す前に当てる。
 * 覚えた画面がもう無いとき（外したモニター）や、覚えた位置が画面の外になったときは、画面の真ん中に置く。画面より大きければ縮める。
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ bounds: Rect, display?: number, fullscreen?: boolean, maximized?: boolean }} WindowState
 * @typedef {{ id: number, workArea: Rect }} DisplayInfo
 */

/** @param {unknown} r @returns {r is Rect} */
function isRect(r) {
  if (!r || typeof r !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (r);
  return ["x", "y", "width", "height"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k])) && /** @type {number} */ (o.width) > 0 && /** @type {number} */ (o.height) > 0;
}

/**
 * 覚えたもの（無いか壊れていれば null）。
 * @param {string} file
 * @returns {WindowState | null}
 */
function readWindowState(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!o || !isRect(o.bounds)) return null;
    /** @type {WindowState} */
    const out = { bounds: { x: Math.round(o.bounds.x), y: Math.round(o.bounds.y), width: Math.round(o.bounds.width), height: Math.round(o.bounds.height) } };
    if (typeof o.display === "number") out.display = o.display;
    if (o.fullscreen === true) out.fullscreen = true;
    if (o.maximized === true) out.maximized = true;
    return out;
  } catch {
    // 覚えた大きさが読めなければ、既定の大きさで開く
    return null;
  }
}

/**
 * 覚える（書けなければ何もしない）。
 * @param {string} file
 * @param {WindowState} state
 */
function writeWindowState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // 覚えられなくても遊ぶのは続ける
  }
}

/** @param {Rect} a @param {Rect} b */
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 覚えた位置と大きさを、今の画面に合わせて決める。displays は今の画面（はじめが主の画面）。覚えたものが無ければ null。
 * - 覚えた画面（id）がまだあればその画面、無ければ覚えた位置といちばん重なる画面、どれとも重ならなければ主の画面に置く
 * - 画面の作業領域より大きければ、縦横比を保って収まるまで縮める（scaled が true）
 * - ウィンドウの上の端（題名の帯のあたり）が作業領域に入らないか、別の画面へ移すときは、その画面の真ん中に置く。入っていれば、はみ出す分だけ戻す
 * @param {WindowState | null} saved
 * @param {readonly DisplayInfo[]} displays
 * @returns {{ bounds: Rect, display: number, scaled: boolean } | null}
 */
function placeWindow(saved, displays) {
  if (!saved || displays.length === 0) return null;
  const b = saved.bounds;
  const byId = saved.display === undefined ? undefined : displays.find((d) => d.id === saved.display);
  const best = displays.reduce((a, d) => (overlap(b, d.workArea) > overlap(b, a.workArea) ? d : a), /** @type {DisplayInfo} */ (displays[0]));
  const target = byId && overlap(b, byId.workArea) > 0 ? byId : overlap(b, best.workArea) > 0 ? best : /** @type {DisplayInfo} */ (displays[0]);
  const area = target.workArea;
  const scale = Math.min(1, area.width / b.width, area.height / b.height);
  const width = Math.max(1, Math.floor(b.width * scale));
  const height = Math.max(1, Math.floor(b.height * scale));
  // 上の端（高さ 40、幅は 200 まで）が作業領域に入っているか
  const top = { x: b.x, y: b.y, width: Math.min(width, 200), height: 40 };
  const keep = overlap(b, area) > 0 && overlap(top, area) >= Math.min(width, 200) * 20;
  let x;
  let y;
  if (keep) {
    // Windows の外枠は作業領域の外へ数 px はみ出して置かれる（見えない縁）ので、少しのはみ出しは許す
    const slack = 16;
    x = Math.min(Math.max(b.x, area.x - slack), area.x + area.width - width + slack);
    y = Math.min(Math.max(b.y, area.y), area.y + area.height - height + slack);
  } else {
    x = Math.round(area.x + (area.width - width) / 2);
    y = Math.round(area.y + (area.height - height) / 2);
  }
  return { bounds: { x, y, width, height }, display: target.id, scaled: scale < 1 };
}

module.exports = { readWindowState, writeWindowState, placeWindow };
