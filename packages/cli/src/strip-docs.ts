import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { Plugin } from "vite";

/**
 * 書き出すエンジン（プレイヤーの束）から、命令の説明文（要約、パラメータの説明、例、探す言葉と、その英語）を外す（lim build）。
 * 説明文は制作画面、VS Code、lim reference、AI の手引きが読むもので、遊ぶ側は読まない（lim check の直し方の例（hint）に
 * example を使うが、書き出したゲームでは画面に出さない）。命令の名前、パラメータの名前と型と既定の値は残す。
 *
 * 外すもの:
 * - 命令の表（@liminalia/lang の registry.ts、registry-play.ts、command-meta.ts と、標準の命令 @liminalia/std の commands/*.ts）:
 *   summary、summaryEn、doc、docEn、example、exampleEn、keywords、keywordsEn の文字列（と文字列の並び。中に式のある `…` も）。
 *   パラメータを作る部品の説明の引数（doc・docEn という名前の引数を持つ部品と、SDK の t.text("説明", …) など）と、
 *   作品のデータの形の見出しを作る部品の見出しの引数（label・labelEn という名前の引数。制作画面のフォームと lim check だけが読む）
 * - 英語の表（registry-en.ts と std の commands/en.ts）: 値の文字列すべてと、export した表（オブジェクト）の中身ごと。
 *   遊ぶ側は英語の説明を読まないので、表は空のオブジェクトにする（withEnglish は表に無い命令をそのまま返す）
 */

const DOC_KEYS = new Set(["summary", "summaryEn", "doc", "docEn", "example", "exampleEn", "keywords", "keywordsEn", "preview"]);
/** SDK の t の部品の、説明の引数の位置（ほかは 0）。 */
const T_DOC_ARG: Record<string, number> = { enum: 1, asset: 1, dataKey: 2 };
/** 部品の引数のうち、外す説明と見出しの名前。 */
const DOC_PARAMS = new Set(["doc", "docEn", "label", "labelEn"]);
const T_NO_DOC = new Set(["required", "skip"]);

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && typeof (v as Node).type === "string";
const isString = (n: unknown): boolean => isNode(n) && ((n.type === "Literal" && typeof n.value === "string") || (n.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0));
const keyName = (n: Node): string | null => {
  const key = n.key as Node;
  if (n.computed) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
};

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const [k, v] of Object.entries(node)) if (k !== "type" && k !== "start" && k !== "end" && typeof v === "object" && v !== null) walk(v, visit);
}

/** 文字列（中に式のある `…` も）か文字列の並びなら、空のものに置き換える文。違えば null。 */
function emptied(value: Node): string | null {
  if (isString(value) || value.type === "TemplateLiteral") return '""';
  if (value.type === "ArrayExpression" && (value.elements as unknown[]).length > 0 && (value.elements as unknown[]).every(isString)) return "[]";
  return null;
}

/**
 * JS（TypeScript を外したもの）と、その AST（ESTree。start と end を持つ）から説明文を外した JS を返す。
 * table なら英語の表として、値の文字列をすべて外す。
 */
