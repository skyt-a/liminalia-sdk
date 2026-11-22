import { PLAY_COMMANDS, soundFilterParam } from "./registry-play.ts";
import { CHOICE_EN, CORE_COMMANDS_EN, SHARED_PARAMS_EN, withCommandEnglish, withEnglish } from "./registry-en.ts";
import { BUILTIN_TONES } from "./tone.ts";
import { SPRITE_FOCUS_MODES } from "./ui.ts";

/** @camera・@reset-camera などの ease で使えるイージングの名前（@liminalia/web の EASINGS と同じ並び）。 */
export const CAMERA_EASINGS = ["ease", "linear", "easeInSine", "easeOutSine", "easeInOutSine", "easeInQuad", "easeOutQuad", "easeInOutQuad", "easeInCubic", "easeOutCubic", "easeInOutCubic"] as const;

/**
 * 命令の仕様。検査・補完・リファレンス生成・実行がすべてここを読む（仕様の正本はここ一か所）。
 * 作品固有の命令（章タイトルの演出など）は、プラグインが同じ形で追加する（@liminalia/sdk）。
 */

export type ParamType =
  /**
   * suggest は入力の候補（制作画面で一覧から選べる。ほかの値も書ける）。
   * translate は多言語の訳の対象。text はプレイヤーに見せる文（訳のファイルの lines に「コマンドの文字」として並び、実行するときに訳す）、
   * name は話者や相手の名前（訳のファイルの speakers に並ぶ。訳して見せるのは命令の実装）。
   * data は作品のデータの中の名前（file は paths.data の .json、path はその中の辞書か並びへの道。並びなら項目の id）。
   * プラグインの検査が実在を確かめ、制作画面が名前の候補を出す（@liminalia/sdk の t.dataKey）。
   * tone は色調の名前（組み込みと liminalia.json の ui.tones）。制作画面は作品の ui.tones の名前も候補に足す。
   * nvlStyle は NVL の見た目の名前（liminalia.json の ui.nvlStyles）。構文チェックが実在を確かめる。
   */
  | { kind: "string"; suggest?: readonly string[]; translate?: "text" | "name"; data?: { file: string; path: string }; tone?: true; nvlStyle?: true }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "bool" }
  | { kind: "duration" }
  | { kind: "color" }
  | { kind: "enum"; values: readonly string[] }
  /**
   * 素材のパス。folder はプロジェクト内の探し先。cg なら、この素材を出したときに CG として解放する
   * （liminalia.json の extra.cg にある画像か、extra.cgAuto のフォルダの下の画像なら。@cg-unlock を書かなくてよい）。
   */
  | { kind: "asset"; folder: string; cg?: boolean }
  /**
   * キャストに登録された名前。shown は、表示中の立ち絵の人物に効く引数（消す、動かす、揺らす、ぼかしの焦点など）。
   * 制作画面の補完が、その行で表示中の人物を候補の上に並べる（ほかの人物も候補に残す。検査と実行には使わない）。
   */
  | { kind: "cast"; shown?: true }
  /** 同じ命令の cast 型の引数のキャストにある立ち絵セット。 */
  | { kind: "appearance" }
  /** 同じ命令のキャスト・立ち絵セット（appearance 型の引数。無ければ既定の立ち絵セット）にある差分。 */
  | { kind: "variant" }
  /** 同じ命令の差分の立ち位置（枠の positions の名前）か auto。 */
  | { kind: "position" }
  /** 飛び先（`#ラベル`・`ファイル`・`ファイル#ラベル`）。検査でラベルとファイルの実在を確かめる。 */
  | { kind: "target" }
  /** 値を入れる変数（`game.x` / `system.x` / `temp.x`）。命令の結果を受け取るときに使う。 */
  | { kind: "variable" }
  /** 条件。必ず式（`(…)`）で書き、実行時に評価して真偽を見る（@if と同じ）。 */
  | { kind: "condition" };

export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  /** 既定値。.lim の値の書き方で書く（例: "300ms"、"true"）。 */
  default?: string;
  /** ここに挙げた引数がすべて書かれていると、この引数は意味を持たない（一緒に書くとエラー。書き方を一通りにするため）。 */
  redundantWith?: readonly string[];
  /** 必ず書く。ただし、ここに挙げた引数のどれかを書けば要らない（@bg の image と color のように、どちらか一つを書くもの）。 */
  requiredUnless?: readonly string[];
  /**
   * default を作品の設定（liminalia.json の commandDefaults）で決めたなら true。standardDefault はそのときの、コマンドの仕様の既定値
   * （無ければ書かない）。applyCommandDefaults が付ける。
   */
  projectDefault?: true;
  standardDefault?: string;
  doc: string;
  /** 英語の説明（無ければ doc を出す）。組み込みは registry-en.ts の表から付く。 */
  docEn?: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** 英語の要約（無ければ summary を出す）。組み込みは registry-en.ts の表から付く。 */
  summaryEn?: string;
  /** 位置引数として書く引数名（順番どおり）。これらは key=value では書けない。 */
  positional: readonly string[];
  /**
   * 位置引数を埋めたあとの名前なしの値一つを受ける引数（名前を付けても書ける）。対象を取らない命令の時間（@mask 600ms の time）。
   * args.ts の normalizeBooleanArgs が名前を付けて読む。
   */
  bare?: string;
  params: Readonly<Record<string, ParamSpec>>;
  example: string;
  /** 英語の例（人物の名前や見せる文字を英語にしたもの。無ければ example を出す）。組み込みは registry-en.ts の表から付く。 */
  exampleEn?: string;
  /** @define で作ったマクロ（引数の型に target が無いので、飛び先を文字列で受ける）。 */
  macro?: boolean;
  /** 中で @content を使うマクロ（@with で中身を渡して呼ぶ）。 */
  block?: boolean;
  /**
   * 演出の終わりを待ってから次へ進むか（待つ命令は、演出の時間だけシナリオが止まる）。引数 wait を書けばそれが優先し、
   * wait を持つ命令ではその既定値と同じにする。省略は待たない。制作画面の演出の流れとリファレンスが使う
   * （実行器の実装とは runtime のテストで突き合わせる）。
   */
  waits?: boolean;
  /**
   * この命令でプレイが終わる（タイトルへ戻る・ゲームを終えるなど。あとの行へは進まない）。制作画面の地図は、
   * この命令で終わる場面を「終わり」にして、次の場面へ矢印を引かない。
   */
  ends?: boolean;
  /** パーツの欄の区切り（プラグインの命令が書く。組み込みは command-meta.ts）。 */
  category?: string;
  /** やりたいことの言葉（プラグインの命令が書く。組み込みは command-meta.ts）。パーツの欄の検索と AI の手引きが読む。 */
  keywords?: readonly string[];
  /** やりたいことの言葉の英語（Studio の英語表示で探すとき）。組み込みは registry-en.ts の表から付く。 */
  keywordsEn?: readonly string[];
}

export type Registry = ReadonlyMap<string, CommandSpec>;

const duration = (doc: string, def: string): ParamSpec => ({ type: { kind: "duration" }, default: def, doc });
const flag = (doc: string, def: boolean): ParamSpec => ({ type: { kind: "bool" }, default: String(def), doc });
const volume: ParamSpec = { type: { kind: "int", min: 0, max: 100 }, default: "100", doc: "音量（0〜100）", docEn: SHARED_PARAMS_EN.volume };
const soundFilterParams = (what: string): Record<string, ParamSpec> => ({
  ...soundFilterParam(`${what}に掛ける音のフィルター`),
  "filter-fade": { type: { kind: "duration" }, default: "0ms", doc: "フィルターを掛けるのと外すのにかける時間（鳴っている同じ曲に掛け直すとき）" },
});

