import { readFileSync } from "node:fs";

/**
 * エンジンの版（cli の package.json の version）。エンジンのパッケージはすべて同じ版で、リポジトリ直下の package.json が元
 * （npm run engine-version がそろえる。docs/versioning.md）。制作アプリは組み立てるときに、アプリと中のエンジンを同じ版にする。
 */
let cached: string | null = null;
export function engineVersion(): string {
  cached ??= (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  return cached;
}
