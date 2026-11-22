import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SLOW_START_MS, StartupTimes } from "../src/web.ts";

/** 開発サーバーの起動にかかった時間の内訳（長くかかったときだけ記録に出す。制作アプリでは studio.log に入る）。 */

/** 呼ぶたびに step ミリ秒ずつ進む時計。 */
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};

describe("起動の時間の内訳", () => {
  it("区切りごとの時間を、全体が 3 秒以上のときだけ一行にする", () => {
    const fast = new StartupTimes(clock(100));
    fast.mark("設定の読み込み");
    fast.mark("待ち受けの開始");
    expect(fast.report()).toBeNull();
    const slow = new StartupTimes(clock(SLOW_START_MS / 2));
    slow.mark("設定の読み込み");
    slow.mark("待ち受けの開始");
    expect(slow.report()).toBe("開発サーバーの起動に 3.0 秒かかりました（設定の読み込み 1.5 秒、待ち受けの開始 1.5 秒）");
  });

  it("長くかかったら、設定の読み込みから待ち受けの開始までの内訳を開発サーバーの記録に出す", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-startup-"));
    try {
      cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
      // 開発サーバーは lim と同じく tsx で動かす（Vite の設定が読むエンジンの部品は TypeScript のまま）。区切りのたびに 1 秒進む時計で、
      // 実際の時間によらず長くかかったことにする
      const script = join(dir, "start.mts");
      writeFileSync(
        script,
        [
          `import { loadProject } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../project/src/index.ts")).href)};`,
          `import { StartupTimes, startPlayerServer } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../src/web.ts")).href)};`,
          `let t = 0;`,
          `const times = new StartupTimes(() => (t += 1000));`,
          `const project = loadProject(${JSON.stringify(dir)}, { skipBrokenPlugins: true });`,
          `times.mark("設定の読み込み");`,
          `const { server } = await startPlayerServer(project, 0, false, { server: { watch: null } }, times);`,
          `await server.close();`,
          `process.exit(0);`,
        ].join("\n"),
      );
      const r = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 60_000 });
      const line = `${r.stdout}${r.stderr}`.split("\n").find((l) => l.includes("開発サーバーの起動に"));
      expect(line, `${r.stdout}${r.stderr}`).toBeDefined();
      const labels = [...line!.matchAll(/(?:（|、)([^（、]+?) \d+\.\d 秒/g)].map((m) => m[1]);
      expect(labels).toEqual(["設定の読み込み", "Vite の設定ファイルの読み込み", "Vite のプラグインの準備", "Vite のサーバーの作成", "プラグインの開始", "依存の下調べと待ち受けの開始"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
