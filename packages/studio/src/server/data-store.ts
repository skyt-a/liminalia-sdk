import { managedPath } from "./managed-path.ts";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { MEDIA_EXTENSIONS } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import type { AssetUploadResult, DataText, DataWriteResult, StudioEvent } from "../protocol.ts";
import { HISTORY_DIR, hashText, StudioError } from "./workspace.ts";
import { putFile, type Journals } from "./file-undo.ts";
import { keepVersion, writeAtomic } from "./versions.ts";

/** 素材として足せるファイルの拡張子を、中身の種類ごとに（書き出しがゲームに入れるものと同じ表。@liminalia/lang の MEDIA_EXTENSIONS）。 */
const IMAGE_EXTENSIONS = MEDIA_EXTENSIONS.image;
const AUDIO_EXTENSIONS = MEDIA_EXTENSIONS.audio;
const VIDEO_EXTENSIONS = MEDIA_EXTENSIONS.video;
/** 字幕（WebVTT）。@movie の subtitles で video の中から読む。 */
const SUBTITLE_EXTENSIONS = MEDIA_EXTENSIONS.subtitle;
/** 素材として足せるファイル（画像、音、動画、字幕、書体、シェーダー、立ち絵のモデル、外部のランタイム）。 */
const ASSET_EXTENSIONS = new Set(Object.values(MEDIA_EXTENSIONS).flat());
/**
 * 決まった素材のフォルダに置けるファイルの種類。背景のフォルダに音を入れるといった取り違えは、置いても命令から読めないので先に断る。
 * ここに無いフォルダ（others と、作品やプラグインが足したもの）は、素材として足せるファイルなら何でも置ける。
 */
const KIND_EXTENSIONS: Record<string, { what: string; extensions: readonly string[] }> = {
  bgimage: { what: "画像", extensions: IMAGE_EXTENSIONS },
  fgimage: { what: "画像と立ち絵のモデル", extensions: [...IMAGE_EXTENSIONS, ...MEDIA_EXTENSIONS.model] },
  image: { what: "画像", extensions: IMAGE_EXTENSIONS },
  bgm: { what: "音声", extensions: AUDIO_EXTENSIONS },
  sound: { what: "音声", extensions: AUDIO_EXTENSIONS },
  voice: { what: "音声", extensions: AUDIO_EXTENSIONS },
  video: { what: "動画と字幕", extensions: [...VIDEO_EXTENSIONS, ...SUBTITLE_EXTENSIONS] },
};
/** 素材の大きさの上限（動画も入るので大きめ）。 */
export const ASSET_LIMIT = 256 * 1024 * 1024;

/**
 * 作品のデータ（paths.data の .json）と素材の、制作画面からの読み書き。プラグインの画面（作品独自の記録や図鑑など）が使う。
 * - データは JSON として読めるものだけ書き、前の版を .liminalia/history/@data/<名前>/ に日時付きで残す（シナリオの変更履歴と同じく間引く。./versions.ts）
 * - 読んだあとにほかで書き換えられていたら書かずに今の中身を返す（.lim の書き込み口と同じ）
 * - 自分で書いた内容は覚えておき、ファイルの見張りが拾っても知らせない
 * - 素材は決まった拡張子のファイルだけを paths.assets/<種類>/ に書く（背景・立ち絵・画像には画像、BGM・効果音・ボイスには音、動画には動画と字幕だけ）。
 *   同じ名前は overwrite のときだけ上書き
 */
export class DataStore {
  /** 名前 → 最後に自分で書いた中身のハッシュ。 */
  private readonly written = new Map<string, string>();

  constructor(private readonly project: Project) {}

  read(name: string): DataText {
    const path = this.path(name);
    if (!existsSync(path)) throw new StudioError(404, `data/${name} がありません`);
    const text = readFileSync(path, "utf8");
    return { name, text, hash: hashText(text) };
  }

  write(name: string, text: string, baseHash: string | null): DataWriteResult {
    const path = this.path(name);
    try {
      JSON.parse(text);
    } catch (e) {
      throw new StudioError(400, `data/${name} に保存する内容を JSON として読み込めません: ${e instanceof Error ? e.message : String(e)}`);
    }
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    const currentHash = current === null ? null : hashText(current);
    if (currentHash !== baseHash) {
      if (current === null) throw new StudioError(404, `data/${name} がありません（ほかで削除されたか、名前が変更されました）`);
      return { ok: false, current: { name, text: current, hash: currentHash! } };
    }
    const hash = hashText(text);
    if (current !== text) {
      if (current !== null) this.keepHistory(name, current);
      this.written.set(name, hash);
      writeAtomic(path, text);
    }
    return { ok: true, name, hash };
  }

  /** ファイルの見張りから呼ぶ。data の .json がほかで変わったなら知らせを返す。 */
  changed(path: string): StudioEvent | null {
    const rel = relative(this.project.paths.data, path);
    if (rel.startsWith("..") || rel.split(sep).some((p) => p.startsWith(".")) || extname(rel) !== ".json") return null;
    const name = rel.split(sep).join("/");
    if (existsSync(path) && this.written.get(name) === hashText(readFileSync(path, "utf8"))) return null;
    return { type: "data-changed", name };
  }

  /** 素材を足す。kind は paths.assets の下のフォルダ、path はその中の相対パス。 */
  /** 素材を書く。undo を渡すと、⌘Z で戻すための控え（返事の undo）も作る（after は戻した・やり直したあとに呼ぶ）。 */
  upload(kind: string, path: string, body: Buffer, overwrite: boolean, undo?: { journals: Journals; after?: () => void }): AssetUploadResult {
    if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw new StudioError(400, `素材の種類として使えない名前です: ${kind}`);
    const clean = managedPath(this.project.paths.assets, `${kind}/${path}`, "素材");
    const ext = extname(clean).toLowerCase();
    if (!ASSET_EXTENSIONS.has(ext)) throw new StudioError(400, `素材として追加できない種類のファイルです: ${path}`);
    const allowed = KIND_EXTENSIONS[kind];
    if (allowed && !allowed.extensions.includes(ext)) {
      throw new StudioError(400, `${kind} のフォルダには${allowed.what}（${allowed.extensions.join(" ")}）だけを置けます。${path} は別の種類のフォルダへ追加してください`);
    }
    if (body.length === 0) throw new StudioError(400, "空のファイルは追加できません");
    if (body.length > ASSET_LIMIT) throw new StudioError(413, "ファイルが大きすぎます");
    if (existsSync(clean) && !overwrite) return { ok: false, exists: true };
    const rel = relative(join(this.project.paths.assets, kind), clean).split(sep).join("/");
    if (!undo) {
      writeAtomic(clean, body);
      return { ok: true, kind, path: rel };
    }
    // ⌘Z で戻せるように書く（上書きした前のファイルは控えの置き場へ。戻すと前のものが同じ場所に戻る。./file-undo.ts）
    const id = undo.journals.add(putFile(undo.journals, `${kind}/${rel}`, clean, body, join(this.project.paths.assets, kind)), undo.after);
    return { ok: true, kind, path: rel, ...(id ? { undo: id } : {}) };
  }

  private path(name: string): string {
    if (extname(name) !== ".json") throw new StudioError(400, `プロジェクトのデータは .json だけを読み書きできます: ${name}`);
    return managedPath(this.project.paths.data, name, "データ");
  }

  private keepHistory(name: string, text: string): void {
    keepVersion(join(this.project.root, HISTORY_DIR, "@data", ...name.split("/")), ".json", text);
  }
}
