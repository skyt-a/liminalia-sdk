import { describe, expect, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, DIAGNOSTIC_CODES_EN, parse, RUNTIME_QUIET, RUNTIME_REPORTED, runtimeDiagnostic, SUGGESTION_CODES } from "../src/index.ts";

/**
 * 検査の言葉を実行時にも知らせるかの表（runtime-codes.ts）。エンジンの診断の言葉（英語の表 DIAGNOSTIC_CODES_EN。ソースの code と突き合わせ済み）の
 * すべてが「出す」か「出さない」のどちらか一方にあることを確かめる。新しい言葉を足して表に入れ忘れると落ちる（2026-11-19 の O1）。
 */

describe("実行時に知らせる言葉の表", () => {
  it("エンジンのすべての言葉が、出す（RUNTIME_REPORTED）か出さない（RUNTIME_QUIET）のどちらか一方にある", () => {
    const codes = Object.keys(DIAGNOSTIC_CODES_EN);
    expect(codes.length).toBeGreaterThan(200);
    expect(codes.filter((c) => !RUNTIME_QUIET.has(c) && !RUNTIME_REPORTED.has(c)).sort(), "表に無い言葉").toEqual([]);
    expect([...RUNTIME_QUIET].filter((c) => RUNTIME_REPORTED.has(c)), "両方にある言葉").toEqual([]);
    expect([...RUNTIME_QUIET, ...RUNTIME_REPORTED].filter((c) => !(c in DIAGNOSTIC_CODES_EN)), "エンジンに無い言葉").toEqual([]);
    // 書き方の提案はどれも出さない
    expect([...SUGGESTION_CODES].filter((c) => !RUNTIME_QUIET.has(c))).toEqual([]);
  });

  it("前の名前の fade= は実行時に知らせない（実行器は time= として読む）。誤りと、表に無いプラグインの言葉は知らせる", () => {
    const registry = createRegistry(CORE_COMMANDS);
    const script = parse("@chara-hide アカリ fade=1s\n@chara-hide アカリ tmie=1s\n", "a");
    const found = check(script, { registry, punctuation: false }).filter(runtimeDiagnostic).map((d) => d.code);
    expect(found).not.toContain("renamed-param");
    expect(found).toContain("unknown-param");
    expect(runtimeDiagnostic({ code: "my-plugin-code", severity: "warning" })).toBe(true);
    expect(runtimeDiagnostic({ code: "unknown-param", severity: "info" })).toBe(false);
  });
});
