import type { Diagnostic } from "./ast.ts";
import { parseExpr } from "./expr.ts";
import { uiCssPathProblem } from "./ui-css.ts";

/**
 * ゲームの見た目と操作の設定。liminalia.json の ui に書く（どれも省略でき、省略は既定のシステム画面の見た目）。
 * 長さは舞台の px、色は CSS の色、画像は素材のフォルダからのパス（どのフォルダかは項目ごとに決まっている）。
 * TyranoBuilder の「ゲームの設定」（文字・メッセージ枠・名前・クリック待ち・既読・選択肢・タイトル・セーブ・キー）にあたる。
 */
export interface UiConfig {
  /** 読み込む書体（others からのパス）。本文・名前・選択肢・システム画面の font から family の名前で使う。 */
  fonts?: UiFont[];
  text?: UiText;
  message?: UiMessage;
  name?: UiName;
  glyph?: UiGlyph;
  choice?: UiChoice;
  /** チャットの画面（@chat-open と、dialogue なら ふだんの台詞）の配色と形。書かなければ @chat の見た目は既定のまま。 */
  chat?: UiChat;
  system?: UiSystem;
  /** 結末の名前の画面（@title-screen ending=）の見た目。書かなければ、システム画面の値（system の titleBg・fg・accent）と本文の書体で描く。 */
  ending?: UiEnding;
  /** 章の扉と章末（@chapter-card、@chapter-end）の見た目。書かなければ、システム画面の値（system の titleBg・fg・accent）と本文の書体で描く。 */
  chapter?: UiChapter;
  /** NVL（@nvl on）の見た目。書かなければ、暗い地に本文の書体と大きさで下から積む。 */
  nvl?: UiNvl;
  /**
   * 名前を付けた NVL の見た目（名前 → 見た目）。`@nvl on style=letter` で選び、書いた項目だけ nvl の上に重ねる
   * （手紙、文書、端末の画面のような「別の紙に本文を書く」場面を、本文のまま書く）。
   */
  nvlStyles?: Record<string, UiNvl>;
  title?: UiTitle;
  /** ゲーム中の操作の帯（メッセージ枠の下のボタンの並び）。 */
  menuBar?: UiMenuBar;
  /**
   * オート中・スキップ中の表示の位置（hidden は出さない）。既定は top-left。作品が操作の帯を差し替えているとき（screens.menuBar）は、
   * 表示も差し替えて（screens.indicator）いなければ hidden。
   */
  indicator?: (typeof INDICATOR_POSITIONS)[number];
  /**
   * マウスのカーソルの画像（image からのパス）と、押す点（画像の左上からの px）。animated なら画像を舞台の上に描いてマウスに
   * 付いて動かす（GIF・APNG の動きが出る。OS のカーソルは動く画像を動かさないため）。
   */
  cursor?: { image: string; x?: number; y?: number; animated?: boolean };
  /** 押した（触れた）ところに出す演出。画像（image からのパス）を出して消し、効果音（sound からのパス）を鳴らす。 */
  tap?: UiTap;
  /**
   * 背景を舞台に合わせて切り抜くときの焦点。背景のファイルの名前（bgimage からのパス）→ 残す位置（CSS の object-position。"30% 50%" など）。
   * "*" はそれ以外のすべての背景。書いていなければ真ん中。縦長の作品で横長の背景を使うときなど、画面と縦横比が違う背景に効く。タイトルの背景にも効く。
   */
  backgroundFocus?: Record<string, string>;
  /**
   * 作品の画面のテンプレート（画面の名前 → テンプレートの HTML のファイル。作品のフォルダ（liminalia.json のあるところ）からのパスで、ui/screens/confirm/confirm.html など）。
   * 標準の画面を写して HTML と CSS で直したもの。部品（<template data-part>）ごとに標準のテンプレートに重なるので、部品一つだけを書いてもよい。
   * 同じ画面をプラグインの screens.* が差し替えていれば、そちらが先。書ける画面は confirm（確認）、menu（メニュー）、help（操作の説明）、ending（エンディング）、
   * choice（選択肢）、saveload（セーブとロード）、backlog（履歴）、title（タイトル）、config（コンフィグ）。
   */
  templates?: Record<string, string>;
  /**
   * 画面。fullscreen を false にすると全画面にさせない（設定画面の「画面」を出さず、Alt+Enter・F11 も効かない）。
   * pauseScenario は、標準の画面（設定・セーブ・ロード・履歴など）を開いている間、シナリオの次の命令を止めるか
   * （@wait の残りや時間で進む演出が、画面の裏で先へ進まない。既定は止める。false で前の版と同じく止めない）。
   * textScale はコンフィグの「文字サイズ」を効かせる範囲で、all（本文・選択肢・名前欄・バックログ・システム画面。既定）か
   * message（本文と選択肢だけ。作品が名前欄やシステム画面を決まった大きさで組んでいるとき）。
   * pauseInBackground を false にすると、タブを裏へ回したとき（ほかのタブ・ウィンドウを最小化など）も音・動画・オート・
   * 選択肢の制限時間を止めない（既定は止め、戻ったら続ける）。
   */
  screen?: { fullscreen?: boolean; pauseScenario?: boolean; textScale?: "all" | "message"; pauseInBackground?: boolean };
  /** セーブの枠の数（8 の倍数に切り上げる。8〜200。既定 48）。 */
  saveSlots?: number;
  /**
   * オートセーブ。slots は枠の数（0〜10。既定 3。新しいもので古いものを置き換えて回す。0 なら持たず、@autosave も何もしない）。
   * leave は、終了するときと裏へ回ったとき（タブを切り替える・スマホでホームへ戻るなど）にもオートセーブするか
   * （既定は true。ロード画面を作品が差し替えているときは false）。
   * on はほかに保存する時機。choice は選択肢を出したとき（既定 true）、chapter は章の頭（liminalia.json の chapters の
   * ファイルが替わった最初のページと、おまけの章の始まり。既定 false）、pages はこのページ数を読むごと（0 か書かなければしない）。
   */
  autosave?: UiAutosave;
  /**
   * クイックセーブ。slots は枠の数（1〜10。既定 3）。クイックセーブは空いている枠か、いちばん古い枠に書き、
   * クイックロードはいちばん新しい枠から読む。1 なら一つの枠を上書きし続ける。
   */
  quickSave?: { slots?: number };
  /**
   * セーブの一覧に出す章の名前。"ファイル#ラベル" か "ファイル" → 名前（今いるラベル、ファイルの順に探す）。
   * 書いていなければ、おまけの章（extra.chapters）に着いていればその題、そうでなければファイルの名前。プラグインの slotChapter が先。
   */
  chapterNames?: Record<string, string>;
  /** 履歴に残すページの数（10〜2000。既定 300）。 */
  backlog?: number;
  /** 選んだ選択肢を履歴に残すか（既定 true。@choice の選択肢を選んだとき。時間切れで default を選んだときも）。 */
  backlogChoices?: boolean;
  /** はじめて遊ぶ人の設定画面の値。 */
  defaults?: UiDefaults;
  /** キーの割り当て（KeyboardEvent.key の名前。"Enter"・" "・"Escape"・"s" など）。書いた操作だけ既定を置き換える。 */
  keys?: Partial<Record<UiKeyAction, string[]>>;
  /**
   * マウスの割り当て。rightClick はゲーム中の右クリックで、menu（メニューを開く。既定）か hide（文字の枠を隠す・戻す）。
   * wheelUp はホイールを上へ回したときで、backlog（履歴を開く。既定）か rollback（一ページ戻る）。
   * 下へ回すと、戻ったところからは進め直し、そうでなければ読み進める。
   * swipeSide は指で横になぞったときで、rollback（右へなぞると一ページ戻り、左へなぞると進め直す。既定）か none（何もしない）。
   * skipEffects を false にすると、クリック・決定キー・タップで演出（背景や立ち絵の切り替え、カメラ、揺れ、暗転、@wait など）を
   * 終わりまで飛ばさない（既定は飛ばす。命令ごとに止めるなら、その命令の skip=false）。
   * middleClick はホイールを押したときで、hide（ウィンドウを消す・戻す。既定）か none（何もしない）。
   * numberKeys を false にすると、数字のキー（1〜9）で選択肢を選ばない（既定は選ぶ）。
   */
  input?: { rightClick?: "menu" | "hide"; wheelUp?: "backlog" | "rollback"; swipeSide?: "rollback" | "none"; skipEffects?: boolean; middleClick?: "hide" | "none"; numberKeys?: boolean };
  /** 巻き戻し（一ページずつ戻る・進め直す）。 */
  rollback?: UiRollback;
  /**
   * 立ち絵の色調（@tone）の名前 → 中身。組み込み（sepia・mono・night・evening・dark）と同じ名前なら置き換える。
   * color（掛け合わせる色）と amount（その強さ 0〜1。既定 1）、saturation（彩度。1 でそのまま、0 で白黒）、
   * brightness（明るさ。1 でそのまま）、contrast（1 でそのまま）。
   */
  tones?: Record<string, UiTone>;
  /**
   * 背景の色調。背景のファイルの名前（bgimage からのパス）→ 色調の名前（tones か組み込み）。その背景が出ている間は、@tone を書いていない
   * 立ち絵にこの色調を掛ける（暗い部屋や夕方の背景で立ち絵だけが明るく浮かないように）。@bg の tone= が先。
   */
  backgroundTones?: Record<string, string>;
  /**
   * 次の選択肢へ。readOnly が true なら、次の選択肢まで既読のときだけ飛ぶ（未読があれば知らせるだけ）。
   * 既定（false）はスキップの設定に従い、「既読のみ」なら選択肢の手前の未読のページで止まる。
   */
  nextChoice?: { readOnly?: boolean };
  /**
   * 顔ウィンドウ。話している人物の顔をメッセージ枠の中（side の側。既定は左）に出し、本文をその分ずらす。
   * 顔の絵はキャストの差分の face か、立ち絵セットの face（立ち絵から切り出す範囲）。どちらも無い人物は出さない。
   * show が offstage なら、その人物の立ち絵を表示していないときだけ出す（既定 always）。width・height は枠の大きさ（px。既定 180）。
   * 縦書き・NVL・吹き出しのあいだは出さない。
   */
  face?: UiFace;
  /**
   * 立ち絵の見せ方（シナリオで書いたもの（@chara-config）が優先する）。focus は話者強調で、話していないキャラクターの立ち絵を沈める
   * （名前欄の話者とキャラクター ID か cast.json の speaker が同じキャラクターを、話している人とみなす。地の文と、話者の立ち絵が出ていないときは誰も変えない）。
   */
  chara?: UiChara;
  /**
   * 効果音と BGM の字幕（コンフィグで「効果音の字幕」をオンにした人に、画面の右上に少しのあいだ出す）。
   * sounds は効果音のファイル（sound からのパス）→ 字幕（@se の caption= が優先）。music が true なら、BGM が替わったときに
   * おまけの音楽の一覧（extra.music）の題名を出す。
   */
  captions?: { sounds?: Record<string, string>; music?: boolean };
  /**
   * 操作説明の画面（メニューの「操作説明」と @open-screen help）。操作の表は今の割り当てから作り、pages（題・絵・文）をタブにして足す。
   * title が true ならタイトル画面にも「操作説明」を出す。
   */
  help?: { pages?: UiHelpPage[]; title?: boolean };
  /**
   * システムボイス（voice フォルダの音）。title はタイトル画面を出したとき（タイトルコール）、actions は操作したとき
   * （"start"・"continue"・"extra" と、メニューの操作 "save"・"load"・"auto" など）、confirm は確認のダイアログを出したとき。
   * 候補が複数あれば、if（全セーブ共通の変数の式。クリア後だけ、など）が真のものから一つを選ぶ。character を書くと、
   * 遊ぶ人がコンフィグで担当のキャラクターを選べる。volume は 0〜100（既定 100）。
   */
  systemVoice?: UiSystemVoice;
  /**
   * 表現を控えめにする設定（設定画面に出す）。台本は system.content_filter で分け、assets（"種類/パス" → 控えめのときに使う同じ種類のパス）で素材を差し替える。
   * label は設定画面の項目の名前、default ははじめの値。
   */
  contentFilter?: { label?: string; default?: boolean; assets?: Record<string, string> };
  /** 起動したときにタイトルの前に出す注意書き（年齢・表現・光の点滅など）。文を変えたら、同意した人にも出し直す。always ならいつも出す。 */
  contentWarning?: { title?: string; text: string; button?: string; always?: boolean };
  /**
   * 起動の演出（「クリックで開始」のあと、タイトルの前に一度だけ流す）。ロゴを順に出し、注意書きを出す。プラグインの splash があればそちらを使う。
   * 押す（クリック・Enter・Space）と次へ進む（skip が false なら進まない）。
   */
  splash?: UiSplash;
  /** 設定の幅（設定画面のつまみの幅と、保存した値を収める幅）。 */
  settings?: UiSettings;
  /**
   * 音。movie は動画（@movie・@bg-movie・@blend-movie・おまけのムービー）の音に掛けるコンフィグの音量で、bgm（既定）・se・voice・
   * none（全体の音量だけ）。動画の音量は「命令の volume × その音量 × 全体の音量」になり、ミュートも効く。
   */
  /**
   * 音。movie は動画の音に掛ける系統。streamBgm を false にすると、長い BGM（1MB より大きいもの）も展開して鳴らす
   * （既定はストリーミング再生。ループのつなぎ目はデコードした方が正確）。
   * ui はシステム画面の効果音（sound からのパス。効果音の音量で鳴らす）。hover はボタンにマウスが乗ったときとキー・パッドで選んだとき、
   * select は押したとき、cancel は閉じるボタン・Esc・右クリック・B で戻ったとき、open と close は画面を開いた・閉じたとき、
   * page はタブを替えたとき、choice は選択肢を選んだとき。既定の画面とプラグインの部品（ui.button など）の両方で鳴る。
   */
  sound?: { movie?: "bgm" | "se" | "voice" | "none"; streamBgm?: boolean; ui?: UiSounds };
  /**
   * 言語ごとの見た目（言語 → 書き換える項目）。遊んでいる言語のものを、上の設定に重ねる（項目ごとに、書いたものだけ置き換える。
   * fonts は足す）。書けるのは UI_LANGUAGE_GROUPS（書体、本文、メッセージ枠、名前の欄、クリック待ち、選択肢、チャット、システム画面、結末の画面、章の扉）。
   * 原文の言語にも書ける。
   */
  languages?: Record<string, UiLanguageOverride>;
  /**
   * 作品の CSS（作品のフォルダからの CSS のファイルのパスの並び。"ui/screens.css" など）。テーマとプラグインの CSS のあとに、この順で読む
   * （後のものが勝つ。エンジンの CSS はカスケードレイヤーの中なので、詳細度を競わずに勝つ）。中の url() と @import は、そのファイルからの
   * 相対のパスで作品のフォルダの中を指すか data: だけ（作品の外は読まない）。書き出しに入り、開発サーバーでは保存するとその場で差し替わる。
   */
  css?: string[];
}