/** 画像の出し入れの動き（@liminalia/web の transitions.ts と同じ並び）。 */
const TRANSITION_METHODS = ["crossfade", "fadeIn", "fadeInLeft", "fadeInRight", "fadeInUp", "fadeInDown", "slideInLeft", "slideInRight", "slideInUp", "slideInDown", "puffIn", "vanishIn"];

/**
 * 組み込みのルール（ルール画像を描かなくても使える切り替えの型。@liminalia/web の ruleFromPattern）。
 * wipe-* はその向きへ拭う、circle-in は外から中へ・circle-out は中から外へ、blinds は横の帯・blinds-vertical は縦の帯、
 * diamond はひし形が広がる、noise はばらばらのます目。
 */
export const RULE_PATTERNS = ["wipe-left", "wipe-right", "wipe-up", "wipe-down", "circle-in", "circle-out", "blinds", "blinds-vertical", "diamond", "noise"] as const;

/** ルール画像の切り替え（ユニバーサルトランジション）の引数。書けば method より優先する。 */
export const RULE_PARAMS: Readonly<Record<string, ParamSpec>> = {
  rule: { type: { kind: "asset", folder: "image" }, doc: "ルール画像（白黒）。暗いところから先に切り替わる。method より優先する", docEn: SHARED_PARAMS_EN.rule },
  pattern: { type: { kind: "enum", values: [...RULE_PATTERNS] }, doc: "組み込みのルール（rule を書かないとき。wipe-left、circle-out、blinds、noise など）", docEn: SHARED_PARAMS_EN.pattern },
  vague: { type: { kind: "int", min: 0, max: 255 }, default: "64", doc: "ルールの境目のぼかし（0〜255。大きいほど柔らかい）", docEn: SHARED_PARAMS_EN.vague },
};

/**
 * 時間のかかる演出をクリック（決定キー・タップ）で終わりまで飛ばせるか。演出に時間をかける命令が持つ。
 * 作品全体で飛ばさないなら liminalia.json の ui.input.skipEffects を false にする。
 */
export const SKIP_PARAM: ParamSpec = {
  type: { kind: "bool" },
  default: "true",
  doc: "クリック、決定キー、タップで演出を終わりまで飛ばせる。false なら飛ばせない（スキップ中は書かなくてもすぐ終わる）",
  docEn: SHARED_PARAMS_EN.skip,
};

const number = (doc: string, def?: string): ParamSpec => (def === undefined ? { type: { kind: "number" }, doc } : { type: { kind: "number" }, default: def, doc });

/** 立ち絵が出るとき・消えるときの動き（fade はその場で。left・right・top・bottom はその側から入る、その側へ出る。zoom は小さい姿から、小さい姿へ）。 */
export const SPRITE_MOTIONS = ["fade", "left", "right", "top", "bottom", "zoom"] as const;
const MOTION_DISTANCE: ParamSpec = { type: { kind: "number", min: 0 }, default: "160", doc: "left・right・top・bottom で動く距離（px）", docEn: SHARED_PARAMS_EN.distance };

