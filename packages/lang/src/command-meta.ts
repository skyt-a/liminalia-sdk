/**
 * 組み込みの命令の、書き方とは別の情報（制作画面のパーツの欄・AI の手引き・MCP が読む）。
 * - category: パーツの欄の区切り（ここに無い命令は system）
 * - keywords: やりたいことの言葉（「揺らす」「暗転」など）。命令の名前や説明を知らなくても探せるように
 * - preview: パーツの見本で繰り返し流す行。次は見本の素材に置き換える（作品に無ければ、その見本は出さない）:
 *   {bg}・{bg2}（背景）、{who}（立ち絵の人物）、{speaker}（その人物の話者名）、{bgm}・{se}・{voice}（音）。
 *   見本は自動で送るので、本文の行を書いてもよい。reset は次に流す前に元へ戻す行。
 *   画面に何も出ない命令（変数・チェックポイント・課金・終了など）と、作品の設定が無いと何も出ない命令（@cg-unlock・@face）は
 *   持たない（パーツの札だけ）
 * プラグインの命令は、定義の category・keywords で同じことを書く。
 */

export const COMMAND_CATEGORIES = ["screen", "sprite", "sound", "motion", "flow", "system"] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export interface CommandPreview {
  lines: readonly string[];
  reset?: readonly string[];
}

export interface CommandMeta {
  category: CommandCategory;
  keywords?: readonly string[];
  preview?: CommandPreview;
  /** 区切りの中の小分け（制作画面のパーツの欄が見出しにする。名前の文言は制作画面の側）。 */
  group?: string;
  /** めったに使わない命令（待つ・止める・元に戻すなど）。パーツの欄では「詳しい命令」に畳む。 */
  advanced?: true;
}

const screen = (keywords: string[], preview?: CommandPreview): CommandMeta => ({ category: "screen", keywords, ...(preview ? { preview } : {}) });
const sprite = (keywords: string[], preview?: CommandPreview): CommandMeta => ({ category: "sprite", keywords, ...(preview ? { preview } : {}) });
const sound = (keywords: string[]): CommandMeta => ({ category: "sound", keywords });
const motion = (keywords: string[], preview?: CommandPreview): CommandMeta => ({ category: "motion", keywords, ...(preview ? { preview } : {}) });
const flow = (keywords: string[]): CommandMeta => ({ category: "flow", keywords });
const system = (keywords: string[]): CommandMeta => ({ category: "system", keywords });

