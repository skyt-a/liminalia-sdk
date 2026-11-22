// @ts-check
/**
 * アップデートの確認とパックの適用（書き出したデスクトップ版の main.cjs と、lim update-manifest が使う）。
 *
 * マニフェスト（liminalia.json の build.update.url に置く JSON）:
 * {
 *   "format": "liminalia-update", "formatVersion": 1,
 *   "app": {                                  本体の更新（任意）
 *     "version": "1.2.0", "page": "https://…", "notes": "…" か { "ja": "…", "en": "…" },
 *     "files": { "windows": { "url", "sha256", "size" }, "mac": {…}, "linux": {…} }
 *     （Mac を CPU ごとに分けて配るなら mac-arm64、mac-x64 も書ける。planUpdate に arch を渡す側（制作アプリ）だけが読む）
 *   },
 *   "packs": [                                パック（lim pack の中身を zip にしたもの。任意）
 *     { "id": "patch1", "version": "1.0.1", "requires": "1.0.0", "title": "…", "notes": …, "url", "sha256", "size" }
 *   ]
 * }
 * URL はマニフェストの場所からの相対でもよい。https だけ（確かめ用に localhost の http は受ける）。sha256 は必須。
 *
 * パックは保存先の packs/<id>/ に入れる（アプリの中の Resources/packs は署名されていて書き換えられないことがあるため）。
 * 書きかけで止まっても前のものが残るよう、別の名前で展開してから入れ替える。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/**
 * @typedef {string | Record<string, string>} Notes
 * @typedef {{ url: string, sha256: string, size?: number }} UpdateFile
 * @typedef {UpdateFile & { id: string, version: string, requires?: string, title?: string, notes?: Notes }} PackEntry
 * @typedef {{ version: string, page?: string, notes?: Notes, files?: Record<string, UpdateFile> }} AppEntry
 * @typedef {{ format: "liminalia-update", formatVersion: 1, app?: AppEntry, packs?: PackEntry[] }} UpdateManifest
 * @typedef {{ version: string, page?: string, notes?: Notes, file?: UpdateFile }} AppUpdate
 * @typedef {{ app: AppUpdate | null, packs: PackEntry[] }} UpdatePlan
 */

const FORMAT = /** @type {const} */ ("liminalia-update");
const PLATFORMS = ["windows", "mac", "linux", "mac-arm64", "mac-x64"];
const ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * 版を比べる（1.2.10 > 1.2.9。- の後ろ（1.0.0-beta）は無いものより前）。a が新しければ正。
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  /** @param {string} v */
  const split = (v) => {
    const [main = "", pre] = String(v).trim().replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true }) > 0 ? 1 : -1;
}

/**
 * 取り寄せてよい URL か（https と、確かめ用の localhost の http）。
 * @param {string} url
 */
function allowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    // URL として読めないものは許さない
    return false;
  }
}

/**
 * マニフェストの形を確かめ、URL を絶対にしたものと問題の一覧を返す。base はマニフェストの URL。
 * @param {any} json 取り寄せた JSON（形はここで確かめる）
 * @param {string} [base]
 * @returns {{ manifest: UpdateManifest | null, problems: string[] }}
 */
