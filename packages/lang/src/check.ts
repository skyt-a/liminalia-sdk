import { checkPunctuation, type PunctuationConfig } from "./punctuation.ts";
import type { Argument, Diagnostic, Expr, Inline, Literal, ProjectFix, Script, Severity, Statement, Target, DiagnosticFix } from "./ast.ts";
import { booleanShorthandConflicts, normalizeBooleanArgs, paramLocalName, parseArgs, parseTargetText, printLiteral, sameLiteral, VARIABLE_PATH } from "./args.ts";
import { sceneChangeCandidates } from "./scene-change.ts";
import { AOZORA_RUBY } from "./proofread.ts";
import { AUTO_POSITION, appearanceKey, positionNames, resolveVariant, type CastEntry } from "./cast.ts";
import { someConditionAlwaysTrue } from "./choice-cover.ts";
import { checkSpriteFlicker } from "./sprite-flicker.ts";
import { htmlPosition, scanHtml } from "./html.ts";
import { FORBIDDEN_PROPERTIES, forbiddenProperties, rootNames } from "./expr.ts";
import { plainText, printInline } from "./inline.ts";
import { isSpeechQuote, SPEECH_CLOSE } from "./speech.ts";
import { arityText, CHOICE_BLOCK, DEFINE_TYPE_NAMES, CHOICE_OPTION, CORE_COMMANDS, createRegistry, FUNCTION_ARITY, functionArity, knownFunctions, paramTypeFromName, type CommandSpec, type ParamType, type Registry } from "./registry.ts";
import { RENAMED_COMMANDS, renamedParam } from "./migrate.ts";
import { RUNTIME_QUIET } from "./runtime-codes.ts";

export interface CheckContext {
  registry?: Registry;
  functions?: ReadonlySet<string>;
  /** キャスト名。省略時はキャストの検査をしない（castEntries があればその名前）。 */
  cast?: ReadonlySet<string>;
  /** キャストの定義（cast.json の cast）。あれば立ち絵セット・差分・立ち位置も確かめる。 */
  castEntries?: Readonly<Record<string, CastEntry>>;
  /** @use したファイルで @define された部品。 */
  defines?: ReadonlyMap<string, CommandSpec>;
  /** @use したファイルの @function（名前 → 引数の数）。 */
  userFunctions?: ReadonlyMap<string, number>;
  /** プロジェクトのすべての @function がどのファイルにあるか（@use し忘れたときの直し方の候補に使う）。 */
  functionFiles?: ReadonlyMap<string, string>;
  /** プロジェクトのすべての @define がどのファイルにあるか（@use し忘れたときの直し方の候補に使う）。 */
  defineFiles?: ReadonlyMap<string, string>;
  /** 話者（cast.json の speakers）。台詞の形なのに地の文になった行の直し方の候補に使う。 */
  speakers?: Iterable<string>;
  /** @script を使ってよいか（liminalia.json の allowScript）。 */
  allowScript?: boolean;
  /** 約物の検査（liminalia.json の check.punctuation。省略はすべて行う。false で外す。./punctuation.ts）。 */
  punctuation?: PunctuationConfig | undefined;
  /** 原文の言語（liminalia.json の languages の先頭。省略は日本語）。日本語でなければ日本語の組版の決まり（…を二つ重ねるなど）を見ない。 */
  sourceLanguage?: string | undefined;
}

/**
 * 構文チェックの診断を、実行時の検査（テストプレイ、全ルートテスト、lim coverage、lim trace）でも知らせるか。
 * 実行の結果を変えない点検（runtime-codes.ts の RUNTIME_QUIET。前の名前の fade=、書き方の提案など）と情報は知らせない
 * （ファイルを読むたび、流すたびに同じものが重なり、実行時の誤りが埋もれるため。構文チェックが知らせる）。表に無い言葉（プラグインの診断）は知らせる。
 */
export function runtimeDiagnostic(d: Pick<Diagnostic, "code" | "severity">): boolean {
  return d.severity !== "info" && !RUNTIME_QUIET.has(d.code);
}

/** 引数の書いたままの字面（Argument.text。無ければ書き直したもの）。直し方の find に使う。 */
export function writtenArg(a: Argument): string {
  return a.text ?? `${a.key === null ? "" : `${a.key}=`}${printLiteral(a.value)}`;
}

/** 名前付きの引数の、書いたままの値の字面（`src=x.png` の x.png）。 */
function writtenValue(a: Argument): string {
  return a.text !== undefined ? a.text.replace(/^[a-z][a-z0-9-]*[=＝]/, "") : printLiteral(a.value);
}

/** 式で読める名前の頭（save はセーブの様子で、読むだけ。save.version）。 */
const VARIABLE_ROOTS = new Set(["game", "system", "temp", "save"]);

/** 構文として読む書き方の言葉（同じ名前のマクロは呼べない）。 */
const FLOW_KEYWORDS: ReadonlySet<string> = new Set(["if", "elif", "else", "end", "while", "for", "with", "content", "choice", "define", "function", "script", "set", "let", "jump", "call", "return", "use"]);

/**
 * 構文木の意味を検査する（命令と引数の型、未定義のラベル・変数・関数・キャスト）。
 * 別ファイルへの飛び先と素材の実在はプロジェクト単位の検査で見る。
 */