const META: Readonly<Record<string, CommandMeta>> = {
  // ---- 背景と画面 ----
  bg: screen(["背景", "場所", "場面転換", "切り替え", "ワイプ", "background"], { lines: ["@bg {bg2} time=800ms"], reset: ["@bg {bg} time=0ms"] }),
  "bg-place": screen(["背景", "大きい背景", "位置", "パン", "スクロール"]),
  "scene-change": screen(["場面転換", "暗転", "明転", "シーンの切り替え", "背景", "立ち絵をすべて消す", "フェード", "BGM を止める", "曲を替える", "scene"], { lines: ["@scene-change {bg2} time=600ms"], reset: ["@bg {bg} time=0ms"] }),
  mask: screen(["暗転", "フェードアウト", "黒", "白", "画面を覆う", "場面転換"], { lines: ["@mask time=600ms", "@wait 300ms", "@mask-off time=600ms"] }),
  "mask-off": screen(["明転", "フェードイン", "暗転を戻す"], { lines: ["@mask time=600ms", "@wait 300ms", "@mask-off time=600ms"] }),
  quake: screen(["揺らす", "揺れ", "振動", "地震", "衝撃", "シェイク", "shake"], { lines: ["@quake time=500ms count=3 horizontal=12"] }),
  "quake-decay": screen(["揺らす", "揺れ", "だんだん弱まる", "余震", "衝撃"], { lines: ["@quake-decay time=900ms vertical=30"] }),
  camera: screen(["カメラ", "寄る", "ズーム", "拡大", "アップ", "引く", "パン", "zoom"], { lines: ["@camera zoom=1.25 time=800ms", "@wait 500ms", "@reset-camera time=600ms"] }),
  "reset-camera": screen(["カメラを戻す", "ズームを戻す"], { lines: ["@camera zoom=1.25 time=800ms", "@wait 500ms", "@reset-camera time=600ms"] }),
  "layer-camera": screen(["カメラ", "レイヤー", "ズーム", "奥行き"]),
  "reset-layer-camera": screen(["カメラを戻す", "レイヤー"]),
  "wait-camera": screen(["カメラを待つ"]),
  plane: screen(["奥行き", "多重スクロール", "遠景", "パララックス"]),
  "plane-hide": screen(["奥行きを外す"]),
  image: screen(["画像", "絵", "図", "地図", "一枚絵", "表示"]),
  "free-image": screen(["画像を消す"]),
  html: screen(["HTML", "自由な表示", "カード", "表", "ボタン", "お知らせ", "ステータス"]),
  "html-hide": screen(["HTML を消す", "カードを消す"]),
  layer: screen(["レイヤー", "表示", "非表示"]),
  blend: screen(["合成", "重ねる", "光", "ビネット", "フィルム"]),
  "blend-off": screen(["合成を外す"]),
  "blend-movie": screen(["動画を重ねる", "ほこり", "合成"]),
  filter: screen(["フィルタ", "白黒", "モノクロ", "セピア", "ぼかし", "色を変える"], { lines: ["@filter grayscale=100", "@wait 900ms", "@filter-off"] }),
  "filter-off": screen(["フィルタを外す"]),
  tone: screen(["色調", "夜", "夕方", "セピア", "回想", "モノクロ", "色を変える"], { lines: ["@tone sepia time=600ms", "@wait 700ms", "@tone none time=600ms"] }),
  effect: screen(["画面効果", "ぼかし", "ブラー", "モザイク", "波紋", "グリッチ", "ノイズ", "一瞬だけ"], { lines: ["@effect zoom-blur strength=20 x=50 y=50", "@wait 900ms", "@effect-off"] }),
  "effect-off": screen(["画面効果を止める"]),
  dof: screen(["被写界深度", "ぼかし", "ピント"]),
  freeze: screen(["止める", "画面を固定", "トランジション"]),
  transition: screen(["トランジション", "切り替え", "フェード"]),
  "wait-transition": screen(["トランジションを待つ"]),
  "chapter-card": screen(["章", "章の扉", "章タイトル", "扉", "エピソード", "第一章", "タイトルカード"], { lines: ["@chapter-card number=第一章 title=雨の駅 subtitle=\"RAINY STATION\" time=1500ms fade=500ms"] }),
  "chapter-end": screen(["章末", "章の終わり", "終わり", "完", "エンド", "つづく"], { lines: ["@chapter-end number=第一章 title=雨の駅 time=1500ms fade=500ms leave=none"] }),
  movie: screen(["動画", "ムービー", "オープニング", "映像", "movie"]),
  "bg-movie": screen(["背景動画", "動く背景", "動画"]),
  "stop-bg-movie": screen(["背景動画を止める"]),
  "wait-bg-movie": screen(["背景動画を待つ"]),
  particles: screen(["雨", "雪", "桜", "花びら", "光", "パーティクル", "降らせる", "天気"], { lines: ["@particles snow"], reset: ["@particles-off time=0ms"] }),
  "particles-off": screen(["雨を止める", "雪を止める", "パーティクルを止める"]),
  window: screen(["メッセージウィンドウ", "テキスト枠", "隠す", "表示"]),
  nvl: screen(["全画面テキスト", "NVL", "ノベル", "サウンドノベル"]),
  vertical: screen(["縦書き"]),
  balloon: screen(["吹き出し", "ふきだし"]),
  clear: screen(["本文を消す", "クリア", "改ページ"]),
  name: screen(["表示名", "名前欄", "？？？", "名前を伏せる", "正体", "プレイヤーの名前"]),
  "name-off": screen(["表示名を戻す", "名前欄を戻す"]),
  wait: screen(["待つ", "間", "ウェイト", "時間を置く", "止める"]),
  "wait-click": screen(["クリック待ち", "待つ"]),
  peek: screen(["覗く", "メッセージを隠す"]),
  "cg-unlock": screen(["CG", "一枚絵", "解放", "ギャラリー", "鑑賞"]),
  // ---- 一瞬の演出 ----
  flipbook: screen(["コマ送り", "連番", "アニメーション", "斬撃", "爆発", "エフェクト", "スプライトシート", "パラパラ", "繰り返す", "ループ"]),
  "flipbook-off": screen(["コマ送りを止める", "ループを止める", "繰り返しを止める"]),
  flash: screen(["フラッシュ", "光る", "閃光", "反転", "ネガ", "白く光る", "点滅", "衝撃"], { lines: ["@flash white count=2 time=60ms"] }),
  blink: screen(["瞬き", "まばたき", "目を閉じる", "目を覚ます", "気を失う", "瞼", "視界"], { lines: ["@blink count=2"] }),
  cutin: screen(["カットイン", "差し込み", "手がかり", "アップ", "枠付きの画像", "証拠", "持ち物"]),
  "cutin-hide": screen(["カットインを消す", "カットインを引く", "差し込みを消す"]),
  speedlines: screen(["集中線", "流線", "スピード線", "勢い", "漫画", "迫る", "走る", "衝撃"], { lines: ["@speedlines focus time=1200ms"] }),
  burst: screen(["衝撃", "爆発", "ドン", "擬音", "漫画", "ギザギザ", "吹き出し"], { lines: ["@burst text=ドン！ time=800ms"] }),
  // ---- 立ち絵 ----
  chara: sprite(["立ち絵", "キャラ", "人物", "登場", "表情", "表情を変える", "差分", "出す", "横から出る", "スライド", "拡大", "重なり順", "手前", "一人ずつ", "入れ替える"], { lines: ["@chara-hide {who} time=0ms", "@chara {who} at=center time=500ms"] }),
  "chara-hide": sprite(["立ち絵を消す", "退場", "退く", "いなくなる", "横へ消える", "スライド"], { lines: ["@chara-hide {who} time=500ms"], reset: ["@chara {who} at=center time=0ms"] }),
  "chara-hide-all": sprite(["立ち絵をすべて消す", "全員退場"], { lines: ["@chara-hide-all time=500ms"], reset: ["@chara {who} at=center time=0ms"] }),
  "chara-move": sprite(["立ち絵を動かす", "移動", "位置"]),
  "chara-shake": sprite(["立ち絵を揺らす", "驚く", "ぴょん", "跳ねる", "震える"], { lines: ["@chara-shake {who} count=2 swing=20"] }),
  "chara-config": sprite(["立ち絵の設定", "話している人を明るく", "暗くする", "話者強調", "沈める"]),
  emote: sprite(["漫符", "汗", "怒りマーク", "驚き", "びっくり", "はてな", "ハート", "きらきら", "音符", "立ち絵に付ける"], { lines: ["@emote {who} sweat"], reset: ["@emote-off"] }),
  "emote-off": sprite(["漫符を消す"]),
  face: sprite(["顔ウィンドウ", "顔", "表情"]),
  "face-off": sprite(["顔ウィンドウ", "顔", "消す"]),
  "window-image": screen(["メッセージウィンドウ", "枠", "背景", "画像"]),
  // ---- 音 ----
  bgm: sound(["BGM", "音楽", "曲", "流す", "music"]),
  "stop-bgm": sound(["BGM を止める", "音楽を止める", "フェードアウト"]),
  "pause-bgm": sound(["BGM を一時停止"]),
  "resume-bgm": sound(["BGM を再開"]),
  "bgm-volume": sound(["BGM の音量", "音量"]),
  "wait-bgm": sound(["BGM を待つ"]),
  se: sound(["効果音", "SE", "音", "鳴らす", "足音", "ドア", "環境音", "sound"]),
  "stop-se": sound(["効果音を止める"]),
  "pause-se": sound(["効果音を一時停止"]),
  "resume-se": sound(["効果音を再開"]),
  "se-volume": sound(["効果音の音量", "音量"]),
  "wait-se": sound(["効果音を待つ"]),
  voice: sound(["ボイス", "声", "台詞の声"]),
  "voice-auto": sound(["ボイス", "連番", "自動再生"]),
  "voice-auto-off": sound(["ボイスの自動再生を止める"]),
  "stop-voice": sound(["ボイスを止める"]),
  "voice-filter": sound(["電話越し", "無線", "こもった声", "響き", "フィルター", "ボイス"]),
  "wait-voice": sound(["ボイスを待つ"]),
  "text-sound": sound(["文字の音", "タイプ音", "ピコピコ"]),
  "text-sound-off": sound(["文字の音を止める"]),
  // ---- 動き ----
  anim: motion(["動かす", "アニメーション", "移動", "透明", "フェード"], { lines: ["@anim {who} left-by=160 time=500ms", "@wait-anim", "@anim {who} left-by=-160 time=500ms", "@wait-anim"] }),
  "stop-anim": motion(["アニメーションを止める"]),
  "wait-anim": motion(["アニメーションを待つ"]),
  keyframe: motion(["キーフレーム", "動きの定義"]),
  kanim: motion(["キーフレーム", "繰り返し動かす", "揺れる", "ゆらゆら"]),
  "stop-kanim": motion(["キーフレームを止める"]),
  "layer-text": motion(["文字を置く", "章タイトル", "テロップ", "字幕"]),
  "motion-text": motion(["文字の演出", "テロップ", "章タイトル", "文字を動かす"], { lines: ['@motion-text "見本の文字" x=200 y=300 size=44 in=fadeInUp time=1200ms'] }),
  // ---- 流れ ----
  choice: flow(["選択肢", "分岐", "選ぶ", "ルート"]),
  if: flow(["条件", "分岐", "もし", "フラグ"]),
  while: flow(["繰り返し", "ループ", "何回も", "あいだ"]),
  with: flow(["マクロ", "中身を渡す", "囲む", "回想の枠"]),
  content: flow(["マクロの中身", "差し込む"]),
  set: flow(["変数", "フラグ", "好感度", "数える", "代入"]),
  jump: flow(["飛ぶ", "移動", "次の章", "ジャンプ"]),
  call: flow(["呼ぶ", "サブルーチン"]),
  return: flow(["戻る"]),
  define: flow(["マクロ", "部品", "まとめる", "使い回す"]),
  use: flow(["別のファイルのマクロ"]),
  stop: flow(["終わり", "止める", "エンディング"]),
  "title-screen": flow(["タイトルへ戻る", "エンディング", "終わり"]),
  notify: system(["通知", "お知らせ", "トースト", "記録", "手帳に書き足す", "実績", "取得", "知らせる", "場面の切れ目まで待つ"]),
  "staff-roll": flow(["スタッフロール", "エンドロール", "クレジット", "流れる文字", "エンディング"]),
  // ---- 進行とシステム ----
  "text-speed": system(["文字の速さ", "テキスト速度", "ゆっくり"]),
  "text-speed-reset": system(["文字の速さを戻す"]),
  "text-input": system(["名前入力", "文字の入力", "主人公の名前"]),
  achieve: system(["実績", "トロフィー", "Steam"]),
  "achieve-progress": system(["実績の進み具合", "数える実績", "トロフィー", "回数"]),
  "replay-unlock": system(["回想", "解放"]),
  "replay-end": system(["回想の終わり"]),
  "glossary-unlock": system(["用語", "用語集", "辞書", "解放"]),
  codex: system(["図鑑", "記録", "手帳", "用語集", "開く"]),
  "codex-unlock": system(["図鑑", "記録", "手帳", "用語", "解放", "追記"]),
  investigate: flow(["調べる", "探索", "現場", "クリックで調べる", "ポイント", "アドベンチャー"]),
  "investigate-reset": flow(["調べ直す", "調べた印を消す"]),
  "map-choice": flow(["地図", "行き先", "移動", "マップ", "場所を選ぶ"]),
  "item-add": system(["アイテム", "持ち物", "手に入れる"]),
  "item-remove": system(["アイテムを捨てる", "持ち物"]),
  "item-select": system(["アイテムを選ぶ", "持ち物"]),
  "open-screen": system(["セーブ画面", "ロード画面", "設定画面", "システム画面を開く", "作品の画面", "独自の画面"]),
  "menu-button": system(["メニューボタン", "クイックメニュー", "隠す"]),
  dialog: system(["確認", "ダイアログ", "はい・いいえ"]),
  auto: system(["オート", "自動で進む"]),
  skip: system(["スキップ"]),
  autosave: system(["オートセーブ", "セーブ"]),
  checkpoint: system(["チェックポイント", "やり直し"]),
  rollback: system(["巻き戻し", "やり直し"]),
  "window-title": system(["ウィンドウのタイトル"]),
  "hud-button": system(["常駐のボタン", "いつも出ているボタン", "手帳", "メモ", "地図を開く", "HUD", "固定ボタン"]),
  "hud-button-off": system(["常駐のボタンを消す", "固定ボタンを消す"]),
  "hud-text": system(["常駐の表示", "日付", "場所", "好感度", "変数を表示", "ステータス", "HUD"]),
  "hud-text-off": system(["常駐の表示を消す"]),
  chat: system(["チャット", "メッセージアプリ", "LINE", "SNS"]),
  "chat-open": system(["チャットを開く", "メッセージアプリ"]),
  "chat-close": system(["チャットを閉じる"]),
  vibrate: system(["振動", "バイブ", "スマホ"]),
};