export const CORE_COMMANDS: readonly CommandSpec[] = withEnglish<CommandSpec>([
  {
    name: "bg",
    summary: "背景を切り替える",
    positional: ["image"],
    params: {
      image: { type: { kind: "asset", folder: "bgimage", cg: true }, requiredUnless: ["color"], doc: "背景画像（単色にするなら代わりに color を書く）" },
      color: { type: { kind: "color" }, redundantWith: ["image"], doc: "単色の背景の色。image の代わりに書く。画像を用意しなくてよく、セーブにも色のまま残る" },
      time: duration("切り替えにかける時間", "0ms"),
      method: { type: { kind: "enum", values: TRANSITION_METHODS }, default: "crossfade", doc: "切り替え方" },
      cross: flag("新旧の背景を重ねて切り替える", false),
      wait: flag("切り替え終わるまで次に進まない", true),
      "hide-window": flag("true なら、切り替えている time の間はメッセージウィンドウを非表示にし、次の本文を表示するときに再表示する。省けば表示したままで、一枚絵の差分を替えるときもメッセージウィンドウは残る", false),
      "keep-text": flag("true なら、クリックでページを送ってすぐこの行に来たとき、前のページの名前と本文を消さずに次の本文まで残す（一枚絵の差分を替える間も台詞を見せておく）。前の行で消えていれば戻らない。liminalia.json の ui.message.keepText で作品全体を以前の動きに戻せる", false),
      alt: { type: { kind: "string", translate: "text" }, doc: "絵の説明。画面には出さず、次の本文と一緒にスクリーンリーダーとテキスト読み上げに渡す" },
      tone: { type: { kind: "string", suggest: [...Object.keys(BUILTIN_TONES), "none"], tone: true }, doc: "この背景が出ている間、立ち絵に掛ける色調（@tone と同じ名前。none は掛けない）。省くと liminalia.json の ui.backgroundTones のもの。@tone で色調を決めた立ち絵は @tone の色調のまま" },
      ...RULE_PARAMS,
      skip: SKIP_PARAM,
    },
    example: "@bg room_night.jpg time=1s pattern=wipe-right",
    waits: true,
  },
  {
    name: "chara",
    summary: "立ち絵を表示する、または差し替える。表示中のキャラクターは、書かなかった差分、立ち絵セット、位置、反転を今のまま保つ（表示していなければ既定）",
    positional: ["who", "variant"],
    params: {
      who: { type: { kind: "cast" }, required: true, doc: "キャラクター ID" },
      variant: { type: { kind: "variant" }, doc: "差分（表情やポーズ）。省くと、表示中のキャラクターは今の差分、表示していなければ標準の差分（normal → default → 最初のもの）" },
      appearance: { type: { kind: "appearance" }, doc: "立ち絵セット（服装、時代、状態など）。省くと、表示中のキャラクターは今のもの、表示していなければ既定の立ち絵セット（defaultAppearance → default → 最初のもの）" },
      at: {
        type: { kind: "position" },
        redundantWith: ["x", "y"],
        doc: "立ち位置。差分のフレーム（frame）の positions の名前か auto。positions にない名前は center になる。auto の立ち絵どうしは横に等間隔で並ぶ。at、x、y をどれも省くと、表示中のキャラクターは今の位置、表示していなければ center",
      },
      x: number("左端の位置（px）。書くと at より優先する"),
      y: number("上端の位置（px）。書くと at より優先する"),
      width: number("幅（px）。省くと、表示中のキャラクターは今の大きさ、表示していなければ差分の大きさ"),
      height: number("高さ（px）。省くと、表示中のキャラクターは今の大きさ、表示していなければ差分の大きさ"),
      flip: { type: { kind: "bool" }, doc: "左右反転。省くと、表示中のキャラクターは今のまま、表示していなければ反転しない" },
      cross: flag("画像の差し替えで、新旧を重ねて切り替える。false なら新しい画像を表示し終えてから古い画像を消す", true),
      time: duration("表示や差し替えにかける時間", "0ms"),
      wait: flag("表示や差し替えが終わるまで次に進まない", false),
      "if-hidden": flag("表示していないときだけ表示する。表示中なら何もしない", false),
      enter: { type: { kind: "enum", values: SPRITE_MOTIONS }, default: "fade", doc: "表示していなかったキャラクターの出方。fade はその場で、left、right、top、bottom はその側から distance の距離を滑って、zoom は小さい姿から大きくなって、time の時間で出る" },
      distance: MOTION_DISTANCE,
      slide: flag("表示中のキャラクターの立ち位置が変わるとき、消してから出し直さずに、time の時間で新しい位置へ滑らせる", false),
      z: { type: { kind: "int" }, doc: "重なり順。大きいほど手前で、同じなら後から出したものが手前。省くと、表示中のキャラクターは今のまま、表示していなければ 0" },
      solo: flag("ほかのキャラクターの立ち絵を消してから出す（time の時間で入れ替える）。一人ずつ出す作品は commandDefaults の chara に書く", false),
      replace: { type: { kind: "string", suggest: ["left", "center", "right"] }, doc: "入れ替える相手。表示中の人物の名前か、その人物の立ち位置の名前で書く。立ち位置の名前は left、center、right、立ち絵の枠（frame）の positions の名前、autoLayout の positions に書いた名前、autoLayout の byCount で読み替えたあとの名前が使える（x、y で置いた人物は名前で書く）。left、center、right と autoLayout の positions の名前は、同じ名前の人物がいても立ち位置として読む。相手の位置と登場順を引き継ぎ、ほかの人物はそのまま残す" },
      "auto-layout": flag("位置を指定せず初めて出す人物を、登場順で左から自動配置する。人数が変わると立ち絵を一度消して並べ直す。作品全体で使うなら commandDefaults の chara に設定する。並べ方は liminalia.json の autoLayout と cast.json の side で変えられる", false),
      "auto-fade": duration("自動配置で並べ直す前に、表示中の立ち絵を消す時間。新しい配置の表示時間は time", "300ms"),
      clear: { type: { kind: "duration" }, doc: "表示する前に全員の立ち絵をこの時間で消す（本人も含む）。@chara-hide-all time=… の直後に @chara を書くのと同じ。表示の時間は time で指定する" },
      swap: {
        type: { kind: "enum", values: ["after", "cross"] },
        default: "after",
        doc: "行き先の立ち位置で、ほかのキャラクターの立ち絵がまだ消えていく途中のときの出し方。after は消え終わってから出し、二人が重ならない。立っているキャラクターを動かすときも、行き先に現すのは消え終わってから。cross は重ねて出す（旧バージョンの動作）。作品全体で替えるなら commandDefaults の chara に書く",
      },
      alt: { type: { kind: "string", translate: "text" }, doc: "絵の説明。画面には出さず、次の本文と一緒にスクリーンリーダーとテキスト読み上げに渡す" },
      skip: SKIP_PARAM,
    },
    example: "@chara ユイカ smile at=left time=300ms",
  },
  {
    name: "plane",
    summary: "奥行きのある背景の絵を重ねる（遠くの空、山、手前の草など）。@camera で動かすと、奥のものほど小さく動く。同じ名前は置き換え、@bg で外れる",
    positional: ["name", "image"],
    params: {
      name: { type: { kind: "string" }, required: true, doc: "名前（@plane-hide で外すため）" },
      image: { type: { kind: "asset", folder: "bgimage" }, required: true, doc: "絵（bgimage）。透明なところは後ろが見える" },
      depth: { type: { kind: "number", min: -1, max: 1 }, default: "0.5", doc: "奥行き。0 は立ち絵と同じに動き、1 に近いほど動かない。負の値は手前で、より大きく動く。奥のものほど後ろに重ねる" },
      front: flag("立ち絵より手前に置く", false),
      time: duration("出るまでの時間", "0ms"),
      wait: flag("出終わるまで次に進まない", false),
      skip: SKIP_PARAM,
    },
    example: "@plane sky sky.png depth=0.9",
  },
  {
    name: "plane-hide",
    summary: "@plane で重ねた絵を外す",
    positional: ["name"],
    params: {
      name: { type: { kind: "string" }, doc: "外す名前（省くとすべて）" },
      time: duration("消えるまでの時間", "0ms"),
      wait: flag("消え終わるまで次に進まない", false),
      skip: SKIP_PARAM,
    },
    example: "@plane-hide sky time=500ms",
  },
  {
    name: "dof",
    summary: "被写界深度。ピントを合わせるところを決め、ほかをぼかす。背景に合わせれば立ち絵と前景の画像を、立ち絵に合わせれば背景と前景の画像をぼかす。none で戻す",
    positional: ["on"],
    params: {
      on: { type: { kind: "enum", values: ["background", "sprites", "none"] }, default: "none", doc: "ピントを合わせるところ（background 背景 / sprites 立ち絵 / none ぼかさない）。who を書けば省ける" },
      who: { type: { kind: "cast", shown: true }, doc: "ピントを合わせるキャラクター（背景とほかの立ち絵をぼかす。ほかの立ち絵は半分の強さ）" },
      blur: { type: { kind: "number", min: 0 }, default: "6", doc: "ぼかしの強さ（px）" },
      time: duration("変わるまでの時間", "0ms"),
      wait: flag("変わり終わるまで次に進まない", false),
      skip: SKIP_PARAM,
    },
    example: "@dof sprites blur=8 time=600ms",
  },
  {
    name: "tone",
    summary: "立ち絵の色調を変える（時間帯や回想に合わせる）。キャラクターを書かなければ、これから出すものも含めてすべての立ち絵の色調を変える。背景の色調（@bg の tone=）より優先する。none で戻し、背景に色調があればその色調になる",
    positional: ["tone"],
    params: {
      tone: { type: { kind: "string", suggest: [...Object.keys(BUILTIN_TONES), "none"], tone: true }, required: true, doc: "色調（sepia セピア / mono 白黒 / night 夜 / evening 夕方 / dark 暗く / plain 色を変えない（背景の色調も掛けない）/ none 戻す と、liminalia.json の ui.tones で決めたもの）" },
      who: { type: { kind: "cast", shown: true }, doc: "キャラクター ID（省くとすべての立ち絵。人物ごとに変えた色調も外す）" },
      time: duration("変わるまでの時間", "0ms"),
      wait: flag("変わり終わるまで次に進まない", false),
      skip: SKIP_PARAM,
    },
    example: "@tone night time=1s",
  },
  {
    name: "chara-config",
    summary: "立ち絵の振る舞い（話しているキャラクターの目立たせ方、自動配置で並べ直す速さ）を設定する。書いた項目だけ変える",
    positional: [],
    params: {
      focus: {
        type: { kind: "enum", values: [...SPRITE_FOCUS_MODES] },
        doc: "話していないキャラクターの見せ方。dim は暗く、lower は少し下げる、dim-lower は暗くして下げる、blur はぼかす、dim-blur は暗くしてぼかす、none は変えない（地の文のときは誰も変えない）。書くまでは作品の設定（liminalia.json の ui.chara）",
      },
      dim: { type: { kind: "number", min: 0, max: 1 }, doc: "暗くするときの明るさ（0〜1。既定 0.6）" },
      lower: { type: { kind: "number", min: 0 }, doc: "下げるときの量（px。既定 12）" },
      jump: { type: { kind: "bool" }, doc: "話し始めたキャラクターを小さく跳ねさせる" },
      "move-time": { type: { kind: "duration" }, doc: "自動配置で並べ直すのにかける時間。省くと表示や消去にかける時間と同じ" },
      easing: { type: { kind: "enum", values: ["ease", "linear", "ease-in", "ease-out", "ease-in-out"] }, doc: "並べ直すときのイージング（既定 ease）" },
    },
    example: "@chara-config focus=dim-lower dim=0.7 jump=true",
  },
  {
    name: "chara-hide",
    summary: "立ち絵を消す",
    positional: ["who"],
    params: {
      who: { type: { kind: "cast", shown: true }, required: true, doc: "キャラクター ID" },
      time: duration("消えるまでの時間", "0ms"),
      exit: { type: { kind: "enum", values: SPRITE_MOTIONS }, default: "fade", doc: "消え方。fade はその場で、left、right、top、bottom はその側へ distance の距離を滑って、zoom は小さくなって、time の時間で消える" },
      distance: MOTION_DISTANCE,
      wait: flag("消え終わるまで次に進まない", false),
      skip: SKIP_PARAM,
    },
    example: "@chara-hide ユイカ time=300ms",
  },
  {
    name: "chara-hide-all",
    summary: "立ち絵をすべて消す",
    positional: [],
    bare: "time",
    params: {
      time: duration("消えるまでの時間。名前なしでも書ける（@chara-hide-all 300ms）", "0ms"),
      exit: { type: { kind: "enum", values: SPRITE_MOTIONS }, default: "fade", doc: "消え方（@chara-hide の exit と同じ）" },
      distance: MOTION_DISTANCE,
      wait: flag("消え終わるまで次に進まない", false),
      skip: SKIP_PARAM,
    },
    example: "@chara-hide-all time=500ms",
  },
  {
    name: "face",
    summary: "立ち絵を表示していないキャラクターの、顔ウィンドウの表情を決める。立ち絵を表示中のキャラクターは立ち絵の差分を使う。立ち絵を消したときは、消す前の差分を引き継ぐ",
    positional: ["who", "variant"],
    params: {
      who: { type: { kind: "cast" }, required: true, doc: "キャラクター ID" },
      variant: { type: { kind: "variant" }, doc: "差分（表情）。省くと標準の差分" },
      appearance: { type: { kind: "appearance" }, doc: "立ち絵セット。省くと既定の立ち絵セット" },
    },
    example: "@face ユイカ smile",
  },
  {
    name: "face-off",
    summary: "ui.face の show が explicit のとき、顔ウィンドウを消す。@face で出すまで出さない",
    positional: [],
    params: {},
    example: "@face-off",
  },
  {
    name: "bgm",
    summary: "BGM を鳴らす",
    positional: ["file"],
    params: {
      file: { type: { kind: "asset", folder: "bgm" }, required: true, doc: "音声ファイル" },
      volume,
      time: duration("フェードインにかける時間", "0ms"),
      loop: flag("繰り返す", true),
      crossfade: duration("今の BGM から重ねて替える時間（新しい曲を読み込んでから、今の曲を消しつつ新しい曲を入れる）", "0ms"),
      "loop-start": { type: { kind: "duration" }, doc: "ループの開始位置（イントロのあと）。省くと曲に埋め込まれた LOOPSTART、無ければ曲の先頭" },
      "loop-end": { type: { kind: "duration" }, doc: "ループの終わりの位置。省くと曲に埋め込まれた LOOPLENGTH から求め、無ければ曲の最後" },
      pan: { type: { kind: "int", min: -100, max: 100 }, default: "0", doc: "左右の定位（-100 で左、100 で右）" },
      rate: { type: { kind: "number", min: 0.1, max: 4 }, default: "1", doc: "再生速度（1 で等速。音の高さも変わる）" },
      ...soundFilterParams("BGM "),
    },
    example: "@bgm night_rain.ogg crossfade=2s loop-start=12.5s",
  },
  {
    name: "stop-bgm",
    summary: "BGM を止める",
    positional: [],
    bare: "time",
    params: { time: duration("フェードアウトにかける時間。名前なしでも書ける（@stop-bgm 600ms）", "0ms") },
    example: "@stop-bgm time=600ms",
  },
  {
    name: "se",
    summary: "効果音を鳴らす",
    positional: ["file"],
    params: {
      file: { type: { kind: "asset", folder: "sound" }, required: true, doc: "音声ファイル" },
      channel: { type: { kind: "int", min: 0 }, default: "0", doc: "再生チャンネル。同じチャンネルの音は上書きされる" },
      volume,
      time: duration("フェードインにかける時間", "0ms"),
      loop: flag("繰り返す", false),
      pan: { type: { kind: "int", min: -100, max: 100 }, default: "0", doc: "左右の定位（-100 で左、100 で右）" },
      rate: { type: { kind: "number", min: 0.1, max: 4 }, default: "1", doc: "再生速度（1 で等速。音の高さも変わる）" },
      caption: { type: { kind: "string", translate: "text" }, doc: "字幕。コンフィグで効果音の字幕をオンにした人に出す。省くと liminalia.json の ui.captions.sounds のもの" },
      ...soundFilterParams("効果音"),
    },
    example: "@se breakage/glass_crack.mp3 pan=-60",
  },
  {
    name: "stop-se",
    summary: "効果音を止める",
    positional: [],
    bare: "time",
    params: {
      channel: { type: { kind: "int", min: 0 }, default: "0", doc: "止めるチャンネル" },
      time: duration("フェードアウトにかける時間。名前なしでも書ける（@stop-se 1s）", "0ms"),
    },
    example: "@stop-se time=1s",
  },
  {
    name: "wait",
    summary: "指定した時間だけ待つ",
    positional: ["time"],
    params: { time: { type: { kind: "duration" }, required: true, doc: "待つ時間" }, skip: SKIP_PARAM },
    example: "@wait 1s",
    waits: true,
  },
  {
    name: "mask",
    summary: "画面を一色で覆う（暗転）",
    positional: [],
    bare: "time",
    params: {
      color: { type: { kind: "color" }, default: "#000000", doc: "覆う色" },
      time: duration("覆い終わるまでの時間。名前なしでも書ける（@mask 600ms）", "0ms"),
      method: { type: { kind: "enum", values: TRANSITION_METHODS }, default: "crossfade", doc: "覆うときの動き（@bg の method と同じ）" },
      "hide-window": flag("覆い終えたところでメッセージウィンドウを非表示にし、次の本文を表示するときに再表示する（明転のときに前の本文を見せない）。false なら表示したまま", true),
      ...RULE_PARAMS,
      skip: SKIP_PARAM,
    },
    example: "@mask time=1s",
    waits: true,
  },
  {
    name: "mask-off",
    summary: "画面の覆いを外す（明転）",
    positional: [],
    bare: "time",
    params: {
      time: duration("外し終わるまでの時間。名前なしでも書ける（@mask-off 600ms）", "0ms"),
      method: { type: { kind: "enum", values: TRANSITION_METHODS }, default: "crossfade", doc: "覆いの外し方（@bg の method の消えていく向きの動き）" },
      ...RULE_PARAMS,
      skip: SKIP_PARAM,
    },
    example: "@mask-off time=1s",
    waits: true,
  },
  {
    name: "scene-change",
    summary: "場面転換。暗転し、立ち絵をすべて消して背景を切り替えてから明転する（@mask、@chara-hide-all、@bg、@mask-off をこの順に一つの命令で行う）。暗転したところで BGM を止めたり替えたりもできる",
    positional: ["image"],
    params: {
      image: { type: { kind: "asset", folder: "bgimage", cg: true }, doc: "背景画像。省くと背景はそのまま（立ち絵を消すだけ）" },
      "bg-color": { type: { kind: "color" }, redundantWith: ["image"], doc: "背景を単色にする（image の代わりに書く。@bg color= と同じ）" },
      time: { type: { kind: "duration" }, default: "1s", redundantWith: ["fade-out", "fade-in"], doc: "暗転と明転のそれぞれにかける時間" },
      "fade-out": { type: { kind: "duration" }, doc: "暗転（画面を覆う）にかける時間。省くと time" },
      "fade-in": { type: { kind: "duration" }, doc: "明転（覆いを外す）にかける時間。省くと time" },
      hold: duration("暗転したまま置く時間（背景を切り替えてから明転し始めるまで）", "0ms"),
      "hide-chara": flag("立ち絵を消す。false なら全員を残す（hide-who・hide-chara-at・hide-fade は使わない）", true),
      "hide-who": { type: { kind: "cast", shown: true }, doc: "消すキャラクター。省くと全員を消し、指定したときはほかの立ち絵を残す" },
      "hide-chara-at": { type: { kind: "enum", values: ["covered", "start"] }, default: "covered", doc: "立ち絵を消し始めるタイミング。covered は暗転した後、start は暗転と同時" },
      "hide-at": { type: { kind: "enum", values: ["covered", "start"] }, redundantWith: ["hide-chara-at"], doc: "旧名。hide-chara-at と同じ（両方は指定しない）" },
      "hide-fade": duration("立ち絵を消す時間。暗転・明転の時間とは別", "0ms"),
      color: { type: { kind: "color" }, default: "#000000", doc: "暗転の色" },
      "stop-bgm": { ...flag("暗転したところで BGM を止める", false), redundantWith: ["bgm"] },
      bgm: { type: { kind: "asset", folder: "bgm" }, doc: "暗転したところで流す BGM。今の BGM から替え、繰り返し流す。細かく決めるなら @bgm を別に書く" },
      "bgm-volume": { type: { kind: "int", min: 0, max: 100 }, default: "100", doc: "bgm で流す BGM の音量（0〜100）" },
      "bgm-fade": duration("止める BGM のフェードアウトと、流す BGM のフェードインにかける時間（暗転したところから）", "0ms"),
      "hide-window": flag("メッセージウィンドウを隠し、次の本文で再表示する。false なら表示したまま", true),
      "hide-window-at": { type: { kind: "enum", values: ["covered", "start"] }, default: "start", doc: "メッセージ枠と操作ボタンを隠すタイミング。start は暗転と同時、covered は暗転した後。hide-window=false なら使わない" },
      tone: { type: { kind: "string", suggest: [...Object.keys(BUILTIN_TONES), "none"], tone: true }, doc: "替えた背景が出ている間、立ち絵に掛ける色調（@bg の tone= と同じ）。省くと liminalia.json の ui.backgroundTones のもの" },
    },
    example: "@scene-change street_night.jpg time=1500ms",
    waits: true,
  },
  {
    name: "quake",
    summary: "画面を揺らす",
    positional: [],
    params: {
      time: duration("揺れの長さ", "300ms"),
      count: { type: { kind: "int", min: 1 }, default: "5", doc: "揺れる回数" },
      horizontal: { type: { kind: "number", min: 0 }, default: "0", doc: "横の揺れ幅（px）" },
      vertical: { type: { kind: "number", min: 0 }, default: "10", doc: "縦の揺れ幅（px）" },
      target: { type: { kind: "enum", values: ["screen", "background"] }, default: "screen", doc: "揺らすもの（screen は背景と立ち絵と前景、background は背景だけ）" },
      wait: flag("揺れ終わるまで次に進まない", true),
      skip: SKIP_PARAM,
    },
    example: "@quake time=300ms count=3 horizontal=10",
    waits: true,
  },
  {
    name: "camera",
    summary: "画面全体をズーム、移動、回転させる",
    positional: [],
    params: {
      zoom: number("倍率（1 で等倍）"),
      x: number("カメラの横位置（ゲーム画面の px）。正で右へ動き、画面の中身は左へ流れる。寄っているほど画面上では大きく流れる"),
      y: number("カメラの縦位置（ゲーム画面の px）。正で下へ動き、画面の中身は上へ流れる。寄っているほど画面上では大きく流れる"),
      rotate: number("回転の角度（度）"),
      "from-zoom": number("開始時の倍率。省略時は現在の値"),
      "from-x": number("開始時の横位置"),
      "from-y": number("開始時の縦位置"),
      "from-rotate": number("開始時の回転の角度"),
      time: duration("動きにかける時間", "1s"),
      ease: { type: { kind: "string", suggest: CAMERA_EASINGS }, default: "ease", doc: "イージング（ease / easeOutSine など）" },
      yoyo: flag("行って戻る。time の半分で書いた姿まで動き、残りの半分で元の姿へ戻る。カメラの状態は変えない", false),
      wait: flag("動き終わるまで次に進まない", true),
      skip: SKIP_PARAM,
    },
    example: "@camera zoom=1.08 y=-10 time=900ms ease=easeOutSine",
    waits: true,
  },
  {
    name: "reset-camera",
    summary: "カメラを元に戻す",
    positional: [],
    params: {
      time: duration("戻すのにかける時間", "1s"),
      ease: { type: { kind: "string", suggest: CAMERA_EASINGS }, default: "ease", doc: "イージング" },
      wait: flag("戻り終わるまで次に進まない", true),
      skip: SKIP_PARAM,
    },
    example: "@reset-camera time=400ms",
    waits: true,
  },
  {
    name: "window",
    summary: "メッセージウィンドウを表示、または非表示にする",
    positional: ["mode"],
    params: {
      mode: { type: { kind: "enum", values: ["show", "hide"] }, required: true, doc: "show / hide" },
      time: duration("切り替えにかける時間", "0ms"),
      skip: SKIP_PARAM,
    },
    example: "@window hide",
    waits: true,
  },
  {
    name: "window-image",
    summary: "メッセージウィンドウの背景の画像を替える。画像を省くと ui.message.image に戻す",
    positional: ["image"],
    params: { image: { type: { kind: "asset", folder: "image" }, doc: "背景の画像" } },
    example: "@window-image frames/night.png",
  },
  {
    name: "nvl",
    summary: "画面全体に文章を重ねて表示する NVL モードにする、またはメッセージウィンドウに戻す。切り替えると文字は消える。style= で liminalia.json の ui.nvlStyles の見た目にする",
    positional: ["mode"],
    params: {
      mode: { type: { kind: "enum", values: ["on", "off"] }, required: true, doc: "on（NVL モード）/ off（メッセージウィンドウ）" },
      style: { type: { kind: "string", nvlStyle: true }, doc: "ui.nvlStyles にある見た目の名前。手紙や文書の場面に使う。省くと ui.nvl の見た目" },
    },
    example: "@nvl on style=letter",
  },
  {
    name: "vertical",
    summary: "本文を縦書き（右から左へ行が進む）にする、または横書きに戻す。切り替えると文字は消える。メッセージウィンドウと NVL モードに効く。既定は liminalia.json の ui.message.vertical",
    positional: ["mode"],
    params: { mode: { type: { kind: "enum", values: ["on", "off"] }, required: true, doc: "on（縦書き）/ off（横書き）" } },
    example: "@vertical on",
  },
  {
    name: "balloon",
    summary: "吹き出し表示にする（話しているキャラクターの立ち絵の上に本文を表示する）、またはメッセージウィンドウに戻す。話者の立ち絵が表示されていない台詞は、x と y を書けばその位置の吹き出し、書かなければメッセージウィンドウに表示する",
    positional: ["mode"],
    params: {
      mode: { type: { kind: "enum", values: ["on", "off"] }, required: true, doc: "on（吹き出し）/ off（メッセージウィンドウ）" },
      width: { type: { kind: "number", min: 160 }, doc: "吹き出しの幅（px。既定 520）" },
      x: { type: { kind: "number" }, doc: "話者の立ち絵が表示されていないときの吹き出しの左端（px。y と一緒に書く）" },
      y: { type: { kind: "number" }, doc: "話者の立ち絵が表示されていないときの吹き出しの上端（px）" },
      tail: { type: { kind: "enum", values: ["auto", "down", "up", "none"] }, doc: "しっぽの向き。立ち絵のない吹き出しは down（auto も同じ）か up、立ち絵があれば立ち絵へ向ける。none はしっぽを付けない" },
      "tail-x": { type: { kind: "number", min: 0 }, doc: "しっぽの位置（吹き出しの左端からの px）。省くと立ち絵の中央（なければ吹き出しの中央）" },
    },
    example: "@balloon on x=80 y=120 tail=down tail-x=60",
  },
  {
    name: "text-sound",
    summary: "本文の文字を表示するときに音を鳴らす（話者ごとに変えられる）",
    positional: ["file"],
    params: {
      file: { type: { kind: "asset", folder: "sound" }, required: true, doc: "鳴らす音（sound からのパス。短い音）" },
      who: { type: { kind: "string" }, doc: "話者の名前（本文の行の話者と同じ書き方）。省略すると、個別に設定していない話者と地の文のすべて" },
      volume,
      every: { type: { kind: "int", min: 1, max: 10 }, default: "2", doc: "何文字ごとに鳴らすか" },
    },
    example: "@text-sound pop.wav who=ユイカ every=2",
  },
  {
    name: "text-sound-off",
    summary: "文字を表示するときの音を止める",
    positional: ["who"],
    params: { who: { type: { kind: "string" }, doc: "話者の名前。省略するとすべて" } },
    example: "@text-sound-off",
  },
  {
    name: "name",
    summary:
      "話者の名前欄に出す名前（表示名）を替える。@name-off で戻すまで続く。口パク、話していない人物を暗くする処理、吹き出し、ボイス、名前の色は、元の話者のものを使う。一行だけ替えるなら 話者{name 表示名}「…」と書く",
    positional: ["who"],
    params: {
      who: { type: { kind: "string" }, required: true, doc: "話者の名前（本文の行の話者と同じ書き方）" },
      as: { type: { kind: "string" }, required: true, doc: "名前欄に出す名前。(式) で、プレイヤーが入力した名前などの変数も書ける。変数は @name を実行した時の値を使う" },
    },
    example: "@name ユイ as=？？？",
  },
  {
    name: "name-off",
    summary: "@name で替えた表示名を話者の名前に戻す",
    positional: ["who"],
    params: { who: { type: { kind: "string" }, doc: "話者の名前。省略するとすべて" } },
    example: "@name-off ユイ",
  },
  {
    name: "clear",
    summary: "メッセージウィンドウの文字を消す（NVL モードでは表示した文章をすべて消す）",
    positional: [],
    params: {},
    example: "@clear",
  },
  {
    name: "text-speed",
    summary: "テキスト速度を変える",
    positional: ["per-char"],
    params: { "per-char": { type: { kind: "duration" }, required: true, doc: "一文字あたりの時間" } },
    example: "@text-speed 30ms",
  },
  {
    name: "text-speed-reset",
    summary: "テキスト速度をコンフィグの値に戻す",
    positional: [],
    params: {},
    example: "@text-speed-reset",
  },
  {
    name: "cg-unlock",
    summary: "CG を解放し、おまけの CG で見られるようにする。表示はしない",
    positional: ["image"],
    params: {
      image: { type: { kind: "asset", folder: "bgimage" }, required: true, doc: "CG の画像" },
      folder: { type: { kind: "enum", values: ["bgimage", "fgimage"] }, default: "bgimage", doc: "素材のフォルダ（extra.cg の folder に合わせる）" },
    },
    example: "@cg-unlock stills/ending_a.png",
  },
  {
    name: "wait-click",
    summary: "本文を表示せずにクリックを待つ",
    positional: [],
    params: {},
    example: "@wait-click",
  },
  {
    name: "stop",
    summary: "クリックでは進まない状態で止まる（ボタンや外部の操作を待つ）",
    positional: [],
    params: {},
    example: "@stop",
  },
  ...PLAY_COMMANDS,
], CORE_COMMANDS_EN);

