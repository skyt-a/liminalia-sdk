import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Expr, Inline, Script, Statement, Target } from "./ast.ts";
import { paramLocalName, parseTargetText } from "./args.ts";
import { check, defineSpec, nearName, type CheckContext } from "./check.ts";
import { htmlPosition, scanHtml } from "./html.ts";
import { checkStoryCalls } from "./story.ts";
import { checkVariableNames } from "./variables.ts";
import { checkFlow, checkSceneStarts } from "./flow-check.ts";
import { checkCommandLints } from "./command-lint.ts";
import { checkChapterUse } from "./chapters.ts";
import { CORE_COMMANDS, createRegistry, type CommandSpec, type Registry } from "./registry.ts";

/** 同じ構文木と検査条件で得たファイル単位の診断。参照されなくなった構文木は回収される。 */
export type ProjectFileCheckCache = WeakMap<Script, { registry: Registry; project: string; imports: string; diagnostics: Diagnostic[] }>;

/**
 * プロジェクト全体を検査する。ファイルごとの検査に加えて、
 * 別ファイルへの飛び先（ファイルとラベルの実在）と、@use した別ファイルの @define の呼び出しを見る。
 * 別ファイルの @define は、使う側のファイルに `@use そのファイル` を書いたときだけ呼べる。
 */