/** 本文の見本（見本は自動で送る）。 */
const PROSE = "　見本の文です。ここに本文が出ます。";
const SAY = "{speaker}「見本の台詞です。ここに台詞が出ます」";
const chara = "@chara {who} at=center time=0ms";

/** 上の表の見本に足すもの（音・本文・画面を使う見本）。 */
const MORE_PREVIEWS: Readonly<Record<string, CommandPreview>> = {
  // 背景と画面
  "bg-place": { lines: ["@bg-place {bg2} width=1600 height=900 left=-160 top=-90 time=800ms"], reset: ["@bg {bg} time=0ms"] },
  image: { lines: ["@image {bg2} folder=bgimage name=pic x=400 y=150 width=480 height=270 time=400ms", "@wait 900ms", "@free-image fg1 name=pic time=400ms"] },
  "free-image": { lines: ["@image {bg2} folder=bgimage name=pic x=400 y=150 width=480 height=270 time=0ms", "@wait 500ms", "@free-image fg1 name=pic time=500ms"] },
  plane: { lines: ["@plane far {bg2} depth=0.8 time=400ms", "@camera x=120 time=900ms", "@wait 300ms", "@reset-camera time=600ms"], reset: ["@plane-hide far time=0ms"] },
  "plane-hide": { lines: ["@plane far {bg2} depth=0.8 time=0ms", "@wait 500ms", "@plane-hide far time=500ms"] },
  blend: { lines: ["@blend name=tint color=#ff9966 mode=overlay opacity=180 time=500ms", "@wait 700ms", "@blend-off name=tint time=400ms"] },
  "blend-off": { lines: ["@blend name=tint color=#ff9966 mode=overlay opacity=180 time=0ms", "@wait 500ms", "@blend-off name=tint time=500ms"] },
  "filter-off": { lines: ["@filter grayscale=100", "@wait 700ms", "@filter-off"] },
  "effect-off": { lines: ["@effect zoom-blur strength=20 x=50 y=50", "@wait 700ms", "@effect-off"] },
  "particles-off": { lines: ["@particles snow", "@wait 1200ms", "@particles-off snow time=1s", "@wait 1000ms"] },
  dof: { lines: ["@dof background blur=8 time=500ms", "@wait 800ms", "@dof none time=500ms"] },
  layer: { lines: ["@layer fg0 opacity=60", "@wait 800ms", "@layer fg0 opacity=255"] },
  "layer-camera": { lines: ["@layer-camera base zoom=1.25 time=800ms", "@wait 400ms", "@reset-layer-camera base time=600ms"] },
  "reset-layer-camera": { lines: ["@layer-camera base zoom=1.25 time=800ms", "@wait 400ms", "@reset-layer-camera base time=600ms"] },
  freeze: { lines: ["@freeze", "@bg {bg2} time=0ms", "@transition method=fadeInLeft time=800ms"], reset: ["@bg {bg} time=0ms"] },
  transition: { lines: ["@freeze", "@bg {bg2} time=0ms", "@transition method=fadeInLeft time=800ms"], reset: ["@bg {bg} time=0ms"] },
  html: { lines: ["@html sample x=390 y=220 width=500 time=300ms", '<div style="padding:24px;border-radius:12px;background:rgba(0,0,0,.65);color:#fff;font-size:28px">見本の <b>HTML</b> の表示</div>', "@end", "@wait 1000ms"], reset: ["@html-hide sample"] },
  "html-hide": { lines: ["@html sample x=390 y=220 width=500", '<div style="padding:24px;border-radius:12px;background:rgba(0,0,0,.65);color:#fff;font-size:28px">見本の <b>HTML</b> の表示</div>', "@end", "@wait 600ms", "@html-hide sample time=400ms"] },
  // メッセージ枠と本文
  window: { lines: [PROSE, "@window hide time=400ms", "@wait 700ms", "@window show time=400ms"] },
  nvl: { lines: ["@nvl on", PROSE, "　全画面に文字を重ねて出します。", "@nvl off"] },
  vertical: { lines: ["@vertical on", PROSE, "@vertical off"] },
  balloon: { lines: ["@balloon on", SAY, "@balloon off"] },
  clear: { lines: [PROSE, "@clear", "@wait 600ms"] },
  name: { lines: ["@name {speaker} as=？？？", SAY, "@name-off {speaker}", SAY] },
  "name-off": { lines: ["@name {speaker} as=？？？", SAY, "@name-off {speaker}", SAY] },
  "text-speed": { lines: ["@text-speed 120ms", "　ゆっくり、一文字ずつ。", "@text-speed-reset"] },
  "text-speed-reset": { lines: ["@text-speed 120ms", "　ゆっくり。", "@text-speed-reset", "　いつもの速さ。"] },
  peek: { lines: [PROSE] },
  "chara-config": { lines: ["@chara-config focus=dim jump=true", SAY, "@chara-config focus=none jump=false"] },
  "menu-button": { lines: [PROSE, "@menu-button hide", "@wait 800ms", "@menu-button show"] },
  "layer-text": { lines: ['@layer-text "第一章　見本" x=80 y=300 size=48 name=chapter time=600ms', "@wait 900ms", "@free-image fg0 name=chapter time=400ms"] },
  "chat-open": { lines: ["@chat-open {speaker}", "@chat {speaker} text=見本のメッセージです", "@wait 600ms", "@chat-close"] },
  chat: { lines: ["@chat-open {speaker}", "@chat {speaker} text=見本のメッセージです", "@wait 600ms", "@chat-close"] },
  "chat-close": { lines: ["@chat-open {speaker}", "@chat {speaker} text=見本のメッセージです", "@wait 600ms", "@chat-close"] },
  "open-screen": { lines: ["@open-screen config"] },
  "text-input": { lines: ['@text-input temp.name prompt="名前を入力してください"'] },
  dialog: { lines: ['@dialog "見本の確認です。よろしいですか？" type=confirm'] },
  notify: { lines: ["@notify 見本の通知です kind=success", "@wait 1500ms"] },
  // 立ち絵と動き
  "chara-move": { lines: ["@chara-move {who} time=600ms left=80 wait=true", "@wait 400ms"], reset: ["@chara-hide {who} time=0ms", chara] },
  keyframe: { lines: ['@keyframe sway frames="0% rotate=0; 50% rotate=8 x=12; 100% rotate=0"', "@kanim {who} keyframe=sway time=600ms count=2"] },
  kanim: { lines: ['@keyframe sway frames="0% rotate=0; 50% rotate=8 x=12; 100% rotate=0"', "@kanim {who} keyframe=sway time=600ms count=2"] },
  "stop-kanim": { lines: ['@keyframe sway frames="0% rotate=0; 50% rotate=8 x=12; 100% rotate=0"', "@kanim {who} keyframe=sway time=500ms loop=true", "@wait 1500ms", "@stop-kanim {who}"] },
  "stop-anim": { lines: ["@anim {who} left-by=200 time=2000ms", "@wait 600ms", "@stop-anim {who}", "@wait 500ms"], reset: ["@chara-hide {who} time=0ms", chara] },
  "wait-anim": { lines: ["@anim {who} left-by=160 time=500ms", "@wait-anim", "@anim {who} left-by=-160 time=500ms", "@wait-anim"] },
  // 音
  bgm: { lines: ["@bgm {bgm} time=500ms", "@wait 2500ms"], reset: ["@stop-bgm time=300ms"] },
  "stop-bgm": { lines: ["@bgm {bgm} time=0ms", "@wait 1500ms", "@stop-bgm time=1s", "@wait 1000ms"] },
  "bgm-volume": { lines: ["@bgm {bgm} time=0ms", "@wait 1200ms", "@bgm-volume 20 time=800ms", "@wait 1200ms"], reset: ["@stop-bgm time=0ms"] },
  "pause-bgm": { lines: ["@bgm {bgm} time=0ms", "@wait 1200ms", "@pause-bgm", "@wait 800ms", "@resume-bgm", "@wait 1200ms"], reset: ["@stop-bgm time=0ms"] },
  "resume-bgm": { lines: ["@bgm {bgm} time=0ms", "@wait 1200ms", "@pause-bgm", "@wait 800ms", "@resume-bgm", "@wait 1200ms"], reset: ["@stop-bgm time=0ms"] },
  se: { lines: ["@se {se}", "@wait 1200ms"] },
  "stop-se": { lines: ["@se {se} loop=true", "@wait 1200ms", "@stop-se time=500ms", "@wait 600ms"] },
  "se-volume": { lines: ["@se-volume 30", "@se {se}", "@wait 1200ms", "@se-volume 100"] },
  voice: { lines: ["@voice {voice}", SAY] },
  "stop-voice": { lines: ["@voice {voice}", SAY, "@stop-voice"] },
  "text-sound": { lines: ["@text-sound {se} every=2", "　文字が出るたびに音が鳴ります。", "@text-sound-off"] },
  "text-sound-off": { lines: ["@text-sound {se} every=2", "　文字が出るたびに音が鳴ります。", "@text-sound-off", "　もう鳴りません。"] },
};

