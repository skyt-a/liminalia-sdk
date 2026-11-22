// @ts-check
/**
 * 書き出したデスクトップ版の、止まったときの記録と逃げ道（main.cjs が使い、テストもこのファイルを読む）。
 * - 止まったときの記録（保存先の logs/crash-<日時>.log）は新しいものから KEEP_LOGS 件だけ残す
 * - 描画のプロセスが短い間に続けて落ちたら読み直しをやめる（crashCounter）。次の起動では GPU を使わない印（gpu.json）を置く。
 *   印はゲームの版が変わるまで効く（新しい版で直っているかもしれないので、版が変われば GPU を使い直す）
 */
const fs = require("node:fs");
const path = require("node:path");

/** 残す記録の数。 */
const KEEP_LOGS = 20;

/**
 * 記録を書き、古いものを片づける。書けなければ何もしない（遊ぶのは続ける）。書いたファイルを返す（書けなければ null）。
 * @param {string} dir
 * @param {string} text
 * @param {{ keep?: number, now?: Date }} [o]
 */
function writeCrashLog(dir, text, o = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `crash-${(o.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}.log`);
    fs.writeFileSync(file, text);
    pruneLogs(dir, o.keep ?? KEEP_LOGS);
    return file;
  } catch {
    // 記録を書けなくても、画面の読み直しは続ける
    return null;
  }
}

/**
 * 記録（crash-*.log）を新しいものから keep 件だけ残す。名前の日時の順が書いた順。
 * @param {string} dir
 * @param {number} keep
 */
function pruneLogs(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith("crash-") && n.endsWith(".log"));
  } catch {
    // 記録のフォルダが読めなければ、古い記録を消さない
    return;
  }
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.rmSync(path.join(dir, n), { force: true });
    } catch {
      // 消せなくても続ける
    }
  }
}

/**
 * 短い間に続けて落ちたかを数える。record() は落ちた時刻を足し、within ミリ秒の間に limit 回に届いたら true。
 * @param {{ limit?: number, within?: number, now?: () => number }} [o]
 */
function crashCounter(o = {}) {
  const limit = o.limit ?? 3;
  const within = o.within ?? 60_000;
  const now = o.now ?? Date.now;
  /** @type {number[]} */
  let times = [];
  return {
    record() {
      const t = now();
      times = [...times.filter((x) => t - x < within), t];
      return times.length >= limit;
    },
    reset() {
      times = [];
    },
  };
}

/**
 * GPU を使わない印があるか。印を置いたときと版が違えば印を消して false（新しい版で GPU を使い直す）。
 * @param {string} file
 * @param {string} version
 */
function gpuOff(file, version) {
  let mark;
  try {
    mark = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // 印が無い・読めなければ、画面の部品（GPU）を切らない
    return false;
  }
  if (mark && mark.disabled === true && mark.version === version) return true;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 消せなくても GPU を使う
  }
  return false;
}

/**
 * 次の起動から GPU を使わない印を置く。置けたら true。
 * @param {string} file
 * @param {string} version
 * @param {string} reason
 */
function turnGpuOff(file, version, reason) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ disabled: true, version, reason, date: new Date().toISOString() }, null, 2));
    return true;
  } catch {
    // 印を書けなければ、次の起動でも GPU を使う（落ち続ける回数の上限は別に数える）
    return false;
  }
}

module.exports = { KEEP_LOGS, writeCrashLog, pruneLogs, crashCounter, gpuOff, turnGpuOff };
