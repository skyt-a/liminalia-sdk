import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assetNameResolver, LFS_HEAD_BYTES, configValueProblems, VARIABLE_KEY, encodingDiagnostic, jsonSyntaxError, readConfigJson, lineColumn, jsonLines, type Diagnostic, buildFlow, buildStoryMap, CORE_COMMANDS, scriptExportHtml, scriptExportLines, scriptExportText, createRegistry, expandExtra, extraWithChapters, parse, shownImages, toCsv, voiceScriptRows, type ChapterInfo, type CommandDefaults, type ExtraConfig, type Flow, type ItemsConfig, type PackManifest, type Script, type TargetHook, type UiConfig, type VariantDictionary, type VoiceLock, type VoiceScriptRow, type PunctuationConfig, type SoundCheckConfig } from "@liminalia/lang";
import { UI_THEMES, type UiThemePreset, type UiThemeValues } from "@liminalia/lang";
import { checkPluginManifest, combinePlugins, engineMismatches, PLUGIN_API_VERSION, type CommandPlugin } from "@liminalia/sdk";
import { listPackSources, listScenarioFiles, packScenarioPlace, readScenarioFile } from "./scenario-files.ts";
import { RESTRICTED_PLUGIN_MESSAGE, restrictedFromEnv } from "./trust.ts";
import { stdWebFeaturesOf } from "./std-features.ts";

export { ASSET_TEXT_SOURCES, assetAlwaysUsed, assetNameKey, assetTextFiles, assetTextFilesIn, assetTextUses, assetTextWhere, readAssetTextFiles, type AssetTextPlaces, type AssetTextSource, type AssetTextUse } from "./asset-uses.ts";
export { exportFileNames, fileNameProblems, hostPlatform, MAX_FILE_NAME, suggestFileName, type FilePlatform, type NamedFile, type NameProblem, type NameTarget } from "./file-names.ts";
export { LOCAL_VARIANTS_FILE, projectTextReport, variantDictionary, type ProjectTextReport } from "./text-stats.ts";
export { PROJECT_FILE_KINDS, type ProjectFileKind } from "./project-files.ts";
export { chooseProjectId, PROJECT_ID_MAX, PROJECT_ID_PATTERN, projectIdFromName, unsafeProjectId, type ProjectIdGuess } from "./project-id.ts";
import { unsafeProjectId } from "./project-id.ts";
export { assertProjectScenariosUtf8, assertScenariosUtf8, listPackScenarioFiles, listPackSources, listScenarioFiles, listScenarioTestFiles, loadScenarioSource, notUtf8Scenarios, PACKS_FOLDER, projectTestFiles, packScenarioPlace, readScenarioFile, SCENARIO_TESTS_FOLDER, ScenarioEncodingError, scenarioFileEncoding, type PackScenarioFile, type PackSource, type ScenarioFile, type ScenarioSource } from "./scenario-files.ts";
export { projectCode, projectCodeLine, RESTRICTED_PLUGIN_MESSAGE, restrictedFromEnv, type ProjectCode } from "./trust.ts";
export { stdWebFeaturesOf, type StdWebUsage } from "./std-features.ts";

/**
 * プロジェクト設定 liminalia.json。プロジェクトのフォルダの直下に置く。
 *
 * {
 *   "id": "my_game", "title": "My Game", "version": "1.0.0", "author": "Me",
 *   "screen": { "width": 1280, "height": 720 },
 *   "entry": "start",                 // 「はじめから」の開始位置（ファイル[#ラベル]）
 *   "titleScreen": true,              // タイトル画面を出すか
 *   "paths": { "scenario": "scenario", "assets": "assets", "data": "data", "cast": "cast.json", "lang": "lang", "voiceLock": "voice-lock.json" },
 *   "languages": ["ja", "en"],        // 多言語。先頭が原文の言語、ほかは lang/<言語>.json の訳
 *   "variables": { "game.trust": 0 }, // 変数の初期値（game.・system.）
 *   "ui": { "text": { "size": 28 }, "message": { "height": 180 } },  // 見た目と操作（@liminalia/lang の UiConfig）
 *   "plugins": ["./plugins/my-plugin"],
 *   "import": { "tyrano": { "source": "../my_tyrano_project", "profile": "./plugins/my-plugin" } },
 *   "build": { "bundleId": "com.example.mygame", "icon": "icon.png", "winIcon": "icon.ico",
 *              "asar": true, "resizable": true, "exclude": ["drafts/"], "forbid": ["unreleased/"] }
 * }
 */
/** 変数の初期値に書ける値（JSON の値）。 */
export type VariableInitial = string | number | boolean | null | VariableInitial[] | { [key: string]: VariableInitial };

