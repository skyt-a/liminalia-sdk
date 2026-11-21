import { SUGGESTION_CODES } from "./suggestions.ts";

/**
 * 検査の言葉ごとに、実行時の検査（テストプレイ、全ルートテスト、lim coverage、lim trace、lim test）でも知らせるかの表。
 * 実行器は、読んだ台本一つの構文の誤りと check の結果のうち、RUNTIME_QUIET に無いものを知らせる（check.ts の runtimeDiagnostic）。
 *
 * - RUNTIME_QUIET: 実行の結果を変えない点検。書いたとおりに動き、直しても動きは同じ（前の名前の fade=、書き方の提案、約物）か、
 *   作品の整理（使われないもの、届かない行、訳の進み具合、前の書き方の ending=）。ファイルを読むたび、流すたびに同じものが重なり、
 *   実行時の誤りが埋もれるので、構文チェック（lim check、制作画面、VS Code）だけが知らせる
 * - RUNTIME_REPORTED: 誤りか、実行の結果が変わるもの（書いた行が本文になる、止まる、効かない、など）。実行時にも知らせる
 *
 * 作品全体の検査（checkProject など）だけが出す言葉は実行時には出てこないが、どちらかに入れる。
 * 新しい言葉を足したら、どちらかに足す（足し忘れは test/runtime-codes.test.ts が、英語の表 DIAGNOSTIC_CODES_EN と突き合わせて見つける）。
 */
export const RUNTIME_QUIET: ReadonlySet<string> = new Set([
  ...SUGGESTION_CODES,
  // 前の名前の fade=（args.ts が time= として読む）
  "renamed-param",
  // 約物（実行時は punctuation: false で見ない）
  "doubled-punctuation",
  "space-after-exclamation",
  "single-ellipsis",
  "bracket-mismatch",
  // 作品の整理
  "unused-define",
  "unused-label",
  "unused-speaker",
  "unused-ignore",
  "unused-translation",
  "unreachable-line",
  "untranslated",
  "outdated-translation",
  "stale-translation",
  "legacy-ending",
  "redundant-cg-unlock",
]);

/** 実行時にも知らせる言葉（RUNTIME_QUIET の説明）。 */
export const RUNTIME_REPORTED: ReadonlySet<string> = new Set([
  "all-options-conditional", "ambiguous-bool-shorthand", "aozora-ruby", "asset-case-mismatch", "asset-not-exported", "bad-after-load",
  "bad-arguments", "bad-auto-layout", "bad-cast", "bad-chapters", "bad-color", "bad-command-defaults", "bad-command-name", "bad-config",
  "bad-content", "bad-define", "bad-effect-mask", "bad-encoding", "bad-expression", "bad-extra", "bad-for", "bad-function", "bad-fx", "bad-guard",
  "bad-image", "bad-items", "bad-label", "bad-let", "bad-line-id", "bad-option", "bad-param", "bad-return", "bad-ruby", "bad-rules", "bad-scenes",
  "bad-set", "bad-set-target", "bad-size", "bad-speaker-name", "bad-speed", "bad-target", "bad-test", "bad-translation", "bad-ui", "bad-use",
  "bad-value", "bad-voice-lock", "bad-with", "branch-after-else", "call-without-return", "cast-ambiguous", "chapter-card-empty", "chapter-files",
  "chara-replace-conflict", "chara-replace-target", "chara-replace-unknown", "choice-loop", "dangling-escape", "data-bad-expr", "data-duplicate",
  "data-flag-unread", "data-flag-unset", "data-missing", "data-missing-asset", "data-type", "data-unknown-cast", "data-unknown-ref",
  "data-unknown-scene", "define-shadows-command", "draft-entry", "draft-target", "draft-use", "duplicate-define", "duplicate-function",
  "duplicate-label", "duplicate-line-id", "duplicate-param", "effect-mask-ignored", "emote-hidden", "empty-map", "empty-option", "empty-ruby",
  "engine-version", "flash-rate", "flipbook-data", "flipbook-frames", "flipbook-loop-wait", "flipbook-missing", "flipbook-off-unknown",
  "font-no-vertical-metrics", "forbidden-property", "fullwidth-symbol", "hide-name-unknown", "html-attribute-not-allowed", "html-bad-nesting",
  "html-dynamic-attribute", "html-empty", "html-empty-src", "html-event-attribute", "html-external-url", "html-inline", "html-jump-without-wait",
  "html-tag-not-allowed", "html-unclosed-tag", "html-wait-without-jump", "invisible-space", "label-in-if", "lfs-pointer", "map-spot-hidden",
  "missing-asset", "missing-expression", "missing-param", "missing-translation", "missing-value", "missing-voice", "model-plugin-missing",
  "nested-define", "nested-function", "nested-use", "newer-format", "no-choice-shown", "noclick-in-option", "noclick-not-last", "not-in-chapter",
  "not-in-extra", "option-outside-choice", "orphan-branch", "orphan-end", "plugin-api-version", "plugin-check-failed", "plugin-check-invalid",
  "plugin-engine-version", "plugin-function-clash", "plugin-load", "plugin-replaces-command", "positional-by-name", "redundant-param",
  "renamed-command", "rule-appearance-change", "rule-appearance-era", "rule-cg-with-sprites", "rule-fade-before-jump", "rule-pov-sprite", "runtime",
  "save-relocated", "save-version", "scene-change-sprite-overlap", "script-not-allowed", "script-skipped", "shadows-param", "staff-roll-empty",
  "stray-brace", "target-never-offered", "template-list-item", "template-missing", "template-missing-role", "template-outdated",
  "template-overridden", "template-script-export", "template-script-unknown", "template-unknown-part", "template-unknown-screen",
  "template-unknown-value", "template-unsafe", "theme-engine-version", "too-many-positional", "trailing-comment", "translation-lost-command",
  "tyrano-tag", "ui-css-asset", "ui-css-missing", "ui-css-outside", "ui-css-syntax", "unclosed-block", "unclosed-inline", "unclosed-paren",
  "unclosed-string", "undeclared-variable", "unexpected-argument", "uninitialized-variable", "unknown-appearance", "unknown-cast",
  "unknown-codex-entry", "unknown-command", "unknown-config-key", "unknown-data-key", "unknown-ending-kind", "unknown-file", "unknown-function",
  "unknown-inline", "unknown-investigation", "unknown-item", "unknown-label", "unknown-map", "unknown-nvl-style", "unknown-option", "unknown-param",
  "unknown-position", "unknown-screen", "unknown-speaker", "unknown-targets", "unknown-tone", "unknown-type", "unknown-variable", "unknown-variant",
  "unset-variable", "unshown-cg", "unsupported-command", "voice-lock-duplicate", "voice-lock-outdated", "voice-unlocked", "with-without-content",
]);