/**
 * @choice の選択肢の行（`- 文 -> 飛び先 …`）の飛び先のあとに書ける指定。
 * if は出す条件（偽なら、その選択肢を出さない）。ほかは見た目で、
 * image を書くと画像のボタン、image を書かずに width と height を書くと見えない押せる範囲になる。
 * どちらも書かなければ文字のボタン（x・y で置き場所を決められる）。
 */
export const CHOICE_OPTION: CommandSpec = withCommandEnglish<CommandSpec>({
  name: "choice",
  summary: "選択肢の行の条件と見た目",
  positional: [],
  params: {
    locked: { type: { kind: "condition" }, doc: "真なら押せない状態で表示する（条件を満たしていない選択肢を、隠さずに見せる）" },
    if: { type: { kind: "condition" }, doc: "表示する条件。偽ならこの選択肢を表示しない（すべて偽なら選択肢を表示せずに止まる）" },
    call: { type: { kind: "bool" }, doc: "ジャンプ先を呼び出し（@call）、@return でこの選択肢へ戻ってもう一度表示する（切り替えのボタンなど）" },
    image: { type: { kind: "asset", folder: "image" }, doc: "ボタンの画像" },
    hover: { type: { kind: "asset", folder: "image" }, doc: "マウスオーバー時の画像" },
    x: { type: { kind: "number" }, doc: "左上の横位置（px）" },
    y: { type: { kind: "number" }, doc: "左上の縦位置（px）" },
    width: { type: { kind: "number", min: 0 }, doc: "幅（px）。画像なら省略時は画像の大きさ" },
    height: { type: { kind: "number", min: 0 }, doc: "高さ（px）" },
    cursor: { type: { kind: "asset", folder: "image" }, doc: "上に乗せたときのマウスのカーソルの画像（調べる場所の虫眼鏡など。押す点は画像の真ん中）" },
    tip: { type: { kind: "string", translate: "text" }, doc: "上に乗せたときに出す短い説明（調べる場所の名前など）" },
  },
  example: "- 扉を調べる -> #door if=(game.has_key) image=button/door.png hover=button/door_on.png x=120 y=300",
}, CHOICE_EN.option);