export function check(script: Script, context: CheckContext = {}): Diagnostic[] {
  const registry = context.registry ?? createRegistry(CORE_COMMANDS);
  const castNames = context.cast ?? (context.castEntries ? new Set(Object.keys(context.castEntries)) : undefined);
  const functions = context.functions ?? knownFunctions();
  const out: Diagnostic[] = [];
  const report = (severity: Severity, code: string, line: number, message: string, extra: { column?: number | undefined; hint?: string | undefined; hintEn?: string | undefined; fix?: DiagnosticFix | undefined; fixes?: (DiagnosticFix | ProjectFix)[] | undefined } = {}) => {
    const d: Diagnostic = { severity, code, message, file: script.file, line };
    if (extra.column !== undefined) d.column = extra.column;
    if (extra.hint !== undefined) d.hint = extra.hint;
    // 例を手がかりに出すときは、英語の例があればそれを英語の手がかりにする
    if (extra.hintEn !== undefined) d.hintEn = extra.hintEn;
    if (extra.fix !== undefined) d.fix = extra.fix;
    if (extra.fixes !== undefined && extra.fixes.length > 0) d.fixes = extra.fixes;
    out.push(d);
  };
  /** 原文の言語が日本語か（ヒントを原文の言語で分ける。英語の作品に全角スペースを案内しない）。 */
  const japanese = context.sourceLanguage === undefined || context.sourceLanguage === "" || context.sourceLanguage === "ja";

  // ラベルと部品（@define）を先に集める。
  const labels = new Map<string, number>();
  const defines = new Map<string, Extract<Statement, { kind: "define" }>>();
  walk(script.body, (s) => {
    if (s.kind === "label") {
      const first = labels.get(s.name);
      if (first !== undefined) report("error", "duplicate-label", s.line, `ラベル #${s.name} は ${first} 行目にもあります`);
      else labels.set(s.name, s.line);
    }
    if (s.kind === "define" && s.name !== "") {
      // 書き方の言葉（@if・@jump など）は構文として読むので、同じ名前のマクロは呼べない
      if (FLOW_KEYWORDS.has(s.name)) report("error", "define-shadows-command", s.line, `@${s.name} は書き方の決まりの言葉なので、マクロの名前にできません`, { hint: "別の名前にします" });
      else if (defines.has(s.name)) report("error", "duplicate-define", s.line, `@define ${s.name} が重複しています`);
      else {
        // 組み込みのコマンドと同じ名前なら、作品のマクロを使う（実行器もマクロを先に探す）。新しい版で同じ名前のコマンドが増えても止めない
        if (registry.has(s.name)) report("warning", "define-shadows-command", s.line, `@${s.name} は組み込みのコマンドと同じ名前です（この作品ではマクロを使います）`, { hint: `組み込みの @${s.name} を使うなら、マクロの名前を変えます` });
        defines.set(s.name, s);
      }
    }
  });

  // 式の関数（@function）。組み込みの関数と同じ名前は作れない
  const own = new Map<string, number>();
  for (const s of script.body) {
    if (s.kind !== "function") continue;
    if (functions.has(s.name) || FUNCTION_ARITY[s.name]) report("error", "duplicate-function", s.line, `${s.name}() は組み込みの関数と同じ名前なので、@function の名前にできません`, { hint: "別の名前にします" });
    else if (own.has(s.name)) report("error", "duplicate-function", s.line, `@function ${s.name} が重複しています`);
    else own.set(s.name, s.params.length);
  }
  const userFunctions = new Map<string, number>([...(context.userFunctions ?? []), ...own]);

  const checkTarget = (target: Target, line: number, locals: ReadonlySet<string>) => {
    if (target.expr) return checkExpr(target.expr, line, locals);
    if (target.file === null && target.label !== null && !labels.has(target.label)) {
      const near = nearName(target.label, labels.keys(), (n) => `#${n}`);
      const create: ProjectFix = { kind: "add-label", file: script.file, label: target.label };
      report("error", "unknown-label", line, `ラベル #${target.label} がこのファイルにありません`, {
        ...(near.hint ? { hint: `${near.hint}（シーンを作るなら、ファイルの終わりに # ${target.label} の行を足します）` } : { hint: `シーンを作るなら、ファイルの終わりに # ${target.label} の行を足します` }),
        ...(near.fix ? { fix: near.fix } : {}),
        fixes: [create, ...(near.fix ? [near.fix] : [])],
      });
    }
  };

  const reportForbidden = (name: string, line: number) =>
    report("error", "forbidden-property", line, `${name} は変数の名前やキーに使えません`, { hint: "__proto__、constructor、prototype 以外の名前にします" });

  const checkExpr = (expr: Expr, line: number, locals: ReadonlySet<string>) => {
    const forbidden = forbiddenProperties(expr);
    for (const name of forbidden) reportForbidden(name, line);
    for (const name of rootNames(expr)) {
      if (forbidden.has(name)) continue;
      if (VARIABLE_ROOTS.has(name) || locals.has(name)) continue;
      report("error", "unknown-variable", line, `変数 ${name} は定義されていません`, {
        hint: `ゲーム変数なら game.${name}、一時変数なら temp.${name}、ローカル変数なら先に @let ${name} = … と書きます`,
      });
    }
    visitCalls(expr, (callee, count) => {
      const user = userFunctions.get(callee);
      if (user !== undefined && !functions.has(callee)) {
        if (count !== user) report("error", "bad-arguments", line, `${callee}() の引数は ${user} つです（${count} つ書いてあります）`);
        return;
      }
      if (!functions.has(callee)) {
        const elsewhere = context.functionFiles?.get(callee);
        if (elsewhere !== undefined && elsewhere !== script.file) report("error", "unknown-function", line, `${callee}() は ${elsewhere} の @function なので、このファイルでは使えません`, { hint: `ファイルの先頭に @use ${elsewhere} を書きます` });
        else report("error", "unknown-function", line, `関数 ${callee}() はありません`, hintFrom(callee, [...functions, ...userFunctions.keys()], (n) => `${n}()`, (n) => `${n}(`));
      }
      const arity = functionArity(callee);
      if (arity && (count < arity[0] || count > arity[1])) {
        report("error", "bad-arguments", line, `${callee}() の引数は ${arityText(arity)}です（${count} つ書いてあります）`, callee === "random" ? { hint: "random(n) は 0 以上 n 未満の整数を返します。a 以上 b 以下なら a + random(b - a + 1) と書きます" } : {});
      }
    });
  };

  /**
   * define は中を調べている @define（無ければ null）、inWith は @with の中身の中か（@content は書けない）。
   */
  const checkBlock = (body: Statement[], locals: Set<string>, define: Extract<Statement, { kind: "define" }> | null = null, inWith = false) => {
    // 行の if=(式) の付いた @let と @for の名前も、その後ろの行で読める（実行器の局所変数はブロックで分かれない。
    // @for の名前は最後の値のまま、一度も回らなければ値の無いまま）
    for (const s of body) {
      if (s.kind === "let") locals.add(s.name);
      else if (s.kind === "if" && s.guard !== undefined && s.branches[0]?.body[0]?.kind === "let") locals.add(s.branches[0].body[0].name);
      else if (s.kind === "if" && s.each && s.each.name !== "" && !VARIABLE_ROOTS.has(s.each.name) && !FORBIDDEN_PROPERTIES.has(s.each.name)) locals.add(s.each.name);
    }
    for (const s of body) {
      switch (s.kind) {
        case "say":
          if (s.name) checkInline(s.name, s.line, locals);
          checkInline(s.content, s.line, locals);
          checkTextHabits(s.content, s.line);
          break;
        case "prose":
          checkInline(s.content, s.line, locals);
          // 構文解析が台詞の形の誤りを知らせた行（話者でない名前の {name …}）は重ねない
          if (!parsedSpeech.has(s.line)) checkSpeechShape(s.content, s.line);
          checkTextHabits(s.content, s.line);
          break;
        case "script":
          // 中身はどの環境でも実行しない（取り込んだ [iscript] の JS を、書き直すまで残しておく所）
          if (!context.allowScript) {
            report("error", "script-not-allowed", s.line, "@script はこのプロジェクトでは使えません", {
              hint: 'プロジェクト固有の処理はプラグインのコマンドにします。取り込んだ JS を書き直すまで残すなら liminalia.json に "allowScript": true を書きます（中身は実行しません）',
            });
          } else {
            report("warning", "script-skipped", s.line, "@script の中身は実行しません", {
              hint: "プロジェクト固有の処理はプラグインのコマンド（@liminalia/sdk）にし、表示を作るだけなら @html にします。書き直し終えたら @script を消します",
            });
          }
          break;
        case "label":
        case "use":
          break;
        case "function": {
          // 中で読めるのは引数と game・system・temp・save だけ（呼んだ所の @let は見えない）
          for (const p of s.params) if (FORBIDDEN_PROPERTIES.has(p)) reportForbidden(p, s.line);
          checkExpr(s.body, s.line, new Set(s.params));
          break;
        }
        case "return":
          if (inWith) {
            report("error", "bad-return", s.line, "@with の中身の中には @return を書けません（中身はマクロの中で実行するため）");
            break;
          }
          if (!s.value) break;
          checkExpr(s.value, s.line, locals);
          if (!define) report("error", "bad-return", s.line, "値を返す @return (式) は @define の中にだけ書けます", { hint: "@call で呼んだところへ戻るだけなら @return と書きます" });
          else if (!define.params.some((p) => p.type === "variable")) {
            report("error", "bad-return", s.line, `@define ${define.name} に戻り値を入れる変数のパラメータ（型 variable）がありません`, { hint: `@define ${define.name}(…, result: variable)` });
          }
          break;
        case "content":
          if (!define) report("error", "bad-content", s.line, "@content は @define の中にだけ書けます（@with で渡された中身を実行する）");
          else if (inWith) report("error", "bad-content", s.line, "@with の中身の中には @content を書けません");
          break;
        case "let":
          if (FORBIDDEN_PROPERTIES.has(s.name)) reportForbidden(s.name, s.line);
          checkExpr(s.value, s.line, locals);
          break;
        case "set":
          checkExpr(s.target, s.line, locals);
          checkExpr(s.value, s.line, locals);
          break;
        case "if": {
          if (s.with) checkWith(s.with.name, s.with.args, s.line, locals);
          const block = s.each ? "@for" : s.loop ? "@while" : s.with ? "@with" : "@if";
          // @for 名前 in 式: 名前は中だけの局所変数
          const inner = new Set(locals);
          if (s.each) {
            checkExpr(s.each.list, s.line, locals);
            // 字面の数、文字列、真偽値、null は回せない（実行すると「回せるのは配列か辞書」で止まる）
            const list = s.each.list;
            if (list.kind === "literal") report("error", "bad-for", s.line, `@for で回せるのは配列か辞書です（${JSON.stringify(list.value)} は配列でも辞書でもありません）`, { hint: "@for item in game.items" });
            if (s.each.name !== "") {
              if (FORBIDDEN_PROPERTIES.has(s.each.name)) reportForbidden(s.each.name, s.line);
              else if (VARIABLE_ROOTS.has(s.each.name)) report("error", "bad-for", s.line, `${s.each.name} は変数の頭の名前なので、@for の名前にできません`, { hint: "@for item in game.items" });
              inner.add(s.each.name);
            }
          }
          for (const b of s.branches) {
            if (b.condition) checkExpr(b.condition, b.line, locals);
            checkBlock(b.body, new Set(inner), define, inWith || s.with !== undefined);
            // 外から @if の中のラベルへ飛ぶと、条件を通らずに枝の途中から始まり、枝の終わりで @end の後ろへ抜ける
            // （入れ子の @if の中のものは、その @if を調べるときに知らせる）
            for (const inner of b.body) {
              if (inner.kind === "label") {
                report("error", "label-in-if", inner.line, `ラベル #${inner.name} が ${block} の中にあります。ここへジャンプすると、条件を確認せずに分岐の途中から始まります`, {
                  hint: `ラベルは ${block} の外に置き、${block} の中からそこへ @jump します`,
                });
              }
            }
          }
          break;
        }
        case "choice":
          // どの選択肢にも条件（if=）があると、すべて偽のときに選択肢を出せずに止まる（実行時の no-choice-shown）。
          // 条件を組み合わせてどれかが必ず真になると確かめられたとき（残りの裏返しの条件など）は知らせない
          if (s.args) checkArgs(CHOICE_BLOCK, s.args, s.line, locals);
          const conditions = s.options.map((o) => o.args.find((a) => a.key === "if")?.value);
          if (
            s.options.length > 0 &&
            conditions.every((c) => c !== undefined) &&
            !(conditions.every((c) => c?.kind === "expr") && someConditionAlwaysTrue(conditions.map((c) => (c as { expr: Expr }).expr)))
          ) {
            report("warning", "all-options-conditional", s.line, "どの選択肢にも条件（if=）があるため、すべて偽のときは選択肢を表示できずに止まります", {
              hint: "条件のない選択肢を一つ置きます（すべて偽になることがなければ、そのままでかまいません。変数を true か false、または値と比べる条件で、どれかが必ず真になる場合はこの警告を出しません）",
            });
          }
          for (const o of s.options) {
            checkTarget(o.target, o.line, locals);
            checkInline(o.content, o.line, locals);
            checkTextHabits(o.content, o.line);
            checkArgs(CHOICE_OPTION, o.args, o.line, locals);
            const has = (key: string) => o.args.some((a) => a.key === key);
            if (plainText(o.content) === "" && !has("image") && !(has("width") && has("height"))) {
              report("error", "empty-option", o.line, "選択肢のテキストが空です。画像のボタンなら image=、クリックできる範囲なら width= と height= を書きます", {
                hint: CHOICE_OPTION.example,
                hintEn: CHOICE_OPTION.exampleEn,
              });
            }
          }
          break;
        case "jump":
        case "call":
          checkTarget(s.target, s.line, locals);
          break;
        case "define": {
          const params = new Set<string>();
          if (s.params.filter((p) => p.type === "variable").length > 1) report("error", "bad-param", s.line, "変数のパラメータ（型 variable。@return (式) の値を入れる）は一つだけ書けます");
          for (const p of s.params) {
            if (!paramTypeFromName(p.type)) report("error", "unknown-type", s.line, `型 ${p.type} はありません（${DEFINE_TYPE_NAMES}）`, hintFrom(p.type, ["string", "number", "int", "bool", "duration", "color", "variable", "cast", "appearance", "variant", "position", "target"], (n) => n));
            if (FORBIDDEN_PROPERTIES.has(paramLocalName(p.name))) reportForbidden(p.name, s.line);
            params.add(paramLocalName(p.name));
          }
          // 引数 first-name は式の中で first_name と読むので、同じ名前の @let は引数を上書きしてしまう
          walk(s.body, (inner) => {
            if (inner.kind === "let" && params.has(inner.name)) {
              const param = s.params.find((p) => paramLocalName(p.name) === inner.name)!;
              report("error", "shadows-param", inner.line, `@let ${inner.name} はパラメータ ${param.name} と同じ名前です（式の中ではパラメータ名の - を _ として扱うため）`, {
                hint: "別の名前にします",
              });
            }
          });
          checkBlock(s.body, params, s);
          break;
        }
        case "command":
          checkCommand(s.name, s.args, s.line, locals);
          if (s.name === "html") checkHtml(s, locals);
          if (s.name === "staff-roll" && !s.args.some((a) => a.key === "file") && (s.body?.text.trim() ?? "") === "") {
            report("warning", "staff-roll-empty", s.line, "@staff-roll の中身がありません", { hint: "@staff-roll と @end のあいだに名前を書くか、file= で data の JSON を指します" });
          }
          break;
      }
    }
  };

  /** 台詞の形なのに地の文になった行（話者名の綴りの誤り・話者に足し忘れ・名前と括弧のあいだの空白・名前の後の「：」・【名前】）。 */
  const speakers = [...(context.speakers ?? [])];
  const parsedSpeech = new Set(script.diagnostics.filter((d) => d.code === "unknown-speaker").map((d) => d.line));
  // 半角の : のあとに引用符の台詞（Nora: "…"）が同じ名前で二行以上あれば、話者でなくても脚本の形とみなす（一行だけの Note: "x" は地の文）
  const scriptNames = colonSpeechNames(script.body);
  const checkSpeechShape = (content: Inline[], line: number) => {
    const text = printInline(content);
    // 台本の書き方の癖（アカリ：「…」、【アカリ】「…」、アカリ：…）
    const marked = markedSpeech(text, speakers, japanese, scriptNames);
    if (marked) {
      const replace: DiagnosticFix = { kind: "replace", find: marked.find, with: marked.with };
      const registered = speakers.includes(marked.name);
      if (registered) {
        const message = marked.kind === "bracket" ? `【${marked.name}】の形のため、この行は台詞ではなく地の文になります` : `${marked.name} の後の「${marked.mark}」のため、この行は台詞ではなく地の文になります`;
        report("warning", "unknown-speaker", line, message, { hint: `${marked.with}… と書きます`, fix: replace, fixes: [replace] });
      } else {
        report("warning", "unknown-speaker", line, `${marked.name} は話者に登録されていないため、この行は台詞ではなく地の文になります（名前の書き方も台詞の形ではありません）`, {
          hint: `${marked.name} を話者に追加し、${marked.with}… と書きます`,
          fix: replace,
          fixes: [{ kind: "add-speaker", name: marked.name }, replace],
        });
      }
      return;
    }
    const shape = speechShape(text);
    if (!shape) return;
    if (shape.spaced && speakers.includes(shape.name)) {
      const head = /^\S+[ 　]*/.exec(text)![0];
      if (isSpeechQuote(shape.open)) {
        const fix: DiagnosticFix = { kind: "replace", find: `${head}${shape.open}`, with: `${shape.name} ${shape.open}` };
        report("warning", "unknown-speaker", line, `${shape.name} と引用符のあいだの空白が半角の一つではないため、この行は台詞ではなく地の文になります`, { hint: `${shape.name} ${shape.open}… と書きます（空白は半角の一つまで）`, fix, fixes: [fix] });
      } else {
        const fix: DiagnosticFix = { kind: "replace", find: `${head}${shape.open}`, with: `${shape.name}${shape.open}` };
        report("warning", "unknown-speaker", line, `${shape.name} と括弧のあいだに空白があるため、この行は台詞ではなく地の文になります`, { hint: `${shape.name}${shape.open}… と詰めて書きます`, fix, fixes: [fix] });
      }
      return;
    }
    // 候補は、一字ほどの違いか、一方がもう一方を含む名前（「白石ミナ」→「ミナ」）だけ。短い名前は似ていなくても近くなるため
    const near = speakers.find((n) => n.includes(shape.name) || shape.name.includes(n)) ?? speakers.find((n) => distance(n, shape.name) <= Math.max(1, Math.floor(shape.name.length / 3)));
    const add: ProjectFix = { kind: "add-speaker", name: shape.name };
    const rename: DiagnosticFix | undefined = near ? { kind: "replace", find: shape.name, with: near } : undefined;
    report("warning", "unknown-speaker", line, `${shape.name} は話者に登録されていないため、この行は台詞ではなく地の文になります`, {
      hint: near
        ? `${near} のことですか？（別の人物なら ${shape.name} を話者に追加します）`
        : japanese
          ? `${shape.name} を話者（cast.json の speakers）に追加するか、名前の綴りを直します。地の文なら行頭を全角スペースで字下げします`
          : `${shape.name} を話者（cast.json の speakers）に追加するか、名前の綴りを直します`,
      ...(rename ? { fix: rename } : {}),
      fixes: rename ? [rename, add] : [add],
    });
  };

  /** 本文に残った別の書き方（《》のルビ、TyranoScript のタグ）。 */
  const checkTextHabits = (content: Inline[], line: number) => {
    const visit = (nodes: Inline[]) => {
      for (const n of nodes) {
        if (n.kind === "text") {
          for (const m of n.text.matchAll(AOZORA_RUBY)) {
            const base = m[1] ?? m[3]!;
            const reading = m[2] ?? m[4]!;
            const fix: DiagnosticFix = { kind: "replace", find: m[0], with: `{r ${base}|${reading}}` };
            report("warning", "aozora-ruby", line, `《》のルビ ${m[0]} はルビにならず、そのまま表示されます`, { hint: `{r ${base}|${reading}} と書きます`, fix, fixes: [fix] });
          }
          for (const m of n.text.matchAll(TYRANO_TAG)) {
            const to = TYRANO_REPLACE[m[1]!]!;
            const fix: DiagnosticFix = { kind: "replace", find: m[0], with: to };
            report("warning", "tyrano-tag", line, `TyranoScript のタグ ${m[0]} が本文に残っています（そのまま表示されます）`, { hint: to === "" ? `${m[0]} を消します（行の終わりでクリックを待ちます）` : `${to} と書きます`, fix, fixes: [fix] });
          }
        } else if ("children" in n) visit(n.children);
      }
    };
    visit(content);
  };

  /** column は命令の @ の桁（本文の中の {@…}。行の頭の命令は行の最初の @ なので省く）。 */
  const checkCommand = (name: string, args: Argument[], line: number, locals: ReadonlySet<string>, column?: number) => {
    const at = column !== undefined ? { column } : {};
    // 実行器と同じく、このファイルのマクロ、@use したファイルのマクロ、組み込みのコマンドの順に探す
    const spec = defineSpec(defines.get(name)) ?? context.defines?.get(name) ?? registry.get(name);
    if (!spec) {
      const elsewhere = context.defineFiles?.get(name);
      if (elsewhere !== undefined && elsewhere !== script.file) {
        report("error", "unknown-command", line, `@${name} は ${elsewhere} で定義したマクロ（@define）なので、このファイルでは使えません`, { ...at, hint: `ファイルの先頭に @use ${elsewhere} を書きます` });
        return;
      }
      // 前の版の名前（@scene → @scene-change など）。lim migrate がまとめて直す
      const renamed = RENAMED_COMMANDS[name];
      if (renamed && registry.has(renamed.to)) {
        const fix: DiagnosticFix = { kind: "replace", find: `@${name}`, with: `@${renamed.to}` };
        report("error", "renamed-command", line, `@${name} は @${renamed.to} という名前になりました`, { ...at, hint: `@${renamed.to} と書きます（作品全体は lim migrate で直せます）`, fix, fixes: [fix] });
        const now = registry.get(renamed.to)!;
        checkArgs(now, args, line, locals);
        return;
      }
      report("error", "unknown-command", line, `コマンド @${name} はありません`, { ...at, ...hintFrom(name, [...registry.keys(), ...defines.keys(), ...(context.defines?.keys() ?? [])], (n) => `@${n}`) });
      return;
    }
    checkArgs(spec, args, line, locals);
  };

  /** @with マクロ パラメータ…（中身を渡すマクロの呼び出し）。 */
  const checkWith = (name: string, args: Argument[], line: number, locals: ReadonlySet<string>) => {
    if (name === "") return;
    if (registry.has(name) && !defines.has(name) && !context.defines?.has(name)) {
      report("error", "bad-with", line, `@with で呼べるのは @define のマクロだけです（@${name} はコマンドです）`, { hint: `@with を外して @${name} と書き、@end までの行は外に出します` });
      return;
    }
    const spec = defineSpec(defines.get(name)) ?? context.defines?.get(name);
    if (!spec) {
      checkCommand(name, args, line, locals);
      return;
    }
    checkArgs(spec, args, line, locals);
    if (!spec.block) report("warning", "with-without-content", line, `@${name} の中に @content が無いため、@with の中身は実行されません`, { hint: `@define ${name} の中の、中身を実行するところに @content を書きます` });
  };

  /** @html の中身（使えるタグと属性・埋め込みの式・同じファイルの飛び先・wait との組み合わせ）。 */
  const checkHtml = (s: Extract<Statement, { kind: "command" }>, locals: ReadonlySet<string>) => {
    const body = s.body;
    if (!body) return;
    const scan = scanHtml(body.text);
    const at = (offset: number) => {
      const p = htmlPosition(body.text, offset);
      return { line: body.line + p.line, column: body.indent + p.column + 1 };
    };
    for (const issue of scan.issues) {
      const p = at(issue.offset);
      report("error", issue.code, p.line, issue.message, { column: p.column, ...(issue.hint !== undefined ? { hint: issue.hint } : {}) });
    }
    for (const v of scan.values) checkExpr(v.expr, at(v.start).line, locals);
    for (const j of scan.jumps) checkTarget(parseTargetText(j.target)!, at(j.offset).line, locals);
    if (body.text.trim() === "") report("warning", "html-empty", s.line, "@html の中身がありません", { hint: "@html と @end のあいだに HTML を書きます" });
    const spec = registry.get(s.name);
    const wait = (spec ? normalizeBooleanArgs(spec, s.args) : s.args).find((a) => a.key === "wait")?.value;
    const waits = wait?.kind === "bool" ? wait.value : wait === undefined ? false : null;
    if (waits === true && scan.jumps.length === 0) {
      report("warning", "html-wait-without-jump", s.line, "wait=true の @html に、押して飛ぶ要素（data-jump）がありません（表示し終わるのを待つだけです）", {
        hint: '<button data-jump="#ラベル">…</button> を書くか、wait=true を消します',
      });
    }
    if (waits === false && scan.jumps.length > 0) {
      report("warning", "html-jump-without-wait", at(scan.jumps[0]!.offset).line, "data-jump の要素は、wait=true の @html でしか押せません（このままでは表示するだけです）", {
        hint: "押して飛ばすなら @html の行に wait=true を書きます",
      });
    }
  };

  const checkInline = (content: Inline[], line: number, locals: ReadonlySet<string>) => {
    for (const node of content) {
      if (node.kind === "command" && node.name === "html") {
        report("error", "html-inline", line, "@html は本文の中には書けません", { hint: "@html の行と @end の行のあいだに HTML を書きます" });
      } else if (node.kind === "command") checkCommand(node.name, node.args, line, locals, node.column);
      else if (node.kind === "value") checkExpr(node.expr, line, locals);
      else if (node.kind === "style" || node.kind === "color" || node.kind === "speed" || node.kind === "size" || node.kind === "mark" || node.kind === "fx" || node.kind === "emphasis" || node.kind === "variants") checkInline(node.children, line, locals);
    }
  };

  const checkArgs = (spec: CommandSpec, rawArgs: Argument[], line: number, locals: ReadonlySet<string>) => {
    for (const conflict of booleanShorthandConflicts(spec, rawArgs, context.castEntries)) {
      report("error", "ambiguous-bool-shorthand", line, `${conflict.name} は真偽値の名前と ${conflict.positional} の値の両方に使えます`, {
        column: conflict.column,
        hint: `真偽値には ${conflict.name}=true と書き、${conflict.positional} の名前と区別します`,
        hintEn: `Write ${conflict.name}=true for the boolean to distinguish it from ${conflict.positional}`,
      });
    }
    // 前の版の引数の名前（fade= → time=）。そのまま動くので警告。作品全体は lim migrate で直す
    for (const a of rawArgs) {
      const to = a.key === null ? null : renamedParam(spec, a.key);
      if (to === null) continue;
      const value = printLiteral(a.value);
      // 名前だけを置き換える（値の字面は書いたまま。診断の桁から始まる引数にだけ当たる）
      const fix: DiagnosticFix = { kind: "replace", find: `${a.key}=`, with: `${to}=` };
      report("warning", "renamed-param", line, `@${spec.name} の ${a.key}= は ${to}= という名前になりました`, {
        column: a.column,
        hint: `${to}=${value} と書きます（作品全体は lim migrate で直せます）`,
        hintEn: `Write ${to}=${value} (lim migrate rewrites the whole project)`,
        fix,
        fixes: [fix],
      });
    }
    const args = normalizeBooleanArgs(spec, rawArgs);
    const bare = new Set(args.filter((a, i) => a !== rawArgs[i]).map((a) => a.column));
    const fixedLine = (items: readonly FixedArg[]) => fixedCommandLine(spec, items);
    const asItems = (list: readonly Argument[]): FixedArg[] => {
      let at = 0;
      return list.map((x) => ({ name: x.key ?? spec.positional[at++] ?? "", text: `${x.key === null ? "" : `${x.key}=`}${printLiteral(x.value)}` }));
    };
    const given = new Map<string, Argument>();
    /** 作品の既定値（commandDefaults）と同じ値を書いた引数。 */
    const sameAsDefault: { a: Argument; name: string }[] = [];
    let position = 0;
    for (const [index, a] of args.entries()) {
      /** 書いたままの引数（前の名前の fade= や、名前なしの時間の 300 のまま。直し方と文の名前に使う）。 */
      const raw = rawArgs[index] ?? a;
      let name: string;
      if (a.key === null) {
        const p = spec.positional[position++];
        if (p === undefined) {
          // その行から余分な値を外した形を見せる（名前を付けるパラメータの書き間違いなら、名前を付けて書く）
          const extra = printLiteral(a.value);
          const without = fixedLine(asItems(args.filter((x) => x !== a)));
          const fix: DiagnosticFix = { kind: "replace", find: ` ${writtenArg(a)}`, with: "" };
          report("error", "too-many-positional", line, `@${spec.name} の名前なしのパラメータは ${spec.positional.length} 個までです`, {
            column: a.column,
            hint: `${extra} を外すか、名前を付けて書きます（${without}）`,
            hintEn: `Remove ${extra} or write it with a parameter name (${without})`,
            fix,
            fixes: [fix],
          });
          continue;
        }
        name = p;
      } else {
        name = a.key;
        if (spec.positional.includes(name)) {
          // その行を直した形（name= を外す）。名前なしで書ける順番より後ろなら、外しても読めないので例を出す
          const value = printLiteral(a.value);
          const fix: DiagnosticFix = { kind: "replace", find: writtenArg(a), with: writtenValue(a) };
          const inOrder = spec.positional.indexOf(name) === position;
          report("error", "positional-by-name", line, `${name} は名前なしのパラメータとして書きます（${name}= は付けません）`, {
            column: a.column,
            ...(inOrder ? { hint: `${name}= を外して ${value} と書きます`, fix, fixes: [fix] } : { hint: `名前なしのパラメータを前に並べて書きます: ${fixedLine(asItems(args))}`, hintEn: `Put the positional parameters first: ${fixedLine(asItems(args))}` }),
          });
          // 順番どおりなら、そのパラメータとして続けて確かめる（ほかの誤りが重ならないように）
          if (!inOrder) continue;
          position++;
        }
        if (!(name in spec.params) && name === "if") {
          // 行の if=(式) は構文解析が外す。ここに来るのは本文の中の {@…} と @with の行
          report("error", "bad-guard", line, "if= は命令の行にだけ書けます（本文の中の {@…} と @with には書けません）", { column: a.column, hint: "@if 〜 @end で囲みます" });
          continue;
        }
        if (!(name in spec.params)) {
          report("error", "unknown-param", line, `@${spec.name} に ${name} というパラメータはありません`, {
            column: a.column,
            ...hintFrom(name, Object.keys(spec.params), (n) => `${n}=`),
          });
          continue;
        }
      }
      if (given.has(name)) {
        report("error", "duplicate-param", line, `${name} が二回指定されています`, { column: a.column });
        continue;
      }
      given.set(name, a);
      if (a.value.kind === "expr") {
        // 式の値の型は実行時に確かめる。ここでは使っている変数と関数だけ見る。
        checkExpr(a.value.expr, line, locals);
        continue;
      }
      const type = spec.params[name]!.type;
      if (type.kind === "variable" && a.value.kind === "string" && a.value.value.split(".").some((p) => FORBIDDEN_PROPERTIES.has(p))) {
        report("error", "forbidden-property", line, `${name}: ${a.value.value} は使えません（__proto__、constructor、prototype は変数の名前やキーに使えません）`, { column: a.column });
        continue;
      }
      // プレイを終える命令の ending=true は、真偽の字面でなくエンディングの種類の true（種類の検査は endings.ts の checkEndings）
      const endingTrue = spec.ends === true && name === "ending" && a.value.kind === "bool" && a.value.value;
      const problem = endingTrue ? null : typeProblem(type, a.value, castNames);
      if (problem) {
        // 値だけを直した形（fade=300 → fade=300ms、名前なしの 300 → 300ms）を、行に当てる直し方にする。名前は書いたまま（前の名前の fade= も）
        const fixed = problem.value !== undefined ? { kind: "replace" as const, find: writtenArg(raw), with: `${raw.key === null ? "" : `${raw.key}=`}${problem.value}` } : problem.fix;
        report("error", "bad-value", line, `${raw.key ?? name}: ${problem.message}`, { column: a.column, ...(problem.hint ? { hint: problem.hint } : {}), ...(fixed ? { fix: fixed, fixes: [fixed] } : {}) });
      }
      else if (type.kind === "target" && a.value.kind === "string") checkTarget(parseTargetText(a.value.value)!, line, locals);
      if (!problem && !bare.has(a.column) && spec.params[name]!.projectDefault && sameLiteral(a.value, spec.params[name]!.default)) sameAsDefault.push({ a, name });
    }
    for (const { a, name } of sameAsDefault) {
      // 名前なしの引数は、後ろに名前なしの引数が無いときだけ（外すと後ろの引数の読み方が変わる）
      if (a.key === null && args.some((b) => b.key === null && b.column > a.column)) continue;
      const text = writtenArg(a);
      const fix: DiagnosticFix = { kind: "replace", find: ` ${text}`, with: "" };
      report("info", "same-as-default", line, `@${spec.name} の ${name} は作品の既定値（commandDefaults）と同じ ${spec.params[name]!.default} です`, {
        column: a.column,
        hint: `${text} を外します（既定値を替えたときに、この行も一緒に替わります）`,
        fix,
        fixes: [fix],
      });
    }
    if (spec.name === "chara" && given.has("replace")) {
      for (const key of ["at", "x", "y", "clear", "solo"]) {
        if (given.has(key)) report("error", "chara-replace-conflict", line, `replace と ${key} は同時に指定できません`, { column: given.get(key)!.column });
      }
      const target = given.get("replace")!;
      // 立ち位置の名前（left、center、right と、立ち絵の枠の positions の名前。liminalia.json の autoLayout で並べる位置にも使う）は人物でなく位置
      const framed = Object.values(context.castEntries ?? {}).some((entry) =>
        Object.values(entry.appearances ?? {}).some((a) => Object.values(a.variants ?? {}).some((v) => Object.hasOwn(v.frame?.positions ?? {}, target.value.kind === "string" ? target.value.value : ""))));
      if (target.value.kind === "string" && !["left", "center", "right"].includes(target.value.value) && !framed && castNames && !castNames.has(target.value.value)) {
        report("error", "chara-replace-unknown", line, `入れ替え先 ${target.value.value} はキャストにありません`, { column: target.column });
      }
    }
    if (context.castEntries) checkSprite(spec, given, line, context.castEntries);
    for (const [name, p] of Object.entries(spec.params)) {
      if (p.required && !given.has(name)) {
        // その行に足した形（値は命令の例の値か、…）
        const added = fixedLine([...asItems(args), { name, text: `${name}=${exampleValue(spec.example, spec, name)}` }]);
        const addedEn = fixedLine([...asItems(args), { name, text: `${name}=${exampleValue(spec.exampleEn ?? spec.example, spec, name)}` }]);
        report("error", "missing-param", line, `@${spec.name} には ${name} が必要です`, { hint: `${name} を足します: ${added}`, hintEn: `Add ${name}: ${addedEn}` });
      }
      if (p.requiredUnless && !given.has(name) && !p.requiredUnless.some((other) => given.has(other))) {
        const added = fixedLine([...asItems(args), { name, text: `${name}=${exampleValue(spec.example, spec, name)}` }]);
        const addedEn = fixedLine([...asItems(args), { name, text: `${name}=${exampleValue(spec.exampleEn ?? spec.example, spec, name)}` }]);
        const others = p.requiredUnless.join("、");
        report("error", "missing-param", line, `@${spec.name} には ${name} か ${others} が必要です`, { hint: `${name} か ${others} を足します: ${added}`, hintEn: `Add ${name} or ${p.requiredUnless.join(", ")}: ${addedEn}` });
      }
      if (p.redundantWith && given.has(name) && p.redundantWith.every((other) => given.has(other))) {
        report("error", "redundant-param", line, `${p.redundantWith.join(" と ")} を書いたときは ${name} は使われません`, {
          column: given.get(name)!.column,
          hint: `${name}= を削除します`,
        });
      }
    }
  };

  /**
   * 立ち絵の引数（appearance / variant / position 型）を、同じ命令のキャストの定義と突き合わせる。
   * 値が式のものと、キャストが分からないものは見ない。
   */
  const checkSprite = (spec: CommandSpec, given: ReadonlyMap<string, Argument>, line: number, entries: Readonly<Record<string, CastEntry>>) => {
    const byKind = (kind: ParamType["kind"]) => {
      const name = Object.keys(spec.params).find((n) => spec.params[n]!.type.kind === kind);
      const arg = name === undefined ? undefined : given.get(name);
      if (arg) return arg.value.kind === "string" ? { value: arg.value.value, column: arg.column as number | undefined } : null;
      // 書かなかったものは作品の既定値（liminalia.json の commandDefaults）で確かめる（桁は無い）
      const def = name === undefined ? undefined : spec.params[name]!.default;
      return def !== undefined ? { value: def, column: undefined } : null;
    };
    const who = byKind("cast");
    const entry = who ? entries[who.value] : undefined;
    if (!entry || !entry.appearances) return;
    const keys = Object.keys(entry.appearances);
    if (keys.length === 0) {
      report("error", "unknown-appearance", line, `キャラクター ${who!.value} に立ち絵セットがありません`);
      return;
    }
    const appearance = byKind("appearance");
    if (appearance && !entry.appearances[appearance.value]) {
      report("error", "unknown-appearance", line, `${who!.value} に立ち絵セット ${appearance.value} はありません`, {
        column: appearance.column,
        ...hintFrom(appearance.value, keys, (n) => n),
      });
      return;
    }
    const variant = byKind("variant");
    if (!variant) return;
    const key = appearanceKey(entry, appearance?.value);
    const resolved = resolveVariant(entry, key, variant.value).variant;
    if (!resolved) {
      // ほかの立ち絵セットにある差分なら、その立ち絵セットを書けばよい。
      const elsewhere = keys.filter((k) => entry.appearances[k]?.variants?.[variant.value]);
      report("error", "unknown-variant", line, `${who!.value} の ${key} に差分 ${variant.value} はありません`, {
        column: variant.column,
        ...(elsewhere.length > 0
          ? { hint: elsewhere.map((k) => `appearance=${k}`).join(" / ") + " を書きます" }
          : hintFrom(variant.value, Object.keys(entry.appearances[key]?.variants ?? {}), (n) => n)),
      });
      return;
    }
    const at = byKind("position");
    if (at && at.value !== AUTO_POSITION && !positionNames(resolved).includes(at.value)) {
      const names = positionNames(resolved);
      report("error", "unknown-position", line, `${who!.value} の ${key} / ${variant.value} に立ち位置 ${at.value} はありません（${[...names, AUTO_POSITION].join(" / ")}）`, {
        column: at.column,
        ...hintFrom(at.value, [...names, AUTO_POSITION], (n) => n),
      });
    }
  };

  checkBlock(script.body, new Set());
  // 前に値を入れていないローカル変数を、@let x += 1 などで前の値から計算している（実行すると値の無いまま計算する誤りになる）。
  // 書いた順にたどり、前の行（@if の枝の中も）で @let したもの、マクロのパラメータ、@for の名前を、値のあるものとみなす
  const known = (body: readonly Statement[], has: Set<string>) => {
    for (const s of body) {
      if (s.kind === "let") {
        const v = s.value;
        if (!has.has(s.name) && v.kind === "binary" && ["+", "-", "*", "/"].includes(v.op) && v.left.kind === "name" && v.left.name === s.name) {
          report("warning", "uninitialized-variable", s.line, `ローカル変数 ${s.name} に値を入れる前に、前の値から計算しています（実行すると、値の無いまま計算する誤りになります）`, { hint: `前の行に @let ${s.name} = 0 を書きます` });
        }
        has.add(s.name);
      } else if (s.kind === "if") {
        if (s.each && s.each.name !== "") has.add(s.each.name);
        for (const b of s.branches) known(b.body, has);
      } else if (s.kind === "define") known(s.body, new Set(s.params.map((p) => paramLocalName(p.name))));
    }
  };
  known(script.body, new Set());
  out.push(...checkPunctuation(script, context.punctuation, context.sourceLanguage));
  // 立ち絵のちらつき（消した直後の出し直し、台詞ごとの全消し）
  out.push(...checkSpriteFlicker(script, registry));
  // @mask 〜 @mask-off の塊のうち、@scene-change 一つで同じ動きになるもの
  out.push(...sceneChangeCandidates(script, registry));
  return out;
}