export function checkProject(
  scripts: ReadonlyMap<string, Script>,
  context: Omit<CheckContext, "defines" | "defineFiles" | "userFunctions" | "functionFiles"> & {
    variables?: Readonly<Record<string, unknown>>;
    /** ほかに値を入れる変数（プラグインの宣言、作品のデータのフラグ。変数の綴り違いの検査に使う）。 */
    writtenVariables?: Iterable<string>;
    /** liminalia.json の check.variables（"declared" なら variables に書いた変数だけを認める）。 */
    variableCheck?: "declared";
    /**
     * 台本の外から指す飛び先（liminalia.json の entry など。configTargets と、プラグインのデータの行き先）。使われないラベルの検査と、
     * 章に入っていないシナリオの検査（はじめから届くか）に使う。
     */
    references?: Iterable<string>;
    /** 台本の外で使うマクロの名前（liminalia.json の commandDefaults など）。 */
    usedMacros?: Iterable<string>;
    /** liminalia.json の chapters（章の扉に出すものと、章に入っていないシナリオの検査。chapters.ts の checkChapterUse）。 */
    chapters?: unknown;
    /** 使われなくても知らせない話者（liminalia.json の check.unusedSpeakers）。 */
    unusedSpeakers?: Iterable<string>;
  } = {},
  cache?: ProjectFileCheckCache,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const registry = context.registry ?? createRegistry(CORE_COMMANDS);
  const labels = new Map<string, Set<string>>();
  /** ファイル → @define の中のラベル → @define の名前（別の実行単位にあるので、@jump の先にはなれない。ファイル単位の検査と同じ見方） */
  const defineLabels = new Map<string, Map<string, string>>();
  const outerLabels = new Map<string, Set<string>>();
  const definesByFile = new Map<string, Map<string, CommandSpec>>();
  const definedIn = new Map<string, string>();
  /** ファイル → そこの @function（名前 → 引数の数）。functionIn は名前 → 書いたファイル。 */
  const functionsByFile = new Map<string, Map<string, number>>();
  const functionIn = new Map<string, string>();
  /** 下書きのファイル（// lim: draft）。 */
  const drafts = new Set([...scripts].filter(([, s]) => s.draft).map(([f]) => f));

  for (const [file, script] of scripts) {
    const names = new Set<string>();
    const inner = new Map<string, string>();
    const outer = new Set<string>();
    const defines = new Map<string, CommandSpec>();
    walk(script.body, (s) => {
      if (s.kind === "label") names.add(s.name);
      if (s.kind === "define" && s.name !== "") {
        const other = definedIn.get(s.name);
        if (other !== undefined && other !== file) {
          out.push({ severity: "error", code: "duplicate-define", message: `@define ${s.name} は ${other} にもあります`, file, line: s.line });
        }
        definedIn.set(s.name, file);
        const spec = defineSpec(s);
        if (spec) defines.set(s.name, spec);
      }
    });
    const collectOuter = (body: readonly Statement[]) => {
      for (const s of body) {
        if (s.kind === "label") outer.add(s.name);
        else if (s.kind === "if") for (const b of s.branches) collectOuter(b.body);
        else if (s.kind === "define")
          walk(s.body, (t) => {
            if (t.kind === "label") inner.set(t.name, s.name);
          });
      }
    };
    collectOuter(script.body);
    labels.set(file, names);
    defineLabels.set(file, inner);
    outerLabels.set(file, outer);
    definesByFile.set(file, defines);
    const fns = new Map<string, number>();
    for (const s of script.body) {
      if (s.kind !== "function") continue;
      const other = functionIn.get(s.name);
      if (other !== undefined && other !== file) out.push({ severity: "error", code: "duplicate-function", message: `@function ${s.name} は ${other} にもあります`, file, line: s.line });
      functionIn.set(s.name, file);
      fns.set(s.name, s.params.length);
    }
    functionsByFile.set(file, fns);
  }

  const projectKey = cache ? JSON.stringify([
    context.cast && [...context.cast],
    context.castEntries,
    context.functions && [...context.functions],
    context.speakers && [...context.speakers],
    context.allowScript,
    context.punctuation,
    context.sourceLanguage,
    [...definedIn],
    [...functionIn],
  ]) : "";
  const candidatesOf = targetCandidates(scripts, { registry, ...(context.variables ? { variables: context.variables } : {}) });
  /** params は中を調べている @define のパラメータの名前（式の中の名前。- は _）。 */
  const checkTarget = (target: Target, file: string, line: number, params?: ReadonlySet<string>, candidate = false) => {
    if (target.expr) {
      // マクロの中の @jump (to) は、パラメータの値（呼ぶ側が書く。型 target なら呼ぶ側で確かめる）へ飛ぶので、ここでは判断しない
      if (params && !target.candidates && target.expr.kind === "name" && params.has(target.expr.name)) return;
      // 式の飛び先は、割り出した候補（か to= の候補）がどれも実在すること
      const candidates = candidatesOf(target, file);
      if (candidates === null) {
        // 警告（資料のとおり。行き先は実行してはじめて決まるだけで、誤りとは限らない）
        out.push({
          severity: "warning",
          code: "unknown-targets",
          message: "ジャンプ先の式から行き先を判断できません（チェックとフローチャートに行き先が反映されません）",
          file,
          line,
          hint: "式の後ろに候補を to=#a,#b のように書きます。式が文字列そのものか、変数に文字列を入れているだけなら書かなくてかまいません",
        });
        return;
      }
      for (const c of candidates) {
        const t = parseTargetText(c);
        if (!t) out.push({ severity: "error", code: "bad-target", message: `ジャンプ先の候補 ${JSON.stringify(c)} は \`#ラベル\`、\`ファイル\`、\`ファイル#ラベル\` のどの形でもありません`, file, line });
        else if (t.file === null && t.label !== null && !labels.get(file)?.has(t.label)) {
          // ほかの飛び先と同じく、シーンを作る直し方と、綴りの近いラベルの案（候補の並びの中は書き換えない）。飛べない @define の中のラベルは案に出さない
          const near = nearName(t.label, [...(labels.get(file) ?? [])].filter((n) => !defineLabels.get(file)?.has(n) || outerLabels.get(file)?.has(n)), (n) => `#${n}`);
          out.push({
            severity: "error",
            code: "unknown-label",
            message: `ジャンプ先の候補のラベル #${t.label} がこのファイルにありません`,
            file,
            line,
            hint: near.hint ? `${near.hint}（シーンを作るなら、ファイルの終わりに # ${t.label} の行を足します）` : `シーンを作るなら、ファイルの終わりに # ${t.label} の行を足します`,
            fixes: [{ kind: "add-label", file, label: t.label }],
          });
        } else checkTarget(t, file, line, undefined, true);
      }
      return;
    }
    if (target.file === null) {
      // 同じファイルの @define の中だけにあるラベルへは飛べない（実行単位が別）。飛び先の字面はファイル単位の検査が
      // 知らせるので、式の候補（ファイル単位の検査は中を見ない）のときだけ知らせる
      const inner = !candidate || target.label === null ? undefined : defineLabels.get(file)?.get(target.label);
      if (inner !== undefined && !outerLabels.get(file)?.has(target.label!)) {
        out.push({
          severity: "error",
          code: "label-in-define",
          message: `ラベル #${target.label} は @define ${inner} の中にあるため、ジャンプできません`,
          file,
          line,
          hint: "ラベルは @define の外に置きます",
        });
      }
      return;
    }
    const targetLabels = labels.get(target.file);
    if (!targetLabels) {
      // 綴りの近いファイル（ラベルはそのまま）
      const near = nearName(target.file, labels.keys(), (n) => n);
      const fix = near.fix?.kind === "replace" ? { kind: "replace" as const, find: `${target.file}${target.label !== null ? `#${target.label}` : ""}`, with: `${near.fix.with}${target.label !== null ? `#${target.label}` : ""}` } : undefined;
      out.push({ severity: "error", code: "unknown-file", message: `ファイル ${target.file} がありません`, file, line, ...(near.hint ? { hint: near.hint } : {}), ...(fix ? { fix, fixes: [fix] } : {}) });
      return;
    }
    // 下書き（// lim: draft）は書き出しに入らないので、遊ぶ人の通るファイルから飛ぶと、書き出したゲームでは行き先が無い
    if (drafts.has(target.file) && !drafts.has(file)) {
      out.push({
        severity: "warning",
        code: "draft-target",
        message: `下書きのファイル ${target.file} へ移ります（下書きは書き出しに入らないので、書き出したゲームでは行き先がありません）`,
        file,
        line,
        hint: `仕上がったら ${target.file} の先頭の // lim: draft を消します`,
      });
    }
    if (target.label !== null && !targetLabels.has(target.label)) {
      // シーンを作る直し方を先に、綴りの近いラベルへの置き換えを後に（飛べない @define の中のラベルは案に出さない）
      const near = nearName(target.label, [...targetLabels].filter((n) => !defineLabels.get(target.file!)?.has(n) || outerLabels.get(target.file!)?.has(n)), (n) => n);
      const fix = near.fix?.kind === "replace" ? { kind: "replace" as const, find: `${target.file}#${target.label}`, with: `${target.file}#${near.fix.with}` } : undefined;
      const create = { kind: "add-label" as const, file: target.file, label: target.label };
      out.push({
        severity: "error",
        code: "unknown-label",
        message: `ラベル #${target.label} が ${target.file} にありません`,
        file,
        line,
        hint: fix ? `${target.file}#${near.fix!.kind === "replace" ? near.fix!.with : ""} のことですか？（シーンを作るなら、${target.file} の終わりに # ${target.label} の行を足します）` : `シーンを作るなら、${target.file} の終わりに # ${target.label} の行を足します`,
        ...(fix ? { fix } : {}),
        fixes: [create, ...(fix ? [fix] : [])],
      });
    } else if (target.label !== null) {
      // 飛び先のファイルの @define の中だけにあるラベルへは飛べない
      const inner = defineLabels.get(target.file)?.get(target.label);
      if (inner !== undefined && !outerLabels.get(target.file)?.has(target.label)) {
        out.push({
          severity: "error",
          code: "label-in-define",
          message: `ラベル #${target.label} は ${target.file} の @define ${inner} の中にあるため、ジャンプできません`,
          file,
          line,
          hint: "ラベルは @define の外に置きます",
        });
      }
    }
  };

  /** 飛び先の型の引数（@sleep-game など。マクロの target 型のパラメータも）。 */
  const checkTargetArgs = (name: string, args: Argument[], file: string, line: number) => {
    const macroFile = definedIn.get(name);
    const spec = (macroFile !== undefined ? definesByFile.get(macroFile)?.get(name) : undefined) ?? registry.get(name);
    if (!spec) return;
    let position = 0;
    for (const a of normalizeBooleanArgs(spec, args)) {
      const key = a.key ?? spec.positional[position++];
      if (key === undefined || spec.params[key]?.type.kind !== "target" || a.value.kind !== "string") continue;
      const target = parseTargetText(a.value.value);
      if (target) checkTarget(target, file, line);
    }
  };
  const visitInline = (content: Inline[], file: string, line: number) => {
    for (const n of content) {
      if (n.kind === "command") checkTargetArgs(n.name, n.args, file, line);
      else if ("children" in n) visitInline(n.children, file, line);
    }
  };

  for (const [file, script] of scripts) {
    out.push(...script.diagnostics);
    const external = new Map<string, CommandSpec>();
    const externalFunctions = new Map<string, number>();
    walk(script.body, (s) => {
      if (s.kind !== "use") return;
      const used = definesByFile.get(s.file);
      if (!used) {
        out.push({ severity: "error", code: "unknown-file", message: `@use したファイル ${s.file} がありません`, file, line: s.line });
        return;
      }
      // 下書きは書き出しに入らないので、書き出したゲームでは @use したファイルが無い（マクロも関数も使えずに止まる）
      if (drafts.has(s.file) && !drafts.has(file)) {
        out.push({
          severity: "error",
          code: "draft-use",
          message: `下書きのファイル ${s.file} を @use しています（下書きは書き出しに入らないので、書き出したゲームではこのファイルのマクロを使えません）`,
          file,
          line: s.line,
          hint: `仕上がったら ${s.file} の先頭の // lim: draft を消します`,
        });
      }
      for (const [name, spec] of used) external.set(name, spec);
      for (const [name, n] of functionsByFile.get(s.file) ?? []) externalFunctions.set(name, n);
    });
    const input = { ...context, registry, defines: external, defineFiles: definedIn, userFunctions: externalFunctions, functionFiles: functionIn };
    if (cache) {
      const imports = JSON.stringify([[...external], [...externalFunctions]]);
      const hit = cache.get(script);
      if (hit?.registry === registry && hit.project === projectKey && hit.imports === imports) out.push(...hit.diagnostics);
      else {
        const diagnostics = check(script, input);
        cache.set(script, { registry, project: projectKey, imports, diagnostics });
        out.push(...diagnostics);
      }
    } else out.push(...check(script, input));
    walkWithDefine(script.body, (s, params) => {
      if (s.kind === "jump" || s.kind === "call") checkTarget(s.target, file, s.line, params);
      if (s.kind === "if" && s.with) checkTargetArgs(s.with.name, s.with.args, file, s.line);
      if (s.kind === "choice") for (const o of s.options) checkTarget(o.target, file, o.line);
      if (s.kind === "command") checkTargetArgs(s.name, s.args, file, s.line);
      // @html の data-jump（同じファイルのラベルは check が見る）
      if (s.kind === "command" && s.name === "html" && s.body) {
        const body = s.body;
        for (const j of scanHtml(body.text).jumps) checkTarget(parseTargetText(j.target)!, file, body.line + htmlPosition(body.text, j.offset).line);
      }
      if (s.kind === "say" || s.kind === "prose") visitInline(s.content, file, s.line);
    });
  }
  // 進み具合の関数（visits("#ラベル")・chosen("文") など）の引数
  out.push(...checkStoryCalls(scripts, labels));
  // game. と system. の変数の綴り違い（マクロの variable 型のパラメータも、命令の結果を入れる所に数える）
  const withMacros = new Map<string, CommandSpec>(registry);
  for (const defines of definesByFile.values()) for (const [name, spec] of defines) if (!withMacros.has(name)) withMacros.set(name, spec);
  out.push(...checkVariableNames(scripts, { registry: withMacros, variables: context.variables, written: context.writtenVariables, mode: context.variableCheck }));
  // 流れの静的な誤り（@call の先の @return、届かない行、使われないラベル・マクロ・話者）
  const macros = new Map<string, CommandSpec>();
  for (const defines of definesByFile.values()) for (const [name, spec] of defines) if (!macros.has(name)) macros.set(name, spec);
  out.push(
    ...checkFlow({
      scripts,
      registry,
      macros,
      candidates: candidatesOf,
      ...(context.references ? { references: context.references } : {}),
      ...(context.speakers ? { speakers: [...context.speakers] } : {}),
      ...(context.unusedSpeakers ? { unusedSpeakers: context.unusedSpeakers } : {}),
      ...(context.usedMacros ? { usedMacros: context.usedMacros } : {}),
    }),
  );
  // 標準のコマンドの書き損じ（消す名前、範囲を決められない mask=、速い点滅）
  out.push(...checkCommandLints(scripts, registry, new Set(definedIn.keys())));
  // ほかのファイルから飛んでくるシーンの初めに背景を決めていない
  out.push(...checkSceneStarts(scripts, registry, macros));
  // 章の扉に出すものが無い、章に入っていないシナリオ
  out.push(...checkChapterUse({ scripts, chapters: context.chapters, registry, macros, starts: context.references ?? [], candidates: candidatesOf }));
  return out;
}

function walk(body: Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) walk(b.body, fn);
    if (s.kind === "define") walk(s.body, fn);
  }
}