/** ui.languages の言語ごとに書き換えられる項目。 */
export const UI_LANGUAGE_GROUPS = ["fonts", "text", "message", "name", "glyph", "choice", "chat", "system", "ending", "chapter"] as const;

/** システム画面の効果音の種類（ui.sound.ui）。 */
export const UI_SOUND_KINDS = ["hover", "select", "cancel", "open", "close", "page", "choice"] as const;
export type UiSoundKind = (typeof UI_SOUND_KINDS)[number];
/** システム画面の効果音（種類 → sound からのパス）。 */
export type UiSounds = Partial<Record<UiSoundKind, string>>;

/** 言語ごとの見た目（ui.languages の一つ）。 */
export type UiLanguageOverride = Pick<UiConfig, (typeof UI_LANGUAGE_GROUPS)[number]>;

/**
 * 遊んでいる言語の見た目（ui.languages のその言語のものを重ねたもの）。書いていなければ ui そのもの。
 * 項目ごとに、書いたものだけを置き換える（text.size だけ書けば、本文のほかの設定はそのまま）。fonts は足す。
 */
export function uiForLanguage(ui: UiConfig | undefined, language: string): UiConfig | undefined {
  const o = ui?.languages?.[language];
  if (!ui || !o || typeof o !== "object") return ui;
  const out: UiConfig = { ...ui };
  for (const key of UI_LANGUAGE_GROUPS) {
    const v = o[key];
    if (v === undefined) continue;
    if (key === "fonts") out.fonts = [...(Array.isArray(ui.fonts) ? ui.fonts : []), ...(Array.isArray(v) ? (v as UiFont[]) : [])];
    else if (v && typeof v === "object") (out as Record<string, unknown>)[key] = { ...((ui as Record<string, unknown>)[key] as object | undefined), ...(v as object) };
  }
  return out;
}

/**
 * 巻き戻し。enabled は使えるか（既定 true）。fixChoices は、戻ってから同じ選択肢に来たとき前に選んだものしか選べなくするか（既定 false。
 * false なら選び直せる）。戻れるのは新しいページから 100 ページまで。既読・おまけの解放・設定は戻さない。
 */
/** システムボイスの候補。文字だけならファイル。 */
export type UiVoiceEntry = string | { file: string; if?: string; character?: string };

export interface UiSystemVoice {
  title?: UiVoiceEntry[];
  actions?: Record<string, UiVoiceEntry[]>;
  confirm?: UiVoiceEntry[];
  volume?: number;
}

/** システムボイスの候補をすべて（ファイル・条件・担当）。 */
export function systemVoiceEntries(v: UiSystemVoice | undefined): { file: string; if?: string; character?: string; where: string }[] {
  const out: { file: string; if?: string; character?: string; where: string }[] = [];
  const add = (list: UiVoiceEntry[] | undefined, where: string) => {
    for (const e of list ?? []) out.push(typeof e === "string" ? { file: e, where } : { ...e, where });
  };
  add(v?.title, "systemVoice.title");
  for (const [k, list] of Object.entries(v?.actions ?? {})) add(list, `systemVoice.actions.${k}`);
  add(v?.confirm, "systemVoice.confirm");
  return out;
}

export interface UiRollback {
  enabled?: boolean;
  fixChoices?: boolean;
}

/**
 * 設定の幅。文字の速さ（一文字のミリ秒。既定 0〜80、刻み 5）・オートの待ち（ミリ秒。既定 500〜5000、刻み 100）と、
 * オートで本文一文字ごとに足す待ち（ミリ秒。既定 25）。
 */
export interface UiSettings {
  /**
   * 音量の欄の試聴（コンフィグの音量を動かし終えたら、その音量で鳴らす）。bgm は bgm、se は sound、voice は voice からのパス。
   * BGM は鳴っていないとき（タイトルなど）だけ鳴らし、コンフィグを閉じたら止める。
   */
  samples?: { bgm?: string; se?: string; voice?: string };
  textSpeedMin?: number;
  textSpeedMax?: number;
  textSpeedStep?: number;
  autoWaitMin?: number;
  autoWaitMax?: number;
  autoWaitStep?: number;
  autoPerChar?: number;
  /**
   * コンフィグの話者ごとの声の音量に並べる人物。heard（既定）は声を聞いた人物だけ、all は cast.json の話者をはじめから並べ、
   * masked は並べたうえで、まだ声を聞いていない人物の名前を「？？？」で伏せる。
   */
  voiceSpeakers?: "heard" | "all" | "masked";
}

export interface UiFont {
  /** CSS の font-family で呼ぶ名前。 */
  family: string;
  /** 書体のファイル（others からのパス）。 */
  file: string;
  /** 太さ（CSS の font-weight）。 */
  weight?: string | number;
}

/** 画像の四辺の切り分け（px。一つなら四辺とも、四つなら上・右・下・左）。角を伸ばさず、辺と中だけを伸ばす。 */
export type UiImageSlice = number | [number, number, number, number];

