import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Plan {
  target: string;
  exe: string;
  staging: string;
  incoming: string | null;
  backup: string;
  work: string;
  result: string;
  started: string;
}
const swap = createRequire(import.meta.url)(resolve(import.meta.dirname, "../../desktop/app-swap.cjs")) as {
  START_WAIT_SECONDS: number;
  LINUX_SWAP_SCRIPT: string;
  MAC_SWAP_SCRIPT: string;
  appLocation(execPath: string, platform: string): { target: string; parent: string; exe: string } | null;
  swappableArchive(name: string, platform: string): boolean;
  canReplace(loc: { target: string; parent: string } | null): boolean;
  swapPlan(loc: { target: string; parent: string; exe: string }, id: string): Plan;
  prepare(archive: string, plan: Plan, platform: string, check: { version: string; name?: string }): Promise<Plan>;
  settle(pendingFile: string, version: string): { kind: string; code?: string } | null;
  checkPending(pendingFile: string, version: string): ({ kind: "updated"; from: string; to: string; confirm(): void } | { kind: "failed"; code: string }) | null;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-app-swap-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 起動すると marks に自分の版を書く、にせのゲーム（started を書くかも選ぶ）。 */
function fakeGame(folder: string, version: string, started: string | null): void {
  mkdirSync(join(folder, "resources", "app"), { recursive: true });
  writeFileSync(join(folder, "resources", "app", "package.json"), JSON.stringify({ name: "game", version }));
  writeFileSync(join(folder, "game"), `#!/bin/sh\necho ${version} >> "${join(dir, "marks")}"\n${started ? `echo ${version} > "${started}"\n` : ""}`);
  chmodSync(join(folder, "game"), 0o755);
}

/** 終わったプロセスの番号（入れ替えの処理がすぐ進むように）。 */
function deadPid(): number {
  const r = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

function runLinuxSwap(plan: Plan, wait: number, launchArgs: string[] = []): void {
  mkdirSync(plan.work, { recursive: true });
  const script = join(plan.work, "swap.sh");
  writeFileSync(script, swap.LINUX_SWAP_SCRIPT);
  spawnSync("/bin/sh", [script, String(deadPid()), plan.target, plan.incoming!, plan.backup, plan.result, plan.started, String(wait), plan.exe, ...launchArgs], { timeout: 30_000 });
}

describe("本体の入れ替え（Mac と Linux）", () => {
  it("入れ替えるものと、使えるファイルの形", () => {
    expect(swap.appLocation("/Applications/Game.app/Contents/MacOS/Game", "darwin")).toEqual({ target: "/Applications/Game.app", parent: "/Applications", exe: "Game" });
    expect(swap.appLocation("/home/a/games/Game/game", "linux")).toEqual({ target: "/home/a/games/Game", parent: "/home/a/games", exe: "game" });
    expect(swap.appLocation("C:\\Game\\Game.exe", "win32")).toBeNull();
    expect(swap.appLocation("/usr/local/bin/electron", "darwin")).toBeNull();
    expect(swap.swappableArchive("Game-mac.zip", "darwin")).toBe(true);
    expect(swap.swappableArchive("Game.dmg", "darwin")).toBe(false);
    expect(swap.swappableArchive("Game.tar.gz", "linux")).toBe(true);
    expect(swap.swappableArchive("Game.zip", "linux")).toBe(false);
    expect(swap.canReplace({ target: "/private/var/folders/x/AppTranslocation/y/Game.app", parent: "/" })).toBe(false);
  });

  // 入れ替えの sh と tar を起こし、新しい版が目印を置くのを待つ（sh の打ち切りは 30 秒）
  it("Linux: 展開して確かめ、入れ替えてセーブとパックを引き継ぎ、新しい版が目印を置けば前の版を消す", { timeout: 60_000 }, async () => {
    const parent = join(dir, "games");
    const target = join(parent, "Game");
    const plan = swap.swapPlan({ target, parent, exe: "game" }, `t${process.pid}a`);
    rmSync(plan.work, { recursive: true, force: true });
    fakeGame(target, "1.0.0", null);
    mkdirSync(join(target, "savedata"), { recursive: true });
    writeFileSync(join(target, "savedata", "slot_0.json"), "{}");
    mkdirSync(join(target, "resources", "packs", "dlc"), { recursive: true });
    // 新しい版の tar.gz（中は Game/…）
    const src = join(dir, "src");
    fakeGame(join(src, "Game"), "1.1.0", plan.started);
    const archive = join(dir, "Game.tar.gz");
    execFileSync("tar", ["-czf", archive, "Game"], { cwd: src });
    await expect(swap.prepare(archive, swap.swapPlan({ target, parent, exe: "game" }, "x"), "linux", { version: "9.9.9", name: "game" })).rejects.toThrow(/バージョン/);
    await expect(swap.prepare(archive, swap.swapPlan({ target, parent, exe: "game" }, "x"), "linux", { version: "1.1.0", name: "other" })).rejects.toThrow(/違います/);
    await swap.prepare(archive, plan, "linux", { version: "1.1.0", name: "game" });
    expect(plan.incoming).toBe(join(plan.staging, "Game"));
    runLinuxSwap(plan, 10);
    expect(JSON.parse(readFileSync(plan.result, "utf8"))).toEqual({ ok: true, code: "done" });
    expect(JSON.parse(readFileSync(join(target, "resources", "app", "package.json"), "utf8")).version).toBe("1.1.0");
    expect(readFileSync(join(target, "savedata", "slot_0.json"), "utf8")).toBe("{}");
    expect(existsSync(join(target, "resources", "packs", "dlc"))).toBe(true);
    expect(existsSync(plan.backup)).toBe(false);
    rmSync(plan.work, { recursive: true, force: true });
  });

  it("Linux: 新しい版が目印を置かなければ、止めて前の版とセーブを元に戻して起動する", { timeout: 60_000 }, () => {
    const parent = join(dir, "games");
    const target = join(parent, "Game");
    const plan = swap.swapPlan({ target, parent, exe: "game" }, `t${process.pid}b`);
    rmSync(plan.work, { recursive: true, force: true });
    fakeGame(target, "1.0.0", null);
    mkdirSync(join(target, "savedata"), { recursive: true });
    writeFileSync(join(target, "savedata", "slot_0.json"), "{\"a\":1}");
    plan.incoming = join(plan.staging, "Game");
    fakeGame(plan.incoming, "1.1.0", null);
    runLinuxSwap(plan, 1);
    expect(JSON.parse(readFileSync(plan.result, "utf8"))).toEqual({ ok: false, code: "no-start" });
    expect(JSON.parse(readFileSync(join(target, "resources", "app", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(readFileSync(join(target, "savedata", "slot_0.json"), "utf8")).toBe("{\"a\":1}");
    expect(existsSync(plan.backup)).toBe(false);
    rmSync(plan.work, { recursive: true, force: true });
  });

  it("起動したときの確かめ: 新しい版なら目印を置き、違えば理由を返す", () => {
    const pending = join(dir, "pending.json");
    const started = join(dir, "w", "started");
    writeFileSync(pending, JSON.stringify({ from: "1.0.0", to: "1.1.0", started, result: join(dir, "w", "result.json"), staging: join(dir, "stage") }));
    expect(swap.settle(pending, "1.1.0")).toMatchObject({ kind: "updated" });
    expect(readFileSync(started, "utf8")).toBe("1.1.0");
    expect(existsSync(pending)).toBe(false);
    writeFileSync(pending, JSON.stringify({ from: "1.0.0", to: "1.1.0", started, result: join(dir, "w", "result.json") }));
    writeFileSync(join(dir, "w", "result.json"), JSON.stringify({ ok: false, code: "no-start" }));
    expect(swap.settle(pending, "1.0.0")).toEqual({ kind: "failed", code: "no-start", from: "1.0.0", to: "1.1.0" });
    expect(swap.settle(pending, "1.0.0")).toBeNull();
  });

  it("起動したときの確かめ（ゲームの画面が出るのを待つ）: confirm を呼ぶまで目印を置かず、控えも残す", () => {
    const pending = join(dir, "pending.json");
    const started = join(dir, "w", "started");
    writeFileSync(pending, JSON.stringify({ from: "1.0.0", to: "1.1.0", started, result: join(dir, "w", "result.json"), staging: join(dir, "stage") }));
    const r = swap.checkPending(pending, "1.1.0");
    expect(r).toMatchObject({ kind: "updated", from: "1.0.0", to: "1.1.0" });
    expect(existsSync(started)).toBe(false);
    expect(existsSync(pending)).toBe(true);
    if (r?.kind === "updated") r.confirm();
    expect(readFileSync(started, "utf8")).toBe("1.1.0");
    expect(existsSync(pending)).toBe(false);
  });

  it("Linux: 新しい版を、今のゲームを起動したときの引数（--no-sandbox など）で起動する", { timeout: 60_000 }, () => {
    const parent = join(dir, "games");
    const target = join(parent, "Game");
    const plan = swap.swapPlan({ target, parent, exe: "game" }, `t${process.pid}c`);
    rmSync(plan.work, { recursive: true, force: true });
    fakeGame(target, "1.0.0", null);
    plan.incoming = join(plan.staging, "Game");
    mkdirSync(plan.incoming, { recursive: true });
    // 引数を控えてから目印を置く、にせの新しい版
    writeFileSync(join(plan.incoming, "game"), `#!/bin/sh\necho "$@" > "${join(dir, "args")}"\necho 1.1.0 > "${plan.started}"\n`);
    chmodSync(join(plan.incoming, "game"), 0o755);
    runLinuxSwap(plan, 10, ["--no-sandbox", "--disable-gpu"]);
    expect(JSON.parse(readFileSync(plan.result, "utf8"))).toEqual({ ok: true, code: "done" });
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe("--no-sandbox --disable-gpu");
    rmSync(plan.work, { recursive: true, force: true });
  });

  it("Mac の入れ替えの処理も sh として読める", () => {
    const f = join(dir, "m.sh");
    writeFileSync(f, swap.MAC_SWAP_SCRIPT);
    expect(spawnSync("/bin/sh", ["-n", f]).status).toBe(0);
  });
});
