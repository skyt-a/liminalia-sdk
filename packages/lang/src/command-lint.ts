import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Inline, Literal, Script, Statement } from "./ast.ts";
import { parseLiteral } from "./args.ts";
import { hintFrom } from "./check.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * 標準のコマンドの書き損じのうち、前は実行して初めて分かったもの（構文チェック。checkProject が呼ぶ。どれも警告）。
 * - hide-name-unknown: @cutin-hide、@hud-text-off、@hud-button-off の名前を、どの @cutin stay=true、@hud-text、@hud-button も出していない
 *   （何も消さずに進む）。名前を式で出すものがあれば、その種類は見ない
 * - effect-mask-ignored: 範囲を決められない @effect（wave、glitch、chromatic）の mask=（黙って画面全体にかかる）
 * - flash-rate: 1 秒に 3 回を超えて点滅する @flash（光の点滅で発作を起こすおそれがある。WCAG の「3 回の閃光」の目安）
 * 作品のマクロ（@define）で同じ名前を作っていれば、そのコマンドは見ない。値が式のものは実行するまで分からないので見ない。
 */

/** 範囲（mask=）を決められず全体にかかる @effect の種類（@liminalia/std の FILTER_EFFECTS と同じ。std のテストで突き合わせる）。 */
export const FILTER_ONLY_EFFECTS: readonly string[] = ["wave", "glitch", "chromatic"];

/** 1 秒の点滅の回数の上限（これを超えると知らせる）。 */
export const FLASH_LIMIT = 3;

/** 消すコマンド → 名前を出すコマンドと、診断の文に書くその呼び名。 */
const HIDES: Readonly<Record<string, { show: string; label: string }>> = {
  "cutin-hide": { show: "cutin", label: "@cutin stay=true" },
  "hud-text-off": { show: "hud-text", label: "@hud-text" },
  "hud-button-off": { show: "hud-button", label: "@hud-button" },
};

interface CommandUse {
  file: string;
  name: string;
  args: readonly Argument[];
  line: number;
}

/** 台本のすべてのコマンド（@if の枝、@define の中、本文の中の {@…} も）。 */
function commandsOf(scripts: ReadonlyMap<string, Script>): CommandUse[] {
  const out: CommandUse[] = [];
  for (const [file, script] of scripts) {
    const inline = (content: readonly Inline[], line: number) => {
      for (const n of content) {
        if (n.kind === "command") out.push({ file, name: n.name, args: n.args, line });
        else if ("children" in n) inline(n.children, line);
      }
    };
    const visit = (body: readonly Statement[]) => {
      for (const s of body) {
        if (s.kind === "command") out.push({ file, name: s.name, args: s.args, line: s.line });
        else if (s.kind === "say" || s.kind === "prose") inline(s.content, s.line);
        else if (s.kind === "if") for (const b of s.branches) visit(b.body);
        else if (s.kind === "define") visit(s.body);
      }
    };
    visit(script.body);
  }
  return out;
}

/** パラメータ → 書いた値（名前なしのものは仕様の並びで名前に当てる）。 */
function argsOf(spec: CommandSpec, args: readonly Argument[]): Map<string, Literal> {
  return new Map([...argumentsOf(spec, args)].map(([k, a]) => [k, a.value]));
}

/** パラメータの名前 → 書いた引数（桁も。直し方を指す所に使う）。 */
function argumentsOf(spec: CommandSpec, args: readonly Argument[]): Map<string, Argument> {
  const out = new Map<string, Argument>();
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const key = a.key ?? spec.positional[position++];
    if (key !== undefined && !out.has(key)) out.set(key, a);
  }
  return out;
}

/** 書いた値か、無ければ仕様の既定値（作品の既定値を重ねたもの）。どちらも無ければ undefined。 */
function valueOf(spec: CommandSpec, given: ReadonlyMap<string, Literal>, name: string): Literal | undefined {
  const v = given.get(name);
  if (v !== undefined) return v;
  const def = spec.params[name]?.default;
  return def === undefined ? undefined : parseLiteral(def);
}

/** 時間の値（ミリ秒）。式や時間でない値なら null。 */
function msOf(v: Literal | undefined): number | null {
  if (v?.kind === "duration") return v.ms;
  if (v?.kind === "number") return v.value;
  return null;
}

