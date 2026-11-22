// @ts-check
/**
 * 書き出したデスクトップ版の起動部分（Electron のメインプロセス）。
 *
 * TyranoBuilder の書き出しに合わせたところ:
 * - ゲームの画面サイズでウィンドウを開く。リサイズの可否は書き出し時に選ぶ。全画面はゲーム内のメニューで切り替える
 * - 開発者ツールは開かない。Windows ではメニューバーを出さない
 * 直したところ:
 * - 素材は独自のプロトコル（liminalia://）で読む。file:// のモジュール読み込みやパスの問題が起きない
 * - リサイズしても縦横比を保つ。Mac は標準のアプリメニュー（終了、編集、全画面、最小化）を付け、ウィンドウを閉じたら終了する。
 *   メニューの文言は遊ぶ言語（ゲームの画面が知らせる。知らせる前と、作品が言語を決めていないときは OS の言語）に合わせる
 * - ウィンドウの位置、大きさ、モニター、全画面かを覚え、次の起動ではウィンドウを出す前に当てる（window-state.cjs）
 * - セーブは OS の標準の場所（Windows は %APPDATA%\<名前>、Mac は ~/Library/Application Support/<名前>、Linux は ~/.config/<名前>）の saves/ が既定。
 *   game.json の saves（liminalia.json の saves.location）が "portable" なら実行ファイルの横の「savedata」（Mac はアプリの横の「<名前> savedata」）に、
 *   セーブのファイルを直に置き、Electron の作業用のファイル（キャッシュ、パッチ、記録）はその中の system/ にまとめる（標準の場所には何も作らない）。
 *   書けない場所（Program Files など）なら標準の場所。前の版の既定（Windows と Linux は実行ファイルの横）にセーブがあれば、はじめて起動したときに写す
 * - セーブを書けなければ少し待って試し直し、それでも書けなければゲームの画面へ知らせる（saves.cjs）
 * - 性能の高い GPU を使う（ノート PC で省電力の GPU に回されない）。game.json の gpu が "default" なら OS に任せる
 * - 二重に起動しない（二つ目は前のウィンドウを前に出して終わる）
 * - 画面のプロセスが落ちたら記録して開き直す。短い間に続けて落ちたら開き直すのをやめて知らせ、次の起動からは GPU を使わない（recovery.cjs）
 * - オート中と動画の再生中は、画面のスリープを止める
 *
 * 店: game.json に steam（liminalia.json の build.steam）があれば Steam につなぎ、ゲームの @achieve を Steam の実績にする
 * （書き出しが steamworks.js を同梱する）。Steam が起動していないなどでつながらなければ、実績を送らずにそのまま遊べる。
 * store（build.store.desktop）があれば、作品のプラグインの店の口（GOG Galaxy など）を使う（store.cjs）。
 *
 * アップデート: game.json に update（liminalia.json の build.update）があれば、マニフェストを取り寄せて新しい版とパックを確かめる
 * （ゲームの画面が尋ねる。パックは保存先の packs/ に入れて再起動。本体は Windows はインストーラーを起動し、Mac（zip）と Linux（tar.gz）は
 * 隣に展開して確かめてから入れ替えて起動し直す（app-swap.cjs）。ファイルが無ければダウンロードのページを開く。update.cjs）。
 * 再起動と終了は、閉じる前の知らせ（オートセーブと保存）を通す。
 *
 * Linux で sandbox を使えない環境（chrome-sandbox に権限が無く、利用者の名前空間も使えない）は、起動の引数の --no-sandbox で起動する。
 * 付けて起動したときは、再起動と本体の入れ替えのあとの起動にも同じ引数を渡す。
 *
 * 環境変数 LIMINALIA_SMOKE=<png のパス> で起動すると、タイトル画面が出たら画面を撮って終了する（書き出しの自動確認用）。
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, net, powerSaveBlocker, protocol, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const update = require("./update.cjs");
const appSwap = require("./app-swap.cjs");
const { createStore } = require("./store.cjs");
const saves = require("./saves.cjs");
const recovery = require("./recovery.cjs");
const windowState = require("./window-state.cjs");
const menus = require("./menu.cjs");

/**
 * 書き出しが入れる game.json（packages/cli の build.ts）。
 * @typedef {{
 *   title: string, id: string, width: number, height: number, resizable?: boolean,
 *   saves?: "user" | "portable", carryFrom?: Record<string, string>, encrypt?: string, gpu?: "default", fullscreen?: false,
 *   steam?: { appId: number } & Record<string, unknown>, update?: { url: string, publicKey?: string | string[], startup?: boolean } & Record<string, unknown>,
 *   store?: { module: string, options?: unknown },
 * }} GameConfig
 */

/** @type {GameConfig} */
const game = JSON.parse(fs.readFileSync(path.join(__dirname, "game.json"), "utf8"));
const webRoot = path.join(__dirname, "web");
// 素材は書き出し時に resources へ一度だけ入れる（ファイル隠蔽がオンなら assets.asar）
const assetsRoot = [path.join(process.resourcesPath, "assets.asar"), path.join(process.resourcesPath, "assets"), path.join(webRoot, "assets")].find((p) => fs.existsSync(p));
const smoke = process.env.LIMINALIA_SMOKE;
/** ファイルの名前に使えない字を除いた題名。 */
const safeTitle = game.title.replace(/[\\/:*?"<>|]/g, "_");

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));
/** ゲームの画面が知らせた遊ぶ言語（作品が言語を決めていなければ空）。メニューと、ゲームの画面の外の知らせの文言に使う。 */
let language = "";

