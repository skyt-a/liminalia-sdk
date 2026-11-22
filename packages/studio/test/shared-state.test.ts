import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { readStudioState, STUDIO_SHARED_FILE, STUDIO_STATE_FILE, writeStudioState } from "../src/server/studio-state.ts";

/**
 * 制作画面のデータのうち、プロジェクトと一緒に共有するもの（シーンのタグと状態、キャラクターのメモ、顔の切り出し、頭の印、
 * フローチャートの配置）は .liminalia/shared.json に置いて Git に入れ、その人の手元だけのもの（開いていた所、ブックマーク、
 * ブレークポイントなど）は .liminalia/studio.json に置いて Git から外す。どちらもゲームの書き出しには入らない（.liminalia/ の下）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("共有する制作画面のデータ", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-shared-state-"));
    cpSync(TEMPLATE, dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sharedPart = {
    sceneMarks: { "start#night": { status: "review" as const, tags: ["夜"] } },
    castNotes: { アカリ: "声: 未定" },
    faces: { アカリ: { x: 50, y: 20, size: 300 } },
    heads: { "akari/normal.webp": { chinX: 1, chinY: 2, top: 3, width: 4, imageWidth: 5, imageHeight: 6 } },
    mapPositions: { "start#night": { x: 10, y: 20 } },
  };
  const personalPart = { lastOpen: { file: "start", line: 3 }, bookmarks: { start: [{ line: 3, text: "一" }] }, reviewer: "ミナ", todoWords: ["TODO"] };

  it("共有するものは shared.json に、手元だけのものは studio.json に書き、読むときは合わせる", () => {
    const project = loadProject(dir);
    writeStudioState(project, { ...sharedPart, ...personalPart });
    const shared = readJson(join(dir, STUDIO_SHARED_FILE));
    const personal = readJson(join(dir, STUDIO_STATE_FILE));
    expect(Object.keys(shared).sort()).toEqual(Object.keys(sharedPart).sort());
    expect(Object.keys(personal).sort()).toEqual(Object.keys(personalPart).sort());
    expect(readStudioState(project)).toEqual({ ...sharedPart, ...personalPart });
  });

  it("頭の測定点の絵の中身の印（imageHash）を書いて読み戻し、印の無い前の形の測定点も読む（2026-11-19 の X4）", () => {
    const project = loadProject(dir);
    const heads = {
      "akari/normal.webp": { chinX: 1, chinY: 2, top: 3, width: 4, imageWidth: 5, imageHeight: 6, imageHash: "1k-0123abcd4567ef89" },
      "akari/smile.webp": { chinX: 1, chinY: 2, top: 3, width: 4, imageWidth: 5, imageHeight: 6 },
    };
    writeStudioState(project, { heads: { ...heads, "akari/bad.webp": { ...heads["akari/smile.webp"], imageHash: 12 } } });
    expect(readStudioState(project).heads).toEqual({ ...heads, "akari/bad.webp": heads["akari/smile.webp"] });
  });

  it("頭の測定点の印は SHA-256 の形（sha256- と 16 進 64 字）も残す（2026-11-19 の rest-q）", () => {
    const project = loadProject(dir);
    const heads = { "akari/normal.webp": { chinX: 1, chinY: 2, top: 3, width: 4, imageWidth: 5, imageHeight: 6, imageHash: `sha256-${"0123456789abcdef".repeat(4)}` } };
    writeStudioState(project, { heads });
    expect(readStudioState(project).heads).toEqual(heads);
  });

  it("共有するものが無ければ shared.json を作らず、変わらなければ書き直さない", () => {
    const project = loadProject(dir);
    writeStudioState(project, personalPart);
    expect(existsSync(join(dir, STUDIO_SHARED_FILE))).toBe(false);
    writeStudioState(project, { ...personalPart, sceneMarks: sharedPart.sceneMarks });
    const before = readFileSync(join(dir, STUDIO_SHARED_FILE), "utf8");
    writeFileSync(join(dir, STUDIO_SHARED_FILE), before.replace(/\n$/, "\n\n"));
    writeStudioState(project, { ...readStudioState(project), lastOpen: { file: "start", line: 9 } });
    // 中身が同じなら、手元の書き方（空行など）のまま残す（Git の差分を出さない）
    expect(readFileSync(join(dir, STUDIO_SHARED_FILE), "utf8")).toBe(before.replace(/\n$/, "\n\n"));
  });

  it("前の版の studio.json にあった共有するものは、開いたときに shared.json へ移す（shared.json にある値を先にする）", () => {
    mkdirSync(join(dir, ".liminalia"), { recursive: true });
    writeFileSync(join(dir, STUDIO_STATE_FILE), JSON.stringify({ ...personalPart, sceneMarks: { "start#a": { status: "draft" }, "start#night": { status: "done" } }, castNotes: { ソウ: "メモ" } }));
    writeFileSync(join(dir, STUDIO_SHARED_FILE), JSON.stringify({ sceneMarks: { "start#night": { status: "review" } } }));
    const project = loadProject(dir);
    const state = readStudioState(project);
    expect(state.sceneMarks).toEqual({ "start#a": { status: "draft" }, "start#night": { status: "review" } });
    expect(state.castNotes).toEqual({ ソウ: "メモ" });
    expect(readJson(join(dir, STUDIO_SHARED_FILE))).toEqual({ sceneMarks: { "start#a": { status: "draft" }, "start#night": { status: "review" } }, castNotes: { ソウ: "メモ" } });
    expect(Object.keys(readJson(join(dir, STUDIO_STATE_FILE))).sort()).toEqual(Object.keys(personalPart).sort());
  });
});
