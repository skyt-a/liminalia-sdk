// @ts-check
/**
 * 書き出したゲームの本体の入れ替え（Mac と Linux。Windows はインストーラーに任せる）。main.cjs が使い、テストもこのファイルを読む。
 * 制作アプリの本体の更新と同じ流れ:
 *   取り寄せた zip（Mac）か tar.gz（Linux）をアプリの隣に展開し、同じアプリの同じ版であることを確かめ（Mac は署名も）、
 *   ゲームを終えてから小さな sh の処理が入れ替える。処理は前の版を消さずに、新しい版が起動できた目印（started）を待ち、
 *   来れば前の版を消す。来なければ新しい版を止めて前の版へ戻して起動する。新しい版は、タイトル画面（タイトル画面の無い作品は
 *   ゲーム）が出てから目印を置く（起動してもゲームの画面が出なければ、前の版へ戻す）。
 * Linux はゲームのフォルダを丸ごと入れ替えるので、前のフォルダにあって新しいフォルダに無いもの（実行ファイルの横のセーブ savedata、
 * 遊ぶ人が置いたパック resources/packs など）を新しいフォルダへ移す（前の版へ戻すときは戻す）。
 * 処理の文言は英数字だけにする。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 新しい版の目印を待つ秒数（タイトル画面が出るまで。起動の演出や遅い機械も見込む）。 */
const START_WAIT_SECONDS = 120;

/**
 * @typedef {{ target: string, parent: string, exe: string }} AppLocation
 * @typedef {{ target: string, exe: string, staging: string, incoming: string | null, backup: string, work: string, result: string, started: string }} SwapPlan
 */

/**
 * 入れ替えるもの。Mac は .app、Linux は実行ファイルのフォルダ。Windows とパッケージにしていないときは null。
 * @param {string} execPath
 * @param {string} platform
 * @returns {AppLocation | null}
 */
function appLocation(execPath, platform) {
  if (platform === "darwin") {
    const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
    const app = m?.[1];
    return app ? { target: app, parent: path.posix.dirname(app), exe: path.posix.basename(execPath) } : null;
  }
  if (platform === "linux") {
    const target = path.posix.dirname(execPath);
    return { target, parent: path.posix.dirname(target), exe: path.posix.basename(execPath) };
  }
  return null;
}

/**
 * 本体の更新のファイルを、この OS で入れ替えに使えるか（Mac は zip、Linux は tar.gz）。
 * @param {string} name
 * @param {string} platform
 */
function swappableArchive(name, platform) {
  if (platform === "darwin") return /\.zip$/i.test(name);
  if (platform === "linux") return /\.(tar\.gz|tgz)$/i.test(name);
  return false;
}