export function checkCommandLints(scripts: ReadonlyMap<string, Script>, registry: Registry, macros: ReadonlySet<string> = new Set()): Diagnostic[] {
  const out: Diagnostic[] = [];
  const specOf = (name: string) => (macros.has(name) ? undefined : registry.get(name));
  const uses = commandsOf(scripts);

  // ---- 消す名前 ----
  /** 名前を出すコマンド → 出した名前（null は式の名前があって分からない）。 */
  const shown = new Map<string, Set<string> | null>();
  for (const u of uses) {
    const kind = Object.values(HIDES).find((h) => h.show === u.name);
    const spec = kind ? specOf(u.name) : undefined;
    if (!kind || !spec) continue;
    const given = argsOf(spec, u.args);
    // @cutin は stay=true のものだけが残る（式なら残るかもしれない）
    if (u.name === "cutin") {
      const stay = valueOf(spec, given, "stay");
      if (stay?.kind === "bool" && !stay.value) continue;
    }
    if (shown.get(u.name) === null) continue;
    const name = given.get("name");
    if (name?.kind === "expr") shown.set(u.name, null);
    else {
      const set = shown.get(u.name) ?? new Set<string>();
      set.add(name?.kind === "string" ? name.value : "");
      shown.set(u.name, set);
    }
  }
  for (const u of uses) {
    const hide = HIDES[u.name];
    const spec = hide ? specOf(u.name) : undefined;
    if (!hide || !spec || !specOf(hide.show)) continue;
    const names = shown.get(hide.show);
    if (names === null) continue;
    const arg = argumentsOf(spec, u.args).get("name");
    const name = arg?.value;
    if (name?.kind !== "string" || names?.has(name.value)) continue;
    out.push({
      severity: "warning",
      code: "hide-name-unknown",
      message: `@${u.name} の ${name.value} を、どの ${hide.label} も名前に書いていません`,
      file: u.file,
      line: u.line,
      column: arg!.column,
      ...hintFrom(name.value, [...(names ?? [])].filter((n) => n !== ""), (n) => n),
    });
  }

  for (const u of uses) {
    const spec = u.name === "effect" || u.name === "flash" ? specOf(u.name) : undefined;
    if (!spec) continue;
    const given = argsOf(spec, u.args);
    // ---- 範囲を決められない @effect の mask= ----
    if (u.name === "effect") {
      const type = given.get("type");
      if (type?.kind === "string" && FILTER_ONLY_EFFECTS.includes(type.value) && given.has("mask")) {
        out.push({
          severity: "warning",
          code: "effect-mask-ignored",
          message: `@effect ${type.value} は範囲（mask=）を決められず、画面全体にかかります`,
          file: u.file,
          line: u.line,
          hint: "mask= を外し、かける場所は layer= で決めます。範囲を決められるのは noise、vignette、scanlines、radial-blur、zoom-blur、mosaic、ripple、shader です",
        });
      }
      continue;
    }
    // ---- 速い点滅の @flash ----
    const count = valueOf(spec, given, "count");
    const time = msOf(valueOf(spec, given, "time"));
    const gap = msOf(valueOf(spec, given, "gap"));
    if (count?.kind !== "number" || time === null || gap === null) continue;
    // 描画と同じく、回数は 1〜20。一コマの出し始めから次の出し始めまでが time + gap
    const n = Math.max(1, Math.min(20, Math.floor(count.value)));
    const period = time + gap;
    const perSecond = period > 0 ? Math.min(n, Math.ceil(1000 / period)) : n;
    if (perSecond <= FLASH_LIMIT) continue;
    out.push({
      severity: "warning",
      code: "flash-rate",
      message: `@flash が 1 秒に ${perSecond} 回点滅します（光の点滅で発作を起こすおそれがあるため、1 秒に ${FLASH_LIMIT} 回までにします）`,
      file: u.file,
      line: u.line,
      hint: `gap=${Math.max(0, Math.floor(1000 / FLASH_LIMIT) + 1 - time)}ms 以上にするか、count=${FLASH_LIMIT} にします`,
    });
  }
  return out;
}