/** 小分け（区切りの中で、この順に並べる）。 */
export const COMMAND_GROUPS: Readonly<Record<CommandCategory, readonly string[]>> = {
  screen: ["background", "tone", "camera", "burst", "weather", "transition", "picture", "message", "wait"],
  sprite: ["sprite"],
  sound: ["bgm", "se", "voice"],
  motion: ["anim", "text-fx"],
  flow: ["end", "investigate"],
  system: ["progress", "save", "extras", "app", "store"],
};

const GROUP_OF: Readonly<Record<string, readonly string[]>> = {
  background: ["bg", "scene-change", "bg-place", "bg-movie", "stop-bg-movie", "wait-bg-movie", "plane", "plane-hide"],
  tone: ["mask", "mask-off", "tone", "filter", "filter-off", "blend", "blend-off", "blend-movie", "effect", "effect-off", "dof"],
  camera: ["quake", "quake-decay", "camera", "reset-camera", "wait-camera", "layer-camera", "reset-layer-camera"],
  burst: ["flash", "blink", "flipbook", "flipbook-off", "cutin", "cutin-hide", "speedlines", "burst"],
  weather: ["particles", "particles-off"],
  transition: ["freeze", "transition", "wait-transition", "chapter-card", "chapter-end"],
  picture: ["image", "free-image", "html", "html-hide", "layer", "movie", "cg-unlock"],
  message: ["window", "window-image", "nvl", "vertical", "balloon", "clear", "peek", "name", "name-off"],
  wait: ["wait", "wait-click"],
  sprite: ["chara", "chara-hide", "chara-hide-all", "chara-move", "chara-shake", "chara-config", "face", "face-off", "emote", "emote-off"],
  bgm: ["bgm", "stop-bgm", "pause-bgm", "resume-bgm", "bgm-volume", "wait-bgm"],
  se: ["se", "stop-se", "pause-se", "resume-se", "se-volume", "wait-se", "text-sound", "text-sound-off"],
  voice: ["voice", "voice-auto", "voice-auto-off", "voice-filter", "stop-voice", "wait-voice"],
  anim: ["anim", "stop-anim", "wait-anim", "keyframe", "kanim", "stop-kanim"],
  "text-fx": ["layer-text", "motion-text"],
  end: ["stop", "title-screen", "staff-roll"],
  progress: ["text-speed", "text-speed-reset", "text-input", "dialog", "notify", "chat-open", "chat", "chat-close", "item-add", "item-remove", "item-select", "auto", "skip", "vibrate"],
  save: ["autosave", "checkpoint", "rollback"],
  extras: ["achieve", "achieve-progress", "replay-unlock", "replay-end", "glossary-unlock", "codex", "codex-unlock"],
  investigate: ["investigate", "investigate-reset", "map-choice"],
  app: ["open-screen", "menu-button", "window-title", "hud-button", "hud-button-off", "hud-text", "hud-text-off"],
};

