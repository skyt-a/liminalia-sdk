import { assignAutoSlots, AUTO_POSITION, castPositionCheck, autoLayoutKeepsSlots, autoLayoutName, autoLayoutPosition, autoLayoutPositionNames, autoLayoutSlots, castSides, CORE_COMMANDS, FRAME_POSITIONS, layoutPercent, shownPositions, spriteProblem, type CommandSpec } from "@liminalia/lang";
import { clearChatMessages } from "./chat.ts";
import { PLAY_HANDLERS } from "./commands-play.ts";
import type { Args, CommandContext, CommandImpl } from "./runtime.ts";
import type { Value } from "./value.ts";
import { filterArg, type Balloon, type SoundOptions, type Sprite } from "./state.ts";

/**
 * 組み込み命令の実装。どれも「状態を更新してから描画側に知らせる」だけで、
 * 見た目の処理は描画側（Host.present）が状態と引数から行う。
 */

const s = (v: unknown) => String(v ?? "");
const n = (v: unknown) => Number(v ?? 0);
const b = (v: unknown) => v === true;

/** 消す立ち絵の差分を、顔ウィンドウの表情に引き継ぐ。 */
function keepFace(ctx: CommandContext, who: string): void {
  const sprite = ctx.state.stage.sprites[who];
  if (sprite) (ctx.state.stage.faces ??= {})[who] = { appearance: sprite.appearance, variant: sprite.variant };
}

/** 今の背景の色調（@bg・@scene-change の tone=）。書かなければ外す（描画側が ui.backgroundTones から引く）。 */
/** 規則の人数ごとの位置（autoLayout の positions）で、自動配置の人物が今いる立ち位置の名前（割合と等分の位置は除く）。 */
function ruledPositions(ctx: CommandContext): Map<string, string> {
  const rules = ctx.runtime.autoLayout;
  const out = new Map<string, string>();
  if (!rules?.positions) return out;
  for (const [who, slot] of autoLayoutSlots(Object.entries(ctx.state.stage.sprites), { rules, side: castSides(ctx.runtime.cast) })) {
    const position = autoLayoutPosition(slot, rules);
    if (position !== AUTO_POSITION && layoutPercent(position) === null) out.set(who, position);
  }
  return out;
}

/**
 * 出し入れで並びが変わり、規則の立ち位置へ動いた自動配置の人物（except は除く。本人は @chara が別に確かめる）について、
 * その立ち位置の名前が本人の立ち絵の枠にあるかを確かめる（無ければ中央に重なる）。before は出し入れの前の ruledPositions。
 */
function reportMovedPositions(ctx: CommandContext, before: ReadonlyMap<string, string>, except?: string): void {
  const cast = ctx.runtime.cast;
  if (!cast) return;
  for (const [who, at] of ruledPositions(ctx)) {
    if (who === except || before.get(who) === at) continue;
    const sprite = ctx.state.stage.sprites[who]!;
    if (sprite.x !== undefined || sprite.y !== undefined) continue;
    const problem = spriteProblem(cast, who, sprite.appearance, sprite.variant, at);
    if (problem?.code === "unknown-position") ctx.runtime.report("error", problem.code, problem.message);
  }
}

function setBackgroundTone(ctx: CommandContext, tone: Value | undefined): void {
  const stage = ctx.state.stage;
  if (tone !== undefined && stage.background) stage.backgroundTone = { image: stage.background, tone: s(tone) };
  else delete stage.backgroundTone;
}

/**
 * 枠を隠して次の本文で出し直す命令（hide-window）。出し直すときに前の本文を見せないので、NVL で積んだ段落とクリック待ちなしの本文も捨てる
 * （@window hide と同じ。次の本文は新しいページから積む）。
 */
function dropPageText(ctx: CommandContext): void {
  delete ctx.state.stage.nvlPages;
  delete ctx.state.stage.noclickPage;
}