function validateManifest(json, base) {
  /** @type {string[]} */
  const problems = [];
  /** @param {any} v */
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  /** @param {any} v */
  const str = (v) => typeof v === "string" && v.trim() !== "";
  /** @param {any} v @param {string} where @returns {Notes | undefined} */
  const notes = (v, where) => {
    if (v === undefined) return undefined;
    if (typeof v === "string") return v;
    if (isObj(v) && Object.values(v).every((x) => typeof x === "string")) return v;
    problems.push(`${where}.notes は文字列か、言語 → 文字列で書きます`);
    return undefined;
  };
  /** @param {any} v @param {string} where @returns {string | null} */
  const url = (v, where) => {
    if (!str(v)) {
      problems.push(`${where}.url がありません`);
      return null;
    }
    let abs;
    try {
      abs = base ? new URL(v, base).toString() : new URL(v).toString();
    } catch {
      // 読めない URL は problems に入れて知らせる
      problems.push(`${where}.url が URL ではありません: ${v}`);
      return null;
    }
    if (!allowedUrl(abs)) problems.push(`${where}.url は https で書きます: ${abs}`);
    return abs;
  };
  /** @param {any} v @param {string} where @returns {UpdateFile | null} */
  const file = (v, where) => {
    if (!isObj(v)) {
      problems.push(`${where} は { url, sha256, size } で書きます`);
      return null;
    }
    const u = url(v.url, where);
    const sha256 = typeof v.sha256 === "string" ? v.sha256.toLowerCase() : "";
    if (!SHA256.test(sha256)) problems.push(`${where}.sha256 は 64 桁の 16 進数で書きます`);
    if (v.size !== undefined && !(Number.isInteger(v.size) && v.size >= 0)) problems.push(`${where}.size は 0 以上の整数で書きます`);
    return u ? { url: u, sha256, ...(Number.isInteger(v.size) ? { size: v.size } : {}) } : null;
  };
  if (!isObj(json)) return { manifest: null, problems: ["マニフェストが JSON のオブジェクトではありません"] };
  if (json.format !== FORMAT) problems.push(`format が "${FORMAT}" ではありません`);
  if (json.formatVersion !== 1) problems.push("formatVersion は 1 です");
  /** @type {UpdateManifest} */
  const out = { format: FORMAT, formatVersion: 1 };
  if (json.app !== undefined) {
    const a = json.app;
    if (!isObj(a) || !str(a.version)) problems.push("app.version がありません");
    else {
      /** @type {AppEntry} */
      const app = { version: a.version.trim() };
      if (a.page !== undefined) {
        const page = url(a.page, "app.page");
        if (page) app.page = page;
      }
      const n = notes(a.notes, "app");
      if (n !== undefined) app.notes = n;
      if (a.files !== undefined) {
        if (!isObj(a.files)) problems.push("app.files は OS（windows、mac、linux）→ ファイルで書きます");
        else {
          /** @type {Record<string, UpdateFile>} */
          const files = {};
          app.files = files;
          for (const [os, f] of Object.entries(a.files)) {
            if (!PLATFORMS.includes(os)) {
              problems.push(`app.files の ${os} は windows、mac、linux、mac-arm64、mac-x64 のどれかです`);
              continue;
            }
            const ok = file(f, `app.files.${os}`);
            if (ok) files[os] = ok;
          }
        }
      }
      if (!app.page && !app.files) problems.push("app には page（ダウンロードのページ）か files（OS ごとのファイル）を書きます");
      out.app = app;
    }
  }
  if (json.packs !== undefined) {
    if (!Array.isArray(json.packs)) problems.push("packs は配列で書きます");
    else {
      /** @type {PackEntry[]} */
      const packs = [];
      out.packs = packs;
      json.packs.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
        const where = `packs[${i}]`;
        if (!isObj(p) || !str(p.id) || !ID.test(p.id)) return void problems.push(`${where}.id は英数字、_、- で書きます`);
        if (!str(p.version)) return void problems.push(`${where}.version がありません`);
        const f = file(p, where);
        if (!f) return;
        /** @type {PackEntry} */
        const pack = { id: p.id, version: p.version.trim(), ...f };
        if (p.requires !== undefined) {
          if (!str(p.requires)) problems.push(`${where}.requires は本体のバージョンで書きます`);
          else pack.requires = p.requires.trim();
        }
        if (str(p.title)) pack.title = p.title;
        const n = notes(p.notes, where);
        if (n !== undefined) pack.notes = n;
        packs.push(pack);
      });
      const ids = packs.map((p) => `${p.id}@${p.requires ?? ""}`);
      for (const [i, id] of ids.entries()) if (ids.indexOf(id) !== i) problems.push(`packs に同じ本体のバージョン向けの ${id.split("@")[0]} が二つあります`);
    }
  }
  if (!out.app && !out.packs) problems.push("app か packs のどちらかを書きます");
  return { manifest: problems.length === 0 ? out : null, problems };
}

/**
 * 何を更新できるか。appVersion は今の本体の版、platform は windows・mac・linux、installed は入っているパック（id → 版）。
 * arch（任意）を渡すと、本体のファイルは <platform>-<arch> を先に探す。
 * パックは本体の版に合うもの（requires が無いか同じ）で、入っていないか新しいもの。
 * @param {UpdateManifest} manifest
 * @param {{ appVersion: string, platform: string, arch?: string | undefined, installed: Record<string, string> }} o
 * @returns {UpdatePlan}
 */