/** @choice の行のパラメータ（制限時間つきの選択肢）。 */
export const CHOICE_BLOCK: CommandSpec = withCommandEnglish<CommandSpec>({
  name: "choice",
  summary: "選択肢。選択肢の行を並べ、@end で閉じる",
  positional: [],
  params: {
    timeout: { type: { kind: "duration" }, doc: "制限時間。過ぎたら default の選択肢を選ぶ（default を省くと、選ばずに @end の後へ進む）。残り時間をバーで見せる。メニューやセーブなどの画面を開いている間は減らない" },
    default: { type: { kind: "int", min: 1 }, doc: "時間切れのときに選ぶ選択肢を、上から何番目かで書く。表示されていない、または押せない選択肢なら、選ばずに @end の後へ進む" },
  },
  example: "@choice timeout=10s default=2",
}, CHOICE_EN.block);

/**
 * どの命令の行にも、@jump・@call・@set・@let・@return・@content にも書ける if=(式)（TyranoScript の cond=）。偽ならその行を飛ばす。
 * 構文解析が行を @if で囲んだ形にするので、命令の仕様には入れない（補完とリファレンスがここを読む）。
 */
export const GUARD_PARAM: ParamSpec = {
  type: { kind: "condition" },
  doc: "偽ならこの行を飛ばす（どの命令の行にも書ける。TyranoScript の cond=）",
  docEn: "If false, this line is skipped (any command line can have it; TyranoScript's cond=)",
};