export function stripDocs(code: string, ast: unknown, table: boolean): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const replace = (n: Node, text: string) => edits.push({ start: n.start, end: n.end, text });
  // 英語の表: export const X = { … } は中身ごと空にする（下の文字列の置き換えより外側なので、こちらが残る）
  if (table && isNode(ast)) {
    for (const st of (ast.body as Node[] | undefined) ?? []) {
      const decl = st.type === "ExportNamedDeclaration" && isNode(st.declaration) ? st.declaration : null;
      if (decl?.type !== "VariableDeclaration") continue;
      for (const d of decl.declarations as Node[]) if (isNode(d.init) && d.init.type === "ObjectExpression") replace(d.init, "{}");
    }
  }
  // doc・docEn・label・labelEn という名前の引数を持つ、この中で作った部品（const duration = (doc, def) => …、function f(doc) {…}）の、その引数の位置
  const helpers = new Map<string, number[]>();
  walk(ast, (n) => {
    const fn = n.type === "VariableDeclarator" && (n.id as Node).type === "Identifier" && isNode(n.init) ? n.init : n.type === "FunctionDeclaration" && isNode(n.id) ? n : null;
    if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression" && fn.type !== "FunctionDeclaration")) return;
    const at = (fn.params as Node[]).flatMap((p, i) => {
      const id = p.type === "AssignmentPattern" ? (p.left as Node) : p;
      return id.type === "Identifier" && DOC_PARAMS.has(id.name as string) ? [i] : [];
    });
    if (at.length > 0) helpers.set((n.id as Node).name as string, at);
  });
  walk(ast, (n) => {
    if (n.type === "Property" && !n.shorthand) {
      const value = n.value as Node;
      const name = keyName(n);
      if (table || (name !== null && DOC_KEYS.has(name))) {
        const text = emptied(value);
        if (text) replace(value, text);
        // パーツの見本（preview: { lines: […], reset: […] }）
        else if (name === "preview" && value.type === "ObjectExpression") {
          for (const p of value.properties as Node[]) {
            const inner = p.type === "Property" ? emptied(p.value as Node) : null;
            if (inner) replace(p.value as Node, inner);
          }
        }
      }
      return;
    }
    if (table && n.type === "VariableDeclarator" && isNode(n.init) && isString(n.init)) {
      replace(n.init, '""');
      return;
    }
    if (n.type === "CallExpression") {
      const callee = n.callee as Node;
      const args = n.arguments as Node[];
      let at: number[] = [];
      if (callee.type === "Identifier" && helpers.has(callee.name as string)) at = helpers.get(callee.name as string)!;
      else if (callee.type === "MemberExpression" && !callee.computed && (callee.object as Node).type === "Identifier" && (callee.object as Node).name === "t") {
        const method = (callee.property as Node).name as string;
        if (!T_NO_DOC.has(method)) at = [T_DOC_ARG[method] ?? 0];
      }
      for (const i of at) {
        const arg = args[i];
        if (arg && (isString(arg) || arg.type === "TemplateLiteral")) replace(arg, '""');
      }
    }
  });
  // 重なる置き換え（外側を先に）を除き、後ろから当てる
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof edits = [];
  for (const e of edits) if (!kept.some((k) => e.start >= k.start && e.end <= k.end)) kept.push(e);
  let out = code;
  for (const e of kept.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** パッケージのフォルダ（入口のファイルから package.json のあるところまで上る）。 */
function packageDir(name: string): string | null {
  try {
    let dir = dirname(realpathSync(createRequire(import.meta.url).resolve(name)));
    while (!existsSync(join(dir, "package.json"))) {
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    return dir;
  } catch {
    // 見つからなければ外さない（説明文が残るだけで、動きは変わらない）
    return null;
  }
}

/** 説明文を外す Vite のプラグイン（書き出しのときだけ）。 */
export function stripCommandDocs(): Plugin {
  const lang = packageDir("@liminalia/lang");
  const std = packageDir("@liminalia/std/commands");
  const specs = new Set([...(lang ? ["registry.ts", "registry-play.ts", "command-meta.ts"].map((f) => join(lang, "src", f)) : [])]);
  const tables = new Set([...(lang ? [join(lang, "src", "registry-en.ts")] : []), ...(std ? [join(std, "src", "commands", "en.ts")] : [])]);
  const stdCommands = std ? join(std, "src", "commands") + sep : null;
  return {
    name: "liminalia-strip-command-docs",
    apply: "build",
    enforce: "post",
    transform(code, id) {
      const file = id.split("?")[0]!;
      const table = tables.has(file);
      if (!table && !specs.has(file) && !(stdCommands && file.startsWith(stdCommands) && file.endsWith(".ts"))) return null;
      return { code: stripDocs(code, this.parse(code), table), map: null };
    },
  };
}

/**
 * 標準の画面のテンプレート（@liminalia/screens の src/*.ts）から、要素の間の字下げと改行を外す（書き出しのときだけ）。
 * 遊ぶ側は、改行を含む空白だけの文字を読むときに捨てる（system/template.ts の sanitize）ので、外しても作る画面は同じ。
 * 書き出したエンジンの大きさのため（docs/design/screen-templates.md）。
 */
export function squeezeScreenTemplates(): Plugin {
  const dir = packageDir("@liminalia/screens");
  const screens = dir ? join(dir, "src") + sep : null;
  return {
    name: "liminalia-squeeze-screen-templates",
    apply: "build",
    enforce: "post",
    transform(code, id) {
      const file = id.split("?")[0]!;
      if (!screens || !file.startsWith(screens) || !file.endsWith(".ts")) return null;
      return { code: squeezeTemplates(code), map: null };
    },
  };
}

/** 要素の間の、改行を含む空白だけを外す（`>` と `<` の間）。文の中の空白（改行を含まないもの）は残す。 */
export function squeezeTemplates(code: string): string {
  return code.replace(/>[ \t]*\n\s*</g, "><");
}