export interface ProjectConfig {
  id: string;
  title: string;
  version?: string;
  /**
   * シナリオ（.lim）のフォーマットバージョン（@liminalia/lang の SCRIPT_FORMAT）。lim new と lim migrate が書く。省くとバージョン未記入のシナリオとして扱う。
   * エンジンの対応バージョンより新しければ、lim check が知らせる（新しいエンジンで書いたシナリオ）。
   */
  format?: number;
  /**
   * 対応エンジンの宣言。liminalia はエンジン API バージョン（@liminalia/sdk の PLUGIN_API_VERSION）の範囲（">=2"、"^2"、"2 - 3" など。
   * プラグインの package.json、テーマの theme.json と同じ書き方）。合わなければ lim check が知らせ、テンプレートなら lim new --template も知らせる。
   */
  engines?: { liminalia?: string };
  author?: string;
  /** 作品の短い説明（ブラウザ版のページの説明 <meta name="description"> と、Linux 版の .desktop の Comment）。 */
  description?: string;
  screen?: { width: number; height: number };
  entry: string;
  titleScreen?: boolean;
  paths?: Partial<Record<"scenario" | "assets" | "data" | "cast" | "lang" | "voiceLock" | "out", string>>;
  /**
   * 遊べる言語。先頭が原文の言語で、ほかの言語の訳は paths.lang の <言語>.json に置く。原文の言語だけでもよい（["en"] ならシステム画面を英語で出す）。
   * 省略は日本語の原文だけ。
   */
  languages?: string[];
  plugins?: string[];
  /**
   * 変数の初期値（"game.名前" か "system.名前" → 値）。game の変数は「はじめから」のたびにこの値で始まり、
   * system の変数はまだ値が無いときにこの値になる（ロードしたセーブに無い game の変数も、この値で補う）。
   */
  variables?: Record<string, VariableInitial>;
  /** ゲームの見た目と操作の設定（@liminalia/lang の UiConfig）。 */
  ui?: UiConfig;
  /** おまけ（CG・回想・音楽・実績）の一覧（@liminalia/lang の ExtraConfig）。 */
  extra?: ExtraConfig;
  /** 章の情報（番号・題・英題と、その章のシナリオファイル。@liminalia/lang の ChapterInfo）。 */
  chapters?: ChapterInfo[];
  /**
   * 作品ごとのコマンドの既定値（コマンド名 → パラメータ名 → .lim の書き方の値。@liminalia/lang の CommandDefaults）。
   * シナリオで省いたパラメータに使う（"chara": { "time": "400ms" } なら、time を書かない @chara は 400ms）。
   */
  commandDefaults?: CommandDefaults;
  /**
   * インポートの設定。tyrano は TyranoScript（lim import）。ink と yarn の commands は Ink のタグ、Yarn Spinner のコマンドの名前 →
   * .lim の行の型（lim import-ink / lim import-yarn。組み込みの対応表に重ねる。null はそのタグ、コマンドを書き出さない）。
   */
  import?: {
    tyrano?: { source: string; profile?: string };
    ink?: { commands?: Record<string, string | null> };
    yarn?: { commands?: Record<string, string | null> };
  };
  /**
   * セーブの扱い。location はデスクトップ版の保存先（"user": OS の標準の場所 / "portable": 実行ファイルの横の
   * savedata フォルダ。書けなければ標準の場所。省くと Windows と Linux は "portable"、Mac は "user"）。protect はセーブ・設定を読めない形で書き、書き換えたものを読まない。
   * carryFrom は引き継げる作品（体験版など）の id → デスクトップ版の題名。はじめて起動したときにその作品のセーブを見つけたら、
   * 引き継ぐかを尋ねる（設定画面の「セーブを読み込む」でも、その作品の書き出したものを読める）。
   */
  saves?: { location?: "user" | "portable"; protect?: boolean; carryFrom?: Record<string, string> };
  /**
   * ロードの直後に呼び出す位置（`ファイル#ラベル`）。セーブに入らない temp の計算し直しなどに使い、@return でロードしたページへ戻る。
   */
  afterLoad?: string;
  /** 持ち物（名前 → 表示名・絵・説明）。@item-add で足し、式の item("名前") で数を読む。 */
  items?: ItemsConfig;
  /**
   * 収録用の台本（lim voice-script と Studio のボイスの画面）。notes は演技のメモにする行（既定は台詞のすぐ上の //! の行だけ。
   * "comments" なら前のとおり、すぐ上のすべての // の行）。
   */
  voiceScript?: { notes?: "marked" | "comments" };
  /** @script（TypeScript を直接書く逃げ道）を使ってよいか。省略は使えない（検査でエラー）。 */
  allowScript?: boolean;
  /**
   * 文字数と表記ゆれの集計（lim stats と Studio のチェックの画面）。variants は表記ゆれの辞書（@liminalia/lang の VariantDictionary。
   * add で組を足し、ignore で組を外し、off で種類を外す）。作者の手元だけの辞書は .liminalia/variants.json に同じ形で書ける。
   */
  stats?: { variants?: VariantDictionary };
  /**
   * 構文チェックの設定。punctuation は約物の検査（@liminalia/lang の punctuation.ts。括弧の閉じ忘れ・句読点の重なり・！？の後の空白・
   * 三点リーダーとダッシュの数）。false ですべて外し、{ "off": ["single-ellipsis"] } で書いたものだけ外す。
   * rules は作品の演出の決まり（@liminalia/lang の ProjectRule。docs/design/format.md の「演出の決まり」）。
   */
  check?: {
    punctuation?: PunctuationConfig;
    rules?: unknown[];
    /**
     * 診断の code ごとの重さ（"error"、"warning"、"info"、"off"。off は出さない）。替えられるのは警告と情報だけ（@liminalia/lang の suppress.ts）。
     * 一行だけ外すなら、その行の前に // lim-ignore 診断のコード を書く。
     */
    severity?: Record<string, "error" | "warning" | "info" | "off">;
    /**
     * 変数の検査。"declared" なら variables に書いた変数だけを認め、書いていない game. と system. の変数を読む・書く所を警告する
     * （undeclared-variable）。省くと、読むだけで値の入らない変数のうち、値の入る変数に綴りの近いものを警告する（unset-variable）。
     */
    variables?: "declared";
    /**
     * 音の抜けの検査（@liminalia/lang の SoundCheckConfig。docs/design/format.md の「音の抜け」）。silence は無音の区間を知らせる本文の行数
     * （既定 30）、quiet はわざと無音にした場面、carry はファイルをまたいで鳴らしてよいループの効果音、off は外す診断。false ですべて外す。
     */
    sound?: false | SoundCheckConfig;
    /**
     * 使われなくても知らせない話者（cast.json の speakers の名前。先の話で使う人物など）。どの台詞にも使われない話者の情報（unused-speaker）を、
     * この話者だけ出さない。
     */
    unusedSpeakers?: string[];
  };
  /** 場面（`ファイル` か `ファイル#ラベル`）ごとの情報（視点の人物 pov・作中の日付 date・場所 place・作品の項目）。演出の決まりが読む。 */
  scenes?: Record<string, Record<string, unknown>>;
  /**
   * 自動確認（lim playtest）と録画の選択肢の選び方。avoidChoices はこの文を含む選択肢を、avoidEndings はこの種類（プレイを終えるコマンドの ending=。
   * bad など。種類でない文字なら、エンディングの名前（title=）にその文字を含むもの）のエンディングにしか到達しない選択肢を、ほかに選べるものがあれば選ばない。
   * lim playtest の --avoid-choice・--avoid-ending に足して使う。
   */
  playtest?: { avoidChoices?: string[]; avoidEndings?: string[] };
  /**
   * 作品が足すエンディングの種類（種類の名前 → 画面の文言。`{ "secret": "SECRET END" }`）。組み込みの種類（bad、normal、good、true、other）を書けば、
   * その作品の文言にする。文言は作品の設定の文字として訳す（@liminalia/lang の endings.ts）。
   */
  endingKinds?: Record<string, string>;
  /**
   * 立ち絵の登場順の自動配置（commandDefaults.chara の auto-layout）の並べ方。positions は人数ごとの立ち位置（人数 → 左からの位置。
   * 立ち絵の枠の立ち位置の名前か、画面の幅に対する割合 "30%"。書かない人数は前からの並べ方）。enter は新しく来た人物を入れる場所
   * （end は右の端、start は左の端、middle は真ん中。既定 end）。exit は誰かが退場したとき（reflow は残った人物を並べ直す、keep は動かさずに空けておき、
   * 次に来た人物をそこへ入れる。既定 reflow）。人物ごとの定位置は cast.json の side に書く。byCount は位置を名前で明示した立ち絵の読み替え
   * （人数 → 書いた立ち位置の名前 → 置く立ち位置の名前。表示中の立ち絵がちょうどその人数のときだけ。x= を書いた立ち絵と自動配置の人物は読み替えない）。
   */
  autoLayout?: { positions?: Record<string, string[]>; enter?: "end" | "start" | "middle"; exit?: "reflow" | "keep"; byCount?: Record<string, Record<string, string>> };
  /**
   * 整形（lim fmt と Studio の「整える」）の設定（フォーマットバージョンの format とは別）。indent は行頭の字下げ（ブロックの深さ一つにつき空白の数か "tab"。省くと字下げは変えない）。
   * expressions が false なら式の演算子の前後の空白を整えない（以前の lim fmt の動作）。
   */
  fmt?: { indent?: number | "tab"; expressions?: boolean };
  build?: {
    bundleId?: string;
    icon?: string;
    /**
     * スマホ版のアイコンの地の色（"#rrggbb"）。iOS は正方形に収めたときの余白と透明な所を、Android は適応アイコンの地を、この色で埋める。
     * 省くとアイコンの縁の色（縁が透明なら白）。
     */
    iconBackground?: string;
    winIcon?: string;
    /**
     * 書き出すファイルの名前（拡張子なし）: Windows 版の実行ファイル、Mac 版のアプリ、書き出し先のフォルダと zip など。
     * 省くとタイトル（Linux 版の実行ファイルだけはプロジェクト ID）。書き出し先の OS で使えない文字があれば書き出しを止める（file-names.ts）。
     */
    executableName?: string;
    /**
     * 書き出したあとの確かめで、タイトル画面が出てから写真を撮るまで待つミリ秒（既定 2500）。作品が host.holdShot() で
     * 撮影を止めていれば、離すまで待ってから数える（白からのフェードで始まるタイトルなど）。
     */
    verifyWait?: number;
    asar?: boolean;
    /**
     * 書き出しの版（lim build --variant 名前。全年齢版など）。forbid・exclude はこの版で足す、入っていたら止める素材・入れない素材。
     * contentFilter なら表現を控えめにしたまま変えさせない（ui.contentFilter）。台本からは system.variant で版の名前を見る。
     */
    variants?: Record<string, { forbid?: string[]; exclude?: string[]; contentFilter?: boolean; feedback?: boolean }>;
    /** 止まったときの記録を、遊ぶ人に尋ねてから送る先（POST で JSON を受ける URL）。書かなければ送らない（デスクトップ版は logs/ に残す）。 */
    crashReport?: { url: string };
    /**
     * ソースマップ（書き出したエンジンとプラグインの束の、元のプログラムの位置）。書かなければ作らない。"separate" は配るファイルに入れず、
     * 書き出し先の sourcemaps/<ID>-<書き出した日時>/ に残す（止まったときの記録のプログラムの位置を元に戻すのに使う）。"include" は書き出しに入れる
     * （遊ぶ人の開発者ツールで元のプログラムが見える）。
     */
    sourcemap?: "separate" | "include";
    /**
     * 遊ばれ方の統計（任意。選んだ選択肢と、遊ぶのをやめた場面）を送る先（POST で JSON を受ける URL）。書かなければ送らない。
     * 書いても、書き出したゲームがはじめて起動したときに遊ぶ人に尋ね、送ると答えたときだけ送る（コンフィグで変えられる）。docs/distribution.md
     */
    analytics?: { url: string };
    /**
     * テスト版の指摘（テスターや依頼主が、遊びながらその場面に指摘を残す）。テスト版（lim build --feedback、
     * 制作アプリの書き出しの「テスト版」、build.variants の feedback: true のエディション）にだけ入れ、製品の書き出しには入れない。
     * url があれば指摘を POST の JSON で送り、無ければ遊ぶ人がファイルに保存して渡す。Studio のコメントの画面で取り込む。
     */
    feedback?: { url?: string };
    /**
     * ブラウザ版とデスクトップ版の index.html に入れる Content Security Policy（@liminalia/cli の csp.ts）。既定はゲームと同じ場所からだけ読む。
     * 指示ごとに許すものを足す（{ "connect-src": ["https://api.example.com"], "frame-src": ["https://www.youtube.com"] }）か、false でその指示を外す。
     * false なら入れない（前の書き出しと同じ）。
     */
    csp?: false | Record<string, string[] | false>;
    /**
     * デスクトップ版の素材とシナリオを暗号にして入れる（読むときにアプリが戻す。素材を取り出されにくくする）。
     * lim pack と lim update-manifest のパックも同じ鍵で暗号にする。ブラウザ版は build.browser.encrypt。
     */
    encrypt?: boolean;
    /**
     * 書体を作品で使う字だけに縮める（書き出しの大きさを減らす）。files は素材のフォルダからのパス（"others/fonts/a.otf"）、
     * text は残す字を足す（作品のプラグインの外から文字を出すときなど）。
     */
    subsetFonts?: { files: string[]; text?: string };
    resizable?: boolean;
    /** 書き出しに入れない素材（素材のフォルダからのパスにこの文字列を含むもの）。 */
    exclude?: string[];
    /**
     * 使っている素材だけを書き出しに入れる（lim build --only-used と同じ。既定 false）。外すのは lim unused が出す素材
     * （名前が台本、データ、設定、プラグイン、作品の CSS と画面のテンプレート、パック、訳のどこにも出てこないもの）。声（voice/）とテーマの素材は外さない。
     * 素材の引数を式で書いた命令（("bg_" + n) など）があるフォルダは外さない。プラグインのコードの中で名前を組み立てる素材は追えない。
     */
    onlyUsed?: boolean;
    /** 書き出しに入っていてはいけない素材。見つかったら書き出しを止める（公開前の素材の混入を防ぐ）。 */
    forbid?: string[];
    /**
     * 日時付きで溜まる書き出し（<out>/mac/<名前>_<日時>/ など）を、書き出しのたびに名前ごとに新しいものからこの数だけ残して消す
     * （0 以上の整数。環境変数 LIMINALIA_KEEP が優先）。省くと 3 件残す。0 なら消さない。lim clean で手で片付けるときの既定の数にもなる。
     */
    keep?: number;
    /**
     * ソースマップの控え（sourcemap が "separate" のときの <out>/sourcemaps/<名前>-<日時>/）を、書き出しのたびに名前ごとに新しいものから
     * この数だけ残して消す（0 以上の整数）。省くと keep（と LIMINALIA_KEEP）と同じ数。0 なら消さない。配った版の止まったときの記録を読むために多めに残すときに書く。
     */
    keepSourcemaps?: number;
    /**
     * スマホ版の版の番号（1 以上の整数。ストアに出すたびに上げる。環境変数 LIMINALIA_BUILD_NUMBER が優先）。省略すると version から作る
     * （1.2.3 → 10203。二つ目か三つ目が 100 以上の版は、ほかの版と重なるので書き出しを止める）。
     */
    buildNumber?: number;
    /**
     * Android 版を Google Play 向けの Android App Bundle（.aab）にもする（APK の隣に作る。bundletool が要る）。
     * lim build android --aab でもよい（環境変数 LIMINALIA_AAB が優先）。
     */
    androidAab?: boolean;
    /**
     * Android 版。keystore・alias・storePasswordEnv は署名（省略すると開発用の鍵）。パスワードは環境変数の名前で書く。AAB も同じ鍵（Play のアップロード鍵）で署名する。
     * targetSdk は targetSdkVersion（既定は Google Play が今求める下限。組み立てにはその版の SDK Platform が要る。下限より小さいと --aab は止める）。
     */
    android?: { keystore?: string; alias?: string; storePasswordEnv?: string; keyPasswordEnv?: string; targetSdk?: number };
    /**
     * iOS 版。team は署名に使う Apple の開発チームの ID。audioSession は音の扱い（"ambient"（既定）: 消音スイッチに従い、ほかのアプリの音と重ねる。
     * "playback": 消音スイッチを入れていても鳴らし、ほかのアプリの音を止める）。
     */
    ios?: {
      team?: string;
      audioSession?: "ambient" | "playback";
      /**
       * iOS のプライバシーマニフェスト（PrivacyInfo.xcprivacy。プロジェクトからのパス）。省くと書き出しが作る（集める情報は build.crashReport、
       * build.analytics、テスト版の build.feedback から決め、追跡はしない）。作品のプラグインが別に情報を送るときは自分のものを書く。docs/distribution.md
       */
      privacyManifest?: string;
    };
    /**
     * スマホ版（android・ios）だけ素材を縮める（劣化を伴うので、書かなければ縮めない）。音は ffmpeg で AAC（format: "m4a"。既定）か
     * Opus（"opus"。.ogg）に bitrate（既定 "64k"・Opus は "48k"）で、画像は cwebp で WebP に quality（既定 80）で。
     * folders で縮めるフォルダを選ぶ（既定は音が bgm・sound・voice、画像が bgimage・fgimage・image）。
     * OGG に埋め込んだループの位置は、縮める前の音から読んで書き出しの project/audio-loops.json に入れる（形式が変わっても保つ）。
     */
    mobile?: AssetCompression;
    /**
     * Steam（デスクトップ版）。appId を書くと Steam につなぎ、@achieve を Steam の実績にする。
     * achievements は @achieve の名前 → Steam の実績の API 名（同じなら書かない）。
     */
    steam?: {
      appId: number;
      achievements?: Record<string, string>;
      /**
       * 数を数える実績（extra.achievements の goal）の @achieve-progress の数を書く統計（実績の名前 → Steam の統計の API 名）。
       * Steamworks で整数の統計を作り、実績の「進行状況の統計」に選ぶ。書かなければ、目標に届いたときの解除だけを送る。
       */
      stats?: Record<string, string>;
      /**
       * lim publish steam が上げる先のデポ（OS → デポ ID。Steamworks の「SteamPipe → デポ」で作る）。版ごとの App ID へ上げるときは
       * lim publish steam --app-id と --depot で選ぶ。
       */
      depots?: Partial<Record<"windows" | "mac" | "linux", number>>;
      /** 版ごとの App ID（"demo" → 体験版の ID など）。`lim build --steam 名前` で選ぶ。 */
      variants?: Record<string, number>;
      /** Steam ワークショップで購読したアイテム（pack.json のあるもの）をパックとして読み込む。 */
      workshop?: boolean;
      /**
       * Steam Input。actionSet（既定 "InGameControls"）の、actions（Steam のデジタルのアクションの名前 → ゲームの操作）を結ぶ。
       * ゲームの操作はゲームパッドのボタン（a、b、x、y、lb、rb、lt、rt、select、start、up、down、left、right。advance は a、back は b）か、
       * システム画面の操作（auto、skip、quick-save、backlog など）。
       */
      input?: { actionSet?: string; actions: Record<string, string> };
    };
    /**
     * iOS 版の実績（Game Center）。書くと @achieve と @achieve-progress を Game Center の実績に送る（App Store Connect で実績を作る）。
     * achievements はゲームの実績の名前 → Game Center の実績の ID（書かなければ同じ名前）。
     */
    gameCenter?: { achievements?: Record<string, string> };
    /**
     * Android 版の実績（Google Play Games Services v2）。appId は Play Console の Play Games サービスのプロジェクトの ID、
     * achievements はゲームの実績の名前 → Play Console の実績の ID（書いた実績だけ送る）、libraries は play-services-games-v2 の AAR と、
     * その依存の AAR・JAR（プロジェクトからのパス。build.store.android.libraries と同じく自分で用意する）。
     */
    playGames?: { appId: string; achievements: Record<string, string>; libraries: string[] };
    /** デスクトップ版で使う GPU（"high-performance": 性能の高い方。既定 / "default": OS に任せる）。 */
    gpu?: "high-performance" | "default";
    /**
     * Mac 版の配布用の署名と公証。署名の名前（環境変数 LIMINALIA_MAC_SIGN_IDENTITY が優先）があれば、hardened runtime と
     * entitlements を付けて署名し、公証の資格（notaryProfile か環境変数。docs/distribution.md）があれば公証して staple する。
     * 無ければ今までどおりアドホック署名。
     */
    mac?: {
      /** 署名の名前（"Developer ID Application: 名前 (チーム ID)"）。 */
      signIdentity?: string;
      /** entitlements の plist（プロジェクトからのパス）。省くと Electron に要るものを書き出しが作る。 */
      entitlements?: string;
      /** notarytool のキーチェーンのプロファイル名（xcrun notarytool store-credentials で作ったもの）。 */
      notaryProfile?: string;
      /** false なら資格があっても公証しない（署名だけ）。 */
      notarize?: boolean;
      /** アプリを zip にもする（ditto で作る。シンボリックリンク・実行の許可・署名を保つ）。環境変数 LIMINALIA_ZIP が優先。 */
      zip?: boolean;
      /** アプリを dmg にもする（hdiutil。アプリと「Applications」へのリンクを入れる）。環境変数 LIMINALIA_DMG が優先。 */
      dmg?: boolean;
      /**
       * Mac の CPU（"universal": Apple Silicon と Intel の両方で動く一つのアプリ。既定 / "arm64": Apple Silicon だけ / "x64": Intel だけ）。
       * 一つに絞ると Electron が片方の分になり、半分ほどの大きさになる。環境変数 LIMINALIA_MAC_ARCH、LIMINALIA_ARCH の順に優先。
       */
      arch?: "universal" | "arm64" | "x64";
    };
    /**
     * ブラウザ版。zip は書き出したフォルダの中身を zip にもする（index.html が zip の一番上。itch.io などにそのまま上げられる）。
     * compress は素材を縮める（形は build.mobile と同じ。環境変数 LIMINALIA_COMPRESS=0 なら縮めない）。
     * encrypt は素材とシナリオを暗号にし、Service Worker で戻す（https のページでだけ遊べる。鍵はページから読めるので、取り出されにくくするだけ）。
     * offline は一度開いたあとオフラインでも遊べるように、Service Worker でエンジン・台本・データを控え、素材は使ったときに控える（既定 true。
     * "all" なら素材も入れたときに全部控える。false なら Service Worker を入れない。暗号化と同じ lm-sw.js）。
     */
    browser?: { zip?: boolean; compress?: AssetCompression; encrypt?: boolean; offline?: boolean | "all" };
    /**
     * デスクトップ版（Mac・Windows・Linux）。compress は素材を縮める（形は build.mobile と同じ）。
     * fuses は Electron の Fuses（既定では RunAsNode、EnableNodeOptionsEnvironmentVariable、EnableNodeCliInspectArguments を切り、
     * app.asar に入れるなら OnlyLoadAppFromAsar と、Mac と Windows では EnableEmbeddedAsarIntegrityValidation を入れる）。
     * 名前 → true か false で一つずつ替え、false なら Fuses に手を付けない（前の書き出しと同じ）。
     * locales は Electron の言語のファイルに、作品の言語（languages）と英語のほかに残す言語（"fr" など）。"all" ならすべて残す（前の書き出しと同じ）。
     */
    desktop?: { compress?: AssetCompression; locales?: "all" | string[]; fuses?: false | Partial<Record<"RunAsNode" | "EnableNodeOptionsEnvironmentVariable" | "EnableNodeCliInspectArguments" | "EnableEmbeddedAsarIntegrityValidation" | "OnlyLoadAppFromAsar", boolean>> };
    /**
     * アップデートの確認（デスクトップ版。Steam 以外で売るとき）。url のマニフェスト（lim update-manifest が作る）を、起動したときと
     * メニューの「アップデートを確認」で取り寄せ、新しいパックがあれば取り寄せて入れ、本体が新しければインストーラーかダウンロードのページへ案内する。
     * 環境変数 LIMINALIA_UPDATE_URL が優先（"off" なら入れない）。
     */
    update?: {
      /** マニフェストの URL（https）。 */
      url: string;
      /** 起動したときに確かめる（既定 true）。false ならメニューから確かめたときだけ。 */
      checkOnStartup?: boolean;
      /** Steam につなぐ版でも確かめる（既定 false。Steam が更新を配るため）。 */
      steam?: boolean;
      /**
       * マニフェストの署名を確かめる公開鍵（Ed25519 の 32 バイトの base64。lim update-key が作る）。書くと、署名の通ったマニフェストだけを使う。
       * 鍵を替えるときは、前の鍵と新しい鍵を配列で並べた版を先に配る。
       */
      publicKey?: string | string[];
    };
    /**
     * 店とアプリ内課金。products は買える商品（ゲームの中の名前 → 店ごとの商品 ID）で、買ったものは system.purchases.<名前> が true になる
     * （シナリオは @purchase と @restore-purchases）。desktop はデスクトップ版の店の口（GOG Galaxy、Epic など。作品のプラグインの CommonJS の
     * ファイル。Steam につなぐ版では使わない）。android は Google Play Billing のライブラリ（AAR と JAR）。docs/distribution.md
     */
    store?: StoreConfig;
    /**
     * itch.io へ上げる先（lim publish itch）。target は "人の名前/ゲームの名前"（itch.io のゲームのページの URL の形）、channels は
     * 書き出しの種類 → チャンネルの名前（既定 browser: html5、windows: windows、mac: mac、linux: linux）。
     */
    itch?: { target?: string; channels?: Partial<Record<"browser" | "windows" | "mac" | "linux", string>> };
    /** Windows 版の Authenticode 署名（sign）と、インストーラー（installer。true か設定）。 */
    windows?: {
      sign?: WindowsSignConfig;
      /**
       * 実行ファイルを包む外部のコマンド（ストアが渡す DRM の道具など）。"{file}" を実行ファイルのパスに置き換え、署名の前に実行する。
       * 環境変数 LIMINALIA_WIN_WRAP_COMMAND（JSON の配列か空白区切り）が優先し、"off" なら行わない。
       */
      wrap?: string[];
      installer?: boolean | WindowsInstallerConfig;
      /** Windows の CPU（"x64": 既定 / "arm64": ARM の Windows / "ia32": 32 ビットの Windows）。環境変数 LIMINALIA_WINDOWS_ARCH、LIMINALIA_ARCH の順に優先。 */
      arch?: "x64" | "arm64" | "ia32";
    };
    /** Linux 版。arch は CPU（"x64": 既定 / "arm64"）。環境変数 LIMINALIA_LINUX_ARCH、LIMINALIA_ARCH の順に優先。 */
    linux?: { arch?: "x64" | "arm64" };
  };
}

