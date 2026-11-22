import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * 素材とシナリオの暗号化（build.encrypt はデスクトップ版、build.browser.encrypt はブラウザ版、lim pack --encrypt はパック）。
 *
 * 形: 印 "LMEN"（4 バイト）・IV（16 バイト）・AES-256-CTR の中身。読む側は印を見て戻し、印の無いものはそのまま使う。
 * IV は鍵と、ファイルの相対パスと、中身のハッシュから決める（HMAC）。中身が同じなら書き出すたびに同じものになり、Steam や itch の
 * 差分の更新が変わったファイルだけを送る。中身が違えば IV も変わるので、同じ鍵で同じ IV を使い回さない。読む側は IV をファイルから読む。
 * - デスクトップ版: 鍵はアプリの中の game.json。main.cjs が liminalia:// で返すときに戻す
 * - ブラウザ版: 鍵は Service Worker（lm-sw.js）の中。index.html が Service Worker を入れてからエンジンを読み、
 *   Service Worker が assets/・project/・packs/ を取り寄せて戻す（WebCrypto の AES-CTR）
 * 鍵は作品ごとに、デスクトップ版は .liminalia/encrypt-key、ブラウザ版は .liminalia/encrypt-key-browser に控える
 * （ブラウザ版の鍵は公開したページから誰でも読めるので、デスクトップ版の鍵とは分ける）。
 * どちらも鍵を配るゲームの中に持つので、取り出されにくくするだけで、手間をかければ破れる（docs/distribution.md）。
 */

/** 暗号にした中身の頭の印。 */
export const ENCRYPTED_MAGIC = Buffer.from("LMEN");

export type KeyKind = "desktop" | "browser";

/** 作品の暗号の鍵（無ければ作って控える）。 */
export function encryptionKey(root: string, kind: KeyKind = "desktop"): Buffer {
  const file = join(root, ".liminalia", kind === "desktop" ? "encrypt-key" : "encrypt-key-browser");
  try {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length === 32) return key;
  } catch {
    // 無ければ作る
  }
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600 });
  return key;
}

/**
 * IV（16 バイト）。鍵から IV のための鍵を分け、ファイルの名前（相対パス）と中身の SHA-256 の HMAC の頭を使う。
 * 同じ鍵、名前、中身なら同じ IV、どれかが違えば別の IV になる。
 */
export function contentIv(data: Buffer, key: Buffer, name = ""): Buffer {
  const ivKey = createHmac("sha256", key).update("liminalia-iv-v1").digest();
  const digest = createHash("sha256").update(data).digest();
  return createHmac("sha256", ivKey).update(name).update("\0").update(digest).digest().subarray(0, 16);
}

/** 中身を暗号にする（印 4 バイト・IV 16 バイト・AES-256-CTR の中身）。name はファイルの相対パス（IV を決めるのに使う）。 */
export function encryptAsset(data: Buffer, key: Buffer, name = ""): Buffer {
  const iv = contentIv(data, key, name);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  return Buffer.concat([ENCRYPTED_MAGIC, iv, cipher.update(data), cipher.final()]);
}

/** ファイルを少しずつ読む大きさ。 */
const CHUNK = 4 * 1024 * 1024;

