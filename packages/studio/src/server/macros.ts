import type { Inline, Statement } from "@liminalia/lang";
import type { MacroUse } from "../protocol.ts";
import type { StudioWorkspace } from "./workspace.ts";

/**
 * マクロを使う行（GET /macro/uses。制作画面の「このマクロを使う行」）。すべての .lim の、行の `@名前`・`@with 名前`・本文の中の `{@名前}`
 * （@if・@define の中も。選択肢の文の中も）を、保存した内容から拾う。同じ行は一つにする。@define の名前はプロジェクトで一つなので、名前だけで見る。
 */
export function macroUses(ws: StudioWorkspace, name: string): MacroUse[] {
  const out: MacroUse[] = [];
  for (const file of ws.files()) {
    const { text, script } = ws.script(file);
    const rows = text.split("\n");
    const seen = new Set<number>();
    const add = (line: number, kind: MacroUse["kind"]) => {
      if (seen.has(line)) return;
      seen.add(line);
      out.push({ file, line, kind, text: (rows[line - 1] ?? "").trim() });
    };
    const inline = (list: readonly Inline[]): boolean => list.some((t) => (t.kind === "command" && t.name === name) || ("children" in t && inline(t.children)));
    const visit = (body: readonly Statement[]) => {
      for (const s of body) {
        if (s.kind === "command" && s.name === name) add(s.line, "command");
        else if ((s.kind === "say" || s.kind === "prose") && inline(s.content)) add(s.line, "inline");
        else if (s.kind === "choice") for (const o of s.options) if (inline(o.content)) add(o.line, "inline");
        if (s.kind === "if") {
          if (s.with?.name === name) add(s.line, "with");
          for (const b of s.branches) visit(b.body);
        } else if (s.kind === "define") visit(s.body);
      }
    };
    visit(script.body);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file, "en", { numeric: true }) || a.line - b.line);
}