export function createRegistry(...groups: readonly (readonly CommandSpec[])[]): Registry {
  const map = new Map<string, CommandSpec>();
  for (const spec of groups.flat()) map.set(spec.name, spec);
  return map;
}

/** 式の中で呼べる関数と、取る引数の数（最小・最大）。 */
export const FUNCTION_ARITY: Readonly<Record<string, readonly [min: number, max: number]>> = {
  // 乱数（作品の乱数のシードに従う）
  random: [0, 1],
  randint: [2, 2],
  pick: [1, 1],
  shuffle: [1, 1],
  // 数
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 2],
  min: [1, Infinity],
  max: [1, Infinity],
  abs: [1, 1],
  clamp: [3, 3],
  sum: [1, 1],
  // 文字列と配列
  len: [1, 1],
  includes: [2, 2],
  index: [2, 2],
  slice: [2, 3],
  replace: [3, 3],
  upper: [1, 1],
  lower: [1, 1],
  trim: [1, 1],
  split: [2, 2],
  join: [1, 2],
  pad: [2, 3],
  str: [1, 1],
  num: [1, 1],
  push: [2, 2],
  remove: [2, 2],
  sort: [1, 1],
  reverse: [1, 1],
  unique: [1, 1],
  keys: [1, 1],
  has: [2, 2],
  // 版（作品の版の比べ方。セーブを付け替えるときに save.version と比べる）
  version_before: [2, 2],
  // 現実の日時（遊んでいる端末の時計）
  year: [0, 0],
  month: [0, 0],
  day: [0, 0],
  hour: [0, 0],
  minute: [0, 0],
  weekday: [0, 0],
  now: [0, 0],
  // 持ち物（liminalia.json の items）
  item: [1, 1],
  // 進み具合と遊んでいる環境（実行器が答える。STORY_FUNCTIONS）
  visits: [1, 1],
  read: [1, 1],
  chosen: [1, 1],
  lang: [0, 0],
  platform: [0, 0],
  app: [0, 0],
  replaying: [0, 0],
  chapter: [0, 0],
  endings: [0, 1],
};