function walk(body: Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) walk(b.body, fn);
    if (s.kind === "define") walk(s.body, fn);
  }
}

/** @define の中に @content があるか（@with の中身の中のものは数えない）。 */
function usesContent(body: readonly Statement[]): boolean {
  return body.some((s) => s.kind === "content" || (s.kind === "if" && !s.with && s.branches.some((b) => usesContent(b.body))));
}

function visitCalls(e: Expr, fn: (callee: string, count: number) => void): void {
  switch (e.kind) {
    case "call":
      fn(e.callee, e.args.length);
      for (const a of e.args) visitCalls(a, fn);
      break;
    case "member":
      visitCalls(e.object, fn);
      break;
    case "index":
      visitCalls(e.object, fn);
      visitCalls(e.index, fn);
      break;
    case "array":
      for (const a of e.items) visitCalls(a, fn);
      break;
    case "object":
      for (const x of e.entries) visitCalls(x.value, fn);
      break;
    case "unary":
      visitCalls(e.operand, fn);
      break;
    case "binary":
      visitCalls(e.left, fn);
      visitCalls(e.right, fn);
      break;
    case "conditional":
      visitCalls(e.test, fn);
      visitCalls(e.then, fn);
      visitCalls(e.otherwise, fn);
      break;
    case "literal":
    case "name":
      break;
  }
}

