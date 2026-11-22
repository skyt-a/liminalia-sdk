import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxDesktopEntry, linuxLauncher, linuxLauncherName } from "../src/linux.ts";
import { tarGz } from "../src/tar.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-linux-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const posix = process.platform !== "win32";

/**
 * `tar --numeric-owner -tv` の一行から、持ち主とグループの番号を「0 0」の形で取り出す。
 * GNU tar（Linux）は「drwxr-xr-x 0/0 0 2026-11-06 …」と持ち主/グループを一つにまとめ、
 * bsdtar（Mac）は「drwxr-xr-x 0 0 0 0 Nov 6 …」とリンクの数、持ち主、グループを分けて出す。
 */
function tarOwner(line: string): string {
  const fields = line.trim().split(/\s+/);
  const gnu = /^(\d+)\/(\d+)$/.exec(fields[1] ?? "");
  return gnu ? `${gnu[1]} ${gnu[2]}` : fields.slice(2, 4).join(" ");
}

/**
 * .desktop の Exec を、Desktop Entry の仕様のとおりに引数へ分ける（文字列の決まりの \ を戻し、"…" の中の \" \$ \` \\ を戻し、
 * %k をファイルの場所、%% を % にする）。
 */
function desktopExec(file: string): string[] {
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("Exec="))!.slice("Exec=".length);
  const value = line.replace(/\\(.)/g, (_s, c: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c] ?? `\\${c}`);
  const args: string[] = [];
  let at = 0;
  while (at < value.length) {
    if (value[at] === " ") {
      at++;
      continue;
    }
    let arg = "";
    if (value[at] === '"') {
      at++;
      while (value[at] !== '"') {
        if (value[at] === "\\" && /["`$\\]/.test(value[at + 1]!)) at++;
        arg += value[at++];
      }
      at++;
      args.push(arg.replace(/%%/g, "%"));
    } else {
      while (at < value.length && value[at] !== " ") arg += value[at++];
      args.push(arg === "%k" ? file : arg.replace(/%%/g, "%"));
    }
  }
  return args;
}

/** 起動用の sh、.desktop、引数を出すだけの実行ファイルを置いたゲームのフォルダ。 */
function game(dir: string, exe: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, linuxLauncherName(exe)), linuxLauncher({ exe, desktop: `${exe}.desktop`, icon: "icon.png" }), { mode: 0o755 });
  writeFileSync(join(dir, `${exe}.desktop`), linuxDesktopEntry({ title: "星を待つ丘", launcher: linuxLauncherName(exe) }), { mode: 0o755 });
  writeFileSync(join(dir, exe), '#!/bin/sh\necho "ARGS:$*"\n');
  chmodSync(join(dir, exe), 0o755);
  return join(dir, `${exe}.desktop`);
}

// 起動用の sh と、PATH の先に置いた偽のコマンドを起こす（一つのテストで十数回）
describe("Linux 版の起動用の sh と .desktop", { skip: !posix, timeout: 60_000 }, () => {
  it(".desktop から起動用の sh を通して実行ファイルを動かし、sh は .desktop を今の場所の絶対パスに書き直す", () => {
    // 空白や $ の入ったフォルダと名前でも動く
    const dir = join(temp(), "Games", 'a b$c "q"');
    const desktop = game(dir, "my game");
    const first = desktopExec(desktop);
    expect(first.slice(0, 2)).toEqual(["sh", "-c"]);
    const env = { ...process.env, LIMINALIA_SANDBOX: "1" };
    const run = (args: string[]) => spawnSync(args[0]!, args.slice(1), { encoding: "utf8", env }).stdout.trim();
    expect(run(first)).toBe("ARGS:");
    // 起動したあとの .desktop は絶対パス（メニューに写しても動く）
    const text = readFileSync(desktop, "utf8");
    expect(text).toContain(`Icon=${dir}/icon.png`);
    expect(text).toContain("Name=星を待つ丘");
    const second = desktopExec(desktop);
    expect(second).toEqual([join(dir, "my game.sh")]);
    expect(run(second)).toBe("ARGS:");
    // 書き直したあとは、もう一度起動しても変えない
    const before = statSync(desktop).mtimeMs;
    run(second);
    expect(statSync(desktop).mtimeMs).toBe(before);
    expect(statSync(desktop).mode & 0o111).not.toBe(0);
  });

  it("LIMINALIA_SANDBOX=0 なら --no-sandbox を付け、引数はそのまま渡す", () => {
    const dir = join(temp(), "g");
    game(dir, "game");
    const out = spawnSync(join(dir, "game.sh"), ["--x", "y z"], { encoding: "utf8", env: { ...process.env, LIMINALIA_SANDBOX: "0" } }).stdout.trim();
    expect(out).toBe("ARGS:--no-sandbox --x y z");
  });

  /**
   * Linux の実機の代わりに、/proc の値（cat）、chrome-sandbox の持ち主（stat -c %u）、利用者の名前空間を作れるか（unshare）を
   * PATH の先に置いた偽のコマンドで答えて、--no-sandbox を付けるかの決め方を確かめる。
   */
  it("sandbox が使えるか（AppArmor、名前空間、root の setuid の chrome-sandbox）で、--no-sandbox を付けるか決める", () => {
    const dir = join(temp(), "g");
    game(dir, "game");
    const fake = join(temp(), "bin");
    mkdirSync(fake);
    const tool = (name: string, body: string) => {
      writeFileSync(join(fake, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(fake, name), 0o755);
    };
    tool("cat", 'case "$1" in\n  /proc/sys/kernel/apparmor_restrict_unprivileged_userns) printf "%s" "$FAKE_APPARMOR" ;;\n  /proc/sys/kernel/unprivileged_userns_clone) printf "%s" "$FAKE_CLONE" ;;\n  /proc/sys/user/max_user_namespaces) printf "%s" "$FAKE_MAX" ;;\n  *) exec /bin/cat "$@" ;;\nesac');
    tool("stat", 'printf "%s\\n" "${FAKE_OWNER:-1000}"');
    tool("unshare", 'exit "${FAKE_UNSHARE:-0}"');
    const sandbox = join(dir, "chrome-sandbox");
    writeFileSync(sandbox, "");
    const launch = (env: Record<string, string>, setuid = false) => {
      chmodSync(sandbox, setuid ? 0o4755 : 0o755);
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "LIMINALIA_SANDBOX" && !k.startsWith("FAKE_")));
      return spawnSync(join(dir, "game.sh"), [], { encoding: "utf8", env: { ...base, PATH: `${fake}:${process.env.PATH}`, ...env } }).stdout.trim();
    };
    // Ubuntu 24.04 以降の既定（AppArmor が名前空間を止める）で、展開しただけの chrome-sandbox
    expect(launch({ FAKE_APPARMOR: "1" })).toBe("ARGS:--no-sandbox");
    // 同じ環境でも、chrome-sandbox を root の持ち物にして setuid を付ければ sandbox のまま
    expect(launch({ FAKE_APPARMOR: "1", FAKE_OWNER: "0" }, true)).toBe("ARGS:");
    // setuid でも持ち主が root でなければ使えない
    expect(launch({ FAKE_APPARMOR: "1", FAKE_OWNER: "1000" }, true)).toBe("ARGS:--no-sandbox");
    // 名前空間を作れる環境は sandbox のまま。止める設定（Debian の unprivileged_userns_clone、max_user_namespaces）か、作れなければ付ける
    expect(launch({ FAKE_APPARMOR: "0" })).toBe("ARGS:");
    expect(launch({ FAKE_CLONE: "0" })).toBe("ARGS:--no-sandbox");
    expect(launch({ FAKE_MAX: "0" })).toBe("ARGS:--no-sandbox");
    expect(launch({ FAKE_UNSHARE: "1" })).toBe("ARGS:--no-sandbox");
    // LIMINALIA_SANDBOX=1 なら、使えなくても付けない
    expect(launch({ FAKE_APPARMOR: "1", LIMINALIA_SANDBOX: "1" })).toBe("ARGS:");
  });
});

