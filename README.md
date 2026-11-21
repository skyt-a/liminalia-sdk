# Liminalia SDK

[Liminalia](https://liminalia.skyta.dev/) は、AI と一緒に作ることを前提にした、ノベルゲームのエンジンと制作ツールです。
このリポジトリは、そのうちプラグインを書くための部品と、VS Code の拡張機能のソースを公開したものです。
制作アプリ（Liminalia Studio）、ブラウザの描画、lim コマンドは含みません。

| 場所 | パッケージ | 中身 |
|---|---|---|
| `packages/sdk` | `@liminalia/sdk` | プラグインを書くための部品（コマンドの表、状態、データの宣言）。MIT ライセンス |
| `packages/lang` | `@liminalia/lang` | .lim の構文解析、式、コマンドの表、検査 |
| `packages/runtime` | `@liminalia/runtime` | 実行器（描画、音、入力は Host として差し込む。画面なしの HeadlessHost つき） |
| `packages/project` | `@liminalia/project` | liminalia.json の読み込みと、プラグインの解決 |
| `packages/std` | `@liminalia/std` | 標準のコマンドの仕様（描画の部分は含まない） |
| `packages/screens` | `@liminalia/screens` | 標準のシステム画面のテンプレート、決まり、文言 |
| `packages/editor` | `@liminalia/editor` | 制作画面と VS Code の拡張機能が共有する、画面を持たない部品 |
| `packages/vscode` | `Liminalia（VS Code の拡張機能）` | 補完、検査、名前の付け替え、ここからテストプレイ |

## プラグインを書く

```sh
npm install --save-dev @liminalia/sdk
```

```ts
import { defineCommandPlugin, t } from "@liminalia/sdk";
```

手順は [プラグインでコマンドを足す](https://liminalia.skyta.dev/howto/plugin-command/)、
決まりは [プラグイン](https://liminalia.skyta.dev/docs/plugins/) にあります。
プラグインが動くときは、Studio と lim が持っている部品が使われます。npm の部品は、エディターの補完と型の確認、テストのために入れます。

## このリポジトリで確かめる

```sh
npm install
npm run typecheck
npm test
```

## ライセンス

- `packages/sdk` は MIT ライセンスです（`packages/sdk/LICENSE`）。
- ほかは「Liminalia のライセンスと利用条件」に従います（`LICENSE`、全文は https://liminalia.skyta.dev/license/ ）。
  ソースは読めますが、オープンソースではありません。プラグインや拡張機能を作るために使えます。

## 不具合の報告と修正の提案

Issues とプルリクエストを受け付けます。このリポジトリは非公開のリポジトリから写したもので、
受け取った修正は正本に取り込んでから、次の写しで反映します。

---

版 0.8.1（正本 4abf284d）。このリポジトリのファイルは `scripts/public-mirror.mjs` が作ります。
