import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { withSchemaText } from "@liminalia/project/new-config";
import { schemaUrl } from "../schema-url.ts";
import { isPortrait, PLUGIN_API_VERSION, portraitSpriteScale, positionCenters, SCRIPT_FORMAT } from "@liminalia/lang";
import { chooseProjectId, CONFIG_FILE, type ProjectConfig, type ProjectIdGuess } from "@liminalia/project";
import { engineMismatches } from "@liminalia/plugin-host";
import { stripTemplateOwner, templateSkips } from "../template-copy.ts";

/**
 * ひな形の置き場所。パッケージとして配るときは cli の中の templates/、このリポジトリではリポジトリ直下の templates/。
 */
const TEMPLATE_ROOTS = [resolve(import.meta.dirname, "../../templates"), resolve(import.meta.dirname, "../../../../templates")];

/** id に使える形（セーブの保存先・書き出しのフォルダ名・アプリの識別子に入る）。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** 言語コードの形（"en"、"zh-Hans" など。制作画面の訳の画面と同じ）。 */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** ひな形の中で名前を変えて置くファイル（npm で配るときに .gitignore が落ちるのを避ける）。 */
const RENAME: Record<string, string> = { gitignore: ".gitignore" };
/** ひな形から写さないもの（書き出し、制作画面の控え、バージョン管理、依存）。ひな形の .gitignore に書いたものなども写さない（../template-copy.ts）。 */
const SKIP_TEMPLATE = new Set(["dist", ".liminalia", ".git", "node_modules", ".DS_Store"]);
/** 人が配るひな形から作った作品の版。 */
const FIRST_VERSION = "1.0.0";

export interface NewOptions {
  title?: string;
  id?: string;
  /** 画面の大きさ（既定はひな形の 1280×720）。見本の立ち絵の枠は、画面の高さに合わせて縮め、横の位置は画面の幅の割合で置き直す。 */
  screen?: { width: number; height: number };
  /** サウンドノベル（画面全体に文章を積む NVL）で始める。「はじめから」の頭に @nvl on を置く。 */
  novel?: boolean;
  /** タイトル画面を出すか（既定 true）。 */
  titleScreen?: boolean;
  /** 見本の物語・素材・キャストを入れず、白紙の台本一つから始める。 */
  blank?: boolean;
  /**
   * 作る人の言語（"en"、"zh-Hans" など。既定は日本語）。白紙（blank）で日本語以外なら、台本の文と頭のコメントを英語にし
   * （地の文は字下げしない）、liminalia.json の languages をその言語にする（原文の言語。システム画面をその言語で出す）。
   * "en" の見本は英語の見本の物語（templates/default-en。素材は templates/default と同じ）で、languages は ["en"]。
   * ほかの言語の見本は日本語の見本の物語のままで、languages を書かない。日本語以外なら CI のひな形（ci）も英語のもの（templates/ci/en）にする。
   * 作ったあとの案内の言語は lim の出力の言語（main.ts）で決まる。
   */
  language?: string;
  /**
   * GitHub Actions の検査のひな形（templates/ci/liminalia-check.yml）を .github/workflows/ に置く。台本のテスト（tests/*.limtest）は
   * 見本の物語なら見本のテスト、白紙なら「はじめから終わりまで流れる」だけのテストを置く。
   */
  ci?: boolean;
  /**
   * 用意したひな形の代わりに写すひな形のフォルダ（liminalia.json のあるもの。人が配るひな形）。id と title を差し替え、version は 1.0.0 にし、
   * ひな形の作者の識別子と送り先（../template-copy.ts の TEMPLATE_OWNER_SETTINGS。バンドル ID、Steam、itch、記録と統計と指摘の送り先、
   * アップデート、署名、ストア、作者）は外して知らせる。ひな形の .gitignore に書いたもの、書き出し先（paths.out）、署名の鍵のファイルは写さない。
   * ほかの設定と台本の書式の版（format）はひな形のまま使う。ひな形の liminalia.json の engines.liminalia（合うエンジンの口の版）か format が
   * このエンジンに合わなければ知らせて作る（作った作品の lim check も知らせ続ける）。blank とは使えない。
   */
  template?: string;
  /**
   * 作ったあとの案内に並べる命令に付ける出力の言語（--lang en。lim new に --lang を付けて、端末の言語と違う言語で出したとき。
   * 付けないと、次の命令は端末の言語で出る）。
   */
  suggestLang?: string;
}

