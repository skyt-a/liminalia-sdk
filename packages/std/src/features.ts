/**
 * 標準の命令の描画のうち、使う作品だけが読む部品（web/index.ts が別のファイルに分けて読む）。部品の名前 → その部品が描く命令。
 * 書き出しでは、作品が使う部品（台本の命令、プラグインが名前で描かせる命令、ui.chat.dialogue、data/codex.json。@liminalia/project の stdWebFeatures）を
 * 始めに読んでおき、ほかの部品は初めて描くときに読む（パックで足した台本など、書き出しのときに見えないもの）。
 * 部品の CSS は分けない（標準の CSS の並びのまま、始めに読む。テーマと作品の CSS が上書きする順を変えない）。
 * 命令の名前は web/<部品>.ts の renderers と同じにしておく（packages/std/test/features.test.ts が突き合わせる）。
 * DOM を使わないので、Node の道具（書き出しの組み立て）からも読める。
 */
export const STD_WEB_FEATURES = {
  chapter: ["chapter-card", "chapter-end"],
  chat: ["chat-open", "chat", "chat-chosen", "chat-close"],
  codex: ["codex-unlock", "codex"],
  effect: ["effect", "effect-off"],
  emote: ["emote", "emote-off"],
  hud: ["hud-button", "hud-button-off", "hud-text", "hud-text-off"],
  investigate: ["investigate"],
  manga: ["speedlines", "burst"],
  "map-choice": ["map-choice"],
  movie: ["movie", "bg-movie", "stop-bg-movie", "wait-bg-movie"],
  oneshot: ["flipbook", "flipbook-off", "flash", "blink", "cutin", "cutin-hide"],
  particles: ["particles", "particles-off"],
  "staff-roll": ["staff-roll"],
} as const satisfies Record<string, readonly string[]>;

export type StdWebFeature = keyof typeof STD_WEB_FEATURES;

export const STD_WEB_FEATURE_NAMES = Object.keys(STD_WEB_FEATURES) as StdWebFeature[];

/** 命令の名前 → それを描く部品（部品に分けた命令だけ）。 */
export const STD_WEB_FEATURE_OF: ReadonlyMap<string, StdWebFeature> = new Map(STD_WEB_FEATURE_NAMES.flatMap((f) => STD_WEB_FEATURES[f].map((name) => [name, f] as const)));