export function defineSpec(d: Extract<Statement, { kind: "define" }> | undefined): CommandSpec | undefined {
  if (!d) return undefined;
  const params: Record<string, CommandSpec["params"][string]> = {};
  for (const p of d.params) {
    const spec: CommandSpec["params"][string] = { type: paramTypeFromName(p.type) ?? { kind: "string" }, doc: "" };
    if (p.defaultValue === null) spec.required = true;
    else spec.default = printLiteral(p.defaultValue);
    params[p.name] = spec;
  }
  const block = usesContent(d.body);
  return { name: d.name, summary: d.doc ?? "", macro: true, ...(block ? { block: true } : {}), positional: [], params, example: `${block ? "@with " : "@"}${d.name} ${d.params.map((p) => `${p.name}=…`).join(" ")}` };
}

/**
 * 値の型の誤り。value はその値だけを直した書き方（分かるとき。呼ぶ側が `名前=値` の置き換えにする）、fix は値の一部の置き換え（綴りの近いキャラクターなど）。
 */
export function typeProblem(type: ParamType, v: Exclude<Literal, { kind: "expr" }>, cast: ReadonlySet<string> | undefined): { message: string; hint?: string; fix?: DiagnosticFix; value?: string } | null {
  switch (type.kind) {
    case "string":
    case "asset":
    case "appearance":
    case "variant":
    case "position":
      return v.kind === "string" ? null : { message: "文字列が必要です", hint: `"${literalSource(v)}"`, value: `"${literalSource(v)}"` };
    case "cast":
      if (v.kind !== "string") return { message: "キャラクター ID が必要です" };
      if (cast && !cast.has(v.value)) return { message: `キャラクター ${v.value} は登録されていません`, ...hintFrom(v.value, cast, (n) => n) };
      return null;
    case "enum": {
      if (v.kind === "string" && type.values.includes(v.value)) return null;
      const near = hintFrom(literalSource(v), type.values, (n) => n);
      return { message: `${type.values.join(" / ")} のどれかを指定します`, ...(near.hint && near.fix?.kind === "replace" ? { hint: near.hint, value: near.fix.with } : {}) };
    }
    case "target":
      if (v.kind === "string" && parseTargetText(v.value)) return null;
      {
        // ラベルの名前だけを書いたなら #ラベル の形にする
        const label = literalSource(v).replace(/^#+/, "").trim();
        return /^[\p{L}\p{N}_-]+$/u.test(label) ? { message: "ジャンプ先（#ラベル / ファイル / ファイル#ラベル）が必要です", hint: `#${label} と書きます`, value: `#${label}` } : { message: "ジャンプ先（#ラベル / ファイル / ファイル#ラベル）が必要です", hint: "#ラベル、ファイル、ファイル#ラベル のどれかで書きます" };
      }
    case "variable":
      if (v.kind === "string" && VARIABLE_PATH.test(v.value)) return null;
      {
        // game. などを付け忘れた名前なら game. を付ける
        const bare = literalSource(v).trim();
        return VARIABLE_PATH.test(`game.${bare}`) ? { message: "変数（game.x / system.x / temp.x）が必要です", hint: `game.${bare} と書きます（周回をまたぐなら system.${bare}）`, value: `game.${bare}` } : { message: "変数（game.x / system.x / temp.x）が必要です", hint: "game.名前、system.名前、temp.名前 のどれかで書きます" };
      }
    case "condition":
      return { message: "条件は ( ) で囲んだ式で書きます", hint: `(${literalSource(v)})`, value: `(${literalSource(v)})` };
    case "bool": {
      if (v.kind === "bool") return null;
      // はい・いいえ、yes・no、on・off、1・0 は true・false の書き間違い
      const word = literalSource(v).toLowerCase();
      const value = TRUE_WORDS.has(word) ? "true" : FALSE_WORDS.has(word) ? "false" : undefined;
      return { message: "true か false を指定します", ...(value ? { hint: `${value} と書きます`, value } : {}) };
    }
    case "color": {
      if (v.kind === "color") return null;
      // # を付け忘れた色（ff0000）
      const text = literalSource(v);
      const value = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text) ? `#${text.toLowerCase()}` : undefined;
      return { message: "色を #rgb / #rrggbb / #rrggbbaa で指定します", ...(value ? { hint: `${value} と書きます`, value } : {}) };
    }
    case "duration": {
      if (v.kind === "duration") return v.ms < 0 ? { message: "負の時間は指定できません" } : null;
      // 単位の無い時間。小さな数（10 未満）は秒、それより大きければミリ秒のつもりとみなす
      if (v.kind === "number") {
        const value = v.value < 10 ? `${v.value}s` : `${v.value}ms`;
        return { message: "時間には単位が必要です", hint: `${value} と書きます`, value };
      }
      return { message: "時間（例: 300ms、1.5s）が必要です" };
    }
    case "number":
    case "int": {
      if (v.kind !== "number") return { message: "数値が必要です" };
      if (type.kind === "int" && !Number.isInteger(v.value)) return { message: "整数が必要です" };
      if (type.min !== undefined && v.value < type.min) return { message: `${type.min} 以上を指定します` };
      if (type.max !== undefined && v.value > type.max) return { message: `${type.max} 以下を指定します` };
      return null;
    }
  }
}