/** 素材を縮める設定（build.mobile・build.browser.compress・build.desktop.compress）。 */
export interface AssetCompression {
  audio?: { format?: "m4a" | "opus"; bitrate?: string; folders?: string[] };
  /**
   * scale は画像の解像度の倍率（0 より大きく 1 より小さい数。0.5 なら縦横を半分に）。scaleFolders（既定は bgimage と fgimage）の画像を
   * 縮め、遊ぶ側は元の大きさで出す（表示の大きさと位置は変わらない）。部品の画像（image）は枠の角の大きさを画素で書くので既定では縮めない。
   */
  images?: { format?: "webp"; quality?: number; folders?: string[]; scale?: number; scaleFolders?: string[] };
}

/** 買える商品の、店ごとの商品 ID（ios: App Store の Product ID、android: Google Play の商品 ID、steam: DLC の App ID、ほかはプラグインの店の名前）。 */
export interface StoreProduct {
  ios?: string;
  android?: string;
  steam?: number;
  [store: string]: string | number | undefined;
}

export interface StoreConfig {
  products?: Record<string, StoreProduct>;
  desktop?: { module: string; options?: Record<string, unknown> };
  /** Play Billing Library の AAR と、その依存の AAR・JAR（プロジェクトからのパス）。無ければ Android 版はアプリ内課金なしで書き出す。 */
  android?: { libraries: string[] };
}