function planUpdate(manifest, o) {
  const file = (o.arch && manifest.app?.files?.[`${o.platform}-${o.arch}`]) || manifest.app?.files?.[o.platform];
  /** @type {AppUpdate | null} */
  const app = manifest.app && compareVersions(manifest.app.version, o.appVersion) > 0 ? { version: manifest.app.version, ...(manifest.app.page ? { page: manifest.app.page } : {}), ...(manifest.app.notes !== undefined ? { notes: manifest.app.notes } : {}), ...(file ? { file } : {}) } : null;
  // ページもこの OS のファイルも無い本体の更新は、できることが無いので知らせない
  const appUpdate = app && (app.page || app.file) ? app : null;
  const packs = (manifest.packs ?? []).filter((p) => {
    const installed = o.installed[p.id];
    return (p.requires === undefined || compareVersions(p.requires, o.appVersion) === 0) && (installed === undefined || compareVersions(p.version, installed) > 0);
  });
  return { app: appUpdate, packs };
}

/**
 * 言語に合う説明（文字列ならそのまま。無ければ英語、それも無ければ最初のもの）。
 * @param {Notes | undefined | null} notes
 * @param {string} language
 * @returns {string}
 */
function pickNotes(notes, language) {
  if (notes === undefined || notes === null) return "";
  if (typeof notes === "string") return notes;
  const lang = String(language || "").toLowerCase();
  return notes[lang] ?? notes[lang.split("-")[0] ?? ""] ?? notes.en ?? Object.values(notes)[0] ?? "";
}

/**
 * ファイルの sha256（16 進数）。
 * @param {string} file
 */
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * URL を dest へ取り寄せ、sha256 と大きさを確かめる（違えば消して投げる）。fetchImpl は fetch と同じ形（Electron では net.fetch）。
 * 書きかけは dest.part に書き、確かめてから名前を変える。onProgress(取り寄せたバイト数, 全体)。
 * @param {(url: string) => Promise<Response>} fetchImpl
 * @param {string} url
 * @param {string} dest
 * @param {{ sha256: string, size?: number | undefined }} expect
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
async function download(fetchImpl, url, dest, expect, onProgress) {
  if (!allowedUrl(url)) throw new Error(`https ではない URL からはダウンロードしません: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`${url} をダウンロードできません（${res.status}）`);
  const total = Number(res.headers.get("content-length")) || expect.size || 0;
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(part, "w");
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      got += chunk.length;
      if (expect.size !== undefined && got > expect.size) {
        // ダウンロードをやめるのが先。止められなくても下で投げる
        await reader.cancel().catch(() => undefined);
        throw new Error(`${url} が指定された大きさ（${expect.size} バイト）より大きいため、ダウンロードを中止しました`);
      }
      hash.update(chunk);
      fs.writeSync(fd, chunk);
      if (onProgress) onProgress(got, total);
    }
    fs.closeSync(fd);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
      // 閉じてある
    }
    fs.rmSync(part, { force: true });
    throw e;
  }
  const digest = hash.digest("hex");
  if (digest !== expect.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${path.basename(dest)} の sha256 がマニフェストと一致しません（${digest}）。ダウンロードしたファイルは使用しません`);
  }
  if (expect.size !== undefined && got !== expect.size) {
    fs.rmSync(part, { force: true });
    throw new Error(`${path.basename(dest)} の大きさがマニフェストと合いません（${got} バイト）`);
  }
  fs.renameSync(part, dest);
  return dest;
}

// ---- zip ----

/**
 * zip の中のファイルの一覧（中央ディレクトリ）。zip64 は扱わない。
 * @param {number} fd
 * @param {number} size
 */