protocol.registerSchemesAsPrivileged([
  { scheme: "liminalia", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---- セーブの置き場所 ----

/** 実行ファイルの横のセーブのフォルダ（saves が "portable" で、書けたとき）。null なら標準の場所の saves/。 */
/** @type {string | null} */
let portableDir = null;
/** 実行ファイルの横に置くときのフォルダ。Mac は <名前>.app/Contents/MacOS/<実行ファイル> なので、アプリの中ではなく横に置く（同じフォルダにほかのアプリも並ぶので名前を付ける）。 */
const exeDir = path.dirname(process.execPath);
const portableCandidate = process.platform === "darwin" ? path.join(path.resolve(exeDir, "../../.."), `${safeTitle} savedata`) : path.join(exeDir, "savedata");

/** セーブの置き場を実行ファイルの横にする（アプリの準備ができる前に）。書けなければ標準の場所のまま。 */
function usePortableSaves() {
  try {
    fs.mkdirSync(portableCandidate, { recursive: true });
    fs.accessSync(portableCandidate, fs.constants.W_OK);
    // セーブはこのフォルダに直に、Electron の作業用のファイルは system/ に
    app.setPath("userData", path.join(portableCandidate, "system"));
    portableDir = portableCandidate;
  } catch (e) {
    console.log(`セーブを ${portableCandidate} に置けないので、標準の場所に置きます: ${message(e)}`);
  }
}
if (game.saves === "portable") usePortableSaves();

/** 作品の鍵の頭（実行ファイルの横に置くときは、ファイルの名前から除く）。 */
const keyPrefix = `liminalia:${game.id}:`;
/** セーブのフォルダ（保存先の saves/。鍵ごとに一つのファイル。Steam の Auto-Cloud はこのフォルダを同期する）。実行ファイルの横に置くときは、そのフォルダに直に。 */
function savesDir() {
  return portableDir ?? path.join(app.getPath("userData"), "saves");
}
/** ファイルの名前から除く鍵の頭（実行ファイルの横に置くときだけ）。 */
function savesPrefix() {
  return portableDir && game.id ? keyPrefix : null;
}
/** 止まったときの記録の置き場所。 */
const logsDir = () => path.join(app.getPath("userData"), "logs");

/**
 * 前の版の既定（Windows と Linux は実行ファイルの横の savedata）のセーブを、標準の場所へ写す（はじめて起動したときに一度だけ。前の場所は消さない）。
 * 前の版がアップデートで入れたパック（savedata/system/packs）も写す。
 */
function carryOldDefaultSaves() {
  if (game.saves !== undefined || process.platform === "darwin" || portableDir) return;
  const mark = path.join(app.getPath("userData"), "saves-carried.json");
  if (fs.existsSync(mark) || !fs.existsSync(portableCandidate)) return;
  try {
    const n = saves.carrySaves({ dir: portableCandidate, prefix: game.id ? keyPrefix : null }, { dir: savesDir(), prefix: null });
    const oldPacks = path.join(portableCandidate, "system", "packs");
    const packs = path.join(app.getPath("userData"), "packs");
    if (n > 0 && fs.existsSync(oldPacks) && !fs.existsSync(packs)) fs.cpSync(oldPacks, packs, { recursive: true });
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, JSON.stringify({ from: portableCandidate, files: n, date: new Date().toISOString() }));
    if (n > 0) console.log(`以前のバージョンのセーブ（${portableCandidate}）を ${savesDir()} にコピーしました（${n} 件）`);
  } catch (e) {
    console.log(`以前のバージョンのセーブ（${portableCandidate}）をコピーできませんでした: ${message(e)}`);
  }
}

// ---- メインのプロセスの止まりと、描画の逃げ道 ----

/** @type {BrowserWindow | null} */
let win = null;

/**
 * メインのプロセスで捕まえていない例外と Promise の失敗を記録に残す。ウィンドウを出す前の例外は、知らせて終了する
 * （出せないまま見えないプロセスが残らないように）。出したあとは遊ぶのを続ける。
 * @param {string} kind
 * @param {unknown} error
 */
function mainError(kind, error) {
  const e = error instanceof Error ? error : new Error(String(error));
  console.error(`${kind}: ${e.stack || e.message}`);
  recovery.writeCrashLog(logsDir(), JSON.stringify({ message: `${kind}: ${e.message}`, stack: e.stack ?? "", process: "main", version: app.getVersion(), date: new Date().toISOString() }, null, 2));
  if (kind === "uncaughtException" && !win) fatal(e);
}
/**
 * 起動できなかったことを知らせて終了する。
 * @param {Error} e
 */
function fatal(e) {
  if (!smoke) dialog.showErrorBox(game.title, `${menus.texts(textLanguage()).startFailed}\n${e.message}`);
  app.exit(1);
}
process.on("uncaughtException", (e) => mainError("uncaughtException", e));
process.on("unhandledRejection", (e) => mainError("unhandledRejection", e));

/** GPU を使わない印（描画のプロセスが続けて落ちたときに置く。ゲームの版が変わるまで効く）。 */
const gpuFile = () => path.join(app.getPath("userData"), "gpu.json");
const gpuOff = !smoke && recovery.gpuOff(gpuFile(), app.getVersion());
if (gpuOff) {
  app.disableHardwareAcceleration();
  console.log(`前に画面のプロセスが続けて止まったため、GPU を使わずに表示します（${gpuFile()} を消すと使い直します）`);
} else if (game.gpu !== "default") app.commandLine.appendSwitch("force_high_performance_gpu");
if (process.platform === "linux" && (app.commandLine.hasSwitch("no-sandbox") || process.env.ELECTRON_DISABLE_SANDBOX)) console.log("sandbox を使わずに起動しました（--no-sandbox）");

// 二つ目の起動は、前のウィンドウを前に出して（second-instance）すぐ終わる。店につなぐ、ウィンドウを開くなどの続きはしない
if (!smoke && !app.requestSingleInstanceLock()) {
  app.exit(0);
  // @ts-expect-error 二つ目は、ここで読み込みをやめる（CommonJS のモジュールは関数の中で動くので return できる。型の確認は知らない）
  return;
}
carryOldDefaultSaves();

/**
 * 店（Steam か、作品のプラグインが差し込んだ GOG Galaxy などの店。つながらなければ null。store.cjs）。
 * Steam のオーバーレイの設定は、アプリの準備ができる前にする。
 */
const store = createStore(game, { appDir: __dirname, version: app.getVersion() });

/** ゲームの実績（@achieve の名前）を店の実績にする。Steam では名前が違えば build.steam.achievements で対応づける。 */
ipcMain.on("liminalia:achievement", (_event, id) => {
  if (store && store.achievement) store.achievement(String(id));
});

/** 数を数える実績の進み具合（@achieve-progress）。Steam では build.steam.stats で結んだ統計の値にする。 */
ipcMain.on("liminalia:achievement-progress", (_event, id, value, goal) => {
  if (store && store.achievementProgress) store.achievementProgress(String(id), Number(value), Number(goal));
});

/** 店の名前と、買ったものを確かめられるか（preload がゲームの画面へ渡す口を決める）。 */
ipcMain.on("liminalia:store-info", (event) => {
  event.returnValue = store ? { name: store.name, purchases: typeof store.owned === "function" } : null;
});
ipcMain.handle("liminalia:store-owned", async (_event, ids) => (store && store.owned ? store.owned((ids || []).map(String)) : []));
ipcMain.handle("liminalia:store-buy", async (_event, id) => (store && store.buy ? store.buy(String(id)) : "failed"));
ipcMain.handle("liminalia:store-restore", async (_event, ids) => (store && store.restore ? store.restore((ids || []).map(String)) : store && store.owned ? store.owned((ids || []).map(String)) : []));

// ---- 暗号にした素材とシナリオ（build.encrypt） ----

const assetKey = game.encrypt ? Buffer.from(game.encrypt, "base64") : null;
// 素材の分は @liminalia/lang の MEDIA_TYPES（packages/lang/src/media.ts）の写し。拡張子を足したら、ここも揃える
/** @type {Record<string, string>} */
const MIME = { ".lim": "text/plain; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac", ".opus": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg", ".vtt": "text/vtt", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject", ".frag": "text/plain; charset=utf-8", ".glsl": "text/plain; charset=utf-8", ".moc3": "application/octet-stream", ".skel": "application/octet-stream", ".atlas": "text/plain; charset=utf-8", ".js": "text/javascript" };
/** 戻した中身の控え（動画の飛ばし読みなどで同じものを何度も読むため。大きさの合計で古いものから捨てる）。 */
/** @type {Map<string, Buffer>} */
const decrypted = new Map();
let decryptedBytes = 0;

/** @param {string} file */
function decryptFile(file) {
  const hit = decrypted.get(file);
  if (hit) {
    decrypted.delete(file);
    decrypted.set(file, hit);
    return hit;
  }
  const raw = fs.readFileSync(file);
  let data = raw;
  if (assetKey && raw.length >= 20 && raw.subarray(0, 4).toString() === "LMEN") {
    const decipher = require("node:crypto").createDecipheriv("aes-256-ctr", assetKey, raw.subarray(4, 20));
    data = Buffer.concat([decipher.update(raw.subarray(20)), decipher.final()]);
  }
  decrypted.set(file, data);
  decryptedBytes += data.length;
  for (const [k, v] of decrypted) {
    if (decryptedBytes <= 256 * 1024 * 1024 || decrypted.size <= 1) break;
    decrypted.delete(k);
    decryptedBytes -= v.length;
  }
  return data;
}

/**
 * 範囲の指定（Range: bytes=a-b・bytes=a-・bytes=-n）から、返す範囲 [頭, 終わり]（終わりも含む）。答えない指定（読めない・いくつも並べた）は null、
 * 素材の外なら "bad"（416 で答える）。
 * @param {string | null} header
 * @param {number} size
 * @returns {[number, number] | "bad" | null}
 */
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n <= 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "bad" : [start, end];
}

/**
 * 範囲の外を頼まれたときの答え（416）。
 * @param {number} size
 */
const unsatisfiable = (size) => new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });

