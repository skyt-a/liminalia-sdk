import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * ソースの文字列を構文木から集める（診断と書き出しの経過の英語の表が、原文と合っているかを確かめるテストが使う）。
 * テンプレート文字列の ${…} は X に置き換える（表の形の {n} に当てはまる）。三項演算子などの枝も一つずつ拾う。
 */
export const JAPANESE = /[぀-ヿ㐀-鿿]/;

function parseFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function materialize(n: ts.Node): string | null {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => `X${s.literal.text}`).join("");
  return null;
}

/** ファイルの中の、日本語を含む文字列のすべて。 */
export function japaneseStrings(root: string, files: readonly string[]): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const file of files) {
    const path = join(root, file);
    const sf = parseFile(path);
    const walk = (n: ts.Node): void => {
      const text = materialize(n);
      if (text !== null && JAPANESE.test(text)) out.push({ where: `${relative(root, path)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, text });
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

/** 指定した名前の関数（new も）に渡した、日本語を含む文字列（console.log なら "console.log"）。枝と入れ子の ${…} の中も拾う。 */
export function japaneseArguments(root: string, files: readonly string[], callees: ReadonlySet<string>): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const file of files) {
    const path = join(root, file);
    const sf = parseFile(path);
    const strings = (n: ts.Node): void => {
      if (ts.isConditionalExpression(n)) return [n.whenTrue, n.whenFalse].forEach(strings);
      if (ts.isBinaryExpression(n)) return [n.left, n.right].forEach(strings);
      if (ts.isParenthesizedExpression(n)) return strings(n.expression);
      const text = materialize(n);
      if (text !== null && JAPANESE.test(text)) out.push({ where: `${relative(root, path)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, text });
      if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) strings(s.expression);
    };
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const e = n.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `${e.expression.getText()}.${e.name.text}` : "";
        if (callees.has(name)) n.arguments?.forEach(strings);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

/** 診断の code（`code: "x"` と、`report("error", "x", …)` のように重大さの次に書く形）。 */
export function diagnosticCodes(root: string, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    const sf = parseFile(join(root, file));
    const walk = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText() === "code" && ts.isStringLiteralLike(n.initializer)) out.add(n.initializer.text);
      if (ts.isCallExpression(n) && n.arguments.length >= 2) {
        const [a, b] = n.arguments;
        if (a && b && ts.isStringLiteralLike(a) && /^(error|warning|info)$/.test(a.text) && ts.isStringLiteralLike(b)) out.add(b.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

/**
 * 行の一部を置き換える直し方（`kind: "replace"`）を付ける診断の code。直し方を作る所から上の囲み（ブロック）へたどり、
 * 最初に code の見つかった囲みの code を拾う。直し方を作る関数（hintFrom など、中に code の無い関数）なら、その関数を呼ぶ所から同じようにたどる。
 * 呼んだ結果の hint だけを使う所（`hintFrom(…).hint`）は数えない。
 */
export function replaceFixCodes(root: string, files: readonly string[]): Map<string, string[]> {
  const sources = files.map((file) => ({ file, sf: parseFile(join(root, file)) }));
  const codesIn = (n: ts.Node): Set<string> => {
    const out = new Set<string>();
    const walk = (m: ts.Node): void => {
      if (ts.isPropertyAssignment(m) && m.name.getText() === "code" && ts.isStringLiteralLike(m.initializer)) out.add(m.initializer.text);
      if (ts.isCallExpression(m) && m.arguments.length >= 2) {
        const [a, b] = m.arguments;
        if (a && b && ts.isStringLiteralLike(a) && /^(error|warning|info)$/.test(a.text) && ts.isStringLiteralLike(b)) out.add(b.text);
      }
      ts.forEachChild(m, walk);
    };
    walk(n);
    return out;
  };
  /** code → 見つけた所（ファイル:行）。 */
  const found = new Map<string, string[]>();
  const add = (code: string, where: string) => (found.get(code) ?? found.set(code, []).get(code)!).push(where);
  const seenHelpers = new Set<string>();
  const climb = (start: ts.Node, where: string): void => {
    for (let n: ts.Node | undefined = start.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) && n.name) {
        // code の無い関数の中: 呼ぶ所からたどる
        const name = n.name.text;
        if (seenHelpers.has(name)) return;
        seenHelpers.add(name);
        for (const { file, sf } of sources) {
          const visit = (m: ts.Node): void => {
            if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === name) follow(m, `${where} ← ${file}:${sf.getLineAndCharacterOfPosition(m.getStart()).line + 1}`);
            ts.forEachChild(m, visit);
          };
          visit(sf);
        }
        return;
      }
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isObjectLiteralExpression(n) || ts.isCallExpression(n)) {
        const codes = codesIn(n);
        if (codes.size > 0) {
          for (const c of codes) add(c, where);
          return;
        }
      }
    }
  };
  /**
   * 直し方を返す関数の呼び出しから、直し方が渡る所をたどる。変数に入れたなら、その変数をそのまま渡す所（引数、...、プロパティの値）と .fix を読む所から。
   * .hint や .message だけを読む所と、条件に使う所はたどらない。
   */
  function follow(call: ts.Expression, where: string): void {
    // 三項演算子、??、括弧の中なら、その外の式から
    while (ts.isConditionalExpression(call.parent) || ts.isParenthesizedExpression(call.parent) || ts.isAsExpression(call.parent) || ts.isNonNullExpression(call.parent) || (ts.isBinaryExpression(call.parent) && /^(\?\?|\|\|)$/.test(call.parent.operatorToken.getText()))) call = call.parent as ts.Expression;
    const parent = call.parent;
    if (ts.isPropertyAccessExpression(parent)) {
      if (parent.name.text === "fix") climb(parent, where);
      return;
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const variable = parent.name.text;
      let scope: ts.Node = parent;
      while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      const refs = (m: ts.Node): void => {
        if (ts.isIdentifier(m) && m.text === variable && m !== parent.name) {
          const up = m.parent;
          if (ts.isPropertyAccessExpression(up) && up.expression === m) {
            if (up.name.text === "fix") climb(up, where);
          } else if (ts.isSpreadAssignment(up) || ts.isSpreadElement(up) || ts.isPropertyAssignment(up) || ts.isShorthandPropertyAssignment(up) || (ts.isCallExpression(up) && up.arguments.includes(m as ts.Expression))) climb(m, where);
          else if (ts.isReturnStatement(up)) climb(m, where);
        }
        ts.forEachChild(m, refs);
      };
      refs(scope);
      return;
    }
    climb(call, where);
  }
  for (const { file, sf } of sources) {
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n) && n.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === "kind" && ts.isStringLiteralLike(p.initializer) && p.initializer.text === "replace" || (ts.isPropertyAssignment(p) && p.name.getText() === "kind" && ts.isAsExpression(p.initializer) && ts.isStringLiteralLike(p.initializer.expression) && p.initializer.expression.text === "replace"))) {
        climb(n, `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}
