import type { Args, CommandContext } from "./runtime.ts";
import { filterArg, voiceFilterFor, type StageState, type VoiceCue } from "./state.ts";
import { EvalError, type Scope } from "./value.ts";

/**
 * 遊ぶ側の仕組みに関わる組み込み命令の実装（仕様は @liminalia/lang の registry-play.ts）。
 * システム画面への要求は状態を更新して描画側に知らせるだけで、何をするかは描画側とシステム画面が決める。
 */

const s = (v: unknown) => String(v ?? "");
const n = (v: unknown) => Number(v ?? 0);
const b = (v: unknown) => v === true;

const ui = (stage: StageState) => (stage.ui ??= { menuButton: true, shortcuts: true, backlog: true });

/** チャンネルの指定がなければ、ループ再生中のすべての効果音。 */
const channels = (stage: StageState, channel: unknown) => (channel === undefined ? Object.keys(stage.loopingSe) : [s(channel)]);

const clear = (scope: Scope) => {
  for (const key of Object.keys(scope)) delete scope[key];
};

/** 持ち物の数（ゲームの変数の、式からは書けない名前のところ。@liminalia/lang の ITEMS_KEY）。 */
const items = (game: Scope): Scope => {
  const v = game["@items"];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Scope;
  return (game["@items"] = {});
};