/**
 * 暗号にした素材を戻して返す。Range（音・動画の飛ばし読み）にも答える。
 * @param {string} file
 * @param {Request} request
 */
function serveEncrypted(file, request) {
  let data;
  try {
    data = decryptFile(file);
  } catch {
    // 復号できない素材は無いものとして返す（遊ぶ側は素材が無いときの扱いになる）
    return new Response("Not Found", { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = byteRange(request.headers.get("range"), data.length);
  if (range === "bad") return unsatisfiable(data.length);
  /** Buffer はそのまま Response の中身にできる（型の上では BodyInit に入らないため）。 @param {Buffer} b */
  const body = (b) => /** @type {BodyInit} */ (/** @type {unknown} */ (b));
  if (range) {
    const [start, end] = range;
    return new Response(body(data.subarray(start, end + 1)), { status: 206, headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${data.length}`, "accept-ranges": "bytes", "content-length": String(end - start + 1) } });
  }
  return new Response(body(data), { headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(data.length) } });
}

/**
 * 暗号にしていないファイルを返す。範囲の指定（Range）があれば、その分だけを読んで 206 で答える（長い BGM を展開せずに流し読みするため。
 * file:// の取り寄せは範囲の指定に答えない）。指定が無ければ、今までどおり file:// で返す。
 * @param {string} file
 * @param {Request} request
 * @returns {Response | Promise<Response>}
 */
function serveFile(file, request) {
  const header = request.headers.get("range");
  if (!header) return net.fetch(pathToFileURL(file).toString());
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    // 消えた素材は無いものとして返す
    return new Response("Not Found", { status: 404 });
  }
  const range = byteRange(header, size);
  if (range === "bad") return unsatisfiable(size);
  if (!range) return net.fetch(pathToFileURL(file).toString());
  const [start, end] = range;
  let body;
  try {
    body = /** @type {ReadableStream} */ (Readable.toWeb(fs.createReadStream(file, { start, end })));
  } catch {
    return net.fetch(pathToFileURL(file).toString());
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  return new Response(body, { status: 206, headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(end - start + 1) } });
}

/** SVG の応答に付ける CSP（文書として開いても中のスクリプトを動かさない。開発サーバーの vite.config.ts、スマホ版の Service Worker と同じ）。 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * SVG の応答に CSP を付ける（ほかの応答はそのまま）。<img> で読む絵には効かない。
 * @param {string} file
 * @param {Response | Promise<Response>} response
 * @returns {Response | Promise<Response>}
 */
function withSvgPolicy(file, response) {
  if (path.extname(file).toLowerCase() !== ".svg") return response;
  return Promise.resolve(response).then((r) => {
    const headers = new Headers(r.headers);
    headers.set("content-security-policy", SVG_CSP);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  });
}

// ---- 追加の中身・修正（パック） ----

/**
 * パックを探す場所（前にあるものが勝つ）: 保存先の packs/（アップデートで入れたもの。アプリの中は署名されていて書き換えられないことがあるため）、
 * Resources/packs（Steam の DLC のデポなど、後から置いたもの）。書き出しに入れたもの（web/packs）はこれらに無いときだけ使う。
 */
function packRoots() {
  return [path.join(app.getPath("userData"), "packs"), path.join(process.resourcesPath, "packs")];
}

/** 入っているパック（id → フォルダ）。起動したときに一度だけ探す（入れ替えたら再起動する）。 */
/** @type {Map<string, string>} */
let packFolders = new Map();

function findPacks() {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const root of packRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      if (d.startsWith(".") || out.has(d) || !fs.existsSync(path.join(root, d, "pack.json"))) continue;
      out.set(d, path.join(root, d));
    }
  }
  // 店が配る追加の中身（Steam ワークショップで購読したものなど）。同じ id は公式のもの（上の場所）を使う
  if (store && store.packs) {
    try {
      for (const p of store.packs()) if (!out.has(p.id)) out.set(p.id, p.folder);
    } catch (e) {
      console.log(`店の追加の中身を読めませんでした: ${message(e)}`);
    }
  }
  return out;
}

/** 書き出しに入れたパックの id（web/packs/index.json）。 */
function builtInPacks() {
  try {
    return /** @type {unknown[]} */ (JSON.parse(fs.readFileSync(path.join(webRoot, "packs", "index.json"), "utf8"))).map(String);
  } catch {
    return [];
  }
}

/** 入っているパックの版（id → pack.json の version。アップデートの確認に使う）。 */
function installedPackVersions() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const id of builtInPacks()) {
    try {
      out[id] = String(JSON.parse(fs.readFileSync(path.join(webRoot, "packs", id, "pack.json"), "utf8")).version ?? "0");
    } catch {
      // 読めないものは入っていないものとする
    }
  }
  for (const [id, dir] of packFolders) {
    try {
      out[id] = String(JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8")).version ?? "0");
    } catch {
      // 読めないパックは入っていないものとして扱う（次の更新で入れ直す）
      delete out[id];
    }
  }
  return out;
}

// ---- セーブのファイル ----

/** セーブの書き込み（送られた順に一つずつ）。 */
const writes = saves.createQueue();
/** セーブを書けなかったことを記録に残したか（一度だけ残す）。 */
let saveFailureLogged = false;

/**
 * 書けなかったときは、理由を出して記録に残す（ゲームの画面には結果を返し、画面が「セーブできませんでした」と出す）。
 * @param {saves.WriteResult} r
 * @param {string} key
 */
function reportWrite(r, key) {
  if (r.ok) return r;
  console.log(`セーブを書けませんでした（${key}、${savesDir()}）: ${r.code} ${r.message}`);
  if (!saveFailureLogged) {
    saveFailureLogged = true;
    recovery.writeCrashLog(logsDir(), JSON.stringify({ message: `save-failed: ${r.code} ${r.message}`, key, dir: savesDir(), version: app.getVersion(), date: new Date().toISOString() }, null, 2));
  }
  return r;
}

ipcMain.on("liminalia:storage-load", (event) => {
  event.returnValue = saves.readSaves(savesDir(), savesPrefix());
});
ipcMain.handle("liminalia:storage-set", (_event, key, value) => writes.run(async () => reportWrite(await saves.writeSafely(saves.fileOf(savesDir(), String(key), savesPrefix()), String(value)), String(key))));
ipcMain.handle("liminalia:storage-remove", (_event, key) => writes.run(async () => reportWrite(await saves.removeSafely(saves.fileOf(savesDir(), String(key), savesPrefix())), String(key))));

// ---- 止まったときの記録 ----

ipcMain.on("liminalia:crash", (_event, text) => recovery.writeCrashLog(logsDir(), String(text)));

/** 画面写真。ウィンドウをそのまま撮り、写真のフォルダの <題名>/ に置いて、そのパスを返す。 */
ipcMain.handle("liminalia:screenshot", async () => {
  if (!win || win.isDestroyed()) return "";
  const image = await win.webContents.capturePage();
  const dir = path.join(app.getPath("pictures"), safeTitle);
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, "0");
  const file = path.join(dir, `${safeTitle} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
});

/** 店の画面のキーボード（Steam Deck・ゲームパッドのとき）。使えないときは null を返し、ゲームの欄で打ってもらう。 */
ipcMain.handle("liminalia:gamepad-text", async (_event, o) => (store && store.gamepadText ? store.gamepadText(o) : null));
ipcMain.handle("liminalia:steam-deck", () => {
  try {
    return !!(store && store.isDeck && store.isDeck());
  } catch {
    // Steam に聞けなければ Steam Deck ではないとする
    return false;
  }
});

/** 店の在席表示（Steam の Rich Presence など）。 */
ipcMain.on("liminalia:presence", (_event, text) => {
  if (store && store.presence) store.presence(String(text || ""));
});

/**
 * 別のアプリ（体験版など。liminalia.json の saves.carryFrom）のセーブを読む。そのアプリの保存先（標準の場所の <題名>）を
 * 別のセッションとして開き、同じ場所（liminalia://game）の localStorage から、その作品の id のものを書き出したものの形で返す。
 */
ipcMain.handle("liminalia:carry", async (_event, from) => {
  const id = String(from && from.id);
  const title = String(from && from.title).replace(/[\\/:*?"<>|]/g, "_");
  if (!game.carryFrom || !(id in game.carryFrom)) return null;
  const dir = path.join(app.getPath("appData"), title);
  // ファイルのセーブ（今の版）があればそれを読む
  const files = saves.readSaves(path.join(dir, "saves"), null);
  const prefix = `liminalia:${id}:`;
  const fromFiles = Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  if (Object.keys(fromFiles).length > 0) return { project: id, entries: fromFiles };
  if (!fs.existsSync(path.join(dir, "Local Storage"))) return null;
  const ses = session.fromPath(dir);
  ses.protocol.handle("liminalia", () => new Response("<!doctype html><meta charset=utf-8>", { headers: { "content-type": "text/html" } }));
  const reader = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  try {
    await reader.loadURL("liminalia://game/carry.html");
    const entries = await reader.webContents.executeJavaScript(
      `(() => { const p = ${JSON.stringify(`liminalia:${id}:`)}; const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(p)) out[k.slice(p.length)] = localStorage.getItem(k); } return out; })()`,
    );
    return { project: id, entries };
  } catch (e) {
    console.log(`${title} のセーブを読めませんでした: ${message(e)}`);
    return null;
  } finally {
    reader.destroy();
  }
});

/** 入っているパック（書き出しに入れたものと、保存先の packs/ と Resources/packs のフォルダ）。 */
ipcMain.handle("liminalia:packs", () => [...new Set([...builtInPacks(), ...packFolders.keys()])]);

// ---- ウィンドウ ----

/** 覚えたウィンドウの位置と大きさを当てて起動したか（ゲームの画面は、設定のウィンドウの大きさを起動したときには当て直さない）。 */
let restoredWindow = false;
/** 覚えた全画面を当てて起動したか（ウィンドウを出す前は isFullScreen が false のことがあるため、ゲームの画面にはこれを渡す）。 */
let fullscreenAtStart = false;

// 設定画面の「ウィンドウの大きさ」。全画面なら戻してから（0 ははじめの大きさ）。今の位置を真ん中にして大きさを変える
ipcMain.on("liminalia:set-window-scale", (_event, scale) => {
  const w = win;
  if (!w || w.isDestroyed()) return;
  const want = Number(scale) > 0 ? Math.min(4, Number(scale)) : 1;
  if (w.isFullScreen()) {
    w.once("leave-full-screen", () => fitToScreen(want, true));
    w.setFullScreen(false);
  } else fitToScreen(want, true);
});
ipcMain.on("liminalia:set-fullscreen", (_event, on) => {
  if (win && !win.isDestroyed() && win.isFullScreen() !== !!on) win.setFullScreen(!!on);
});
/** ウィンドウの今の様子（ゲームの画面が起動したときに読む）。 */
ipcMain.on("liminalia:window-info", (event) => {
  event.returnValue = { restored: restoredWindow, fullscreen: !!win && !win.isDestroyed() && (win.isFullScreen() || fullscreenAtStart) };
});
/**
 * 裏へ回したとき（最小化）に、描画と時計を絞るか。ゲームの画面が、遊ぶ人の設定（最小化したときも鳴らし続ける、など）に合わせて頼む。
 * 絞らないと、最小化しても文字の表示とオートが進む。
 */
ipcMain.on("liminalia:background-throttling", (_event, on) => {
  if (win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(!!on);
});

// ---- 画面のスリープ ----

/** 画面のスリープを止めている印（powerSaveBlocker の id）。 */
/** @type {number | null} */
let awake = null;
/**
 * 画面のスリープを止める・戻す（ゲームの画面が、オート中と動画の再生中に頼む）。
 * @param {boolean} on
 */
function keepAwake(on) {
  if (on && awake === null) awake = powerSaveBlocker.start("prevent-display-sleep");
  else if (!on && awake !== null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
}
ipcMain.on("liminalia:keep-awake", (_event, on) => keepAwake(!!on));

// ---- 言語（メニューと、ゲームの画面の外の知らせ） ----

/** 文言の言語。 */
function textLanguage() {
  /** @type {string[]} */
  let system = [];
  try {
    system = app.getPreferredSystemLanguages();
  } catch {
    // 準備ができる前は読めないことがある
  }
  if (system.length === 0) system = [app.getLocale()];
  return menus.textLanguage(language, system);
}
ipcMain.on("liminalia:language", (_event, lang) => {
  const before = textLanguage();
  language = String(lang || "");
  if (app.isReady() && textLanguage() !== before) buildMenu();
});

// ---- アップデート（game.json の update。liminalia.json の build.update） ----

/** 今の OS の名前（マニフェストの app.files の鍵）。 */
const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
/** 最後に確かめた結果（更新するときに使う）。 */
/** @type {ReturnType<typeof update.planUpdate> | null} */
let updatePlan = null;
/** 起動したときの確認（一度だけ取り寄せ、ゲームの画面が尋ねるまで待たせておく）。 */
/** @type {Promise<ReturnType<typeof update.planUpdate> | null> | null} */
let startupCheck = null;

async function checkForUpdate() {
  if (!game.update) throw new Error("アップデートの確認は設定されていません");
  const res = await net.fetch(game.update.url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`アップデートの情報を取得できません（${res.status}）`);
  const json = await res.json();
  // 公開鍵を入れた書き出し（build.update.publicKey）は、署名の通ったマニフェストだけを使う
  const signed = update.verifyManifestSignature(json, game.update.publicKey);
  if (!signed.ok) throw new Error(signed.problem ?? "");
  const { manifest, problems } = update.validateManifest(json, game.update.url);
  if (!manifest) throw new Error(`アップデートの情報の形が正しくありません\n${problems.join("\n")}`);
  const plan = update.planUpdate(manifest, { appVersion: app.getVersion(), platform: osName, installed: installedPackVersions() });
  updatePlan = plan;
  return plan.app || plan.packs.length > 0 ? plan : null;
}

ipcMain.on("liminalia:update-enabled", (event) => {
  // 書き出しの自動確認（LIMINALIA_SMOKE）では確かめない（タイトル画面の写真に尋ねる画面が重なるため）
  event.returnValue = game.update && !smoke ? { startup: game.update.startup !== false } : null;
});
ipcMain.handle("liminalia:update-check", async (_event, fresh) => {
  if (!game.update) return { ok: false, error: "アップデートの確認は設定されていません" };
  try {
    const plan = await (fresh ? checkForUpdate() : (startupCheck ??= checkForUpdate()));
    return { ok: true, plan };
  } catch (e) {
    if (!fresh) startupCheck = null;
    console.log(`アップデートを確認できませんでした: ${message(e)}`);
    return { ok: false, error: message(e) };
  }
});

/**
 * 取り寄せの進み具合をゲームの画面へ知らせる。
 * @param {string} name
 * @param {number} done
 * @param {number} total
 */
function updateProgress(name, done, total) {
  if (win && !win.isDestroyed()) win.webContents.send("liminalia:update-progress", { name, done, total });
}

/**
 * 確かめた更新を行う。"packs": パックを取り寄せて sha256 を確かめ、保存先の packs/ に入れる（再起動で効く）。
 * "app": この OS のファイルがあれば取り寄せて確かめ、Windows のインストーラーなら起動して終了する（ほかの OS は開く）。
 * ファイルが無ければダウンロードのページを開く。終了するときは、閉じる前の知らせ（オートセーブと保存）を通す。
 */
ipcMain.handle("liminalia:update-apply", async (_event, what) => {
  const plan = updatePlan;
  if (!plan) return { ok: false, error: "先にアップデートを確認してください" };
  const downloads = path.join(app.getPath("userData"), "updates");
  try {
    if (what === "packs") {
      for (const p of plan.packs) {
        const zip = path.join(downloads, `${p.id}-${p.version}.zip`);
        await update.download(net.fetch, p.url, zip, p, (done, total) => updateProgress(p.title || p.id, done, total));
        update.installPack(zip, /** @type {string} */ (packRoots()[0]), p.id);
        fs.rmSync(zip, { force: true });
        console.log(`パック ${p.id} ${p.version} を入れました`);
      }
      return { ok: true, action: "packs" };
    }
    if (what === "app" && plan.app) {
      const file = plan.app.file;
      if (!file) {
        await shell.openExternal(plan.app.page ?? "");
        return { ok: true, action: "page" };
      }
      const name = decodeURIComponent(new URL(file.url).pathname.split("/").pop() || `update-${plan.app.version}`).replace(/[\\/:*?"<>|]/g, "_");
      const dest = path.join(downloads, name);
      await update.download(net.fetch, file.url, dest, file, (done, total) => updateProgress(name, done, total));
      // Mac（zip）と Linux（tar.gz）: 隣に展開して確かめ、ゲームを終えてから入れ替えて起動し直す（app-swap.cjs）。
      // 入れ替えられない場所（書けない場所、Gatekeeper が移して動かしているとき）は、今までどおり取り寄せたファイルを開く
      const loc = app.isPackaged ? appSwap.appLocation(process.execPath, process.platform) : null;
      if (loc && appSwap.swappableArchive(name, process.platform) && appSwap.canReplace(loc)) {
        const swap = appSwap.swapPlan(loc, game.id);
        const check = { version: plan.app.version, bundleId: process.platform === "darwin" ? readBundleId(loc.target) : undefined, name: readOwnPackageName() };
        await appSwap.prepare(dest, swap, process.platform, check);
        fs.writeFileSync(pendingUpdateFile(), JSON.stringify({ from: app.getVersion(), to: plan.app.version, started: swap.started, result: swap.result, staging: swap.staging }));
        // Linux は新しい版を、今のゲームと同じ引数（--no-sandbox など）で起動する
        appSwap.launchSwap(swap, process.platform, process.pid, appSwap.START_WAIT_SECONDS, process.platform === "linux" ? process.argv.slice(1) : []);
        console.log(`本体を ${plan.app.version} に入れ替えて起動し直します（${swap.target}）`);
        setTimeout(() => app.quit(), 300);
        return { ok: true, action: "restart" };
      }
      if (process.platform === "win32" && /\.(exe|msi)$/i.test(name)) {
        const { spawn } = require("node:child_process");
        spawn(dest, [], { detached: true, stdio: "ignore" }).unref();
        setTimeout(() => app.quit(), 300);
        return { ok: true, action: "installer" };
      }
      const problem = await shell.openPath(dest);
      if (problem) shell.showItemInFolder(dest);
      return { ok: true, action: "opened" };
    }
    return { ok: false, error: "更新するものがありません" };
  } catch (e) {
    console.log(`アップデートできませんでした: ${message(e)}`);
    return { ok: false, error: message(e) };
  }
});

/** 本体の入れ替えを頼む前に残す控え（次に起動したアプリが読み、結果を確かめて片づける）。 */
function pendingUpdateFile() {
  const dir = path.join(app.getPath("userData"), "updates");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "pending.json");
}

/**
 * Mac のアプリの ID（Info.plist の CFBundleIdentifier）。
 * @param {string} appPath
 */
function readBundleId(appPath) {
  const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  return m ? (m[1] ?? "") : "";
}

/** このゲームの package.json の name（入れ替える新しいゲームが同じゲームかを見る）。 */
function readOwnPackageName() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).name;
  } catch {
    // 読めなければ名前を確かめずに続ける（呼ぶ側が入れ替えを断る）
    return undefined;
  }
}

// パックを入れたあとの再起動。閉じる前の知らせ（オートセーブと保存）を通してから終了し、同じ引数で起動し直す
ipcMain.on("liminalia:relaunch", () => {
  app.relaunch();
  if (win && !win.isDestroyed()) win.close();
  else app.quit();
});

function serve() {
  protocol.handle("liminalia", (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    // 後から入れた追加の中身・修正（保存先の packs/、Resources/packs）は、書き出しに入れたもの（web/packs）より先に
    const packMatch = /^\/packs\/([^/]+)\/(.+)$/.exec(rel);
    const packDir = packMatch ? packFolders.get(packMatch[1] ?? "") : undefined;
    if (packMatch && packDir) {
      const file = path.normalize(path.join(packDir, packMatch[2] ?? ""));
      // パッチを暗号にしてあれば戻す（serveEncrypted は暗号でないものはそのまま返す）
      if (file.startsWith(packDir + path.sep) && fs.existsSync(file)) return withSvgPolicy(file, assetKey ? serveEncrypted(file, request) : serveFile(file, request));
    }
    const base = rel.startsWith("/assets/") && assetsRoot ? assetsRoot : webRoot;
    const file = path.normalize(path.join(base, base === webRoot ? rel : rel.slice("/assets".length)));
    if (!file.startsWith(base + path.sep)) return new Response("Not Found", { status: 404 });
    // 暗号にした素材と、作品の中身（シナリオ・データ・キャスト・訳。build.encrypt）は戻して返す
    if (assetKey && (base === assetsRoot || rel.startsWith("/project/") || rel.startsWith("/packs/"))) return withSvgPolicy(file, serveEncrypted(file, request));
    // 無いもの（パックの一覧など、あれば読むもの）は 404 で答える
    if (!fs.existsSync(file)) return new Response("Not Found", { status: 404 });
    return withSvgPolicy(file, serveFile(file, request));
  });
}

/** Mac のメニュー（遊ぶ言語で）。Windows と Linux はメニューバーを出さない（入力欄のコピーと貼り付けは OS の決まりで効く）。 */
function buildMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus.menuTemplate(game.title, { fullscreen: game.fullscreen !== false }, textLanguage())));
}

/**
 * ゲーム画面がゲームの大きさの want 倍になるようにし（useContentSize）、画面の作業領域に収まらなければ同じ比で縮める
 * （OS に縮められると縦横比がずれて、左右か上下に黒い帯が出る）。keep なら今のウィンドウの真ん中を保ち（画面の外へは出さない）、
 * そうでなければ画面の真ん中に置く。
 * @param {number} [want]
 * @param {boolean} [keep]
 */
function fitToScreen(want = 1, keep = false) {
  const w = win;
  if (!w) return;
  const before = w.getBounds();
  const area = screen.getDisplayMatching(before).workArea;
  const [outerW = 0, outerH = 0] = w.getSize();
  const [innerW = 0, innerH = 0] = w.getContentSize();
  const frameW = outerW - innerW;
  const frameH = outerH - innerH;
  const scale = Math.min(want, (area.width - frameW) / game.width, (area.height - frameH) / game.height);
  w.setContentSize(Math.floor(game.width * scale), Math.floor(game.height * scale));
  if (!keep) {
    w.center();
    return;
  }
  const after = w.getBounds();
  /** @param {number} v @param {number} lo @param {number} hi */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const x = clamp(before.x + (before.width - after.width) / 2, area.x, area.x + area.width - after.width);
  const y = clamp(before.y + (before.height - after.height) / 2, area.y, area.y + area.height - after.height);
  w.setPosition(Math.round(x), Math.round(y));
}

/** ゲーム画面の縦横比をゲームと同じにする（覚えた大きさを小さな画面に合わせて縮めたとき。外枠の分だけ比がずれるため）。 */
function fixAspect() {
  const w = win;
  if (!w) return;
  const [innerW = 0] = w.getContentSize();
  w.setContentSize(innerW, Math.round((innerW * game.height) / game.width));
}

/**
 * 大きさを変えても、ゲーム画面（タイトルバーと枠を除いた中）の縦横比をゲームと同じに保つ。
 * Windows の setAspectRatio はタイトルバーと枠を含めた大きさに比を掛けるので、中の比がずれて黒い帯が出る。
 * Windows では引いている辺に合わせて自分で大きさを決める（Mac と Linux は setAspectRatio が中の大きさに掛かる）。
 */
function keepAspect() {
  const w = win;
  if (!w) return;
  const ratio = game.width / game.height;
  if (process.platform !== "win32") {
    w.setAspectRatio(ratio);
    return;
  }
  w.on("will-resize", (event, next, details) => {
    const [outerW = 0, outerH = 0] = w.getSize();
    const [innerW = 0, innerH = 0] = w.getContentSize();
    const frameW = outerW - innerW;
    const frameH = outerH - innerH;
    // Windows は上の辺だけを引くと "top" が来る（型には無い）
    const edge = /** @type {string} */ ((details && details.edge) || "");
    let width = next.width;
    let height = next.height;
    // 上か下の辺だけを引いたら高さに、ほかは幅に合わせる
    if (edge === "top" || edge === "bottom") width = Math.round((height - frameH) * ratio) + frameW;
    else height = Math.round((width - frameW) / ratio) + frameH;
    event.preventDefault();
    w.setBounds({
      x: edge.includes("left") ? next.x + next.width - width : next.x,
      y: edge.includes("top") ? next.y + next.height - height : next.y,
      width,
      height,
    });
  });
}

/** ウィンドウの位置と大きさを覚えるファイル。 */
const windowFile = () => path.join(app.getPath("userData"), "window.json");

/** 今のウィンドウの位置、大きさ、モニター、全画面かを覚える。 */
function rememberWindow() {
  const w = win;
  if (!w || w.isDestroyed() || smoke) return;
  const bounds = w.getNormalBounds();
  windowState.writeWindowState(windowFile(), { bounds, display: screen.getDisplayMatching(bounds).id, ...(w.isFullScreen() ? { fullscreen: true } : {}), ...(w.isMaximized() ? { maximized: true } : {}) });
}

/** 描画のプロセスが短い間に続けて落ちたかを数える。 */
const renderCrashes = recovery.crashCounter({ limit: 3, within: 60_000 });

/**
 * 描画のプロセスが続けて落ちた。開き直すのをやめて知らせ、次の起動からは GPU を使わない（もう使っていなければ、知らせるだけ）。
 * 再起動を選べば起動し直す。知らせている間もメインのプロセスは止めない（終了の合図や二つ目の起動を受けられるように）。
 * @param {string} reason
 */
function giveUpRendering(reason) {
  const t = menus.texts(textLanguage());
  const marked = !gpuOff && recovery.turnGpuOff(gpuFile(), app.getVersion(), reason);
  const detail = marked ? t.crashMessage : t.crashMessageNoGpu;
  if (smoke) return app.quit();
  const options = { type: /** @type {const} */ ("error"), title: game.title, message: t.crashTitle, detail, buttons: [t.restart, t.quitButton], defaultId: 0, cancelId: 1 };
  const w = win && !win.isDestroyed() ? win : null;
  void (w ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options)).then(({ response }) => {
    if (response === 0) app.relaunch();
    app.quit();
  });
}

function createWindow() {
  // 覚えた位置と大きさ（自動確認では使わない）。覚えた画面が無い・画面の外なら真ん中に置く
  const saved = smoke ? null : windowState.readWindowState(windowFile());
  const placed = windowState.placeWindow(saved, [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => ({ id: d.id, workArea: d.workArea })));
  const fullscreen = !!saved?.fullscreen && game.fullscreen !== false;
  const w = new BrowserWindow({
    ...(placed ? { ...placed.bounds } : { width: game.width, height: game.height, useContentSize: true }),
    resizable: !!game.resizable,
    // 作品が全画面を許さない（liminalia.json の ui.screen.fullscreen が false）なら、全画面にできないウィンドウにする
    fullscreenable: game.fullscreen !== false,
    fullscreen,
    backgroundColor: "#000000",
    title: game.title,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: false,
    },
  });
  win = w;
  fullscreenAtStart = fullscreen;
  w.once("show", () => {
    fullscreenAtStart = false;
  });
  if (placed) {
    restoredWindow = true;
    if (placed.scaled) fixAspect();
    if (saved?.maximized && game.resizable) w.maximize();
  } else fitToScreen();
  if (game.resizable) keepAspect();
  w.once("ready-to-show", () => w.show());
  // 動かしたり大きさを変えたりしたら、少し待って覚える（止まっても次の起動で同じ所に出す）
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let rememberTimer;
  const rememberLater = () => {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(rememberWindow, 500);
  };
  w.on("resize", rememberLater);
  w.on("move", rememberLater);
  w.on("maximize", rememberLater);
  w.on("unmaximize", rememberLater);
  w.on("enter-full-screen", rememberLater);
  w.on("leave-full-screen", rememberLater);
  // 最小化と戻したことをゲームの画面へ知らせる（描画を絞らない設定では、ページの visibilitychange が来ないため）
  const tellVisible = () => !w.isDestroyed() && w.webContents.send("liminalia:window-visible", w.isVisible() && !w.isMinimized());
  w.on("minimize", tellVisible);
  w.on("restore", tellVisible);
  w.on("hide", tellVisible);
  w.on("show", tellVisible);
  // 閉じる前（終了・閉じるボタン・Cmd+Q・再起動）に、ゲームにオートセーブと保存の間を渡す。済んだと答えるか、2 秒たったら、
  // 書き込みが済むのを待って（長くは待たない）閉じる
  let closing = false;
  w.on("close", (event) => {
    if (!closing) rememberWindow();
    if (closing || w.webContents.isDestroyed() || w.webContents.isCrashed()) return;
    closing = true;
    event.preventDefault();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      ipcMain.removeListener("liminalia:close-ready", ready);
      void Promise.race([writes.idle(), new Promise((r) => setTimeout(r, 3000))]).then(() => {
        if (!w.isDestroyed()) w.close();
      });
    };
    /** @param {Electron.IpcMainEvent} e */
    const ready = (e) => {
      if (e.sender === w.webContents) close();
    };
    const timer = setTimeout(close, 2000);
    ipcMain.on("liminalia:close-ready", ready);
    w.webContents.send("liminalia:before-close");
  });
  w.on("closed", () => keepAwake(false));
  // ウィンドウの題名は作品の題名のまま（ページの題名で置き換えさせない）
  w.on("page-title-updated", (event) => event.preventDefault());
  // 全画面: Alt+Enter と F11 で切り替える（Windows・Linux にはメニューが無いため。Mac はメニューの ⌃⌘F も効く）。
  // ゲームの設定画面にも切り替えがあり、変わったらゲームに知らせる（設定として覚え、次の起動でも同じにする）
  w.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if (game.fullscreen !== false && (input.key === "F11" || (input.key === "Enter" && input.alt))) {
      event.preventDefault();
      w.setFullScreen(!w.isFullScreen());
    }
  });
  const tell = () => !w.isDestroyed() && w.webContents.send("liminalia:fullscreen", w.isFullScreen());
  w.on("enter-full-screen", tell);
  w.on("leave-full-screen", tell);
  // ゲームの外へは移動させない。外部リンクは既定のブラウザで開く
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("liminalia://")) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // 画面のプロセスが落ちたら、記録を残して開き直す。1 分の間に 3 回落ちたら、開き直すのをやめて知らせる
  w.webContents.on("render-process-gone", (_event, details) => {
    recovery.writeCrashLog(logsDir(), JSON.stringify({ message: `render-process-gone: ${details.reason}`, exitCode: details.exitCode, version: app.getVersion(), gpu: !gpuOff, date: new Date().toISOString() }, null, 2));
    keepAwake(false);
    if (details.reason === "clean-exit" || w.isDestroyed()) return;
    if (renderCrashes.record()) giveUpRendering(details.reason);
    else void w.loadURL("liminalia://game/index.html");
  });
  if (smoke) watchForSmoke();
  // Steam Input のアクション（build.steam.input）を、ゲームの操作としてゲームの画面へ渡す
  if (store && store.input) store.input.start((/** @type {string} */ action, /** @type {boolean} */ pressed) => !w.isDestroyed() && w.webContents.send("liminalia:input-action", action, pressed));
  void w.loadURL("liminalia://game/index.html");
}

