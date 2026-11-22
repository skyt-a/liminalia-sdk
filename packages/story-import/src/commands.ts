/**
 * Ink のタグ（`# bg: forest.png`）と Yarn Spinner のコマンド（`<<bg forest.png>>`）を .lim のコマンドにする対応表。
 *
 * 鍵はタグ・コマンドの名前（大文字小文字は区別しない）、値は .lim の行の型。型の中の書き方:
 * - `{1}` `{2}` … 何番目の値（無ければ変換しない）
 * - `{2?}` 何番目の値（無ければ空にする）
 * - `{1:s}` 秒の数を .lim の時間にする（`2` → `2s`。単位が付いていればそのまま）
 * - `{*}` すべての値を空白でつないだもの
 * 改行（`\n`）で区切れば複数の行にできる。値を null にすると、そのタグ・コマンドは書き出さない。
 * プロジェクトの liminalia.json の import.ink.commands / import.yarn.commands で足したり上書きしたりできる。
 */
export type CommandMap = Readonly<Record<string, string | null>>;

/** 組み込みの対応表。商業のノベルゲームでよく使われるタグ・コマンドの名前。 */
export const DEFAULT_COMMANDS: CommandMap = {
  bg: "@bg {1}",
  background: "@bg {1}",
  bgm: "@bgm {1}",
  music: "@bgm {1}",
  "stop-bgm": "@stop-bgm",
  stop_bgm: "@stop-bgm",
  stopmusic: "@stop-bgm",
  stop_music: "@stop-bgm",
  se: "@se {1}",
  sfx: "@se {1}",
  sound: "@se {1}",
  voice: "@voice {1}",
  wait: "@wait {1:s}",
  chara: "@chara {1} {2?}",
  show: "@chara {1} {2?}",
  hide: "@chara-hide {1}",
  "hide-all": "@chara-hide-all",
  hide_all: "@chara-hide-all",
  quake: "@quake",
  shake: "@quake",
};

/** タグ・コマンドの文を、名前と値に分ける（`bg: forest.png` も `bg forest.png` も同じ）。"…" で囲んだ値は空白を含められる。 */
export function splitCommand(text: string): { name: string; args: string[] } {
  const t = text.trim();
  const m = /^([^\s:：]+)\s*[:：]?\s*(.*)$/s.exec(t);
  if (!m) return { name: t.toLowerCase(), args: [] };
  return { name: m[1]!.toLowerCase(), args: splitArgs(m[2]!) };
}

function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!);
  return out;
}

/** 値を .lim のパラメータとして書ける形に（空白・" を含むなら "…" で囲む）。 */
function arg(v: string): string {
  return /[\s"]/.test(v) || v === "" ? `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"` : v;
}

/**
 * 対応表で .lim の行にする。対応表に無い名前は "unmapped"、値が足りなければ "missing"、null を当てた名前は空の配列。
 */
export function mapCommand(map: CommandMap, name: string, args: readonly string[]): string[] | "unmapped" | "missing" {
  if (!Object.prototype.hasOwnProperty.call(map, name)) return "unmapped";
  const template = map[name];
  if (template === null || template === undefined) return [];
  let missing = false;
  const text = template.replace(/\{(\*|\d+)(\?|:s|:ms)?\}/g, (_, which: string, mod: string | undefined) => {
    if (which === "*") return args.map(arg).join(" ");
    const v = args[Number(which) - 1];
    if (v === undefined) {
      if (mod !== "?") missing = true;
      return "";
    }
    if (mod === ":s" || mod === ":ms") return /^-?\d+(\.\d+)?$/.test(v) ? `${v}${mod === ":s" ? "s" : "ms"}` : arg(v);
    return arg(v);
  });
  if (missing) return "missing";
  return text.split("\n").map((l) => l.replace(/[ \t]+$/, "").replace(/ {2,}/g, " "));
}
