import { uiTranslationText } from "@liminalia/lang";
import { TEXT_EN } from "./strings-en.ts";

/**
 * 既定のシステム画面の文言。画面に出る文字はすべてここに置く。
 * 言語を替えると setUiLanguage が中身を差し替える（英語は strings-en.ts、ほかの言語は訳のファイルの ui で上書きする）。
 * 画面は開くたびに TEXT を読むので、替えたあとに開いた画面から効く。
 */
export const TEXT = {
  gate: "クリックで開始",
  /** 指で触る端末の「クリックで開始」。 */
  gateTouch: "タップで開始",
  close: "閉じる",
  /** 指で触る端末を縦に持っているとき。 */
  rotate: "端末を横向きにしてください",
  /** ゲームからアプリを閉じられない（iOS のアプリとブラウザ）ときの @quit。 */
  quitUnavailable: "ここではゲームを終了できません",
  /** 縦に持っていても遊べる大きさのときに、知らせを閉じるボタン。 */
  rotateKeep: "このまま遊ぶ",

  /**
   * エンディングの名前（@title-screen ending=）。mark は名前の下の終わりの表記、proceed は押したときの操作（読み上げ）。
   * kinds はエンディングの種類（ending= の bad など）の文言（other は文言を持たない。作品の liminalia.json の endingKinds が先）。
   * listName はおまけとフローチャートの一覧で、種類の文言と名前（title=）を一行にしたもの。
   */
  ending: {
    mark: "終",
    proceed: "タイトルへ戻る",
    kinds: { bad: "BAD END", normal: "NORMAL END", good: "GOOD END", true: "TRUE END" } as Record<string, string>,
    listName: (label: string, title: string) => `${label}　${title}`,
  },

  title: {
    start: "はじめから",
    continue: "つづきから",
    extra: "おまけ",
    flowchart: "フローチャート",
    config: "コンフィグ",
    exit: "終了",
  },

  /** おまけ（CG、回想、音楽、実績）。 */
  extra: {
    heading: "おまけ",
    tabs: { cg: "CG", replay: "回想", music: "音楽", movies: "ムービー", characters: "キャラクター", chapters: "章", glossary: "用語集", achievements: "実績", endings: "エンディング" },
    /** CG のまとまりのタブで、group も章も無いもの。 */
    ungrouped: "そのほか",
    /** CG の解放の数と割合。 */
    rate: (done: number, total: number) => `${done} / ${total}（${total > 0 ? Math.floor((done / total) * 100) : 0}%）`,
    locked: "？",
    unknown: "？？？",
    hiddenDescription: "隠し実績",
    progress: (done: number, total: number) => `${done} / ${total}`,
    completion: "達成率",
    completionRead: "既読",
    completionEndings: "エンディング",
    completionPercent: (label: string, percent: number) => `${label} ${percent}%`,
    completionCount: (label: string, done: number, total: number) => `${label} ${done} / ${total}`,
    progressed: (title: string, done: number, total: number) => `${title} ${done} / ${total}`,
    empty: "まだ何もありません",
    musicNone: "曲を選んでください",
    musicPlay: "再生",
    musicPause: "一時停止",
    musicPrev: "前の曲",
    musicNext: "次の曲",
    musicSeek: "再生位置",
    musicShuffle: "シャッフル",
    musicRepeat: { all: "全曲リピート", one: "一曲リピート", none: "リピートなし" } as Record<"all" | "one" | "none", string>,
    termAdded: (term: string) => `用語集に「${term}」を追加しました`,
    chapterConfirm: (title: string) => `「${title}」から読みますか？\n現在の進行状況は失われます。`,
  },

  /** ゲーム中のメニュー（クイックメニューと、右クリック・Esc で開くメニュー）。 */
  menu: {
    heading: "メニュー",
    quickSave: "Qセーブ",
    quickLoad: "Qロード",
    save: "セーブ",
    load: "ロード",
    auto: "オート",
    skip: "スキップ",
    rollback: "戻る",
    rollforward: "進む",
    prevChoice: "前の選択肢へ",
    nextChoice: "次の選択肢へ",
    nextUnread: "次の未読へ",
    flowchart: "フローチャート",
    items: "持ち物",
    help: "操作説明",
    screenshot: "スクリーンショット",
    backlog: "バックログ",
    replayVoice: "ボイスを再生",
    config: "コンフィグ",
    hide: "ウィンドウを消す",
    title: "タイトルへ",
    exit: "終了",
    checkUpdate: "アップデートを確認",
    fullscreen: "フルスクリーン",
    resume: "ゲームに戻る",
  },

  /** 操作説明の画面。 */
  help: {
    heading: "操作説明",
    controls: "操作",
    keyboard: "マウス、キーボード",
    touch: "タッチ",
    pad: "ゲームパッド",
    click: "クリック",
    rightClick: "右クリック",
    wheelDown: "ホイール下",
    wheelUp: "ホイール上",
    middleClick: "ホイールを押す",
    choose: "選択肢を選ぶ",
    numberKeys: "1〜9",
    holdCtrl: "Ctrl を押している間",
    tap: "タップ",
    longPress: "長押し",
    swipeDown: "下へスワイプ",
    swipeUp: "上へスワイプ",
    swipeRight: "右へスワイプ",
    swipeLeft: "左へスワイプ",
    holdPad: (b: string) => `${b} を押している間`,
    copyKey: "Ctrl+C（Mac は ⌘+C）",
    dpadRight: "十字キー右",
    dpadLeft: "十字キー左",
    /** 常駐のボタン（十字キーで選んで、決定のボタンで押す）。 */
    dpadChoose: (b: string) => `十字キーで選んで ${b}`,
    menuBar: "クイックメニュー",
    or: "、",
  },

  /** 字幕（コンフィグの「効果音の字幕」）。 */
  captions: {
    music: (title: string) => `♪ ${title}`,
  },

  /** 持ち物（liminalia.json の items）。 */
  items: {
    heading: "持ち物",
    select: "何を使う？",
    use: "使う",
    empty: "持ち物はありません",
    count: (n: number) => `×${n}`,
    added: (name: string) => `${name}を手に入れた`,
  },

  saveload: {
    save: "セーブ",
    load: "ロード",
    quickTab: "Q",
    quickName: "クイック",
    quickSlot: (n: number) => `クイック ${n}`,
    autoTab: "A",
    autoName: "オートセーブ",
    empty: "空き",
    noText: "（本文なし）",
    delete: "削除",
    memo: "メモ",
    memoPlaceholder: "メモを入力",
    lock: "保護",
    unlock: "保護を外す",
    locked: "保護中",
    copy: "コピー",
    move: "移動",
    cancel: "キャンセル",
    pickCopy: (slot: string) => `${slot} のコピー先を選んでください`,
    pickMove: (slot: string) => `${slot} の移動先を選んでください`,
    page: (n: number) => `${n}`,
    slot: (n: number) => `No.${String(n).padStart(2, "0")}`,
    playTime: (ms: number) => {
      const m = Math.floor(ms / 60000);
      return m < 60 ? `プレイ時間 ${m}分` : `プレイ時間 ${Math.floor(m / 60)}時間${m % 60}分`;
    },
  },

  backlog: {
    heading: "バックログ",
    empty: "まだ何も読んでいません",
    narration: "",
    choice: "選択肢",
    playVoice: "ボイスを再生",
    jump: "ここに戻る",
    jumpTitle: "このページまで戻る",
    jumpConfirm: "このページまで戻りますか？\n以降の進行状況は失われます。",
    search: "バックログを検索",
    hits: (n: number) => `${n} 件`,
  },

  saves: {
    export: "セーブデータをエクスポート",
    import: "セーブデータをインポート",
    importConfirm: "現在のセーブデータ、既読情報、コンフィグの設定を、インポートしたもので置き換えますか？",
    invalid: "セーブデータのファイルではありません",
    otherProject: "別のゲームのセーブデータです",
    newer: "新しいバージョンのゲームで作られたセーブデータのため、ロードできません",
    broken: "このセーブデータは破損しているため、ロードできません",
    full: "空き容量が足りないため、セーブデータを読み込めませんでした",
    carryConfirm: (title: string) => `「${title}」のセーブデータが見つかりました。引き継ぎますか？`,
  },

  config: {
    heading: "コンフィグ",
    tabs: { text: "テキスト", screen: "画面", sound: "サウンド", controls: "操作" },
    keyboard: "キーボード",
    gamepad: "ゲームパッド",
    change: "変更",
    pressKey: "キーを押してください",
    pressButton: "ボタンを押してください",
    resetControls: "操作を初期値に戻す",
    noKey: "なし",
    keyActions: {
      advance: "読み進める",
      menu: "メニュー",
      backlog: "バックログ",
      hide: "ウィンドウを消す",
      auto: "オート",
      skip: "スキップ",
      quickSave: "クイックセーブ",
      quickLoad: "クイックロード",
      save: "セーブ",
      load: "ロード",
      config: "コンフィグ",
      rollback: "1 ページ戻る",
      rollforward: "1 ページ進む",
      prevChoice: "前の選択肢へ",
      nextChoice: "次の選択肢へ",
      nextUnread: "次の未読へ",
      screenshot: "スクリーンショット",
      mute: "ミュート",
      replayVoice: "ボイスを再生",
      copyText: "本文をコピー",
    } as Record<string, string>,
    padRoles: {
      a: "決定、読み進める",
      b: "戻る、メニュー",
      x: "ウィンドウを消す",
      y: "バックログ",
      start: "メニュー",
      select: "コンフィグ",
      lb: "1 ページ戻る",
      lt: "1 ページ進む",
      rb: "押している間スキップ",
      rt: "オート",
      l3: "スキップ",
      r3: "ミュート",
    } as Record<string, string>,
    padStyle: "ボタンの表記",
    padStyles: { "": "自動", xbox: "Xbox", playstation: "PlayStation", nintendo: "Switch" } as Record<string, string>,
    windowOpacity: "ウィンドウの不透明度",
    thin: "薄い",
    thick: "濃い",
    textScale: "文字サイズ",
    small: "小さい",
    large: "大きい",
    font: "フォント",
    fonts: { work: "標準", mincho: "明朝", gothic: "ゴシック", maru: "丸ゴシック", ud: "UD" } as Record<string, string>,
    colorVision: "色覚の補正",
    captions: "効果音の字幕",
    colorVisions: { "": "しない", protan: "1 型（P）", deutan: "2 型（D）", tritan: "3 型（T）" } as Record<string, string>,
    motionFull: "標準",
    motionReduced: "控えめ",
    shake: "画面の揺れ",
    flash: "光の点滅",
    readColor: "既読の文の色",
    lineSpacing: "行間",
    lineSpacings: { 100: "標準", 125: "広め", 150: "より広め" } as Record<number, string>,
    textEdge: "文字の縁",
    textEdges: { "": "標準", none: "なし", shadow: "影", edge: "縁取り" } as Record<string, string>,
    skipSpeed: "スキップの速さ",
    skipSpeeds: { fast: "速い", fastest: "最速" } as Record<string, string>,
    /** 話者ごとの声の音量で、まだ声を聞いていない人物の名前（作品の ui.settings.voiceSpeakers が masked のとき）。 */
    unknownSpeaker: "？？？",
    contentFilter: "表現を控えめにする",
    selfVoicing: "テキスト読み上げ",
    highContrast: "高コントラスト",
    off: "オフ",
    on: "オン",
    duck: "ボイス再生中の BGM",
    systemVoice: "システムボイス",
    systemVoiceRandom: "ランダム",
    duckOn: "音量を下げる",
    duckOff: "下げない",
    whenHidden: "最小化したとき",
    whenUnfocused: "前面にないとき",
    inactiveActions: { pause: "一時停止", mute: "ミュート", play: "再生を続ける" } as Record<string, string>,
    textSpeed: "テキスト速度",
    autoWait: "オートの待ち時間",
    master: "全体の音量",
    mute: "ミュート",
    bgm: "BGM の音量",
    se: "効果音の音量",
    voice: "ボイスの音量",
    voiceStop: "次へ進んだとき",
    voiceStopOn: "ボイスを止める",
    voiceStopOff: "再生を続ける",
    speakerVoice: (who: string) => `${who}の声`,
    language: "言語",
    screen: "画面モード",
    windowSize: "ウィンドウの大きさ",
    windowSizeDefault: "標準",
    confirm: "確認のメッセージ",
    hideCursor: "動かさないマウスのカーソルを隠す",
    windowed: "ウィンドウ",
    fullscreen: "フルスクリーン",
    skip: "スキップの対象",
    skipRead: "既読のみ",
    skipAll: "すべて",
    autoAfterChoice: "選択肢のあとのオート",
    skipAfterChoice: "選択肢のあとのスキップ",
    afterChoiceStop: "止める",
    afterChoiceKeep: "続ける",
    choiceTimer: "選択肢の制限時間",
    slow: "遅い",
    fast: "速い",
    short: "短い",
    long: "長い",
    instant: "ノーウェイト",
    seconds: (ms: number) => `${(ms / 1000).toFixed(1)} 秒`,
    preview: "プレビュー",
    previewText: "テキストはこの速度で表示されます。オートでは、表示し終えてから設定した待ち時間のあとに次へ進みます。",
    reset: "初期設定に戻す",
  },

  warning: {
    heading: "ご注意",
    agree: "同意して始める",
    quit: "終了",
  },

  a11y: {
    choices: "選択肢",
    /** スクリーンリーダーへ渡す一行（本文は書いたまま。括弧で始まる台詞は名前に続け、そうでなければ「：」でつなぐ）。 */
    line: (speaker: string, text: string) => `${speaker}${/^[「『（(“"]/.test(text) ? "" : "："}${text}`,
    /** テキスト読み上げで読む文（名前と本文のあいだで一度区切る）。 */
    speak: (speaker: string, text: string) => `${speaker}。${text}`,
    /** 選択肢の一覧（スクリーンリーダー）。 */
    list: (heading: string, options: readonly string[]) => `${heading}: ${options.join("、")}`,
    /** 選択肢の一覧（テキスト読み上げ）。 */
    speakList: (heading: string, options: readonly string[]) => `${heading}。${options.join("。")}`,
  },

  /** 遊ばれ方の統計（作品が build.analytics を書いたときだけ。analytics.ts）。 */
  analytics: {
    ask: "プレイ統計（選んだ選択肢と、プレイをやめたシーン。名前や文章、セーブは含みません）を開発者に送信しますか？ コンフィグであとから変更できます。",
    setting: "プレイ統計を送信",
  },

  crash: {
    ask: "前回、エラーでゲームが停止しました。原因の調査のため、クラッシュレポート（エラーの内容、プレイしていた位置、バージョン、動作環境）を開発者に送信しますか？",
    sent: "クラッシュレポートを送信しました",
    failed: "クラッシュレポートを送信できませんでした",
  },

  /** テスト版の指摘（lim build --feedback で書き出したものだけ。feedback.ts）。 */
  feedback: {
    button: "指摘",
    buttonTitle: "この場面に指摘を残す（F8）",
    title: "この場面に指摘",
    where: (file: string, line: number) => `${file} の ${line} 行目`,
    nowhere: "場面の位置は分かりません",
    shot: "指摘する場面のスクリーンショット",
    placeholder: "気になったこと、直してほしいこと",
    name: "名前",
    namePlaceholder: "指摘に付ける名前",
    send: "送信",
    save: "ファイルに保存",
    cancel: "キャンセル",
    empty: "指摘を入力してください",
    sent: "指摘を送信しました",
    saved: "指摘をファイルに保存しました。開発者に渡してください",
    sendFailed: "送信できませんでした。ネットワークを確認して、もう一度試してください",
    saveFailed: "ファイルに保存できませんでした",
  },

  /** ストアの購入（@purchase、@restore-purchases）。 */
  store: {
    purchased: "購入しました",
    pending: "購入の手続き中です。完了すると反映されます",
    cancelled: "購入をキャンセルしました",
    failed: "購入できませんでした",
    opened: "ストアのページを開きました。購入すると反映されます",
    restored: "購入を復元しました",
    nothingToRestore: "復元できる購入はありません",
    unavailable: "この環境では購入できません",
  },

  /** アップデート（デスクトップ版で liminalia.json の build.update があるとき）。 */
  update: {
    app: (version: string, notes: string) => `新しいバージョン ${version} があります。${notes ? `\n\n${notes}\n\n` : ""}ダウンロードしますか？`,
    packs: (names: string, notes: string) => `更新データ（${names}）があります。${notes ? `\n\n${notes}\n\n` : ""}ダウンロードして適用しますか？`,
    progress: (name: string, percent: number) => `ダウンロードしています: ${name} ${percent}%`,
    restart: "更新データを適用しました。ゲームを再起動すると反映されます。今すぐ再起動しますか？",
    nextLaunch: "更新データは次回の起動から反映されます",
    installer: "インストーラーを起動します",
    swapping: "新しいバージョンに入れ替えて、ゲームを起動し直します",
    opened: "ダウンロードしたファイルを開きました",
    page: "ダウンロードのページを開きました",
    latest: "最新のバージョンです",
    /** ブラウザ版で、遊んでいる途中に新しい版が置かれたとき（build-watch.ts）。 */
    web: "新しいバージョンがあります。読み直すと反映されます",
    reload: "読み直す",
    checkFailed: "アップデートを確認できませんでした",
    failed: "アップデートできませんでした",
  },

  flowchart: {
    heading: "フローチャート",
    tabs: { flow: "フローチャート", endings: "エンディング" },
    readRate: (percent: number) => `既読率 ${percent}%`,
    endingCount: (done: number, total: number) => `エンディング ${done} / ${total}`,
    locked: "？？？",
    untitled: "（本文なし）",
    choice: "選択肢",
    end: "END",
    endingName: (n: number) => `エンディング ${n}`,
    noEndings: "エンディングはありません",
    jumpConfirm: "このシーンから読み直しますか？\n現在の進行状況は失われます。",
  },

  /** @dialog のボタン（ok-label・cancel-label を書かなかったとき）。 */
  dialog: {
    space: "空白",
    backspace: "1 字消す",
    keyboardSets: { kana: "かな", katakana: "カナ", latin: "英数" } as Record<string, string>,
    ok: "OK",
    cancel: "キャンセル",
  },

  confirm: {
    /** 確認の画面の名前（読み上げだけ。見出しは見せない）。 */
    heading: "確認",
    yes: "はい",
    no: "いいえ",
    overwrite: (slot: string) => `${slot} に上書きしますか？`,
    load: (slot: string) => `${slot} をロードしますか？\n現在の進行状況は失われます。`,
    delete: (slot: string) => `${slot} を削除しますか？`,
    title: "タイトル画面に戻りますか？\nセーブしていない進行状況は失われます。",
    endReplay: "回想を終了しますか？",
    exit: "終了しますか？",
    /** @quit で、ゲームからアプリを閉じられないとき（iOS のアプリとブラウザ）。 */
    cannotQuit: "ここではゲームを終了できません。\nタイトル画面に戻りますか？",
  },

  choice: {
    prevConfirm: "前の選択肢まで戻りますか？\n以降の進行状況は失われます。",
    noPrev: "戻れる選択肢がありません",
    noNext: "この先に選択肢はありません",
    noUnread: "この先に未読はありません",
    unreadAhead: "次の選択肢までに未読があるため、進めません",
    stoppedAtUnread: "未読のため、ここで止まりました",
  },

  /**
   * 図鑑（@liminalia/std の @codex）。閉じるボタンは close。fresh はまだ読んでいない印、related は関連する項目の見出し。
   * added と updated は新しく開いたときの知らせ（数を入れる関数なので、作品の文言の表では替えられない）。
   */
  codex: {
    title: "記録",
    empty: "まだ何も記録していません",
    fresh: "新",
    related: "関連",
    added: (title: string) => `記録に「${title}」を加えた`,
    updated: (title: string) => `「${title}」の記録が増えた`,
    /** 一度に二つ以上開いたとき。 */
    addedMany: (n: number) => `記録に ${n} 件加えた`,
    updatedMany: (n: number) => `${n} 件の記録が増えた`,
  },

  /**
   * 調べる画面（@liminalia/std の @investigate）。finish は「調べ終える」のボタン、done は調べた場所の印の読み上げ、
   * unfinished は調べていない場所が残ったまま「調べ終える」を押したときの確かめ、reveal は調べられる場所を光らせるボタン。
   */
  investigate: {
    finish: "調べ終える",
    done: "調べた",
    unfinished: "まだ調べていない場所があります。調べ終えますか？",
    reveal: "場所を示す",
  },

  /** 地図から選ぶ画面（@liminalia/std の @map-choice）。go は決めるボタン、hint は地点を選ぶ前の案内。 */
  mapChoice: {
    go: "ここに決める",
    hint: "地点を選んでください",
  },

  /** 章の扉と章末（@liminalia/std の @chapter-card・@chapter-end）。end は章末の終わりの表記（text= を書かなかったとき）。 */
  chapter: {
    end: "完",
  },

  toast: {
    /** 標準の配置でないゲームパッドをつないだとき。 */
    padNotStandard: "このコントローラーのボタンの配置を読み取れません。ボタンが合わないときは、コンフィグの「操作」で入れ替えてください",
    saved: "セーブしました",
    quickSaved: "クイックセーブしました",
    saveFailed: "セーブできませんでした",
    noQuickSave: "クイックセーブがありません",
    deleted: "削除しました",
    copied: "コピーしました",
    moved: "移動しました",
    lockedSlot: "保護されているスロットです",
    achieved: (title: string) => `実績を解除しました: ${title}`,
    screenshot: "スクリーンショットを保存しました",
    screenshotFailed: "スクリーンショットを撮れませんでした",
    exportFailed: "セーブデータをエクスポートできませんでした",
    muted: "ミュートしました",
    unmuted: "ミュートを解除しました",
    textCopied: "本文をコピーしました",
    copyFailed: "コピーできませんでした",
    /** @quit ask=false で、ゲームからアプリを閉じられないとき。 */
    cannotQuit: "ここではゲームを終了できないため、タイトル画面に戻りました",
  },
};