export interface UiText {
  /** 本文の書体（CSS の font-family）。 */
  font?: string;
  /** 書体のファイル（others からのパス。.woff2・.woff・.ttf・.otf）。読み込んで font より先に使う。 */
  fontFile?: string;
  /** 文字の大きさ（px。既定 26）。 */
  size?: number;
  color?: string;
  /** 行の高さ（文字の大きさの倍率。既定 1.75）。 */
  lineHeight?: number;
  /** 文字の飾り。shadow は影、edge は縁取り。 */
  decoration?: "none" | "shadow" | "edge";
  decorationColor?: string;
  /** 文字の影（CSS の text-shadow。decoration より優先する）。 */
  shadow?: string;
  /** 文字の縁（CSS の -webkit-text-stroke。"0.5px #000" など）。 */
  stroke?: string;
  /** 字間（CSS の letter-spacing。"1.6px"・"0.04em" など）。 */
  letterSpacing?: string;
  /** 太さ（CSS の font-weight）。 */
  weight?: string | number;
  /** 本文の上に空ける長さ（px）。 */
  topGap?: number;
  /** 既読のページの本文の色（省略で変えない）。 */
  readColor?: string;
  /** 本文の揃え（既定 left）。中央にしても、文字を出す途中で行が動かない（ルビも同じ）。 */
  align?: "left" | "center" | "right";
  /** ルビの文字の大きさ（親文字に対する倍率。既定 0.45）。縦書きのルビの位置もこれから決まる。 */
  rubySize?: number;
  /** NVL の段落と段落のあいだ（文字の大きさの倍率。既定 0.5。0 なら段落の終わりでちょうど一行分だけ進む）。縦書きでも同じ。 */
  paragraphGap?: number;
  /** ルビと親文字のあいだ（親文字の大きさの倍率。既定 0）。縦書きでは親文字の右との間。ルビの大きさを変えても位置はずれない。 */
  rubyGap?: number;
  /** 一行の字数（全角で数える。書かなければ枠の幅いっぱい）。縦書きなら一列の字数。 */
  lineChars?: number;
  /**
   * 禁則の強さ（CSS の line-break）。strict は行頭に小さい「ッ」「ゃ」や「ー」も置かない、normal は標準、loose は緩め、anywhere はどこでも折る、
   * auto はブラウザに任せる。書かなければ、遊んでいる言語（<html lang>）が日本語か中国語なら strict、ほかは auto
   * （前の版の既定は言語によらず auto。前と同じにするなら auto と書く）。
   * 行頭禁則の文字の一覧は指定できない（ブラウザの禁則処理に任せる）。
   */
  lineBreak?: "auto" | "strict" | "normal" | "loose" | "anywhere";
  /** 行末の句読点（、。）をぶら下げる（CSS の hanging-punctuation。Safari・iOS だけが対応。ほかでは何もしない）。 */
  hangingPunctuation?: boolean;
  /** 傍点（{dot …}）の形（CSS の text-emphasis-style。既定 "filled sesame"。"filled dot"、"open circle" など）。 */
  emphasis?: string;
  /**
   * 台詞の外側の括弧と引用符。keep（既定）は書いたまま出す。strip は台詞の本文の外側の一組（「…」『…』“…”"…"）を外して中身だけを出す
   * （始まりの印が本文の最初の字で、対になる閉じが最後の字のときだけ。（…）は心の声として残す）。
   * メッセージ枠・NVL・バックログ・吹き出し（@balloon と、チャットの画面のふだんの台詞）に効く。言語ごとに替えられる（ui.languages）。
   * チャットの画面は、keep でも「…」『…』を外す（吹き出しが括弧の代わりなので）。
   */
  quotes?: "keep" | "strip";
  /**
   * 本文の一文字の出し方。fade（既定）は浮き出る、none はフェードせずに一文字ずつ出す、rise は少し下から浮かび上がる。
   * revealTime は一文字が出きるまでの長さ（ミリ秒。既定 120。none では使わない）。文字送りの速さ（一文字ずつの間隔）は設定画面と @text-speed で決まる。
   * 作品の CSS とプラグインからは、公開の CSS 変数 --lm-reveal-animation・--lm-reveal-time・--lm-reveal-easing と、本文の一文字の要素（.ch・.ch.shown）で変えられる。
   */
  reveal?: "fade" | "none" | "rise";
  revealTime?: number;
}

export interface UiTone {
  color?: string;
  amount?: number;
  saturation?: number;
  brightness?: number;
  contrast?: number;
}

export interface UiHelpPage {
  title: string;
  /** 絵（image からのパス）。 */
  image?: string;
  text?: string;
}

export interface UiFace {
  /** always: 話者の顔を常に。offstage: 立ち絵がないときだけ。explicit: 話者によらず @face で出したものだけ（@face-off で消す）。 */
  show?: "always" | "offstage" | "explicit";
  side?: "left" | "right";
  width?: number;
  height?: number;
  /** 置く位置（メッセージウィンドウの左上から px。負でもよい）。書くと side より優先し、本文をずらさない。 */
  x?: number;
  y?: number;
}

/** 話していないキャラクターの見せ方（@chara-config の focus と同じ）。 */
export const SPRITE_FOCUS_MODES = ["none", "dim", "blur", "dim-blur", "lower", "dim-lower"] as const;
export type SpriteFocusMode = (typeof SPRITE_FOCUS_MODES)[number];

export interface UiChara {
  /** 話していないキャラクターの見せ方。none: 変えない（既定）、dim: 暗く、lower: 少し下げる、dim-lower: 暗くして下げる、blur: ぼかす、dim-blur: 暗くしてぼかす。 */
  focus?: SpriteFocusMode;
  /** 暗くするときの明るさ（0〜1。既定 0.6）。 */
  dim?: number;
  /** 下げる量（px。既定 12）。 */
  lower?: number;
  /** 話し始めたキャラクターを小さく跳ねさせる。 */
  jump?: boolean;
  /**
   * true なら、まだ出ていないキャラクターが出るのを待つ間（@chara の wait=true）も、前のページの話者の名前と本文を残す（旧バージョンの動作）。
   * 既定（false）は、前の話者がそのキャラクターでなければ名前欄と本文を消してから出す。
   */
  keepText?: boolean;
}

export interface UiMessage {
  /** 枠の位置と大きさ（px）。省略した項目は既定（画面の下に、左右 60px あけて置く）。 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 枠の内側の余白（px か CSS の padding。"48px 148px 18px 122px" など）。 */
  padding?: number | string;
  background?: string;
  /** 枠の画像（image からのパス）。枠いっぱいに引き伸ばす。imageSlice があれば角を伸ばさない。 */
  image?: string;
  imageSlice?: UiImageSlice;
  /** 枠の線の色。"none" で線を消す。 */
  borderColor?: string;
  /** 枠の下から敷く地（CSS の background。グラデーションなど）。本文の下に、枠とは別に置く。 */
  backdrop?: string;
  /** 敷く地の高さ（px。既定は枠の高さ）。 */
  backdropHeight?: number;
  /** 角の丸み（px）。 */
  radius?: number;
  /**
   * 枠に収まらない本文を、改ページせずに枠の中でスクロールさせる（文字を出すのに合わせて下へ送る。ホイールで読み返せる）。
   * 枠の高さは height（省略は既定の高さ）で決まったままにする。
   */
  scroll?: boolean;
  /**
   * 本文を縦書きにする（行は右から左へ進む。ルビは文字の右）。シナリオの @vertical で途中から切り替えられる。
   * 位置と大きさを書かなければ、枠は画面の右に縦長に置く。吹き出し（@balloon）は横書きのまま。
   */
  vertical?: boolean;
  /**
   * true なら、ページをクリックで送ったあとも、次の本文を出すまで前のページの名前と本文を枠に残す（0.4.1 より前の動き）。
   * 既定（false）は TyranoScript の [p] と同じく、送ったあとの最初の命令（背景、立ち絵、待つなど）で消し、枠だけを残す。
   * 一行だけ残すなら @bg の keep-text=true。
   */
  keepText?: boolean;
}

export interface UiTap {
  /** 出す画像（image からのパス）。 */
  image?: string;
  /** 鳴らす効果音（sound からのパス）。 */
  se?: string;
  /** 画像の幅（px。既定は画像の大きさ）。 */
  size?: number;
  /** 出してから消えるまで（ミリ秒。既定 400）。 */
  time?: number;
}

export interface UiName {
  /** 名前の欄の位置（メッセージ枠の左上からの px）。 */
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  background?: string;
  /** 名前の欄の画像（image からのパス）。imageSlice があれば角を伸ばさない。 */
  image?: string;
  imageSlice?: UiImageSlice;
  /** 欄の線の色。"none" で線を消す。 */
  borderColor?: string;
  /** 書体（CSS の font-family）。 */
  font?: string;
  /** 太さ（CSS の font-weight）。 */
  weight?: string | number;
  letterSpacing?: string;
  /** 文字の影（CSS の text-shadow）。 */
  shadow?: string;
  /** 欄の内側の余白（CSS の padding）。 */
  padding?: string;
  /** 行の高さ（文字の大きさの倍率。既定 1.4）。 */
  lineHeight?: number;
  /** 名前の左に引く縦の罫の色。 */
  rule?: string;
}

export const GLYPH_SHAPES = ["diamond", "triangle", "dot", "bar"] as const;

export interface UiGlyph {
  /** クリック待ちの印の文字（既定 ▼）。 */
  text?: string;
  /** 印の画像（image からのパス。text より先に使う）。 */
  image?: string;
  color?: string;
  /** 文字や画像の代わりに描く形（image より先に使う）。 */
  shape?: (typeof GLYPH_SHAPES)[number];
  /** 印の動き。breathe はゆっくり大きさと濃さを変える。 */
  motion?: "bounce" | "blink" | "breathe" | "none";
  /** 印の大きさ（本文の文字の大きさの倍率。既定 0.7）。 */
  size?: number;
  /** 本文の終わりと印のあいだ（印の文字の大きさの倍率。既定 0.3）。縦書きでは上下の間。 */
  gap?: number;
}

export const CHOICE_ORNAMENTS = ["none", "brackets", "underline"] as const;
/** 選択肢の置き方（ui.choice.position）。avoid-faces は立ち絵の顔に重なるときだけ、重ならない高さへずらす。inline は本文の流れに出す（サウンドノベル式）。 */
export const CHOICE_POSITIONS = ["center", "top", "bottom", "avoid-faces", "inline"] as const;