/**
 * タイトル画面（タイトル画面の無い作品はゲーム）が出るのを待つ。出たらその画面の名前、timeout ミリ秒たっても出なければ null。
 * @param {number} timeout
 * @returns {Promise<string | null>}
 */
function titleShown(timeout) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      const w = win;
      if (!w || w.isDestroyed()) {
        clearInterval(timer);
        resolve(null);
        return;
      }
      try {
        const mode = await w.webContents.executeJavaScript("window.__liminalia?.screen().mode ?? null");
        if (mode === "title" || mode === "game") {
          clearInterval(timer);
          resolve(mode);
          return;
        }
      } catch {
        // 読み込み中
      }
      if (Date.now() - started > timeout) {
        clearInterval(timer);
        resolve(null);
      }
    }, 500);
  });
}

/** 自動確認: タイトル画面が出たら撮って終了。出なければ失敗で終了。 */
function watchForSmoke() {
  const w = win;
  if (!w || !smoke) return;
  /** @type {string[]} */
  const errors = [];
  w.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") errors.push(`${event.level}: ${event.message}`);
  });
  void titleShown(90_000).then(async (mode) => {
    if (mode) {
      await new Promise((r) => setTimeout(r, 2500));
      const image = await w.webContents.capturePage();
      fs.writeFileSync(smoke, image.toPNG());
      for (const e of errors) console.log(e);
      console.log(`LIMINALIA_SMOKE ok: タイトル画面を ${smoke} に撮りました`);
      app.exit(0);
    } else {
      for (const e of errors) console.log(e);
      console.log("LIMINALIA_SMOKE ng: 90 秒たってもタイトル画面になりません");
      app.exit(1);
    }
  });
}

