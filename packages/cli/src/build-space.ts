/**
 * 書き出しに要る空きの見込み（lim build が組み立てる前に確かめる）。素材を写す分だけでなく、デスクトップ版の Electron の本体、
 * 素材を一つにまとめた assets.asar（既定）、暗号化した素材の写し、配る形（zip、dmg、tar.gz、インストーラー）の分も数える。
 * 素材は同じディスクの中なら複製（clone.ts）で空きをほとんど使わないが、asar、暗号化、配る形は中身を書くので必ず数える。
 */

const MB = 1024 * 1024;

/**
 * Electron の本体の大きさ（書き出したアプリから素材を除いたもの。Electron 45 で、言語のファイルを作品の言語と英語の分にしたあとに測り、
 * 少し多めに丸めた。Windows の x64 は 312 MiB、Mac の arm64 は 245 MiB ほど）。
 */
export const ELECTRON_BYTES = { mac: 260 * MB, windows: 330 * MB, linux: 300 * MB } as const;
/** エンジン、シナリオ、データ（素材の外）の分のゆとり。 */
export const ENGINE_BYTES = 16 * MB;
/** スマホ版の組み立ての道具が作業の場所に置くもの（Gradle、Xcode の中間のファイル）のゆとり。 */
const MOBILE_WORK_BYTES = 512 * MB;
/** 配る形（zip、dmg、tar.gz、インストーラー）に縮めたときの Electron の本体の割合（Windows の zip で 0.46。素材はほとんど縮まないので、そのまま数える）。 */
const ARCHIVE_RATIO = 0.5;

export interface BuildSpaceInput {
  targets: readonly string[];
  /** 書き出しに入れる素材の大きさの合計（バイト）。 */
  assets: number;
  /** 素材を書き出し先のディスクへ写すと中身を写すか（複製できない）。 */
  copyToOut: boolean;
  /** 素材を作業の場所（一時フォルダ）へ写すと中身を写すか。 */
  copyToWork: boolean;
  /** 作業の場所が書き出し先と同じディスクか（組み立てたアプリは名前を変えるだけで書き出し先へ動く）。 */
  sameDisk: boolean;
  /** デスクトップ版の素材を assets.asar にする（build.asar、既定 true）。 */
  asar: boolean;
  /** デスクトップ版の素材を暗号にする（build.encrypt）。 */
  encrypt: boolean;
  /** ブラウザ版の素材を暗号にする（build.browser.encrypt）。 */
  browserEncrypt: boolean;
  browserZip: boolean;
  /** Windows 版の zip と Linux 版の tar.gz。 */
  zip: boolean;
  macZip: boolean;
  macDmg: boolean;
  /** Windows のインストーラー。 */
  installer: boolean;
  /** Mac 版を universal（Intel と Apple Silicon の両方）で書き出す。 */
  macUniversal: boolean;
}

/** 見込み。out は書き出し先のディスクに残るもの、work は作業の場所に一時に置くもの（同じディスクなら足して比べる）。 */
export interface BuildSpaceEstimate {
  out: number;
  work: number;
}

export function estimateBuildSpace(i: BuildSpaceInput): BuildSpaceEstimate {
  let out = 0;
  let work = 0;
  /** デスクトップ版のうち、作業の場所でいちばん大きくなるもの（アプリを組み立ててから書き出し先へ動かす）。 */
  let peak = 0;
  const desktop = i.targets.filter((t) => t === "mac" || t === "windows" || t === "linux");
  const packed = i.asar || i.encrypt;
  if (desktop.length > 0) {
    // 素材を一つのフォルダに集めたもの（asar と暗号化の元）と、暗号にした写し。書き出しの終わりまで作業の場所に残る
    if (packed && i.copyToWork) work += i.assets;
    if (i.encrypt) work += i.assets;
  }
  for (const t of i.targets) {
    if (t === "browser") {
      const assets = i.browserEncrypt || i.copyToOut ? i.assets : 0;
      out += ENGINE_BYTES + assets + (i.browserZip ? ENGINE_BYTES + i.assets : 0);
      continue;
    }
    if (t === "android" || t === "ios") {
      out += ENGINE_BYTES + i.assets;
      work += ENGINE_BYTES + i.assets + MOBILE_WORK_BYTES;
      continue;
    }
    const electron = t === "mac" ? ELECTRON_BYTES.mac * (i.macUniversal ? 2 : 1) : t === "windows" ? ELECTRON_BYTES.windows : ELECTRON_BYTES.linux;
    // アプリの中の素材: asar か暗号化なら中身を書く。そうでなければ作業の場所へ写し（複製できれば 0）、書き出し先へ動かす
    const inApp = packed ? i.assets : i.sameDisk ? (i.copyToWork ? i.assets : 0) : i.assets;
    const app = ENGINE_BYTES + electron + inApp;
    const archive = ENGINE_BYTES + electron * ARCHIVE_RATIO + i.assets;
    const archives = (t === "mac" ? (i.macZip ? 1 : 0) + (i.macDmg ? 1 : 0) : t === "windows" ? (i.zip ? 1 : 0) + (i.installer ? 1 : 0) : i.zip ? 1 : 0) * archive;
    out += app + archives;
    // 作業の場所: 組み立てたアプリ（別のディスクなら、書き出し先へ写してから消す）と、dmg を作るときのアプリの写し
    peak = Math.max(peak, (i.sameDisk ? 0 : app) + (t === "mac" && i.macDmg ? app : 0));
  }
  return { out: Math.round(out), work: Math.round(work + peak) };
}