const handlers: Record<string, (args: Args, ctx: CommandContext) => unknown> = {
  bg: (a, ctx) => {
    // 単色の背景（color=）は色のままセーブに残す
    if (typeof a.color === "string") {
      ctx.state.stage.background = null;
      ctx.state.stage.backgroundColor = a.color;
    } else {
      ctx.state.stage.background = s(a.image);
      delete ctx.state.stage.backgroundColor;
    }
    setBackgroundTone(ctx, a.tone);
    // 奥行きの絵は前の背景のもの
    delete ctx.state.stage.planes;
    if (a["hide-window"] === true) dropPageText(ctx);
    return ctx.present(a, b(a.wait));
  },
  plane: (a, ctx) => {
    const planes = { ...(ctx.state.stage.planes ?? {}) };
    planes[s(a.name)] = { image: s(a.image), depth: n(a.depth), ...(b(a.front) ? { front: true } : {}) };
    ctx.state.stage.planes = planes;
    return ctx.present(a, b(a.wait));
  },
  "plane-hide": (a, ctx) => {
    const planes = { ...(ctx.state.stage.planes ?? {}) };
    if (a.name === undefined) for (const k of Object.keys(planes)) delete planes[k];
    else delete planes[s(a.name)];
    if (Object.keys(planes).length > 0) ctx.state.stage.planes = planes;
    else delete ctx.state.stage.planes;
    return ctx.present(a, b(a.wait));
  },
  chara: (a, ctx) => {
    const sprites = ctx.state.stage.sprites;
    const who = s(a.who);
    const before = ruledPositions(ctx);
    let replacing: string | undefined;
    if (a.replace !== undefined) {
      if (a.at !== undefined || a.x !== undefined || a.y !== undefined || a.clear !== undefined || b(a.solo)) {
        ctx.runtime.report("error", "chara-replace-conflict", "replace と at・x・y・clear・solo は同時に指定できません");
        return;
      }
      const target = s(a.replace);
      const layout = { rules: ctx.runtime.autoLayout, side: castSides(ctx.runtime.cast) };
      const slots = autoLayoutSlots(Object.entries(sprites), layout);
      // left、center、right と規則の立ち位置の名前は、同じ名前の人物がいても立ち位置。ほかは表示中の人物の名前でなければ立ち位置の名前で、
      // 書いた立ち位置（立ち絵の枠の positions の名前も）のほか、人数で読み替えたあとの名前（autoLayout の byCount。制作画面の
      // シーンの情報が出す名前）でも選べる
      const positions: readonly string[] = [...FRAME_POSITIONS, ...autoLayoutPositionNames(layout.rules)];
      // 描画と同じく、差分の枠に読み替え先がある人物だけを読み替える（キャストを持たない流しでは、どの枠にもあるとする）
      const shown = shownPositions(Object.entries(sprites), layout, castPositionCheck(sprites, ctx.runtime.cast));
      const candidates = positions.includes(target) || !Object.hasOwn(sprites, target)
        ? Object.entries(sprites).filter(([name, sprite]) => {
          const slot = slots.get(name);
          if (slot) return autoLayoutName(slot, layout.rules) === target;
          return sprite.x === undefined && sprite.y === undefined && (sprite.at === target || shown.get(name) === target);
        }).map(([name]) => name)
        : [target];
      if (candidates.length !== 1 || candidates[0] === who || Object.hasOwn(sprites, who)) {
        ctx.runtime.report("error", "chara-replace-target", candidates.length === 0 ? `入れ替え先 ${target} は表示されていません` : candidates.length > 1 ? `入れ替え先 ${target} に複数の人物がいます` : `${who} はすでに表示されています`);
        return;
      }
      replacing = candidates[0]!;
    }
    // 全消しの直後と同じく、本人の以前の設定も引き継がない。
    if (a.clear !== undefined) {
      for (const other of Object.keys(sprites)) {
        keepFace(ctx, other);
        delete sprites[other];
      }
    }
    const current = sprites[who];
    // 表示中なら何もしない（描画側にも知らせない）。
    if (b(a["if-hidden"]) && current) return;
    // 出ている人物は、書かなかったものを今のまま保つ（位置は at・x・y のどれも書かなかったとき）。出ていなければ既定
    // （差分 "" は基準の差分、立ち絵セット "" はキャストの既定。描画側が選ぶ）
    const placed = a.at !== undefined || a.x !== undefined || a.y !== undefined;
    const sprite: Sprite = {
      variant: a.variant !== undefined ? s(a.variant) : (current?.variant ?? ""),
      appearance: a.appearance !== undefined ? s(a.appearance) : (current?.appearance ?? ""),
      at: a.at !== undefined ? s(a.at) : placed ? "center" : (current?.at ?? "center"),
      flip: a.flip !== undefined ? b(a.flip) : (current?.flip ?? false),
    };
    if (replacing) {
      const previous = sprites[replacing]!;
      sprite.at = previous.at;
      if (previous.autoLayout) sprite.autoLayout = true;
      if (previous.autoSlot) sprite.autoSlot = { ...previous.autoSlot };
      if (previous.x !== undefined) sprite.x = previous.x;
      if (previous.y !== undefined) sprite.y = previous.y;
    }
    if (!replacing && !placed && (current?.autoLayout === true || (!current && b(a["auto-layout"])))) sprite.autoLayout = true;
    if (sprite.autoLayout && current?.autoSlot) sprite.autoSlot = { ...current.autoSlot };
    const x = placed ? a.x : current?.x;
    const y = placed ? a.y : current?.y;
    if (x !== undefined) sprite.x = n(x);
    if (y !== undefined) sprite.y = n(y);
    const width = a.width ?? current?.width;
    const height = a.height ?? current?.height;
    if (width !== undefined) sprite.width = n(width);
    if (height !== undefined) sprite.height = n(height);
    // 重なり順（z）。0 は書かない
    const z = a.z !== undefined ? n(a.z) : (current?.z ?? 0);
    if (z !== 0) sprite.z = z;
    // 立ち絵に付いたプラグインの状態（漫符など）は、差し替えても残す
    if (current?.extra) sprite.extra = current.extra;
    // solo: ほかの人物を消す（描画側は消えた人物を同じ時間で消す）
    if (b(a.solo)) {
      for (const other of Object.keys(sprites)) {
        if (other === who) continue;
        keepFace(ctx, other);
        delete sprites[other];
      }
    }
    // 表示中の立ち絵の差し替えは、出した順（同じ重なり順のときの前後）を変えない。
    if (replacing) {
      keepFace(ctx, replacing);
      const ordered = Object.entries(sprites).map(([name, value]) => name === replacing ? [who, sprite] as const : [name, value] as const);
      for (const name of Object.keys(sprites)) delete sprites[name];
      for (const [name, value] of ordered) sprites[name] = value;
    } else sprites[who] = sprite;
    // 新しく自動配置に入った人物を並びに入れ、全員の枠を決めて残す（入れる場所、退場しても動かさない並べ方、人物ごとの定位置を使う作品だけ）
    if (!current && !replacing && sprite.autoLayout && autoLayoutKeepsSlots({ rules: ctx.runtime.autoLayout }, ctx.runtime.cast)) {
      const slots = assignAutoSlots(Object.entries(sprites), who, { rules: ctx.runtime.autoLayout, side: castSides(ctx.runtime.cast) });
      for (const [name, slot] of slots) {
        const value = sprites[name];
        if (value) sprites[name] = { ...value, autoSlot: slot };
      }
    }
    // 検査と同じ誤りを、実行時にも黙らずに知らせる（描画は既定・center に落として続ける）
    const cast = ctx.runtime.cast;
    // 自動配置の人物は、規則で決まった立ち位置の名前が本人の枠にあるかも確かめる（無ければ中央に重なる）
    const slot = sprite.autoLayout && ctx.runtime.autoLayout?.positions ? autoLayoutSlots(Object.entries(sprites), { rules: ctx.runtime.autoLayout, side: castSides(cast) }).get(who) : undefined;
    const ruled = slot ? autoLayoutPosition(slot, ctx.runtime.autoLayout) : "";
    const at = ruled !== "" && ruled !== AUTO_POSITION && layoutPercent(ruled) === null ? ruled : sprite.at;
    const problem = cast ? spriteProblem(cast, who, sprite.appearance, sprite.variant, sprite.x !== undefined || sprite.y !== undefined ? "" : at) : null;
    if (problem) ctx.runtime.report("error", problem.code, problem.message);
    // 並べ直しで動いたほかの人物も、規則の立ち位置が本人の枠にあるかを確かめる
    reportMovedPositions(ctx, before, who);
    return ctx.present(replacing ? { ...a, "replace-who": replacing } : a, b(a.wait));
  },
  "chara-config": (a, ctx) => {
    const c = { ...(ctx.state.stage.spriteConfig ?? {}) };
    if (a.focus !== undefined) c.focus = s(a.focus) as NonNullable<typeof c.focus>;
    if (a.dim !== undefined) c.dim = n(a.dim);
    if (a.lower !== undefined) c.lower = n(a.lower);
    if (a.jump !== undefined) c.jump = b(a.jump);
    if (a["move-time"] !== undefined) c.moveTime = n(a["move-time"]);
    if (a.easing !== undefined) c.easing = s(a.easing);
    ctx.state.stage.spriteConfig = c;
    return ctx.present(a, false);
  },
  dof: (a, ctx) => {
    const on = a.who !== undefined ? "chara" : s(a.on);
    if (on === "none") delete ctx.state.stage.dof;
    else ctx.state.stage.dof = { on: on as "background" | "sprites" | "chara", ...(a.who !== undefined ? { who: s(a.who) } : {}), blur: n(a.blur) };
    return ctx.present(a, b(a.wait));
  },
  tone: (a, ctx) => {
    const key = a.who === undefined ? "" : s(a.who);
    const name = s(a.tone);
    const tones = { ...(ctx.state.stage.tones ?? {}) };
    // すべての立ち絵を替えるときは、人物ごとの色調も外す
    if (key === "") for (const k of Object.keys(tones)) delete tones[k];
    if (name === "none") delete tones[key];
    else tones[key] = name;
    if (Object.keys(tones).length > 0) ctx.state.stage.tones = tones;
    else delete ctx.state.stage.tones;
    return ctx.present(a, b(a.wait));
  },
  "text-sound": (a, ctx) => {
    (ctx.state.stage.textSound ??= {})[a.who === undefined ? "" : s(a.who)] = { file: s(a.file), volume: n(a.volume), every: Math.max(1, n(a.every)) };
    return ctx.present(a, false);
  },
  "text-sound-off": (a, ctx) => {
    if (a.who === undefined) delete ctx.state.stage.textSound;
    else delete ctx.state.stage.textSound?.[s(a.who)];
    return ctx.present(a, false);
  },
  balloon: (a, ctx) => {
    if (a.mode !== "on") ctx.state.stage.balloon = null;
    else {
      const b: Balloon = {};
      if (a.width !== undefined) b.width = n(a.width);
      if (a.x !== undefined) b.x = n(a.x);
      if (a.y !== undefined) b.y = n(a.y);
      if (a.tail !== undefined && a.tail !== "auto") b.tail = s(a.tail) as NonNullable<Balloon["tail"]>;
      if (a["tail-x"] !== undefined) b.tailX = n(a["tail-x"]);
      ctx.state.stage.balloon = b;
    }
    return ctx.present(a, false);
  },
  "chara-hide": (a, ctx) => {
    const before = ruledPositions(ctx);
    keepFace(ctx, s(a.who));
    delete ctx.state.stage.sprites[s(a.who)];
    reportMovedPositions(ctx, before);
    return ctx.present(a, b(a.wait));
  },
  "chara-hide-all": (a, ctx) => {
    for (const who of Object.keys(ctx.state.stage.sprites)) keepFace(ctx, who);
    ctx.state.stage.sprites = {};
    return ctx.present(a, b(a.wait));
  },
  face: (a, ctx) => {
    (ctx.state.stage.faces ??= {})[s(a.who)] = { appearance: s(a.appearance), variant: s(a.variant) };
    ctx.state.stage.faceShown = { who: s(a.who), appearance: s(a.appearance), variant: s(a.variant) };
    return ctx.present(a, false);
  },
  "face-off": (a, ctx) => {
    delete ctx.state.stage.faceShown;
    return ctx.present(a, false);
  },
  "window-image": (a, ctx) => {
    if (a.image === undefined) delete ctx.state.stage.windowImage;
    else ctx.state.stage.windowImage = s(a.image);
    return ctx.present(a, false);
  },
  bgm: (a, ctx) => {
    ctx.state.stage.bgm = { file: s(a.file), volume: n(a.volume), loop: b(a.loop), ...soundOptions(a) };
    // 一度鳴らした BGM（おまけの音楽で聞けるようにする）
    ((ctx.runtime.system.bgm_heard ??= {}) as Record<string, true>)[s(a.file)] = true;
    return ctx.present(a, false);
  },
  "stop-bgm": (a, ctx) => {
    ctx.state.stage.bgm = null;
    return ctx.present(a, false);
  },
  se: (a, ctx) => {
    const channel = s(a.channel);
    if (b(a.loop)) ctx.state.stage.loopingSe[channel] = { file: s(a.file), volume: n(a.volume), ...soundOptions(a) };
    else delete ctx.state.stage.loopingSe[channel];
    return ctx.present(a, false);
  },
  "stop-se": (a, ctx) => {
    delete ctx.state.stage.loopingSe[s(a.channel)];
    return ctx.present(a, false);
  },
  wait: (a, ctx) => ctx.present(a, true),
  mask: (a, ctx) => {
    ctx.state.stage.mask = s(a.color);
    if (a["hide-window"] !== false) {
      dropPageText(ctx);
      ctx.state.stage.windowSuppressed = true;
    }
    return ctx.present(a, true);
  },
  "mask-off": (a, ctx) => {
    ctx.state.stage.mask = null;
    return ctx.present(a, true);
  },
  "scene-change": (a, ctx) => {
    // 明転し終えたあとの様子にしてから、描画側に暗転→切り替え→明転をさせる。
    const stage = ctx.state.stage;
    if (a["hide-chara"] !== false) {
      if (a["hide-who"] !== undefined) {
        const who = s(a["hide-who"]);
        const before = ruledPositions(ctx);
        keepFace(ctx, who);
        delete stage.sprites[who];
        reportMovedPositions(ctx, before);
      } else {
        for (const who of Object.keys(stage.sprites)) keepFace(ctx, who);
        stage.sprites = {};
      }
    }
    if (a.image !== undefined) {
      stage.background = s(a.image);
      delete stage.backgroundColor;
      delete stage.planes;
    } else if (typeof a["bg-color"] === "string") {
      stage.background = null;
      stage.backgroundColor = a["bg-color"];
      delete stage.planes;
    }
    if (a.image !== undefined || a.tone !== undefined) setBackgroundTone(ctx, a.tone);
    stage.mask = null;
    if (a["hide-window"] !== false) {
      dropPageText(ctx);
      stage.windowSuppressed = true;
    }
    // 暗転の後ろで BGM を止める・替える（bgm を書けば stop-bgm は要らない）
    if (a.bgm !== undefined) {
      stage.bgm = { file: s(a.bgm), volume: n(a["bgm-volume"] ?? 100), loop: true };
      ((ctx.runtime.system.bgm_heard ??= {}) as Record<string, true>)[s(a.bgm)] = true;
    } else if (a["stop-bgm"] === true) stage.bgm = null;
    // 暗転と明転の時間は、省けば time（描画側には決まった値を渡す）
    return ctx.present({ ...a, "fade-out": a["fade-out"] ?? a.time ?? 0, "fade-in": a["fade-in"] ?? a.time ?? 0, "hide-chara-at": a["hide-at"] ?? a["hide-chara-at"] ?? "covered" }, true);
  },
  quake: (a, ctx) => ctx.present(a, b(a.wait)),
  camera: (a, ctx) => {
    // 行って戻る（yoyo）は状態を変えない（描画側が書いた姿まで動かして戻す）
    if (a.yoyo === true) return ctx.present(a, b(a.wait));
    const c = ctx.state.stage.camera;
    if (a.zoom !== undefined) c.zoom = n(a.zoom);
    if (a.x !== undefined) c.x = n(a.x);
    if (a.y !== undefined) c.y = n(a.y);
    if (a.rotate !== undefined) c.rotate = n(a.rotate);
    return ctx.present(a, b(a.wait));
  },
  "reset-camera": (a, ctx) => {
    ctx.state.stage.camera = { zoom: 1, x: 0, y: 0, rotate: 0 };
    return ctx.present(a, b(a.wait));
  },
  window: (a, ctx) => {
    ctx.state.stage.window = a.mode === "show";
    delete ctx.state.stage.windowSuppressed;
    if (a.mode === "show") delete ctx.state.stage.windowHidden;
    else {
      ctx.state.stage.windowHidden = true;
      delete ctx.state.stage.nvlPages; // 枠を消すと本文も消える
      delete ctx.state.stage.noclickPage;
    }
    return ctx.present(a, true);
  },
  nvl: (a, ctx) => {
    ctx.state.stage.nvl = a.mode === "on";
    // 見た目の名前（ui.nvlStyles）。書かなければ ui.nvl の見た目に戻す
    if (a.mode === "on" && typeof a.style === "string" && a.style !== "") ctx.state.stage.nvlStyle = a.style;
    else delete ctx.state.stage.nvlStyle;
    delete ctx.state.stage.nvlPages;
    delete ctx.state.stage.noclickPage;
    return ctx.present(a, false);
  },
  vertical: (a, ctx) => {
    ctx.state.stage.vertical = a.mode === "on";
    delete ctx.state.stage.nvlPages;
    delete ctx.state.stage.noclickPage;
    return ctx.present(a, false);
  },
  name: (a, ctx) => {
    ctx.state.stage.names = { ...(ctx.state.stage.names ?? {}), [s(a.who)]: s(a.as) };
    return ctx.present(a, false);
  },
  "name-off": (a, ctx) => {
    const names = { ...(ctx.state.stage.names ?? {}) };
    if (a.who === undefined) for (const k of Object.keys(names)) delete names[k];
    else delete names[s(a.who)];
    if (Object.keys(names).length > 0) ctx.state.stage.names = names;
    else delete ctx.state.stage.names;
    return ctx.present(a, false);
  },
  clear: (a, ctx) => {
    delete ctx.state.stage.nvlPages;
    delete ctx.state.stage.noclickPage;
    // 吹き出しの列も NVL の段落と同じに消す（@chat-open だけを使う作品の吹き出しは @clear で消えない）
    if (ctx.runtime.chatDialogue) clearChatMessages(ctx.state.stage.extra);
    return ctx.present(a, false);
  },
  "text-speed": (a, ctx) => {
    ctx.state.stage.textSpeed = n(a["per-char"]);
    return ctx.present(a, false);
  },
  "text-speed-reset": (a, ctx) => {
    ctx.state.stage.textSpeed = null;
    return ctx.present(a, false);
  },
  "cg-unlock": (a, ctx) => {
    const system = ctx.runtime.system;
    const unlocked = (system.cg_unlocked ??= {}) as Record<string, true>;
    unlocked[s(a.image)] = true;
  },
  "wait-click": async (a, ctx) => {
    await ctx.present(a, false);
    await ctx.runtime.waitClick();
  },
  stop: (_a, ctx) => ctx.runtime.stop(),
  ...PLAY_HANDLERS,
};

