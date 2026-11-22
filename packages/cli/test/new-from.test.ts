import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restrictedFromEnv } from "@liminalia/project/trust";
import { parseTemplateSource, runNewFrom } from "../src/commands/new-from.ts";

/** lim new --from <URL>: Git のリポジトリか zip のひな形から作る。取ってきたものの中のコードは、信頼するまで動かさない。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "liminalia-new-from-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, out: [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

/** ひな形の作品（plugin なら、作品のプラグインを入れる）。 */
function templateAt(dir: string, plugin = false): string {
  cpSync(TEMPLATE, dir, { recursive: true });
  if (plugin) {
    const p = join(dir, "plugins", "mark");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "package.json"), JSON.stringify({ name: "mark", exports: { "./commands": "./src/commands.js" } }));
    writeFileSync(join(p, "src", "commands.js"), "export default { commands: [] };\n");
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, plugins: ["./plugins/mark"] }, null, 2));
  }
  return dir;
}

describe("ひな形の URL の読み方", () => {
  it("github:人/リポジトリ#タグ、https の Git と zip、ローカルの file: を読み、ほかは断る", () => {
    expect(parseTemplateSource("github:someone/vn-template#v2")).toEqual({ kind: "git", url: "https://github.com/someone/vn-template.git", ref: "v2" });
    expect(parseTemplateSource("https://github.com/someone/vn-template")).toEqual({ kind: "git", url: "https://github.com/someone/vn-template" });
    expect(parseTemplateSource("https://example.com/t.git#main")).toEqual({ kind: "git", url: "https://example.com/t.git", ref: "main" });
    expect(parseTemplateSource("https://example.com/t.zip")).toEqual({ kind: "zip", url: "https://example.com/t.zip" });
    expect(parseTemplateSource("http://127.0.0.1:8080/t.zip")).toEqual({ kind: "zip", url: "http://127.0.0.1:8080/t.zip" });
    expect(parseTemplateSource("file:///tmp/repo")).toEqual({ kind: "git", url: "file:///tmp/repo" });
    // 暗号化しない http は手元の名前だけ。ほかの方式は断る
    expect(() => parseTemplateSource("http://example.com/t.zip")).toThrow(/https/);
    expect(() => parseTemplateSource("ftp://example.com/t.zip")).toThrow();
    expect(() => parseTemplateSource("github:only-owner")).toThrow();
  });
});

describe("lim new --from", () => {
  it("Git のリポジトリから作り、中のプラグインがあることを知らせる（.git は写さない）", async () => {
    const repo = templateAt(join(root, "repo"), true);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "template");
    const dest = join(root, "made");
    const r = await quiet(() => runNewFrom(dest, `file://${repo}`, { id: "made" }));
    expect(existsSync(join(dest, "liminalia.json"))).toBe(true);
    expect(existsSync(join(dest, "scenario", "start.lim"))).toBe(true);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    // 何が動くかを知らせるだけで、制限付きにはしない（自分の作品と同じに開く）
    expect(restrictedFromEnv({})).toBe(false);
    expect(r.out).toContain("開く前に中身を確かめてください");
    expect(r.out).toContain("./plugins/mark");
  });

  it("zip（GitHub のアーカイブのように一つのフォルダに入ったもの）から作る。コードが無ければ何も知らせない", async () => {
    const src = join(root, "zipsrc");
    templateAt(join(src, "game-main"));
    const zip = join(root, "game.zip");
    execFileSync("zip", ["-q", "-r", zip, "game-main"], { cwd: src });
    const server = createServer((req, res) => {
      if (req.url === "/game.zip") res.writeHead(200, { "Content-Type": "application/zip" }).end(readFileSync(zip));
      else res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const port = (server.address() as AddressInfo).port;
      const dest = join(root, "fromzip");
      await quiet(() => runNewFrom(dest, `http://127.0.0.1:${port}/game.zip`, { id: "fromzip" }));
      expect(existsSync(join(dest, "liminalia.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dest, "liminalia.json"), "utf8"))).toMatchObject({ id: "fromzip" });
      // 取れないものは作らずに止める
      await expect(quiet(() => runNewFrom(join(root, "none"), `http://127.0.0.1:${port}/missing.zip`, {}))).rejects.toThrow(/404/);
      expect(existsSync(join(root, "none"))).toBe(false);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
