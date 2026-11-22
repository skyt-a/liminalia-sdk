import { join } from "node:path";
import { parse, type Script } from "@liminalia/lang";
import { listPackScenarioFiles, loadScenarioSource, packScenarioPlace, projectDataReader } from "@liminalia/project";
import { runtimeOptionsOf, type Context } from "./context.ts";

/**
 * 本体の台本にパック（packs/<フォルダ>/scenario）の台本を重ねて流す道具（lim coverage と lim reach）の、読み口と位置。
 * 遊ぶ側と同じく、同じ名前の台本は後ろのパック（pack.json の order、id の順）のもの。流す実行器は台本の名前で動くので、
 * 出力ではパックの台本を packs/<フォルダ>/scenario/<台本> の位置に直す。パックのデータ（packs/<フォルダ>/data）も同じ並びで重ねる。
 */

/** 作品のパック一つ（遊ぶ側の並び）。 */
export interface OverlayPack {
  /** packs/<フォルダ>。 */
  dir: string;
  /** パックの scenario のフォルダ。 */
  scenario: string;
  /** 台本の名前（名前の順）。 */
  names: string[];
  /** パックの cast.json の話者。 */
  speakers: string[];
}

/** 作品のパック（台本のあるもの。遊ぶ側の並び）。 */
export function overlayPacks(ctx: Context): OverlayPack[] {
  const out = new Map<string, OverlayPack>();
  for (const f of listPackScenarioFiles(ctx.project.root)) {
    const pack = out.get(f.pack) ?? out.set(f.pack, { dir: f.pack, scenario: join(ctx.project.root, f.pack, "scenario"), names: [], speakers: f.speakers }).get(f.pack)!;
    pack.names.push(f.name);
  }
  return [...out.values()];
}

/** 本体に packs を重ねたもの。 */
export interface Overlay {
  packs: readonly OverlayPack[];
  /** その名前の台本を持つ、一番後ろのパック（本体の台本なら null）。 */
  owner(name: string): OverlayPack | null;
  /** 出力に出す位置（パックの台本は packs/<フォルダ>/scenario/<台本>、本体の台本は名前のまま）。 */
  place(name: string): string;
  /** 台本の中身（UTF-8 で読めなければ例外。loadScenarioSource と同じ）。 */
  loadSource(name: string): Promise<string>;
  /** 読む話者（本体の話者にパックの cast.json の話者を足したもの）。 */
  speakers: string[];
  /** 流す実行器の設定（話者にパックの話者を足し、作品のデータにパックのデータを重ねる）。 */
  runtime: ReturnType<typeof runtimeOptionsOf>;
  /** 作品のデータ（パックのデータを重ねたもの。命令の行き先と地図を作るときに使う）。 */
  data: (name: string) => unknown;
  /** 本体とパックの台本の名前（重ねたあと。名前の順）。 */
  names(mainNames: readonly string[]): string[];
  /** 重ねた台本を読み解く（名前 → 構文木と中身）。 */
  read(mainNames: readonly string[]): Map<string, { script: Script; text: string }>;
}

/**
 * パック一つの台本を流すための重ね方: 本体にすべてのパックを重ね、そのパックを一番後ろにする（そのパックの台本が勝つ）。
 * パックの台本は、ほかのパックの台本へ飛ぶこともある（書き出しはパックをすべて入れる）ので、そのパックだけを重ねると無い台本で止まる。
 */
export function overlayForPack(ctx: Context, packs: readonly OverlayPack[], pack: OverlayPack): Overlay {
  return overlayOf(ctx, [...packs.filter((p) => p !== pack), pack]);
}

export function overlayOf(ctx: Context, packs: readonly OverlayPack[]): Overlay {
  const owner = (name: string) => [...packs].reverse().find((p) => p.names.includes(name)) ?? null;
  const speakers = [...new Set([...ctx.cast.speakers, ...packs.flatMap((p) => p.speakers)])];
  const loadSource = async (name: string) => {
    const p = owner(name);
    return loadScenarioSource(p ? p.scenario : ctx.project.paths.scenario, name);
  };
  const names = (mainNames: readonly string[]) => [...new Set([...mainNames, ...packs.flatMap((p) => p.names)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const data = projectDataReader(ctx.project, packs.map((p) => p.dir));
  return {
    packs,
    owner,
    place: (name) => {
      const p = owner(name);
      return p ? packScenarioPlace(p.dir, name) : name;
    },
    loadSource,
    speakers,
    runtime: { ...runtimeOptionsOf(ctx), speakers, loadData: data },
    data,
    names,
    read: (mainNames) => {
      const out = new Map<string, { script: Script; text: string }>();
      for (const name of names(mainNames)) {
        const p = owner(name);
        const text = loadScenarioSource(p ? p.scenario : ctx.project.paths.scenario, name);
        out.set(name, { script: parse(text, name, { speakers }), text });
      }
      return out;
    },
  };
}
