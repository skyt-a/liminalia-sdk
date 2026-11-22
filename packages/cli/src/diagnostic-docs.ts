// 生成したファイル。手で直さない（元は docs/design/format.md の code の表。npx tsx packages/cli/scripts/diagnostic-docs.ts で作り直す）。
import type { DiagnosticDoc } from "./diagnostic-docs-source.ts";

export const DIAGNOSTIC_DOCS: Readonly<Record<string, DiagnosticDoc>> = {
  "all-options-conditional": {
    "severity": "警告",
    "summary": "すべての選択肢に `if=` があり、どれも出ずに止まることがある（8 章）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "ambiguous-bool-shorthand": {
    "severity": "エラー",
    "summary": "真偽値の省略形が、名前なしのパラメータの値にも読める。真偽値には `name=true` と明示する",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "aozora-ruby": {
    "severity": "警告",
    "summary": "本文に残った《》のルビや TyranoScript のタグ（`[p]` `[l]` `[r]` `[cm]` `[er]`）。どちらもそのまま表示される",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "tyrano-tag"
    ]
  },
  "asset-case-mismatch": {
    "severity": "エラー",
    "summary": "素材の名前が、ファイルの名前と大文字と小文字だけ違う（Mac と Windows では開けても、Linux のサーバーやスマホでは読めない）。フォルダの中にある実際の名前と突き合わせ、その名前に置き換える修正案を出す",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "asset-not-exported": {
    "severity": "警告",
    "summary": "書き出しに入らない種類のファイル（拡張子が素材の表に無いもの）を参照している",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "bad-after-load": {
    "severity": "エラー",
    "summary": "liminalia.json の `ui` `items` `extra` `afterLoad` の形の誤り",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-ui",
      "bad-items",
      "bad-extra"
    ]
  },
  "bad-arguments": {
    "severity": "エラー",
    "summary": "式の誤り、定義していない変数、無い関数（別のファイルの `@function` なら `@use` を修正案に出す）、関数の引数の数の違い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "bad-expression",
      "unknown-variable",
      "unknown-function"
    ]
  },
  "bad-auto-layout": {
    "severity": "エラー",
    "summary": "liminalia.json の `autoLayout` の形の誤り（人数と立ち位置の数が合わない、知らない `enter` と `exit`、`byCount` のキーが人数でない・名前が空）と、どの立ち絵の枠にも無い立ち位置の名前（`byCount` の書いた側も。6章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "bad-cast": {
    "severity": "エラー",
    "summary": "cast.json の形の誤り（人物の `side` が `left` と `right` のほかも。6章）",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "bad-chapters": {
    "severity": "エラー、警告",
    "summary": "liminalia.json の `chapters` の形の誤り、章のファイルの指定がどのシナリオにも当たらない、一つのファイルが二つの章に入る（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "chapter-files"
    ]
  },
  "bad-color": {
    "severity": "エラー",
    "summary": "本文の `{c #色 …}` `{mark #色 …}`、`{size 32 …}`、`{speed 600ms …}`、`{img パス}`、`{fx wave …}` の書き方の誤り（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-size",
      "bad-speed",
      "bad-image",
      "bad-fx"
    ]
  },
  "bad-command-defaults": {
    "severity": "エラー",
    "summary": "liminalia.json の `commandDefaults` の誤り（無いコマンドやパラメータ、型の違う値。その値は使わない。5 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "bad-command-name": {
    "severity": "エラー",
    "summary": "コマンド名に英小文字、数字、`-` 以外の字がある（`@Bg`、`{@ bg}` など）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-config": {
    "severity": "エラー、警告",
    "summary": "liminalia.json か cast.json を JSON として読めない（行と桁を出す）、`variables` の名前か `saves.location` の値の誤り（その項目は使わない。10 章）、`check.sound` の形の誤り（`quiet` に書いたシーンが無いときは警告。下の「音の抜け」）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "bad-content": {
    "severity": "エラー",
    "summary": "`@with` の形の誤り、`@define` の外に書いた `@content`、値を返せない所に書いた `@return (式)`（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-with",
      "bad-return"
    ]
  },
  "bad-define": {
    "severity": "エラー",
    "summary": "`@define` が `@define 名前(パラメータ: 型 = 既定値, …)` の形になっていない、パラメータの形が誤っている",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-param"
    ]
  },
  "bad-effect-mask": {
    "severity": "エラー",
    "summary": "`@filter` と `@effect` の `mask=` を読めない（書けるのは `\"radial x y 幅 高さ\"` か `\"radial-out x y 幅 高さ ぼかし\"`。値はどれも px）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "bad-encoding": {
    "severity": "エラー",
    "summary": "シナリオを UTF-8 として読めない（Shift_JIS などで保存したもの）。文字化けしたまま読み進めることはしない。UTF-8 で保存し直す。`lim check` はそのファイルのほかの診断を出さず、`lim trace` と `lim coverage` はそのファイルで止まる",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-expression": {
    "severity": "エラー",
    "summary": "式の誤り、定義していない変数、無い関数（別のファイルの `@function` なら `@use` を修正案に出す）、関数の引数の数の違い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "unknown-variable",
      "unknown-function",
      "bad-arguments"
    ]
  },
  "bad-extra": {
    "severity": "エラー",
    "summary": "liminalia.json の `ui` `items` `extra` `afterLoad` の形の誤り",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-ui",
      "bad-items",
      "bad-after-load"
    ]
  },
  "bad-for": {
    "severity": "エラー",
    "summary": "`@for 名前 in 式` の形でない、`game` など変数の頭に付く名前を `@for` の名前にした、配列でも辞書でもない値（数や文字列をそのまま書いたものなど）で繰り返そうとした（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-function": {
    "severity": "エラー",
    "summary": "`@function 名前(引数, …) = 式` の形でない（`@end` で閉じるブロックの形で書いたものは、まとめて一件の誤りとして知らせ、中身が `@return` 一つなら一行の形を修正案にする）、ファイルの一番外側に書いていない、組み込みの関数か別の `@function` と同じ名前にした（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "nested-function",
      "duplicate-function"
    ]
  },
  "bad-fx": {
    "severity": "エラー",
    "summary": "本文の `{c #色 …}` `{mark #色 …}`、`{size 32 …}`、`{speed 600ms …}`、`{img パス}`、`{fx wave …}` の書き方の誤り（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-color",
      "bad-size",
      "bad-speed",
      "bad-image"
    ]
  },
  "bad-guard": {
    "severity": "エラー",
    "summary": "ブロックを開くコマンド（`@if` `@while` `@for` `@with` `@choice` `@define` など）の行や本文の中の `{@…}` のように、書けない所に書いた `if=`、`(…)` で囲んでいない `if=`（`if=game.x` は `if=(game.x)` に直す。8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-image": {
    "severity": "エラー",
    "summary": "本文の `{c #色 …}` `{mark #色 …}`、`{size 32 …}`、`{speed 600ms …}`、`{img パス}`、`{fx wave …}` の書き方の誤り（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-color",
      "bad-size",
      "bad-speed",
      "bad-fx"
    ]
  },
  "bad-items": {
    "severity": "エラー",
    "summary": "liminalia.json の `ui` `items` `extra` `afterLoad` の形の誤り",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-ui",
      "bad-extra",
      "bad-after-load"
    ]
  },
  "bad-label": {
    "severity": "エラー",
    "summary": "ラベルの形の誤り。`#名前` のように空白を空けずに書いたもの（正しくは `# 名前`）、名前に文字、数字、_、- 以外の字を使ったもの",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-let": {
    "severity": "エラー",
    "summary": "`@set 変数 = 式` の形でない、`@set` の左辺が変数でない、`@let 名前 = 式` の形でない（どちらも `=` `+=` `-=` `*=` `/=` を書ける）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-set",
      "bad-set-target"
    ]
  },
  "bad-line-id": {
    "severity": "エラー、警告",
    "summary": "同じファイルで二度使った固定の行 ID、英数字と `_` `-` 以外の字を含む `#line:`（2 章。行 ID でない `#line:` は本文として表示される）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "duplicate-line-id"
    ]
  },
  "bad-option": {
    "severity": "エラー",
    "summary": "`@choice` の中にある `- 文 -> ジャンプ先` の形でない行、文が無い選択肢（画像のボタンにする `image=` か、クリックできる範囲にする `width=` と `height=` を書いたものは除く）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "empty-option"
    ]
  },
  "bad-param": {
    "severity": "エラー",
    "summary": "`@define` が `@define 名前(パラメータ: 型 = 既定値, …)` の形になっていない、パラメータの形が誤っている",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-define"
    ]
  },
  "bad-return": {
    "severity": "エラー",
    "summary": "`@with` の形の誤り、`@define` の外に書いた `@content`、値を返せない所に書いた `@return (式)`（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-with",
      "bad-content"
    ]
  },
  "bad-ruby": {
    "severity": "エラー",
    "summary": "ルビの親文字か読みが空、読みの区切りの `|` が無いか、全角の `｜` で書いた（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "empty-ruby"
    ]
  },
  "bad-rules": {
    "severity": "エラー、警告",
    "summary": "liminalia.json の `check.rules` と `scenes` の形の誤り（下を参照）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-scenes"
    ]
  },
  "bad-scenes": {
    "severity": "エラー、警告",
    "summary": "liminalia.json の `check.rules` と `scenes` の形の誤り（下を参照）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-rules"
    ]
  },
  "bad-set": {
    "severity": "エラー",
    "summary": "`@set 変数 = 式` の形でない、`@set` の左辺が変数でない、`@let 名前 = 式` の形でない（どちらも `=` `+=` `-=` `*=` `/=` を書ける）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-set-target",
      "bad-let"
    ]
  },
  "bad-set-target": {
    "severity": "エラー",
    "summary": "`@set 変数 = 式` の形でない、`@set` の左辺が変数でない、`@let 名前 = 式` の形でない（どちらも `=` `+=` `-=` `*=` `/=` を書ける）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-set",
      "bad-let"
    ]
  },
  "bad-size": {
    "severity": "エラー",
    "summary": "本文の `{c #色 …}` `{mark #色 …}`、`{size 32 …}`、`{speed 600ms …}`、`{img パス}`、`{fx wave …}` の書き方の誤り（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-color",
      "bad-speed",
      "bad-image",
      "bad-fx"
    ]
  },
  "bad-speaker-name": {
    "severity": "エラー",
    "summary": "表示名の `{name …}` の誤り（中身が空、文字と `{= 式}` 以外を書いた、すぐ後に台詞の括弧か引用符が無い。2 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-speed": {
    "severity": "エラー",
    "summary": "本文の `{c #色 …}` `{mark #色 …}`、`{size 32 …}`、`{speed 600ms …}`、`{img パス}`、`{fx wave …}` の書き方の誤り（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-color",
      "bad-size",
      "bad-image",
      "bad-fx"
    ]
  },
  "bad-target": {
    "severity": "エラー",
    "summary": "ジャンプ先が `#ラベル`、`ファイル`、`ファイル#ラベル` のどれでもない、式で書いたジャンプ先の後ろに `to=` 以外を書いた",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-test": {
    "severity": "エラー",
    "summary": "`.limtest` の読めない行（`# 名前` より前の行、知らない言葉、形の違う `set` `choose` `expect reach` など）。読めない行のあるテストは通過にしない",
    "section": "12. `lim` コマンド / シナリオのテスト（`lim test`）",
    "related": []
  },
  "bad-translation": {
    "severity": "警告、エラー",
    "summary": "翻訳ファイルが無い、JSON として読めない（行と桁を出す）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "missing-translation"
    ]
  },
  "bad-ui": {
    "severity": "エラー",
    "summary": "liminalia.json の `ui` `items` `extra` `afterLoad` の形の誤り",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-items",
      "bad-extra",
      "bad-after-load"
    ]
  },
  "bad-use": {
    "severity": "エラー",
    "summary": "`@use ファイル` の形でない",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "bad-value": {
    "severity": "エラー",
    "summary": "型の違う値（単位の無い時間など）。値だけを直した行を修正案にする",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "bad-voice-lock": {
    "severity": "エラー",
    "summary": "voice-lock.json を JSON として読めない",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "bad-with": {
    "severity": "エラー",
    "summary": "`@with` の形の誤り、`@define` の外に書いた `@content`、値を返せない所に書いた `@return (式)`（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-content",
      "bad-return"
    ]
  },
  "bracket-mismatch": {
    "severity": "警告",
    "summary": "「」『』（）【】の閉じ忘れ、開き忘れ、入れ子の食い違い（一行の中で数える）",
    "section": "9. 構文チェック / 約物（括弧、句読点、記号）",
    "related": []
  },
  "branch-after-else": {
    "severity": "エラー",
    "summary": "`@if` `@while` `@with` `@choice` `@define` などのブロックの閉じ忘れ、対応するブロックの無い `@end` `@elif` `@else`",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-block",
      "orphan-end",
      "orphan-branch"
    ]
  },
  "call-without-return": {
    "severity": "警告",
    "summary": "`@call` の先から `@return` まで到達しない（ファイルの終わりで止まり、呼んだ所へ戻らない）。途中で `@jump` や選択肢で別の場所へ移るものは知らせない",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "cast-ambiguous": {
    "severity": "警告",
    "summary": "標準の差分や既定の立ち絵セットが、並び順で決まってしまう（6 章）",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "chapter-card-empty": {
    "severity": "警告",
    "summary": "番号も題も書かない `@chapter-card` と `@chapter-end` が、どの章にも入らないシナリオにある（何も書かれていない扉が出る。10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "chapter-files": {
    "severity": "エラー、警告",
    "summary": "liminalia.json の `chapters` の形の誤り、章のファイルの指定がどのシナリオにも当たらない、一つのファイルが二つの章に入る（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-chapters"
    ]
  },
  "chara-hide-per-line": {
    "severity": "警告",
    "summary": "台詞 2 行以内ごとに `@chara-hide-all` で全員を消して出し直すことを、3 回以上続けている（6 章）",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "chara-replace-conflict": {
    "severity": "エラー",
    "summary": "`@chara` の `replace` と、位置や全消しの指定が競合している",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "chara-replace-target": {
    "severity": "エラー",
    "summary": "入れ替え先が表示されていない、その位置に複数人がいる、または入れ替える人物が既に表示されている",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "chara-replace-unknown": {
    "severity": "エラー",
    "summary": "`replace` に書いた入れ替え先のキャラクターが、cast.json に無い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "chara-reshow": {
    "severity": "警告",
    "summary": "立ち絵を消して、本文をはさまずに同じキャラクターを出し直している（消えてまた出るのでちらつく）。全消しと直後の表示を、同じ演出の `@chara … clear=…` にまとめられる場合は、その修正案を付ける。単独の消去など、条件によっては消す行を削除する修正案も付ける。立ち絵セットを替えるもの、`enter` `exit` で動いて出入りするもの、消してから出し直すまでの間に背景の切り替え、暗転、動画、`@wait` を挟むものは知らせない（6 章）",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "chara-solo": {
    "severity": "情報",
    "summary": "立ち絵が出ているときの `@chara-hide-all` のすぐ次の行に、`@chara` を書いている。`@chara … solo=true` の一行にまとめる修正案を付ける（一人ずつ見せる書き方をまとめて直すには `lim check --fix chara-solo`）。続けて複数人を出すもの、全消しに `time` 以外を書いたもの、動いて入るもの、表示中の人物の見た目を変えるもの、出す人物が表示中か分からないものは知らせない（6 章）",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "choice-loop": {
    "severity": "警告",
    "summary": "画面なしで流したとき、本文を挟まずに同じ選択肢へ戻り続けたので止めた（`lim trace`。抜ける選択肢を足すか、`--choose` で選ぶ）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": []
  },
  "dangling-escape": {
    "severity": "エラー",
    "summary": "本文の `{…}` の対応が崩れている、その中に無い書き方を書いた、行末に `\\` がある",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "stray-brace",
      "unclosed-inline",
      "unknown-inline"
    ]
  },
  "data-bad-expr": {
    "severity": "エラー",
    "summary": "データの中の条件の式を読めない",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": []
  },
  "data-duplicate": {
    "severity": "エラー",
    "summary": "書かなければならない項目が無い、値の型が違う、同じ id が二つある",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-missing",
      "data-type"
    ]
  },
  "data-flag-unread": {
    "severity": "警告、情報",
    "summary": "データが読むフラグを、どのシナリオもデータも立てない、データで立てるフラグをどこも読まない",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-flag-unset"
    ]
  },
  "data-flag-unset": {
    "severity": "警告、情報",
    "summary": "データが読むフラグを、どのシナリオもデータも立てない、データで立てるフラグをどこも読まない",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-flag-unread"
    ]
  },
  "data-missing": {
    "severity": "エラー",
    "summary": "書かなければならない項目が無い、値の型が違う、同じ id が二つある",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-type",
      "data-duplicate"
    ]
  },
  "data-missing-asset": {
    "severity": "エラー、警告",
    "summary": "データの中から参照している素材、キャラクター、シーン、ほかの項目が無い",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-unknown-cast",
      "data-unknown-scene",
      "data-unknown-ref"
    ]
  },
  "data-type": {
    "severity": "エラー",
    "summary": "書かなければならない項目が無い、値の型が違う、同じ id が二つある",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-missing",
      "data-duplicate"
    ]
  },
  "data-unknown-cast": {
    "severity": "エラー、警告",
    "summary": "データの中から参照している素材、キャラクター、シーン、ほかの項目が無い",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-missing-asset",
      "data-unknown-scene",
      "data-unknown-ref"
    ]
  },
  "data-unknown-ref": {
    "severity": "エラー、警告",
    "summary": "データの中から参照している素材、キャラクター、シーン、ほかの項目が無い",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-missing-asset",
      "data-unknown-cast",
      "data-unknown-scene"
    ]
  },
  "data-unknown-scene": {
    "severity": "エラー、警告",
    "summary": "データの中から参照している素材、キャラクター、シーン、ほかの項目が無い",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "data-missing-asset",
      "data-unknown-cast",
      "data-unknown-ref"
    ]
  },
  "define-shadows-command": {
    "severity": "警告、エラー",
    "summary": "組み込みのコマンドと同じ名前のマクロ（プロジェクトのマクロのほうを使う。警告）、条件分岐やジャンプなど構文に使うコマンドと同じ名前のマクロ（エラー）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "doubled-punctuation": {
    "severity": "警告",
    "summary": "同じ句読点の重なり（`。。` `、、`）。修正案は一つにする",
    "section": "9. 構文チェック / 約物（括弧、句読点、記号）",
    "related": []
  },
  "draft-entry": {
    "severity": "エラー",
    "summary": "liminalia.json の `entry`（はじめから）、`afterLoad`、おまけの回想と章の `target` が、下書きのファイルを指している（書き出したゲームはそこで止まる）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "draft-target": {
    "severity": "警告",
    "summary": "下書き（`// lim: draft`。10 章）でないファイルから、下書きのファイルへ移る。下書きは書き出しに入らないので、`lim build` の前のチェックではエラーにする",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "draft-use": {
    "severity": "エラー",
    "summary": "下書きでないファイルが、下書きのファイルを `@use` している（書き出したゲームでは、そのファイルのマクロと関数が無い）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "duplicate-define": {
    "severity": "エラー",
    "summary": "マクロのパラメータと同じ名前の `@let`、同じ名前のマクロ",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "shadows-param"
    ]
  },
  "duplicate-function": {
    "severity": "エラー",
    "summary": "`@function 名前(引数, …) = 式` の形でない（`@end` で閉じるブロックの形で書いたものは、まとめて一件の誤りとして知らせ、中身が `@return` 一つなら一行の形を修正案にする）、ファイルの一番外側に書いていない、組み込みの関数か別の `@function` と同じ名前にした（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-function",
      "nested-function"
    ]
  },
  "duplicate-label": {
    "severity": "エラー",
    "summary": "同じファイルに同じラベルが二つある",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "duplicate-line-id": {
    "severity": "エラー、警告",
    "summary": "同じファイルで二度使った固定の行 ID、英数字と `_` `-` 以外の字を含む `#line:`（2 章。行 ID でない `#line:` は本文として表示される）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-line-id"
    ]
  },
  "duplicate-param": {
    "severity": "エラー",
    "summary": "同じパラメータを二回書いた",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "effect-mask-ignored": {
    "severity": "警告",
    "summary": "範囲を決められない `@effect`（`wave`、`glitch`、`chromatic`）に `mask=` を書いた。効果は画面全体にかかる（かける場所は `layer=` で決める）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "emote-hidden": {
    "severity": "警告",
    "summary": "`@emote` の人物の立ち絵が出ていないので、漫符を付けなかった",
    "section": "9. 構文チェック / 実行時の診断",
    "related": []
  },
  "empty-map": {
    "severity": "エラー、警告",
    "summary": "`@map-choice` の地図が `data/investigation.json` の `maps` に無い、選べる地点が一つも無い（次の行へ進む）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": [
      "unknown-map"
    ]
  },
  "empty-option": {
    "severity": "エラー",
    "summary": "`@choice` の中にある `- 文 -> ジャンプ先` の形でない行、文が無い選択肢（画像のボタンにする `image=` か、クリックできる範囲にする `width=` と `height=` を書いたものは除く）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-option"
    ]
  },
  "empty-ruby": {
    "severity": "エラー",
    "summary": "ルビの親文字か読みが空、読みの区切りの `|` が無いか、全角の `｜` で書いた（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-ruby"
    ]
  },
  "engine-version": {
    "severity": "警告",
    "summary": "`liminalia.json` の `engines.liminalia`（プロジェクトとテンプレートが対応するエンジン API バージョン）が、このエンジンに合わない",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": []
  },
  "flash-rate": {
    "severity": "警告",
    "summary": "1 秒に 3 回を超えて点滅する `@flash`。光の点滅で発作を起こすおそれがある（回数は `count`、`time`、`gap` と、プロジェクトの既定値から数える）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "flipbook-data": {
    "severity": "エラー",
    "summary": "`@flipbook` のコマの書き方の誤り（`image` も `data` も無い、`image` に `{n}` があるのに `frames` が無いなど）、`data=` の JSON が無い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "flipbook-frames"
    ]
  },
  "flipbook-frames": {
    "severity": "エラー",
    "summary": "`@flipbook` のコマの書き方の誤り（`image` も `data` も無い、`image` に `{n}` があるのに `frames` が無いなど）、`data=` の JSON が無い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "flipbook-data"
    ]
  },
  "flipbook-loop-wait": {
    "severity": "警告",
    "summary": "`loop=0`（止めるまで繰り返す）に `wait=true` を書いた（待たずに次へ進む）、`@flipbook-off` に書いた名前を、どの `@flipbook loop=0` の `name=` にも書いていない",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "flipbook-off-unknown"
    ]
  },
  "flipbook-missing": {
    "severity": "警告",
    "summary": "`@flipbook` のコマの画像が素材のフォルダに無い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "flipbook-off-unknown": {
    "severity": "警告",
    "summary": "`loop=0`（止めるまで繰り返す）に `wait=true` を書いた（待たずに次へ進む）、`@flipbook-off` に書いた名前を、どの `@flipbook loop=0` の `name=` にも書いていない",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "flipbook-loop-wait"
    ]
  },
  "font-no-vertical-metrics": {
    "severity": "警告",
    "summary": "縦書きの本文のフォントが、縦書きの字送り幅（vmtx）を持たない",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "forbidden-property": {
    "severity": "エラー",
    "summary": "変数の名前などに `__proto__` などを使った",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "fullwidth-symbol": {
    "severity": "警告",
    "summary": "行頭の全角の `＠` `＃` `／／`、全角の `＝`、`@choice` の外に書いた選択肢の行（2 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "option-outside-choice"
    ]
  },
  "hide-name-unknown": {
    "severity": "警告",
    "summary": "`@cutin-hide`、`@hud-text-off`、`@hud-button-off` に書いた名前を、どの `@cutin stay=true`、`@hud-text`、`@hud-button` も出していない（何も消さずに進む）。名前を式で決めて出すものがあれば、その種類のコマンドは確認しない",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "html-attribute-not-allowed": {
    "severity": "エラー",
    "summary": "`@html` に書けないタグ（`<script>` など）、書けない属性、`on…` の属性、式を書けない属性に書いた `{= 式}`（5 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-tag-not-allowed",
      "html-event-attribute",
      "html-dynamic-attribute"
    ]
  },
  "html-bad-nesting": {
    "severity": "エラー",
    "summary": "`@html` のタグの閉じ忘れ、入れ子の崩れ",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-unclosed-tag"
    ]
  },
  "html-dynamic-attribute": {
    "severity": "エラー",
    "summary": "`@html` に書けないタグ（`<script>` など）、書けない属性、`on…` の属性、式を書けない属性に書いた `{= 式}`（5 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-tag-not-allowed",
      "html-attribute-not-allowed",
      "html-event-attribute"
    ]
  },
  "html-empty": {
    "severity": "警告",
    "summary": "中身の無い `@html`、押すとジャンプする要素の無い `wait=true`、`wait=true` の無い `data-jump`",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-wait-without-jump",
      "html-jump-without-wait"
    ]
  },
  "html-empty-src": {
    "severity": "エラー",
    "summary": "`@html` に書いた外部の URL、空の `src=`",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-external-url"
    ]
  },
  "html-event-attribute": {
    "severity": "エラー",
    "summary": "`@html` に書けないタグ（`<script>` など）、書けない属性、`on…` の属性、式を書けない属性に書いた `{= 式}`（5 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-tag-not-allowed",
      "html-attribute-not-allowed",
      "html-dynamic-attribute"
    ]
  },
  "html-external-url": {
    "severity": "エラー",
    "summary": "`@html` に書いた外部の URL、空の `src=`",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-empty-src"
    ]
  },
  "html-inline": {
    "severity": "エラー",
    "summary": "本文の中に書いた `{@html …}`（`@html` は `@end` までの行に書く）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "html-jump-without-wait": {
    "severity": "警告",
    "summary": "中身の無い `@html`、押すとジャンプする要素の無い `wait=true`、`wait=true` の無い `data-jump`",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-empty",
      "html-wait-without-jump"
    ]
  },
  "html-tag-not-allowed": {
    "severity": "エラー",
    "summary": "`@html` に書けないタグ（`<script>` など）、書けない属性、`on…` の属性、式を書けない属性に書いた `{= 式}`（5 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-attribute-not-allowed",
      "html-event-attribute",
      "html-dynamic-attribute"
    ]
  },
  "html-unclosed-tag": {
    "severity": "エラー",
    "summary": "`@html` のタグの閉じ忘れ、入れ子の崩れ",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-bad-nesting"
    ]
  },
  "html-wait-without-jump": {
    "severity": "警告",
    "summary": "中身の無い `@html`、押すとジャンプする要素の無い `wait=true`、`wait=true` の無い `data-jump`",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "html-empty",
      "html-jump-without-wait"
    ]
  },
  "invisible-space": {
    "severity": "警告",
    "summary": "見えない文字（下を参照）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "label-in-define": {
    "severity": "エラー",
    "summary": "`@define` の中だけにあるラベルへのジャンプ（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "label-in-if": {
    "severity": "エラー",
    "summary": "`@if` の中に書いたラベル（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "legacy-ending": {
    "severity": "警告",
    "summary": "フォーマットバージョン 2 までのプロジェクトで、プレイを終えるコマンドの `ending=` に文言を書いた以前の書き方（`ending=\"BAD END\"`）。種類と `title=` に分けた書き方を修正案に出す。プロジェクト全体は `lim migrate` で移す（2 章の「プレイの終わり」）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "lfs-pointer": {
    "severity": "エラー",
    "summary": "参照している素材が Git LFS のポインタのまま（中身を取得していないので、表示も再生もできない）。素材ごとに、最初に参照した所に出す。直すには `git lfs pull`（CI では `actions/checkout` に `lfs: true`）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "long-silence": {
    "severity": "警告",
    "summary": "BGM も環境音も鳴らないまま、本文（台詞と地の文）が `check.sound.silence` 行（既定 30）以上続く。数え始めた行に、続いた行数と終わりの行を添えて出す。`@pause-bgm` で止めている間と、一回きりの `@se` は無音に数える",
    "section": "9. 構文チェック / 音の抜け（`check.sound`）",
    "related": []
  },
  "loop-across-files": {
    "severity": "情報",
    "summary": "ほかのファイルで鳴らしたループの効果音が、`@jump` や選択肢で移った先のファイルの本文でも鳴り続けている（雨音を止め忘れて次のシーンへ持ち込むなど）。移った先の最初の本文に、鳴らした行とチャンネルを添えて出す",
    "section": "9. 構文チェック / 音の抜け（`check.sound`）",
    "related": []
  },
  "map-spot-hidden": {
    "severity": "警告",
    "summary": "地図で選ぶ画面（`@map-choice`）で、地点の押す範囲のまん中が説明の欄（`panel`）の下に入り、押せない。地点を欄の外へ動かすか、`panel` を地点と重ならない側にする",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": []
  },
  "missing-asset": {
    "severity": "エラー",
    "summary": "無い素材のファイル",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "missing-expression": {
    "severity": "エラー",
    "summary": "`@if` などの式が空",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "missing-param": {
    "severity": "エラー",
    "summary": "無いパラメータ、必須のパラメータの書き忘れ、名前なしのパラメータが多すぎる",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "unknown-param",
      "too-many-positional"
    ]
  },
  "missing-translation": {
    "severity": "警告、エラー",
    "summary": "翻訳ファイルが無い、JSON として読めない（行と桁を出す）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "bad-translation"
    ]
  },
  "missing-value": {
    "severity": "エラー",
    "summary": "パラメータの `\"…\"` や `(…)` の閉じ忘れ、`名前=` の後ろに値が無い、パラメータを書けないコマンドにパラメータを書いた",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-string",
      "unclosed-paren",
      "unexpected-argument"
    ]
  },
  "missing-voice": {
    "severity": "警告",
    "summary": "無いボイスのファイル（`@voice-auto` の型が一つに決まる話者だけ）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "model-plugin-missing": {
    "severity": "警告",
    "summary": "cast.json の `model` の種類（`live2d`、`spine`）を描くプラグインを読み込んでおらず、liminalia.json の `plugins` にも無い。綴りの近い種類（`Live2D`）も知らせる。ゲームの画面では画像の立ち絵で表示される（[live2d-spine.md](../live2d-spine.md)）",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "nested-define": {
    "severity": "エラー",
    "summary": "ファイルの一番外側以外に書いた `@define` と `@use`",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "nested-use"
    ]
  },
  "nested-function": {
    "severity": "エラー",
    "summary": "`@function 名前(引数, …) = 式` の形でない（`@end` で閉じるブロックの形で書いたものは、まとめて一件の誤りとして知らせ、中身が `@return` 一つなら一行の形を修正案にする）、ファイルの一番外側に書いていない、組み込みの関数か別の `@function` と同じ名前にした（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "bad-function",
      "duplicate-function"
    ]
  },
  "nested-use": {
    "severity": "エラー",
    "summary": "ファイルの一番外側以外に書いた `@define` と `@use`",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "nested-define"
    ]
  },
  "newer-format": {
    "severity": "警告",
    "summary": "liminalia.json の `format`（シナリオのフォーマットバージョン）が、このエンジンの対応バージョンより新しい（新しいエンジンで書いたシナリオ。10 章の「シナリオのフォーマットバージョン」）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "no-choice-shown": {
    "severity": "警告",
    "summary": "選択肢の `if=` がすべて偽で、選択肢が一つも出なかった",
    "section": "9. 構文チェック / 実行時の診断",
    "related": []
  },
  "noclick-in-option": {
    "severity": "エラー",
    "summary": "行の最後以外に書いた `{noclick}`、選択肢の文に書いた `{noclick}`（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "noclick-not-last"
    ]
  },
  "noclick-not-last": {
    "severity": "エラー",
    "summary": "行の最後以外に書いた `{noclick}`、選択肢の文に書いた `{noclick}`（3 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "noclick-in-option"
    ]
  },
  "not-in-chapter": {
    "severity": "情報",
    "summary": "章を使うプロジェクトで、はじめから到達でき、本文のあるシナリオが、どの章にも入らない（セーブスロットの章の見出しと `chapter()` が空になる。10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "not-in-extra": {
    "severity": "警告",
    "summary": "`extra` の一覧に無い名前を解放するコマンド",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "option-outside-choice": {
    "severity": "警告",
    "summary": "行頭の全角の `＠` `＃` `／／`、全角の `＝`、`@choice` の外に書いた選択肢の行（2 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "fullwidth-symbol"
    ]
  },
  "orphan-branch": {
    "severity": "エラー",
    "summary": "`@if` `@while` `@with` `@choice` `@define` などのブロックの閉じ忘れ、対応するブロックの無い `@end` `@elif` `@else`",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-block",
      "orphan-end",
      "branch-after-else"
    ]
  },
  "orphan-end": {
    "severity": "エラー",
    "summary": "`@if` `@while` `@with` `@choice` `@define` などのブロックの閉じ忘れ、対応するブロックの無い `@end` `@elif` `@else`",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-block",
      "orphan-branch",
      "branch-after-else"
    ]
  },
  "outdated-translation": {
    "severity": "情報",
    "summary": "訳したあとで原文が変わった項目（固定の行 ID の行。前の原文の訳を出す）の数。`lim i18n --export xliff --changed` で書き出せる（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "plugin-api-version": {
    "severity": "警告",
    "summary": "プラグインが、このエンジンより新しい API バージョンを使う（`defineCommandPlugin` の `apiVersion`、`package.json` の `liminalia.api` と `engines.liminalia`。[plugins.md](../plugins.md) の「合うエンジンの宣言」）",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": [
      "plugin-engine-version"
    ]
  },
  "plugin-check-failed": {
    "severity": "エラー",
    "summary": "プラグインの `check` が例外を投げた、または診断の配列でないものか形の合わない診断を返した（ほかのチェックは最後まで行う）",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": [
      "plugin-check-invalid"
    ]
  },
  "plugin-check-invalid": {
    "severity": "エラー",
    "summary": "プラグインの `check` が例外を投げた、または診断の配列でないものか形の合わない診断を返した（ほかのチェックは最後まで行う）",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": [
      "plugin-check-failed"
    ]
  },
  "plugin-engine-version": {
    "severity": "警告",
    "summary": "プラグインが、このエンジンより新しい API バージョンを使う（`defineCommandPlugin` の `apiVersion`、`package.json` の `liminalia.api` と `engines.liminalia`。[plugins.md](../plugins.md) の「合うエンジンの宣言」）",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": [
      "plugin-api-version"
    ]
  },
  "plugin-function-clash": {
    "severity": "警告",
    "summary": "プラグインの式の関数が、組み込みの関数と同じ名前なので使われない",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": []
  },
  "plugin-load": {
    "severity": "エラー",
    "summary": "プロジェクトのプラグインを読み込めない（パッケージが無い、構文の誤りなど。理由を添える）。Studio と `lim studio` はそのプラグインを外して開き、そのプラグインのコマンドが未定義だという指摘は、この診断のヒントにまとめる",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": []
  },
  "plugin-replaces-command": {
    "severity": "警告",
    "summary": "プラグインのコマンドが、組み込みのコマンドか先に読み込んだプラグインのコマンド（標準のコマンドなど）のうち同じ名前のものを、宣言（`replaces: true`）なしに上書きしている",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "positional-by-name": {
    "severity": "エラー",
    "summary": "名前なしのパラメータを名前付きで書いた",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "redundant-cg-unlock": {
    "severity": "情報、警告",
    "summary": "表示したときに解放されるので要らない `@cg-unlock`、どのシナリオでも表示も解放もしない CG（おまけで見られない）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "unshown-cg"
    ]
  },
  "redundant-param": {
    "severity": "エラー",
    "summary": "ほかのパラメータと一緒に書いたために使われないパラメータ（`x` と `y` を両方書いたときの `at` など）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "redundant-stop": {
    "severity": "情報",
    "summary": "鳴っていないのに止めている（`@stop-bgm`、`@scene-change stop-bgm=true`、`@stop-se`）。修正案は行を消す（`stop-bgm=true` はそのパラメータを消す）",
    "section": "9. 構文チェック / 音の抜け（`check.sound`）",
    "related": []
  },
  "renamed-command": {
    "severity": "エラー",
    "summary": "名前が変わる前の古い名前で書いたコマンド（`@scene` は今の `@scene-change`）。今の名前に置き換える修正案を出す。プロジェクト全体は `lim migrate` で直す（10 章の「シナリオのフォーマットバージョン」）。同じ名前のマクロがあれば知らせない",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "renamed-param": {
    "severity": "警告",
    "summary": "名前が変わる前の古い名前で書いたパラメータ（`@bg x.jpg fade=1s` は今の `time=1s`）。古い名前のままでも動く。今の名前に置き換える修正案を出す。プロジェクト全体は `lim migrate` で直す（10 章の「シナリオのフォーマットバージョン」）。同じ名前のマクロのパラメータは知らせない",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "rule-appearance-change": {
    "severity": "",
    "summary": "`appearance-change-while-shown`: 出している人物の立ち絵セットを、消さずに替えた（衣装替えは出し直す）",
    "section": "9. 構文チェック / 演出の決まり（`check.rules`）とシーンの情報（`scenes`）",
    "related": []
  },
  "rule-appearance-era": {
    "severity": "",
    "summary": "`appearance-era`: 時代の立ち絵セットを混ぜた。`eras` には、時代ごとにその時代の立ち絵セットの名前を書く（`*` は任意の文字）。`scenes` に時代（`field`、既定 `era`）があるシーンでは、その時代の立ち絵セットを持つ人物はそれを使う。時代の無いシーンでは、一つのラベルの中で時代を混ぜない",
    "section": "9. 構文チェック / 演出の決まり（`check.rules`）とシーンの情報（`scenes`）",
    "related": []
  },
  "rule-cg-with-sprites": {
    "severity": "",
    "summary": "`cg-without-sprites`: CG（extra.cg の画像）を出すときに、立ち絵が残っている",
    "section": "9. 構文チェック / 演出の決まり（`check.rules`）とシーンの情報（`scenes`）",
    "related": []
  },
  "rule-fade-before-jump": {
    "severity": "",
    "summary": "`fade-before-file-jump`: 別のファイルへの `@jump` の前に暗転していない（`commands` は暗転として数えるコマンド。既定は `mask`、`scene-change`。`@mask-off` までは暗転のまま）",
    "section": "9. 構文チェック / 演出の決まり（`check.rules`）とシーンの情報（`scenes`）",
    "related": []
  },
  "rule-pov-sprite": {
    "severity": "",
    "summary": "`no-pov-sprite`: シーンの視点の人物（`scenes` の `pov`。キャラクター ID か話者名）の立ち絵を出した。`allow` には出してよい立ち絵セットを書く",
    "section": "9. 構文チェック / 演出の決まり（`check.rules`）とシーンの情報（`scenes`）",
    "related": []
  },
  "runtime": {
    "severity": "エラー",
    "summary": "実行中の誤り（式の型の違い、無い組み合わせの立ち絵、`to=` に無い行き先など）。条件の式の誤りは、その条件を偽として進める",
    "section": "9. 構文チェック / 実行時の診断",
    "related": []
  },
  "same-as-default": {
    "severity": "情報",
    "summary": "プロジェクトの既定値（liminalia.json の `commandDefaults`）と同じ値のパラメータ（`500ms` と `0.5s` は同じ）。外す修正案を付ける。コマンドの組み込みの既定値と同じ値は知らせない",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "save-relocated": {
    "severity": "エラー、警告",
    "summary": "読み込めないセーブ（このゲームより新しいセーブバージョンか、形が崩れたもの。10 章の「セーブバージョン」）、シナリオが変わってずれたセーブの位置（近い行から再開した）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": [
      "save-version"
    ]
  },
  "save-version": {
    "severity": "エラー、警告",
    "summary": "読み込めないセーブ（このゲームより新しいセーブバージョンか、形が崩れたもの。10 章の「セーブバージョン」）、シナリオが変わってずれたセーブの位置（近い行から再開した）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": [
      "save-relocated"
    ]
  },
  "scene-change-candidate": {
    "severity": "情報",
    "summary": "暗転から明転までの塊や、立ち絵の退場とその直後の場面転換を、`@scene-change` 一つにまとめられる（下の「場面転換にまとめる」）。動きが変わらない場合は、一行にまとめる修正案を付ける",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "scene-change-sprite-overlap": {
    "severity": "警告",
    "summary": "明転が始まっても前の立ち絵が消え終わっておらず、立ち絵が薄く見えることがある。暗転中に消し終えてから明転する `@scene-change` を修正案に付ける（直すと消え方が変わる）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "scene-start-no-bg": {
    "severity": "情報",
    "summary": "ほかのファイルから `@jump` か選択肢で飛んでくるシーン（ラベルかファイルの先頭）の初めに、最初の本文までに背景を決める命令（背景の画像を書いた `@scene-change` や `@bg`、単色の背景）が無い。前のファイルの画面のまま始まり、途中から再生したときと画面が変わる。画像を書かない `@scene-change`（制作画面で作ったシーンの雛形）は背景を決めたと数えない。飛んでくる所がすべて飛ぶ直前（`@if` の中から飛ぶなら `@if` の前も）に背景を決めているときと、`@call`、`call=true` の選択肢、式の飛び先、`@if` やマクロで始まるシーン、下書きのファイル、背景を使わない作品は知らせない",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "script-not-allowed": {
    "severity": "エラー、警告",
    "summary": "`allowScript` を書いていないプロジェクトの `@script`（エラー）。書いたプロジェクトでも `@script` の中身は実行しない（警告。プラグインのコマンドに書き直す）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "script-skipped"
    ]
  },
  "script-skipped": {
    "severity": "エラー、警告",
    "summary": "`allowScript` を書いていないプロジェクトの `@script`（エラー）。書いたプロジェクトでも `@script` の中身は実行しない（警告。プラグインのコマンドに書き直す）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "script-not-allowed"
    ]
  },
  "shadows-param": {
    "severity": "エラー",
    "summary": "マクロのパラメータと同じ名前の `@let`、同じ名前のマクロ",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "duplicate-define"
    ]
  },
  "single-ellipsis": {
    "severity": "情報",
    "summary": "`…` や `―` を一つだけ書いている（二つ重ねて `……` `――` にする）",
    "section": "9. 構文チェック / 約物（括弧、句読点、記号）",
    "related": []
  },
  "space-after-exclamation": {
    "severity": "情報",
    "summary": "文の途中の `！` `？` の後に全角の空白が無い。閉じ括弧、続く `！？`、`…` `―`、行の終わりの前では空白は要らず、「と」「って」などで受けるとき（`都会！ってこと`）も要らない。半角の空白は全角にそろえる。一行の中の一つずつを知らせ、「まとめて修正」で全部直せる",
    "section": "9. 構文チェック / 約物（括弧、句読点、記号）",
    "related": []
  },
  "staff-roll-empty": {
    "severity": "警告",
    "summary": "中身の無い `@staff-roll`（5 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "stale-translation": {
    "severity": "警告、情報",
    "summary": "原文の本文の中にあるコマンドが訳から抜けている、使われていない訳がある、今のシナリオに無い原文の訳が `stale` に残っている",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "translation-lost-command",
      "unused-translation"
    ]
  },
  "stray-brace": {
    "severity": "エラー",
    "summary": "本文の `{…}` の対応が崩れている、その中に無い書き方を書いた、行末に `\\` がある",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-inline",
      "unknown-inline",
      "dangling-escape"
    ]
  },
  "target-never-offered": {
    "severity": "警告",
    "summary": "プラグインのコマンドが教えた行き先が、画面なしで流したとき一度も選択肢に出なかった（`lim coverage`）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": []
  },
  "template-list-item": {
    "severity": "エラー",
    "summary": "部品の中の `data-list` に `data-item` が無い、`data-item` の部品が無い（一覧の一行を作れない）",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-missing": {
    "severity": "エラー",
    "summary": "`ui.templates` に登録したファイルが無いか、読めない（標準の画面のまま出る）",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-missing-role": {
    "severity": "エラー",
    "summary": "その画面に要る `data-role` が無い（閉じる手段の `close`、`cancel`、`ok` のどれも無い、確認の画面なのに `ok` が無いなど）。プロジェクトの部品を標準の部品に重ねた全体で見る",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-outdated": {
    "severity": "警告",
    "summary": "コピー元のバージョン（部品の `data-version`）が標準の現在のバージョンより古い、またはバージョンが無い（標準のテンプレートが変わった）。部品の名前と標準の現在のバージョンを出し、`lim screens diff <画面>` を案内する",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-overridden": {
    "severity": "警告",
    "summary": "同じ画面をプラグインの `screens.*`（`system`、選んだテーマの `screens.*` も）が差し替えているので、テンプレートは使われない。プラグインの `./web` の書き方から分かるものだけを見る",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-script-export": {
    "severity": "警告",
    "summary": "画面の JS（テンプレートと同じ場所にある同じ名前の `.js`。登録が無ければ `ui/screens/<画面>/<画面>.js`）に `export default` が無い（読んでも動かない）",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-script-unknown": {
    "severity": "警告",
    "summary": "画面の JS が、画面の `api` に無い名前（`api.answer` など）や、その画面で働かない `api.press` の値を使っている。`api` という名前で受けたときだけ見る。綴りの近い名前を出す",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-unknown-part": {
    "severity": "警告",
    "summary": "テンプレートの部品の名前（`data-part`）がその画面に無い、`data-part` の無い `<template>`、部品も `<style>` も無いファイル（使われない）",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-unknown-screen": {
    "severity": "警告",
    "summary": "`ui.templates` に書いた画面の名前が、テンプレートで作れる画面でない（使われない）。綴りの近い名前か、作れる画面の一覧を出す",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-unknown-value": {
    "severity": "警告",
    "summary": "`data-role`、`data-field`、`data-text`、`data-setting` の値が、その画面では働かない（押しても何もしない、文字が入らない）。綴りの近い値を出す",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "template-unsafe": {
    "severity": "警告",
    "summary": "ゲームの実行時に外されるもの（`script` などの要素、`on` で始まる属性、外部の URL、ページを移るリンク、`@import`）を書いている（外されるので動かない）",
    "section": "9. 構文チェック / 確かめること / 画面のテンプレート（`ui.templates`）",
    "related": []
  },
  "theme-engine-version": {
    "severity": "警告",
    "summary": "プロジェクトの中のテーマ（`themes/<id>/theme.json`）の `engines.liminalia` が、このエンジンの API バージョンに合わない（一部の見た目が表示されないことがある）",
    "section": "9. 構文チェック / 確かめること / プラグイン",
    "related": []
  },
  "too-many-positional": {
    "severity": "エラー",
    "summary": "無いパラメータ、必須のパラメータの書き忘れ、名前なしのパラメータが多すぎる",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "unknown-param",
      "missing-param"
    ]
  },
  "trailing-comment": {
    "severity": "エラー、警告",
    "summary": "行末の `//`（コマンドと選択肢の行ではエラー、台詞と地の文では警告。2 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "translation-lost-command": {
    "severity": "警告、情報",
    "summary": "原文の本文の中にあるコマンドが訳から抜けている、使われていない訳がある、今のシナリオに無い原文の訳が `stale` に残っている",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "unused-translation",
      "stale-translation"
    ]
  },
  "tyrano-tag": {
    "severity": "警告",
    "summary": "本文に残った《》のルビや TyranoScript のタグ（`[p]` `[l]` `[r]` `[cm]` `[er]`）。どちらもそのまま表示される",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "aozora-ruby"
    ]
  },
  "ui-css-asset": {
    "severity": "エラー",
    "summary": "作品の CSS の `url()` と `@import` が指すファイルが無い（CSS のファイルからの相対のパスで探す）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "ui-css-missing": {
    "severity": "エラー",
    "summary": "liminalia.json の `ui.css`（作品の CSS）に書いたファイルが無い（`ui.css` のその行に出す）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "ui-css-outside": {
    "severity": "エラー",
    "summary": "作品の CSS の `url()` と `@import` がプロジェクトの外を指す（`http:` などの絶対の URL、`/` で始まるパス、プロジェクトのフォルダより上。書き出しに入らず、書き出したゲームでは読めない）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "ui-css-syntax": {
    "severity": "エラー",
    "summary": "作品の CSS を読めない（閉じていないコメント、引用符、括弧。そのファイルのその行に出す）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "unclosed-block": {
    "severity": "エラー",
    "summary": "`@if` `@while` `@with` `@choice` `@define` などのブロックの閉じ忘れ、対応するブロックの無い `@end` `@elif` `@else`",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "orphan-end",
      "orphan-branch",
      "branch-after-else"
    ]
  },
  "unclosed-inline": {
    "severity": "エラー",
    "summary": "本文の `{…}` の対応が崩れている、その中に無い書き方を書いた、行末に `\\` がある",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "stray-brace",
      "unknown-inline",
      "dangling-escape"
    ]
  },
  "unclosed-paren": {
    "severity": "エラー",
    "summary": "パラメータの `\"…\"` や `(…)` の閉じ忘れ、`名前=` の後ろに値が無い、パラメータを書けないコマンドにパラメータを書いた",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-string",
      "missing-value",
      "unexpected-argument"
    ]
  },
  "unclosed-string": {
    "severity": "エラー",
    "summary": "パラメータの `\"…\"` や `(…)` の閉じ忘れ、`名前=` の後ろに値が無い、パラメータを書けないコマンドにパラメータを書いた",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-paren",
      "missing-value",
      "unexpected-argument"
    ]
  },
  "undeclared-variable": {
    "severity": "警告",
    "summary": "どこでも値を入れていない変数を読んでいて、値を入れている変数に綴りの近いものがある（綴り違いとみなし、その名前を修正案に出す）、`check.variables` が `\"declared\"` のときに `variables` に書いていない変数（8 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "unset-variable"
    ]
  },
  "unexpected-argument": {
    "severity": "エラー",
    "summary": "パラメータの `\"…\"` や `(…)` の閉じ忘れ、`名前=` の後ろに値が無い、パラメータを書けないコマンドにパラメータを書いた",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "unclosed-string",
      "unclosed-paren",
      "missing-value"
    ]
  },
  "uninitialized-variable": {
    "severity": "警告",
    "summary": "初期値が無く、`+=` などで前の値から計算するだけの変数を読んでいる（その計算より前にその行へ来ると、値の無いまま読む。8 章）。直すには `variables` に初期値を書く（`temp.` は先に `=` で値を入れる）。前の行で値を入れていないローカル変数を `@let x += 1` などで計算する行も知らせる（直すには前の行に `@let x = 0` を書く）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "unknown-appearance": {
    "severity": "エラー",
    "summary": "cast.json に無いキャラクター、立ち絵セット、差分、立ち位置",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": [
      "unknown-cast",
      "unknown-variant",
      "unknown-position"
    ]
  },
  "unknown-cast": {
    "severity": "エラー",
    "summary": "cast.json に無いキャラクター、立ち絵セット、差分、立ち位置",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": [
      "unknown-appearance",
      "unknown-variant",
      "unknown-position"
    ]
  },
  "unknown-codex-entry": {
    "severity": "エラー",
    "summary": "標準の調べる場所（`@investigate`）と図鑑（`@codex-unlock` など）の名前が、作品のデータ（`data/investigation.json`、`data/codex.json`）に無い。視点や段の名前が無いときも知らせる。実行中に見つけたものは実行時の診断として知らせる（図鑑は警告）",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "unknown-investigation"
    ]
  },
  "unknown-command": {
    "severity": "エラー",
    "summary": "無いコマンド。別のファイルのマクロなら、`@use` を修正案に出す",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "unknown-config-key": {
    "severity": "警告",
    "summary": "liminalia.json、cast.json、翻訳ファイルにある、型に無い項目（使われない）。綴りの近い項目を修正案にする（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "unknown-data-key": {
    "severity": "エラー",
    "summary": "プラグインのコマンドで、データの名前を受けるパラメータ（`t.dataKey`）の値が、作品のデータに無い（データのファイルが無いときと、ファイルの中にパラメータが読むパスが無いときも）",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": []
  },
  "unknown-ending-kind": {
    "severity": "エラー",
    "summary": "無いエンディングの種類（フォーマットバージョン 3 から）。近い種類の名前を修正案に出し、種類の代わりに文言を書いたときは、種類と `title=` に分けた書き方を修正案に出す。`playtest.avoidEndings` と式の `endings()` に書いた種類で、当たるものが無いときは警告",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "unknown-file": {
    "severity": "エラー",
    "summary": "無いラベル、無いファイル",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": [
      "unknown-label"
    ]
  },
  "unknown-function": {
    "severity": "エラー",
    "summary": "式の誤り、定義していない変数、無い関数（別のファイルの `@function` なら `@use` を修正案に出す）、関数の引数の数の違い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "bad-expression",
      "unknown-variable",
      "bad-arguments"
    ]
  },
  "unknown-inline": {
    "severity": "エラー",
    "summary": "本文の `{…}` の対応が崩れている、その中に無い書き方を書いた、行末に `\\` がある",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": [
      "stray-brace",
      "unclosed-inline",
      "dangling-escape"
    ]
  },
  "unknown-investigation": {
    "severity": "エラー",
    "summary": "標準の調べる場所（`@investigate`）と図鑑（`@codex-unlock` など）の名前が、作品のデータ（`data/investigation.json`、`data/codex.json`）に無い。視点や段の名前が無いときも知らせる。実行中に見つけたものは実行時の診断として知らせる（図鑑は警告）",
    "section": "9. 構文チェック / 確かめること / 作品のデータ（プラグインのデータの宣言）",
    "related": [
      "unknown-codex-entry"
    ]
  },
  "unknown-item": {
    "severity": "エラー",
    "summary": "`items` に無い持ち物",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "unknown-label": {
    "severity": "エラー",
    "summary": "無いラベル、無いファイル",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": [
      "unknown-file"
    ]
  },
  "unknown-map": {
    "severity": "エラー、警告",
    "summary": "`@map-choice` の地図が `data/investigation.json` の `maps` に無い、選べる地点が一つも無い（次の行へ進む）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": [
      "empty-map"
    ]
  },
  "unknown-nvl-style": {
    "severity": "エラー",
    "summary": "`@nvl on style=` に書いた見た目の名前が、liminalia.json の `ui.nvlStyles` に無い（4 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "unknown-option": {
    "severity": "警告",
    "summary": "`chosen(\"文\")` に書いた文の選択肢が、どのシナリオにも無い（いつも false になる。8 章）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "unknown-param": {
    "severity": "エラー",
    "summary": "無いパラメータ、必須のパラメータの書き忘れ、名前なしのパラメータが多すぎる",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "missing-param",
      "too-many-positional"
    ]
  },
  "unknown-position": {
    "severity": "エラー",
    "summary": "cast.json に無いキャラクター、立ち絵セット、差分、立ち位置",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": [
      "unknown-cast",
      "unknown-appearance",
      "unknown-variant"
    ]
  },
  "unknown-screen": {
    "severity": "警告",
    "summary": "開こうとした画面（`@open-screen` など）が無い",
    "section": "9. 構文チェック / 実行時の診断",
    "related": []
  },
  "unknown-speaker": {
    "severity": "警告",
    "summary": "台詞の形なのに地の文になった行（`ユイ：「…」` `【ユイ】「…」` のような行。話者でない名前の `{name …}` と、同じファイルに二行以上ある `Nora: \"…\"` も含む。2 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  },
  "unknown-targets": {
    "severity": "警告",
    "summary": "式で決めるジャンプ先の候補を読めず、`to=` も無い（8 章）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "unknown-tone": {
    "severity": "エラー",
    "summary": "無い色調",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": []
  },
  "unknown-type": {
    "severity": "エラー",
    "summary": "`@define` のパラメータの型が無い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": []
  },
  "unknown-variable": {
    "severity": "エラー",
    "summary": "式の誤り、定義していない変数、無い関数（別のファイルの `@function` なら `@use` を修正案に出す）、関数の引数の数の違い",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "bad-expression",
      "unknown-function",
      "bad-arguments"
    ]
  },
  "unknown-variant": {
    "severity": "エラー",
    "summary": "cast.json に無いキャラクター、立ち絵セット、差分、立ち位置",
    "section": "9. 構文チェック / 確かめること / キャラクター",
    "related": [
      "unknown-cast",
      "unknown-appearance",
      "unknown-position"
    ]
  },
  "unreachable-line": {
    "severity": "警告、情報",
    "summary": "`@jump`、`@return`、`@stop`、プレイを終えるコマンドの後にある、ラベルの無い行（どこからも到達しない）。到達しない行に台詞、地の文、選択肢があれば警告、コマンドだけなら情報",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "unset-variable": {
    "severity": "警告",
    "summary": "どこでも値を入れていない変数を読んでいて、値を入れている変数に綴りの近いものがある（綴り違いとみなし、その名前を修正案に出す）、`check.variables` が `\"declared\"` のときに `variables` に書いていない変数（8 章）",
    "section": "9. 構文チェック / 確かめること / コマンドとパラメータ",
    "related": [
      "undeclared-variable"
    ]
  },
  "unshown-cg": {
    "severity": "情報、警告",
    "summary": "表示したときに解放されるので要らない `@cg-unlock`、どのシナリオでも表示も解放もしない CG（おまけで見られない）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "redundant-cg-unlock"
    ]
  },
  "unsupported-command": {
    "severity": "警告",
    "summary": "その環境では動かさないコマンド（画面なしの実行での、描画だけのコマンドなど）、通った `@script`（中身は実行しない）",
    "section": "9. 構文チェック / 実行時の診断",
    "related": [
      "script-skipped"
    ]
  },
  "untranslated": {
    "severity": "情報",
    "summary": "訳し漏れ（訳が空の項目と、まだ翻訳ファイルに無い項目。本文の行、選択肢、コマンドの文字、プロジェクトの設定の文字）の数",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": []
  },
  "unused-define": {
    "severity": "情報",
    "summary": "どこからも呼ばれないマクロ、どの台詞にも使われない話者（cast.json の `speakers` のその話者の行に出す。liminalia.json の `check.unusedSpeakers` に書いた話者は除く）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": [
      "unused-speaker"
    ]
  },
  "unused-ignore": {
    "severity": "情報",
    "summary": "何も黙らせなかった `lim-ignore`（次の行かファイルに、その code の警告と情報が無い。code の綴り違いや、エラーを黙らせようとしたものも含む）。行を消す修正案を付ける。`lim check` と Studio のチェックのように、プロジェクト全体を見るときだけ知らせる",
    "section": "9. 構文チェック / 診断を黙らせる（`lim-ignore` と `check.severity`）",
    "related": []
  },
  "unused-label": {
    "severity": "情報",
    "summary": "どこからもジャンプされず、前の行からも続かないラベル（そのシーンに到達しない）。式の中の `\"#ラベル\"`、liminalia.json の `entry` と回想、プラグインのデータの行き先もジャンプ先に数える",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": []
  },
  "unused-speaker": {
    "severity": "情報",
    "summary": "どこからも呼ばれないマクロ、どの台詞にも使われない話者（cast.json の `speakers` のその話者の行に出す。liminalia.json の `check.unusedSpeakers` に書いた話者は除く）",
    "section": "9. 構文チェック / 確かめること / ジャンプ先",
    "related": [
      "unused-define"
    ]
  },
  "unused-translation": {
    "severity": "警告、情報",
    "summary": "原文の本文の中にあるコマンドが訳から抜けている、使われていない訳がある、今のシナリオに無い原文の訳が `stale` に残っている",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "translation-lost-command",
      "stale-translation"
    ]
  },
  "voice-lock-duplicate": {
    "severity": "警告、エラー",
    "summary": "ボイスの番号の固定の誤り。番号が決まっていない台詞（再生されない）、今のシナリオに無い台詞の番号、複数の台詞に振られた同じ番号（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "voice-unlocked",
      "voice-lock-outdated"
    ]
  },
  "voice-lock-outdated": {
    "severity": "警告、エラー",
    "summary": "ボイスの番号の固定の誤り。番号が決まっていない台詞（再生されない）、今のシナリオに無い台詞の番号、複数の台詞に振られた同じ番号（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "voice-unlocked",
      "voice-lock-duplicate"
    ]
  },
  "voice-unlocked": {
    "severity": "警告、エラー",
    "summary": "ボイスの番号の固定の誤り。番号が決まっていない台詞（再生されない）、今のシナリオに無い台詞の番号、複数の台詞に振られた同じ番号（10 章）",
    "section": "9. 構文チェック / 確かめること / 素材とプロジェクトの設定",
    "related": [
      "voice-lock-outdated",
      "voice-lock-duplicate"
    ]
  },
  "with-without-content": {
    "severity": "警告",
    "summary": "`@content` の無いマクロを `@with` で呼んだ（8 章）",
    "section": "9. 構文チェック / 確かめること / 構文",
    "related": []
  }
};
