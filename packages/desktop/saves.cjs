// @ts-check
/**
 * 書き出したデスクトップ版のセーブのファイル（main.cjs が使い、テストもこのファイルを読む）。
 * - 鍵ごとに一つのファイル。実行ファイルの横に置くときは、遊ぶ人が開いても分かるよう作品の鍵の頭（liminalia:<id>:）を除き、":" を "_" にする
 *   （slot:0 → slot_0.json。もとの "_" は %5F）。標準の場所は前からの名前（鍵をそのまま URL の形に）
 * - 書きかけで落ちても壊れないよう、別の名前に書いてから入れ替える。Windows でウイルス対策や同期のソフトがファイルを掴んでいると
 *   入れ替えが EPERM や EBUSY で失敗するので、少し待って試し直す。それでも書けなければ理由を返す（ゲームの画面が「セーブできませんでした」と出す）
 * - 書き込みは送られた順に一つずつ行う（試し直しの間に、後から来た同じ鍵の書き込みを先に済ませて、古い値で上書きしないため）
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {{ ok: true } | { ok: false, code: string, message: string }} WriteResult
 * @typedef {Pick<typeof fsp, "mkdir" | "writeFile" | "rename" | "rm">} FileOps
 */

/** 試し直す誤り。Windows はファイルを掴まれていると EPERM・EBUSY・EACCES になる。ほかの OS の EACCES・EPERM は試し直しても変わらない。 */
const RETRY_CODES = process.platform === "win32" ? ["EPERM", "EBUSY", "EACCES", "EAGAIN"] : ["EBUSY", "EAGAIN"];
/** 試し直すまでの待ち（ミリ秒）。合わせて 1.5 秒ほど。 */
const RETRY_DELAYS = [50, 100, 200, 400, 800];

/** @param {unknown} e */
function errorCode(e) {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "";
}

/** @param {unknown} e */
function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 値をファイルに書く（別の名前に書いてから入れ替える）。掴まれているなどの一時の誤りは少し待って試し直す。
 * @param {string} file
 * @param {string} value
 * @param {{ delays?: readonly number[], retry?: readonly string[], fs?: FileOps }} [o] テストで待ちと試し直す誤りとファイルの操作を差し替える
 * @returns {Promise<WriteResult>}
 */
async function writeSafely(file, value, o = {}) {
  const delays = o.delays ?? RETRY_DELAYS;
  const retry = o.retry ?? RETRY_CODES;
  const ops = o.fs ?? fsp;
  const tmp = `${file}.tmp`;
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.mkdir(path.dirname(file), { recursive: true });
      await ops.writeFile(tmp, value);
      await ops.rename(tmp, file);
      return { ok: true };
    } catch (e) {
      const code = errorCode(e);
      const wait = delays[attempt];
      if (retry.includes(code) && wait !== undefined) {
        await sleep(wait);
        continue;
      }
      // 書き込みの失敗を返すのが先。一時ファイルを消せなくても、次の書き込みが上書きする
      await ops.rm(tmp, { force: true }).catch(() => undefined);
      return { ok: false, code, message: errorMessage(e) };
    }
  }
}

/**
 * ファイルを消す（無ければ何もしない）。掴まれているなどの一時の誤りは少し待って試し直す。
 * @param {string} file
 * @param {{ delays?: readonly number[], retry?: readonly string[], fs?: FileOps }} [o]
 * @returns {Promise<WriteResult>}
 */
async function removeSafely(file, o = {}) {
  const delays = o.delays ?? RETRY_DELAYS;
  const retry = o.retry ?? RETRY_CODES;
  const ops = o.fs ?? fsp;
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rm(file, { force: true });
      return { ok: true };
    } catch (e) {
      const code = errorCode(e);
      const wait = delays[attempt];
      if (retry.includes(code) && wait !== undefined) {
        await sleep(wait);
        continue;
      }
      return { ok: false, code, message: errorMessage(e) };
    }
  }
}

/**
 * 送られた順に一つずつ行う列。run は前のものが済んでから task を始め、その結果を返す。idle は今までに入れたものが済むまで待つ。
 * @returns {{ run<T>(task: () => Promise<T>): Promise<T>, idle(): Promise<void> }}
 */
function createQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return {
    run(task) {
      const p = tail.then(task, task);
      // 失敗は呼んだ側が p で受ける。列は次の書き込みへ進める
      tail = p.catch(() => undefined);
      return p;
    },
    idle() {
      return tail.then(() => undefined);
    },
  };
}

/**
 * 鍵のファイル。prefix は実行ファイルの横に置くときの作品の鍵の頭（liminalia:<id>:）。標準の場所は null。
 * @param {string} dir
 * @param {string} key
 * @param {string | null} prefix
 */
function fileOf(dir, key, prefix) {
  if (prefix && key.startsWith(prefix)) return path.join(dir, `${encodeURIComponent(key.slice(prefix.length)).replace(/_/g, "%5F").replace(/%3A/g, "_")}.json`);
  return path.join(dir, `${encodeURIComponent(key)}.json`);
}

/**
 * フォルダのセーブを全部読む（鍵 → 中身）。読めないファイルは飛ばす。prefix は fileOf と同じ。
 * @param {string} dir
 * @param {string | null} prefix
 * @returns {Record<string, string>}
 */
function readSaves(dir, prefix) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const name = f.slice(0, -".json".length);
      const key = prefix && !name.startsWith("liminalia%3A") ? prefix + decodeURIComponent(name.replace(/_/g, "%3A")) : decodeURIComponent(name);
      out[key] = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  return out;
}

/**
 * 前の置き場所のセーブを今の置き場所へ写す（今の置き場所にまだ一つも無いときだけ。前の置き場所は消さない）。写した数を返す。
 * 前の版の既定（Windows と Linux は実行ファイルの横の savedata）から、今の既定（OS の標準の場所）へ移るときに使う。
 * @param {{ dir: string, prefix: string | null }} from
 * @param {{ dir: string, prefix: string | null }} to
 */
function carrySaves(from, to) {
  if (path.resolve(from.dir) === path.resolve(to.dir)) return 0;
  if (Object.keys(readSaves(to.dir, to.prefix)).length > 0) return 0;
  const found = readSaves(from.dir, from.prefix);
  const keys = Object.keys(found);
  if (keys.length === 0) return 0;
  fs.mkdirSync(to.dir, { recursive: true });
  for (const key of keys) {
    const file = fileOf(to.dir, key, to.prefix);
    fs.writeFileSync(`${file}.tmp`, found[key] ?? "");
    fs.renameSync(`${file}.tmp`, file);
  }
  return keys.length;
}

module.exports = { RETRY_CODES, RETRY_DELAYS, writeSafely, removeSafely, createQueue, fileOf, readSaves, carrySaves };