export type UiText = typeof TEXT;

/**
 * 今の言語のシステム画面の文言（作品の文言の表と訳のファイルの ui を重ねたもの）。標準の命令の画面（@liminalia/std の図鑑など）が読む。
 * 言語を替えると中身が替わるので、文字を出すたびに読む。
 */
export function systemText(): Readonly<UiText> {
  return TEXT;
}

/** 原文（日本語）の表。 */
const TEXT_JA: UiText = structuredCloneText(TEXT);

/** 関数も含めて写す（structuredClone は関数を写せない）。 */
function structuredCloneText<T>(o: T): T {
  if (typeof o !== "object" || o === null) return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, structuredCloneText(v)])) as T;
}

/** 入れ子の表を target に重ねる（文字列と関数だけ）。 */
function overlay(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && target[k] && typeof target[k] === "object") overlay(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    else if (typeof v === "string" || typeof v === "function") target[k] = v;
  }
}

/**
 * 訳のファイルの ui（鍵 → 訳か、英語の原文を添えた訳）を、上書きする文言（鍵 → 文字列）にする。
 * 訳が空のもの（lim i18n が並べたまま、まだ訳していない鍵）は除く（英語の文言を出す）。
 */
export function translatedUi(ui: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ui ?? {})) {
    const text = uiTranslationText(value as Parameters<typeof uiTranslationText>[0]);
    if (text !== "") out[key] = text;
  }
  return out;
}

/**
 * システム画面の文言を言語に合わせる。日本語は原文の表、それ以外は英語の表を下敷きにし、
 * overrides（"title.start" のような鍵 → 文字列。訳のファイルの ui は translatedUi で直したもの）で上書きする。
 */
export function setUiLanguage(language: string, overrides: Readonly<Record<string, string>> = {}): void {
  overlay(TEXT as unknown as Record<string, unknown>, TEXT_JA as unknown as Record<string, unknown>);
  if (!language.startsWith("ja")) overlay(TEXT as unknown as Record<string, unknown>, TEXT_EN as unknown as Record<string, unknown>);
  for (const [path, value] of Object.entries(overrides)) {
    if (typeof value !== "string") continue;
    const keys = path.split(".");
    let o = TEXT as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) o = (o?.[k] ?? {}) as Record<string, unknown>;
    const last = keys.at(-1)!;
    if (o && typeof o[last] === "string") o[last] = value;
  }
}

/** 日時の表示（年/月/日 時:分）。 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
