# Liminalia（VS Code 拡張機能）

**日本語** | [English](https://github.com/skyt-a/liminalia-sdk/blob/main/packages/vscode/README.en.md)

[Liminalia](https://liminalia.skyta.dev/) のシナリオファイル（`.lim`）を VS Code で執筆するための拡張機能です。Liminalia Studio と同じ構文チェック、補完、リファクタリング、テストプレイを普段のエディター上で使えます。Cursor や VSCodium など、VS Code 拡張機能に対応したエディターでも動作します。

## 主な機能

- **シンタックスハイライト**: ラベル（`# name`）、コマンド（`@name key=value`）、コメント（`//`）、台詞の話者（`名前「…」` / `Name "…"`）、本文内マークアップ（`{r 漢字|かんじ}`、`{br}`、`{= 式}`、`{b …}`、`{@コマンド …}`）、選択肢、式、およびテストファイル（`.limtest`）を色分けします。
- **リアルタイム構文チェック**: `lim check` と同じチェックを編集しながらリアルタイムに実行します。開いているファイルは保存前の内容で検証し、`liminalia.json`・`cast.json`・翻訳ファイル（`lang/<言語>.json`）のエラーも該当ファイル上に表示します。
- **補完・ホバー説明**:
  - `@` に続くコマンド名（`@define` マクロやプラグインコマンドを含む）、パラメータ名と型に応じた値（キャラクター、立ち絵セット、差分、立ち位置、素材ファイルなど）、ジャンプ先、行頭の話者名、`{` に続く本文内マークアップ、式の中の変数・関数を補完します。
  - コマンド・パラメータ・関数・変数・アイテム・ジャンプ先にホバーすると、要約やパラメータ一覧、定義情報を表示します。
  - `liminalia.json`・`cast.json`・`lang/*.json` に JSON Schema を適用し、キー補完や説明、未定義項目の検出を行います。
- **ナビゲーション**: 定義へ移動（`F12`）、すべての参照を検索（`⇧F12`）、アウトライン、ワークスペースシンボル検索（`⌘T`）、コードの折りたたみに対応しています。
- **整形・Quick Fix・名前の変更**:
  - 「ドキュメントのフォーマット」（`⇧⌥F`）で `lim fmt` と同じルールでコマンド行を整えます（本文は変更しません）。
  - 綴りの誤りなど修正案のある診断は Quick Fix（`⌘.`）で修正できます。
  - 名前の変更（`F2`）で、シーン（ラベル）・シナリオファイル・マクロ・変数・キャラクター・話者・素材の名前を、他ファイルの参照・`liminalia.json`・`cast.json`・翻訳キー・`voice-lock.json` まで一括で書き換えます。
- **シナリオテスト**: `tests/*.limtest` を VS Code のテストビューに一覧表示し、テスト単位またはファイル単位で実行して結果と不一致箇所を表示します。
- **ここからテストプレイ**（`⌘⌥P` / `Ctrl+Alt+P`）: カーソル行を実行する直前の状態から始まるプレイヤーをブラウザで開きます。プロジェクトを開いている Liminalia Studio（または `lim studio`）と連携します。
- **日本語・英語対応**: コマンド名、診断メッセージ、補完・ホバーの説明は VS Code の表示言語（日本語 / 英語）に合わせて切り替わります。

## 編集中の例

```lim
# morning
@bg hill_morning.webp time=1s
@chara アカリ smlie at=left
アカリ「おはよう。今日は早いね」
@choice
  - 一緒に出かける -> #walk
  - まだ寝ている -> #morning
@end
```

`@chara` で差分名を `smile` ではなく `smlie` と打ち間違えると、該当行にエラーと `smile` への修正案（Quick Fix）が表示されます。存在しないジャンプ先 `#walk` も保存前に検出されます。

## 使い方

1. VS Code の拡張機能ビューで「Liminalia」を検索してインストールします（[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=liminalia.liminalia)）。
   [リリースページ](https://github.com/skyt-a/liminalia-releases/releases/latest)の `liminalia-<バージョン>.vsix` を、コマンドパレットの「拡張機能: VSIX からのインストール…」で入れることもできます。
2. `liminalia.json` を含むプロジェクトフォルダを開き、`.lim` ファイルを開きます。

設定・`cast.json`・プラグインを更新すると自動で再読み込みされます。反映されない場合は、コマンドパレットから **「Liminalia: 言語サーバーを再起動」** を実行してください。

### 設定項目

| 設定名 | 説明 |
|---|---|
| `liminalia.studioApp` | 「ここからテストプレイ」で開く Liminalia Studio アプリのパス（空なら標準のインストール先から自動検出） |
| `liminalia.lim` | 「ここからテストプレイ」やシナリオテストで使う `lim` 実行ファイルまたは `lim.mjs` のパス（空ならプロジェクトの `node_modules/@liminalia/cli` を使用） |
| `liminalia.node` | プラグイン読み込みや `lim.mjs` 実行に使う Node.js 実行ファイルのパス（空なら VS Code 同梱の Node.js を使用） |

### ワークスペースの信頼（制限モード）

信頼していないワークスペースや、ワークスペースフォルダ外の `.lim` ファイルでは、プロジェクト内のプラグインコードやプロジェクト内の `lim` は実行されません（組み込みコマンドと標準コマンドのみでチェックします）。

## ソースからビルドする

```sh
npm install
npm run -w @liminalia/vscode build
npm run -w @liminalia/vscode package
```

生成された `packages/vscode/liminalia-<version>.vsix` は、VS Code のコマンドパレットから「拡張機能: VSIX からのインストール…」でインストールできます。

## ドキュメント

- [VS Code の拡張機能（機能紹介）](https://liminalia.skyta.dev/vscode/)
- [VS Code の拡張機能（技術資料）](https://liminalia.skyta.dev/docs/vscode/)
- [Liminalia 公式サイト](https://liminalia.skyta.dev/)

## ライセンス

この拡張機能は [Liminalia のライセンスと利用条件](https://liminalia.skyta.dev/license/) に従います。ソースコードは公開されていますが、オープンソースではありません。