export const PLAY_HANDLERS: Record<string, (args: Args, ctx: CommandContext) => unknown> = {
  // ---- 持ち物 ----
  "item-add": (a, ctx) => {
    const bag = items(ctx.state.game);
    const key = s(a.item);
    bag[key] = (typeof bag[key] === "number" ? (bag[key] as number) : 0) + Math.max(1, n(a.count ?? 1));
    ctx.runtime.variablesChanged("game.@items");
    return ctx.present(a, false);
  },
  "item-remove": (a, ctx) => {
    const bag = items(ctx.state.game);
    const key = s(a.item);
    const left = a.count === undefined ? 0 : (typeof bag[key] === "number" ? (bag[key] as number) : 0) - n(a.count);
    if (left > 0) bag[key] = left;
    else delete bag[key];
    ctx.runtime.variablesChanged("game.@items");
    return ctx.present(a, false);
  },
  "item-select": async (a, ctx) => {
    ctx.resumeHere();
    // 描画側は選んだ持ち物の名前（やめたら null）を返す。画面なしでは選ばなかったことにする
    const value = await ctx.present(a, true);
    ctx.runtime.setVariable(s(a.variable), typeof value === "string" ? value : "");
  },
  // ---- システム画面への要求 ----
  auto: (a, ctx) => ctx.present(a, false),
  skip: (a, ctx) => ctx.present(a, false),
  // セーブ画面で保存したら、この命令の次から再開する（開き直さない）。
  "open-screen": (a, ctx) => ctx.present(a, true),
  "menu-button": (a, ctx) => {
    ui(ctx.state.stage).menuButton = a.mode === "show";
    return ctx.present(a, false);
  },
  shortcuts: (a, ctx) => {
    ui(ctx.state.stage).shortcuts = a.mode === "on";
    return ctx.present(a, false);
  },
  config: (a, ctx) => ctx.present(a, false),
  fullscreen: (a, ctx) => ctx.present(a, false),
  quit: (a, ctx) => ctx.present(a, true),
  // システム画面に知らせてから、このプレイを終える（システム画面がタイトルへ戻す）
  "title-screen": async (a, ctx) => {
    await ctx.present(a, false);
    ctx.runtime.stop();
  },
  "window-title": (a, ctx) => ctx.present(a, false),
  presence: (a, ctx) => ctx.present(a, false),
  "open-url": (a, ctx) => ctx.present(a, false),
  autosave: (a, ctx) => ctx.present(a, true),
  autoload: (a, ctx) => ctx.present(a, true),
  backlog: (a, ctx) => {
    ui(ctx.state.stage).backlog = a.mode === "on";
    return ctx.present(a, false);
  },
  "backlog-add": (a, ctx) => ctx.present(a, false),
  // 読み上げのときだけの文（システム画面がスクリーンリーダーとテキスト読み上げに渡す）
  describe: (a, ctx) => ctx.present(a, false),

  // ---- 音 ----
  "pause-bgm": (a, ctx) => {
    if (ctx.state.stage.bgm) ctx.state.stage.bgm.paused = true;
    return ctx.present(a, false);
  },
  "resume-bgm": (a, ctx) => {
    if (ctx.state.stage.bgm) delete ctx.state.stage.bgm.paused;
    return ctx.present(a, false);
  },
  "pause-se": (a, ctx) => {
    for (const c of channels(ctx.state.stage, a.channel)) {
      const se = ctx.state.stage.loopingSe[c];
      if (se) se.paused = true;
    }
    return ctx.present(a, false);
  },
  "resume-se": (a, ctx) => {
    for (const c of channels(ctx.state.stage, a.channel)) delete ctx.state.stage.loopingSe[c]?.paused;
    return ctx.present(a, false);
  },
  "bgm-volume": (a, ctx) => {
    if (ctx.state.stage.bgm) ctx.state.stage.bgm.volume = n(a.volume);
    return ctx.present(a, false);
  },
  "se-volume": (a, ctx) => {
    for (const c of channels(ctx.state.stage, a.channel)) {
      const se = ctx.state.stage.loopingSe[c];
      if (se) se.volume = n(a.volume);
    }
    return ctx.present(a, false);
  },
  "wait-bgm": (a, ctx) => ctx.present(a, true),
  "wait-se": (a, ctx) => ctx.present(a, true),

  // ---- ボイス ----
  voice: (a, ctx) => {
    const cue: VoiceCue = {
      file: s(a.file),
      volume: n(a.volume),
      folder: s(a.folder),
      ...(typeof a.caption === "string" && a.caption !== "" ? { caption: a.caption } : {}),
      ...(typeof a.channel === "number" && a.channel !== 1 ? { channel: a.channel } : {}),
      ...(typeof a.who === "string" && a.who !== "" ? { who: a.who } : {}),
      // filter=none は、@voice-filter で掛け続けているフィルターもこのボイスには掛けない
      ...(typeof a.filter === "string" ? { filter: filterArg(a) } : {}),
    };
    // 本文の中なら、そのページのボイスとして今鳴らす（フィルターは書いたもの、無ければ @voice-filter のもの）
    if (ctx.runtime.speaking) {
      const who = cue.who ?? ctx.runtime.speakerNow ?? null;
      const filter = cue.filter !== undefined ? cue.filter : voiceFilterFor(ctx.state.stage, who);
      return ctx.present({ ...a, ...(filter ? { filter: filter.type, "filter-strength": filter.strength } : { filter: "none" }) }, false);
    }
    // 本文の外なら、次の台詞で鳴らす。話者やチャンネルの違う @voice は同時に鳴らし（channel が重なれば鳴らすときに空きへ回す）、
    // 同じ話者とチャンネルのものは書き直す
    const voice = (ctx.state.stage.voice ??= {});
    const slots = voice.next ? [voice.next, ...(voice.next.also ?? [])] : [];
    // who を省いた @voice はその台詞の話者のもの（省いたものどうしは同じところに入れ、話者を書いたものとは別にする）
    const slot = (c: VoiceCue) => `${c.channel ?? 1} ${c.who ?? ""}`;
    const at = slots.findIndex((x) => slot(x) === slot(cue));
    if (at >= 0) slots[at] = cue;
    else slots.push(cue);
    const [main, ...also] = slots;
    voice.next = also.length > 0 ? { ...main!, also } : main!;
  },
  "voice-filter": (a, ctx) => {
    const filters = (ctx.state.stage.voiceFilter ??= {});
    const who = typeof a.who === "string" ? a.who : "";
    const filter = filterArg(a);
    if (filter) filters[who] = filter;
    else delete filters[who];
    if (Object.keys(filters).length === 0) delete ctx.state.stage.voiceFilter;
    // 鳴っているボイスにも掛ける（描画側）
    return ctx.present(a, false);
  },
  "voice-auto": (a, ctx) => {
    const auto = ((ctx.state.stage.voice ??= {}).auto ??= {});
    if (a.pattern !== undefined) {
      // 設定する
      if (a.who === undefined) throw new EvalError("@voice-auto で pattern を書くときは話者も書きます");
      auto[s(a.who)] = { pattern: s(a.pattern), next: a.next === undefined ? 1 : n(a.next), volume: n(a.volume), folder: s(a.folder), ...(b(a.start) ? {} : { off: true }) };
      return;
    }
    // 再開する（番号は保つ。next を書けばその番号から）
    if (a.who !== undefined && !auto[s(a.who)]) throw new EvalError(`@voice-auto ${s(a.who)} の設定がありません（pattern を書いて設定します）`);
    for (const t of a.who === undefined ? Object.values(auto) : [auto[s(a.who)]!]) {
      delete t.off;
      if (a.next !== undefined) t.next = n(a.next);
    }
  },
  "voice-auto-off": (a, ctx) => {
    const auto = ctx.state.stage.voice?.auto ?? {};
    for (const t of a.who === undefined ? Object.values(auto) : [auto[s(a.who)]]) if (t) t.off = true;
  },
  "stop-voice": (a, ctx) => ctx.present(a, false),
  "wait-voice": (a, ctx) => ctx.present(a, true),

  // ---- 入力と確認の枠 ----
  "text-input": async (a, ctx) => {
    ctx.resumeHere();
    const value = await ctx.present(a, true);
    ctx.runtime.setVariable(s(a.variable), typeof value === "string" ? value : s(a.initial));
  },
  dialog: async (a, ctx) => {
    ctx.resumeHere();
    // 描画側は confirm なら true / false、input なら入力した文字（取り消しは null）を返す。画面なしでは OK を押したことにする。
    const value = await ctx.present(a, true);
    let ok = value !== false && value !== null;
    if (a.type === "input" && ok) {
      if (a.variable !== undefined) ctx.runtime.setVariable(s(a.variable), typeof value === "string" ? value : "");
    }
    if (a.type === "alert") ok = true;
    const target = ok ? a.target : a["cancel-target"];
    if (target !== undefined) await ctx.runtime.jump(s(target));
  },
  peek: (a, ctx) => ctx.present(a, true),

  // ---- 変数と実行の状態 ----
  "clear-vars": (a, ctx) => {
    const scope = s(a.scope);
    if (scope === "game" || scope === "all") clear(ctx.state.game);
    if (scope === "system" || scope === "all") clear(ctx.runtime.system);
    if (scope === "temp" || scope === "all") clear(ctx.state.temp);
    ctx.runtime.variablesChanged(...(scope === "all" ? ["game", "system", "temp"] : [scope]));
  },
  "clear-stack": (_a, ctx) => {
    ctx.state.callStack.length = 0;
  },
  "sleep-game": async (a, ctx) => {
    ctx.state.sleep = ctx.runtime.snapshot();
    await ctx.present(a, false);
    await ctx.runtime.jump(s(a.target));
  },
  "awake-game": async (a, ctx) => {
    const sleep = ctx.state.sleep;
    if (!sleep) return;
    ctx.state.sleep = null;
    await ctx.runtime.restoreSnapshot(sleep, { keepVariables: b(a["keep-variables"]), keepBgm: b(a["keep-bgm"]) });
  },
  "break-game": (_a, ctx) => {
    ctx.state.sleep = null;
  },
  checkpoint: (a, ctx) => {
    (ctx.state.checkpoints ??= {})[s(a.name)] = ctx.runtime.snapshot();
  },
  rollback: async (a, ctx) => {
    const snapshot = ctx.state.checkpoints?.[s(a.name)];
    if (!snapshot) throw new EvalError(`@checkpoint ${s(a.name)} はまだ記録されていません`);
    await ctx.runtime.restoreSnapshot(snapshot, { keepVariables: b(a["keep-variables"]), keepBgm: b(a["keep-bgm"]) });
  },
  "clear-checkpoint": (a, ctx) => {
    if (a.name === undefined) ctx.state.checkpoints = {};
    else delete ctx.state.checkpoints?.[s(a.name)];
  },
  "glossary-unlock": (a, ctx) => {
    const unlocked = (ctx.runtime.system.glossary_unlocked ??= {}) as Record<string, true>;
    unlocked[s(a.id)] = true;
  },
  "replay-unlock": (a, ctx) => {
    const unlocked = (ctx.runtime.system.replay_unlocked ??= {}) as Record<string, true>;
    unlocked[s(a.id)] = true;
  },
  "replay-end": (a, ctx) => ctx.present(a, false),
  achieve: (a, ctx) => {
    const unlocked = (ctx.runtime.system.achievements ??= {}) as Record<string, string>;
    // はじめて解放したときだけ描画側（システム画面）へ知らせる
    if (unlocked[s(a.id)]) return;
    unlocked[s(a.id)] = new Date().toISOString();
    return ctx.present(a, false);
  },
  // 数を数える実績。数をシステム変数 achievement_progress に残し、目標（extra.achievements の goal）に届いたら解除する。
  // 描画側へは id・数・目標と、このとき解除したか（unlocked）を渡す（店の実績の進み具合に送る）
  "achieve-progress": (a, ctx) => {
    const id = s(a.id);
    const progress = (ctx.runtime.system.achievement_progress ??= {}) as Record<string, number>;
    const now = typeof progress[id] === "number" ? progress[id] : 0;
    const next = Math.max(0, typeof a.set === "number" ? Math.max(now, a.set) : now + (typeof a.add === "number" ? a.add : 1));
    if (next === now) return;
    progress[id] = next;
    const goal = ctx.runtime.achievementGoals[id];
    const unlocked = (ctx.runtime.system.achievements ??= {}) as Record<string, string>;
    let reached = false;
    if (goal !== undefined && next >= goal && !unlocked[id]) {
      unlocked[id] = new Date().toISOString();
      reached = true;
    }
    return ctx.present({ id, value: next, ...(goal !== undefined ? { goal } : {}), unlocked: reached }, false);
  },
  // アップデートを確かめ、尋ね終えるまで待つ（デスクトップ版で build.update があるときだけ描画側が行う）
  "check-update": (a, ctx) => ctx.present(a, true),
  // 店の画面が閉じるまで待つ（買ったものは描画側が system.purchases に書く）
  purchase: (a, ctx) => ctx.present(a, true),
  "restore-purchases": (a, ctx) => ctx.present(a, true),
};
