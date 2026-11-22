import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * 突き合わせ用の参照プロジェクト（TyranoScript のプロジェクト）。環境変数 LIMINALIA_REFERENCE_PROJECT で指定し、
 * 指定がなければ差分テストは飛ばす。
 * TyranoScript のコードはリポジトリに含めず、テスト時にここから読むだけにする。
 */
export const REFERENCE_PROJECT =
  process.env.LIMINALIA_REFERENCE_PROJECT ?? "";

export const hasReference = REFERENCE_PROJECT !== "" && existsSync(join(REFERENCE_PROJECT, "tyrano/plugins/kag/kag.parser.js"));

export interface ReferenceCommand {
  name: string;
  pm: Record<string, string>;
  val: string;
  line: number;
}

export interface ReferenceResult {
  commands: ReferenceCommand[];
  warnings: string[];
}

/** TyranoScript のパーサを隔離した環境で読み込み、.ks を解析する関数を返す。 */
export function loadReferenceParser(keepSpace = "2"): (source: string) => ReferenceResult {
  const code = readFileSync(join(REFERENCE_PROJECT, "tyrano/plugins/kag/kag.parser.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    tyrano: { plugin: { kag: {} } },
    $: {
      trim: (s: unknown) => String(s ?? "").trim(),
      replaceAll: (s: string, a: string, b: string) => s.split(a).join(b),
      loadText: () => {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const proto = (sandbox.tyrano as { plugin: { kag: { parser: Record<string, unknown> } } }).plugin.kag.parser;

  return (source: string) => {
    const warnings: string[] = [];
    const parser = Object.assign(Object.create(proto) as Record<string, unknown>, {
      flag_script: false,
      deep_if: 0,
      kag: {
        config: { KeepSpaceInParameterValue: keepSpace },
        stat: { current_scenario: "" },
        convertLang: () => {},
        warning: (code: string) => warnings.push(code),
        error: (code: string) => warnings.push(code),
      },
    });
    const result = (parser.parseScenario as (s: string) => { array_s: ReferenceCommand[] }).call(parser, source);
    return { commands: result.array_s, warnings };
  };
}

/** 参照プロジェクトの .ks を再帰的に列挙する（生成物の _ 始まりも含む）。 */
export function listReferenceScenarios(): string[] {
  const root = join(REFERENCE_PROJECT, "data/scenario");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".ks")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}