/** @param {string} dir */
function canWrite(dir) {
  const probe = path.join(dir, `.liminalia-write-check-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    // 書けない場所なら入れ替えない（呼ぶ側がダウンロード先を示す）
    return false;
  }
}

/**
 * 入れ替えられる場所か（書けない場所、Gatekeeper が移して動かしているとき（App Translocation）は入れ替えない）。
 * @param {Pick<AppLocation, "target" | "parent"> | null} loc
 */
function canReplace(loc) {
  if (!loc || loc.target.includes("/AppTranslocation/")) return false;
  return canWrite(loc.parent) && canWrite(loc.target);
}

/**
 * 入れ替えに使う場所。展開と前の版はアプリの隣（同じボリュームなので名前の変更で入れ替わる）、処理の記録は一時の場所。
 * @param {AppLocation} loc
 * @param {string} id
 * @returns {SwapPlan}
 */
function swapPlan(loc, id) {
  const name = path.basename(loc.target);
  const work = path.join(os.tmpdir(), `liminalia-update-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`);
  return {
    target: loc.target,
    exe: loc.exe,
    staging: path.join(loc.parent, `.${name}.update`),
    incoming: null,
    backup: path.join(loc.parent, name.endsWith(".app") ? `.${name.slice(0, -4)}.old.app` : `.${name}.old`),
    work,
    result: path.join(work, "result.json"),
    started: path.join(work, "started"),
  };
}

/**
 * Mac の入れ替え。引数: <pid> <target> <incoming> <backup> <result> <started> <待つ秒数>
 * 終わるのを待ち（1 分で諦める）、前のアプリをよけて新しいアプリを置き、開く。新しいアプリが目印を置けば前のアプリを消し、
 * 置かなければ新しいアプリを止めて前のアプリへ戻して開く。結果は result に書く（次に起動したアプリが読む）。
 */
const MAC_SWAP_SCRIPT = `#!/bin/sh
pid=$1; target=$2; incoming=$3; backup=$4; result=$5; started=$6; waitfor=$7
report() { printf '{"ok":%s,"code":"%s"}\\n' "$1" "$2" > "$result.tmp" && mv -f "$result.tmp" "$result"; }
stop_new() {
  ps -axo pid=,command= | while read -r p c; do
    case "$c" in "$target"/Contents/*) kill "-$1" "$p" 2>/dev/null ;; esac
  done
}
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 240 ]; then report false timeout; exit 1; fi
  sleep 0.25
done
if ! mv "$target" "$backup"; then report false backup; open -n "$target"; exit 1; fi
if ! mv "$incoming" "$target"; then
  rm -rf "$target"
  if mv "$backup" "$target"; then report false replace; open -n "$target"; else report false restore; open -n "$backup"; fi
  exit 1
fi
if ! open -n "$target"; then
  rm -rf "$target"; mv "$backup" "$target"; report false launch; open -n "$target"; exit 1
fi
i=0
while [ ! -e "$started" ]; do
  i=$((i + 1))
  if [ "$i" -gt "$((waitfor * 4))" ]; then
    stop_new TERM; sleep 2; stop_new KILL
    rm -rf "$target"
    if mv "$backup" "$target"; then report false no-start; open -n "$target"; else report false restore; open -n "$backup"; fi
    exit 1
  fi
  sleep 0.25
done
rm -rf "$backup"
report true done
`;

/**
 * Linux の入れ替え。引数: <pid> <target> <incoming> <backup> <result> <started> <待つ秒数> <実行ファイルの名前> [起動の引数…]
 * Mac と同じ順で、前のフォルダにだけあるもの（savedata など）を新しいフォルダへ移し（resources/packs も）、移したものの名前を
 * <result>.carried に控える。前の版へ戻すときは、移したものを前のフォルダへ戻してから入れ替える。
 * 起動の引数は、今のゲームを起動したときのもの（sandbox を使えない環境で付けた --no-sandbox など）で、起動し直すときにそのまま渡す。
 */
const LINUX_SWAP_SCRIPT = `#!/bin/sh
pid=$1; target=$2; incoming=$3; backup=$4; result=$5; started=$6; waitfor=$7; exe=$8
shift 8
carried="$result.carried"
report() { printf '{"ok":%s,"code":"%s"}\\n' "$1" "$2" > "$result.tmp" && mv -f "$result.tmp" "$result"; }
launch() { dir=$1; shift; (cd "$dir" && nohup "./$exe" "$@" >/dev/null 2>&1 &); }
carry_back() {
  if [ -f "$carried" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] && [ -e "$target/$name" ] && mv "$target/$name" "$backup/$name"
    done < "$carried"
  fi
}
stop_new() {
  ps -eo pid=,args= | while read -r p c; do
    case "$c" in "$target"/*) kill "-$1" "$p" 2>/dev/null ;; esac
  done
}
: > "$carried"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 240 ]; then report false timeout; exit 1; fi
  sleep 0.25
done
if ! mv "$target" "$backup"; then report false backup; launch "$target" "$@"; exit 1; fi
if ! mv "$incoming" "$target"; then
  rm -rf "$target"
  if mv "$backup" "$target"; then report false replace; launch "$target" "$@"; else report false restore; launch "$backup" "$@"; fi
  exit 1
fi
for entry in "$backup"/* "$backup"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  if [ ! -e "$target/$name" ]; then mv "$entry" "$target/$name" && printf '%s\\n' "$name" >> "$carried"; fi
done
if [ -d "$backup/resources/packs" ] && [ ! -e "$target/resources/packs" ]; then
  mv "$backup/resources/packs" "$target/resources/packs" && printf '%s\\n' "resources/packs" >> "$carried"
fi
launch "$target" "$@"
i=0
while [ ! -e "$started" ]; do
  i=$((i + 1))
  if [ "$i" -gt "$((waitfor * 4))" ]; then
    stop_new TERM; sleep 2; stop_new KILL
    carry_back
    rm -rf "$target"
    if mv "$backup" "$target"; then report false no-start; launch "$target" "$@"; else report false restore; launch "$backup" "$@"; fi
    exit 1
  fi
  sleep 0.25
done
rm -rf "$backup"
report true done
`;

const execFileAsync = require("node:util").promisify(require("node:child_process").execFile);

/**
 * 別のプロセスを動かし、出力を返す（失敗すれば投げる。投げたものも stdout と stderr を持つ）。
 * @param {string} file
 * @param {string[]} args
 * @param {{ maxBuffer?: number }} [o]
 */
async function run(file, args, o = {}) {
  const r = await execFileAsync(file, args, { ...o, encoding: "utf8" });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

/**
 * 投げたもの（execFile の失敗など）の文字の欄。
 * @param {unknown} e
 * @param {string} key
 */
function field(e, key) {
  const v = e && typeof e === "object" ? /** @type {Record<string, unknown>} */ (e)[key] : undefined;
  return v === undefined || v === null ? "" : String(v);
}

/**
 * @param {string} app
 * @param {string} key
 */
async function plistValue(app, key) {
  return (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents/Info.plist")])).stdout.trim();
}

/**
 * codesign -dv の TeamIdentifier（アドホック署名は null。codesign -dv は標準エラーに書く）。
 * @param {string} app
 */
async function teamOf(app) {
  let out = "";
  try {
    const r = await run("/usr/bin/codesign", ["-dv", app]);
    out = `${r.stdout}${r.stderr}`;
  } catch (e) {
    out = `${field(e, "stdout")}${field(e, "stderr")}`;
  }
  const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
  return team && team !== "not set" ? team : null;
}

/**
 * 取り寄せたものを展開し、同じアプリの同じ版であることを確かめて、新しいもの（incoming）の場所を plan に入れる。違えば投げる。
 * check.version は更新の情報の版、check.bundleId（Mac）は今のアプリの ID、check.name（Linux）は今のゲームの package.json の name。
 * 展開は別のプロセスで行う（大きなゲームでも、ゲームの画面を止めない）。
 * @param {string} archive
 * @param {SwapPlan} plan
 * @param {string} platform
 * @param {{ version: string, bundleId?: string | undefined, name?: string | undefined }} check
 */
async function prepare(archive, plan, platform, check) {
  fs.rmSync(plan.staging, { recursive: true, force: true });
  fs.rmSync(`${plan.staging}.dir`, { recursive: true, force: true });
  fs.mkdirSync(plan.staging, { recursive: true });
  const update = require("./update.cjs");
  if (platform === "darwin") {
    const bad = update.listZip(archive).filter((e) => update.safeEntryPath(e.name) === null);
    if (bad[0]) throw new Error(`zip に展開先の外を指す名前があります: ${bad[0].name}`);
    await run("/usr/bin/ditto", ["-x", "-k", "--sequesterRsrc", archive, plan.staging]);
    const apps = fs.readdirSync(plan.staging).filter((n) => n.endsWith(".app"));
    if (apps.length !== 1 || !apps[0]) throw new Error("zip の中にアプリ（.app）がありません");
    const incoming = path.join(plan.staging, apps[0]);
    const id = await plistValue(incoming, "CFBundleIdentifier");
    if (id !== check.bundleId) throw new Error(`zip の中のアプリが違います（${id}）`);
    const version = await plistValue(incoming, "CFBundleShortVersionString");
    if (version !== check.version) throw new Error(`zip の中のアプリのバージョン（${version}）が更新情報（${check.version}）と一致しません`);
    try {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", incoming]);
    } catch (e) {
      throw new Error(`新しいアプリの署名を確かめられません\n${field(e, "stderr") || String(e)}`);
    }
    const now = await teamOf(plan.target);
    const next = await teamOf(incoming);
    if (now && now !== next) throw new Error(`新しいアプリの署名（${next || "署名者なし"}）が今のアプリ（${now}）と違います`);
    plan.incoming = incoming;
    return plan;
  }
  if (platform === "linux") {
    // 先に名前を確かめてから展開する（外を指す名前は受けない）
    const names = (await run("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 })).stdout.split("\n").filter(Boolean);
    const bad = names.filter((n) => update.safeEntryPath(n) === null);
    if (bad.length > 0) throw new Error(`tar.gz に展開先の外を指す名前があります: ${bad[0]}`);
    await run("tar", ["-xzf", archive, "-C", plan.staging, "--no-same-owner"]);
    const top = fs.readdirSync(plan.staging).filter((n) => !n.startsWith("."));
    const only = top.length === 1 ? top[0] : undefined;
    const nested = only !== undefined && fs.statSync(path.join(plan.staging, only)).isDirectory();
    const incoming = nested && only !== undefined ? path.join(plan.staging, only) : plan.staging;
    if (!fs.existsSync(path.join(incoming, plan.exe))) throw new Error(`tar.gz の中に ${plan.exe} がありません`);
    const pkg = readAppPackage(incoming);
    if (check.name && pkg.name !== check.name) throw new Error(`tar.gz の中のゲームが違います（${pkg.name}）`);
    if (pkg.version !== check.version) throw new Error(`tar.gz の中のゲームのバージョン（${pkg.version}）が更新情報（${check.version}）と一致しません`);
    if (!nested) {
      // 直下に展開されたもの: 隣の名前へ移して、それを入れ替える
      fs.renameSync(plan.staging, `${plan.staging}.dir`);
      plan.incoming = `${plan.staging}.dir`;
    } else plan.incoming = incoming;
    return plan;
  }
  throw new Error(`${platform} では本体を入れ替えられません`);
}

/**
 * Linux 版の resources/app.asar（か resources/app）の package.json。
 * @param {string} folder
 * @returns {{ name?: string, version?: string }}
 */
function readAppPackage(folder) {
  for (const p of [path.join(folder, "resources", "app.asar", "package.json"), path.join(folder, "resources", "app", "package.json")]) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      // 次へ
    }
  }
  throw new Error("新しいゲームの package.json を読めません");
}

/**
 * 入れ替えの処理を、ゲームから切り離して動かす（ゲームが終わるのを待って入れ替える）。launchArgs は Linux で新しい版を起動するときの引数
 * （今のゲームを起動したときのもの）。
 * @param {SwapPlan} plan
 * @param {string} platform
 * @param {number} pid
 * @param {number} [waitSeconds]
 * @param {readonly string[]} [launchArgs]
 */
function launchSwap(plan, platform, pid, waitSeconds = START_WAIT_SECONDS, launchArgs = []) {
  if (!plan.incoming) throw new Error("入れ替える新しいバージョンがありません（先に prepare を呼びます）");
  fs.mkdirSync(plan.work, { recursive: true });
  fs.rmSync(plan.result, { force: true });
  fs.rmSync(plan.started, { force: true });
  const script = path.join(plan.work, "swap.sh");
  fs.writeFileSync(script, platform === "darwin" ? MAC_SWAP_SCRIPT : LINUX_SWAP_SCRIPT);
  const args = [script, String(pid), plan.target, plan.incoming, plan.backup, plan.result, plan.started, String(waitSeconds), ...(platform === "darwin" ? [] : [plan.exe, ...launchArgs])];
  const out = fs.openSync(path.join(plan.work, "swap.log"), "w");
  try {
    const child = spawn("/bin/sh", args, { detached: true, stdio: ["ignore", out, out], cwd: plan.work });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  return args;
}

/**
 * @typedef {{ from: string, to: string, started: string, result: string, staging?: string }} Pending
 * @typedef {{ kind: "updated", from: string, to: string, confirm(): void } | { kind: "failed", code: string, from: string, to: string }} PendingCheck
 */

/**
 * 起動したときに、前の入れ替えを確かめる。pending は入れ替えを頼む前に残した控え（{ from, to, started, result, staging }）。
 * 今の版が to なら、起動できた目印を置く confirm を返す（ゲームの画面が出てから呼ぶ。入れ替えの処理が前の版を消す。呼ばずに止まれば前の版へ戻る）。
 * そうでなければ失敗の理由（result の code）を返し、控えを片づける。控えが無ければ null。
 * @param {string} pendingFile
 * @param {string} version
 * @returns {PendingCheck | null}
 */
function checkPending(pendingFile, version) {
  /** @type {Pending} */
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  } catch {
    // 入れ替えの控えが読めなければ、入れ替えは無かったものとする
    return null;
  }
  if (version === pending.to) {
    let done = false;
    return {
      kind: "updated",
      from: pending.from,
      to: pending.to,
      confirm() {
        if (done) return;
        done = true;
        try {
          fs.mkdirSync(path.dirname(pending.started), { recursive: true });
          fs.writeFileSync(pending.started, version);
        } catch {
          // 目印を置けなければ、処理は前の版へ戻す
        }
        fs.rmSync(pendingFile, { force: true });
        if (pending.staging) {
          fs.rmSync(pending.staging, { recursive: true, force: true });
          fs.rmSync(`${pending.staging}.dir`, { recursive: true, force: true });
        }
      },
    };
  }
  let code = "unknown";
  try {
    code = JSON.parse(fs.readFileSync(pending.result, "utf8")).code || code;
  } catch {
    // 結果を書く前に止まった（まだ動いているかもしれないので、控えは残さない）
  }
  fs.rmSync(pendingFile, { force: true });
  if (pending.staging) fs.rmSync(pending.staging, { recursive: true, force: true });
  return { kind: "failed", code, from: pending.from, to: pending.to };
}

/**
 * 起動したときに、前の入れ替えを確かめて片づける（checkPending の、すぐに目印を置くもの）。
 * @param {string} pendingFile
 * @param {string} version
 */
function settle(pendingFile, version) {
  const r = checkPending(pendingFile, version);
  if (r?.kind !== "updated") return r;
  r.confirm();
  return { kind: r.kind, from: r.from, to: r.to };
}

module.exports = { START_WAIT_SECONDS, MAC_SWAP_SCRIPT, LINUX_SWAP_SCRIPT, appLocation, swappableArchive, canReplace, swapPlan, prepare, readAppPackage, launchSwap, checkPending, settle };