/** 関数の書き方（呼び方が二通りあるものは両方）。リファレンスと補完に出す。 */
export const FUNCTION_USAGE: Readonly<Record<string, readonly string[]>> = {
  random: ["random()", "random(n)"],
  randint: ["randint(a, b)"],
  pick: ["pick(配列)"],
  shuffle: ["shuffle(配列)"],
  floor: ["floor(x)"],
  ceil: ["ceil(x)"],
  round: ["round(x)", "round(x, 桁)"],
  min: ["min(a, b, …)"],
  max: ["max(a, b, …)"],
  abs: ["abs(x)"],
  clamp: ["clamp(x, 下限, 上限)"],
  sum: ["sum(配列)"],
  len: ["len(文字列か配列)"],
  includes: ["includes(文字列か配列, 値)"],
  index: ["index(文字列か配列, 値)"],
  slice: ["slice(文字列か配列, 始め)", "slice(文字列か配列, 始め, 終わり)"],
  replace: ["replace(文字列, 探す文字列, 置き換える文字列)"],
  upper: ["upper(文字列)"],
  lower: ["lower(文字列)"],
  trim: ["trim(文字列)"],
  split: ["split(文字列, 区切り)"],
  join: ["join(配列)", "join(配列, 区切り)"],
  pad: ["pad(値, 桁)", "pad(値, 桁, 埋める文字)"],
  str: ["str(値)"],
  num: ["num(値)"],
  push: ["push(配列, 値)"],
  remove: ["remove(配列, 値)"],
  sort: ["sort(配列)"],
  reverse: ["reverse(配列)"],
  unique: ["unique(配列)"],
  keys: ["keys(オブジェクト)"],
  has: ["has(オブジェクト, 名前)"],
  version_before: ['version_before(バージョン, "1.1.0")'],
  year: ["year()"],
  month: ["month()"],
  day: ["day()"],
  hour: ["hour()"],
  minute: ["minute()"],
  weekday: ["weekday()"],
  now: ["now()"],
  item: ['item("名前")'],
  visits: ['visits("#ラベル")', 'visits("ファイル#ラベル")', 'visits("ファイル")'],
  read: ['read("#ラベル")', 'read("ファイル#ラベル")', 'read("ファイル")'],
  chosen: ['chosen("選択肢の文")'],
  lang: ["lang()"],
  platform: ["platform()"],
  app: ["app()"],
  replaying: ["replaying()"],
  chapter: ["chapter()"],
  endings: ["endings()", 'endings("bad")'],
};

/** 関数の説明（リファレンスと補完に出す。書き方は FUNCTION_USAGE）。 */
export const FUNCTION_DOCS: Readonly<Record<string, string>> = {
  random: "引数なしは 0 以上 1 未満の数、n を渡すと 0 以上 n 未満の整数",
  randint: "a 以上 b 以下の整数",
  pick: "配列から一つ選ぶ（空なら null）",
  shuffle: "並びを混ぜた新しい配列",
  floor: "切り捨て",
  ceil: "切り上げ",
  round: "四捨五入。桁を渡すと小数第何位までにする",
  min: "いちばん小さい数",
  max: "いちばん大きい数",
  abs: "絶対値",
  clamp: "下限と上限のあいだに収める",
  sum: "数の合計",
  len: "文字列の文字数、配列の長さ",
  includes: "値を含むか",
  index: "値が最初に出てくる位置（無ければ -1）",
  slice: "一部を取り出す（終わりの位置は含まない。省くと最後まで。負の数は後ろから数える）",
  replace: "すべて置き換える",
  upper: "英字を大文字に",
  lower: "英字を小文字に",
  trim: "前後の空白を取る",
  split: "区切りで分けた配列",
  join: "区切りでつないだ文字列（区切りを省くと空）",
  pad: "前を埋めて桁をそろえる（埋める文字を省くと 0）",
  str: "文字列にする",
  num: "数にする（数として読めなければ null）",
  push: "末尾に足した新しい配列",
  remove: "その値を除いた新しい配列",
  sort: "並べ替えた新しい配列（数は小さい順、文字列は辞書の順）",
  reverse: "逆にした新しい配列",
  unique: "重なりを除いた新しい配列",
  keys: "名前の配列",
  has: "その名前があるか",
  version_before: "バージョンが比較対象より前か（1.9.0 は 1.10.0 より前、1.1.0-beta は 1.1.0 より前。空文字はどのバージョンよりも前）。アップデートでセーブデータを移行するときに save.version と比べる",
  year: "今の年（遊んでいる端末の時計）",
  month: "今の月（1〜12）",
  day: "今日の日（1〜31）",
  hour: "今の時（0〜23）",
  minute: "今の分（0〜59）",
  weekday: "今日の曜日（0 が日曜、6 が土曜）",
  now: "今の時刻（1970 年からのミリ秒）",
  item: "持ち物の数（liminalia.json の items の名前。持っていなければ 0）",
  visits: "このプレイでそのラベル（ファイルだけならファイルの先頭）に入った回数。入った行の中では 1 から数える（はじめて入ったときは 1）。セーブに入る",
  read: "どのプレイでも、そのラベル（ファイルだけならファイルの先頭）に一度でも入ったか（既読。全セーブ共通）",
  chosen: "このプレイでその文の選択肢を選んだか（ルビは親文字で書く。訳ではなく原文）。セーブに入る",
  lang: "遊んでいる言語（liminalia.json の languages の一つ。ja、en など）",
  platform: "遊んでいる機種。pc（パソコン）か mobile（スマホ、タブレット）",
  app: "アプリ（デスクトップ版、スマホ版）で遊んでいるか。ブラウザなら false",
  replaying: "おまけの回想を再生しているか",
  chapter: "今のシナリオファイルの章（liminalia.json の chapters の id。どの章にも入らなければ空）",
  endings: "どのプレイでも、見たエンディングの数（全セーブ共通）。種類（bad など）を渡すとその種類だけ。同じエンディングは何度見ても一つ。今のプレイのエンディングは、プレイを終える命令（@title-screen）を動かしたときに数える",
};

