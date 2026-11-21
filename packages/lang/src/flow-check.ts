import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Expr, Inline, Script, Statement, Target } from "./ast.ts";
import { parseTargetText } from "./args.ts";
import { scanHtml } from "./html.ts";
import type { CommandSpec, Registry } from "./registry.ts";
import { expressionsIn } from "./story.ts";

/**
 * 流れの静的な誤り（構文チェックの一部。checkProject が呼ぶ）。
 * - call-without-return（警告）: @call の先から @return まで届かない（ファイルの終わりで止まり、呼んだ所へ戻らない）
 * - unreachable-line（警告）: @jump・@return・@stop・プレイを終える命令の後の、ラベルの無い行（どこからも届かない）。
 *   届かない行が命令だけ（本文が無い）なら情報
 * - unused-label（情報）: どこからも飛ばれず、前の行から続けても着かないラベル（その場面に届かない）
 * - unused-define（情報）: どこからも呼ばれないマクロ
 * - unused-speaker（情報）: どの台詞にも使われない話者（cast.json の speakers。liminalia.json の check.unusedSpeakers に書いた話者は除く）
 */
export interface FlowCheckInput {
  scripts: ReadonlyMap<string, Script>;
  /** 組み込みとプラグインの命令（飛び先の型の引数・プレイを終える命令を見る）。 */
  registry: Registry;
  /** 作品のマクロ（名前 → 仕様。target 型のパラメータも飛び先に数える）。 */
  macros?: ReadonlyMap<string, CommandSpec>;
  /** 台本の外から指す飛び先（"ファイル" か "ファイル#ラベル"。liminalia.json の entry・afterLoad・おまけの回想、プラグインのデータの行き先など）。 */
  references?: Iterable<string>;
  /** 式の飛び先の候補（project.ts の targetCandidates）。 */
  candidates?: (target: Target, file: string) => string[] | null;
  /** cast.json の speakers（無ければ使われない話者を見ない）。 */
  speakers?: readonly string[];
  /** 使われなくても知らせない話者（liminalia.json の check.unusedSpeakers。先の話で使う人物など）。 */
  unusedSpeakers?: Iterable<string>;
  /** そのほかに使っているマクロの名前（liminalia.json の commandDefaults など）。 */
  usedMacros?: Iterable<string>;
}

