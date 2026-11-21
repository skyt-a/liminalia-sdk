import { CHOICE_OPTION, normalizeBooleanArgs, type Argument, type CommandSpec, type Inline, type Registry } from "@liminalia/lang";
import type { Instruction, Unit } from "./program.ts";

/** 先読みしてほしい素材。立ち絵はキャストの定義から画像を求めるので、名前の組で渡す。 */
export type PrefetchItem =
  | { kind: "asset"; folder: string; path: string }
  | { kind: "sprite"; who: string; appearance: string; variant: string };

/** 画像のフォルダ。命令が folder 引数を持つときは、それで探し先が替わる。 */
const IMAGE_FOLDERS = new Set(["bgimage", "fgimage", "image"]);
/** ボイスを探せるフォルダ（@voice の folder=）。 */
const VOICE_FOLDERS = new Set(["voice", "sound"]);

/**
 * index から先の limit 個の命令（本文中の命令と、選択肢の画像も含む）が使う素材を集める。
 * 分岐は両方とも見る（どちらへ進んでも間に合うように）。式で書いた引数は評価せずに飛ばす（副作用を起こさないため）。
 */
export function collectPrefetch(unit: Unit, index: number, registry: Registry, limit = 40): PrefetchItem[] {
  const out: PrefetchItem[] = [];
  const seen = new Set<string>();
  const push = (item: PrefetchItem) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const end = Math.min(unit.instructions.length, index + limit);
  for (let i = index; i < end; i++) {
    const ins: Instruction = unit.instructions[i]!;
    if (ins.op === "command") fromCommand(ins.name, ins.args, registry, push);
    else if (ins.op === "say") fromInline(ins.content, registry, push);
    else if (ins.op === "choice") for (const o of ins.options) fromSpec(CHOICE_OPTION, o.args, push);
  }
  return out;
}

function fromInline(nodes: Inline[], registry: Registry, push: (item: PrefetchItem) => void): void {
  for (const n of nodes) {
    if (n.kind === "command") fromCommand(n.name, n.args, registry, push);
    else if ("children" in n) fromInline(n.children, registry, push);
  }
}

function fromCommand(name: string, args: Argument[], registry: Registry, push: (item: PrefetchItem) => void): void {
  const spec = registry.get(name);
  if (spec) fromSpec(spec, args, push);
}

function fromSpec(spec: CommandSpec, args: Argument[], push: (item: PrefetchItem) => void): void {
  const values = literalArgs(spec, args);
  let who: string | null = null;
  let variant: string | null = null;
  let appearance = "";
  for (const [param, value] of Object.entries(values)) {
    const type = spec.params[param]?.type;
    if (!type) continue;
    if (type.kind === "asset" && value !== "") {
      const given = typeof values.folder === "string" ? values.folder : null;
      const folder = given !== null && ((IMAGE_FOLDERS.has(type.folder) && IMAGE_FOLDERS.has(given)) || (VOICE_FOLDERS.has(type.folder) && VOICE_FOLDERS.has(given))) ? given : type.folder;
      push({ kind: "asset", folder, path: value });
    }
    if (type.kind === "cast") who = value;
    if (type.kind === "variant") variant = value;
    if (type.kind === "appearance") appearance = value;
  }
  if (who !== null && variant !== null) push({ kind: "sprite", who, appearance, variant });
}

/** 文字列で書かれた引数だけを、引数名ごとに取り出す。 */
function literalArgs(spec: CommandSpec, args: Argument[]): Record<string, string> {
  const out: Record<string, string> = {};
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const name = a.key ?? spec.positional[position++];
    if (name !== undefined && a.value.kind === "string") out[name] = a.value.value;
  }
  return out;
}