/** ファイルを CHUNK ずつ読んで fn に渡す（大きな動画でも、丸ごとメモリに持たない）。 */
function eachChunk(file: string, fn: (chunk: Buffer) => void): void {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let n = readSync(fd, buf, 0, CHUNK, null); n > 0; n = readSync(fd, buf, 0, CHUNK, null)) fn(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** ファイルの中身のハッシュ（少しずつ読む）。 */
export function hashFile(file: string, algorithm: "sha1" | "sha256"): Buffer {
  const hash = createHash(algorithm);
  eachChunk(file, (chunk) => hash.update(chunk));
  return hash.digest();
}

/**
 * ファイルを暗号にして to に書く（encryptAsset と同じ中身）。少しずつ読んで書くので、大きな動画でもメモリに丸ごと持たない
 * （IV に中身の SHA-256 を使うので、一度読んでハッシュを取り、もう一度読んで暗号にする）。
 */
export function encryptAssetFile(from: string, to: string, key: Buffer, name = ""): void {
  const ivKey = createHmac("sha256", key).update("liminalia-iv-v1").digest();
  const iv = createHmac("sha256", ivKey).update(name).update("\0").update(hashFile(from, "sha256")).digest().subarray(0, 16);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const fd = openSync(to, "w");
  try {
    writeSync(fd, ENCRYPTED_MAGIC);
    writeSync(fd, iv);
    eachChunk(from, (chunk) => writeSync(fd, cipher.update(chunk)));
    writeSync(fd, cipher.final());
  } finally {
    closeSync(fd);
  }
}

/** 暗号にしたもの（LMEN で始まる）を戻す。そうでなければそのまま。 */
export function decryptBuffer(data: Buffer, key: Buffer): Buffer {
  if (!isEncrypted(data)) return data;
  const decipher = createDecipheriv("aes-256-ctr", key, data.subarray(4, 20));
  return Buffer.concat([decipher.update(data.subarray(20)), decipher.final()]);
}

export function isEncrypted(data: Buffer): boolean {
  return data.length >= 20 && data.subarray(0, 4).equals(ENCRYPTED_MAGIC);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** root から見たファイルの名前（"/" 区切り）。IV を決めるのに使う。 */
export const relativeName = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/** ファイルを暗号にする（もう暗号のものは二重にしない）。root はファイルの名前（IV）を決める元のフォルダ。 */
function encryptFile(f: string, key: Buffer, root: string): void {
  const data = readFileSync(f);
  if (!isEncrypted(data)) writeFileSync(f, encryptAsset(data, key, relativeName(root, f)));
}

/**
 * root（project/ かパックのフォルダ）の中のシナリオ・データ・訳・キャスト・フローチャート（assets なら素材も）を暗号にする。
 * pack.json、素材の一覧（assets.json など）、build.json は読む側が鍵の前に読むので、そのまま。
 */
export function encryptContent(root: string, key: Buffer, assets: boolean): void {
  const dirs = ["scenario", "data", "lang", ...(assets ? ["assets"] : [])];
  const targets = [...dirs.flatMap((d) => walk(join(root, d))), join(root, "cast.json"), join(root, "flow.json")];
  for (const f of targets) if (existsSync(f)) encryptFile(f, key, root);
}

/** 書き出しの web の中の、作品の中身（project/ と、入れたパック packs/<id>/。パックは素材も）を暗号にする。 */
export function encryptProjectFiles(web: string, key: Buffer): void {
  encryptContent(join(web, "project"), key, false);
  if (existsSync(join(web, "packs"))) for (const e of readdirSync(join(web, "packs"), { withFileTypes: true })) if (e.isDirectory()) encryptContent(join(web, "packs", e.name), key, true);
}

/** ブラウザ版の Service Worker のファイル名（書き出しの一番上）。暗号化（build.browser.encrypt）とオフライン（build.browser.offline）で一つ。 */
export const SERVICE_WORKER = "lm-sw.js";

/** 書体のファイル。 */
const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;

/**
 * 書き出しの中のファイル（相対パス。区切りは /）を、Service Worker を入れたときに控えるか。控えるのはエンジン、台本、データ。
 * 素材（assets/。build.browser.offline が "all" なら別に足す）、zip、Service Worker 自身と、書体は使ったときに控える
 * （Web 書体のパッケージは unicode-range で何百もの分割ファイルになり、ブラウザは使う字の分しか読まない）。
 */
export function precacheAtInstall(rel: string): boolean {
  return rel !== SERVICE_WORKER && !rel.startsWith("assets/") && !rel.endsWith(".zip") && !FONT_FILE.test(rel);
}

/** オフラインで遊べるように控えるもの（build.browser.offline）。 */
export interface OfflineCache {
  /** 控えの名前（作品と書き出しごと。新しい書き出しが入ったら、同じ作品の古い控えを消す）。 */
  cache: string;
  /** 同じ作品の控えの名前の頭。 */
  prefix: string;
  /** 入れたときに控えるもの（ページからの相対 URL。エンジン・台本・データ。"all" なら素材も。書体は使ったときに控える）。 */
  precache: string[];
}

/**
 * ブラウザ版の Service Worker。
 * - 暗号化（key があるとき）: assets/・project/・packs/ の取り寄せを受け、LMEN で始まるものを戻して返す。戻したものは大きさの合計 128MB まで控える
 * - オフライン（offline があるとき）: 入れたときにエンジン・台本・データ（"all" なら素材も）を Cache Storage に控え、素材と書体は使ったときに控える。
 *   ページは新しいものを先に取りに行き（3 秒で諦めて控えを使う）、名前に中身の鍵の付くもの（engine/・?v= の付く素材）と project/ は控えを先に使う
 *   （控えは書き出しごとなので、遊んでいる途中に新しい版を置いても、エンジンと台本とデータは入れたときの版でそろう）。
 *   暗号にしたものは暗号のまま控え、返すときに戻す
 * - 新しい版: はじめて入れたときはすぐ使う。前の版が動いているときに新しい版を入れたら、ページが「lm-skip-waiting」を送るまで待つ
 *   （プレイヤーが「新しいバージョンがあります」から読み直したとき。それまでは前の版のページを返す）。?lm-latest の付く取り寄せ（版の確認）は通す
 * 音と動画の範囲指定（Range）には、中身から切り出して 206 で答える（控えていない素材の範囲指定は、そのまま取りに行き、裏で全体を控える）。
 */
export function serviceWorkerSource(key: Buffer | null, offline: OfflineCache | null = null): string {
  return `// Liminalia: ブラウザ版の Service Worker（lim build が作る。暗号にした素材を戻す build.browser.encrypt と、オフラインで遊ぶ build.browser.offline）
const KEY = ${key ? JSON.stringify(key.toString("base64")) : "null"};
const OFFLINE = ${offline ? JSON.stringify(offline) : "null"};
const PREFIXES = ["assets/", "project/", "packs/"];
const LIMIT = 128 * 1024 * 1024;
const kept = new Map();
let keptBytes = 0;
let keyPromise = null;
const cryptoKey = () => (keyPromise ??= crypto.subtle.importKey("raw", Uint8Array.from(atob(KEY), (c) => c.charCodeAt(0)), "AES-CTR", false, ["decrypt"]));
const scopeUrl = () => new URL(self.registration.scope);
self.addEventListener("install", (event) => {
  // はじめて入れたときはすぐ使う。前の版が動いているときは、ページが読み直すと決めるまで待つ（遊んでいる途中の版をそろえる）
  if (!self.registration.active) self.skipWaiting();
  if (OFFLINE) event.waitUntil(precache());
});
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  if (OFFLINE) for (const name of await caches.keys()) if (name.startsWith(OFFLINE.prefix) && name !== OFFLINE.cache) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener("message", (event) => {
  if (event.data === "lm-claim") event.waitUntil(self.clients.claim());
  // 「新しいバージョンがあります」から読み直す（待っている新しい版に替わる）
  if (event.data === "lm-skip-waiting") event.waitUntil(self.skipWaiting());
});
/** 入れたときに控える（取れなかったものは、使ったときに控える）。 */
async function precache() {
  const cache = await caches.open(OFFLINE.cache);
  const base = scopeUrl();
  let next = 0;
  const worker = async () => {
    while (next < OFFLINE.precache.length) {
      const url = new URL(OFFLINE.precache[next++], base).toString();
      try {
        if (await cache.match(url)) continue;
        const res = await fetch(url, { credentials: "same-origin" });
        if (res.ok) await cache.put(url, res);
      } catch {}
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const scope = scopeUrl();
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  // 新しい版の確認（project/build.json?lm-latest）は、控えを通さずに取りに行く
  if (url.searchParams.has("lm-latest")) return;
  const rel = decodeURIComponent(url.pathname.slice(scope.pathname.length));
  const encrypted = KEY !== null && PREFIXES.some((p) => rel.startsWith(p));
  if (!encrypted && !OFFLINE) return;
  event.respondWith(serve(event, request, url, rel, encrypted));
});
/**
 * 新しいものを先に取りに行くもの（ページと、名前に中身の鍵が付かないもの）。project/ は書き出しごとの控えを先に使う（エンジンとそろえる）。
 * 新しい版が待っている間は、ページも控えを先に使う（読み直しても、前の版のエンジンと台本のまま）。
 */
function fresh(request, rel, url) {
  if (rel.startsWith("project/")) return false;
  if (self.registration.waiting && (request.mode === "navigate" || rel === "" || rel.endsWith(".html"))) return false;
  return request.mode === "navigate" || rel === "" || rel.endsWith(".html") || rel.endsWith(".webmanifest") || rel === "lm-sw.js" || (!rel.startsWith("engine/") && !url.search);
}
/** 控えの鍵（ページへの移動は、引数を外した index.html）。 */
function cacheKey(request, rel, url) {
  if (request.mode === "navigate" || rel === "") return new URL("index.html", scopeUrl()).toString();
  return url.toString();
}
/** 中身（Response）。オフラインなら控えから、無ければ取りに行って控える。 */
async function raw(event, request, rel, url) {
  if (!OFFLINE) return fetch(url.toString(), { credentials: "same-origin" });
  const cache = await caches.open(OFFLINE.cache);
  const key = cacheKey(request, rel, url);
  const network = async () => {
    const res = await fetch(request.mode === "navigate" ? request : url.toString(), request.mode === "navigate" ? undefined : { credentials: "same-origin" });
    if (res.ok && res.status === 200) event.waitUntil(cache.put(key, res.clone()));
    return res;
  };
  if (fresh(request, rel, url)) {
    try {
      return await Promise.race([network(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
    } catch (e) {
      const hit = await cache.match(key);
      if (hit) return hit;
      throw e;
    }
  }
  const hit = await cache.match(key);
  if (hit) return hit;
  return network();
}
async function serve(event, request, url, rel, encrypted) {
  const range = /^bytes=(\\d*)-(\\d*)$/.exec(request.headers.get("range") || "");
  if (!encrypted) {
    // 控えていない素材の範囲指定は、そのまま取りに行き（流し読み）、裏で全体を控える
    if (range && OFFLINE) {
      const cache = await caches.open(OFFLINE.cache);
      const hit = await cache.match(url.toString());
      if (!hit) {
        event.waitUntil(fetch(url.toString(), { credentials: "same-origin" }).then((res) => (res.ok && res.status === 200 ? cache.put(url.toString(), res) : undefined)).catch(() => undefined));
        return fetch(request);
      }
      return slice(await hit.blob(), hit.headers.get("content-type") || "application/octet-stream", range);
    }
    return raw(event, request, rel, url);
  }
  const entry = await load(event, request, rel, url);
  if (entry.res) return entry.res;
  return slice(entry.body, entry.type, range);
}
/** 中身（Blob か Uint8Array）を、範囲指定があれば切り出して返す。 */
function slice(body, type, range) {
  const size = body.size ?? body.length;
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + size } });
    return new Response(body.slice(start, end + 1), { status: 206, headers: { "content-type": type, "content-range": "bytes " + start + "-" + end + "/" + size, "accept-ranges": "bytes", "content-length": String(end - start + 1) } });
  }
  return new Response(body, { headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(size) } });
}
/** 暗号にしたものを戻す（戻したものは控える）。 */
async function load(event, request, rel, url) {
  const id = url.pathname + url.search;
  const hit = kept.get(id);
  if (hit) {
    kept.delete(id);
    kept.set(id, hit);
    return hit;
  }
  const res = await raw(event, request, rel, url);
  if (!res.ok) return { res };
  const data = new Uint8Array(await res.arrayBuffer());
  let body = data;
  if (data.length >= 20 && data[0] === 0x4c && data[1] === 0x4d && data[2] === 0x45 && data[3] === 0x4e) {
    body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: data.slice(4, 20), length: 128 }, await cryptoKey(), data.subarray(20)));
  }
  const entry = { body, type: res.headers.get("content-type") || "application/octet-stream" };
  kept.set(id, entry);
  keptBytes += body.length;
  for (const [k, v] of kept) {
    if (keptBytes <= LIMIT || kept.size <= 1) break;
    kept.delete(k);
    keptBytes -= v.body.length;
  }
  return entry;
}
`;
}

/**
 * オフラインのとき（暗号化しないブラウザ版）の index.html。ページを読み終えてから Service Worker を入れる（入れられなくても遊べる。
 * file:// や https でない場所では入れない）。
 */
export function injectServiceWorkerRegister(html: string): string {
  const script = `<script>
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  addEventListener("load", function () { navigator.serviceWorker.register(${JSON.stringify(`./${SERVICE_WORKER}`)}).catch(function (e) { console.warn("Service Worker を入れられませんでした（オフラインでは遊べません）", e); }); });
}
</script>`;
  if (!html.includes("</body>")) throw new Error("index.html に </body> が見つかりません");
  return html.replace("</body>", `${script}\n</body>`);
}

/**
 * ブラウザ版の index.html の、エンジンを読む <script type="module"> を、Service Worker を入れてから読む形にする。
 * Service Worker が使えないとき（file:// や、https でない場所）は理由を出す。
 */
export function injectServiceWorkerLoader(html: string): string {
  const m = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(html);
  if (!m) throw new Error("index.html にエンジンを読む <script type=\"module\"> が見つかりません");
  const loader = `<script>
(function () {
  var src = ${JSON.stringify(m[1])};
  var started = false;
  function boot() {
    if (started) return;
    started = true;
    var s = document.createElement("script");
    s.type = "module";
    s.crossOrigin = "";
    s.src = src;
    document.head.appendChild(s);
  }
  function fail(detail) {
    var p = document.createElement("p");
    p.style.cssText = "color:#ddd;font:16px sans-serif;padding:24px;line-height:1.7";
    p.textContent = "このゲームは https のページで開いてください（Service Worker が使えません）。 / Please open this game on an https page (Service Workers are unavailable). " + (detail || "");
    document.body.appendChild(p);
  }
  if (!("serviceWorker" in navigator)) return fail("");
  var sw = navigator.serviceWorker;
  sw.addEventListener("controllerchange", boot);
  sw.register(${JSON.stringify(`./${SERVICE_WORKER}`)}).then(function () {
    if (sw.controller) return boot();
    return sw.ready.then(function (reg) {
      if (sw.controller) return boot();
      if (reg.active) reg.active.postMessage("lm-claim");
      setTimeout(function () {
        if (sw.controller || started) return;
        // 強制の再読み込み（Shift を押して）で開いたページは Service Worker を通らないので、一度だけ読み直す
        if (!sessionStorage.getItem("lm-sw-reload")) {
          sessionStorage.setItem("lm-sw-reload", "1");
          location.reload();
        } else fail("");
      }, 3000);
    });
  }).catch(function (e) { fail(String(e && e.message || e)); });
})();
</script>`;
  return html.replace(m[0], loader);
}

/** ブラウザ版の書き出し（web のフォルダ）の Service Worker から鍵を読む（lim patch が前の書き出しを戻すのに使う）。 */
export function keyFromServiceWorker(web: string): Buffer | null {
  const file = join(web, SERVICE_WORKER);
  if (!existsSync(file)) return null;
  const m = /const KEY = "([A-Za-z0-9+/=]+)";/.exec(readFileSync(file, "utf8"));
  const key = m ? Buffer.from(m[1]!, "base64") : null;
  return key && key.length === 32 ? key : null;
}

/** フォルダの中のファイルをすべて暗号にする（ブラウザ版の assets/）。 */
export function encryptFolder(dir: string, key: Buffer): void {
  for (const f of walk(dir)) encryptFile(f, key, dir);
}