const TRUE_WORDS: ReadonlySet<string> = new Set(["yes", "on", "1", "はい", "オン"]);
const FALSE_WORDS: ReadonlySet<string> = new Set(["no", "off", "0", "いいえ", "オフ"]);

/** 本文に残った TyranoScript のタグと、置き換える書き方。 */
const TYRANO_TAG = /\[(p|l|r|cm|er)\]/g;
const TYRANO_REPLACE: Readonly<Record<string, string>> = { p: "", l: "{click}", r: "{br}", cm: "", er: "" };

/**
 * 台本の書き方の癖で、台詞にならない行の形（アカリ：「…」、【アカリ】「…」、話者のアカリ：…）。直すと台詞になる書き方（with）と、
 * 行の中で置き換える所（find）を返す。名前の後の「：」のあとに括弧が無い形は、登録した話者だけ見る（「注意：…」などの地の文があるため）。
 * 半角の : は、登録した話者と、日本語の括弧が続くものと、scriptNames の名前（同じファイルで脚本の形に書いた名前。colonSpeechNames）だけ見る。
 */
export function markedSpeech(
  text: string,
  speakers: readonly string[],
  japanese = true,
  scriptNames: ReadonlySet<string> = new Set(),
): { kind: "bracket" | "colon"; name: string; mark: string; find: string; with: string } | null {
  const bracket = /^【([^【】\s]{1,20})】[ 　]*/.exec(text);
  if (bracket && speechShape(`${bracket[1]}${text.slice(bracket[0].length)}`)) {
    const rest = text.slice(bracket[0].length);
    const join = isSpeechQuote(rest[0] ?? "") ? " " : "";
    return { kind: "bracket", name: bracket[1]!, mark: "【】", find: bracket[0], with: `${bracket[1]}${join}` };
  }
  const colon = /^([^\s【】「」『』（）()：:]{1,20})([：:])[ 　]*/.exec(text);
  if (!colon || !/[\p{L}\p{N}]/u.test(colon[1]!)) return null;
  const rest = text.slice(colon[0].length);
  // 半角の : は英語の地の文（Note: "x"）にもあるので、登録した話者と、日本語の括弧が続くものと、脚本の形の名前だけ見る
  if (colon[2] === ":" && !speakers.includes(colon[1]!) && !/^[「『（]/.test(rest) && !scriptNames.has(colon[1]!)) return null;
  if (speechShape(`${colon[1]}${rest}`)) {
    const join = isSpeechQuote(rest[0] ?? "") ? " " : "";
    return { kind: "colon", name: colon[1]!, mark: colon[2]!, find: colon[0], with: `${colon[1]}${join}` };
  }
  if (speakers.includes(colon[1]!) && rest.trim() !== "") {
    const quoted = japanese ? `「${rest.trim()}」` : ` "${rest.trim()}"`;
    return { kind: "colon", name: colon[1]!, mark: colon[2]!, find: text, with: `${colon[1]}${quoted}` };
  }
  return null;
}