/** CI のひな形のファイル（lim new --ci が .github/workflows/ に写す）。 */
export const CI_WORKFLOW = "liminalia-check.yml";

/** CI のひな形の置き場所（templates/ci。日本語以外の作品は英語のひな形の templates/ci/en）。 */
export function ciTemplate(file: string, language?: string): string {
  const folders = language !== undefined && language !== "ja" ? [join("ci", "en"), "ci"] : ["ci"];
  for (const folder of folders) {
    for (const root of TEMPLATE_ROOTS) {
      const path = join(root, folder, file);
      if (existsSync(path)) return path;
    }
  }
  throw new Error(`CI のひな形 ${file} が見つかりません`);
}

/**
 * 英語の見本の物語（Waiting for Stars）。台本、テスト、キャスト（人物の ID は Akari、Sou）、liminalia.json、素材の説明だけを持ち、
 * 素材とアイコンは日本語の見本（templates/default）と同じものを使う（lim new が default を写してから重ねる）。
 */
export const ENGLISH_SAMPLE = "default-en";

/** ひな形の画面の大きさ（見本の立ち絵の枠はこの大きさで決めてある）。 */
const TEMPLATE_SCREEN = { width: 1280, height: 720 };
/** 縦長の作品での、見本の背景の焦点（liminalia.json の ui.backgroundFocus）。 */
const TEMPLATE_PORTRAIT_FOCUS = { "*": "62% 50%" };
/** 白紙の台本の名前と、ひな形の素材のフォルダ（白紙でも空で作っておく）。 */
const ENTRY = "start";
const ASSET_FOLDERS = ["bgimage", "fgimage", "image", "bgm", "sound", "voice", "video"];

export function templateDir(name: string): string {
  for (const root of TEMPLATE_ROOTS) {
    const dir = join(root, name);
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
  }
  throw new Error(`ひな形 ${name} が見つかりません`);
}

/** --template に渡したひな形のフォルダ（liminalia.json が無ければ止める）。 */
function givenTemplate(dir: string): string {
  const src = resolve(dir);
  if (!existsSync(join(src, CONFIG_FILE))) throw new Error(`${dir} に ${CONFIG_FILE} がありません（ひな形には作品のフォルダを渡します）`);
  return src;
}

/**
 * 人が配るひな形が、このエンジンに合うか（liminalia.json の engines.liminalia と format）。合わなければ知らせる文（english なら英語）。
 * 作るのは止めない（作った作品の lim check も engine-version と newer-format で知らせ続ける）。
 */