/**
 * Windows 版のインストーラー（NSIS の makensis で作る。日本語と英語の画面、スタートメニューとデスクトップのショートカット、アンインストール）。
 */
export interface WindowsInstallerConfig {
  /** すべての利用者に入れる（Program Files。管理者の権限が要る）。既定は入れる人だけ（%LOCALAPPDATA%\Programs）。 */
  perMachine?: boolean;
  /** デスクトップのショートカットを作るチェックの初め（既定 true）。 */
  desktopShortcut?: boolean;
  /** 画面の言語（既定 ["ja", "en"]。Windows の表示の言語で選ぶ）。 */
  languages?: ("ja" | "en")[];
}

/**
 * Windows 版の Authenticode 署名。pfx（環境変数 LIMINALIA_WIN_PFX が優先）とパスワードの環境変数か、外部の署名コマンド
 * （Azure Trusted Signing の jsign など。環境変数 LIMINALIA_WIN_SIGN_COMMAND が優先）のどちらかを書く。
 * Windows では signtool、Mac と Linux では osslsigncode で署名する。
 */
export interface WindowsSignConfig {
  /** 証明書（PFX）のパス（プロジェクトからの相対）。 */
  pfx?: string;
  /** PFX のパスワードを入れた環境変数の名前（既定 LIMINALIA_WIN_PFX_PASSWORD）。 */
  passwordEnv?: string;
  /** 外部の署名コマンド。"{file}" を署名するファイルのパスに置き換えて実行する。 */
  command?: string[];
  /** タイムスタンプのサーバー（RFC 3161。既定 http://timestamp.digicert.com）。 */
  timestampUrl?: string;
  /** 署名の道具（osslsigncode・signtool）が無いとき。"fail": 書き出しを止める（既定） / "skip": 理由を出して署名せずに続ける。 */
  ifMissing?: "fail" | "skip";
}

/** 話者とキャスト（立ち絵の定義）。paths.cast のファイル。 */
export interface CastFile {
  speakers: string[];
  cast: Record<string, unknown>;
}

export interface Project {
  root: string;
  config: ProjectConfig;
  /**
   * liminalia.json の誤りのうち、読み込みを止めずにその項目を使わないことにしたもの（variables の名前の誤り、saves.location の値の誤り）。
   * lim check が診断として出す。
   */
  problems?: Diagnostic[];
  /** voiceLock は連番のボイスの番号の固定（lim voice-lock が書く。@liminalia/lang の VoiceLock）。 */
  paths: { scenario: string; assets: string; data: string; cast: string; lang: string; voiceLock: string; out: string };
  screen: { width: number; height: number };
  /** プラグインのフォルダ（package.json のあるところ）。先頭は組み込みの標準の命令（@liminalia/std）。 */
  plugins: string[];
  /**
   * 読み込めずに抜いたプラグイン（loadProject の skipBrokenPlugins と、loadCommandPlugins の skipBroken のとき）。
   * 制作画面は上の帯とチェックの「プラグイン」の分類に出す。
   */
  pluginErrors?: PluginLoadError[];
  /**
   * 制限付きで読んだ（--restricted、LIMINALIA_RESTRICTED=1、VS Code の信頼していないワークスペース。trust.ts）。作品のプラグインを読まず（plugins は標準の命令だけ）、書き出しを止める。
   * 書いたプラグインは、skipBrokenPlugins なら pluginErrors に restricted の印を付けて残す。
   */
  restricted?: boolean;
}

/** 読み込めなかったプラグイン。 */
export interface PluginLoadError {
  /** liminalia.json の plugins に書いたもの。 */
  spec: string;
  /** 理由（「パッケージが見つかりません」、読み込んだときの例外の文など）。 */
  message: string;
  /** 作品の外のフォルダが無い（その Mac にだけある道具のプラグインを、ほかのコンピューターで開いたとき。どの口でも止めない）。 */
  outside?: boolean;
  /** 制限付きで開いたので読まなかった（trust.ts）。 */
  restricted?: boolean;
}

/** 読み込めなかったプラグインの一文（lim のエラー、制作画面の帯と診断で同じ形）。 */
export function pluginLoadMessage(e: Pick<PluginLoadError, "spec" | "message">): string {
  return `プラグイン ${e.spec} を読み込めません（${e.message}）`;
}

export const CONFIG_FILE = "liminalia.json";

/**
 * 設定の JSON（liminalia.json・cast.json）を読めないときの誤り。file・line・column はその位置（行と桁は 1 から）。
 * lim check は診断として出し、ほかの道具は位置つきの文で止まる。
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number | undefined,
    readonly reason: string,
  ) {
    super(`${file}:${line}${column !== undefined ? `:${column}` : ""} ${reason}`);
  }
}

/** JSON の文字を読む。読めなければ、読めない所の行と桁の ConfigError を投げる。 */
export function parseConfigJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const at = jsonSyntaxError(text) ?? { offset: 0, reason: "JSON として読めません" };
    const { line, column } = lineColumn(text, at.offset);
    throw new ConfigError(file, line, column, `JSON として読めません: ${at.reason}`);
  }
}