export interface UiChoice {
  /** ボタンの幅（px。既定 560）と文字の大きさ。 */
  width?: number;
  size?: number;
  /** ボタンどうしの間（px）。 */
  gap?: number;
  color?: string;
  background?: string;
  hoverBackground?: string;
  borderColor?: string;
  /** ボタンの画像と、重ねたときの画像（image からのパス）。imageSlice があれば角を伸ばさない。 */
  image?: string;
  hoverImage?: string;
  imageSlice?: UiImageSlice;
  /** 書体（CSS の font-family）。 */
  font?: string;
  /** 太さ（CSS の font-weight）。 */
  weight?: string | number;
  letterSpacing?: string;
  /** 行の高さ（文字の大きさの倍率）。 */
  lineHeight?: number;
  /** 文字の揃え（既定 center）。 */
  align?: "left" | "center" | "right";
  /** ボタンの内側の余白（CSS の padding）。 */
  padding?: string;
  /** ボタンの外側の余白（CSS の margin）。 */
  margin?: string;
  /** ボタンの高さの下限（px）。 */
  minHeight?: number;
  /** 幅を width に決め、長い文は折り返す（既定は width を下限に文の長さまで広がる）。 */
  fixedWidth?: boolean;
  /** 角の丸み（px）。 */
  radius?: number;
  /** ボタンの後ろをぼかす大きさ（px か CSS の backdrop-filter）。 */
  blur?: number | string;
  /** 文字の影（CSS の text-shadow）。 */
  shadow?: string;
  /** 重ねたときの文字の色・線の色・影（CSS の box-shadow）。 */
  hoverColor?: string;
  hoverBorderColor?: string;
  hoverShadow?: string;
  /** ボタンの飾り。brackets は左右の括弧、underline は下線。 */
  ornament?: (typeof CHOICE_ORNAMENTS)[number];
  /** 飾りの色（既定は線の色）。 */
  ornamentColor?: string;
  /** 選択肢を出している間、メッセージ枠を隠す。 */
  hideMessage?: boolean;
  /** ボタンの高さ（px）。 */
  height?: number;
  /** 最初のボタンの上端（px）。省略は画面の縦の中央にまとめる（position で変えられる）。 */
  y?: number;
  /**
   * 選択肢の置き方。center は縦の中央、top は上、bottom はメッセージ枠のすぐ上（枠が無ければ下）。
   * avoid-faces（既定）は縦の中央に置き、立ち絵の顔に重なるときだけ、重ならないいちばん近い高さへずらす（顔の範囲は cast.json の立ち絵セットの face、
   * 無ければ立ち絵の絵から推し量る）。y を書いたときは top と bottom は使わず、avoid-faces は y の位置からずらす（position を書かずに y だけ書けば y のまま）。
   * inline はボタンの層を重ねず、今出ている本文の続きとして文字の行で書き込む（サウンドノベル式）。選ぶとそのまま本文の一部として残り、
   * @nvl の間は段落と同じく積まれる。作品の選択肢（screens.choice）とチャットの画面には効かない。
   */
  position?: (typeof CHOICE_POSITIONS)[number];
  /** 選択肢を出している間、画面いっぱいに敷く画像（image からのパス）。 */
  backdrop?: string;
  /** 先を読んだことのある選択肢の文字の色（書かなければ少し薄くする）。 */
  readColor?: string;
}

/** 吹き出しの名前の出し方（ui.chat.showName）。 */
export const CHAT_NAME_MODES = ["always", "first", "none"] as const;

/**
 * チャットの画面（packages/std の @chat-open・@chat）の配色と形。色は CSS の色、長さは px。
 * dialogue を true にすると、シナリオの書き方を変えずに、台詞を吹き出しに、地の文を中央の小さな一行にして、舞台いっぱいのチャットの画面に積む
 * （@nvl on・@vertical on・@balloon on の間は、いつものメッセージ枠に戻す）。
 */
export interface UiChat {
  /** ふだんの台詞・地の文・選択肢をチャットの画面に出す。 */
  dialogue?: boolean;
  /** 自分の話者名（この話者の吹き出しを右に出す。@chat-open me= が優先）。テーマを替えても残す。 */
  me?: string;
  /** 画面の上の名前（dialogue で @chat-open がまだ無いとき。無ければ上の帯を出さない）。テーマを替えても残す。 */
  title?: string;
  /** 文字の大きさ（px。既定は @chat の画面 16、dialogue 26）と書体（CSS の font-family）。 */
  size?: number;
  font?: string;
  /** 文字の色（地の文の一行と @chat の相手の吹き出しの既定）。 */
  color?: string;
  /** 画面の地（CSS の background。色かグラデーション）と、その上に敷く絵（image からのパス。繰り返す）。 */
  background?: string;
  image?: string;
  /** 上の帯の地と文字の色。 */
  headBackground?: string;
  headColor?: string;
  /** 相手の吹き出しの地と文字の色。 */
  otherBackground?: string;
  otherColor?: string;
  /** 自分の吹き出しの地と文字の色。 */
  meBackground?: string;
  meColor?: string;
  /** 吹き出しの角の丸さ（px。既定 16）と、話している側の角（px。既定 4）。 */
  radius?: number;
  tailRadius?: number;
  /** 名前の色と、地の文の一行の色。 */
  nameColor?: string;
  noteColor?: string;
  /** 相手の名前の出し方。always は毎回（既定）、first は話者が替わったときだけ、none は出さない。 */
  showName?: (typeof CHAT_NAME_MODES)[number];
  /** 相手の吹き出しの横に顔を丸く出す（キャストの顔。無ければ名前の一文字目）。faceSize は直径（px。既定 56）。 */
  showFace?: boolean;
  faceSize?: number;
  /** 選択肢の後ろに敷く帯の地（dialogue のとき。ボタンの見た目は ui.choice）。 */
  choiceBackground?: string;
  /** 相手の吹き出しの前に「…」を出す長さ（ミリ秒。既定 0 で出さない）。スキップと既読のページでは出さない。 */
  typing?: number;
}

/** 読み終えたページをチャットの列に積む設定（実行器の options.chatDialogue に渡す）。dialogue でなければ undefined。 */
export function chatDialogueOption(ui: UiConfig | undefined): { me?: string; title?: string } | undefined {
  const c = ui?.chat;
  if (c?.dialogue !== true) return undefined;
  return { ...(c.me ? { me: c.me } : {}), ...(c.title ? { title: c.title } : {}) };
}

export interface UiSystem {
  /**
   * 選んだテーマの名前（Studio の「ゲームの設定」で選んだもの。default・washi・night・pastel・terminal など）。
   * 見た目はここでは決めず、テーマが書き込んだ下の項目が決める（あとで色を直しても、どのテーマから始めたかが分かるように残す）。
   */
  preset?: string;
  /** システム画面（メニュー・セーブ・設定・履歴など）の配色。 */
  theme?: "dark" | "light";
  /** 選んでいるものの色。 */
  accent?: string;
  /** システム画面の書体。 */
  font?: string;
  /** 文字の色（薄い文字は、この色を薄めて作る）。 */
  fg?: string;
  /** 画面の地の色（セーブ・設定・履歴などの全面の画面と、メニュー・確認の枠）。 */
  screenBg?: string;
  /** ボタン・タブの地の色（触れたとき・選んでいるときの色は、これに選んでいるものの色を混ぜて作る）。 */
  controlBg?: string;
  /** 線の色（細い線は、この色を薄めて作る）。 */
  border?: string;
  /** ボタンと枠の角の丸み（px。既定 4）。 */
  radius?: number;
  /** タイトル画面の地（CSS の background。色かグラデーション。ui.title.background の画像があればそちらが上）。 */
  titleBg?: string;
  /** タイトルのボタンの地の色（絵の上でも読めるように。省略はボタンの地の色）。 */
  titleButtonBg?: string;
  /** タイトルの題名の文字の影（CSS の text-shadow）。 */
  titleShadow?: string;
  /** システム画面の画像。 */
  images?: UiSystemImages;
}

/** 結末の画面の終わりの表記（ui.ending.mark）の出し方。below は名前の下、above は名前の上、none は出さない。 */
export const ENDING_MARK_PLACES = ["below", "above", "none"] as const;

/**
 * 結末の名前の画面（@title-screen ending= で終えたとき、タイトルへ戻る前に出す）の見た目。色は CSS の色、長さは px。
 * 書いていない項目は、システム画面の値（地は system.titleBg、文字は system.fg、種類の文言と罫は system.accent、終わりの表記は薄い文字）と本文の書体。
 * 文言（終わりの表記の「終」、種類の文言）は作品の文言の表（ending.mark・ending.kinds.<種類>）と liminalia.json の endingKinds で替える。
 */
export interface UiEnding {
  /** 地（CSS の background。色かグラデーション）。 */
  background?: string;
  /** 地に敷く絵（bgimage からのパス。画面いっぱいに切り抜く）。 */
  image?: string;
  /** 書体（CSS の font-family）。 */
  font?: string;
  /** 名前の文字の色と大きさ（px。既定 48）。 */
  color?: string;
  size?: number;
  /** 名前の字間（CSS の letter-spacing。既定 0.16em）。 */
  letterSpacing?: string;
  /** 種類の文言（title= があるときに名前の上に添える BAD END など）の色。 */
  kindColor?: string;
  /** 名前と終わりの表記のあいだの罫の色。"none" で引かない。 */
  rule?: string;
  /** 終わりの表記の色と大きさ（px。既定 26）。 */
  markColor?: string;
  markSize?: number;
  /** 終わりの表記の出し方。below は名前の下（既定）、above は名前の上、none は出さない（罫も引かない）。 */
  mark?: (typeof ENDING_MARK_PLACES)[number];
}

/** NVL の段落を積む位置（top は上から、center は真ん中に、bottom は下から積んで古い段落を上へ流す）。 */
export const NVL_VALIGNS = ["top", "center", "bottom"] as const;

/** NVL（@nvl on）の見た目。色は CSS の色、長さは px。 */
export interface UiNvl {
  /** 地（CSS の background。色かグラデーション。既定は暗い半透明）。 */
  background?: string;
  /** 地に敷く絵（image からのパス。画面いっぱいに切り抜く。地の色の上に重なる）。 */
  image?: string;
  /** 文章の周りの余白（px。一つなら四辺とも、四つなら上・右・下・左。既定 72・150・96・150）。 */
  padding?: UiImageSlice;
  /** 行の揃え（left、center、right）。 */
  align?: "left" | "center" | "right";
  /** 段落を積む位置（既定 bottom）。 */
  valign?: (typeof NVL_VALIGNS)[number];
  /** 書体（CSS の font-family。遊ぶ人がコンフィグで選んだ書体が先）。 */
  font?: string;
  /** 文字の色。 */
  color?: string;
  /** 文字の大きさ（px。遊ぶ人の文字サイズを掛ける）。 */
  size?: number;
  /** 行の高さ（文字の大きさに対する倍率）。 */
  lineHeight?: number;
  /** 段落を出すときのフェードの時間（ミリ秒。0 か省くとフェードしない）。 */
  fade?: number;
  /** 段落の頭に話者の名前を出すか（既定 true）。 */
  names?: boolean;
}

/**
 * 章の扉と章末（@chapter-card、@chapter-end）の見た目。色は CSS の色、長さは px。
 * 書いていない項目は、システム画面の値（地は system.titleBg、文字は system.fg、番号と罫は system.accent、副題は薄い文字）と本文の書体。
 * 文言（章末の終わりの表記の「完」）は作品の文言の表（chapter.end）か命令の text= で替える。絵は命令の image= があればそちらを出す。
 */
