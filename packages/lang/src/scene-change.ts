import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Inline, Literal, Script, Statement } from "./ast.ts";
import { parseArgs, parseLiteral, printLiteral, sameLiteral } from "./args.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * `@mask` 〜 `@mask-off` の塊のうち、`@scene-change` 一つで同じ動きになるものを情報（scene-change-candidate）で知らせ、
 * 塊を一行にする直し方（replace-lines）を付ける。条件の合う塊だけを見る。
 * - 間の行は @bg、@chara-hide-all、@stop-bgm、@bgm だけ（空行やコメントを挟まない、同じ命令は一つずつ）。@bg か @chara-hide-all のどちらかがある
 *   ただし事前に全消し済みなら、間に @wait だけを挟む暗転・明転もまとめる（待機時間を hold にする）
 * - @mask に書けるのは fade と hide-window、@mask-off は fade だけ（動き方や画像の指定があれば置き換えない）。
 *   黒でない暗転（白い光など）は場面転換でない演出のことが多いので置き換えない
 * - 暗転と明転の時間は fade（違えば fade-out と fade-in）、覆っている間に待つ @bg と @chara-hide-all の時間は hold
 * - BGM（@stop-bgm、@bgm）は暗転の直後（覆っている間に待つ命令より前）にあるときだけ。@bgm に書けるのは fade と volume
 * - @chara-hide-all の無い塊は、同じ流れの前の行で立ち絵をすべて消してから @chara を出していないと分かるときだけ
 *   （@scene-change は立ち絵をすべて消すため）。待たない @chara-hide-all が明転にかかる場合は、動きが変わることを示して警告する
 * 作品の既定値（commandDefaults）を重ねた仕様で値を読み、@scene-change に書く値も、その既定値と同じものは書かない。
 */

/** 立ち絵を出さない命令（立ち絵を消した様子を、これらの命令を越えて保つ）。 */
const KEEPS_SPRITES = new Set(["bg", "bgm", "stop-bgm", "se", "stop-se", "wait", "mask", "mask-off", "voice", "chara-hide", "chara-hide-all", "scene-change", "window", "quake", "name", "name-off", "camera", "reset-camera", "cg-unlock"]);
const BODY = new Set(["bg", "chara-hide-all", "stop-bgm", "bgm"]);

/** 時間の書き方（1000 の倍数は秒）。 */
function durationText(ms: number): string {
  return ms > 0 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** 書いた引数（名前なしは positional の名前で）。式の値があれば null。 */
function written(spec: CommandSpec, args: readonly Argument[]): Map<string, Literal> | null {
  const out = new Map<string, Literal>();
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const key = a.key ?? spec.positional[position++];
    if (key === undefined || a.value.kind === "expr" || out.has(key)) return null;
    out.set(key, a.value);
  }
  return out;
}

/** 引数の値（書いていなければ既定値）。 */
function valueOf(spec: CommandSpec, args: ReadonlyMap<string, Literal>, key: string): Literal | undefined {
  const w = args.get(key);
  if (w) return w;
  const d = spec.params[key]?.default;
  return d === undefined ? undefined : parseLiteral(d);
}

const msOf = (v: Literal | undefined): number | null => (v === undefined ? 0 : v.kind === "duration" ? v.ms : null);
const boolOf = (v: Literal | undefined, fallback: boolean): boolean | null => (v === undefined ? fallback : v.kind === "bool" ? v.value : null);

/** 書いた引数がすべて allowed の中か。 */
const only = (args: ReadonlyMap<string, Literal>, allowed: readonly string[]) => [...args.keys()].every((k) => allowed.includes(k));

/** 作品の既定値（commandDefaults）で、書いていない引数の動きを替えているか（allowed 以外）。 */
const projectDefaults = (spec: CommandSpec, allowed: readonly string[]) => Object.entries(spec.params).some(([k, p]) => p.projectDefault && !allowed.includes(k));

type Command = Extract<Statement, { kind: "command" }>;