export { configSchema } from "./config-schema.ts";

/** どのプロジェクトにも組み込みで入る標準の命令のプラグイン。 */
export const STD_PLUGIN = dirname(createRequire(import.meta.url).resolve("@liminalia/std/package.json"));

/** テーマの素材を写す先（assets/image からのパス）。 */
const themeAssetDir = (id: string) => `themes/${id}`;

/** 用意したテーマと、作品の中のテーマ（themes/<id>/theme.json）。 */
export function listUiThemes(dir: string): UiThemePreset[] {
  const root = join(dir, "themes");
  const local: UiThemePreset[] = [];
  if (existsSync(root)) {
    for (const id of readdirSync(root).sort()) {
      const file = join(root, id, "theme.json");
      if (!existsSync(file)) continue;
      const t = JSON.parse(readFileSync(file, "utf8")) as { name?: string; nameEn?: string; orientation?: unknown; ui?: UiThemeValues };
      local.push({ id, name: t.name ?? id, nameEn: t.nameEn ?? t.name ?? id, ui: t.ui ?? {}, local: true, ...(t.orientation === "portrait" ? { orientation: "portrait" as const } : {}) });
    }
  }
  // 同じ名前なら作品の中のものを使う
  return [...UI_THEMES.filter((t) => !local.some((l) => l.id === t.id)), ...local];
}

/** テーマの素材を作品へ写す（用意したテーマの assets と、作品の中のテーマの themes/<id>/assets/）。既にあるものは書き直す。 */
export function copyUiThemeAssets(dir: string, theme: UiThemePreset, assetsDir = join(dir, "assets")): void {
  const to = join(assetsDir, "image", themeAssetDir(theme.id));
  for (const [name, content] of Object.entries(theme.assets ?? {})) {
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, name), content);
  }
  const from = join(dir, "themes", theme.id, "assets");
  if (theme.local && existsSync(from)) cpSync(from, to, { recursive: true });
}

/**
 * プロジェクトを読む。skipBrokenPlugins なら、見つからないプラグイン（パッケージ、作品の中のフォルダ、package.json）を
 * 止めずに抜いて pluginErrors に残す（制作画面。lim studio は抜いて起動する）。省くと、見つからないパッケージで止まる。
 * restricted なら作品のプラグインを読まない（省くと環境変数で決める。trust.ts の restrictedFromEnv）。
 */
