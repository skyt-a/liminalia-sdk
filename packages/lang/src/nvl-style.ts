import type { Diagnostic, Script, Statement } from "./ast.ts";
import type { ParamType } from "./registry.ts";

/** liminalia.json の ui の、名前 → 値の組の名前（ui.tones、ui.nvlStyles。形が崩れていれば空）。 */
function uiNames(ui: unknown, key: "tones" | "nvlStyles"): string[] {
  const raw = ui && typeof ui === "object" ? (ui as Record<string, unknown>)[key] : undefined;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
}

/**
 * 作品の設定で名前を決める引数の候補（補完と制作画面の右の欄）。色調の名前（tone）は ui.tones、NVL の見た目の名前（nvlStyle）は ui.nvlStyles の名前。
 * 命令の仕様の suggest（決まった名前）には足さないので、呼ぶ側で合わせる。
 */
export function uiParamNames(type: ParamType, ui: unknown): string[] {
  if (type.kind !== "string") return [];
  return [...(type.tone ? uiNames(ui, "tones") : []), ...(type.nvlStyle ? uiNames(ui, "nvlStyles") : [])];
}

/**
 * NVL の見た目の名前（@nvl on style=letter）が、liminalia.json の ui.nvlStyles にあるか（unknown-nvl-style）。
 * 式で書いた名前は実行するまで分からないので見ない。
 */
export function checkNvlStyles(scripts: ReadonlyMap<string, Script>, ui: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = uiNames(ui, "nvlStyles");
  const visit = (file: string, body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "command" && s.name === "nvl") {
        const a = s.args.find((x) => x.key === "style");
        if (a?.value.kind === "string" && a.value.value !== "" && !known.includes(a.value.value)) {
          out.push({
            severity: "error",
            code: "unknown-nvl-style",
            message: `NVL の見た目 ${a.value.value} は liminalia.json の ui.nvlStyles にありません`,
            file,
            line: s.line,
            column: a.column,
            hint: known.length > 0 ? known.join(" / ") : "ui.nvlStyles に名前と見た目を書きます",
          });
        }
      }
      if (s.kind === "if") for (const b of s.branches) visit(file, b.body);
      if (s.kind === "define") visit(file, s.body);
    }
  };
  for (const [file, script] of scripts) visit(file, script.body);
  return out;
}
