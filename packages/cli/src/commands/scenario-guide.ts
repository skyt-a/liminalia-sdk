import { FUNCTION_ARITY, FUNCTION_DOCS, FUNCTION_USAGE } from "@liminalia/lang";

/**
 * AI のアシスタントに渡す、シナリオ（.lim）の書き方の手引き（lim mcp の scenario_guide と、resource の liminalia://guide/scenario）。
 * docs/design/format.md を AI 向けに短くまとめたもの。式の関数の表は lim reference と同じ表（@liminalia/lang）から作る。
 * format.md と食い違わないよう、主な見出しと本文の中の書き方の一覧、関数の名前が入っていることを test/scenario-guide.test.ts が確かめる。
 * 命令ごとのパラメータはここに書かない（command_reference が仕様から出す）。
 */

const GUIDE = `# シナリオ（.lim）の書き方

元の文書は docs/design/format.md。命令（\`@名前\`）ごとのパラメータは command_reference で引く。書いたら check_text か check で確かめる。

## 行の種類

一行が一クリック（ページ）。種類は行頭で決まる。UTF-8、一ファイルに一章などのまとまりを書き、中をラベルで区切る。

| 行頭 | 種類 | 例 |
|---|---|---|
| 話者名と、すぐ後の \`「\` \`『\` \`（\` \`(\` | 台詞 | \`ユイ「おはよう」\` |
| 話者名と、後ろの \`"\` \`“\`（半角の空白を一つ挟んでもよい） | 台詞（英語） | \`Yui "Good morning."\` |
| \`@\` | コマンド | \`@chara ユイカ smile at=left time=300ms\` |
| \`# \` | ラベル | \`# north_road\` |
| \`//\` | コメント | \`// ここから回想\` |
| 空行 | 区切り（意味はない） | |
| それ以外 | 地の文 | \`窓の外では、雨が上がりかけていた。\` |

- 行頭の半角スペースとタブは字下げで意味を持たない。**全角スペースは本文として残る**（本文の字下げは全角スペース）
- 行頭の記号を本文にするときは \`\\\` を前に付ける（\`\\# は見出しではない\`）

## 台詞

- 台詞になるのは、行頭が cast.json の \`speakers\` に登録した話者名で、そのすぐ後に \`「\` \`『\` \`（\` \`(\` が来る行だけ。ほかは地の文
- 名前と括弧のあいだに空白を入れない（\`ユイ 「…」\` は地の文になり、警告 \`unknown-speaker\`）
- 英語の台詞は話者名の後ろに \`"\` か \`“\` で始まる本文を書く（\`Yui "Hello."\`、\`Yui“Wait for me!”\`）。話者名と引用符のあいだには半角の空白を一つだけ書いてよい（二つ以上や全角の空白は地の文）。一重の引用符（\`'\` \`‘\`）は台詞にならない
- 括弧も引用符も本文の一部で、ゲームには書いたまま出す（外すなら liminalia.json の \`ui.text.quotes: "strip"\`）
- 話者名は名前欄に出す名前。立ち絵のキャラクター（cast.json の \`cast\`）とは別に登録する
- 台詞の形をした地の文をわざと書くときは、行頭を全角スペースで字下げする
- 名前欄の名前だけを替える（「？？？」、プレイヤーが入力した名前など。口パクや音量などは話者のまま）:
  - その行だけ: \`ユイ{name ？？？}「……」\`、\`Yui{name ???} "……"\`（\`{name …}\` は話者名のすぐ後、括弧か引用符の前。中は文字と \`{= 式}\` だけ）
  - しばらく続ける: \`@name 話者 as=表示名\`（\`as=(式)\` も可）から \`@name-off 話者\`（話者を省くとすべて）まで。一行の \`{name …}\` が優先する

## ラベルとジャンプ先

- ラベルは \`# 名前\`（\`#\` の後に半角スペース。名前は文字、数字、\`_\`、\`-\`）。\`@if\` の中には置けない
- ジャンプ先: \`#ラベル\`（同じファイル）、\`ファイル\`（その先頭）、\`ファイル#ラベル\`、\`(式)\`（実行時に決める。候補は \`to=#a,#b\` で書ける）
- \`@jump chapter2#start\` で移る。\`@call common#interlude\` で呼び、\`@return\` で戻る
- ファイルの名前は scenario/ からのパスで拡張子なし（\`chapter1/a\`）

## 本文の中の書き方

台詞と地の文の中では \`{ … }\` で書き方を差し込む。本文で特別な文字は \`{\` \`}\` \`\\\` だけ（\`[\` \`]\` \`#\` \`&\` などはそのまま出る）。

ルビは \`{r 漢字|かんじ}\`（親文字と読みを \`|\` で区切る。親文字は何文字でもよい）。中に \`{…}\` は書けないので、飾るときは外側を囲む（\`{b {r 漢字|かんじ}}\`）。

| 書き方 | 意味 |
|---|---|
| \`{dot 大事}\` | 傍点 |
| \`{b 太字}\` \`{i 斜体}\` | 太字、斜体 |
| \`{c #cc3333 色}\` | 文字の色 |
| \`{size 32 大きな文字}\` | 文字サイズ（px） |
| \`{mark #ffff66 印}\` | 蛍光ペンのような背景色 |
| \`{fx wave 波打つ文字}\` \`{fx wave strength=2 speed=0.5 文字}\` | 文字の動き（\`shake\` \`wave\` \`pop\` \`fade\` \`glow\`。動きの大きさと速さの倍率を書ける） |
| \`{click}\` | 行の途中のクリック待ち |
| \`{noclick}\` | 行の最後に書くと、クリックを待たずに次の行へ進む（本文は次の本文まで残る。選択肢の問いかけを出したまま選ばせるときなど。行の最後にだけ書ける） |
| \`{br}\` | 同じページの中での改行 |
| \`{speed 600ms ……}\` | 囲んだ部分だけテキスト速度を変える |
| \`{= game.name}\` | 値を埋め込む |
| \`{img icons/heart.png}\` \`{img icons/heart.png 32}\` | 本文の中の画像（image フォルダ。高さ px） |
| \`{@chara ユイカ smile}\` | 本文がその位置まで出たときにコマンドを実行する（同じページのまま演出を差し込むときだけ） |
| \`{seq 一度目|二度目}\` \`{cycle 朝|夜}\` \`{once はじめまして|}\` \`{shuffle 赤|青}\` | 同じ行を通るたびに出す文を替える（seq は最後で止まる、cycle は戻る、once は出し終えたら空、shuffle はばらばら。数はセーブに入る。文字の \`|\` は \`\\|\`） |
| \`\\{\` \`\\}\` \`\\\\\` | \`{\` \`}\` \`\\\` そのもの |

- 飾り（\`b\` \`i\` \`c\` \`size\` \`mark\` \`fx\`）と傍点は入れ子にできる。親文字と読みは空にできない（\`empty-ruby\`）
- 当てはまらない \`{\` はエラーになる（黙って文字として出さない）

## コマンドの書き方

\`@名前 名前なしのパラメータ… 名前=値 …\`。コマンド名は英小文字、数字、\`-\`。

| 値 | 型 |
|---|---|
| \`300ms\` \`1.5s\` | 時間。単位は必須（\`300\` だけはエラー） |
| \`3\` \`-0.5\` | 数値 |
| \`true\` \`false\` | 真偽（必ずこう書く） |
| \`#000\` \`#cc3333\` \`#cc333380\` | 色 |
| \`"空白を含む文字列"\` \`room_night.jpg\` | 文字列 |
| \`(式)\` | 式。実行時に評価する（\`time=(t)\`） |
| \`#ラベル\` \`ファイル#ラベル\` | ジャンプ先 |
| \`game.x\` \`system.x\` \`temp.x\` | 結果を入れる変数（\`@text-input game.name\`） |

- **名前なしのパラメータは名前付きでは書けない**（\`positional-by-name\`）。どれが名前なしかは command_reference の「名前なしで書く」
- **既定値と同じ値は書かない**
- どのコマンドの行にも、\`@jump\` \`@call\` \`@set\` \`@let\` \`@return\` にも \`if=(式)\` を書ける。偽ならその行を飛ばす（\`@bg room_night.jpg if=(game.night)\`。\`@if\` で一行囲むのと同じ）
- 演出を待つかの既定はコマンドで決まる（背景や画面全体は待つ、立ち絵と音は待たない）。\`wait=true\` \`wait=false\` で変える
- 表示だけの HTML は \`@html 名前\` 〜 \`@end\`（JS は書けない）。\`@script\` は liminalia.json の \`allowScript\` がある作品だけ

## 立ち絵

\`\`\`
@chara ユイカ normal at=left time=500ms
@chara ユイカ smile
@chara ユイカ normal appearance=casual at=center
@chara-hide ユイカ time=300ms
\`\`\`

- キャラクター（名前なし一つ目）、差分（名前なし二つ目）、立ち絵セット（\`appearance=\`）は cast.json の \`cast\` にあるもの
- 表示も切り替えも \`@chara\` 一つ。表情だけ変えるなら \`@chara ユイカ smile\`（書かなかった位置や立ち絵セットは今のまま）
- 位置は \`at=left\` \`at=center\` \`at=right\`（差分の枠の立ち位置）か \`at=auto\`、または \`x=\` \`y=\`（px）
- \`commandDefaults.chara\` に \`"auto-layout": true\` がある作品は、\`at\` を省くと登場順に並べる。並べ方は liminalia.json の \`autoLayout\`（人数ごとの立ち位置 \`positions\`、入れる場所 \`enter\`、退場したとき \`exit\`、人数で名前の立ち位置を読み替える \`byCount\`）と、cast.json の人物ごとの定位置 \`side\`（read_cast が返す）

## ボイス

- \`@voice yui/001.ogg\` を本文の行の前に書くと、次の台詞で一度だけ鳴らす（assets/voice/ から）
- \`@voice-auto ユイ pattern="yui/{n:3}.ogg"\` はその話者の台詞ごとに連番を鳴らす。\`@voice-auto-off\` で止める

## 条件分岐（@if）

\`\`\`
@if game.trust >= 2
ユイ「なら、話は早いわ」
@elif game.trust == 1
ユイ「……考えておくわ」
@else
ユイ「……そう」
@end
\`\`\`

- ブロックは必ず \`@end\` で閉じる。字下げは見た目だけ。\`@if\` の中にラベルは置けない（\`label-in-if\`）
- 繰り返しは \`@while 条件\` 〜 \`@end\`、配列なら \`@for item in game.items\` 〜 \`@end\`（辞書ならキーを回す。\`@elif\` \`@else\` は書けない）
- 一行だけなら \`@jump #bad_end if=(game.trust < 0)\` のように行の \`if=(式)\` で書ける
- 「初めて調べたか」は変数を作らずに \`@if visits("#ラベル") == 1\`（このプレイでそのラベルに入った回数。下の関数）

## 選択肢（@choice）

\`\`\`
@choice
- 北の道を行く -> #north_road
- 鍵を使う -> #unlock if=(game.has_key)
- 引き返す -> #back
@end
\`\`\`

- 選択肢の行は \`- 文 -> ジャンプ先\`。後ろに \`if=(式)\`（真のときだけ出す）、\`locked=(式)\`（押せない状態で出す）、\`call=true\`、見た目（\`image=\` \`x=\` \`y=\` など）を書ける
- \`@choice\` の中は選択肢の行だけ（\`@if\` で囲めない）。制限時間は \`@choice timeout=10s default=2\`

## 変数と式

\`\`\`
@set game.trust += 1
@let count = game.trust * 2
ユイ「{= count} 回目ね」
\`\`\`

- \`game.x\` はセーブに入る、\`system.x\` は全セーブで共通、\`temp.x\` はそのプレイ中だけ、\`@let\` はそのファイルかマクロの中だけ
- 初期値は liminalia.json の \`variables\`（\`{ "game.trust": 0 }\`）
- 式は JavaScript ではない小さな言語: 四則、比較、論理（\`&&\` \`||\` \`!\`）、三項、配列 \`[1, 2]\`、辞書 \`{"a": 1}\`、添字、下の関数
- \`==\` は型も比べる。文字列は \`"…"\` だけ。\`+\` はどちらかが文字列ならつなげる。0 で割るとエラー
- \`@set\` も \`@let\` も \`=\` \`+=\` \`-=\` \`*=\` \`/=\`（\`@let i += 1\`）
- 計算を使い回すなら \`@function rank(score) = score >= 80 ? "A" : "B"\`（ファイルの一番外側に一行で。中は式一つで、読めるのは引数と \`game\` \`system\` \`temp\`。ほかのファイルからは \`@use\` して呼ぶ）

## マクロ（@define、@use）

\`\`\`
// 場面転換（すぐ上の // の行はマクロの要約。補完と説明に出る）
@define scene(image: asset(bgimage), time: duration = 800ms)
@mask time=(time)
@bg (image)
@mask-off time=(time)
@end

@scene image=room_night.jpg
\`\`\`

- 型は \`string\` \`number\` \`int\` \`bool\` \`duration\` \`color\` \`variable\` と、組み込みのコマンドと同じに確かめる \`asset(フォルダ)\` \`cast\` \`appearance\` \`variant\` \`position\` \`target\` \`enum(a|b)\`。中ではパラメータを \`(名前)\` で渡す（名前の \`-\` は式では \`_\`）
- 中身を渡すなら \`@with マクロ パラメータ…\` 〜 \`@end\`。マクロの中の \`@content\` でその中身を実行する
- 値を返すなら型 \`variable\` のパラメータを一つ書き、マクロの中で \`@return (式)\`（呼ぶ側は \`into=temp.r\` のように変数を渡す）
- liminalia.json の \`commandDefaults\` で、マクロの既定値のあるパラメータの既定値も決められる
- 別のファイルのマクロは、ファイルの一番外側に \`@use ファイル\` を書いてから呼ぶ

## 書いたあとの確かめ

- check_text: 書く前に中身を検査する（ほかのファイル、キャラクター、素材と合わせて）。check: 作品全体（\`lim check\`）
- trace: 画面なしで実行。screenshot: スクリーンショット
- 誤りは行と修正案（hint）付きで返る。直すときは edit_scenario で行を書き換える
- 分岐の確認は、プロジェクトの \`tests/\` に \`.limtest\`（\`# 名前\`、\`choose 文\`、\`expect game.trust == 2\`、\`expect reach ending#good\`）を書き、\`lim test\` で実行する。届く選び方は \`lim reach ファイル#ラベル\` で探せる`;

/** 式の関数の表（lim reference の「式の関数」と同じ表から作る）。 */
function functionTable(): string {
  const rows = Object.keys(FUNCTION_ARITY).map((name) => `| ${(FUNCTION_USAGE[name] ?? [`${name}()`]).map((u) => `\`${u}\``).join(" ")} | ${FUNCTION_DOCS[name] ?? ""} |`);
  return ["## 式の関数", "", "| 書き方 | 説明 |", "|---|---|", ...rows].join("\n");
}

export function scenarioGuide(): string {
  return `${GUIDE}\n\n${functionTable()}\n`;
}
