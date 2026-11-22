import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "@liminalia/lang";
import { applyFixesToText } from "../src/apply-fixes.ts";
import { runCheck } from "../src/commands/check.ts";

/** lim check --fix: 診断に付いた直し方を、code を選んで作品の全体にまとめて当てる（一人ずつ見せる型を solo=true へ直すなど）。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-check-fix-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("直し方をまとめて当てる", () => {
  it("一行の直し方と、何行かを一行にする直し方を、下の行から当てる（改行の形はそのまま）", () => {
    const text = ["@chara-hide-all", "@chara アカリ", "a", "@chara-hide-all", "@chara ソウ", "b", "@wait 1s"].join("\r\n");
    const ds: Diagnostic[] = [
      { severity: "info", code: "chara-solo", message: "", file: "x", line: 4, fix: { kind: "replace-lines", lines: ["@chara-hide-all", "@chara ソウ"], with: "@chara ソウ solo=true" } },
      { severity: "warning", code: "w", message: "", file: "x", line: 7, fix: { kind: "replace", find: "1s", with: "2s" } },
      // 書いたあとに変わった行は当てない
      { severity: "info", code: "chara-solo", message: "", file: "x", line: 1, fix: { kind: "replace-lines", lines: ["@chara-hide-all", "@chara ミオ"], with: "@chara ミオ solo=true" } },
    ];
    const r = applyFixesToText(text, ds);
    expect(r.text).toBe(["@chara-hide-all", "@chara アカリ", "a", "@chara ソウ solo=true", "b", "@wait 2s"].join("\r\n"));
    expect(r.applied.map((d) => d.line)).toEqual([4, 7]);
  });
});

describe("同じ行の直し方（2026-11-19 の疑い）", () => {
  it("桁のある直し方は、同じ行に重ならなければ右から順にすべて当てる。重なるものは当てずに数える", () => {
    const line = "地の文{@chara-hide アカリ fade=1s}と{@chara-hide ソウ fade=300}です。";
    const ds: Diagnostic[] = [
      { severity: "warning", code: "renamed-param", message: "", file: "x", line: 1, column: 21, fix: { kind: "replace", find: "fade=", with: "time=" } },
      { severity: "warning", code: "renamed-param", message: "", file: "x", line: 1, column: 46, fix: { kind: "replace", find: "fade=", with: "time=" } },
      { severity: "error", code: "bad-value", message: "", file: "x", line: 1, column: 46, fix: { kind: "replace", find: "fade=300", with: "fade=300ms" } },
    ];
    const r = applyFixesToText(line, ds);
    expect(r.applied.map((d) => d.column)).toEqual([21, 46]);
    expect(r.left).toBe(1);
    expect(r.text).toMatch(/^地の文\{@chara-hide アカリ time=1s\}と\{@chara-hide ソウ (time=300|fade=300ms)\}です。$/);
  });

  it("lim check --fix --json も、重なって当てなかった直し方の数を出す（2026-11-19 の X5）", async () => {
    writeFileSync(join(dir, "scenario", "overlap.lim"), "@bg hill_dusk.webp fade=300\n");
    const r = await quiet(() => runCheck(dir, true, "ja", { fix: ["renamed-param", "bad-value"] }));
    const out = JSON.parse(r.out) as { fixed: { file: string }[]; fixedLeft?: number };
    expect(out.fixed.filter((f) => f.file === "overlap.lim")).toHaveLength(1);
    expect(out.fixedLeft).toBe(1);
  });

  it("直し方をまとめて当てる所はどれも、重なって当てなかった数（left）を使う（返事や出力に出す。2026-11-19 の X5）", () => {
    const src = resolve(import.meta.dirname, "../src");
    const callers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .map((f) => f.split("\\").join("/"))
      .filter((f) => f.endsWith(".ts") && f !== "apply-fixes.ts")
      .map((f) => ({ f, text: readFileSync(join(src, f), "utf8") }))
      .filter(({ text }) => /\bapplyFixesTo(Text|Files)\(/.test(text));
    expect(callers.map((c) => c.f).sort()).toEqual(["commands/check.ts", "commands/mcp-authoring.ts"]);
    for (const { f, text } of callers) expect(/\.left\b/.test(text), f).toBe(true);
  });
});

describe("lim check --fix", () => {
  it("選んだ code の直し方を全ファイルに当て、当てたあとの検査を出す", async () => {
    const one = ["# one", "@chara-hide-all", "@chara アカリ normal", "アカリ「a」", "@chara-hide-all", "@chara ソウ normal", "ソウ「b」", "@chara-hide-all", "@chara アカリ smile", "アカリ「c」", "@chara-hide-all", "@chara ソウ normal", "ソウ「d」", ""].join("\n");
    writeFileSync(join(dir, "scenario", "solo.lim"), one);
    const before = await quiet(() => runCheck(dir, true));
    const codes = (JSON.parse(before.out) as { diagnostics: { code: string; file: string }[] }).diagnostics.filter((d) => d.file === "solo").map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["chara-hide-per-line", "chara-solo"]));
    const fixed = await quiet(() => runCheck(dir, false, "ja", { fix: ["chara-solo"] }));
    expect(fixed.out).toContain("solo.lim:5 [chara-solo]");
    expect(readFileSync(join(dir, "scenario", "solo.lim"), "utf8")).toBe(
      ["# one", "@chara-hide-all", "@chara アカリ normal", "アカリ「a」", "@chara ソウ normal solo=true", "ソウ「b」", "@chara アカリ smile solo=true", "アカリ「c」", "@chara ソウ normal solo=true", "ソウ「d」", ""].join("\n"),
    );
    // 当てたあとは、一人ずつ見せる型の知らせが残らない
    const after = await quiet(() => runCheck(dir, true));
    expect((JSON.parse(after.out) as { diagnostics: { code: string; file: string }[] }).diagnostics.filter((d) => d.file === "solo")).toEqual([]);
    // 当てるものが無ければそう言う
    expect((await quiet(() => runCheck(dir, false, "ja", { fix: ["chara-solo"] }))).out).toContain("当てられる直し方はありませんでした");
  });
});
