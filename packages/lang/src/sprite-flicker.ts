import type { Argument, Diagnostic, DiagnosticFix, Script, Statement } from "./ast.ts";
import { normalizeBooleanArgs, printLiteral } from "./args.ts";
import { commandText } from "./cg.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * 立ち絵のちらつきの検査（check.ts の check が呼ぶ。どちらも警告）。
 * - chara-reshow: 立ち絵を消した直後（本文をはさまずに）に、同じ人物を出し直している。消さずに表情だけ替えればちらつかない。
 *   消した行に出し、その行を削除する（全消しなら、ほかの人物だけを消す行に替える）直し方を付ける。ただし直すと画面が変わるときは付けない:
 *   出し直しの行が立ち位置、差分、反転を省いていて、消さずに残すと前のまま残る（消してから出すと既定に戻る）とき（Look）と、
 *   消してから出し直すまでの間にほかの人物を出している（一人ずつ見せる。消す行を削除すると二人が同時に立つ）とき
 * - chara-hide-per-line: 台詞の FLICKER_CHAIN_LINES 行以内ごとに @chara-hide-all で全員を消して出し直す、を FLICKER_CHAIN 回以上続けている。
 *   同じ場にいる人物も一人しか立たず、話者が替わるたびにちらつく
 * - chara-solo（情報。書き方の提案）: 舞台に誰かいるときの @chara-hide-all のすぐ次の行で @chara を書いている。@chara … solo=true の一行にまとめる直し方
 *   （replace-lines）を付ける。一人ずつ見せる型を、まとめて solo=true に直すためのもの。まとめると画面が変わるものは知らせない:
 *   全消しに fade 以外を書いたもの、動いて入るもの、出す人物が舞台にいて、出し直しの行が省いた立ち位置や差分が前の見た目のまま残るもの、
 *   出す人物が舞台にいるか分からないもの
 *
 * 台本を上から順に読み、立ち絵の出入りを追う。ラベル、@if、@choice、@jump などで流れが分かれるところと、
 * 場面が替わる命令（背景、暗転、動画、@wait）の所で追うのをやめる（消して場面を替えてから出し直すのは自然なため）。
 * マクロ（@define）の呼び出しの中は見ない。
 */

/** 消してから出し直すまでの本文（台詞と地の文）の行の数の上限。これ以下なら「直後」とみなす（0 なので、本文を一行でもはさめば知らせない。消えて地の文に続くのは演出として自然なため）。 */
export const FLICKER_RESHOW_LINES = 0;
/** 台詞ごとの全消しとみなす、全消しと全消しのあいだの本文の行の数の上限。 */
export const FLICKER_CHAIN_LINES = 2;
/** 台詞ごとの全消しとみなす、続けて並んだ @chara-hide-all の数の下限。 */
export const FLICKER_CHAIN = 3;

/** 場面が替わる命令（背景を替える命令は、背景の素材のパラメータを持つかで見分ける）。 */
const SCENE_BREAKS: ReadonlySet<string> = new Set(["scene-change", "mask", "mask-off", "movie", "wait"]);

type CommandStatement = Extract<Statement, { kind: "command" }>;

/**
 * 立ち絵の今の見た目のうち、@chara が省くと「表示中なら今のまま、表示していなければ既定」になるもの。
 * at は立ち位置の名前（x、y で置いたものは null）、variant は差分（標準の差分は ""）、sized は大きさか重なり順を書いたか。
 */
interface Look {
  at: string | null;
  variant: string;
  flip: boolean;
  sized: boolean;
}

/** 表示していない人物を @chara で出したときの既定の見た目。 */
const FRESH: Look = { at: "center", variant: "", flip: false, sized: false };

/** 一つの消す命令で消した人物と、そのあと出し直した人物。 */
interface HideGroup {
  cmd: CommandStatement;
  /** 全消しのときに舞台にいたと分かっている人物（分からなければ null）。単独の @chara-hide は null。 */
  onStage: ReadonlySet<string> | null;
  /**
   * 出し直した人物と行。keeps は消さずに残しても出し直しと同じ画面になるか、between は消してから出し直すまでの間にほかの人物を出したか。
   */
  reshown: { who: string; line: number; keeps: boolean; between: boolean; cmd: CommandStatement; before: Look | undefined }[];
}

/** 出ていると分かっている人物の、立ち絵セット（書いていなければ null）と見た目。 */
interface Shown {
  appearance: string | null;
  look: Look;
}

