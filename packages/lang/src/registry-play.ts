import type { CommandSpec, ParamSpec } from "./registry.ts";

/**
 * 組み込みの命令のうち、遊ぶ側の仕組みに関わるもの（システム画面への要求・音の操作・ボイス・文字入力と確認の枠・
 * 一時的に別の場面へ行って戻る・変数の消去・履歴）。registry.ts の CORE_COMMANDS に入る。
 *
 * システム画面への要求（@auto @skip @open-screen など）は、実行器では描画側に知らせるだけで、
 * 何をするかはシステム画面（SystemController.request）が決める。システム画面が扱わないときは描画側の最小の既定の動きになる。
 */

const duration = (doc: string, def: string): ParamSpec => ({ type: { kind: "duration" }, default: def, doc });
const flag = (doc: string, def: boolean): ParamSpec => ({ type: { kind: "bool" }, default: String(def), doc });
const choice = (values: readonly string[], doc: string): ParamSpec => ({ type: { kind: "enum", values }, required: true, doc });
const channel = (doc: string): ParamSpec => ({ type: { kind: "int", min: 0 }, doc });
const volume = (doc: string): ParamSpec => ({ type: { kind: "int", min: 0, max: 100 }, doc });

/** 音のフィルターの名前（@bgm・@se・@voice・@voice-filter の filter）。 */
export const SOUND_FILTER_NAMES = ["none", "muffled", "phone", "radio", "hall"] as const;

/** 音のフィルターの種類と強さ（@bgm・@se・@voice・@voice-filter）。 */
export function soundFilterParam(doc: string, required = false): Record<string, ParamSpec> {
  return {
    filter: { type: { kind: "enum", values: SOUND_FILTER_NAMES }, ...(required ? { required: true } : {}), doc: `${doc}（muffled こもった音、phone 電話越し、radio 無線、hall 広間の響き。none は掛けない）` },
    "filter-strength": { type: { kind: "int", min: 0, max: 100 }, default: "100", doc: "フィルターの強さ（0〜100。元の音と混ぜる）" },
  };
}