export function templateWarnings(src: string, english = false): string[] {
  let config: { format?: unknown; engines?: unknown };
  try {
    config = JSON.parse(readFileSync(join(src, CONFIG_FILE), "utf8")) as typeof config;
  } catch (e) {
    throw new Error(`ひな形の ${CONFIG_FILE} を読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = engineMismatches(config).map((need) =>
    english
      ? `Warning: the template needs engine API version ${need}, but this engine provides version ${PLUGIN_API_VERSION}; the project may not work (update Liminalia)`
      : `注意: このテンプレートはエンジン API バージョン ${need} 向けのため、このエンジン（バージョン ${PLUGIN_API_VERSION}）では動かないことがあります（Liminalia を新しいバージョンに更新してください）`,
  );
  if (typeof config.format === "number" && config.format > SCRIPT_FORMAT) {
    out.push(
      english
        ? `Warning: the template's script format (format: ${config.format}) is newer than this engine's (${SCRIPT_FORMAT}) (update Liminalia)`
        : `注意: このテンプレートのシナリオフォーマットバージョン（format: ${config.format}）が、このエンジンの対応バージョン（${SCRIPT_FORMAT}）より新しくなっています（Liminalia を新しいバージョンに更新してください）`,
    );
  }
  return out;
}

/**
 * フォルダ名と題名から作品の id を作る（@liminalia/project の chooseProjectId。制作アプリの新規作成と同じ。かなはローマ字にし、漢字は読めないので落とす）。
 * どちらからも作れなければ、--id で入れてもらうように止める（前は黙って my_game にし、別の作品とセーブデータや書き出したフォルダが混ざった）。
 */
export function projectIdFor(dir: string, title?: string, english = false): ProjectIdGuess {
  const folder = basename(resolve(dir));
  const guess = chooseProjectId([folder, title]);
  if (guess) return guess;
  const names = title !== undefined && title !== folder ? (english ? `the folder name "${folder}" or the title "${title}"` : `フォルダ名「${folder}」とタイトル「${title}」`) : english ? `the folder name "${folder}"` : `フォルダ名「${folder}」`;
  throw new Error(
    english
      ? `Can't make a project ID from ${names} (kanji can't be romanized). Give one with --id, using letters, digits, _ and - (it names the export folder and the save data)`
      : `${names}からはプロジェクト ID を作れません（漢字はローマ字にできません）。--id で英数字、_、- の ID を指定します（書き出したフォルダとセーブデータの名前になります）`,
  );
}

/**
 * lim new <フォルダ> [--title "…"] [--id …] [--size 幅x高さ] [--novel] [--no-title-screen] [--blank] [--lang en]
 * ひな形を写し、liminalia.json の id と title（と画面の大きさ・タイトル画面の有無・白紙なら原文の言語）を差し替える。title の既定はフォルダ名、
 * id の既定はフォルダ名か題名から作る（projectIdFor。かなはローマ字にする。漢字ばかりで作れなければ --id を求めて止める）。
 * フォルダが既にあって中身があるときは何も書かない。
 */
export function runNew(dir: string, o: NewOptions = {}): void {
  const dest = resolve(dir);
  const guess = o.id === undefined ? projectIdFor(dest, o.title, o.language === "en") : null;
  const id = o.id ?? guess!.id;
  if (!ID_PATTERN.test(id)) throw new Error(`id ${JSON.stringify(id)} は使えません（英数字、_、- を使い、英数字で始めます）。--id で指定してください`);
  const title = o.title ?? basename(dest);
  if (title.trim() === "") throw new Error("title が空です");
  const size = o.screen;
  if (size && !(Number.isInteger(size.width) && Number.isInteger(size.height) && size.width >= 320 && size.height >= 320 && size.width <= 7680 && size.height <= 7680)) {
    throw new Error(`画面サイズに指定できません: ${size.width}×${size.height}（320〜7680 の整数で指定してください）`);
  }
  if (o.language !== undefined && !LANGUAGE_PATTERN.test(o.language)) throw new Error(`言語コードとして使えません: ${o.language}（"en"、"zh-Hans" など）`);
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) throw new Error(`${dir} はフォルダではありません`);
    if (readdirSync(dest).some((f) => f !== ".DS_Store")) throw new Error(`${dir} は空ではありません。新しいフォルダか空のフォルダを指定してください`);
  }

  if (o.template !== undefined && o.blank) throw new Error("--template と --blank は一緒に使えません");
  const src = o.template !== undefined ? givenTemplate(o.template) : templateDir("default");
  const own = o.template !== undefined;
  // 英語の見本は、日本語の見本の素材の上に英語の台本、テスト、キャスト、設定を重ねる
  const englishSample = !own && !o.blank && o.language === "en";
  if (own) for (const line of templateWarnings(src, o.language === "en")) console.warn(line);
  mkdirSync(dest, { recursive: true });
  // ひな形をこのリポジトリで動かしたときの書き出し（dist/）などは写さない。ひな形の .gitignore に書いたもの、書き出し先（paths.out）、署名の鍵も写さない
  const skips = templateSkips(src, JSON.parse(readFileSync(join(src, CONFIG_FILE), "utf8")) as ProjectConfig);
  cpSync(src, dest, { recursive: true, filter: (f) => !relative(src, f).split(/[\\/]/).some((part) => SKIP_TEMPLATE.has(part)) && !skips.skip(f) });
  if (englishSample) {
    for (const f of ["scenario", "tests", SAMPLE_ASSETS_NOTE]) rmSync(join(dest, f), { recursive: true, force: true });
    const en = templateDir(ENGLISH_SAMPLE);
    cpSync(en, dest, { recursive: true, filter: (f) => !relative(en, f).split(/[\\/]/).some((part) => SKIP_TEMPLATE.has(part)) });
  }
  // 写さなかったファイルだけが入っていたフォルダ（鍵の keys/ など）は、空のまま残さない
  for (const skipped of skips.skipped) {
    for (let d = dirname(join(dest, skipped)); d.startsWith(dest + sep) && existsSync(d) && readdirSync(d).length === 0; d = dirname(d)) rmSync(d, { recursive: true });
  }
  for (const [from, to] of Object.entries(RENAME)) {
    if (existsSync(join(dest, from))) renameSync(join(dest, from), join(dest, to));
  }

  const configFile = join(dest, CONFIG_FILE);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as ProjectConfig;
  const screen = o.screen ?? config.screen ?? TEMPLATE_SCREEN;
  // 日本語以外の白紙は、台本の文とコメントを英語にする（訳した文の用意は英語だけ）
  if (o.blank) makeBlank(dest, title, o.novel === true, o.language !== undefined && o.language !== "ja", o.ci === true);
  else {
    if (o.novel) addNvl(join(dest, "scenario", `${config.entry}.lim`), config.entry);
    // 立ち絵の枠を決めた画面の大きさ（人が配るひな形はその liminalia.json の screen）
    const drawnFor = own ? (config.screen ?? TEMPLATE_SCREEN) : TEMPLATE_SCREEN;
    if (screen.width !== drawnFor.width || screen.height !== drawnFor.height) rescaleCast(join(dest, "cast.json"), screen, drawnFor);
  }
  // 見本の背景（横長）は真ん中で切り抜くと天文台が切れるので、縦長では天文台が入るところを残す（用意したひな形だけ）
  const ui = !o.blank && !own && isPortrait(screen) ? { ui: { ...config.ui, backgroundFocus: TEMPLATE_PORTRAIT_FOCUS } } : {};
  // 原文の言語（日本語は書かないときの既定なので書かない）
  const languages = o.blank && o.language && o.language !== "ja" ? { languages: [o.language] } : {};
  // 白紙には見本の物語の決まり（場面転換の時間など、commandDefaults）を持ち込まない
  const base = o.blank ? { ...config, commandDefaults: undefined } : config;
  // 人が配るひな形の作者の識別子と送り先（バンドル ID、Steam、itch、止まったときの記録、統計、指摘、アップデート、署名、ストア、作者）は写さない
  const removed = own ? stripTemplateOwner(base as Record<string, unknown>) : [];
  // 人が配るひな形は、書いた書式の版のまま（書いていなければ書かない。lim migrate で今の書式へ移せる）
  const format = own ? (base.format !== undefined ? { format: base.format } : {}) : { format: SCRIPT_FORMAT };
  // 作品の版は、人が配るひな形からなら 1.0.0 から始める
  const version = own ? FIRST_VERSION : base.version;
  // 先頭の $schema は、サイトに置いた設定の JSON Schema（エディタと AI のアシスタントが項目を引く）
  const head = { $schema: schemaUrl("liminalia"), id, title, ...(version !== undefined ? { version } : {}), ...format };
  writeFileSync(
    configFile,
    // format は台本の書式の版（lim migrate と lim check が見る）。id、title、version の次に置く（並びを決めてから、ひな形の値を重ねる）
    `${JSON.stringify({ ...head, ...base, ...head, ...(o.blank ? { entry: ENTRY } : {}), titleScreen: o.titleScreen ?? config.titleScreen ?? true, screen, ...languages, ...ui }, null, 2)}\n`,
  );

  withSchema(join(dest, "cast.json"), schemaUrl("cast"));

  // GitHub Actions の検査（台本の検査、整形、網羅、テスト）
  if (o.ci) {
    mkdirSync(join(dest, ".github", "workflows"), { recursive: true });
    cpSync(ciTemplate(CI_WORKFLOW, o.language), join(dest, ".github", "workflows", CI_WORKFLOW));
  }

  const where = relative(process.cwd(), dest) || ".";
  // 空白や記号のあるフォルダは、そのまま打てるように引用符で囲む
  const shown = /[\s"'`$&|;<>()*?!#~{}[\]]/.test(where) ? JSON.stringify(where) : where;
  // 英語の出力は、lim の文言の表（messages-en.ts）で読み替える
  const listSep = "、";
  console.log(`${shown} に「${title}」（id: ${id}）を作成しました`);
  if (guess && !guess.complete) console.log(`ID の ${id} は、名前のうちローマ字にできた部分だけから作りました（漢字は読めません）。書き出したフォルダとセーブデータの名前になります。変えるなら liminalia.json の id を書き換えます`);
  if (removed.length > 0) console.log(`ひな形の作者のものなので写さなかった設定: ${removed.join(listSep)}（書き出しや公開の前に、自分のものを liminalia.json に書きます）`);
  if (own && skips.skipped.length > 0) console.log(`テンプレートからコピーしなかったファイル（テンプレートの .gitignore、書き出し先、署名鍵）: ${skips.skipped.join(listSep)}`);
  if (own && config.version !== undefined && config.version !== FIRST_VERSION) console.log(`バージョンは ${FIRST_VERSION} から始めます（ひな形は ${config.version}）`);
  // 次の手: 制作画面（ブラウザの lim studio と制作アプリ）、テストプレイ、チェック、書き出し
  const at = o.suggestLang ? `${shown} --lang ${o.suggestLang}` : shown;
  console.log("");
  console.log(`  Studio:       lim studio ${at}（Liminalia Studio では「プロジェクトを開く」でこのフォルダを開きます）`);
  console.log(`  テストプレイ: lim dev ${at}`);
  console.log(`  チェック:     lim check ${at}`);
  console.log(`  書き出し:     lim build ${shown} browser${o.suggestLang ? ` --lang ${o.suggestLang}` : ""}`);
  if (o.ci) console.log(`  CI:           .github/workflows/${CI_WORKFLOW} と tests/`);
}

/**
 * JSON のファイルの先頭に "$schema" を書く（もう書いてあれば変えない）。ほかの書き方（並びと字下げ）はそのまま、最初の { の次の行に足す。
 */
export function withSchema(path: string, url: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  const next = withSchemaText(raw, url);
  if (next !== raw) writeFileSync(path, next);
}

/**
 * サンプル素材の説明（CC0 1.0 であること、絵は AI で作ったこと、ストアへの申告と差し替えの勧め）。プロジェクトの直下に置く
 * （書き出しはシナリオ、data、cast.json、言語のファイル、素材だけを写すので、ゲームには入らない）。白紙のプロジェクトには素材が無いので置かない。
 */
export const SAMPLE_ASSETS_NOTE = "素材について.txt";
/** 英語の見本（templates/default-en）のサンプル素材の説明。 */
export const SAMPLE_ASSETS_NOTE_EN = "SAMPLE-ASSETS.txt";

/**
 * 見本の物語・素材・キャストを外し、白紙の台本を一つ置く。english なら台本の文とコメントを英語にする（地の文は字下げしない）。
 * 見本のテストも外し、ci なら「はじめから終わりまで流れる」だけのテストを置く。
 */
function makeBlank(dest: string, title: string, novel: boolean, english: boolean, ci: boolean): void {
  rmSync(join(dest, "scenario"), { recursive: true, force: true });
  rmSync(join(dest, "tests"), { recursive: true, force: true });
  if (ci) {
    mkdirSync(join(dest, "tests"), { recursive: true });
    const test = english
      ? ["// Script tests (lim test). See \"Script tests\" in https://liminalia.skyta.dev/en/docs/design/format/", "", "# Runs from New Game to the end", "expect end", "expect no-errors", ""]
      : ["// 台本のテスト（lim test が流す）。書き方は https://liminalia.skyta.dev/docs/design/format/ の「台本のテスト」。", "", "# はじめから終わりまで流れる", "expect end", "expect no-errors", ""];
    writeFileSync(join(dest, "tests", `${ENTRY}.limtest`), test.join("\n"));
  }
  rmSync(join(dest, "assets"), { recursive: true, force: true });
  rmSync(join(dest, SAMPLE_ASSETS_NOTE), { force: true });
  for (const f of ASSET_FOLDERS) mkdirSync(join(dest, "assets", f), { recursive: true });
  mkdirSync(join(dest, "scenario"), { recursive: true });
  const lines = [
    `// ${title}`,
    english ? "// New Game starts at the top of this file (entry in liminalia.json)." : "// 「はじめから」はこのファイルの先頭から始まる（liminalia.json の entry）。",
    "",
    `# ${ENTRY}`,
    ...(novel ? ["@nvl on"] : []),
    english ? "Your story starts here." : "　ここから物語を書きます。",
    "",
  ];
  writeFileSync(join(dest, "scenario", `${ENTRY}.lim`), lines.join("\n"));
  writeFileSync(join(dest, "cast.json"), `${JSON.stringify({ speakers: [], cast: {} }, null, 2)}\n`);
}

/** 「はじめから」のラベルの次の行に @nvl on を置く（ラベルが無ければファイルの頭のコメントの後）。 */
function addNvl(file: string, entry: string): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const label = lines.findIndex((l) => l.trim() === `# ${entry}`);
  const at = label >= 0 ? label + 1 : lines.findIndex((l) => !l.startsWith("//") && l.trim() !== "");
  lines.splice(Math.max(0, at), 0, "@nvl on");
  writeFileSync(file, lines.join("\n"));
}