/** めったに使わない命令（パーツの欄では「詳しい命令」に畳む）。 */
const ADVANCED = /* @__PURE__ */ new Set([
  "emote-off",
  "hud-text-off",
  "hud-button-off",
  "cutin-hide",
  "wait-bg-movie", "stop-bg-movie", "blend-movie", "dof", "filter-off", "effect-off", "blend-off", "flipbook-off",
  "wait-camera", "layer-camera", "reset-layer-camera", "freeze", "wait-transition", "layer", "peek", "name-off", "menu-button", "face", "bg-place", "plane-hide",
  "chara-config", "pause-bgm", "resume-bgm", "wait-bgm", "pause-se", "resume-se", "wait-se", "se-volume", "bgm-volume", "text-sound-off",
  "voice-auto-off", "stop-voice", "wait-voice", "stop-anim", "wait-anim", "stop-kanim",
  "text-speed-reset", "item-remove", "item-select", "auto", "skip", "vibrate", "rollback", "replay-end", "window-title",
]);

/**
 * 見本だけあって表に無い命令の名前（テストが空であることを確かめる）。
 * 読み込んだときに確かめると、遊ぶ側の書き出しでこの表を束から外せなくなる（最上位の throw が副作用になる）ので、テストで見る。
 */
export function previewsWithoutMeta(): string[] {
  return Object.keys(MORE_PREVIEWS).filter((name) => !META[name]);
}