/** 英字の大文字で始まる名前と半角の :、そのあとの引用符か ( の台詞（Nora: "Hello."）。 */
const COLON_SPEECH = /^([A-Z][\p{L}\p{N}_'-]{0,19}):[ 　]*(?=["“(])/u;

/**
 * 地の文の行のうち、英字の大文字で始まる名前と半角の : のあとに台詞の引用符が続く形（Nora: "Hello."）が、同じ名前で二行以上あるものの名前。
 * 脚本の形で書いたまま、名前を話者に足していないとみなす（一行だけなら英語の地の文の Note: "x" かもしれないので数えない）。
 */
export function colonSpeechNames(body: readonly Statement[]): Set<string> {
  const counts = new Map<string, number>();
  const visit = (list: readonly Statement[]) => {
    for (const s of list) {
      if (s.kind === "prose") {
        const text = printInline(s.content);
        const m = COLON_SPEECH.exec(text);
        if (m && speechShape(`${m[1]}${text.slice(m[0].length)}`)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
      } else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(body);
  return new Set([...counts].filter(([, n]) => n >= 2).map(([name]) => name));
}

function literalSource(v: Literal): string {
  switch (v.kind) {
    case "string":
      return v.value;
    case "expr":
      return `(${v.source})`;
    case "duration":
      return v.source;
    case "number":
    case "bool":
    case "color":
      return String(v.value);
  }
}

/** 行の頭の短い名前（記号・空白を含まない 20 字まで）と、その後の空白と括弧か引用符。 */
const SPEECH_HEAD = /^([^\s「」『』（）()【】[\]：:、。，．,.!?！？…・"“”]{1,20})([ 　]*)([「『（("“])/u;

/**
 * 台詞の形か（名前のすぐ後に括弧か引用符が始まり、それが行の終わりで閉じる）。地の文の `それは「愛」だった。` は括弧が行末で
 * 閉じないので当たらず、全角空白で字下げした地の文も当たらない。spaced は台詞にならない空白があるか
 * （括弧の前の空白すべてと、引用符の前の半角の一つ以外の空白）。
 */
export function speechShape(text: string): { name: string; spaced: boolean; open: string } | null {
  const m = SPEECH_HEAD.exec(text);
  // 名前は文字か数字を含む（`――『…』` のような地の文は当たらない）
  if (!m || !/[\p{L}\p{N}]/u.test(m[1]!)) return null;
  const open = m[3]!;
  const close = SPEECH_CLOSE[open]!;
  const body = text.slice(m[0].length - open.length).trimEnd();
  if (body.length < 2 || !body.endsWith(close)) return null;
  const spaced = isSpeechQuote(open) ? m[2] !== "" && m[2] !== " " : m[2] !== "";
  // " は始まりと閉じが同じ字なので入れ子にならない（次の " が行の終わり）
  if (open === close) return body.indexOf(close, 1) === body.length - 1 ? { name: m[1]!, spaced, open } : null;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close && --depth === 0 && i !== body.length - 1) return null;
  }
  return depth === 0 ? { name: m[1]!, spaced, open } : null;
}

/**
 * 綴りの近い候補を修正案にする（候補が無いか遠ければ空）。修正案と一緒に、行の中の書き方を置き換える直し方（fix）も返す。
 * fixFormat は行に書いてある形（省くと format。関数なら "名前(" のように、表示と書き方が違うときに渡す）。
 */
export function hintFrom(word: string, candidates: Iterable<string>, format: (s: string) => string, fixFormat: (s: string) => string = format): { hint?: string; fix?: DiagnosticFix } {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  if (best === null || bestDistance > Math.max(2, Math.floor(word.length / 3))) return {};
  return { hint: `${format(best)} のことですか？`, fix: { kind: "replace", find: fixFormat(word), with: fixFormat(best) } };
}

/**
 * 名前（ラベル・ファイル）の綴りの近い候補。hintFrom より狭く、違う字が名前の長さの 4 分の 1（短い名前なら 1 字）までのものだけ
 * （#stay に #start を勧めない）。
 */
export function nearName(word: string, candidates: Iterable<string>, format: (s: string) => string): { hint?: string; fix?: DiagnosticFix } {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = typoDistance(word, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  if (best === null || bestDistance > Math.max(1, Math.floor(word.length / 4))) return {};
  return { hint: `${format(best)} のことですか？`, fix: { kind: "replace", find: format(word), with: format(best) } };
}

/** 打ち間違いの近さ（隣り合う二字の入れ替え（strat → start）も一字の違いと数える編集距離）。 */
export function typoDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = d;
    }
  }
  return rows[a.length]![b.length]!;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** 直した形の行に並べる引数（name はパラメータの名前、text は書いた形の `name=値` か値）。 */
interface FixedArg {
  name: string;
  text: string;
}

/**
 * 直した形の命令の行（その行の書き間違いの修正案に見せる）。名前なしで書けるパラメータは、前から続くものだけ名前を外して前に並べ、
 * 間が空いたらそこからは名前を付けたまま後ろに並べる（名前なしの値が別のパラメータに読まれないように）。
 */
function fixedCommandLine(spec: CommandSpec, items: readonly FixedArg[]): string {
  const used = new Set<FixedArg>();
  const front: string[] = [];
  for (const p of spec.positional) {
    const item = items.find((i) => i.name === p);
    if (!item) break;
    used.add(item);
    front.push(item.text.startsWith(`${p}=`) ? item.text.slice(p.length + 1) : item.text);
  }
  const rest = items.filter((i) => !used.has(i)).map((i) => (i.text.includes("=") || !i.name ? i.text : `${i.name}=${i.text}`));
  return [`@${spec.name}`, ...front, ...rest].join(" ");
}

/** 命令の例（spec.example）に書いてあるそのパラメータの値（無ければ …）。足した形の行の値の見本にする。 */
function exampleValue(example: string | undefined, spec: CommandSpec, name: string): string {
  const m = /^@[a-z0-9-]+\s+(.*)$/.exec(example ?? "");
  if (!m) return "…";
  let at = 0;
  for (const a of parseArgs(m[1]!, 1).args) {
    const key = a.key ?? spec.positional[at++];
    if (key === name) return printLiteral(a.value);
  }
  return "…";
}
