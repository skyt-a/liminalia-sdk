/**
 * 型から JSON Schema を作る（scripts/config-schema.ts とテストが使う）。TypeScript の型の検査器で、
 * プロパティ、入れ子の記録、文字の候補（"user" | "portable"）、配列、辞書（Record）、文書の注釈（説明）を読む。
 */
import { join } from "node:path";
import ts from "typescript";

/** 作ったものを置く場所（リポジトリの直下から）。 */
export const SCHEMA_OUTPUTS = ["packages/project/schemas", "packages/vscode/schemas"] as const;
/** VS Code の拡張機能だけに置くもの（vscodeOnlySchemas）の場所。 */
export const VSCODE_SCHEMA_DIR = "packages/vscode/schemas";

type Schema = Record<string, unknown>;

/**
 * VS Code の拡張機能だけに置く Schema。lang-file.schema.json は jsonValidation の lang/*.json に当てるもので、Liminalia の訳のファイルの形
 * （language と lines がある。lim i18n と Studio が書く形）のときだけ訳の Schema で補完して確かめ、ほかの作品の lang/*.json（Web の訳など）には何も言わない。
 * 訳の Schema は中に写す（$ref で別のファイルを読ませない）。
 */
export function vscodeOnlySchemas(schemas: Record<string, Schema>): Record<string, Schema> {
  const { $schema: _schema, title: _title, ...lang } = schemas["lang.schema.json"]!;
  return {
    "lang-file.schema.json": {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "lang/<言語>.json（Liminalia の訳。language と lines のあるファイルだけ）",
      if: { type: "object", required: ["language", "lines"] },
      then: lang,
    },
  };
}

/** liminalia.schema.json・cast.schema.json・lang.schema.json。 */
export function generateConfigSchemas(repo: string): Record<string, Schema> {
  const projectFile = join(repo, "packages/project/src/index.ts");
  const program = ts.createProgram([projectFile], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, strict: true, noEmit: true, exactOptionalPropertyTypes: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const find = (fileSuffix: string, name: string): ts.Type => {
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.endsWith(fileSuffix)) continue;
      for (const st of sf.statements) {
        if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name.text === name) return checker.getTypeAtLocation(st.name);
      }
    }
    throw new Error(`${fileSuffix} に ${name} がありません`);
  };
  const toSchema = (type: ts.Type, depth: number, seen: readonly ts.Type[]): Schema => {
    if (depth > 12 || seen.includes(type)) return {};
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (type.isUnion()) {
      const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
      if (parts.length > 0 && parts.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) return { type: "boolean" };
      if (parts.length > 0 && parts.every((t) => t.isStringLiteral())) return { enum: parts.map((t) => (t as ts.StringLiteralType).value) };
      if (parts.length === 1) return toSchema(parts[0]!, depth, seen);
      // true | false と記録など、真偽を一つにまとめる
      const bools = parts.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
      const rest = parts.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral));
      return { anyOf: [...(bools.length > 0 ? [{ type: "boolean" }] : []), ...rest.map((t) => toSchema(t, depth + 1, seen))] };
    }
    if (type.flags & ts.TypeFlags.StringLiteral) return { enum: [(type as ts.StringLiteralType).value] };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { enum: [(type as ts.NumberLiteralType).value] };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean" };
    if (type.flags & ts.TypeFlags.String) return { type: "string" };
    if (type.flags & ts.TypeFlags.Number) return { type: "number" };
    if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      return { type: "array", ...(element ? { items: toSchema(element, depth + 1, [...seen, type]) } : {}) };
    }
    if (type.flags & ts.TypeFlags.Object) {
      const props = checker.getPropertiesOfType(type);
      const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
      if (type.getCallSignatures().length > 0) return {};
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const p of props) {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const t = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getDeclaredTypeOfSymbol(p);
        const description = ts.displayPartsToString(p.getDocumentationComment(checker)).trim();
        properties[p.name] = { ...(description ? { description } : {}), ...toSchema(t, depth + 1, [...seen, type]) };
        if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
      }
      return {
        type: "object",
        ...(props.length > 0 ? { properties } : {}),
        ...(required.length > 0 && props.length > 0 ? { required } : {}),
        additionalProperties: index ? toSchema(index.type, depth + 1, [...seen, type]) : props.length > 0 ? false : true,
      };
    }
    return {};
  };
  const project = toSchema(find("project/src/index.ts", "ProjectConfig"), 0, []);
  // エディタが Schema を読むための $schema を認める
  (project.properties as Record<string, Schema>).$schema = { type: "string", description: "この Schema の場所（エディタの補完と説明に使う）" };
  const castEntry = toSchema(find("lang/src/cast.ts", "CastEntry"), 0, []);
  const cast: Schema = {
    type: "object",
    properties: {
      $schema: { type: "string", description: "この Schema の場所（エディタの補完と説明に使う）" },
      speakers: { type: "array", items: { type: "string" }, description: "台詞の話者として認める名前（名前欄に出す名前）。行頭がこの名前で、すぐ後に括弧か引用符が来る行が台詞になる" },
      cast: { type: "object", additionalProperties: castEntry, description: "キャラクター（立ち絵の持ち主）。名前 → 立ち絵セット・差分・立ち位置など" },
    },
    additionalProperties: false,
  };
  const lang = toSchema(find("lang/src/i18n.ts", "TranslationFile"), 0, []);
  (lang.properties as Record<string, Schema>).$schema = { type: "string", description: "この Schema の場所（エディタの補完と説明に使う）" };
  const head = (title: string, body: Schema): Schema => ({ $schema: "http://json-schema.org/draft-07/schema#", title, ...body });
  return {
    "liminalia.schema.json": head("liminalia.json（Liminalia の作品の設定）", project),
    "cast.schema.json": head("cast.json（Liminalia の話者とキャラクター）", cast),
    "lang.schema.json": head("lang/<言語>.json（Liminalia の訳）", lang),
  };
}