/**
 * 実行器が答える関数（進み具合と、遊んでいる環境）。TyranoScript の式には無いので、取り込みはこれらを書き出さず、書き戻しは戻せない式として知らせる。
 */
export const STORY_FUNCTIONS: ReadonlySet<string> = new Set(["visits", "read", "chosen", "lang", "platform", "app", "replaying", "chapter", "endings"]);

/** ジャンプ先（`#ラベル`・`ファイル`・`ファイル#ラベル`）を受け取る関数。検査がラベルとファイルがあるかを確かめる。 */
export const TARGET_FUNCTIONS: ReadonlySet<string> = new Set(["visits", "read"]);

/** 既読のラベル（式の read()）を置く、全セーブ共通の変数の名前（式の名前に使えない文字を含むので、作品の変数と重ならない）。 */
export const READ_KEY = "@read";

/** 式の中で呼べる関数。 */
export const CORE_FUNCTIONS: ReadonlySet<string> = new Set(Object.keys(FUNCTION_ARITY));

/**
 * プラグインの命令と描画の口の版（@liminalia/sdk の CommandPlugin・@liminalia/web の WebPlugin の apiVersion と、プラグインの package.json の
 * liminalia.api・engines.liminalia が指すもの）。口を足したら上げる。
 * テーマの theme.json と、作品とひな形の liminalia.json の engines.liminalia もこの版で比べるので、テーマが書ける ui の項目や、
 * ひな形が使う設定の項目を足したときも上げる（前のエンジンで開くと、lim check が theme-engine-version・engine-version で知らせる）。
 * - 1: はじめの口
 * - 2: 命令ごとの validate、式の関数（functions）、診断の修正案、t.variable・t.target・t.cast・t.condition・t.dataKey、defineState、
 *      画面の口の onClose と leave、ConfigScreenApi の defaults と reset、SaveLoadScreenApi の latestSlot・pageSize・chapterId、
 *      ExtraScreenApi の onKey と chapters、BacklogScreenApi の asset、操作の fullscreen、system.theme、screens.codex
 * - 3: 立ち絵の部品（SpritePartContext）の name・appearance・skipping・reduceMotion・holdShot と update の第二引数、@liminalia/web の loadScript
 * - 4: 命令の定義の autoplay（画面なしの自動確認での進め方）、描画の ctx.offer（録画で選べるもの）と ctx.layers.hud、screens.ending（EndingScreenApi）、
 *      FlowchartScreenApi.endings の kind・label・title、作品の設定の endingKinds（台本の書式の版 3 のエンディングの種類）、
 *      screens.choice（ChoiceScreenApi）・screens.name（NameScreenApi）・screens.dialog（DialogScreenApi）・screens.help・screens.items、@liminalia/web の systemText、
 *      テーマが書ける ui.ending（結末の画面の見た目）、作品の文言の表の codex・investigate・mapChoice・chapter（標準の命令の画面の文言）
 * - 5: 描画の ctx.system.ask と ctx.system.announce、ctx.reduceShake と ctx.reduceFlash、常駐の表示の data-lm-play-nav と data-lm-key、
 *      データの形の d.point、d.asset の also、d.string と d.text の translate、@liminalia/web の dataText、
 *      テーマが書ける ui.chapter、ui.nvl、ui.nvlStyles、ui.settings の voiceSpeakers などのコンフィグの値
 * - 6: 作品の CSS（ui.css）、標準の画面のテンプレート（ui.templates、PlayerProject.templates）、画面の JS の口（ScreenScriptApi）、
 *      @liminalia/web の loadScreenTemplates と DomHost.templateSource
 * - 7: 引数の型の cast の shown（@liminalia/sdk の t.cast の shown。表示中の立ち絵の人物に効く引数。制作画面の補完が表示中の人物を上に並べる）
 */
export const PLUGIN_API_VERSION = 7;

/** プラグインが足した式の関数（プラグインの名前 → 関数の名前 → 引数の数）。@liminalia/sdk の combinePlugins が入れる。組み込みと同じ名前は入れない。 */
const pluginFunctionArity = new Map<string, Map<string, readonly [min: number, max: number]>>();

/**
 * そのプラグインが足す式の関数を入れ替える（そのプラグインが前に入れたものは外す。ほかのプラグインのものは残す）。
 * 組み込みと同じ名前のものは入れずに、その名前を返す。
 */
export function setPluginFunctions(plugin: string, arity: Readonly<Record<string, readonly [min: number, max: number]>>): string[] {
  const own = new Map<string, readonly [number, number]>();
  const clash: string[] = [];
  for (const [name, a] of Object.entries(arity)) {
    if (Object.hasOwn(FUNCTION_ARITY, name)) clash.push(name);
    else own.set(name, a);
  }
  pluginFunctionArity.delete(plugin);
  if (own.size > 0) pluginFunctionArity.set(plugin, own);
  return clash;
}

/** 関数の引数の数（組み込みか、プラグインが足したもの。知らない関数なら undefined。同じ名前は後に入れたプラグインのもの）。 */
export function functionArity(name: string): readonly [min: number, max: number] | undefined {
  if (Object.hasOwn(FUNCTION_ARITY, name)) return FUNCTION_ARITY[name];
  let found: readonly [number, number] | undefined;
  for (const own of pluginFunctionArity.values()) found = own.get(name) ?? found;
  return found;
}

/** 式の中で呼べる関数（組み込みと、プラグインが足したもの）。 */
export function knownFunctions(): ReadonlySet<string> {
  return pluginFunctionArity.size === 0 ? CORE_FUNCTIONS : new Set([...CORE_FUNCTIONS, ...[...pluginFunctionArity.values()].flatMap((own) => [...own.keys()])]);
}

/** 引数の数の決まり（「1 つ」「0〜1 つ」「1 つ以上」）。 */
export function arityText([min, max]: readonly [number, number]): string {
  return max === Infinity ? `${min} つ以上` : min === max ? `${min} つ` : `${min}〜${max} つ`;
}

/**
 * @define の引数で使える型名。組み込みの命令と同じ検査に通す型も書ける:
 * asset(フォルダ)（素材。asset(bgimage) など）、cast（キャラクター）、appearance（立ち絵セット）、variant（差分）、position（立ち位置）、
 * target（飛び先）、enum(a|b|c)（決まった値のどれか）。
 */
export function paramTypeFromName(name: string): ParamType | null {
  switch (name) {
    case "string":
    case "bool":
    case "duration":
    case "color":
    case "variable":
    case "cast":
    case "appearance":
    case "variant":
    case "position":
    case "target":
      return { kind: name };
    case "number":
      return { kind: "number" };
    case "int":
      return { kind: "int" };
  }
  const asset = /^asset\(([a-z0-9_][a-z0-9_/-]*)\)$/.exec(name);
  if (asset) return { kind: "asset", folder: asset[1]! };
  const choices = /^enum\(([^()]*)\)$/.exec(name);
  if (choices) {
    const values = choices[1]!.split("|").map((v) => v.trim());
    return values.length > 0 && values.every((v) => /^[\p{L}\p{N}_.-]+$/u.test(v)) ? { kind: "enum", values } : null;
  }
  return null;
}

/** @define の引数の型名の一覧（誤りの文に出す）。 */
export const DEFINE_TYPE_NAMES = "string / number / int / bool / duration / color / variable / asset(フォルダ) / cast / appearance / variant / position / target / enum(a|b)";