interface Run {
  shown: Map<string, Shown>;
  /** 舞台にいる人物をすべて知っているか（全消しか @scene-change のあと）。 */
  complete: boolean;
  /**
   * 消した人物 → 消した命令と、そのあとの本文の行の数、消す前の立ち絵セットと見た目（分からなければ undefined）、
   * そのあとにほかの人物を出したか。
   */
  hidden: Map<string, { group: HideGroup; texts: number; appearance: string | null | undefined; look: Look | undefined; between: boolean }>;
  /** 続けて並んだ全消し（行と、前の全消しからの本文の行の数、出した人物がいるか）。 */
  chain: { cmds: CommandStatement[]; texts: number; showed: boolean } | null;
}

export function checkSpriteFlicker(script: Script, registry: Registry): Diagnostic[] {
  const out: Diagnostic[] = [];
  const groups: HideGroup[] = [];
  /** 台詞ごとの全消しとして知らせた範囲（最初と最後の @chara-hide-all の行）。中の出し直しの警告は重ねて出さない。 */
  const chained: [number, number][] = [];

  const value = (s: CommandStatement, key: string): string | null => {
    const spec: CommandSpec | undefined = registry.get(s.name);
    let pos = 0;
    for (const a of spec ? normalizeBooleanArgs(spec, s.args) : s.args) {
      const k = a.key ?? spec?.positional[pos++];
      if (k !== key) continue;
      const v = a.value;
      return v.kind === "string" ? v.value : v.kind === "bool" || v.kind === "number" ? String(v.value) : v.kind === "duration" ? v.source : null;
    }
    return spec?.params[key]?.default ?? null;
  };
  /** 背景を替える命令か（背景の素材のパラメータを持つ）。 */
  const changesBackground = (name: string): boolean => {
    const spec = registry.get(name);
    return !!spec && Object.values(spec.params).some((p) => p.type.kind === "asset" && p.type.folder === "bgimage");
  };
  /** その行に書いたパラメータか、既定値（commandDefaults）で決まっているか。 */
  const written = (s: CommandStatement, key: string): boolean => {
    const spec = registry.get(s.name);
    let pos = 0;
    return (spec ? normalizeBooleanArgs(spec, s.args) : s.args).some((a) => (a.key ?? spec?.positional[pos++]) === key) || spec?.params[key]?.default !== undefined;
  };
  /** @chara の行が決める見た目（before は表示中ならその見た目、表示していなければ既定）。 */
  const lookOf = (s: CommandStatement, before: Look): Look => {
    const at = value(s, "at");
    const placed = written(s, "x") || written(s, "y");
    const variant = value(s, "variant");
    const flip = value(s, "flip");
    return {
      at: placed ? null : (at ?? before.at),
      variant: variant ?? before.variant,
      flip: flip === null ? before.flip : flip === "true",
      sized: before.sized || written(s, "width") || written(s, "height") || written(s, "z"),
    };
  };
  const sameLook = (a: Look, b: Look) => a.at !== null && a.at === b.at && a.variant === b.variant && a.flip === b.flip && !a.sized && !b.sized;

  /** 消え方、出方に動き（fade 以外）を書いたか（わざと出入りさせている）。 */
  const moves = (s: CommandStatement, key: "enter" | "exit") => {
    const v = value(s, key);
    return v !== null && v !== "fade";
  };

  /**
   * 消さずに残しても出し直しと同じ見た目になるよう、出し直しの行に省いた立ち位置と反転を書き足した一行（書き足せなければ null）。
   * 標準の差分は名前で書けないので、前の差分が標準でなく出し直しの行が差分を省いていれば書き足せない。
   */
  const keepLine = (s: CommandStatement, before: Look | undefined): string | null => {
    if (!before || before.at === null || before.sized) return null;
    const after = lookOf(s, FRESH);
    if (after.at === null || after.sized) return null;
    if (after.variant !== before.variant && value(s, "variant") === null) return null;
    let line = commandText(s.name, s.args);
    if (after.at !== before.at && value(s, "at") === null) line += ` at=${after.at}`;
    if (after.flip !== before.flip && value(s, "flip") === null) line += ` flip=${after.flip}`;
    return line;
  };

  const fresh = (): Run => ({ shown: new Map(), complete: false, hidden: new Map(), chain: null });

  const endChain = (run: Run) => {
    const c = run.chain;
    run.chain = null;
    if (!c || c.cmds.length < FLICKER_CHAIN) return;
    const last = c.cmds.at(-1)!.line;
    chained.push([c.cmds[0]!.line, last]);
    out.push({
      severity: "warning",
      code: "chara-hide-per-line",
      message: `台詞の ${FLICKER_CHAIN_LINES} 行以内ごとに @chara-hide-all で全員を消して出し直しています（${c.cmds.length} 回、${last} 行目まで）。立ち絵がちらつき、同じ場にいる人物も一人しか立ちません`,
      file: script.file,
      line: c.cmds[0]!.line,
      hint: "同じ場にいる人物は at=left、at=right などで立たせたまま、@chara 名前 差分 で表情だけ替えます。話している人物は話者強調（liminalia.json の ui.chara.focus）で目立たせられます。一人ずつ出すなら @chara 名前 solo=true と書きます",
    });
  };

  const textLine = (run: Run) => {
    for (const [who, h] of run.hidden) if (++h.texts > FLICKER_RESHOW_LINES) run.hidden.delete(who);
    if (run.chain && ++run.chain.texts > FLICKER_CHAIN_LINES) endChain(run);
  };

  const command = (run: Run, s: CommandStatement) => {
    if (SCENE_BREAKS.has(s.name) || changesBackground(s.name)) {
      run.hidden.clear();
      endChain(run);
      if (s.name === "scene-change") {
        const hide = value(s, "hide-chara");
        if (hide !== "false") {
          if (hide !== "true") {
            run.shown.clear();
            run.complete = false;
          } else if (!written(s, "hide-who")) {
            run.shown.clear();
            run.complete = true;
          } else {
            const who = value(s, "hide-who");
            if (who === null) { run.shown.clear(); run.complete = false; }
            else run.shown.delete(who);
          }
        }
      }
      return;
    }
    if (s.name === "chara-hide-all") {
      const group: HideGroup = { cmd: s, onStage: run.complete ? new Set(run.shown.keys()) : null, reshown: [] };
      groups.push(group);
      if (!moves(s, "exit")) for (const [who, shown] of run.shown) run.hidden.set(who, { group, texts: 0, appearance: shown.appearance, look: shown.look, between: false });
      run.shown.clear();
      run.complete = true;
      // 全消しが続いているか（前の全消しから本文が FLICKER_CHAIN_LINES 行以内で、その間に誰かを出した）
      if (run.chain && run.chain.showed) run.chain = { cmds: [...run.chain.cmds, s], texts: 0, showed: false };
      else {
        endChain(run);
        run.chain = { cmds: [s], texts: 0, showed: false };
      }
      return;
    }
    if (s.name === "chara-hide") {
      const who = value(s, "who");
      if (who === null) return;
      const shown = run.shown.get(who);
      run.shown.delete(who);
      if (moves(s, "exit")) return;
      const group: HideGroup = { cmd: s, onStage: null, reshown: [] };
      groups.push(group);
      run.hidden.set(who, { group, texts: 0, appearance: shown?.appearance, look: shown?.look, between: false });
      return;
    }
    if (s.name !== "chara") return;
    const who = value(s, "who");
    if (who === null) return;
    if (written(s, "clear")) {
      run.shown.clear();
      run.hidden.clear();
      run.complete = true;
    }
    if (run.chain) run.chain.showed = true;
    // 消したほかの人物は、出し直すまでの間に新しくこの人物が出た（一人ずつ見せている。一緒に消した人物を出し直すのは数えない）
    if (!run.hidden.has(who)) for (const h of run.hidden.values()) h.between = true;
    const hidden = run.hidden.get(who);
    const appearance = value(s, "appearance");
    // 立ち絵セットを替える出し直し（衣装替えは消してから出し直す作品がある）と、動いて入る出し直しは、わざとしているものとして見ない。
    // 消す前の立ち絵セットが分からなければ、書いていないときだけ同じとみなす
    const same = hidden !== undefined && (hidden.appearance === undefined ? appearance === null : hidden.appearance === appearance);
    if (hidden && same && !moves(s, "enter")) {
      // 消してから出すと既定から、消さずに残すと前の見た目から、この行の書いたものを重ねる。同じなら残しても同じ画面
      const keeps = hidden.look !== undefined && sameLook(lookOf(s, FRESH), lookOf(s, hidden.look));
      hidden.group.reshown.push({ who, line: s.line, keeps, between: hidden.between, cmd: s, before: hidden.look });
    }
    run.hidden.delete(who);
    const before = run.shown.get(who);
    if (value(s, "solo") === "true") {
      run.shown.clear();
      run.complete = true;
      run.hidden.clear();
    }
    run.shown.set(who, { appearance: appearance ?? before?.appearance ?? null, look: lookOf(s, before?.look ?? FRESH) });
  };

  /** 全消しのすぐ次の行の @chara を、solo=true の一行にまとめられるなら知らせる（全消しの前の舞台で見る）。 */
  const soloCandidate = (run: Run, hide: CommandStatement, next: Statement | undefined, following: Statement | undefined) => {
    if (run.shown.size === 0 || !registry.get("chara")?.params.solo) return;
    if (next?.kind !== "command" || next.name !== "chara" || next.line !== hide.line + 1) return;
    // 続けて複数人を出す場面は、一人ずつ見せるための書き換えの対象にしない。
    if (following?.kind === "command" && following.name === "chara" && following.line === next.line + 1) return;
    if (moves(next, "enter") || value(next, "solo") === "true") return;
    // 全消しに書いてよいのは time だけ（ほかは消え方が変わる）
    const spec = registry.get(hide.name);
    let pos = 0;
    if ((spec ? normalizeBooleanArgs(spec, hide.args as readonly Argument[]) : (hide.args as readonly Argument[])).some((a) => (a.key ?? spec?.positional[pos++]) !== "time")) return;
    const who = value(next, "who");
    if (who === null) return;
    const before = run.shown.get(who);
    if (before) {
      // 舞台にいる人物は solo なら前の見た目から、全消しのあとは既定から出る。同じになるときだけ
      if (!sameLook(lookOf(next, FRESH), lookOf(next, before.look))) return;
      if (!sameLook(before.look, lookOf(next, before.look))) return;
      if (value(next, "appearance") === null && before.appearance !== null) return;
    } else if (!run.complete) return;
    const shown = commandText(next.name, next.args);
    const fix: DiagnosticFix = { kind: "replace-lines", lines: [commandText(hide.name, hide.args), shown], with: `${shown} solo=true` };
    out.push({
      severity: "info",
      code: "chara-solo",
      message: `全員を消してすぐ ${who} を出しています。@chara の solo=true で一行にまとめられます（ほかの人物を消してから ${who} を出します）`,
      file: script.file,
      line: hide.line,
      hint: `${shown} solo=true にして、全員を消す行を削除します`,
      fix,
      fixes: [fix],
    });
  };

  const block = (body: readonly Statement[]) => {
    let run = fresh();
    const cut = () => {
      endChain(run);
      run = fresh();
    };
    for (let i = 0; i < body.length; i++) {
      const s = body[i]!;
      switch (s.kind) {
        case "say":
        case "prose":
          textLine(run);
          break;
        case "command":
          if (s.name === "chara-hide-all") soloCandidate(run, s, body[i + 1], body[i + 2]);
          command(run, s);
          break;
        case "if":
          cut();
          for (const b of s.branches) block(b.body);
          break;
        case "define":
          cut();
          block(s.body);
          break;
        case "label":
        case "choice":
        case "jump":
        case "call":
        case "return":
        case "content":
        case "script":
          cut();
          break;
        default:
          break;
      }
    }
    endChain(run);
  };

  block(script.body);

  /** 待たずに全消しする行と直後の表示を、同じ消去時間の clear にまとめる。 */
  const clearFix = (hide: CommandStatement, next: CommandStatement): DiagnosticFix | undefined => {
    if (hide.name !== "chara-hide-all" || next.line !== hide.line + 1 || !registry.get("chara")?.params.clear) return;
    if (written(next, "clear") || value(hide, "wait") !== "false" || value(hide, "exit") !== "fade") return;
    if (value(hide, "skip") === null || value(hide, "skip") !== value(next, "skip")) return;
    const hideSpec = registry.get("chara-hide-all");
    const hideArgs = hideSpec ? normalizeBooleanArgs(hideSpec, hide.args as readonly Argument[]) : (hide.args as readonly Argument[]);
    if (hideArgs.some((a) => a.key !== "time") || hideArgs.length > 1) return;
    const given = hideArgs.find((a) => a.key === "time");
    const time = given ? printLiteral(given.value) : hideSpec?.params.time?.default;
    if (time === undefined) return;
    const shown = commandText(next.name, next.args);
    return { kind: "replace-lines", lines: [commandText(hide.name, hide.args), shown], with: `${shown} clear=${time}` };
  };

  for (const g of groups) {
    const line = g.cmd.line;
    if (g.reshown.length === 0 || chained.some(([from, to]) => line >= from && line <= to)) continue;
    const names = [...new Set(g.reshown.map((r) => r.who))];
    const who = names.join("、");
    const first = names[0]!;
    let hint: string;
    let fix: DiagnosticFix | undefined;
    const between = g.reshown.find((r) => r.between);
    const changes = g.reshown.find((r) => !r.keeps);
    const repositioned = g.reshown.find((r) => {
      if (!r.before) return true;
      const after = lookOf(r.cmd, FRESH);
      return r.before.at === null || after.at === null || r.before.at !== after.at || r.before.sized || after.sized;
    });
    const adjacent = g.reshown.find((r) => r.line === line + 1);
    const equivalent = adjacent ? clearFix(g.cmd, adjacent.cmd) : undefined;
    if (equivalent) {
      hint = "消去時間を保ったまま、全消しと表示を @chara の clear にまとめます";
      fix = equivalent;
      // 同じ二行について、演出が異なりうる solo の提案を重ねない。
      const duplicate = out.findIndex((d) => d.code === "chara-solo" && d.line === line);
      if (duplicate !== -1) out.splice(duplicate, 1);
    } else if (between) {
      // 一人ずつ見せている。消す行を削除すると、間に出した人物と一緒に立つ
      hint = `${between.who} を消してから出し直すまでの間に、ほかの人物を出しています。一人ずつ出すなら、出す行に solo=true を書いて、全員を消す行を削除します`;
    } else if (repositioned) {
      hint = `${repositioned.who} の立ち位置や大きさが変わるため、消す行を残します。消さずに残すと移動や切り替えの演出が変わります`;
    } else if (changes) {
      // 出し直しの行が省いた立ち位置、差分、反転は、消さずに残すと前のまま残る
      const single = g.reshown.length === 1 && changes.line === line + 1;
      const alone = g.cmd.name === "chara-hide" || (g.onStage !== null && [...g.onStage].every((n) => names.includes(n)));
      const kept = single && alone ? keepLine(changes.cmd, changes.before) : null;
      if (kept !== null) {
        // 消す行と出し直す行が隣り合っていれば、二行を、省いたものを書き足した出し直しの一行にまとめる
        hint = `${who} は消さずに残し、${changes.line} 行目に省いていた立ち位置を書き足して、この行を削除します（${kept}）`;
        fix = { kind: "replace-lines", lines: [commandText(g.cmd.name, g.cmd.args), commandText(changes.cmd.name, changes.cmd.args)], with: kept };
      } else {
        hint = `${who} は消さずに残し、表情は @chara ${first} 差分 で替えます。${changes.line} 行目は立ち位置か差分を省いているので、残すと前の見た目のまま替わります。先に at= と差分を書きます`;
      }
    } else if (g.cmd.name === "chara-hide") {
      hint = `消さずに残し、表情は @chara ${first} 差分 で替えます（この行を削除します）`;
      fix = { kind: "delete-line", text: commandText(g.cmd.name, g.cmd.args) };
    } else {
      const rest = g.onStage ? [...g.onStage].filter((n) => !names.includes(n)) : null;
      if (rest && rest.length === 0) {
        hint = `${who} は消さずに残し、表情は @chara ${first} 差分 で替えます（この行を削除します）`;
        fix = { kind: "delete-line", text: commandText(g.cmd.name, g.cmd.args) };
      } else if (rest && rest.length === 1) {
        hint = `${who} は消さずに残し、${rest[0]} だけを @chara-hide ${rest[0]} で消します。表情は @chara ${first} 差分 で替えます`;
        // 全消しの行を、残る一人だけを消す行に置き換える。@chara-hide には名前なしの時間が無いので、名前を付けて書く（100ms → time=100ms）
        const spec = registry.get(g.cmd.name);
        const args = spec ? normalizeBooleanArgs(spec, g.cmd.args) : g.cmd.args;
        fix = { kind: "replace-lines", lines: [commandText(g.cmd.name, g.cmd.args)], with: commandText("chara-hide", [{ key: null, value: { kind: "string", value: rest[0]!, quoted: false }, column: 0 }, ...args]) };
      } else {
        hint = `${who} は消さずに残し、退場する人物だけを @chara-hide で消します。表情は @chara ${first} 差分 で替えます`;
      }
    }
    out.push({
      severity: "warning",
      code: "chara-reshow",
      message: `${who} をここで消して、すぐ後（${g.reshown[0]!.line} 行目）で出し直しています。消えてまた出るので立ち絵がちらつきます`,
      file: script.file,
      line,
      hint,
      ...(fix ? { fix, fixes: [fix] } : {}),
    });
  }
  return out;
}
