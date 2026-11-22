import type { CommandSpec, ParamType, Registry } from "@liminalia/lang";
import { bool, color, ms, str, type TagConversion, type TagProfile } from "./convert.ts";
import type { Params } from "./types.ts";

/**
 * .ks のタグから .lim の命令への変換表。命令の仕様（引数の型・位置引数・既定値）は書かず、
 * 命令のレジストリ（組み込み＋標準＋プラグイン）から引く。変換表は取り込みの側（このパッケージの
 * 組み込みの表と、プラグインの "./import"）だけが持ち、書き出すゲームには入らない。
 *
 * .lim の既定値は、対応する .ks のタグで省略したときの値と同じにしてある。そうすれば変換は
 * 「.ks に書かれていた値のうち、既定値と違うもの」を書き出すだけで意味が保てる（機械的な変換）。
 */
export interface TagMapping {
  /** 変換先の .lim の命令名。 */
  command: string;
  /** 変換元の .ks のタグ名。 */
  tags: readonly string[];
  /** .lim の引数名 → .ks の引数名。省略した引数は名前の - を _ にしたもの。null なら .ks に対応する引数はない。 */
  params?: Readonly<Record<string, string | null>>;
  /**
   * 機械的な変換では足りないとき。null なら機械的な変換に任せる。
   * tag は変換するタグ名（tags に複数のタグを並べたとき、タグごとに変換を変えるため）。
   */
  convert?(pm: Params, tag: string, ctx: TagMappingContext): TagConversion | null;
  /**
   * true を返したタグはこの変換表では変換せず、組み込みの変換に任せる。
   * 組み込みのタグ（[jump] など）のうち、特定の書き方だけをプラグインの命令にしたいときに使う。
   */
  defer?(pm: Params): boolean;
  /** 変換しない .ks の引数（見た目に効かない・このエンジンでは不要なもの）。 */
  ignore?: readonly string[];
  /**
   * 直後の [s] を変換で取り除く。.ks では UI を出して [s] で止め、UI 側から [jump] していた命令で、
   * .lim では命令の中で飛ぶもの。
   */
  swallowStop?: boolean;
}

export interface TagMappingContext {
  /** 変換先の命令の仕様。 */
  spec: CommandSpec;
  /** 変換している .ks（data/scenario からのパス）。 */
  file: string;
  /** この変換表で機械的に変換する。 */
  mechanical(pm: Params): TagConversion;
  /**
   * ほかの変換表で、tag として変換する（その表の convert があれば convert、なければ機械的な変換）。
   * 使う表は command の表のうち tag を変換するもの（無ければ command の最後の表）。defer と swallowStop は見ない。
   */
  convertAs(command: string, pm: Params, tag: string): TagConversion;
}

/** .ks の値を .lim の値の書き方にする。 */
export function ksValue(type: ParamType, value: string): string {
  switch (type.kind) {
    case "duration":
      return ms(value);
    case "bool":
      return bool(value);
    case "color":
      return color(value);
    case "number":
    case "int":
      return /^-?\d+(\.\d+)?$/.test(value.trim()) ? String(Number(value)) : str(value);
    default:
      return str(value);
  }
}

/** 命令の仕様と変換表から、機械的に変換する。 */
export function mechanicalConversion(spec: CommandSpec, pm: Params, mapping: Pick<TagMapping, "params" | "ignore"> = {}): TagConversion {
  const positional: string[] = [];
  const named: TagConversion["named"] = [];
  const notes: string[] = [];
  const used = new Set<string>(["cond"]);
  const ksName = (name: string) => {
    const key = mapping.params?.[name];
    return key === undefined ? name.replace(/-/g, "_") : key;
  };
  for (const name of spec.positional) {
    const p = spec.params[name]!;
    const key = ksName(name);
    if (key === null) continue;
    used.add(key);
    const raw = pm[key];
    if (raw === undefined || raw === "") {
      if (p.required) notes.push(`必須の ${key} がありません`);
      break;
    }
    positional.push(ksValue(p.type, raw));
  }
  for (const [name, p] of Object.entries(spec.params)) {
    if (spec.positional.includes(name)) continue;
    const key = ksName(name);
    if (key === null) continue;
    used.add(key);
    const raw = pm[key];
    if (raw === undefined || raw === "") continue;
    named.push([name, ksValue(p.type, raw), p.default ?? null]);
  }
  for (const key of Object.keys(pm)) {
    if (!used.has(key) && !(mapping.ignore ?? []).includes(key) && !key.startsWith("_")) notes.push(`${key}=${pm[key]} は変換していません`);
  }
  return notes.length > 0 ? { name: spec.name, positional, named, notes } : { name: spec.name, positional, named };
}

/**
 * 変換表を、変換（ConvertOptions の profile）の形にする。命令の仕様は registry から引く。
 * 同じタグ・同じ命令の表が複数あれば後のものが勝つ。
 */
export function toProfile(mappings: readonly TagMapping[], registry: Registry): TagProfile {
  for (const m of mappings) {
    if (!registry.has(m.command)) throw new Error(`.ks のタグ ${m.tags.map((t) => `[${t}]`).join(" ")} の変換先 @${m.command} が命令の仕様にありません`);
  }
  const run = (m: TagMapping, pm: Params, tag: string, file: string): TagConversion => {
    const spec = registry.get(m.command)!;
    const ctx: TagMappingContext = {
      spec,
      file,
      mechanical: (p) => mechanicalConversion(spec, p, m),
      convertAs: (command, p, t) => {
        const tables = mappings.filter((x) => x.command === command);
        const other = tables.findLast((x) => x.tags.includes(t)) ?? tables.at(-1);
        if (!other) throw new Error(`@${command} の変換表がありません`);
        return run(other, p, t, file);
      },
    };
    return m.convert?.(pm, tag, ctx) ?? ctx.mechanical(pm);
  };
  const profile: TagProfile = {};
  for (const m of mappings) {
    for (const tag of m.tags) {
      profile[tag] = (pm, ctx) => {
        if (m.defer?.(pm)) return null;
        const converted = run(m, pm, tag, ctx?.file ?? "");
        return m.swallowStop ? { ...converted, swallowStop: true } : converted;
      };
    }
  }
  return profile;
}

/** 変換表の中の、命令ごとの取り込み元のタグ（リファレンス用。並びは変換表の順）。 */
export function tagsByCommand(mappings: readonly TagMapping[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of mappings) {
    const list = out.get(m.command) ?? [];
    for (const tag of m.tags) if (!list.includes(tag)) list.push(tag);
    out.set(m.command, list);
  }
  return out;
}