export interface UiChapter {
  /** 地（CSS の background。色かグラデーション）。 */
  background?: string;
  /** 地に敷く絵（bgimage からのパス。画面いっぱいに切り抜く）。 */
  image?: string;
  /** 書体（CSS の font-family）。 */
  font?: string;
  /** 文字の色。 */
  color?: string;
  /** 題の大きさ（px。既定 52。章末の題はその 8/13、縦長の作品の扉の題は 10/13）。 */
  size?: number;
  /** 題の字間（CSS の letter-spacing。既定 0.12em）。 */
  letterSpacing?: string;
  /** 章の番号（第一章 など）と罫の色。 */
  accent?: string;
  /** 章の番号の大きさ（px。既定 22）。 */
  numberSize?: number;
  /** 副題の色と大きさ（px。既定 18）。 */
  subtitleColor?: string;
  subtitleSize?: number;
  /** 題と副題のあいだの罫の色。"none" で引かない。 */
  rule?: string;
  /** 章末の終わりの表記（完）の色と大きさ（px。既定 44）。 */
  endColor?: string;
  endSize?: number;
}

/**
 * システム画面の画像。screen は全面の画面（セーブ・ロード・設定・履歴など）の背景で bgimage からのパス、
 * button・buttonHover はボタン（タイトルのボタンも）の地で、frame はメニューと確認の枠の地。この三つは image からのパス。
 * ボタンと枠の画像は、大きさに合わせて伸ばす（buttonSlice・frameSlice を書くと角を伸ばさない）。
 */
export interface UiSystemImages {
  screen?: string;
  button?: string;
  buttonHover?: string;
  frame?: string;
  /** ボタンと枠の画像の切り分け。書くと角を伸ばさない。 */
  buttonSlice?: UiImageSlice;
  frameSlice?: UiImageSlice;
  /** つまみの丸の画像（image からのパス）。 */
  sliderThumb?: string;
}

export interface UiTitle {
  /** タイトル画面の背景（bgimage からのパス）。 */
  background?: string;
  /** タイトル画面の BGM（bgm からのパス）。 */
  bgm?: string;
  /** タイトル画面の BGM の音量（0〜100。既定 100）。 */
  bgmVolume?: number;
  /** 「つづきから」で、ロード画面を開かずにいちばん新しいセーブ（番号つき・クイック・オートセーブのうち）から再開する。 */
  resume?: boolean;
  /** 題名の代わりに出す画像（image からのパス）。 */
  logo?: string;
  /** 題名の文字を出すか（既定 true。logo があれば出さない）。 */
  showName?: boolean;
  /** タイトルのボタンの並べ方。 */
  menu?: UiTitleMenu;
  /**
   * クリアの状況などで変わるタイトル。if（全セーブ共通の変数 system.… の式）が真の最初のものが、書いた項目だけ上の値を置き換える。
   * 例: [{ "if": "(system.cleared_true)", "background": "title_after.png", "bgm": "title2.ogg" }]
   */
  variants?: UiTitleVariant[];
}

export interface UiTitleMenu {
  /** 題名とボタンのまとまりを置く場所（既定 center）。 */
  align?: "left" | "center" | "right";
  /** ボタンの並ぶ向き（既定 column）。 */
  direction?: "column" | "row";
  /** ボタンどうしの間（px。既定 14）。 */
  gap?: number;
  /** ボタンの幅の下限（px。既定 280）。 */
  width?: number;
}

export type UiTitleVariant = Omit<UiTitle, "variants" | "menu"> & { if: string };

/** 今のタイトル（variants のうち test が真の最初のものを重ねたもの）。 */
export function resolveTitle(title: UiTitle | undefined, test: (condition: string) => boolean): Omit<UiTitle, "variants"> | undefined {
  if (!title) return undefined;
  const { variants, ...base } = title;
  const hit = variants?.find((v) => test(v.if));
  if (!hit) return base;
  const { if: _if, ...over } = hit;
  return { ...base, ...over };
}

/** ゲーム中の操作の帯に置けるボタン（既定はこの順にすべて）。 */
export const MENU_BAR_ITEMS = ["quick-save", "quick-load", "save", "load", "auto", "skip", "rollback", "rollforward", "prev-choice", "next-choice", "next-unread", "backlog", "replay-voice", "items", "config", "help", "screenshot", "hide", "title", "fullscreen"] as const;
/** 帯に置ける操作。ほかに "screen:<名前>" で、作品の画面（プラグインが system.defineScreen で登録したもの）を開くボタンを置ける。 */
export type MenuBarItem = (typeof MENU_BAR_ITEMS)[number] | `screen:${string}`;
/** 作品の画面を開く帯の項目（"screen:<名前>"）か。 */
export function isScreenMenuItem(item: unknown): item is `screen:${string}` {
  return typeof item === "string" && /^screen:[A-Za-z0-9_.-]+$/.test(item);
}
/** ui.menuBar.items を書かないときに置くもの（戻る・進む・前の選択肢へ・次の選択肢へは、書いたときだけ置く）。 */
export const DEFAULT_MENU_BAR_ITEMS: readonly MenuBarItem[] = ["quick-save", "quick-load", "save", "load", "auto", "skip", "backlog", "config", "hide", "title"];
export const MENU_BAR_POSITIONS = ["bottom-right", "bottom-left", "bottom-center", "top-right", "top-left", "hidden"] as const;
/** 起動の演出（ui.splash）。 */
export interface UiSplash {
  /** 順に出すロゴ。image は image フォルダの画像、background は地の色、time は出しておく時間（ミリ秒。既定 2500）。 */
  logos?: { image: string; background?: string; time?: number }[];
  /** 注意書き。blocks は見出し（label）と文（text。改行で行を分ける）の並び。time は自動で進むまでの時間（ミリ秒。既定 6000）、auto が false なら押すまで待つ。 */
  notice?: { title?: string; blocks?: { label?: string; text: string }[]; background?: string; color?: string; time?: number; auto?: boolean };
  /** 押して次へ進めるか（既定 true）。 */
  skip?: boolean;
  /** 最後に地の色を残して消える時間（ミリ秒。既定 600）。 */
  fade?: number;
}

/** オート中・スキップ中の表示の位置（ui.indicator）。 */
export const INDICATOR_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right", "hidden"] as const;

export interface UiMenuBar {
  /** 置くボタンと並び（書いたものだけをこの順に置く）。 */
  items?: MenuBarItem[];
  /** 帯の位置（hidden は出さない。右クリック・Esc のメニューからは使える）。既定 bottom-right。 */
  position?: (typeof MENU_BAR_POSITIONS)[number];
  /**
   * 帯の左端（px。文字と枠の座標）。書くと position の左右の置き方より優先する（書かなければ position の置き方のまま）。
   * position が hidden なら出さない。
   */
  x?: number;
  /** 帯の上端（px。文字と枠の座標）。書くと position の上下の置き方より優先する。 */
  y?: number;
  /**
   * 指で触れる端末に出すメニューのボタン（帯を隠しても、指でメニューを開けるように出す）。false で出さない
   * （指では長押しでメニューを開く。作品が自分のボタンからメニューを開くとき）。
   */
  touchButton?: boolean;
  /** ボタンごとの絵（操作の名前 → image からのパス）。書いたボタンは文字の代わりに絵を出す。 */
  images?: Partial<Record<MenuBarItem, string>>;
  /** オート・スキップが動いている間の絵。 */
  activeImages?: Partial<Record<MenuBarItem, string>>;
  /** ボタンの文字を置き換える（操作の名前 → 文字）。 */
  labels?: Partial<Record<MenuBarItem, string>>;
  /** ボタンの文字の色（既定は薄い白）。 */
  color?: string;
  /** 帯の文字の影（CSS の text-shadow）。 */
  shadow?: string;
}

export interface UiDefaults {
  /** 一文字あたりのミリ秒（0〜80）。 */
  textSpeed?: number;
  /** オートの待ち（ミリ秒。500〜5000）。 */
  autoWait?: number;
  /** 全体の音量（0〜100）。 */
  master?: number;
  bgm?: number;
  se?: number;
  voice?: number;
  /** スキップで未読も飛ばすか。 */
  skipUnread?: boolean;
  /** 選択肢を選んだあともオート・スキップを続けるか（既定 false）。 */
  autoAfterChoice?: boolean;
  skipAfterChoice?: boolean;
  /** 全画面で始めるか（デスクトップ版）。 */
  fullscreen?: boolean;
  /** メッセージ枠の濃さ（0〜100。枠の色の不透明度に掛ける）。 */
  windowOpacity?: number;
  /** 文字の大きさ（80〜200 %）。 */
  textScale?: number;
  /** ボイスの間 BGM を下げるか（既定 true）。 */
  duckBgm?: boolean;
}

export const UI_KEY_ACTIONS = ["advance", "menu", "backlog", "hide", "auto", "skip", "quickSave", "quickLoad", "save", "load", "config", "rollback", "rollforward", "prevChoice", "nextChoice", "nextUnread", "screenshot", "mute", "replayVoice", "copyText"] as const;
export type UiKeyAction = (typeof UI_KEY_ACTIONS)[number];

/**
 * キーの既定の割り当て（ui.keys に書かなかった操作）。遊ぶ人か作品がほかの操作に割り当てたキーは、既定からは外す（resolveKeys）。
 * 割り当てを止めるなら ui.keys にその操作を空の配列で書く。
 */
export const DEFAULT_KEYS: Readonly<Record<UiKeyAction, readonly string[]>> = {
  advance: ["Enter", " "],
  menu: ["Escape"],
  backlog: ["b", "B"],
  hide: ["h", "H", "Delete"],
  auto: ["a", "A"],
  // 押すたびに切り替える（Ctrl は押している間だけ）
  skip: ["Tab"],
  quickSave: ["s", "S"],
  quickLoad: ["l", "L"],
  save: [],
  load: [],
  config: ["c", "C"],
  rollback: ["PageUp"],
  rollforward: ["PageDown"],
  prevChoice: [],
  nextChoice: [],
  nextUnread: [],
  screenshot: [],
  // ほかの操作に割り当てたキーが先（作品と遊ぶ人の割り当て）
  mute: ["m", "M"],
  // 今のページのボイスをもう一度鳴らす
  replayVoice: ["v", "V"],
  // 今のページの本文をコピーする（Ctrl+C・Cmd+C は割り当てなくても、文字を選んでいなければ今のページをコピーする）
  copyText: [],
};