export const PLAY_COMMANDS: readonly CommandSpec[] = [
  // ---- システム画面への要求 ----
  {
    name: "auto",
    summary: "オート（本文を自動で送る）を開始、または停止する",
    positional: ["mode"],
    params: { mode: choice(["start", "stop"], "start / stop") },
    example: "@auto start",
  },
  {
    name: "skip",
    summary: "スキップを開始、または停止する",
    positional: ["mode"],
    params: { mode: choice(["start", "stop"], "start / stop") },
    example: "@skip stop",
  },
  {
    name: "open-screen",
    summary: "システム画面か作品の画面を開き、閉じるまで待つ",
    positional: ["screen"],
    params: {
      screen: {
        type: { kind: "string", suggest: ["save", "load", "log", "menu", "config", "extra", "items", "help", "flowchart"] },
        required: true,
        doc: "save（セーブ）/ load（ロード）/ log（バックログ）/ menu（メニュー）/ config（コンフィグ）/ extra（おまけ）/ items（持ち物）/ help（操作説明）/ flowchart（フローチャート）か、プラグインが system.defineScreen で登録した作品の画面の名前",
      },
    },
    example: "@open-screen save",
    waits: true,
  },
  {
    name: "menu-button",
    summary: "メニューを開くボタンを表示、または非表示にする",
    positional: ["mode"],
    params: { mode: choice(["show", "hide"], "show / hide") },
    example: "@menu-button hide",
  },
  {
    name: "shortcuts",
    summary: "キーとマウスのショートカット（セーブ、スキップ、メニューなど）を有効、または無効にする",
    positional: ["mode"],
    params: { mode: choice(["on", "off"], "on / off") },
    example: "@shortcuts off",
  },
  {
    name: "config",
    summary: "コンフィグのうち、書いた項目の値だけを変える",
    positional: [],
    params: {
      "bgm-volume": volume("BGM 全体の音量（0〜100）"),
      "se-volume": volume("効果音全体の音量（0〜100）"),
      "voice-volume": volume("ボイス全体の音量（0〜100）"),
      "text-speed": { type: { kind: "duration" }, doc: "テキスト速度（一文字あたりの時間）" },
      "auto-wait": { type: { kind: "duration" }, doc: "オートの待ち時間（次のページへ進むまでの時間）" },
      "auto-click-stop": { type: { kind: "bool" }, doc: "オート中にクリックしたらオートを止める" },
    },
    example: "@config bgm-volume=80 text-speed=30ms",
  },
  {
    name: "fullscreen",
    summary: "フルスクリーンとウィンドウを切り替える",
    positional: [],
    params: {},
    example: "@fullscreen",
  },
  {
    name: "quit",
    summary: "ゲームを終了する。iOS のアプリとブラウザはゲームの側から閉じられないので、閉じられないことを知らせてタイトル画面へ戻る",
    positional: [],
    params: { ask: flag("終了する前に確認する", true) },
    example: "@quit ask=false",
    waits: true,
  },
  {
    name: "title-screen",
    summary: "プレイを終えてタイトル画面へ戻る（バッドエンドの後など）。ending にエンディングの種類を書くと、暗転して種類の文言（BAD END など）と title に書いた名前を出し、プレイヤーが押すのを待ってからタイトルへ戻る。このときは Studio のフローチャートにもエンディングとして出る",
    positional: [],
    params: {
      ending: { type: { kind: "string", suggest: ["bad", "normal", "good", "true", "other"] }, doc: "エンディングの種類。bad、normal、good、true、other（文言を持たず title だけを出す）と、liminalia.json の endingKinds で足した種類。画面に出す文言は種類で決まる（bad なら BAD END など）" },
      title: { type: { kind: "string", translate: "text" }, doc: "このエンディングだけの名前（「沈黙」など）。種類の文言に添えて出す" },
      text: { type: { kind: "string", translate: "text" }, doc: "名前の下に出す終わりの表記（省くと「終」。英語で遊んでいれば The End）" },
      card: { type: { kind: "bool" }, default: "true", doc: "ending を書いたとき、エンディングの名前を出してからタイトルへ戻る。false ならすぐ戻る。作品全体で外すときは commandDefaults を使う" },
    },
    example: '@title-screen ending=bad title="沈黙"',
    ends: true,
  },
  {
    name: "presence",
    summary: "デスクトップ版で Steam に接続しているとき、プレイ中の状況を Steam のリッチプレゼンスに表示する。空の文字列を書くと表示を消す",
    positional: ["text"],
    params: { text: { type: { kind: "string", translate: "text" }, required: true, doc: "表示するテキスト。Steamworks のリッチプレゼンスのローカライズに、\"#Status\" を \"%status%\" で用意しておく" } },
    example: '@presence "第一章 星を待つ丘"',
  },
  {
    name: "window-title",
    summary: "ウィンドウ（タブ）のタイトルを変える",
    positional: ["title"],
    params: { title: { type: { kind: "string", translate: "text" }, required: true, doc: "タイトル" } },
    example: '@window-title "第二章"',
  },
  {
    name: "open-url",
    summary: "ブラウザで URL を開く。開ける URL は http、https、mailto だけ。スマホのアプリでは端末のブラウザで開く",
    positional: ["url"],
    params: { url: { type: { kind: "string" }, required: true, doc: "開く URL" } },
    example: "@open-url https://example.com/",
  },
  {
    name: "autosave",
    summary: "オートセーブする。このセーブから再開すると、このコマンドの次から始まる。セーブはロード画面のオートセーブのページに入り、古いものから置き換える",
    positional: [],
    params: {},
    example: "@autosave",
    waits: true,
  },
  {
    name: "autoload",
    summary: "いちばん新しいオートセーブを読み込んで、そこから続ける（無ければ何もしない）",
    positional: [],
    params: {},
    example: "@autoload",
    waits: true,
  },
  {
    name: "backlog",
    summary: "バックログに本文を残すかを切り替える",
    positional: ["mode"],
    params: { mode: choice(["on", "off"], "on（残す）/ off（残さない）") },
    example: "@backlog off",
  },
  {
    name: "backlog-add",
    summary: "バックログにテキストを追加する",
    positional: ["text"],
    params: {
      text: { type: { kind: "string", translate: "text" }, required: true, doc: "追加するテキスト" },
      join: flag("直前のバックログの行につなげる", false),
    },
    example: '@backlog-add "（扉の閉まる音）"',
  },
  {
    name: "describe",
    summary: "読み上げのときだけ出す文。画面には出さず、次の本文と一緒にスクリーンリーダーとテキスト読み上げに渡す。絵や演出の説明に使う",
    positional: ["text"],
    params: {
      text: { type: { kind: "string", translate: "text" }, required: true, doc: "説明の文" },
    },
    example: '@describe "夕暮れの教室。窓の外で雨が降っている"',
  },

  // ---- 音 ----
  {
    name: "pause-bgm",
    summary: "BGM を一時停止する",
    positional: [],
    params: {},
    example: "@pause-bgm",
  },
  {
    name: "resume-bgm",
    summary: "一時停止した BGM を再開する",
    positional: [],
    params: {},
    example: "@resume-bgm",
  },
  {
    name: "pause-se",
    summary: "効果音を一時停止する",
    positional: [],
    params: { channel: channel("止めるチャンネル。省略するとすべて") },
    example: "@pause-se channel=1",
  },
  {
    name: "resume-se",
    summary: "一時停止した効果音を再開する",
    positional: [],
    params: { channel: channel("再開するチャンネル。省略するとすべて") },
    example: "@resume-se channel=1",
  },
  {
    name: "bgm-volume",
    summary: "鳴っている BGM の音量を変える",
    positional: ["volume"],
    params: {
      volume: { ...volume("音量（0〜100）"), required: true },
      time: duration("変えるのにかける時間", "0ms"),
    },
    example: "@bgm-volume 40 time=1s",
  },
  {
    name: "se-volume",
    summary: "鳴っている効果音の音量を変える",
    positional: ["volume"],
    params: {
      volume: { ...volume("音量（0〜100）"), required: true },
      channel: channel("変えるチャンネル。省略するとすべて"),
      time: duration("変えるのにかける時間", "0ms"),
    },
    example: "@se-volume 50 channel=1",
  },
  {
    name: "wait-bgm",
    summary: "BGM が鳴り終わるまで待つ（繰り返す BGM は待たない）",
    positional: [],
    params: {},
    example: "@wait-bgm",
    waits: true,
  },
  {
    name: "wait-se",
    summary: "効果音が鳴り終わるまで待つ（繰り返す効果音は待たない）",
    positional: [],
    params: { channel: channel("待つチャンネル。省略するとすべて") },
    example: "@wait-se channel=0",
    waits: true,
  },

  // ---- ボイス ----
  {
    name: "voice",
    summary: "台詞のボイスを鳴らす。本文の行の前に書けば次の台詞で、本文の中に書けばその場で鳴らす",
    positional: ["file"],
    params: {
      file: { type: { kind: "asset", folder: "voice" }, required: true, doc: "音声ファイル" },
      volume: { ...volume("音量（0〜100）"), default: "100" },
      folder: { type: { kind: "enum", values: ["voice", "sound"] }, default: "voice", doc: "読み込むフォルダ（インポートしたプロジェクトで効果音のフォルダに置いたボイスなど）" },
      caption: { type: { kind: "string", translate: "text" }, doc: "字幕。本文に書いていない声（笑い声やため息、本文と違うことばなど）に付ける。コンフィグで効果音の字幕をオンにした人に出す" },
      channel: { type: { kind: "int", min: 1, max: 8 }, default: "1", doc: "ボイスのチャンネル。違うチャンネルのボイスは同時に鳴る（二人が同時に話す）。同じ台詞の前に話者の違う @voice を二つ書いても同時に鳴る" },
      who: { type: { kind: "string" }, doc: "このボイスの話者（本文の行の話者と同じ書き方）。省くとその台詞の話者。口パクを動かすのと、名前欄に二人の名前を出すのに使う" },
      ...soundFilterParam("このボイスに掛ける音のフィルター。省くと @voice-filter で掛けているもの"),
    },
    example: "@voice yui/001.ogg",
  },
  {
    name: "voice-filter",
    summary: "ボイスに音のフィルターを掛け続ける（電話越し、無線、こもった声、広間の響き）。who を書くと話者ごとに掛け、none を書くと外す。鳴っているボイスにもすぐ掛かる",
    positional: ["filter"],
    params: {
      ...soundFilterParam("掛けるフィルター", true),
      who: { type: { kind: "string" }, doc: "話者の名前（本文の行の話者と同じ書き方）。省くとすべての話者" },
      time: duration("鳴っているボイスにフィルターを掛けるときと外すときにかける時間", "0ms"),
    },
    example: "@voice-filter phone who=ミカ",
  },
  {
    name: "voice-auto",
    summary:
      "話者の台詞ごとに、連番のボイスを自動で再生する。@voice を書いた台詞では @voice が優先される。pattern を書くと自動再生を設定し、書かなければ @voice-auto-off で止めた自動再生を番号を保ったまま再開する。who も省略すると、すべての話者を再開する",
    positional: ["who"],
    params: {
      who: { type: { kind: "string" }, doc: "話者の名前（本文の行の話者と同じ書き方）。省略すると、設定してあるすべての話者を再開する" },
      pattern: { type: { kind: "string" }, doc: "ファイル名のパターン。{n} が番号になる（{n:3} なら 3 桁にそろえる）" },
      next: { type: { kind: "int", min: 0 }, doc: "次に鳴らす番号。省くと、設定するときは 1、再開するときは止めたときの番号" },
      volume: { ...volume("音量（0〜100）。設定するときだけ"), default: "100" },
      folder: { type: { kind: "enum", values: ["voice", "sound"] }, default: "voice", doc: "読み込むフォルダ。設定するときだけ" },
      start: flag("設定してすぐ鳴らし始める。false なら設定だけして、@voice-auto で始める", true),
    },
    example: '@voice-auto ユイ pattern="yui/{n:3}.ogg"',
  },
  {
    name: "voice-auto-off",
    summary: "連番のボイスの自動再生を止める（番号は保ち、@voice-auto で再開できる）",
    positional: ["who"],
    params: { who: { type: { kind: "string" }, doc: "話者の名前。省略するとすべて" } },
    example: "@voice-auto-off ユイ",
  },
  {
    name: "stop-voice",
    summary: "鳴っているボイスを止める",
    positional: [],
    bare: "time",
    params: { time: duration("フェードアウトにかける時間。名前なしでも書ける（@stop-voice 500ms）", "0ms") },
    example: "@stop-voice",
  },
  {
    name: "wait-voice",
    summary: "ボイスが鳴り終わるまで待つ",
    positional: [],
    params: {},
    example: "@wait-voice",
    waits: true,
  },

  // ---- 入力と確認の枠 ----
  // ---- 持ち物 ----
  {
    name: "item-add",
    summary: "持ち物を足す。持ち物は liminalia.json の items に書いた名前で指す。式では item(\"名前\") で数を読める",
    positional: ["item"],
    params: {
      item: { type: { kind: "string" }, required: true, doc: "持ち物の名前" },
      count: { type: { kind: "int", min: 1 }, default: "1", doc: "足す数" },
      notify: { type: { kind: "bool" }, default: "true", doc: "手に入れたことを画面の端に知らせる" },
    },
    example: "@item-add old_key",
  },
  {
    name: "item-remove",
    summary: "持ち物を減らす（count を省くとすべて）",
    positional: ["item"],
    params: {
      item: { type: { kind: "string" }, required: true, doc: "持ち物の名前" },
      count: { type: { kind: "int", min: 1 }, doc: "減らす数（省くとすべて）" },
    },
    example: "@item-remove old_key",
  },
  {
    name: "item-select",
    summary: "持ち物の画面を出してプレイヤーに一つ選んでもらい、選んだ持ち物の名前を変数に入れる。選ばずにやめたときは空の文字を入れる。調べる場所で使う持ち物を選ばせるときに使う",
    positional: ["variable"],
    params: {
      variable: { type: { kind: "variable" }, required: true, doc: "選んだ持ち物の名前を入れる変数" },
      title: { type: { kind: "string", translate: "text" }, doc: "画面の見出し（省くと「何を使う？」の標準の文言）" },
    },
    example: "@item-select temp.used",
    waits: true,
  },
  {
    name: "text-input",
    summary: "文字を入力してもらい、変数に入れる（決定するまで待つ）",
    positional: ["variable"],
    params: {
      variable: { type: { kind: "variable" }, required: true, doc: "入力した文字を入れる変数" },
      prompt: { type: { kind: "string", translate: "text" }, doc: "入力欄の上に出す見出し（「名前を入力してください」など）" },
      initial: { type: { kind: "string", translate: "text" }, default: '""', doc: "最初から入っている文字" },
      placeholder: { type: { kind: "string", translate: "text" }, default: '""', doc: "空のときに薄く表示する説明" },
      max: { type: { kind: "int", min: 1 }, default: "1000", doc: "入力できる文字数" },
      required: { type: { kind: "bool" }, default: "false", doc: "空のときと空白だけのときは決定できないようにする" },
      mode: { type: { kind: "enum", values: ["text", "number", "password"] }, default: "text", doc: "入力の種類。number は数字のキーボードを出して数字だけを受け付け、password は打った文字を伏せる（暗証番号など）" },
      pattern: { type: { kind: "string" }, doc: "受け付ける形を正規表現で書く（[0-9]{4} など）。入力の全体が合わないあいだは決定できない" },
    },
    example: '@text-input game.name prompt="名前を入力してください" initial="ユイ" max=8 required=true',
    waits: true,
  },
  {
    name: "dialog",
    summary: "確認のダイアログを表示し、答えるまで待つ",
    positional: ["text"],
    params: {
      text: { type: { kind: "string", translate: "text" }, required: true, doc: "表示するテキスト" },
      type: { type: { kind: "enum", values: ["alert", "confirm", "input"] }, default: "alert", doc: "alert（OK だけ）/ confirm（OK とキャンセル）/ input（文字を入力する）" },
      "ok-label": { type: { kind: "string", translate: "text" }, doc: "OK ボタンのテキスト。省くと遊んでいる言語の文言（日本語は OK）" },
      "cancel-label": { type: { kind: "string", translate: "text" }, doc: "キャンセルボタンのテキスト。省くと遊んでいる言語の文言（日本語はキャンセル、英語は Cancel）" },
      target: { type: { kind: "target" }, doc: "OK のときのジャンプ先。省略すると次へ進む" },
      "cancel-target": { type: { kind: "target" }, doc: "キャンセルのときのジャンプ先。省略すると次へ進む" },
      variable: { type: { kind: "variable" }, doc: "input で入力した文字を入れる変数" },
    },
    example: '@dialog "タイトルに戻りますか？" type=confirm target=title',
    waits: true,
  },
  {
    name: "peek",
    summary: "メッセージウィンドウを一時的に消し、クリックで元に戻す（本文は消さない）",
    positional: [],
    params: {},
    example: "@peek",
    waits: true,
  },

  // ---- 変数と実行の状態 ----
  {
    name: "clear-vars",
    summary: "変数をまとめて削除する",
    positional: ["scope"],
    params: { scope: choice(["game", "system", "temp", "all"], "game / system / temp / all（三つとも）") },
    example: "@clear-vars temp",
  },
  {
    name: "clear-stack",
    summary: "@call の戻り先をすべて破棄する。サブルーチンの途中からタイトルへ戻るときなどに使う",
    positional: [],
    params: {},
    example: "@clear-stack",
  },
  {
    name: "sleep-game",
    summary: "今の状態を記録して別のシーンへ移る。@awake-game を実行すると、このコマンドの次に戻る",
    positional: ["target"],
    params: { target: { type: { kind: "target" }, required: true, doc: "ジャンプ先" } },
    example: "@sleep-game extra#gallery",
  },
  {
    name: "awake-game",
    summary: "@sleep-game で記録した状態に戻る（記録した状態がなければ何もしない）",
    positional: [],
    params: {
      "keep-variables": flag("ゲーム変数（game.）は今の値を残す", true),
      "keep-bgm": flag("BGM は今鳴っているものを残す", true),
    },
    example: "@awake-game keep-variables=false",
  },
  {
    name: "break-game",
    summary: "@sleep-game で記録した状態を破棄する",
    positional: [],
    params: {},
    example: "@break-game",
  },
  {
    name: "checkpoint",
    summary: "今の状態に名前を付けて記録する（@rollback でここへ戻れる）",
    positional: ["name"],
    params: { name: { type: { kind: "string" }, required: true, doc: "名前" } },
    example: "@checkpoint before_boss",
  },
  {
    name: "rollback",
    summary: "@checkpoint で記録した状態に戻る",
    positional: ["name"],
    params: {
      name: { type: { kind: "string" }, required: true, doc: "戻る先の名前" },
      "keep-variables": flag("ゲーム変数（game.）は今の値を残す", true),
      "keep-bgm": flag("BGM は今鳴っているものを残す", false),
    },
    example: "@rollback before_boss",
  },
  {
    name: "clear-checkpoint",
    summary: "@checkpoint で記録した状態を破棄する",
    positional: [],
    params: { name: { type: { kind: "string" }, doc: "破棄する名前。省略するとすべて" } },
    example: "@clear-checkpoint name=before_boss",
  },
  {
    name: "glossary-unlock",
    summary: "用語集の用語を解放する（本文に出た用語は自動で解放する）",
    positional: ["id"],
    params: { id: { type: { kind: "string" }, required: true, doc: "用語の id（liminalia.json の extra.glossary の id）" } },
    example: "@glossary-unlock comet",
  },
  {
    name: "replay-unlock",
    summary: "回想を解放し、おまけの回想で見られるようにする。再生はしない",
    positional: ["id"],
    params: { id: { type: { kind: "string" }, required: true, doc: "回想の名前（liminalia.json の extra.replay の id）" } },
    example: "@replay-unlock ending_a",
  },
  {
    name: "replay-end",
    summary: "回想の再生をここで終えて、おまけへ戻る（回想の再生中でなければ何もしない）",
    positional: [],
    params: {},
    example: "@replay-end",
  },
  {
    name: "achieve",
    summary: "実績を解除する。通知するのは、はじめて解除したときだけ。デスクトップ版は Steam、スマホ版は Game Center と Google Play Games の実績にも送る",
    positional: ["id"],
    params: { id: { type: { kind: "string" }, required: true, doc: "実績の名前（liminalia.json の extra.achievements の id）" } },
    example: "@achieve first_star",
  },
  {
    name: "achieve-progress",
    summary: "数を数える実績（liminalia.json の extra.achievements で goal を書いたもの）を進める。goal に届いたら解除し、@achieve と同じく知らせる。デスクトップ版とスマホ版は店の実績の進み具合にも送る",
    positional: ["id"],
    params: {
      id: { type: { kind: "string" }, required: true, doc: "実績の名前（liminalia.json の extra.achievements の id。goal を書いたもの）" },
      add: { type: { kind: "int" }, default: "1", doc: "足す数（set を書いたら使わない）" },
      set: { type: { kind: "int", min: 0 }, doc: "数をこの値にする（今より小さければ変えない）" },
    },
    example: "@achieve-progress read_all add=1",
  },
  {
    name: "check-update",
    summary: "デスクトップ版で liminalia.json に build.update があるとき、アップデートを確認し、あればプレイヤーに尋ねて更新する。ほかでは何もしない",
    positional: [],
    params: {},
    example: "@check-update",
    waits: true,
  },
  {
    name: "purchase",
    summary: "商品を買う（スマホ版のアプリ内課金、デスクトップ版の店の DLC など）。店の画面が閉じるまで待ち、買えたら system.purchases.<商品> が true になる",
    positional: ["product"],
    params: { product: { type: { kind: "string" }, required: true, doc: "商品の名前（liminalia.json の build.store.products のキー）" } },
    example: "@purchase full",
    waits: true,
  },
  {
    name: "restore-purchases",
    summary: "購入を復元する（機種変更したときなど）。持っている商品の system.purchases.<商品> が true になる",
    positional: [],
    params: {},
    example: "@restore-purchases",
    waits: true,
  },
];
