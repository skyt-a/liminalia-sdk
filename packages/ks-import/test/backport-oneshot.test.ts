import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { backportTyrano, importTyrano } from "../src/node.ts";

/**
 * 書き戻し（lim backport）で、TyranoScript に対応するタグの無い標準の命令（@notify・@flipbook（loop=0 も）・@flipbook-off・@flash・@blink・@cutin）は、
 * 書き戻せない箇所として報告し、.ks にはコメントとして残す。
 */
const registry = createRegistry([...CORE_COMMANDS, ...combinePlugins([std]).specs]);
const profile = { skipFiles: ["first"] };
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("書き戻せない標準の命令", () => {
  it("一回きりの演出と通知を足した行は、書き戻せない箇所として報告する", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-backport-oneshot-"));
    temps.push(tmp);
    const source = join(import.meta.dirname, "fixtures", "backport-project");
    await importTyrano({
      source,
      scenarioOut: join(tmp, "base/lim"),
      dataOut: join(tmp, "base/data"),
      castOut: join(tmp, "base/cast.json"),
      reportOut: join(tmp, "base/import-report.md"),
      sourceMapOut: join(tmp, "base/import-sourcemap.json"),
      registry,
      profile,
    });
    cpSync(join(tmp, "base/lim"), join(tmp, "cur"), { recursive: true });
    const file = join(tmp, "cur", "scene1.lim");
    const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
    const at = lines.findIndex((l) => l.trim() === "朝の光が差し込んでいた。");
    lines.splice(at + 1, 0, "@notify 手帳に書き足した", "@flipbook fx/s_{n}.png frames=2", "@flipbook fx/r_{n}.png frames=2 loop=0 name=rain", "@flipbook-off rain", "@flash invert", "@blink", "@cutin key.png");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const speakers = (JSON.parse(readFileSync(join(tmp, "base/cast.json"), "utf8")) as { speakers: string[] }).speakers;
    const report = await backportTyrano({
      baseKs: join(source, "data/scenario"),
      baseLim: join(tmp, "base/lim"),
      sourceMap: join(tmp, "base/import-sourcemap.json"),
      currentLim: join(tmp, "cur"),
      source,
      out: join(tmp, "out/scenario"),
      registry,
      profile,
      speakers,
    });
    const errors = report.files.flatMap((f) => f.issues.filter((i) => i.severity === "error").map((i) => i.message));
    expect(errors.filter((m) => m.includes("@flipbook")), "@flipbook").toHaveLength(3);
    for (const name of ["notify", "flipbook", "flipbook-off", "flash", "blink", "cutin"]) expect(errors.some((m) => m.includes(`@${name}`) && m.includes("戻せません")), name).toBe(true);
  });
});