export const SAVE_SLOTS = { min: 8, max: 200, step: 8, default: 48 } as const;
export const BACKLOG_PAGES = { min: 10, max: 2000, default: 300 } as const;
export const AUTOSAVE_SLOTS = { min: 0, max: 10, default: 3 } as const;
export const QUICK_SLOTS = { min: 1, max: 10, default: 3 } as const;

export interface UiAutosave {
  slots?: number;
  leave?: boolean;
  on?: UiAutosaveOn;
}

/** オートセーブするほかの時機（ui.autosave.on）。 */
export interface UiAutosaveOn {
  /** 選択肢を出したとき（既定 true）。 */
  choice?: boolean;
  /** 章の頭（既定 false）。 */
  chapter?: boolean;
  /** このページ数を読むごと（0 か書かなければしない）。 */
  pages?: number;
}

/** オートセーブする時機（ui.autosave.on に既定を補ったもの）。 */
export function autosaveTimings(ui: UiConfig | undefined): { choice: boolean; chapter: boolean; pages: number } {
  const on = ui?.autosave?.on;
  const pages = on?.pages;
  return { choice: on?.choice !== false, chapter: on?.chapter === true, pages: typeof pages === "number" && Number.isFinite(pages) && pages > 0 ? Math.round(pages) : 0 };
}

/** オートセーブの枠の数（幅に収める。0 なら持たない）。 */
export function autosaveSlotCount(ui: UiConfig | undefined): number {
  const n = ui?.autosave?.slots;
  if (typeof n !== "number" || !Number.isFinite(n)) return AUTOSAVE_SLOTS.default;
  return Math.min(AUTOSAVE_SLOTS.max, Math.max(AUTOSAVE_SLOTS.min, Math.round(n)));
}

/** クイックセーブの枠の数（幅に収める）。 */
export function quickSlotCount(ui: UiConfig | undefined): number {
  const n = ui?.quickSave?.slots;
  if (typeof n !== "number" || !Number.isFinite(n)) return QUICK_SLOTS.default;
  return Math.min(QUICK_SLOTS.max, Math.max(QUICK_SLOTS.min, Math.round(n)));
}

/** セーブの枠の数（8 の倍数に切り上げ、幅に収める）。 */
export function saveSlotCount(ui: UiConfig | undefined): number {
  const n = ui?.saveSlots;
  if (typeof n !== "number" || !Number.isFinite(n)) return SAVE_SLOTS.default;
  return Math.min(SAVE_SLOTS.max, Math.max(SAVE_SLOTS.min, Math.ceil(n / SAVE_SLOTS.step) * SAVE_SLOTS.step));
}

/** 履歴に残すページの数。 */
export function backlogPages(ui: UiConfig | undefined): number {
  const n = ui?.backlog;
  if (typeof n !== "number" || !Number.isFinite(n)) return BACKLOG_PAGES.default;
  return Math.min(BACKLOG_PAGES.max, Math.max(BACKLOG_PAGES.min, Math.round(n)));
}

/** その操作のキー（ui.keys か既定）。既定のキーは、作品がほかの操作に割り当てたものを除く。 */
export function keysFor(ui: UiConfig | undefined, action: UiKeyAction): readonly string[] {
  return resolveKeys(ui)[action];
}

/**
 * 操作ごとのキー。遊ぶ人の割り当て（player。コンフィグの「操作」）→ 作品の ui.keys → 既定 の順に決める。
 * 既定のキーは、遊ぶ人か作品がどれかの操作に割り当てたキーを除く（作品が " " を hide に割り当てていれば、既定の advance の " " は効かない）。
 */
export function resolveKeys(ui: UiConfig | undefined, player: Readonly<Record<string, readonly string[] | undefined>> = {}): Record<UiKeyAction, readonly string[]> {
  const explicit = (action: UiKeyAction): readonly string[] | undefined => player[action] ?? ui?.keys?.[action];
  const taken = new Set<string>();
  for (const action of UI_KEY_ACTIONS) for (const k of explicit(action) ?? []) taken.add(k);
  const out = {} as Record<UiKeyAction, readonly string[]>;
  for (const action of UI_KEY_ACTIONS) out[action] = explicit(action) ?? DEFAULT_KEYS[action].filter((k) => !taken.has(k));
  return out;
}

/** システム画面の画像の項目（ui.system.images）。 */
export const SYSTEM_IMAGE_KEYS = ["screen", "button", "buttonHover", "frame", "buttonSlice", "frameSlice", "sliderThumb"] as const;

/** 設定が参照する素材。 */
export function uiAssetReferences(ui: UiConfig | undefined): { folder: string; path: string; where: string }[] {
  const out: { folder: string; path: string; where: string }[] = [];
  const add = (folder: string, path: string | undefined, where: string) => {
    if (typeof path === "string" && path !== "") out.push({ folder, path, where: `ui.${where}` });
  };
  for (const [i, f] of (Array.isArray(ui?.fonts) ? ui.fonts : []).entries()) add("others", f?.file, `fonts[${i}].file`);
  add("others", ui?.text?.fontFile, "text.fontFile");
  add("image", ui?.message?.image, "message.image");
  add("image", ui?.name?.image, "name.image");
  add("image", ui?.glyph?.image, "glyph.image");
  add("image", ui?.choice?.image, "choice.image");
  add("image", ui?.choice?.hoverImage, "choice.hoverImage");
  add("image", ui?.choice?.backdrop, "choice.backdrop");
  add("image", ui?.chat?.image, "chat.image");
  add("bgimage", ui?.ending?.image, "ending.image");
  add("bgimage", ui?.chapter?.image, "chapter.image");
  add("image", ui?.nvl?.image, "nvl.image");
  for (const [name, style] of Object.entries(ui?.nvlStyles ?? {})) add("image", style?.image, `nvlStyles.${name}.image`);
  add("bgimage", ui?.title?.background, "title.background");
  add("bgm", ui?.title?.bgm, "title.bgm");
  add("image", ui?.title?.logo, "title.logo");
  add("bgimage", ui?.system?.images?.screen, "system.images.screen");
  add("image", ui?.system?.images?.button, "system.images.button");
  add("image", ui?.system?.images?.buttonHover, "system.images.buttonHover");
  add("image", ui?.system?.images?.frame, "system.images.frame");
  add("image", ui?.system?.images?.sliderThumb, "system.images.sliderThumb");
  for (const group of ["images", "activeImages"] as const) {
    for (const [item, path] of Object.entries(ui?.menuBar?.[group] ?? {})) add("image", path, `menuBar.${group}.${item}`);
  }
  for (const [i, p] of (Array.isArray(ui?.help?.pages) ? ui.help.pages : []).entries()) add("image", p?.image, `help.pages[${i}].image`);
  for (const [i, l] of (Array.isArray(ui?.splash?.logos) ? ui.splash.logos : []).entries()) add("image", l?.image, `splash.logos[${i}].image`);
  for (const [i, v] of (Array.isArray(ui?.title?.variants) ? ui.title.variants : []).entries()) {
    add("bgimage", v?.background, `title.variants[${i}].background`);
    add("bgm", v?.bgm, `title.variants[${i}].bgm`);
    add("image", v?.logo, `title.variants[${i}].logo`);
  }
  // 背景の色調は、背景のファイルの名前が鍵
  if (ui?.backgroundTones && typeof ui.backgroundTones === "object") for (const image of Object.keys(ui.backgroundTones)) add("bgimage", image, `backgroundTones.${image}`);
  add("image", ui?.cursor?.image, "cursor.image");
  add("image", ui?.tap?.image, "tap.image");
  add("sound", ui?.tap?.se, "tap.se");
  for (const kind of UI_SOUND_KINDS) add("sound", ui?.sound?.ui?.[kind], `sound.ui.${kind}`);
  add("bgm", ui?.settings?.samples?.bgm, "settings.samples.bgm");
  add("sound", ui?.settings?.samples?.se, "settings.samples.se");
  add("voice", ui?.settings?.samples?.voice, "settings.samples.voice");
  for (const e of systemVoiceEntries(ui?.systemVoice)) add("voice", e.file, e.where);
  // 言語ごとの見た目の書体と絵
  if (ui?.languages && typeof ui.languages === "object")
    for (const [language, o] of Object.entries(ui.languages)) if (o && typeof o === "object") for (const r of uiAssetReferences(o as UiConfig)) out.push({ ...r, where: r.where.replace(/^ui\./, `ui.languages.${language}.`) });
  return out;
}

/** 設定の形の誤り（liminalia.json の ui）。 */
/** ui.nvl と ui.nvlStyles の名前ごとの見た目の形（checkUi）。 */
const NVL_SHAPE = { background: "string", image: "string", padding: "slice", align: ["left", "center", "right"], valign: NVL_VALIGNS, font: "string", color: "string", size: "number", lineHeight: "number", fade: "number", names: "boolean" } as const;