// 引数の無い即時関数に /* @__PURE__ */ を付けるのは、遊ぶ側の書き出しで使わないときに束から外すため
// （Rollup は印を付けた呼び出しでも、引数の中の配列の map などは残す）
export const COMMAND_META: Readonly<Record<string, CommandMeta>> = /* @__PURE__ */ (() => {
  const groupByName = new Map(Object.entries(GROUP_OF).flatMap(([group, names]) => names.map((n) => [n, group] as const)));
  return Object.fromEntries(
    Object.entries(META).map(([name, meta]) => {
      const group = groupByName.get(name);
      return [
        name,
        {
          ...meta,
          ...(!meta.preview && MORE_PREVIEWS[name] ? { preview: MORE_PREVIEWS[name]! } : {}),
          ...(group ? { group } : {}),
          ...(ADVANCED.has(name) ? { advanced: true as const } : {}),
        },
      ];
    }),
  );
})();

/**
 * 見本の行の日本語の文と、英語の制作画面で流すときの英語（見本の行に書いた字のまま置き換える）。
 * 台詞は今の書き方（話者「…」）のまま、中の文だけを替える。
 */
const PREVIEW_TEXT_EN: readonly (readonly [string, string])[] = [
  [PROSE, "This is sample text. The story text appears here."],
  ["「見本の台詞です。ここに台詞が出ます」", "「This is a sample line. Dialogue appears here.」"],
  ["\u3000全画面に文字を重ねて出します。", "Text is laid over the whole screen."],
  ["\u3000ゆっくり、一文字ずつ。", "Slowly, one letter at a time."],
  ["\u3000ゆっくり。", "Slowly."],
  ["\u3000いつもの速さ。", "The usual speed."],
  ["\u3000文字が出るたびに音が鳴ります。", "A sound plays as each letter appears."],
  ["\u3000もう鳴りません。", "No more sound."],
  ["見本の <b>HTML</b> の表示", "Sample <b>HTML</b>"],
  ["as=？？？", "as=???"],
  ['"第一章\u3000見本"', '"Chapter 1: Sample"'],
  ["text=見本のメッセージです", 'text="This is a sample message"'],
  ['prompt="名前を入力してください"', 'prompt="Enter a name"'],
  ['"見本の確認です。よろしいですか？"', '"This is a sample confirmation. Continue?"'],
  ["@notify 見本の通知です ", '@notify "This is a sample notice" '],
];

/** 見本の行を、その言語の文にする（英語のときだけ置き換える。ほかの言語は日本語のまま）。 */
export function previewLine(line: string, language: string): string {
  if (language !== "en") return line;
  let out = line;
  for (const [ja, en] of PREVIEW_TEXT_EN) out = out.replaceAll(ja, en);
  return out;
}

/** 命令の区切り（プラグインの命令は定義の category、無ければ null）。 */
export function commandCategory(name: string, own?: string): CommandCategory | null {
  const c = COMMAND_META[name]?.category ?? own;
  return c && (COMMAND_CATEGORIES as readonly string[]).includes(c) ? (c as CommandCategory) : null;
}