app.setName(game.title);
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  keepAwake(false);
  if (store && store.shutdown) {
    try {
      store.shutdown();
    } catch {
      // 終わるところなので続ける
    }
  }
});
app
  .whenReady()
  .then(async () => {
    // 店が遊んでよいかを確かめる（DRM で包む店の起動の確かめなど）。だめなら知らせて終了する
    if (store && store.checkLicense) {
      let ok = false;
      try {
        ok = (await store.checkLicense()) !== false;
      } catch (e) {
        console.log(`ライセンスを確認できませんでした: ${message(e)}`);
      }
      if (!ok) {
        // ゲームの画面を開く前なので、OS の言語で知らせる（店の口が licenseMessage を持てばそれ）
        const ja = app.getLocale().startsWith("ja");
        dialog.showErrorBox(game.title, store.licenseMessage || (ja ? "ライセンスを確認できませんでした。購入したストアのアプリから起動してください。" : "Couldn't verify your license. Start the game from the store app where you bought it."));
        app.quit();
        return;
      }
    }
    // 本体を入れ替えたあとの起動なら、タイトル画面が出てから、入れ替えの処理に起動できたことを知らせる（前の版を消してよい）。
    // 出なければ知らせず、入れ替えの処理が前の版へ戻す。失敗していれば記録に残す
    /** @type {appSwap.PendingCheck | null} */
    let swapped = null;
    if (app.isPackaged && !smoke) {
      try {
        swapped = appSwap.checkPending(path.join(app.getPath("userData"), "updates", "pending.json"), app.getVersion());
        if (swapped?.kind === "failed") console.log(`本体を ${swapped.to} に入れ替えられませんでした（${swapped.code}）。${swapped.from} のまま起動しています`);
      } catch (e) {
        console.log(`前の本体の入れ替えを確かめられませんでした: ${message(e)}`);
      }
    }
    packFolders = findPacks();
    serve();
    buildMenu();
    createWindow();
    if (swapped?.kind === "updated") {
      const done = swapped;
      void titleShown(appSwap.START_WAIT_SECONDS * 1000).then((mode) => {
        if (!mode) return console.log(`本体を ${done.to} に入れ替えましたが、ゲームの画面が出ません。以前のバージョンへ戻します`);
        done.confirm();
        console.log(`本体を ${done.from} から ${done.to} に入れ替えました`);
      });
    }
  })
  .catch((e) => {
    // 起動の途中で止まった（ウィンドウを出せないまま見えないプロセスが残らないように、知らせて終了する）
    mainError("startup", e);
    fatal(e instanceof Error ? e : new Error(String(e)));
  });