/** walk と同じ順にたどり、@define の中ならそのパラメータの名前（式の中の名前。- は _）も渡す。 */
function walkWithDefine(body: Statement[], fn: (s: Statement, params: ReadonlySet<string> | undefined) => void, params?: ReadonlySet<string>): void {
  for (const s of body) {
    fn(s, params);
    if (s.kind === "if") for (const b of s.branches) walkWithDefine(b.body, fn, params);
    if (s.kind === "define") walkWithDefine(s.body, fn, new Set(s.params.map((p) => paramLocalName(p.name))));
  }
}

/**
 * 式の飛び先の候補を割り出す関数（検査と分岐の地図が使う）。to= の候補があればそれ、無ければ式から割り出す:
 * - 文字列そのもの（`("#north")`）・条件式の両側（`(game.ok ? "#a" : "#b")`）
 * - 変数（`(game.next)`）: 作品の中でその変数に入れる値（@set の文字列・liminalia.json の variables の初期値）。
 *   文字列でない値や式を入れる行・命令の結果を入れる命令（@text-input など）があれば割り出せない
 * - 局所変数（@let）: そのファイルで入れる文字列
 * 割り出せなければ null。
 */
export function targetCandidates(
  scripts: ReadonlyMap<string, Script>,
  o: { registry?: Registry; variables?: Readonly<Record<string, unknown>> } = {},
): (target: Target, file: string) => string[] | null {
  /** 変数のパス → 入れる文字列（null は割り出せない）。 */
  const globals = new Map<string, Set<string> | null>();
  const locals = new Map<string, Map<string, Set<string> | null>>();
  const put = (table: Map<string, Set<string> | null>, key: string, value: Expr | string | null) => {
    if (table.get(key) === null) return;
    const text = typeof value === "string" ? value : value && value.kind === "literal" && typeof value.value === "string" ? value.value : null;
    if (text === null) table.set(key, null);
    else (table.get(key) ?? table.set(key, new Set()).get(key)!).add(text);
  };
  for (const [key, value] of Object.entries(o.variables ?? {})) {
    // 空の初期値は「まだ決まっていない」として数えない
    if (value === "") continue;
    put(globals, key, typeof value === "string" ? value : null);
  }
  for (const [file, script] of scripts) {
    const own = new Map<string, Set<string> | null>();
    locals.set(file, own);
    walk(script.body, (s) => {
      if (s.kind === "set") {
        const path = exprPath(s.target);
        if (path) put(globals, path, s.op === "=" ? s.value : null);
      }
      if (s.kind === "let") put(own, s.name, s.value);
      if (s.kind === "command") {
        // 命令の結果を変数に入れる引数（@text-input game.name など）
        const spec = o.registry?.get(s.name);
        let position = 0;
        for (const a of spec ? normalizeBooleanArgs(spec, s.args) : s.args) {
          const key = a.key ?? spec?.positional[position++];
          if (key && spec?.params[key]?.type.kind === "variable" && a.value.kind === "string") globals.set(a.value.value, null);
        }
      }
    });
  }
  const fromExpr = (e: Expr, file: string): string[] | null => {
    switch (e.kind) {
      case "literal":
        return typeof e.value === "string" ? [e.value] : null;
      case "conditional": {
        const a = fromExpr(e.then, file);
        const b = fromExpr(e.otherwise, file);
        return a && b ? [...new Set([...a, ...b])] : null;
      }
      case "name":
      case "member": {
        const path = exprPath(e);
        if (!path) return null;
        const values = path.includes(".") ? globals.get(path) : locals.get(file)?.get(path);
        return values && values.size > 0 ? [...values] : null;
      }
      default:
        return null;
    }
  };
  return (target, file) => (target.candidates ?? (target.expr ? fromExpr(target.expr, file) : null));
}

/** 変数の式（`game.next`・`x`）のパス。添字や呼び出しを含むものは null。 */
function exprPath(e: Expr): string | null {
  if (e.kind === "name") return e.name;
  if (e.kind === "member") {
    const object = exprPath(e.object);
    return object === null ? null : `${object}.${e.property}`;
  }
  return null;
}