/**
 * 自動確認（Host.automated）で、描画側の画面を出さずに答えなしで進める組み込みの命令（CommandImpl.autoplay）。
 * 答えが無いときの動きは画面なしと同じ: @text-input は initial、@dialog は OK、@item-select は選ばない、@open-screen は開かない。
 */
const AUTOPLAY_WITHOUT_ANSWER: ReadonlySet<string> = new Set(["text-input", "dialog", "item-select", "open-screen"]);

export const CORE_IMPLEMENTATIONS: CommandImpl[] = CORE_COMMANDS.map((spec: CommandSpec) => {
  const run = handlers[spec.name];
  if (!run) throw new Error(`組み込みコマンド @${spec.name} の実装がありません`);
  return { spec, run: async (args: Args, ctx: CommandContext) => void (await run(args, ctx)), ...(AUTOPLAY_WITHOUT_ANSWER.has(spec.name) ? { autoplay: () => undefined } : {}) };
});

/** @bgm・@se の鳴らし方のパラメータ（書いたものだけ）。 */
function soundOptions(a: Record<string, Value>): SoundOptions {
  const out: SoundOptions = {};
  if (typeof a["loop-start"] === "number") out.loopStart = a["loop-start"];
  if (typeof a["loop-end"] === "number") out.loopEnd = a["loop-end"];
  if (typeof a.pan === "number" && a.pan !== 0) out.pan = a.pan;
  if (typeof a.rate === "number" && a.rate !== 1) out.rate = a.rate;
  const filter = filterArg(a);
  if (filter) out.filter = filter;
  return out;
}