/**
 * 見本の立ち絵の枠を画面の大きさに合わせる（from は枠を決めた画面の大きさ。既定は用意したひな形の 1280×720）。大きさは画面の幅・高さの縮み方の小さい方で縮め（はみ出さないように）、
 * 下端からの距離も同じ割合にし、横は立ち絵の中心を画面の幅の同じ割合の位置に置く。
 * 縦長の画面は、幅に合わせて縮めると立ち絵が枠の裏に隠れるので、画面の高さの 7 割ほどの大きさにして（screen.ts）、下端を画面の下にそろえ、
 * 左右の立ち位置を真ん中へ寄せる（二人並ぶと少し重なる）。
 */
export function rescaleCast(file: string, screen: { width: number; height: number }, from: { width: number; height: number } = TEMPLATE_SCREEN): void {
  if (!existsSync(file)) return;
  const json = JSON.parse(readFileSync(file, "utf8")) as { cast?: Record<string, { appearances?: Record<string, { variants?: Record<string, { frame?: { width?: number; height?: number; positions?: Record<string, { left: number; top: number }> } }> }> }> };
  const scale = Math.min(screen.width / from.width, screen.height / from.height);
  const sx = screen.width / from.width;
  for (const c of Object.values(json.cast ?? {})) {
    for (const a of Object.values(c.appearances ?? {})) {
      for (const v of Object.values(a.variants ?? {})) {
        const f = v.frame;
        if (!f?.width || !f.height) continue;
        if (isPortrait(screen)) {
          const fit = portraitSpriteScale({ width: f.width, height: f.height }, screen);
          f.width = Math.round(f.width * fit);
          f.height = Math.round(f.height * fit);
          const centers = positionCenters(screen);
          for (const [name, p] of Object.entries(f.positions ?? {})) {
            p.left = Math.round(screen.width * (centers[name as keyof typeof centers] ?? centers.center) - f.width / 2);
            p.top = screen.height - f.height;
          }
          continue;
        }
        const width = Math.round(f.width * scale);
        const height = Math.round(f.height * scale);
        for (const p of Object.values(f.positions ?? {})) {
          const center = (p.left + f.width / 2) * sx;
          const fromBottom = (from.height - p.top) * scale;
          p.left = Math.round(center - width / 2);
          p.top = Math.round(screen.height - fromBottom);
        }
        f.width = width;
        f.height = height;
      }
    }
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
