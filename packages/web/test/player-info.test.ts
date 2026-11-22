import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { liveConfig, playerInfo } from "../player-info.ts";

/**
 * 作品の情報（プレイヤーに渡すもの）。訳のファイルがある言語の一覧（translations）は、書き出したゲームが無い訳を取りに行かないのに使う
 * （languages に書いたが訳がまだ無い言語を英語のブラウザが選ぶと、lang/en.json を取りに行き、lim build browser の確かめが 404 で止まっていた。2026-11-20）。
 */
const dir = mkdtempSync(join(tmpdir(), "liminalia-player-info-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });

describe("作品の情報の translations", () => {
  it("訳のファイルがある言語だけを並べ、languages に書いただけの言語は入れない", () => {
    const file = join(dir, "liminalia.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), languages: ["ja", "en", "ko"] }, null, 2));
    expect(playerInfo(loadProject(dir)).translations).toEqual([]);
    mkdirSync(join(dir, "lang"), { recursive: true });
    writeFileSync(join(dir, "lang/ko.json"), "{}\n");
    const info = playerInfo(loadProject(dir));
    expect(info.translations).toEqual(["ko"]);
    expect(info.languages).toEqual(["ja", "en", "ko"]);
  });
});

describe("開発中の作品の版（2026-11-19 の rest-q）", () => {
  it("開発中だけ、liminalia.json の今の version を渡す（読み込んだあとに書き換えても、開き直さずに新しい版）。書き出しには埋めない", () => {
    const file = join(dir, "liminalia.json");
    const original = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...original, version: "1.0.0" }, null, 2));
    const project = loadProject(dir);
    expect(liveConfig(project, { dev: true }).version).toBe("1.0.0");
    expect(playerInfo(project, { dev: true }).version).toBe("1.0.0");
    writeFileSync(file, JSON.stringify({ ...original, version: "2.0.0" }, null, 2));
    expect(liveConfig(project, { dev: true }).version).toBe("2.0.0");
    expect(playerInfo(project, { dev: true }).version).toBe("2.0.0");
    expect(liveConfig(project)).not.toHaveProperty("version");
    expect(playerInfo(project)).not.toHaveProperty("version");
    // 消したら渡さない
    const { version: _, ...rest } = original;
    writeFileSync(file, JSON.stringify(rest, null, 2));
    expect(liveConfig(project, { dev: true })).not.toHaveProperty("version");
    expect(playerInfo(project, { dev: true })).not.toHaveProperty("version");
    writeFileSync(file, JSON.stringify(original, null, 2));
  });
});
