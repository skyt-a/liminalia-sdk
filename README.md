# Liminalia（lim とエンジン、SDK）

**日本語** | [English](README.en.md)

[Liminalia](https://liminalia.skyta.dev/) は、AI との連携も前提にした、ノベルゲームのエンジンと制作ツールです。
このリポジトリは、そのうち `lim` コマンドとエンジン、プラグイン開発向けのパッケージ、VS Code 拡張機能のソースコードを公開したものです。
制作アプリ（Liminalia Studio）の画面は含みません。
npm に出すのは `@liminalia/sdk` と `@liminalia/cli` の二つで、ほかのエンジンの部品は `@liminalia/cli` の中に入っています。

| パス | パッケージ | 概要 |
|---|---|---|
| `packages/sdk` | `@liminalia/sdk`（npm） | プラグインとの約束（型、コマンドの定義、状態、データの宣言と、描画や制作画面の口）。MIT ライセンス |
| `packages/cli` | `@liminalia/cli`（npm） | `lim` コマンド（作成、開発サーバー、チェック、テスト、書き出し、MCP など）。下のエンジンの部品を束ねて入れ、テストの口 `@liminalia/cli/testing` を持つ |
| `packages/lang` | `@liminalia/lang` | `.lim` の構文解析、式、コマンドレジストリ、静的検査 |
| `packages/runtime` | `@liminalia/runtime` | シナリオ実行エンジン（描画・音声・入力は `Host` として差し込み。画面なしの `HeadlessHost` 付き） |
| `packages/project` | `@liminalia/project` | `liminalia.json` の読み込みとプラグインの解決 |
| `packages/plugin-host` | `@liminalia/plugin-host` | プラグインの読み込みと検査（sdk の約束の実装側） |
| `packages/std` | `@liminalia/std` | 標準コマンドの仕様と描画 |
| `packages/web` | `@liminalia/web` | ブラウザで動くゲームの描画とプレイヤー、開発サーバーの設定 |
| `packages/screens` | `@liminalia/screens` | 標準システム画面のテンプレート、ルール、既定の文言 |
| `packages/editor` | `@liminalia/editor` | Liminalia Studio と VS Code 拡張機能が共有する、UI を持たない共通部品 |
| `packages/studio` | `@liminalia/studio` | 開発サーバーの制作用の口（台本の書き込み、名前の変更など）。制作画面の画面（`src/client`）は含まない |
| `packages/ks-import` | `@liminalia/ks-import` | TyranoScript（.ks）からの取り込み |
| `packages/story-import` | `@liminalia/story-import` | Twine、Ink、Ren'Py などからの取り込み |
| `packages/vscode` | Liminalia（VS Code 拡張機能） | シンタックスハイライト、補完、構文チェック、名前の変更、ここからテストプレイなど |

## lim でゲームを作る

```sh
npm install -g @liminalia/cli
lim new my-game --title "わたしの物語"
cd my-game
lim dev        # 表示された URL をブラウザで開く
lim check      # 構文と参照のチェック
lim build      # 書き出し（ブラウザ版、デスクトップ版など）
```

Node.js 22 以上が要ります。画面写真（`lim shot`）と書き出しの確かめには Chromium も要ります（`npx playwright install chromium-headless-shell`）。
台本は VS Code の拡張機能（このリポジトリの `packages/vscode`。Marketplace で「Liminalia」）で書くと、色分け、補完、チェックが使えます。
画面で作るなら、制作アプリ [Liminalia Studio](https://liminalia.skyta.dev/download/) を使ってください。

## プラグインを書く

```sh
npm install --save-dev @liminalia/sdk
```

```ts
import { defineCommandPlugin, t } from "@liminalia/sdk";
```

手順は [はじめてのコマンドを作る](https://liminalia.skyta.dev/howto/plugin-command/)、詳しい仕様は [プラグインの書き方](https://liminalia.skyta.dev/docs/plugins/) を参照してください。
プラグインは `@liminalia/sdk` とその入口（`/std`、`/web`、`/studio`、`/studio-server`、`/import`）だけを読みます。動くときは `lim` と Liminalia Studio の実装が使われるので、sdk はエディターの補完と型の確認のために `devDependencies` へ入れます。
テストで台本を解析、検査し、画面なしで動かすなら、`@liminalia/cli` も `devDependencies` に入れ、`@liminalia/cli/testing` から読みます。

## このリポジトリでの動作確認

```sh
npm install
npm run typecheck
npm test
```

## ライセンス

- `packages/sdk` は MIT ライセンスです（[packages/sdk/LICENSE](packages/sdk/LICENSE)）。
- それ以外のファイルは [Liminalia のライセンスと利用条件](https://liminalia.skyta.dev/license/) に従います（要点は [LICENSE](LICENSE)）。ソースコードは閲覧できますが、オープンソースではありません。`lim` でゲームを作って書き出すこと、Liminalia のプラグインや拡張機能、関連ツールの開発に利用できます。作ったゲームは作った人のもので、配ることも売ることもできます。

## 不具合の報告と修正の提案

Issue やプルリクエストを受け付けています。このリポジトリは非公開リポジトリからの公開ミラーのため、いただいた修正は正本に取り込んだうえで、次回の同期時に反映します。

---

バージョン 0.9.2（正本 `ec485d19`）。このリポジトリの内容は正本リポジトリの `scripts/public-mirror.mjs` により生成されています。
