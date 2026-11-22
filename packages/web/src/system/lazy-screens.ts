/**
 * 標準の画面の型のうち、遊び始める前に読まないもの（system/standard-templates.ts が、メニュー、操作説明、結末の名前、選択肢、セーブとロード、
 * 履歴、タイトル画面、コンフィグのどれかを初めて開くときに読む）。書き出しでは別の束（engine/lazy-screens-<鍵>.js）になる。
 * ここから import するものは、始めに読む束（core）から import しないこと（すると core に入り、分けた意味が無くなる）。
 */
export { STANDARD_TEMPLATES } from "./screens/index.ts";