/** 一つの塊を @scene-change の引数にする（置き換えられなければ null）。 */
function convert(mask: Command, body: readonly Command[], off: Command, registry: Registry, spritesClear: boolean, allowOverlap = false): string | null {
  const maskSpec = registry.get("mask");
  const offSpec = registry.get("mask-off");
  const sc = registry.get("scene-change");
  if (!maskSpec || !offSpec || !sc) return null;
  // 作品の既定で一人だけを消す場合、元の全消しを再現できない。
  if (sc.params["hide-who"]?.default !== undefined) return null;
  const m = written(maskSpec, mask.args);
  const o = written(offSpec, off.args);
  if (!m || !o || !only(m, ["time", "color", "hide-window"]) || !only(o, ["time"])) return null;
  if (projectDefaults(maskSpec, ["time", "color", "hide-window"]) || projectDefaults(offSpec, ["time"])) return null;
  const fadeOut = msOf(valueOf(maskSpec, m, "time"));
  const fadeIn = msOf(valueOf(offSpec, o, "time"));
  const color = valueOf(maskSpec, m, "color");
  const hideWindow = boolOf(valueOf(maskSpec, m, "hide-window"), true);
  if (fadeOut === null || fadeIn === null || hideWindow === null || (color !== undefined && color.kind !== "color")) return null;
  // 黒でない暗転（白い光で照らす、目がくらむなど）は、場面転換でない演出のことが多い
  if (color && !sameAsDefault(sc, "color", printLiteral(color))) return null;

  const names = body.map((c) => c.name);
  // 先に全消し済みなら、暗転・待機・明転も背景を替えず一つにできる。
  const waitOnly = spritesClear && body.length === 1 && body[0]!.name === "wait";
  if (new Set(names).size !== names.length || !names.every((n) => BODY.has(n) || (waitOnly && n === "wait"))) return null;
  if (!names.includes("bg") && !names.includes("chara-hide-all") && !waitOnly) return null;
  if (waitOnly && (sc.params["bg-color"]?.default !== undefined || sc.params.tone?.default !== undefined)) return null;
  if (names.includes("bgm") && names.includes("stop-bgm")) return null;

  let t = 0;
  let image: string | null = null;
  let bgm: string | null = null;
  let bgmVolume: Literal | undefined;
  let stop = false;
  let bgmFade = 0;
  let spriteEnd = 0;
  let backgroundEnd = 0;
  let hideAll = false;
  for (const c of body) {
    const spec = registry.get(c.name);
    if (!spec) return null;
    const a = written(spec, c.args);
    if (!a) return null;
    if (c.name === "wait") {
      if (!waitOnly || !only(a, ["time"]) || spec.params.skip?.default !== "true") return null;
      const duration = a.get("time");
      if (duration?.kind !== "duration") return null;
      t += duration.ms;
    } else if (c.name === "chara-hide-all") {
      if (!only(a, ["time", "wait"])) return null;
      const y = msOf(valueOf(spec, a, "time"));
      const wait = boolOf(valueOf(spec, a, "wait"), false);
      if (y === null || wait === null) return null;
      hideAll = true;
      if (wait) t += y;
      else spriteEnd = Math.max(spriteEnd, t + y);
    } else if (c.name === "bg") {
      if (!only(a, ["image", "time", "wait"])) return null;
      const img = a.get("image");
      const x = msOf(valueOf(spec, a, "time"));
      const wait = boolOf(valueOf(spec, a, "wait"), true);
      if (img?.kind !== "string" || x === null || wait === null) return null;
      image = img.value;
      if (wait) t += x;
      else backgroundEnd = Math.max(backgroundEnd, t + x);
    } else if (c.name === "stop-bgm") {
      if (!only(a, ["time"]) || t > 0) return null;
      const f = msOf(valueOf(spec, a, "time"));
      if (f === null) return null;
      stop = true;
      bgmFade = f;
    } else if (c.name === "bgm") {
      if (!only(a, ["file", "time", "volume"]) || t > 0) return null;
      // @scene-change の bgm は繰り返す。作品の既定値で繰り返さない・重ねて替えるなどにしていれば置き換えない
      if (projectDefaults(spec, ["time", "volume"])) return null;
      const file = a.get("file");
      const f = msOf(valueOf(spec, a, "time"));
      if (file?.kind !== "string" || f === null) return null;
      bgm = file.value;
      bgmVolume = a.get("volume");
      bgmFade = f;
    }
  }
  if (!hideAll && !spritesClear) return null;
  const overlaps = hideAll && spriteEnd > t && !spritesClear;
  if (overlaps && !allowOverlap) return null;
  if (allowOverlap && !overlaps) return null;
  // 背景のフェードも明転にはみ出すなら、立ち絵だけでなく背景の見え方も変わるため提案しない。
  if (allowOverlap && backgroundEnd > t) return null;

  // 書く値（既定値と同じものは書かない）
  const out: string[] = [];
  const put = (key: string, text: string) => {
    if (!sameAsDefault(sc, key, text)) out.push(`${key}=${text}`);
  };
  if (image !== null) out.push(/[\s"=(){}]/.test(image) || image.startsWith("//") ? JSON.stringify(image) : image);
  else if (sc.params.image?.default !== undefined) return null;
  const separate = fadeOut !== fadeIn || sc.params["fade-out"]?.default !== undefined || sc.params["fade-in"]?.default !== undefined;
  if (separate) {
    out.push(`fade-out=${durationText(fadeOut)}`, `fade-in=${durationText(fadeIn)}`);
  } else put("time", durationText(fadeOut));
  put("hold", durationText(t));
  if (sc.params["hide-chara"]) put("hide-chara", "true");
  if (sc.params["hide-at"]?.default !== undefined) out.push("hide-at=covered");
  else put("hide-chara-at", "covered");
  put("hide-fade", "0ms");
  put("color", color ? printLiteral(color) : "#000000");
  if (bgm !== null) {
    out.push(`bgm=${bgm}`);
    if (bgmVolume) put("bgm-volume", printLiteral(bgmVolume));
  } else if (sc.params.bgm?.default !== undefined) return null;
  put("stop-bgm", String(stop));
  if (stop || bgm !== null) put("bgm-fade", durationText(bgmFade));
  put("hide-window", String(hideWindow));
  if (hideWindow && sc.params["hide-window-at"]) put("hide-window-at", "covered");
  return `@scene-change${out.length > 0 ? ` ${out.join(" ")}` : ""}`;
}

/** 書く値が @scene-change の既定値（作品の既定値を重ねたもの）と同じか。 */
function sameAsDefault(spec: CommandSpec, key: string, text: string): boolean {
  return sameLiteral(parseLiteral(text), spec.params[key]?.default);
}

/** 本文の中の命令（{@chara …} など）が立ち絵を出すかもしれないか。 */
function showsSprite(content: readonly Inline[]): boolean {
  return content.some((n) => (n.kind === "command" && !KEEPS_SPRITES.has(n.name)) || ("children" in n && showsSprite(n.children)));
}

/** 命令の文の形（fix.ts の commandShape と同じ書き方。直し方を当てるときに行の中身と比べる）。 */
function shapeOf(c: Command): string {
  return [`@${c.name}`, ...c.args.map((a) => `${a.key === null ? "" : `${a.key}=`}${printLiteral(a.value)}`)].join(" ");
}

/** 暗転直前の退場を、暗転と同時に消す scene-change にまとめる。 */
function mergeHideAndScene(hide: Command, scene: Command, registry: Registry): string | null {
  const hideSpec = registry.get(hide.name);
  const sceneSpec = registry.get("scene-change");
  if (!hideSpec || !sceneSpec || !sceneSpec.params["hide-chara-at"] || !sceneSpec.params["hide-fade"]) return null;
  const h = written(hideSpec, hide.args);
  const s = written(sceneSpec, scene.args);
  if (!h || !s || !only(h, hide.name === "chara-hide" ? ["who", "time"] : ["time"]) || s.has("hide-at") || s.has("hide-chara-at") || s.has("hide-fade")) return null;
  if (boolOf(valueOf(sceneSpec, s, "hide-chara"), true) !== true) return null;
  const sceneWho = valueOf(sceneSpec, s, "hide-who");
  if (hide.name === "chara-hide") {
    const who = h.get("who");
    if (who?.kind !== "string" || sceneWho?.kind !== "string" || who.value !== sceneWho.value) return null;
  } else if (sceneWho !== undefined) return null;
  if (boolOf(valueOf(hideSpec, h, "wait"), false) !== false || boolOf(valueOf(hideSpec, h, "skip"), true) !== true) return null;
  const exit = valueOf(hideSpec, h, "exit");
  if (exit?.kind !== "string" || exit.value !== "fade") return null;
  const fade = msOf(valueOf(hideSpec, h, "time"));
  if (fade === null || fade < 0) return null;
  // 一人退場では自動配置も動く。先の退場が終わる前に暗転後の退場が重なる場合はまとめない。
  if (hide.name === "chara-hide") {
    const out = msOf(valueOf(sceneSpec, s, "fade-out") ?? valueOf(sceneSpec, s, "time"));
    if (out === null || fade > out) return null;
  }
  const timing = sceneSpec.params["hide-at"]?.default !== undefined ? "hide-at=start" : "hide-chara-at=start";
  return `${shapeOf(scene)} ${timing} hide-fade=${durationText(fade)}`;
}

export function sceneChangeCandidates(script: Script, registry: Registry): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!registry.get("scene-change")) return out;
  const visit = (body: readonly Statement[]) => {
    /** 立ち絵がすべて消えていると分かるか（前の行で消し、そのあと出していない）。 */
    let clear = false;
    for (let i = 0; i < body.length; i++) {
      const s = body[i]!;
      if (s.kind === "if") {
        for (const b of s.branches) visit(b.body);
        clear = false;
        continue;
      }
      if (s.kind === "define") {
        visit(s.body);
        continue;
      }
      if (s.kind === "label" || s.kind === "choice" || s.kind === "jump" || s.kind === "call" || s.kind === "return") {
        clear = false;
        continue;
      }
      if (s.kind === "say" || s.kind === "prose") {
        if (showsSprite(s.content)) clear = false;
        continue;
      }
      if (s.kind !== "command") continue;
      const next = body[i + 1];
      const wait = body[i + 2];
      const off = body[i + 3];
      if (s.name === "chara-hide-all" && next?.kind === "command" && next.name === "mask" && wait?.kind === "command" && wait.name === "wait" && off?.kind === "command" && off.name === "mask-off" && next.line === s.line + 1 && wait.line === next.line + 1 && off.line === wait.line + 1) {
        const scene = convert(next, [wait], off, registry, true);
        const synthetic = scene === null ? null : { ...next, name: "scene-change", args: parseArgs(scene.slice("@scene-change".length).trim(), 1).args };
        const replacement = synthetic ? mergeHideAndScene(s, synthetic, registry) : null;
        if (replacement) {
          const lines = [s, next, wait, off].map(shapeOf);
          const fix = { kind: "replace-lines" as const, lines, with: replacement };
          out.push({ severity: "info", code: "scene-change-candidate", message: "全消しと暗転・待機・明転は、暗転と同時に消す @scene-change 一つにまとめられます", file: script.file, line: s.line, hint: `${replacement} にします`, fix, fixes: [fix] });
          i += 3;
          clear = true;
          continue;
        }
      }
      if ((s.name === "chara-hide-all" || s.name === "chara-hide") && next?.kind === "command" && next.name === "scene-change" && next.line === s.line + 1) {
        const replacement = mergeHideAndScene(s, next, registry);
        if (replacement) {
          const fix = { kind: "replace-lines" as const, lines: [shapeOf(s), shapeOf(next)], with: replacement };
          out.push({ severity: "info", code: "scene-change-candidate", message: "立ち絵の退場と場面転換の2行は、暗転と同時に消す @scene-change 一つにまとめられます", file: script.file, line: s.line, hint: `${replacement} にします`, fix, fixes: [fix] });
        }
      }
      if (s.name === "mask") {
        // @mask-off まで、続いた行（間に空行もコメントも無い）の命令だけ
        const block: Command[] = [];
        let j = i + 1;
        let line = s.line;
        for (; j < body.length && j - i <= 10; j++) {
          const n = body[j]!;
          if (n.kind !== "command" || n.line !== line + 1 || n.name === "mask-off") break;
          line = n.line;
          block.push(n);
        }
        const off = body[j];
        if (off?.kind === "command" && off.name === "mask-off" && off.line === line + 1 && block.length > 0) {
          const replacement = convert(s, block, off, registry, clear);
          if (replacement) {
            const lines = [s, ...block, off].map(shapeOf);
            const fix = { kind: "replace-lines" as const, lines, with: replacement };
            out.push({
              severity: "info",
              code: "scene-change-candidate",
              message: `@mask から @mask-off までの ${lines.length} 行は、@scene-change 一つで同じ動きになります`,
              file: script.file,
              line: s.line,
              hint: `${replacement} にします`,
              fix,
              fixes: [fix],
            });
            // 塊の中は見終えた（立ち絵は @scene-change と同じくすべて消えている）
            i = j;
            clear = true;
            continue;
          }
          const safer = convert(s, block, off, registry, clear, true);
          if (safer) {
            const lines = [s, ...block, off].map(shapeOf);
            const fix = { kind: "replace-lines" as const, lines, with: safer };
            out.push({
              severity: "warning",
              code: "scene-change-sprite-overlap",
              message: "明転が始まっても前の立ち絵の消去が終わっていないため、立ち絵が薄く見えることがあります",
              file: script.file,
              line: s.line,
              hint: `${safer} にすると、暗転中に立ち絵を消してから明転します（元の消え方は変わります）`,
              fix,
              fixes: [fix],
            });
            i = j;
            clear = true;
            continue;
          }
        }
      }
      if (s.name === "chara-hide-all") clear = true;
      else if (s.name === "scene-change") {
        const spec = registry.get(s.name);
        const args = spec ? written(spec, s.args) : null;
        if (!spec || !args) clear = false;
        else if (boolOf(valueOf(spec, args, "hide-chara"), true) === true && valueOf(spec, args, "hide-who") === undefined) clear = true;
      }
      else if (!KEEPS_SPRITES.has(s.name)) clear = false;
    }
  };
  visit(script.body);
  return out;
}
