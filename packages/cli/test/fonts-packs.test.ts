import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { projectCharacters } from "../src/fonts.ts";

/**
 * 書体の切り詰め（build.subsetFonts）に残す字は、パック（packs/<フォルダ>/）の台本、訳、データの字も入れる（2026-11-19 の r1）。
 * 書き出しは作品のパックをすべて入れるので、パックの本文の字が切り詰めた書体に無いと、その字だけほかの書体で出る。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-fonts-packs-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("書体の切り詰めとパック", () => {
  it("パックの台本、訳、データにだけある字も残す", () => {
    const pack = join(dir, "packs", "extra");
    for (const sub of ["scenario", "lang", "data"]) mkdirSync(join(pack, sub), { recursive: true });
    writeFileSync(join(pack, "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    // 本体に無い字（鬱、麒、麟）
    writeFileSync(join(pack, "scenario", "bonus.lim"), "# bonus\nアカリ「鬱」\n");
    writeFileSync(join(pack, "lang", "en.json"), JSON.stringify({ language: "en", lines: { "bonus:l0": { source: "x", text: "麒" } } }));
    writeFileSync(join(pack, "data", "notes.json"), JSON.stringify({ title: "麟" }));
    const chars = projectCharacters(loadProject(dir));
    for (const c of ["鬱", "麒", "麟"]) expect(chars, c).toContain(c);
  });
});