export function loadProject(dir: string, o: { skipBrokenPlugins?: boolean; restricted?: boolean } = {}): Project {
  const root = resolve(dir);
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${file} がありません`);
  const text = readFileSync(file, "utf8");
  const config = parseConfigJson(text, CONFIG_FILE) as ProjectConfig;
  const lines = jsonLines(text);
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw new ConfigError(CONFIG_FILE, 1, undefined, "liminalia.json は { … } の形で書きます");
  for (const key of ["id", "title", "entry"] as const) {
    if (typeof config[key] !== "string" || config[key] === "") throw new ConfigError(CONFIG_FILE, lines.get(`/${key}`) ?? 1, undefined, `${CONFIG_FILE} に ${key} がありません`);
  }
  // id は書き出したフォルダの名前になる（書き出しはそのフォルダを消して置き直す）ので、パスとして危ない id は開かない
  if (unsafeProjectId(config.id)) throw new ConfigError(CONFIG_FILE, lines.get("/id") ?? 1, undefined, `${CONFIG_FILE} の id ${JSON.stringify(config.id)} は書き出したフォルダの名前に使えません（英数字、_、- で書きます）`);
  // 一つの項目の誤りで全体を止めない（その項目を使わず、検査が知らせる。知らせる文は検査と同じ configValueProblems）
  const problems = configValueProblems(config, text, CONFIG_FILE);
  if (config.variables !== undefined) {
    if (typeof config.variables !== "object" || config.variables === null || Array.isArray(config.variables)) delete config.variables;
    else for (const key of Object.keys(config.variables)) if (!VARIABLE_KEY.test(key)) delete config.variables[key];
  }
  if (config.saves?.location !== undefined && config.saves.location !== "user" && config.saves.location !== "portable") delete config.saves.location;
  const p = config.paths ?? {};
  const at = (v: string | undefined, d: string) => resolve(root, v ?? d);
  const pluginErrors: PluginLoadError[] = [];
  const restricted = o.restricted ?? restrictedFromEnv();
  if (restricted) {
    for (const spec of config.plugins ?? []) pluginErrors.push({ spec, message: RESTRICTED_PLUGIN_MESSAGE, restricted: true });
    if ((config.plugins ?? []).length > 0 && !warnedRestricted.has(root)) console.warn(`[プラグイン] ${RESTRICTED_PLUGIN_MESSAGE}（${(config.plugins ?? []).join("、")}）。--restricted か LIMINALIA_RESTRICTED=1 を外すと読みます`);
    warnedRestricted.add(root);
  }
  const plugins = restricted ? [] : pluginDirs(root, config.plugins ?? [], pluginErrors, o.skipBrokenPlugins === true);
  return {
    root,
    config,
    ...(problems.length > 0 ? { problems } : {}),
    paths: {
      scenario: at(p.scenario, "scenario"),
      assets: at(p.assets, "assets"),
      data: at(p.data, "data"),
      cast: at(p.cast, "cast.json"),
      lang: at(p.lang, "lang"),
      voiceLock: at(p.voiceLock, "voice-lock.json"),
      out: at(p.out, "dist"),
    },
    screen: config.screen ?? { width: 1280, height: 720 },
    plugins: [STD_PLUGIN, ...plugins],
    ...(o.skipBrokenPlugins ? { pluginErrors } : {}),
    ...(restricted ? { restricted: true } : {}),
  };
}

/** 制限付きで読んだと知らせた作品（一度だけ知らせる）。 */
const warnedRestricted = new Set<string>();

/** 見つからないと知らせた、作品の外のプラグイン（作品のフォルダ → 指定）。 */
const missingOutside = new Set<string>();

/**
 * liminalia.json の plugins のフォルダ。作品の外のフォルダ（`../x`、絶対パス）を指すもので、そのフォルダがこのコンピューターに無いものは飛ばす
 * （その Mac にだけある道具のプラグインを、スマホ版でリポジトリから開いたときや、ほかのコンピューターで開いたとき）。飛ばしたことは一度だけ知らせる。
 * 作品の中のフォルダは、無ければ今までどおり読むときに止まり、パッケージの名前は見つからなければここで止まる。
 * skip なら、どちらも止めずに抜いて errors に残す（一度だけ知らせる）。
 */
function pluginDirs(root: string, specs: string[], errors: PluginLoadError[], skip: boolean): string[] {
  const dirs: string[] = [];
  const broken = (spec: string, message: string): void => {
    const e = { spec, message };
    if (!skip) throw new Error(pluginLoadMessage(e));
    errors.push(e);
    if (!missingOutside.has(`${root}\0${spec}`)) console.warn(`[プラグイン] ${pluginLoadMessage(e)}。このプラグインを抜いて続けます`);
    missingOutside.add(`${root}\0${spec}`);
  };
  for (const spec of specs) {
    let dir: string;
    try {
      dir = resolvePackageDir(root, spec);
    } catch {
      // 見つからないことを pluginErrors に残し、ほかのプラグインで続ける
      broken(spec, "パッケージが見つかりません");
      continue;
    }
    const rel = relative(root, dir);
    const outside = rel.startsWith("..") || isAbsolute(rel);
    if (outside && (spec.startsWith(".") || isAbsolute(spec)) && !existsSync(dir)) {
      if (!missingOutside.has(`${root}\0${spec}`)) console.warn(`[プラグイン] ${spec} が見つからないので読み込みません（作品の外のフォルダ）`);
      missingOutside.add(`${root}\0${spec}`);
      errors.push({ spec, message: "フォルダがありません", outside: true });
      continue;
    }
    if (skip && !existsSync(dir)) {
      broken(spec, "フォルダがありません");
      continue;
    }
    if (skip && !existsSync(join(dir, "package.json"))) {
      broken(spec, "package.json がありません");
      continue;
    }
    dirs.push(dir);
  }
  return dirs;
}

export function readCast(project: Project): CastFile {
  if (!existsSync(project.paths.cast)) return { speakers: [], cast: {} };
  const json = parseConfigJson(readFileSync(project.paths.cast, "utf8"), relative(project.root, project.paths.cast).split("\\").join("/") || "cast.json") as Partial<CastFile>;
  return { speakers: json.speakers ?? [], cast: json.cast ?? {} };
}

/** 連番のボイスの番号の固定（無ければ null）。 */
export function readVoiceLock(project: Project): VoiceLock | null {
  if (!existsSync(project.paths.voiceLock)) return null;
  return JSON.parse(readFileSync(project.paths.voiceLock, "utf8")) as VoiceLock;
}

/**
 * voice-lock.json を読めなかったときの診断（bad-voice-lock）。JSON の書き方の誤りなら、読めない所の行と桁を付ける。
 * e は readVoiceLock が投げたもの。
 */
export function voiceLockProblem(project: Project, e: unknown): Diagnostic {
  let text: string | null = null;
  try {
    text = readFileSync(project.paths.voiceLock, "utf8");
  } catch {
    // voice-lock.json が無いか読めなければ、ボイスの割り当ては無いものとする
    text = null;
  }
  const placed = text === null ? [] : readConfigJson(text, "voice-lock.json", null, "bad-voice-lock").diagnostics;
  return placed[0] ?? { severity: "error", code: "bad-voice-lock", message: `voice-lock.json を JSON として読み込めません: ${e instanceof Error ? e.message : String(e)}`, file: "voice-lock.json", line: 1 };
}

/** "./plugins/x" ならプロジェクトからの相対、それ以外はプロジェクトから見たパッケージ名として探す。 */
export function resolvePackageDir(root: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) return resolve(root, spec);
  const require = createRequire(join(root, "package.json"));
  return dirname(require.resolve(`${spec}/package.json`));
}

/** プラグインのパッケージの exports から、"./commands" などの入口のファイルを求める。無ければ null。 */
export function pluginEntry(pluginDir: string, entry: "commands" | "web" | "import" | "studio" | "studio-server"): string | null {
  const pkgFile = join(pluginDir, "package.json");
  if (!existsSync(pkgFile)) throw new Error(`プラグイン ${pluginDir} に package.json がありません`);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { exports?: Record<string, string | { import?: string; default?: string }> };
  const target = pkg.exports?.[`./${entry}`];
  const path = typeof target === "string" ? target : (target?.import ?? target?.default);
  return path ? resolve(pluginDir, path) : null;
}

/** 命令のプラグインの読み込み方。ブラウザの中で動く制作画面（@liminalia/studio-mobile）が替える。 */
let importCommands = async (entry: string): Promise<{ default?: CommandPlugin }> => (await import(pathToFileURL(entry).href)) as { default?: CommandPlugin };

export function setCommandImporter(fn: typeof importCommands): void {
  importCommands = fn;
}

/**
 * プラグインを読み込めなかった理由を、Node の生の文でなく分かる言葉にする（入口のファイルが無い、読むモジュールが無い、構文の誤り）。
 * ほかは例外の文の一行目。entry は読もうとした入口（plugin の dir からの相対で出す）。
 */
export function pluginErrorReason(e: unknown, dir: string, entry: string | null): string {
  const text = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  // 外さずに読んだときも、外して読んだとき（pluginDirs）と同じ理由にする（前はプラグインの絶対パスの入った文だった）
  if (!existsSync(dir)) return "フォルダがありません";
  if (!existsSync(join(dir, "package.json"))) return "package.json がありません";
  const rel = entry ? relative(dir, entry).split(sep).join("/") : null;
  if (rel && entry && !existsSync(entry)) return `入口のファイル ${rel} がありません`;
  const missing = /Cannot find (?:module|package) '([^']+)'/.exec(text);
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || missing) {
    const name = missing?.[1] ?? "";
    const shown = isAbsolute(name) ? relative(dir, name).split(sep).join("/") : name;
    return shown ? `読み込むモジュール ${shown} が見つかりません（npm install で入れるか、import の書き方を確かめます）` : "読み込むモジュールが見つかりません（npm install で入れるか、import の書き方を確かめます）";
  }
  if (e instanceof SyntaxError) return `${rel ?? "入口"} の書き方の誤り（${text.split("\n")[0]}）`;
  return text.split("\n")[0]!;
}

/**
 * 作品のプラグインの "./commands" を読む。skipBroken なら、読み込めないもの（入口が無い、読み込むと例外、default export が無い）を
 * 止めずに抜いて project.pluginErrors に足す（制作画面）。省くと、読み込めないところで「プラグイン X を読み込めません（理由）」で止まる。
 */
export async function loadCommandPlugins(project: Project, o: { skipBroken?: boolean } = {}): Promise<CommandPlugin[]> {
  const out: CommandPlugin[] = [];
  for (const dir of project.plugins) {
    let entry: string | null = null;
    try {
      entry = pluginEntry(dir, "commands");
      if (!entry) continue;
      const mod = await importCommands(entry);
      if (!mod.default) throw new Error(`${entry} が CommandPlugin を default export していません`);
      out.push(mod.default);
    } catch (e) {
      const error = { spec: pluginSpec(project, dir), message: pluginErrorReason(e, dir, entry) };
      if (!o.skipBroken) throw new Error(pluginLoadMessage(error), { cause: e });
      (project.pluginErrors ??= []).push(error);
      console.warn(`[プラグイン] ${pluginLoadMessage(error)}。このプラグインを抜いて続けます`);
    }
  }
  return out;
}

/**
 * プラグインの package.json の、合うエンジンの宣言（liminalia.api・engines.liminalia）を、このエンジンのプラグインの口の版と比べる
 * （lim check と制作画面のチェック）。合わないものは警告（plugin-engine-version）。読めない package.json は見ない。
 */
export function pluginManifestDiagnostics(project: Project): Diagnostic[] {
  return project.plugins.flatMap((dir) => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      // package.json が読めないプラグインは、読み込みの誤り（plugin-load）として別に知らせる
      return [];
    }
    return checkPluginManifest(pluginSpec(project, dir), manifest);
  });
}

/**
 * 作品の中のテーマ（themes/<id>/theme.json）の、合うエンジンの宣言（engines.liminalia・liminalia.api。プラグインと同じ形）を、
 * このエンジンの口の版と比べる。合わないものは警告（theme-engine-version）。読めない theme.json は見ない。
 */
export function themeManifestDiagnostics(root: string): Diagnostic[] {
  const dir = join(root, "themes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((id) => {
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(join(dir, id, "theme.json"), "utf8"));
      } catch {
        // theme.json の無いフォルダと読めないものは、テーマの一覧（listUiThemes）でも扱わない
        return [];
      }
      return engineMismatches(manifest).map(
        (need): Diagnostic => ({
          severity: "warning",
          code: "theme-engine-version",
          message: `テーマ ${id} はエンジン API バージョン ${need} 向けのため、このエンジン（バージョン ${PLUGIN_API_VERSION}）では一部の見た目が表示されないことがあります`,
          messageEn: `The theme ${id} needs engine API version ${need}, but this engine provides version ${PLUGIN_API_VERSION}; some of its look may not show`,
          file: `themes/${id}/theme.json`,
          line: 1,
          hint: "Liminalia を新しいバージョンに更新するか、このエンジンに対応するバージョンのテーマを使います",
          hintEn: "Update Liminalia, or use a version of the theme made for this engine",
        }),
      );
    });
}

/**
 * 作品（とひな形）の liminalia.json の、合うエンジンの宣言（engines.liminalia・liminalia.api）を、このエンジンの口の版と比べる。
 * 合わなければ警告（engine-version）。
 */
export function projectEngineDiagnostics(config: unknown): Diagnostic[] {
  return engineMismatches(config).map((need) => ({
    severity: "warning",
    code: "engine-version",
    message: `このプロジェクトはエンジン API バージョン ${need} 向けのため、このエンジン（バージョン ${PLUGIN_API_VERSION}）では動かないことがあります`,
    messageEn: `This project needs engine API version ${need}, but this engine provides version ${PLUGIN_API_VERSION}; it may not work`,
    file: CONFIG_FILE,
    line: 1,
    hint: "Liminalia を新しいバージョンに更新します",
    hintEn: "Update Liminalia",
  }));
}

/** 合うエンジンの宣言のすべて（作品、プラグイン、作品の中のテーマ）。lim check と制作画面のチェックが出す。 */
export function engineVersionDiagnostics(project: Project): Diagnostic[] {
  return [...projectEngineDiagnostics(project.config), ...pluginManifestDiagnostics(project), ...themeManifestDiagnostics(project.root)];
}

/** プラグインのフォルダを、liminalia.json の plugins に書いた形で（見つからなければ作品からの相対パス）。 */
export function pluginSpec(project: Project, dir: string): string {
  for (const spec of project.config.plugins ?? []) {
    try {
      if (resolvePackageDir(project.root, spec) === dir) return spec;
    } catch {
      // 見つからない指定は、このフォルダではない
    }
  }
  const rel = relative(project.root, dir).split(sep).join("/");
  return rel.startsWith("..") || isAbsolute(rel) ? dir : `./${rel}`;
}

/**
 * 作品のデータ（paths.data の .json）を読む関数（命令の targets とプラグインの check が使う。無い・読めないものは undefined。読んだものは覚える）。
 * name の .json は省ける（名前に点があってもよい: code.en → code.en.json）。packDirs（packs/<フォルダ>。遊ぶ側の並び）を渡すと、
 * パックのデータ（packs/<フォルダ>/data）を重ねて読む（後ろのパックの同じ名前が勝つ。lim coverage と lim reach がパックを重ねて流すとき）。
 */
export function projectDataReader(project: Project, packDirs: readonly string[] = []): (name: string) => unknown {
  const cache = new Map<string, unknown>();
  // パック（packs/<フォルダ>/data）を重ねるときは、遊ぶ側と同じく後ろのパックの同じ名前のデータが勝つ
  const folders = [...packDirs.map((dir) => join(project.root, dir, "data")).reverse(), project.paths.data];
  return (raw) => {
    const name = raw.endsWith(".json") ? raw : `${raw}.json`;
    if (!cache.has(name)) {
      let value: unknown;
      try {
        for (const folder of folders) {
          const path = resolve(folder, ...name.split("/"));
          if (!path.startsWith(folder) || !existsSync(path)) continue;
          value = JSON.parse(readFileSync(path, "utf8"));
          break;
        }
      } catch {
        // 読めないデータは無いものとして渡す（データの形の誤りは lim check が知らせる）
        value = undefined;
      }
      cache.set(name, value);
    }
    return cache.get(name);
  };
}

/**
 * 素材のファイルの頭を読む関数（@liminalia/lang の missingAssets の head。Git LFS のポインタのままの素材を見分ける）。
 * ポインタのファイルは 1024 バイトより小さい（Git LFS の決まり）ので、それより大きいファイルは読まずに null。読めないファイルも null。
 * スマホ版の制作画面の fs の代わりにもある statSync と readFileSync だけを使う。
 */
export function assetHeads(assetsDir: string): (folder: string, path: string) => Uint8Array | null {
  return (folder, path) => {
    const file = join(assetsDir, folder, path);
    try {
      if (statSync(file).size >= 1024) return null;
      return readFileSync(file).subarray(0, LFS_HEAD_BYTES);
    } catch {
      // 読めない素材（フォルダや権限の無いもの）は、ポインタかどうかを見ない（無いことは missing-asset が知らせる）
      return null;
    }
  };
}

/**
 * 作品のフォルダの中のファイルを読む口（@liminalia/sdk の projectDiagnostics の projectFiles。作品の CSS ui.css の検査）。
 * パスは作品のフォルダからの / 区切り。ファイルでないもの、読めないものは無いものとする。
 */
export function projectFileReader(root: string): { text(path: string): string | null; exists(path: string): boolean } {
  const at = (path: string) => join(root, ...path.split("/"));
  const isFile = (path: string) => {
    try {
      return statSync(at(path)).isFile();
    } catch {
      // 無いファイル（作品の CSS が指す素材など）は、無いものとして lim check が知らせる
      return false;
    }
  };
  return {
    text: (path) => (isFile(path) ? readFileSync(at(path), "utf8") : null),
    exists: isFile,
  };
}

/**
 * 素材の本当の名前を引く関数（@liminalia/lang の missingAssets の actual）。大文字と小文字を問わずに探し、ファイルの名前どおりのパスを返す
 * （無ければ null）。Mac と Windows では大文字と小文字の違う名前でも開けてしまうので、existsSync ではなくフォルダの中身と突き合わせる。
 * 一度の検査のあいだだけ使う（フォルダの中身を覚えておく）。
 */
export function assetNames(assetsDir: string): (folder: string, path: string) => string | null | undefined {
  return assetNameResolver((segments) => {
    try {
      return readdirSync(join(assetsDir, ...segments));
    } catch {
      // 無いフォルダは null（素材が無いことは呼ぶ側が知らせる）
      return null;
    }
  });
}

/** 台本 → その台本が出す画像（projectShownImages の数え直しを省く。台本を読み直したら数え直す）。 */
const shownCache = new WeakMap<Script, string[]>();

/**
 * シナリオが出す画像（@liminalia/lang の shownImages）。台本は projectScripts で読む（変わっていないファイルは読み直さない）。
 * 下書き（// lim: draft）の画像は数えない。
 */
export function projectShownImages(project: Project): string[] {
  const out = new Set<string>();
  for (const [name, { script }] of projectScripts(project)) {
    let images = shownCache.get(script);
    if (!images) shownCache.set(script, (images = script.draft ? [] : shownImages([[name, script]])));
    for (const image of images) out.add(image);
  }
  return [...out];
}

/**
 * おまけの一覧（liminalia.json の extra）に、自動の登録（extra.cgAuto）を広げ、章の情報（chapters）で CG の見出しと章選択の題を補ったもの。
 * プレイヤーと書き出しはこれを渡す。
 */
export function projectExtra(project: Project, extra: ExtraConfig | undefined = project.config.extra, chapters: ChapterInfo[] | undefined = project.config.chapters): ExtraConfig | undefined {
  return extraWithChapters(extra?.cgAuto ? expandExtra(extra, projectShownImages(project)) : extra, chapters);
}

/** ファイル → 更新時刻と、話者を見分けて読んだ台本（projectScripts の読み直しを省く）。 */
const scriptCache = new Map<string, { mtime: number; speakers: string; script: Script; text: string }>();

/**
 * シナリオのフォルダの台本をすべて読む（名前は拡張子なし。数字を数として並べる）。変わっていないファイルは読み直さない。
 * overlays（パックの scenario のフォルダ）があれば、その台本を重ねる（同じ名前は差し替え、新しい名前は足す）。
 */
export function projectScripts(project: Project, overlays: readonly string[] = []): Map<string, { script: Script; text: string }> {
  const out = new Map<string, { script: Script; text: string }>();
  for (const dir of [project.paths.scenario, ...overlays]) readScenarioDir(project, dir, out);
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
}

/**
 * パック（packs/<フォルダ>/scenario）の台本（listPackSources。遊ぶ側の並び）。台本は、本体の話者にパックの cast.json の話者を足して読む
 * （遊ぶ側はパックの cast.json で本体のものを差し替える）。収録用の台本（lim voice-script と MCP の voice_script）と書体の切り詰めが読む。
 */
export function projectPackScripts(project: Project): { dir: string; scripts: Map<string, { script: Script; text: string }> }[] {
  let speakers: string[] = [];
  try {
    speakers = readCast(project).speakers;
  } catch {
    // cast.json が読めなければ話者なしで読む（読めないことは lim check が知らせる）
    speakers = [];
  }
  return listPackSources(project.root).map((p) => {
    const said = [...new Set([...speakers, ...p.speakers])];
    return { dir: p.dir, scripts: new Map([...p.scripts].map(([name, text]) => [name, { script: parse(text, name, { speakers: said }), text }])) };
  });
}

function readScenarioDir(project: Project, dir: string, out: Map<string, { script: Script; text: string }>): void {
  if (!existsSync(dir)) return;
  let speakers: string[] = [];
  try {
    speakers = readCast(project).speakers;
  } catch {
    // cast.json が読めなければ話者なしで数える（読めないことは lim check が知らせる）
    speakers = [];
  }
  const key = speakers.join("\u0000");
  for (const { name, path: file } of listScenarioFiles(dir)) {
    const mtime = statSync(file).mtimeMs;
    let hit = scriptCache.get(file);
    if (!hit || hit.mtime !== mtime || hit.speakers !== key) {
      const { text, encoding } = readScenarioFile(file);
      const script = parse(text, name, { speakers });
      // UTF-8 で読めない台本（Shift_JIS など）は、化けたまま読んだことを誤りにする
      if (encoding) script.diagnostics.unshift(encodingDiagnostic(name, encoding));
      hit = { mtime, speakers: key, script, text };
      scriptCache.set(file, hit);
    }
    out.set(name, { script: hit.script, text: hit.text });
  }
}

/**
 * 作品が使う標準の命令の描画の部品（std-features.ts の stdWebFeaturesOf）。書き出しのエンジンは、これを始めに読み、ほかの部品は描くときに読む
 * （packages/web/vite.config.ts）。台本は下書き（// lim: draft）を除き、プラグインは標準の命令のほかの、書き出しに入る入口（"./web"・"./commands"）から見る。
 */
export function stdWebFeatures(project: Project): string[] {
  return stdWebFeaturesOf({
    scripts: [...projectScripts(project).values()].filter((s) => !s.script.draft).map((s) => s.script),
    ui: project.config.ui as Parameters<typeof stdWebFeaturesOf>[0]["ui"],
    dataDir: project.paths.data,
    plugins: project.plugins
      .filter((dir) => resolve(dir) !== resolve(STD_PLUGIN))
      .map((dir) => ({ dir, entries: (["web", "commands"] as const).flatMap((entry) => pluginEntry(dir, entry) ?? []) })),
  });
}

/**
 * 遊ぶ人に見せるフローチャート（@liminalia/lang の buildFlow）。作品の命令のプラグインが教える飛び先も使う。
 * 開発サーバーは /project/flow.json で、書き出しは project/flow.json として渡す。下書き（// lim: draft）のファイルは入れない。
 */
export async function projectFlow(project: Project, overlays: readonly string[] = []): Promise<Flow> {
  const plugins = combinePlugins(await loadCommandPlugins(project));
  const hooks = new Map<string, TargetHook>();
  for (const c of plugins.commands) if (c.targets) hooks.set(c.name, c.targets.bind(c));
  const scripts = new Map([...projectScripts(project, overlays)].filter(([, s]) => !s.script.draft));
  const data = projectDataReader(project);
  const map = buildStoryMap({
    scripts,
    registry: createRegistry(CORE_COMMANDS, plugins.specs),
    entry: project.config.entry,
    hooks,
    data,
    ...(project.config.variables ? { variables: project.config.variables } : {}),
    ...(project.config.endingKinds ? { endingKinds: project.config.endingKinds } : {}),
  });
  return buildFlow(map, new Map([...scripts].map(([name, s]) => [name, s.script])));
}

/** 収録用の台本の、全体と集計のファイルの名前（拡張子なし。話者ごとのファイルは話者の名前）。 */
export const VOICE_SCRIPT_FILES: Record<"ja" | "en", { all: string; summary: string }> = {
  ja: { all: "全体", summary: "集計" },
  en: { all: "all", summary: "summary" },
};

/**
 * 収録用の台本を CSV で書き出す（@liminalia/lang の voiceScript）。全体.csv（全員の台詞を台本の順に）・話者ごとの <話者>.csv・
 * 集計.csv（話者ごとの台詞の数と文字数とボイスが決まっていない台詞の数）。Excel で開けるよう BOM を付ける。folder は既定で exports/voice-script。
 */
export function exportVoiceScript(project: Project, folder = resolve(project.root, "exports/voice-script"), language: "ja" | "en" = "ja"): { folder: string; lines: number; speakers: number; missing: number } {
  const en = language === "en";
  const scripts = projectScripts(project);
  let lock: VoiceLock | null = null;
  try {
    lock = readVoiceLock(project);
  } catch {
    // 番号の固定が読めなければ、固定していない台本として作る（読めないことは lim check が知らせる）
    lock = null;
  }
  // 演技のメモは //! の行（liminalia.json の voiceScript.notes が "comments" なら、前のとおりすべての // の行）
  // パックの台詞も並べる（遊ぶ側はパックの台詞にも本体の番号の固定を使う）
  const rows = voiceScriptRows(scripts, lock, { notes: project.config.voiceScript?.notes, entry: project.config.entry, packs: projectPackScripts(project) });
  mkdirSync(folder, { recursive: true });
  // 鳴らない台詞の理由、ボイスのファイルがあるか（大文字と小文字も合わせる）、書き換えて録り直す台詞
  const assetName = assetNames(project.paths.assets);
  const fileState = (r: VoiceScriptRow) => {
    if (r.voice === "") return "";
    const real = assetName(r.folder, r.voice);
    const found = real === undefined ? existsSync(join(project.paths.assets, r.folder, r.voice)) : real === r.voice;
    return found ? (en ? "yes" : "ある") : en ? "missing" : "無い";
  };
  const silentText = (r: VoiceScriptRow) => (r.silent === "no-auto" ? (en ? "No @voice and @voice-auto isn't on" : "@voice も @voice-auto も効いていない") : r.silent === "unlocked" ? (en ? "No number in voice-lock.json" : "番号の固定に番号が無い") : "");
  const header = en
    ? ["Voice", "Speaker", "Line", "Direction", "Previous line", "Scene", "Location", "Why it doesn't play", "File", "Re-record"]
    : ["ボイス", "話者", "台詞", "演技のメモ", "前の行", "シーン", "位置", "鳴らない理由", "ファイル", "要再収録"];
  // 同時に鳴らすほかの話者のボイス（@voice who=）は、台詞の話者と同時に話すことを演技のメモの頭に書く
  const note = (r: VoiceScriptRow) => (r.speakerOfLine ? [en ? `Together with ${r.speakerOfLine}` : `${r.speakerOfLine}と同時`, r.note].filter((x) => x !== "").join(en ? "; " : "、") : r.note);
  // 位置は本体の台本の名前（パックの台詞はパックの scenario からのパス）と行
  const line = (r: VoiceScriptRow) => [r.voice, r.speaker, r.text, note(r), r.previous, r.scene, `${r.pack ? `${r.pack}/scenario/` : ""}${r.file}:${r.line}`, silentText(r), fileState(r), r.rerecord ? (en ? "re-record" : "要再収録") : ""];
  const write = (name: string, table: (string | number)[][]) => writeFileSync(join(folder, `${name}.csv`), `\uFEFF${toCsv(table)}`);
  // 全体と集計のファイルの名前。日本語は前からの名前のまま（既に使っている人の手順を壊さない）、英語は all.csv と summary.csv
  const names = VOICE_SCRIPT_FILES[language];
  write(names.all, [header, ...rows.map(line)]);
  const bySpeaker = new Map<string, VoiceScriptRow[]>();
  for (const r of rows) (bySpeaker.get(r.speaker) ?? bySpeaker.set(r.speaker, []).get(r.speaker)!).push(r);
  for (const [speaker, list] of bySpeaker) write(speaker.replace(/[\\/:*?"<>|]/g, "_"), [header, ...list.map(line)]);
  const chars = (list: VoiceScriptRow[]) => list.reduce((n, r) => n + [...r.text.replace(/《[^》]*》/g, "")].length, 0);
  write(names.summary, [en ? ["Speaker", "Lines", "Characters", "Lines without a voice file"] : ["話者", "台詞の数", "文字数", "ボイスが決まっていない台詞"], ...[...bySpeaker].map(([speaker, list]) => [speaker, list.length, chars(list), list.filter((r) => r.voice === "").length])]);
  return { folder, lines: rows.length, speakers: bySpeaker.size, missing: rows.filter((r) => r.voice === "").length };
}

/**
 * 校正用の台本を書き出す（@liminalia/lang の scriptExportText・scriptExportHtml）。ファイルごとに本文とシーンの見出しだけを、話者名を添えて
 * テキスト（ルビは ｜親文字《よみ》）か HTML（<ruby>。index.html から各ファイルへ）にする。folder は既定で exports/script。
 * lines ならテキストの行の頭に .lim の行番号を付ける（HTML はいつも付ける）。下書き（// lim: draft）も書き出す（校正するもの）。
 * パック（packs/<フォルダ>/scenario）の台本も、本体の台本のあとに packs/<フォルダ>/scenario/<台本> の名前で書き出す。
 */
export function exportScriptText(project: Project, o: { format?: "text" | "html"; folder?: string; lines?: boolean; language?: "ja" | "en" } = {}): { folder: string; files: number; lines: number } {
  const format = o.format ?? "text";
  const folder = o.folder ?? resolve(project.root, "exports/script");
  const en = o.language === "en";
  const choiceLabel = en ? "Choice" : "選択肢";
  const scripts = projectScripts(project);
  for (const pack of projectPackScripts(project)) for (const [name, s] of pack.scripts) scripts.set(packScenarioPlace(pack.dir, name), s);
  mkdirSync(folder, { recursive: true });
  let lines = 0;
  const index: string[] = [];
  for (const [name, { script }] of scripts) {
    const path = join(folder, `${name}.${format === "html" ? "html" : "txt"}`);
    mkdirSync(dirname(path), { recursive: true });
    lines += scriptExportLines(script).filter((l) => l.kind !== "label").length;
    if (format === "html") {
      writeFileSync(path, scriptExportHtml(name, script, { lang: project.config.languages?.[0] ?? "ja", choiceLabel, title: project.config.title }));
      index.push(`<li><a href="${encodeURI(`${name}.html`)}">${name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}.lim</a>${script.draft ? (en ? " (draft)" : "（下書き）") : ""}</li>`);
    } else writeFileSync(path, scriptExportText(name, script, { lines: o.lines === true, choiceLabel }));
  }
  if (format === "html") {
    const title = project.config.title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    writeFileSync(join(folder, "index.html"), `<!doctype html>\n<html lang="${project.config.languages?.[0] ?? "ja"}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>body { font-family: serif; max-width: 44em; margin: 2em auto; padding: 0 1em; line-height: 1.9; color: #222; background: #fff; }</style>\n</head>\n<body>\n<h1>${title}</h1>\n<ul>\n${index.join("\n")}\n</ul>\n</body>\n</html>\n`);
  }
  return { folder, files: scripts.size, lines };
}

