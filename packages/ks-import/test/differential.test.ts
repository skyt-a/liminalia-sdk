import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { lex } from "../src/index.ts";
import { REFERENCE_PROJECT, hasReference, listReferenceScenarios, loadReferenceParser } from "./reference.ts";

/** TyranoScript の出力を比較用の形にそろえる（行番号は 1 始まり、内部用の引数は除く）。 */
function normalizeReference(cmd: { name: string; pm: Record<string, string>; val: string; line: number }) {
  if (cmd.name === "label") {
    const pm = cmd.pm as unknown as { line: number; label_name: string; val: string };
    return { name: "label", pm: { label_name: pm.label_name, val: pm.val }, val: cmd.val, line: pm.line + 1 };
  }
  const pm = { ...cmd.pm };
  delete pm.deep_if;
  return { name: cmd.name, pm, val: cmd.val ?? "", line: cmd.line + 1 };
}

describe.skipIf(!hasReference)("TyranoScript のパーサとの一致（参照プロジェクトの全 .ks）", () => {
  const reference = hasReference ? loadReferenceParser() : () => ({ commands: [], warnings: [] });
  const files = hasReference ? listReferenceScenarios() : [];

  it("参照プロジェクトに .ks がある", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const path of files) {
    const name = relative(REFERENCE_PROJECT, path);
    it(name, () => {
      const source = readFileSync(path, "utf8");
      const expected = reference(source).commands.map(normalizeReference);
      const actual = lex(source, name).commands.map(({ entityDisabled: _, ...c }) => c);
      expect(actual).toEqual(expected);
    });
  }
});
