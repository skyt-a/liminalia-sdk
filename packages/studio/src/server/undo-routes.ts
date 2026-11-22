/**
 * 開発サーバーの、作品を書き換える口（GET でないもの。./index.ts の switch の case）と、その書き換えを制作画面の ⌘Z でどう戻すかの一覧。
 * 口を足したら、ここにも書く（test/file-undo.test.ts が、書いていない口と、journal なのに戻して確かめていない口を落とす）。
 *
 * - journal: 返事の undo（./file-undo.ts の控え）で、素材のファイルも設定も前と同じに戻す
 * - config: 画面が liminalia.json と訳の前後を読んで覚える（client/api.ts の tracked と undoGroup）
 * - editor: 台本の書き込み。シナリオの ⌘Z（CodeMirror の履歴）と、画面が覚えた台本の前後
 * - output: 作品のファイルは変えない（書き出し、確かめ、記録、開く）
 * - none: ⌘Z では戻さない（行の後ろに理由を書く）
 */
export type UndoKind = "journal" | "config" | "editor" | "output" | "none";

export const WRITE_ROUTES: Readonly<Record<string, UndoKind>> = {
  // ---- ⌘Z で素材も設定も戻す ----
  "POST /asset": "journal",
  "POST /assets/rename": "journal",
  "POST /assets/trash": "journal",
  "POST /assets/trash-many": "journal",
  "POST /ui/theme": "journal",
  "POST /ui/css-rule": "journal",
  "PUT /ui/css": "journal",
  "POST /cast/rename": "journal",
  "POST /screens/copy": "journal",
  "POST /screens/script": "journal",
  "PUT /screens/file": "journal",
  "POST /screens/reset": "journal",
  "POST /undo/apply": "output",

  // ---- 画面が設定のファイルの前後を覚える ----
  "POST /settings": "config",
  "POST /extra": "config",
  "PUT /i18n/file": "config",
  "POST /i18n/languages": "config",
  "POST /plugins": "config",
  "POST /ui": "config",
  "POST /command-defaults": "config",
  "POST /variables/set": "config",
  "PUT /part-file": "config",

  // ---- 台本 ----
  "PUT /file": "editor",

  // ---- 作品のファイルは変えない ----
  "POST /shot": "output",
  "POST /shot/play": "output",
  "POST /profile": "output",
  "POST /search": "output",
  "POST /check": "output",
  "POST /coverage/stream": "output",
  "POST /coverage": "output",
  "POST /assets/requests": "output",
  "POST /assets/reveal": "output",
  "POST /assets/reveal-file": "output",
  "POST /files/reveal": "output",
  "POST /i18n/export": "output",
  "POST /voice-script": "output",
  "POST /script-export": "output",
  "POST /plugins/reveal": "output",
  "POST /reload": "output",
  "POST /regress": "output",

  // ---- ⌘Z では戻さない ----
  "POST /voice-lock": "none", // ボイスの番号の固定は、収録の台帳として残すもの（外すのは voice-lock.json を直す）
  "POST /stats/ignore": "none", // 表記の揺れの除外は、同じ一覧の「除外を取り消す」で戻す
  "POST /stats/unignore": "none", // 表記の揺れの除外は、同じ一覧でもう一度除外する
  "POST /check/severity": "none", // チェックの画面の「この種類を出さない」は、その画面の設定から外す
  "POST /scenes": "none", // シーンの情報は、同じ欄でいつでも書き直せる
  "PUT /data": "none", // 作品のデータの欄は、変更履歴（.liminalia/history/@data）から戻す
  "POST /assets/restore": "none", // ごみ箱から戻すこと自体が元に戻す操作
  "POST /assets/folder": "none", // 空のフォルダを作るだけ（ごみ箱へ入れれば消える）
  "POST /assets/samples": "none", // サンプル素材は、素材の画面でまとめてごみ箱へ入れられる
  "POST /files/create": "none", // シナリオのファイルは、シーンの一覧でごみ箱へ入れられる
  "POST /files/duplicate": "none", // シナリオのファイルは、シーンの一覧でごみ箱へ入れられる
  "POST /files/rename": "none", // シナリオの名前は、同じ操作で戻せる（参照も書き換える）
  "POST /labels/rename": "none", // シーンの名前は、同じ操作で戻せる（参照も書き換える）
  "POST /scenes/move": "none", // シーンの移動は、同じ操作で戻せる
  "POST /files/trash": "none", // ごみ箱から戻す
  "POST /i18n/import": "none", // 訳の取り込みは、訳の変更履歴から戻す
  "POST /plugins/create": "none", // 作ったプラグインのフォルダは、ファイルの画面で消す
  "POST /plugins/update": "none", // プラグインの名前と説明は、同じ欄で書き直せる
  "POST /plugins/install": "none", // 入れた公式のプラグインは、プラグインの画面で外す
  "POST /ui/theme/save": "none", // 保存したテーマは、テーマの一覧でごみ箱へ入れられる
  "POST /ui/theme/trash": "none", // ごみ箱から戻す
  "POST /macros/rename": "none", // マクロの名前は、同じ操作で戻せる（参照も書き換える）
  "POST /variables/rename": "none", // 変数の名前は、同じ操作で戻せる（参照も書き換える）
  "PUT /studio-state": "none", // 制作画面だけの覚え書き（顔の切り出し、メモ）
  "POST /reviews": "none", // レビューのコメントは、その画面で消す
  "POST /reviews/import": "none", // 取り込んだ指摘は、レビューの画面で消す
};