export function checkFlow(input: FlowCheckInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { scripts, registry } = input;
  const specOf = (name: string) => input.macros?.get(name) ?? registry.get(name);

  // ---- 飛び先を集める ----
  const targeted = new Set<string>();
  const addTarget = (text: string, file: string) => {
    const t = parseTargetText(text.trim());
    if (!t) return;
    const f = t.file ?? file;
    targeted.add(t.label === null ? f : `${f}#${t.label}`);
  };
  for (const r of input.references ?? []) addTarget(r, "");
  const usedMacros = new Set<string>(input.usedMacros ?? []);
  const usedSpeakers = new Set<string>();
  /** 呼び出し（@call と call=true の選択肢）の行き先と、呼んだ場所。 */
  const calls: { file: string; line: number; target: string; label: string | null; to: string }[] = [];

  for (const [file, script] of scripts) {
    const targetOf = (target: Target, line: number, call: boolean) => {
      const list = target.expr ? (target.candidates ?? input.candidates?.(target, file) ?? []) : [target.file === null ? `#${target.label}` : target.label === null ? target.file : `${target.file}#${target.label}`];
      for (const c of list) {
        addTarget(c, file);
        if (call && !target.expr) {
          const t = parseTargetText(c)!;
          calls.push({ file, line, target: c, label: t.label, to: t.file ?? file });
        }
      }
    };
    const commandArgs = (name: string, args: readonly Argument[]) => {
      usedMacros.add(name);
      const spec = specOf(name);
      if (!spec) return;
      let position = 0;
      for (const a of normalizeBooleanArgs(spec, args)) {
        const key = a.key ?? spec.positional[position++];
        if (key && spec.params[key]?.type.kind === "target" && a.value.kind === "string" && typeof a.value.value === "string") addTarget(a.value.value, file);
      }
    };
    const inline = (content: readonly Inline[]) => {
      for (const n of content) {
        if (n.kind === "command") commandArgs(n.name, n.args);
        else if ("children" in n) inline(n.children);
      }
    };
    const visit = (body: readonly Statement[]) => {
      for (const s of body) {
        switch (s.kind) {
          case "jump":
          case "call":
            targetOf(s.target, s.line, s.kind === "call");
            break;
          case "choice":
            for (const o of s.options) {
              const call = o.args.some((a) => a.key === "call" && a.value.kind === "bool" && a.value.value);
              targetOf(o.target, o.line, call);
              inline(o.content);
            }
            break;
          case "command":
            commandArgs(s.name, s.args);
            if (s.name === "html" && s.body) for (const j of scanHtml(s.body.text).jumps) addTarget(j.target, file);
            break;
          case "say":
            usedSpeakers.add(s.speaker);
            inline(s.content);
            break;
          case "prose":
            inline(s.content);
            break;
          case "if":
            if (s.with) usedMacros.add(s.with.name), commandArgs(s.with.name, s.with.args);
            for (const b of s.branches) visit(b.body);
            break;
          case "define":
            visit(s.body);
            break;
          default:
            break;
        }
      }
    };
    visit(script.body);
    // 式の中の飛び先の文字列（visits("#x")、@set game.next = "#a" など）
    for (const { expr } of expressionsIn(script.body)) for (const text of stringsIn(expr)) if (/^[\w./-]*#[\p{L}\p{N}_-]+$/u.test(text)) addTarget(text, file);
  }

  // ---- 届かない行と、使われないラベル ----
  const leaves = (s: Statement): boolean =>
    s.kind === "jump" || s.kind === "return" || (s.kind === "command" && (s.name === "stop" || registry.get(s.name)?.ends === true) && !input.macros?.has(s.name));
  for (const [file, script] of scripts) {
    // 下書き（// lim: draft）は遊ぶ人に届かないファイルなので、届かない行と使われないラベルを見ない
    if (script.draft) continue;
    const walkTop = (body: readonly Statement[]) => {
      let dead = false;
      let reported = false;
      for (const [index, s] of body.entries()) {
        if (s.kind === "label") {
          if (dead && !targeted.has(`${file}#${s.name}`)) {
            out.push({ severity: "info", code: "unused-label", message: `ラベル #${s.name} へはどこからも飛ばず、前の行からも続かないため、この場面には届きません`, file, line: s.line, hint: `どこかから @jump #${s.name} で飛ぶか、要らなければラベルと場面を消します` });
          }
          dead = false;
          reported = false;
          continue;
        }
        if (s.kind === "define") {
          walkBlock(s.body);
          continue;
        }
        // @use と @function は宣言（流れの中で実行するものではない）
        if (s.kind === "use" || s.kind === "function") continue;
        if (dead) {
          if (!reported) {
            // 届かない本文（台詞・地の文・選択肢）があれば警告。命令だけ（取り込んだ台本の末尾の @return など）なら情報
            const next = body.findIndex((x, i) => i > index && x.kind === "label");
            const run = body.slice(index, next < 0 ? body.length : next);
            out.push({ severity: run.some(showsText) ? "warning" : "info", code: "unreachable-line", message: "この行には届きません（前の行で別の場所へ移り、間にラベルがありません）", file, line: s.line, hint: "前の行の @jump などの前に移すか、この行の前にラベルを置いてそこへ飛びます" });
          }
          reported = true;
          continue;
        }
        if (s.kind === "if") for (const b of s.branches) walkBlock(b.body);
        if (leaves(s)) dead = true;
      }
    };
    /** @if・@define の中（ラベルは置けないので、移った後の行はその枝の終わりまで届かない）。 */
    const walkBlock = (body: readonly Statement[]) => {
      let dead = false;
      for (const s of body) {
        if (s.kind === "label") {
          dead = false;
          continue;
        }
        if (dead) {
          const run = body.slice(body.indexOf(s));
          out.push({ severity: run.some(showsText) ? "warning" : "info", code: "unreachable-line", message: "この行には届きません（前の行で別の場所へ移り、間にラベルがありません）", file, line: s.line, hint: "前の行の @jump などの前に移すか、この行の前にラベルを置いてそこへ飛びます" });
          return;
        }
        if (s.kind === "if") for (const b of s.branches) walkBlock(b.body);
        if (leaves(s)) dead = true;
      }
    };
    walkTop(script.body);
  }

  // ---- @call の先から @return まで届くか ----
  const seen = new Set<string>();
  for (const c of calls) {
    const key = `${c.file}:${c.line}:${c.to}#${c.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const script = scripts.get(c.to);
    if (!script) continue;
    const start = c.label === null ? 0 : script.body.findIndex((s) => s.kind === "label" && s.name === c.label);
    if (start < 0) continue;
    if (reachesReturn(script.body.slice(c.label === null ? 0 : start + 1), leaves) === "no") {
      out.push({
        severity: "warning",
        code: "call-without-return",
        message: `@call の先 ${c.target} から @return まで届きません（ファイルの終わりで止まり、呼んだ所へ戻りません）`,
        file: c.file,
        line: c.line,
        hint: `${c.target} の場面の終わりに @return を書くか、戻らないなら @jump にします`,
      });
    }
  }

  // ---- 使われないマクロと話者 ----
  for (const [file, script] of scripts) {
    for (const s of script.body) {
      if (s.kind === "define" && s.name !== "" && !usedMacros.has(s.name)) {
        out.push({ severity: "info", code: "unused-define", message: `マクロ @${s.name} はどこからも呼ばれていません`, file, line: s.line, hint: "要らなければ @define から @end までを消します" });
      }
    }
  }
  const quiet = new Set(input.unusedSpeakers ?? []);
  for (const speaker of input.speakers ?? []) {
    // 行は placeConfigLines が cast.json の speakers のその話者の行へ移す
    if (!usedSpeakers.has(speaker) && !quiet.has(speaker)) out.push({ severity: "info", code: "unused-speaker", message: `話者 ${speaker} はどの台詞にも使われていません`, file: "cast.json", line: 1, hint: "要らなければ cast.json の speakers から消します。先の話で使うなら、liminalia.json の check.unusedSpeakers にこの話者を足します" });
  }
  return out;
}

/**
 * 呼ばれた場面（body はラベルの次の行から）から @return まで届くか。"yes" は届く @return がある、"no" はファイルの終わりまで @return が無い、
 * "unknown" は途中で別の場所へ移る（@jump・選択肢・プレイを終える命令。その先で戻るかもしれない）。ラベルは越えて続ける（前の行から続くため）。
 */
function reachesReturn(body: readonly Statement[], leaves: (s: Statement) => boolean): "yes" | "no" | "unknown" {
  for (const s of body) {
    if (s.kind === "define" || s.kind === "use" || s.kind === "label") continue;
    if (s.kind === "return") return "yes";
    if (s.kind === "if") {
      // 枝の中の @return か、枝の中で別の場所へ移るもの（その先で戻るかもしれない）
      const inner = s.branches.map((b) => reachesReturn(b.body, leaves));
      if (inner.includes("yes")) return "yes";
      if (inner.includes("unknown")) return "unknown";
      continue;
    }
    if (s.kind === "choice" && s.options.length > 0) return "unknown";
    if (leaves(s)) return "unknown";
  }
  return "no";
}

/** 遊ぶ人に見せる本文（台詞・地の文・選択肢）を含むか。 */
function showsText(s: Statement): boolean {
  return s.kind === "say" || s.kind === "prose" || s.kind === "choice" || (s.kind === "if" && s.branches.some((b) => b.body.some(showsText)));
}

/** 式の中の文字列のリテラル。 */
function stringsIn(e: Expr, out: string[] = []): string[] {
  switch (e.kind) {
    case "literal":
      if (typeof e.value === "string") out.push(e.value);
      break;
    case "array":
      for (const x of e.items) stringsIn(x, out);
      break;
    case "object":
      for (const x of e.entries) stringsIn(x.value, out);
      break;
    case "member":
      stringsIn(e.object, out);
      break;
    case "index":
      stringsIn(e.object, out);
      stringsIn(e.index, out);
      break;
    case "call":
      for (const x of e.args) stringsIn(x, out);
      break;
    case "unary":
      stringsIn(e.operand, out);
      break;
    case "binary":
      stringsIn(e.left, out);
      stringsIn(e.right, out);
      break;
    case "conditional":
      stringsIn(e.test, out);
      stringsIn(e.then, out);
      stringsIn(e.otherwise, out);
      break;
    case "name":
      break;
  }
  return out;
}

/** liminalia.json の check.unusedSpeakers の読める所（使われなくても知らせない話者の名前）。 */
export function unusedSpeakersConfig(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

/**
 * liminalia.json の check.unusedSpeakers の形の誤り（bad-config。名前の並びでない、cast.json の speakers に無い名前）。
 * 行は placeConfigLines が check.unusedSpeakers の行へ移す。
 */
export function checkUnusedSpeakersConfig(raw: unknown, speakers: readonly string[]): Diagnostic[] {
  if (raw === undefined) return [];
  const at = { file: "liminalia.json", line: 1 };
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    return [{ severity: "error", code: "bad-config", message: "check.unusedSpeakers は話者の名前の並びで書きます", hint: '"unusedSpeakers": ["カイ"]', ...at }];
  }
  return (raw as string[]).filter((s) => !speakers.includes(s)).map((s): Diagnostic => ({ severity: "warning", code: "bad-config", message: `check.unusedSpeakers の ${s} は cast.json の speakers にありません`, ...at }));
}

/** liminalia.json から指す飛び先（entry・afterLoad・おまけの回想と章の target）。使われないラベルの検査に渡す。 */
export function configTargets(config: { entry?: unknown; afterLoad?: unknown; extra?: unknown }): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v !== "") out.push(v);
  };
  add(config.entry);
  add(config.afterLoad);
  const extra = config.extra as { replay?: unknown; chapters?: unknown } | undefined;
  for (const list of [extra?.replay, extra?.chapters]) if (Array.isArray(list)) for (const r of list) add((r as { target?: unknown } | null)?.target);
  return out;
}

/**
 * liminalia.json から始める位置（entry、afterLoad、おまけの回想と章の target）が、下書き（// lim: draft）のファイルを指していないか（draft-entry。エラー）。
 * 下書きは書き出しに入らないので、書き出したゲームはそこで止まる。
 */
export function checkDraftStarts(config: { entry?: unknown; afterLoad?: unknown; extra?: unknown }, scripts: ReadonlyMap<string, Pick<Script, "draft">>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const draftOf = (target: unknown): string | null => {
    if (typeof target !== "string" || target === "") return null;
    const file = target.split("#")[0]!;
    return scripts.get(file)?.draft ? file : null;
  };
  const hint = (file: string) => `仕上がったら ${file} の先頭の // lim: draft を消します`;
  const push = (file: string, message: string) => out.push({ severity: "error", code: "draft-entry", message, file: "liminalia.json", line: 1, hint: hint(file) });
  const entry = draftOf(config.entry);
  if (entry !== null) push(entry, `「はじめから」の位置（entry）のファイル ${entry} が下書きです（下書きは書き出しに入らないので、書き出したゲームは「はじめから」で止まります）`);
  const afterLoad = draftOf(config.afterLoad);
  if (afterLoad !== null) push(afterLoad, `ロードの直後に呼び出す位置（afterLoad）のファイル ${afterLoad} が下書きです（下書きは書き出しに入らないので、書き出したゲームはロードのあとで止まります）`);
  const extra = config.extra as { replay?: unknown; chapters?: unknown } | undefined;
  const list = (v: unknown) => (Array.isArray(v) ? (v as ({ id?: unknown; target?: unknown } | null)[]) : []);
  for (const r of list(extra?.replay)) {
    const file = draftOf(r?.target);
    if (file !== null) push(file, `extra.replay ${String(r?.id ?? "")} の target のファイル ${file} が下書きです（下書きは書き出しに入らないので、書き出したゲームではこの回想を再生できません）`);
  }
  for (const c of list(extra?.chapters)) {
    const file = draftOf(c?.target);
    if (file !== null) push(file, `extra.chapters ${String(c?.id ?? "")} の target のファイル ${file} が下書きです（下書きは書き出しに入らないので、書き出したゲームではこの章から始められません）`);
  }
  return out;
}
