/**
 * lim mcp の道具の形と、返事を作る小さな部品（mcp.ts と、制作画面の口を使う道具の mcp-studio.ts が共に使う）。
 */

/** 子のコマンドの返事を AI に渡す長さの上限（長い経過は頭と終わりだけにする）。 */
export const MAX_TEXT = 60_000;

export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

/** 道具の使い方の誤り（AI に直し方と一緒に返す）。 */
export class ToolError extends Error {}

export function clip(t: string): string {
  if (t.length <= MAX_TEXT) return t;
  const half = MAX_TEXT / 2;
  return `${t.slice(0, half)}\n…（${t.length - MAX_TEXT} 文字を省略）…\n${t.slice(-half)}`;
}

export const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: clip(t) }], ...(isError ? { isError } : {}) });

export const str = (args: Record<string, unknown>, key: string): string | undefined => (typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined);

export function need(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (v === undefined) throw new ToolError(`${key} を指定してください`);
  return v;
}

/**
 * 道具と引数の説明。日本語の次の行に英語を書く。
 * MCP の説明は一つの文字列で、initialize でも使う人の言語は伝わらない（環境変数の LANG は AI のアプリが起こすプロセスでは当てにならない）。
 * 読むのは AI なので、両方を書いておけばどちらの言語の利用者にも足りる。
 */
export const both = (ja: string, en: string): string => `${ja}\n${en}`;

/** 作品の指定の説明（command_reference は後ろに添え書きをするので、言語ごとに分けて持つ）。 */
export const PROJECT_DESCRIPTION = {
  ja: "プロジェクトの名前（保存先フォルダの中のフォルダ名）か、保存先フォルダの中の絶対パス",
  en: "Project name (a folder in the project root) or an absolute path inside the project root",
} as const;

/** 作品の指定（どの道具も同じ書き方）。 */
export const PROJECT_PARAM = { type: "string", description: both(PROJECT_DESCRIPTION.ja, PROJECT_DESCRIPTION.en) } as const;

export function queryTool(project: (args: Record<string, unknown>) => string, lim: (args: string[]) => Promise<ToolResult>): Tool {
  return {
    name: "query",
    description: both("ラベル、変数、素材の定義と参照を JSON で調べる。名前を省くと一覧を返す。", "Looks up label, variable and asset definitions and references as JSON. Omit name for an inventory."),
    inputSchema: { type: "object", properties: { project: PROJECT_PARAM, kind: { type: "string", enum: ["label", "var", "asset"], description: both("調べる種類", "Kind to look up") }, name: { type: "string", description: both("調べる名前（省くと一覧）", "Name to look up (omit for inventory)") } }, required: ["project", "kind"] },
    run: async (args) => lim(["query", project(args), need(args, "kind"), ...(str(args, "name") ? [str(args, "name")!] : []), "--json"]),
  };
}