function zipEntries(fd, size) {
  const tailSize = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailSize);
  fs.readSync(fd, tail, 0, tailSize, size - tailSize);
  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip ではありません（終わりの印が見つかりません）");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("4 GB を超える zip（zip64）は扱えません");
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("zip の中央ディレクトリが壊れています");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressed = cd.readUInt32LE(p + 20);
    const uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttr = cd.readUInt32LE(p + 38);
    const offset = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    // UTF-8 の印（11 ビット目）が無くても、yazl や今の道具は UTF-8 で書く
    const name = nameBuf.toString("utf8");
    entries.push({ name, flags, method, crc, compressed, uncompressed, offset, symlink: ((externalAttr >>> 16) & 0o170000) === 0o120000 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * zip の中の名前を、展開先の中の安全な相対パスにする（外へ出る名前・絶対パスは null）。
 * @param {string} name
 */
function safeEntryPath(name) {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.some((x) => x === "..")) return null;
  return parts.join("/");
}

/**
 * zip の中の名前の一覧（リンクは symlink が true）。展開の道具を別に使うときに、先に名前を確かめるためのもの。
 * @param {string} zipPath
 */
function listZip(zipPath) {
  const fd = fs.openSync(zipPath, "r");
  try {
    return zipEntries(fd, fs.fstatSync(fd).size).map((e) => ({ name: e.name, symlink: e.symlink }));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * zip を dir へ展開する（ファイルとフォルダだけ。リンクと外へ出る名前は止める）。展開したファイルの数を返す。
 * @param {string} zipPath
 * @param {string} dir
 */
function extractZip(zipPath, dir) {
  const fd = fs.openSync(zipPath, "r");
  let files = 0;
  try {
    const entries = zipEntries(fd, fs.fstatSync(fd).size);
    for (const e of entries) {
      const rel = safeEntryPath(e.name);
      if (rel === null) throw new Error(`zip に展開先の外を指す名前があります: ${e.name}`);
      if (rel === "" || rel.startsWith("__MACOSX/")) continue;
      if (e.symlink) throw new Error(`zip にリンクがあります: ${e.name}`);
      const target = path.join(dir, ...rel.split("/"));
      if (e.name.endsWith("/")) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      if (e.flags & 0x1) throw new Error(`暗号化された zip は扱えません: ${e.name}`);
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, e.offset);
      if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip が壊れています: ${e.name}`);
      const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const raw = Buffer.alloc(e.compressed);
      fs.readSync(fd, raw, 0, e.compressed, start);
      let data;
      if (e.method === 0) data = raw;
      else if (e.method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`扱えない圧縮の方式（${e.method}）です: ${e.name}`);
      if (data.length !== e.uncompressed) throw new Error(`zip の中身の大きさが合いません: ${e.name}`);
      if (typeof zlib.crc32 === "function" && zlib.crc32(data) >>> 0 !== e.crc >>> 0) throw new Error(`zip の中身が壊れています（CRC）: ${e.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      files++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return files;
}

/**
 * パックの zip を packsDir/<id>/ に入れる。展開したものの直下（か、ただ一つのフォルダの中）に pack.json があり、
 * その id が manifestId と同じことを確かめる。前のものは入れ終えてから消す。入れた pack.json を返す。
 * @param {string} zipPath
 * @param {string} packsDir
 * @param {string} manifestId
 */
function installPack(zipPath, packsDir, manifestId) {
  if (!ID.test(manifestId)) throw new Error(`パックの id が正しくありません: ${manifestId}`);
  fs.mkdirSync(packsDir, { recursive: true });
  const staging = path.join(packsDir, `.${manifestId}.new`);
  const old = path.join(packsDir, `.${manifestId}.old`);
  const dest = path.join(packsDir, manifestId);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  try {
    extractZip(zipPath, staging);
    let root = staging;
    if (!fs.existsSync(path.join(root, "pack.json"))) {
      const dirs = fs.readdirSync(root).filter((d) => !d.startsWith(".") && fs.statSync(path.join(root, d)).isDirectory());
      const only = dirs.length === 1 ? dirs[0] : undefined;
      if (only !== undefined && fs.existsSync(path.join(root, only, "pack.json"))) root = path.join(root, only);
      else throw new Error("パックの zip に pack.json がありません");
    }
    const pack = JSON.parse(fs.readFileSync(path.join(root, "pack.json"), "utf8"));
    if (pack.id !== manifestId) throw new Error(`パックの id（${pack.id}）がマニフェスト（${manifestId}）と違います`);
    const had = fs.existsSync(dest);
    if (had) fs.renameSync(dest, old);
    try {
      fs.renameSync(root, dest);
    } catch (e) {
      // 入れ替えられなければ前のものに戻す
      if (had) fs.renameSync(old, dest);
      throw e;
    }
    fs.rmSync(old, { recursive: true, force: true });
    return pack;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ---- 署名（Ed25519） ----

/**
 * マニフェストの署名。署名するのは signature を除いたマニフェストを、鍵を名前の順に並べた JSON（canonicalJson）にしたもの。
 * 署名はマニフェストの中の "signature": { "alg": "ed25519", "value": "<base64>" } に置く（読む側は signature のほかを確かめる）。
 * 公開鍵は Ed25519 の 32 バイトを base64 にしたもの（liminalia.json の build.update.publicKey に書く。配列なら、どれかで通ればよい）。
 * 秘密鍵は PKCS#8 の PEM（lim update-key が作る）。
 */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/**
 * 鍵を名前の順に並べた JSON（署名する文字列。同じ中身なら書き方によらず同じになる）。
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 公開鍵（base64 の 32 バイト）を読む。形が違えば投げる。
 * @param {string} text
 */
function publicKeyFrom(text) {
  const raw = Buffer.from(String(text).trim(), "base64");
  if (raw.length !== 32) throw new Error(`公開鍵は Ed25519 の 32 バイトを base64 で書きます（${raw.length} バイトでした）`);
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
}

/** 新しい鍵の組（秘密鍵は PKCS#8 の PEM、公開鍵は base64 の 32 バイト）。 */
function generateSigningKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: der.subarray(der.length - 32).toString("base64") };
}

/**
 * 秘密鍵（PEM）の公開鍵（base64）。
 * @param {string} privateKeyPem
 */
function publicKeyOf(privateKeyPem) {
  const der = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
}

/**
 * マニフェストに署名したもの（前の signature は除いて署名し直す）。
 * @template {object} T
 * @param {T & { signature?: unknown }} manifest
 * @param {string} privateKeyPem
 * @returns {Omit<T, "signature"> & { signature: { alg: "ed25519", value: string } }}
 */
function signManifest(manifest, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("署名の鍵は Ed25519 の秘密鍵（PEM）です");
  const { signature: _, ...body } = manifest;
  const value = crypto.sign(null, Buffer.from(canonicalJson(body)), key).toString("base64");
  return { ...body, signature: { alg: /** @type {const} */ ("ed25519"), value } };
}

/**
 * 取り寄せたマニフェストの署名を確かめる。publicKeys が空なら確かめない（ok）。
 * 署名が無い・形が違う・どの公開鍵でも通らないなら、理由を返す。
 * @param {any} json 取り寄せた JSON
 * @param {string | string[] | undefined | null} publicKeys
 * @returns {{ ok: boolean, problem: string | null }}
 */
function verifyManifestSignature(json, publicKeys) {
  const keys = (Array.isArray(publicKeys) ? publicKeys : publicKeys ? [publicKeys] : []).filter(Boolean);
  if (keys.length === 0) return { ok: true, problem: null };
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, problem: "マニフェストが JSON のオブジェクトではありません" };
  const sig = json.signature;
  if (!sig || typeof sig !== "object" || sig.alg !== "ed25519" || typeof sig.value !== "string") return { ok: false, problem: "マニフェストに署名（signature）がありません" };
  const { signature: _, ...body } = json;
  const data = Buffer.from(canonicalJson(body));
  const value = Buffer.from(sig.value, "base64");
  for (const k of keys) {
    try {
      if (crypto.verify(null, data, publicKeyFrom(k), value)) return { ok: true, problem: null };
    } catch {
      // 読めない公開鍵は次へ
    }
  }
  return { ok: false, problem: "マニフェストの署名が、ゲームに入れた公開鍵と合いません（書き換えられたか、別の鍵で署名されています）" };
}

module.exports = { FORMAT, canonicalJson, publicKeyFrom, generateSigningKey, publicKeyOf, signManifest, verifyManifestSignature, compareVersions, allowedUrl, validateManifest, planUpdate, pickNotes, sha256File, download, listZip, extractZip, safeEntryPath, installPack };
