# Liminalia SDK

**日本語** | [English](README.en.md)

[Liminalia](https://liminalia.skyta.dev/) は、AI との連携も前提にした、ノベルゲームのエンジンと制作ツールです。
このリポジトリは、そのうちプラグイン開発向けのパッケージと VS Code 拡張機能のソースコードを公開したものです。
制作アプリ（Liminalia Studio）、ブラウザ向けの描画部分、`lim` コマンドは含みません。

| パス | パッケージ | 概要 |
|---|---|---|
| `packages/sdk` | `@liminalia/sdk` | プラグインを書くための SDK（コマンド定義、状態、データの宣言）。MIT ライセンス |
| `packages/lang` | `@liminalia/lang` | `.lim` の構文解析、式、コマンドレジストリ、静的検査 |
| `packages/runtime` | `@liminalia/runtime` | シナリオ実行エンジン（描画・音声・入力は `Host` として差し込み。画面なしの `HeadlessHost` 付き） |
| `packages/project` | `@liminalia/project` | `liminalia.json` の読み込みとプラグインの解決 |
| `packages/std` | `@liminalia/std` | 標準コマンドの仕様（描画部分は含まない） |
| `packages/screens` | `@liminalia/screens` | 標準システム画面のテンプレート、ルール、既定の文言 |
| `packages/editor` | `@liminalia/editor` | Liminalia Studio と VS Code 拡張機能が共有する、UI を持たない共通部品 |
| `packages/vscode` | Liminalia（VS Code 拡張機能） | シンタックスハイライト、補完、構文チェック、名前の変更、ここからテストプレイなど |

## プラグインを書く

```sh
npm install --save-dev @liminalia/sdk
```

```ts
import { defineCommandPlugin, t } from "@liminalia/sdk";
```

手順は [はじめてのコマンドを作る](https://liminalia.skyta.dev/howto/plugin-command/)、詳しい仕様は [プラグインの書き方](https://liminalia.skyta.dev/docs/plugins/) を参照してください。
プラグインの実行時には Liminalia Studio や `lim` に同梱されたパッケージが使われるため、npm パッケージはエディターの補完・型チェック・テスト用に `devDependencies` へ入れます。

## このリポジトリでの動作確認

```sh
npm install
npm run typecheck
npm test
```

## ライセンス

- `packages/sdk` は MIT ライセンスです（[packages/sdk/LICENSE](packages/sdk/LICENSE)）。
- それ以外のファイルは [Liminalia のライセンスと利用条件](https://liminalia.skyta.dev/license/) に従います（要点は [LICENSE](LICENSE)）。ソースコードは閲覧できますが、オープンソースではありません。Liminalia のプラグインや拡張機能、関連ツールの開発のために利用できます。

## 不具合の報告と修正の提案

Issue やプルリクエストを受け付けています。このリポジトリは非公開リポジトリからの公開ミラーのため、いただいた修正は正本に取り込んだうえで、次回の同期時に反映します。

---

バージョン 0.8.1（正本 `d61b57bb`）。このリポジトリの内容は正本リポジトリの `scripts/public-mirror.mjs` により生成されています。