/** 作品のフォルダの packs/ にあるパック（pack.json のあるフォルダ）。 */
export function projectPacks(project: Project): string[] {
  const dir = join(project.root, "packs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "pack.json")))
    .map((d) => join(dir, d));
}

/**
 * パックを書き出す（lim pack と lim build が使う）。packDir の pack.json・scenario・data・assets を out へ写し、
 * pack.json に中身の一覧（files）を足し、本体に重ねたフローチャート（flow.json）を置く。台本の書き方の誤りは problems に返す。
 */
export async function buildPack(project: Project, packDir: string, out: string): Promise<{ manifest: PackManifest; problems: string[] }> {
  const manifest = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as PackManifest;
  if (typeof manifest.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(manifest.id)) throw new Error(`${join(packDir, "pack.json")} の id は英数字、_、- で書きます`);
  const files: NonNullable<PackManifest["files"]> = { scenario: [], data: [], assets: [] };
  const problems: string[] = [];
  const walk = (dir: string, base = ""): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]))
      : [];
  mkdirSync(out, { recursive: true });
  const copy = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  };
  let speakers: string[] = [];
  try {
    speakers = readCast(project).speakers;
  } catch {
    // cast.json が読めなければ話者なしで読む（読めないことは lim check が知らせる）
    speakers = [];
  }
  for (const f of walk(join(packDir, "scenario")).filter((f) => f.endsWith(".lim"))) {
    const name = f.slice(0, -".lim".length);
    const text = readFileSync(join(packDir, "scenario", f), "utf8");
    for (const d of parse(text, name, { speakers }).diagnostics) if (d.severity === "error") problems.push(`${name}.lim:${d.line} ${d.message}`);
    files.scenario.push(name);
    copy(join(packDir, "scenario", f), join(out, "scenario", f));
  }
  for (const f of walk(join(packDir, "data"))) {
    files.data.push(f);
    copy(join(packDir, "data", f), join(out, "data", f));
  }
  for (const f of walk(join(packDir, "assets"))) {
    files.assets.push(f);
    copy(join(packDir, "assets", f), join(out, "assets", f));
  }
  // キャスト（cast.json を丸ごと）と訳（lang/<言語>.json）の差し替え
  if (existsSync(join(packDir, "cast.json"))) {
    files.cast = true;
    copy(join(packDir, "cast.json"), join(out, "cast.json"));
  }
  const lang = walk(join(packDir, "lang")).filter((f) => f.endsWith(".json") && !f.includes("/"));
  if (lang.length > 0) {
    files.lang = lang.map((f) => f.slice(0, -".json".length));
    for (const f of lang) copy(join(packDir, "lang", f), join(out, "lang", f));
  }
  const written: PackManifest = { ...manifest, files };
  writeFileSync(join(out, "pack.json"), `${JSON.stringify(written, null, 2)}\n`);
  // 本体に重ねたフローチャート（パックが分岐を足したり変えたりしたとき、遊ぶ人の画面はこちらを使う）
  writeFileSync(join(out, "flow.json"), JSON.stringify(await projectFlow(project, [join(packDir, "scenario")])));
  return { manifest: written, problems };
}

