import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * プラグインが読む名前。npm に出すのは @liminalia/sdk（約束）と @liminalia/cli（lim）だけなので、
 * 同梱のプラグイン、見本、資料の例は sdk の入口と、テストの口 @liminalia/cli/testing だけを読む。
 * sdk は依存を持たず、エンジンのパッケージからは型だけを読む（実装は host.ts の口でつなぐ）。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const ALLOWED = new Set([
  "@liminalia/sdk",
  "@liminalia/sdk/std",
  "@liminalia/sdk/web",
  "@liminalia/sdk/studio",
  "@liminalia/sdk/studio-server",
  "@liminalia/sdk/import",
  "@liminalia/cli/testing",
]);
const SPECIFIER = /(?:from\s+|import\(\s*|^import\s+)["'](@liminalia\/[^"']+)["']/gm;

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const specifiers = (text: string) => [...text.matchAll(SPECIFIER)].map((m) => m[1] as string);

describe("プラグインが読む名前", () => {
  it("同梱のプラグインと見本は sdk の入口と @liminalia/cli/testing だけを読む", () => {
    const files = ["plugins", "examples"].flatMap((d) => sources(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) => specifiers(readFileSync(f, "utf8")).filter((s) => !ALLOWED.has(s)).map((s) => `${relative(ROOT, f)}: ${s}`));
    expect(offenders).toEqual([]);
  });

  // 資料は公開用のリポジトリには写さない（写した先では飛ばす）
  const DOCS = ["docs/plugins.md", "site/src/content/en/docs/plugins.md", "docs/cast-editor.md", "site/src/content/en/docs/cast-editor.md"];
  it.skipIf(!existsSync(join(ROOT, DOCS[0] as string)))("プラグインの資料の例は sdk の入口と @liminalia/cli/testing だけを読む", () => {
    for (const doc of DOCS) {
      const blocks = [...readFileSync(join(ROOT, doc), "utf8").matchAll(/```(?:ts|js|typescript|javascript)\n([\s\S]*?)```/g)].map((m) => m[1] as string);
      const offenders = blocks.flatMap(specifiers).filter((s) => !ALLOWED.has(s));
      expect(offenders, doc).toEqual([]);
    }
  });

  it("sdk は依存を持たず、エンジンのパッケージを値として読まない", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages/sdk/package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    for (const f of sources(join(ROOT, "packages/sdk/src"))) {
      // import { … } from / export { … } from の文を一つずつ見て、@liminalia/ を読むものは型だけであること
      for (const m of readFileSync(f, "utf8").matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+["'](@liminalia\/[^"']+)["']/gms)) {
        expect(m[2], `${relative(ROOT, f)}: ${m[3]}`).toBeDefined();
      }
    }
  });
});