describe("Linux 版の tar.gz", { skip: !posix }, () => {
  it("一覧の持ち主は GNU tar の形（0/0）でも bsdtar の形（0 0）でも読む", () => {
    expect(tarOwner("drwxr-xr-x 0/0         0 2026-11-06 18:27 星を待つ丘/")).toBe("0 0");
    expect(tarOwner("-rw-r--r-- 1000/100 3000 2026-11-06 18:27 星を待つ丘/LICENSE")).toBe("1000 100");
    expect(tarOwner("lrwxrwxrwx 0/0         0 2026-11-06 18:27 星を待つ丘/link -> game")).toBe("0 0");
    expect(tarOwner("drwxr-xr-x  0 0      0           0 Nov  6 18:27 星を待つ丘/")).toBe("0 0");
    expect(tarOwner("-rw-r--r--  0 501    20       3000 Nov  6 18:27 星を待つ丘/LICENSE")).toBe("501 20");
  });

  it("持ち主を root（0）にし、実行の許可、シンボリックリンク、長い名前を保つ", async () => {
    const dir = temp();
    const folder = join(dir, "星を待つ丘");
    const deep = join(folder, "resources", "app.asar.unpacked", "node_modules", "steamworks.js", "dist", "linux64", "a".repeat(60));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(folder, "game"), "#!/bin/sh\n");
    chmodSync(join(folder, "game"), 0o755);
    writeFileSync(join(folder, "LICENSE"), "MIT".repeat(1000));
    writeFileSync(join(deep, `${"b".repeat(120)}.so`), "lib");
    symlinkSync("game", join(folder, "link"));
    chmodSync(folder, 0o700);
    const out = join(dir, "game.tar.gz");
    await tarGz(dir, "星を待つ丘", out);
    const list = execFileSync("tar", ["--numeric-owner", "-tvzf", out], { encoding: "utf8" });
    const owners = list.trim().split("\n").map(tarOwner);
    expect(new Set(owners)).toEqual(new Set(["0 0"]));
    const into = join(dir, "x");
    mkdirSync(into);
    execFileSync("tar", ["-xzf", out, "-C", into]);
    expect(statSync(join(into, "星を待つ丘", "game")).mode & 0o777).toBe(0o755);
    // 作業のフォルダが 700 でも、フォルダは 755、ファイルは 644 で入れる
    expect(list.split("\n")[0]).toMatch(/^drwxr-xr-x /);
    expect(statSync(join(into, "星を待つ丘", "LICENSE")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(into, "星を待つ丘", "LICENSE"), "utf8")).toBe("MIT".repeat(1000));
    expect(lstatSync(join(into, "星を待つ丘", "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(into, "星を待つ丘", "link"))).toBe("game");
    const long = join(into, deep.slice(dir.length + 1), `${"b".repeat(120)}.so`);
    expect(existsSync(long)).toBe(true);
    expect(readFileSync(long, "utf8")).toBe("lib");
  });
});
