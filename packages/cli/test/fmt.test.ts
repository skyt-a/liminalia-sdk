import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFmt } from "../src/commands/fmt.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-fmt-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  rmSync(join(dir, "scenario"), { recursive: true });
  mkdirSync(join(dir, "scenario"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function quiet(check: boolean): Promise<{ value: boolean; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await runFmt(dir, check);
    return { value, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe.each([true, false])("lim fmt (check=%s)", (check) => {
  const success = check ? "すべて整形済みです" : "変更はありませんでした";

  it.each([false, true])("構文エラーを飛ばしたとき、変更なしとは言わない（整形済みのファイル: %s）", async (formatted) => {
    writeFileSync(join(dir, "scenario", "broken.lim"), "@if\n");
    if (formatted) writeFileSync(join(dir, "scenario", "start.lim"), "本文\n");
    const r = await quiet(check);
    expect(r.value).toBe(false);
    expect(r.out).toContain("構文エラーがあるため整形しなかったファイル:");
    expect(r.out).toContain("broken.lim:");
    expect(r.out).not.toContain(success);
    expect(readFileSync(join(dir, "scenario", "broken.lim"), "utf8")).toBe("@if\n");
  });

  it.each([false, true])("飛ばしたファイルがなければ変更なしと知らせる（整形済みのファイル: %s）", async (formatted) => {
    if (formatted) writeFileSync(join(dir, "scenario", "start.lim"), "本文\n");
    expect(await quiet(check)).toEqual({ value: true, out: success });
  });
});