export function checkUi(ui: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const bad = (where: string, message: string) => out.push({ severity: "error", code: "bad-ui", message: `ui.${where} ${message}`, file: "liminalia.json", line: 1 });
  if (ui === undefined) return out;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    out.push({ severity: "error", code: "bad-ui", message: "ui はオブジェクトで書きます", file: "liminalia.json", line: 1 });
    return out;
  }
  const u = ui as Record<string, unknown>;
  const groups: Record<string, Record<string, "number" | "string" | "boolean" | "array" | "object" | "size" | "weight" | "slice" | readonly string[]>> = {
    text: { font: "string", fontFile: "string", size: "number", color: "string", lineHeight: "number", decoration: ["none", "shadow", "edge"], decorationColor: "string", shadow: "string", stroke: "string", letterSpacing: "string", weight: "weight", topGap: "number", readColor: "string", align: ["left", "center", "right"], rubySize: "number", paragraphGap: "number", rubyGap: "number", lineChars: "number", lineBreak: ["auto", "strict", "normal", "loose", "anywhere"], hangingPunctuation: "boolean", emphasis: "string", quotes: ["keep", "strip"], reveal: ["fade", "none", "rise"], revealTime: "number" },
    message: { x: "number", y: "number", width: "number", height: "number", padding: "size", background: "string", image: "string", imageSlice: "slice", backdrop: "string", backdropHeight: "number", borderColor: "string", radius: "number", scroll: "boolean", vertical: "boolean", keepText: "boolean" },
    name: { x: "number", y: "number", size: "number", color: "string", background: "string", image: "string", imageSlice: "slice", borderColor: "string", font: "string", weight: "weight", letterSpacing: "string", shadow: "string", padding: "string", lineHeight: "number", rule: "string" },
    glyph: { text: "string", image: "string", shape: GLYPH_SHAPES, color: "string", motion: ["bounce", "blink", "breathe", "none"], size: "number", gap: "number" },
    choice: { width: "number", size: "number", gap: "number", color: "string", background: "string", hoverBackground: "string", borderColor: "string", image: "string", hoverImage: "string", imageSlice: "slice", height: "number", y: "number", backdrop: "string", font: "string", weight: "weight", letterSpacing: "string", lineHeight: "number", align: ["left", "center", "right"], padding: "string", margin: "string", minHeight: "number", fixedWidth: "boolean", radius: "number", blur: "size", shadow: "string", hoverColor: "string", hoverBorderColor: "string", hoverShadow: "string", ornament: CHOICE_ORNAMENTS, ornamentColor: "string", hideMessage: "boolean", readColor: "string", position: CHOICE_POSITIONS },
    chat: { dialogue: "boolean", me: "string", title: "string", size: "number", font: "string", color: "string", background: "string", image: "string", headBackground: "string", headColor: "string", otherBackground: "string", otherColor: "string", meBackground: "string", meColor: "string", radius: "number", tailRadius: "number", nameColor: "string", noteColor: "string", showName: CHAT_NAME_MODES, showFace: "boolean", faceSize: "number", choiceBackground: "string", typing: "number" },
    system: { preset: "string", theme: ["dark", "light"], accent: "string", font: "string", fg: "string", screenBg: "string", controlBg: "string", border: "string", radius: "number", titleBg: "string", titleButtonBg: "string", titleShadow: "string", images: "object" },
    ending: { background: "string", image: "string", font: "string", color: "string", size: "number", letterSpacing: "string", kindColor: "string", rule: "string", markColor: "string", markSize: "number", mark: ENDING_MARK_PLACES },
    chapter: { background: "string", image: "string", font: "string", color: "string", size: "number", letterSpacing: "string", accent: "string", numberSize: "number", subtitleColor: "string", subtitleSize: "number", rule: "string", endColor: "string", endSize: "number" },
    nvl: NVL_SHAPE,
    title: { background: "string", bgm: "string", bgmVolume: "number", logo: "string", showName: "boolean", resume: "boolean" },
    cursor: { image: "string", x: "number", y: "number", animated: "boolean" },
    tap: { image: "string", se: "string", size: "number", time: "number" },
    screen: { fullscreen: "boolean", pauseScenario: "boolean", textScale: ["all", "message"], pauseInBackground: "boolean" },
    autosave: { slots: "number", leave: "boolean", on: "object" },
    quickSave: { slots: "number" },
    input: { rightClick: ["menu", "hide"], wheelUp: ["backlog", "rollback"], swipeSide: ["rollback", "none"], skipEffects: "boolean", middleClick: ["hide", "none"], numberKeys: "boolean" },
    rollback: { enabled: "boolean", fixChoices: "boolean" },
    nextChoice: { readOnly: "boolean" },
    face: { show: ["always", "offstage", "explicit"], side: ["left", "right"], width: "number", height: "number", x: "number", y: "number" },
    chara: { focus: SPRITE_FOCUS_MODES, dim: "number", lower: "number", jump: "boolean", keepText: "boolean" },
    captions: { sounds: "object", music: "boolean" },
    contentFilter: { label: "string", default: "boolean", assets: "object" },
    contentWarning: { title: "string", text: "string", button: "string", always: "boolean" },
    sound: { movie: ["bgm", "se", "voice", "none"], streamBgm: "boolean" },
    settings: { textSpeedMin: "number", textSpeedMax: "number", textSpeedStep: "number", autoWaitMin: "number", autoWaitMax: "number", autoWaitStep: "number", autoPerChar: "number", voiceSpeakers: ["heard", "all", "masked"] },
    menuBar: { items: "array", position: MENU_BAR_POSITIONS, x: "number", y: "number", touchButton: "boolean", images: "object", activeImages: "object", labels: "object", color: "string", shadow: "string" },
    defaults: { textSpeed: "number", autoWait: "number", master: "number", bgm: "number", se: "number", voice: "number", skipUnread: "boolean", autoAfterChoice: "boolean", skipAfterChoice: "boolean", fullscreen: "boolean", windowOpacity: "number", textScale: "number", duckBgm: "boolean" },
  };
  for (const [key, value] of Object.entries(u)) {
    if (key === "languages") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "は言語 → { text, name, choice, … } の組で書きます");
        continue;
      }
      for (const [language, o] of Object.entries(value as Record<string, unknown>)) {
        if (!o || typeof o !== "object" || Array.isArray(o)) {
          bad(`languages.${language}`, "はオブジェクトで書きます");
          continue;
        }
        for (const k of Object.keys(o)) if (!(UI_LANGUAGE_GROUPS as readonly string[]).includes(k)) bad(`languages.${language}.${k}`, `は言語ごとに書けません（書けるのは ${UI_LANGUAGE_GROUPS.join("、")}）`);
        // 中身は ui と同じ形で確かめる（場所の名前に言語を足す）
        const allowed = Object.fromEntries(Object.entries(o).filter(([k]) => (UI_LANGUAGE_GROUPS as readonly string[]).includes(k)));
        for (const d of checkUi(allowed)) out.push({ ...d, message: d.message.replace(/^ui\./, `ui.languages.${language}.`) });
      }
      continue;
    }
    if (key === "fonts") {
      if (!Array.isArray(value)) bad(key, "は { family, file, weight } の配列で書きます");
      else
        value.forEach((f: unknown, i: number) => {
          const o = f as Record<string, unknown> | null;
          if (!o || typeof o !== "object" || typeof o.family !== "string" || o.family === "" || typeof o.file !== "string" || o.file === "") bad(`fonts[${i}]`, "には family と file を書きます");
        });
      continue;
    }
    const shape = groups[key];
    if (shape) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "はオブジェクトで書きます");
        continue;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (key === "title" && k === "variants") {
          checkTitleVariants(v, (where, message) => bad(`title.variants${where}`, message));
          continue;
        }
        if (key === "title" && k === "menu") {
          checkTitleMenu(v, (where, message) => bad(`title.menu${where}`, message));
          continue;
        }
        if (key === "autosave" && k === "on") {
          const types: Record<string, string> = { choice: "boolean", chapter: "boolean", pages: "number" };
          if (!v || typeof v !== "object" || Array.isArray(v)) bad("autosave.on", "は { choice, chapter, pages } で書きます");
          else
            for (const [name, x] of Object.entries(v as Record<string, unknown>)) {
              if (!types[name]) bad(`autosave.on.${name}`, "という項目はありません");
              else if (typeof x !== types[name] || (name === "pages" && (!Number.isInteger(x) || (x as number) < 0))) bad(`autosave.on.${name}`, name === "pages" ? "は 0 以上の整数で書きます" : "は true か false で書きます");
            }
          continue;
        }
        if ((key === "sound" && k === "ui") || (key === "settings" && k === "samples")) {
          const names: readonly string[] = key === "sound" ? UI_SOUND_KINDS : ["bgm", "se", "voice"];
          if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${key}.${k}`, `は { ${names.join(", ")} } で書きます`);
          else
            for (const [name, x] of Object.entries(v as Record<string, unknown>)) {
              if (!names.includes(name)) bad(`${key}.${k}.${name}`, "という項目はありません");
              else if (typeof x !== "string") bad(`${key}.${k}.${name}`, "は文字列で書きます");
            }
          continue;
        }
        if (key === "system" && k === "images") {
          if (!v || typeof v !== "object" || Array.isArray(v)) bad("system.images", `は { ${SYSTEM_IMAGE_KEYS.join(", ")} } で書きます`);
          else
            for (const [name, path] of Object.entries(v as Record<string, unknown>)) {
              if (!(SYSTEM_IMAGE_KEYS as readonly string[]).includes(name)) bad(`system.images.${name}`, "という項目はありません");
              else if (name.endsWith("Slice")) {
                if (!isImageSlice(path)) bad(`system.images.${name}`, "は数か四つの数の配列で書きます");
              } else if (typeof path !== "string") bad(`system.images.${name}`, "は文字列で書きます");
            }
          continue;
        }
        const t = shape[k];
        if (!t) bad(`${key}.${k}`, "という項目はありません");
        else if (t === "array") {
          if (!Array.isArray(v) || v.some((x) => !(MENU_BAR_ITEMS as readonly string[]).includes(x as string) && !isScreenMenuItem(x))) bad(`${key}.${k}`, `は ${MENU_BAR_ITEMS.join("、")} と screen:<作品の画面の名前> の配列で書きます`);
        } else if (t === "size") {
          if (typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v))) bad(`${key}.${k}`, "は数か CSS の長さで書きます");
        } else if (t === "weight") {
          if (typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v))) bad(`${key}.${k}`, "は数か CSS の太さで書きます");
        } else if (t === "slice") {
          if (!isImageSlice(v)) bad(`${key}.${k}`, "は数か四つの数の配列で書きます");
        } else if (t === "object") {
          if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) bad(`${key}.${k}`, "は名前 → 文字列の組で書きます");
        } else if (Array.isArray(t) ? !t.includes(v as string) : typeof v !== t || (t === "number" && !Number.isFinite(v))) bad(`${key}.${k}`, Array.isArray(t) ? `は ${t.join("、")} のどれかを指定します` : `は${t === "number" ? "数値" : t === "string" ? "文字列" : " true か false "}で書きます`);
      }
      if (key === "cursor" && typeof (value as { image?: unknown }).image !== "string") bad("cursor.image", "がありません");
      if (key === "contentWarning" && typeof (value as { text?: unknown }).text !== "string") bad("contentWarning.text", "がありません");
      if (key === "tap" && typeof (value as { image?: unknown }).image !== "string" && typeof (value as { se?: unknown }).se !== "string") bad("tap", "には image か se を書きます");
      continue;
    }
    if (key === "chapterNames") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((x) => typeof x !== "string")) bad(key, "は \"ファイル#ラベル\" か \"ファイル\" → 名前 の組で書きます");
      continue;
    }
    if (key === "backgroundTones") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((x) => typeof x !== "string")) bad(key, "は 背景のファイルの名前 → 色調の名前 の組で書きます");
      continue;
    }
    if (key === "templates") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "は 画面の名前 → テンプレートのファイル（ui/screens/confirm/confirm.html など）の組で書きます");
        continue;
      }
      for (const [screen, file] of Object.entries(value as Record<string, unknown>)) {
        if (typeof file !== "string" || !/\.html$/i.test(file)) bad(`templates.${screen}`, "は .html のファイルのパスで書きます");
        else if (/^([\\/]|[a-z]:)/i.test(file) || file.split(/[\\/]/).includes("..")) bad(`templates.${screen}`, "は作品のフォルダの中のパスで書きます（/ で始めず、.. を使わない）");
      }
      continue;
    }
    if (key === "backgroundFocus") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((x) => typeof x !== "string")) bad(key, "は 背景のファイルの名前 → 位置（\"30% 50%\" など）の組で書きます");
      continue;
    }
    if (key === "help") {
      const h = value as { pages?: unknown; title?: unknown } | null;
      if (!h || typeof h !== "object" || Array.isArray(h)) bad(key, "は { pages, title } で書きます");
      else {
        if (h.title !== undefined && typeof h.title !== "boolean") bad("help.title", "は true か false で書きます");
        if (h.pages !== undefined) {
          if (!Array.isArray(h.pages)) bad("help.pages", "は { title, image, text } の配列で書きます");
          else
            h.pages.forEach((p: unknown, i: number) => {
              const o = p as Record<string, unknown> | null;
              if (!o || typeof o !== "object" || typeof o.title !== "string" || o.title === "") bad(`help.pages[${i}]`, "に title がありません");
              else if ((o.image !== undefined && typeof o.image !== "string") || (o.text !== undefined && typeof o.text !== "string")) bad(`help.pages[${i}]`, "の image と text は文字列で書きます");
            });
        }
        for (const k of Object.keys(h)) if (k !== "pages" && k !== "title") bad(`help.${k}`, "という項目はありません");
      }
      continue;
    }
    if (key === "nvlStyles") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "は名前 → { background, image, padding, align, valign, font, color, size, lineHeight, fade, names } の組で書きます");
        continue;
      }
      // 名前ごとの見た目は ui.nvl と同じ形
      for (const [name, style] of Object.entries(value as Record<string, unknown>)) {
        for (const d of checkUi({ nvl: style })) out.push({ ...d, message: d.message.replace(/^ui\.nvl/, `ui.nvlStyles.${name}`) });
      }
      continue;
    }
    if (key === "tones") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "は名前 → { color, amount, saturation, brightness, contrast } の組で書きます");
        continue;
      }
      for (const [name, tone] of Object.entries(value as Record<string, unknown>)) {
        if (!tone || typeof tone !== "object" || Array.isArray(tone)) {
          bad(`tones.${name}`, "は { color, amount, saturation, brightness, contrast } で書きます");
          continue;
        }
        for (const [k, v] of Object.entries(tone as Record<string, unknown>)) {
          if (k === "color") {
            if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) bad(`tones.${name}.color`, "は #rrggbb で書きます");
          } else if (["amount", "saturation", "brightness", "contrast"].includes(k)) {
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`tones.${name}.${k}`, "は 0 以上の数値で書きます");
          } else bad(`tones.${name}.${k}`, "という項目はありません");
        }
      }
      continue;
    }
    if (key === "systemVoice") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "はオブジェクトで書きます");
        continue;
      }
      const v = value as Record<string, unknown>;
      const entries = (list: unknown, where: string) => {
        if (!Array.isArray(list)) return bad(where, "は候補の配列で書きます（ファイルか { file, if, character }）");
        for (const e of list) {
          const ok = typeof e === "string" || (!!e && typeof e === "object" && typeof (e as { file?: unknown }).file === "string" && ["if", "character"].every((k) => (e as Record<string, unknown>)[k] === undefined || typeof (e as Record<string, unknown>)[k] === "string"));
          if (!ok) bad(where, "の候補はファイルか { file, if, character } で書きます");
        }
      };
      for (const [k, list] of Object.entries(v)) {
        if (k === "title" || k === "confirm") entries(list, `systemVoice.${k}`);
        else if (k === "actions") {
          if (!list || typeof list !== "object" || Array.isArray(list)) bad("systemVoice.actions", "は操作 → 候補の配列の組で書きます");
          else for (const [a, l] of Object.entries(list as Record<string, unknown>)) entries(l, `systemVoice.actions.${a}`);
        } else if (k === "volume") {
          if (typeof list !== "number" || !Number.isFinite(list)) bad("systemVoice.volume", "は数値で書きます");
        } else bad(`systemVoice.${k}`, "という項目はありません");
      }
      continue;
    }
    if (key === "indicator") {
      if (!(INDICATOR_POSITIONS as readonly unknown[]).includes(value)) bad(key, `は ${INDICATOR_POSITIONS.join("、")} のどれかを指定します`);
      continue;
    }
    if (key === "splash") {
      checkSplash(value, (where, message) => bad(`splash${where}`, message));
      continue;
    }
    if (key === "saveSlots" || key === "backlog") {
      if (typeof value !== "number" || !Number.isFinite(value)) bad(key, "は数値で書きます");
      continue;
    }
    if (key === "css") {
      if (!Array.isArray(value)) {
        bad(key, "は作品のフォルダからの CSS のファイルのパスの配列で書きます");
        continue;
      }
      value.forEach((f: unknown, i: number) => {
        const problem = typeof f === "string" ? uiCssPathProblem(f) : "は作品のフォルダの中のファイルを、作品のフォルダからの相対のパスで書きます";
        if (problem) bad(`css[${i}]`, problem);
      });
      continue;
    }
    if (key === "backlogChoices") {
      if (typeof value !== "boolean") bad(key, "は true か false で書きます");
      continue;
    }
    if (key === "keys") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(key, "はオブジェクトで書きます");
        continue;
      }
      for (const [action, list] of Object.entries(value as Record<string, unknown>)) {
        if (!(UI_KEY_ACTIONS as readonly string[]).includes(action)) bad(`keys.${action}`, `という操作はありません（${UI_KEY_ACTIONS.join("、")}）`);
        else if (!Array.isArray(list) || list.some((k) => typeof k !== "string" || k === "")) bad(`keys.${action}`, "はキーの名前の配列で書きます");
      }
      continue;
    }
    bad(key, "という項目はありません");
  }
  return out;
}

/** 起動の演出（ui.splash）の形。 */
function checkSplash(v: unknown, bad: (where: string, message: string) => void): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("", "は { logos, notice, skip, fade } で書きます");
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "logos") {
      if (!Array.isArray(x)) {
        bad(".logos", "は { image, background, time } の配列で書きます");
        continue;
      }
      x.forEach((l: unknown, i: number) => {
        const o = l as Record<string, unknown> | null;
        if (!o || typeof o !== "object" || typeof o.image !== "string" || o.image === "") return bad(`.logos[${i}]`, "に image がありません");
        for (const [lk, lv] of Object.entries(o)) {
          if (lk === "image") continue;
          if (lk === "background") {
            if (typeof lv !== "string") bad(`.logos[${i}].background`, "は文字列で書きます");
          } else if (lk === "time") {
            if (!num(lv)) bad(`.logos[${i}].time`, "は 0 以上の数値で書きます");
          } else bad(`.logos[${i}].${lk}`, "という項目はありません");
        }
      });
    } else if (k === "notice") {
      const n = x as Record<string, unknown> | null;
      if (!n || typeof n !== "object" || Array.isArray(n)) {
        bad(".notice", "は { title, blocks, background, color, time, auto } で書きます");
        continue;
      }
      for (const [nk, nv] of Object.entries(n)) {
        if (nk === "title" || nk === "background" || nk === "color") {
          if (typeof nv !== "string") bad(`.notice.${nk}`, "は文字列で書きます");
        } else if (nk === "time") {
          if (!num(nv)) bad(".notice.time", "は 0 以上の数値で書きます");
        } else if (nk === "auto") {
          if (typeof nv !== "boolean") bad(".notice.auto", "は true か false で書きます");
        } else if (nk === "blocks") {
          if (!Array.isArray(nv)) bad(".notice.blocks", "は { label, text } の配列で書きます");
          else
            nv.forEach((b: unknown, i: number) => {
              const o = b as Record<string, unknown> | null;
              if (!o || typeof o !== "object" || typeof o.text !== "string") bad(`.notice.blocks[${i}]`, "に text がありません");
              else if ((o.label !== undefined && typeof o.label !== "string") || Object.keys(o).some((bk) => bk !== "label" && bk !== "text")) bad(`.notice.blocks[${i}]`, "は { label, text } で書きます");
            });
        } else bad(`.notice.${nk}`, "という項目はありません");
      }
    } else if (k === "skip") {
      if (typeof x !== "boolean") bad(".skip", "は true か false で書きます");
    } else if (k === "fade") {
      if (!num(x)) bad(".fade", "は 0 以上の数値で書きます");
    } else bad(`.${k}`, "という項目はありません");
  }
}

/** タイトルの variants の形（if は式として読めるか）。 */
function isImageSlice(v: unknown): boolean {
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return ok(v) || (Array.isArray(v) && v.length === 4 && v.every(ok));
}

function checkTitleMenu(v: unknown, bad: (where: string, message: string) => void): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("", "は { align, direction, gap, width } で書きます");
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "align") {
      if (x !== "left" && x !== "center" && x !== "right") bad(".align", "は left・center・right のどれかです");
    } else if (k === "direction") {
      if (x !== "column" && x !== "row") bad(".direction", "は column か row です");
    } else if (k === "gap" || k === "width") {
      if (typeof x !== "number" || !Number.isFinite(x)) bad(`.${k}`, "は数値で書きます");
    } else bad(`.${k}`, "という項目はありません");
  }
}

function checkTitleVariants(v: unknown, bad: (where: string, message: string) => void): void {
  if (!Array.isArray(v)) return bad("", "は { if, background, bgm, bgmVolume, logo, showName } の配列で書きます");
  const types: Record<string, string> = { if: "string", background: "string", bgm: "string", bgmVolume: "number", logo: "string", showName: "boolean", resume: "boolean" };
  v.forEach((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad(`[${i}]`, "はオブジェクトで書きます");
    const o = e as Record<string, unknown>;
    if (typeof o.if !== "string") bad(`[${i}].if`, "がありません（\"(system.cleared)\" のような式）");
    else {
      try {
        parseExpr(o.if);
      } catch (err) {
        bad(`[${i}].if`, `の式が読めません（${(err as Error).message}）`);
      }
    }
    for (const [k, x] of Object.entries(o)) {
      if (!types[k]) bad(`[${i}].${k}`, "という項目はありません");
      else if (typeof x !== types[k]) bad(`[${i}].${k}`, `は${types[k] === "number" ? "数値" : types[k] === "string" ? "文字列" : " true か false "}で書きます`);
    }
  });
}
