import type { Argument, Diagnostic, Script, Statement, Target } from "./ast.ts";
import { parseTargetText } from "./args.ts";
import { printInline } from "./inline.ts";
import { hash, similarity } from "./text-hash.ts";

/**
 * 連番のボイス（@voice-auto）の番号の固定（プロジェクトの voice-lock.json）。
 *
 * @voice-auto の番号は、鳴らすたびに一つ進む数え方なので、台詞を一行足すとその後ろの番号がすべてずれ、
 * 分かれ道のどちらを通ったかでも変わる。収録したあとは、台詞ごとに番号を固定しておく:
 * - 台詞の鍵（ファイル・話者・原文。同じファイルに同じ台詞が何度もあれば何度目か）→ 番号
 * - 固定があれば、実行器は固定した番号を鳴らす。固定に無い台詞（収録の後に足した台詞）は鳴らさない
 * - lim voice-lock が作り直す。今の固定は変えず、新しい台詞には番号を足す（原文を少し書き換えた台詞は前の番号を引き継ぎ、
 *   それ以外は話者ごとに今までの一番大きい番号の次から）。初めて作るときは、遊ぶ順に流して今の数え方の番号を写す
 */
export interface VoiceLock {
  /** 台詞の鍵 → 番号。 */
  lines: Record<string, VoiceLockEntry>;
  /** 今のシナリオに無い台詞の番号（同じ番号を別の台詞に振らないため・台詞を戻したら使うため）。 */
  retired?: Record<string, VoiceLockEntry>;
}

export interface VoiceLockEntry {
  speaker: string;
  n: number;
  /** 原文（人が見るため。書き換えの前後を見つけるため）。 */
  source: string;
  /**
   * 書き換える前の台詞から番号を引き継いだ（収録したボイスと今の原文が違う。録り直すまで残す）。
   * 収録用の台本の「要再収録」の列に出し、録り直したら lim voice-lock --clear-rerecord で消す。
   */
  rerecord?: true;
}

export interface VoiceLine {
  key: string;
  speaker: string;
  source: string;
  file: string;
  line: number;
  /** パック（packs/<フォルダ>）の台詞なら、そのフォルダ（file はパックの scenario からの台本の名前）。updateVoiceLock の packDirs を渡したときだけ付く。 */
  pack?: string;
}

/** 連番のボイスのファイル名（{n} と {n:桁} を番号に置き換える）。 */
export function voiceFile(pattern: string, n: number): string {
  return pattern.replace(/\{n(?::(\d+))?\}/g, (_m, width: string | undefined) => (width ? String(n).padStart(Number(width), "0") : String(n)));
}

/** シナリオの台詞（話者のある本文の行）を、書いてある順に鍵つきで。@if・@define の中も。 */
export function voiceLines(script: Script): VoiceLine[] {
  const out: VoiceLine[] = [];
  const seen = new Map<string, number>();
  const visit = (body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "say" && s.id) {
        // 固定の行 ID（#line:ID）のある台詞は、原文によらない鍵（原文を書き換えても番号が外れない）
        out.push({ key: `${script.file}:v@${s.id}`, speaker: s.speaker, source: printInline(s.content), file: script.file, line: s.line });
      } else if (s.kind === "say") {
        const source = printInline(s.content);
        const base = `${script.file}:v${hash(`${s.speaker}\u0000${source}`)}`;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        out.push({ key: count === 1 ? base : `${base}-${count}`, speaker: s.speaker, source, file: script.file, line: s.line });
      } else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  return out;
}

/** @voice-auto で pattern を書いた話者ごとの設定（字面で書いたものだけ）。 */
export function voiceAutoSettings(scripts: ReadonlyMap<string, Script>): Map<string, { pattern: string; folder: string; file: string; line: number }[]> {
  const out = new Map<string, { pattern: string; folder: string; file: string; line: number }[]>();
  const visit = (file: string, body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "command" && s.name === "voice-auto") {
        const get = (k: string) => s.args.find((a) => a.key === k) ?? (k === "who" ? s.args.find((a) => a.key === null) : undefined);
        const who = get("who")?.value;
        const pattern = get("pattern")?.value;
        const folder = get("folder")?.value;
        if (who?.kind === "string" && pattern?.kind === "string") {
          const list = out.get(who.value) ?? [];
          list.push({ pattern: pattern.value, folder: folder?.kind === "string" ? folder.value : "voice", file, line: s.line });
          out.set(who.value, list);
        }
      } else if (s.kind === "if") for (const b of s.branches) visit(file, b.body);
      else if (s.kind === "define") visit(file, s.body);
    }
  };
  for (const [file, script] of scripts) visit(file, script.body);
  return out;
}

/** 話者ごとの連番の状態（0: 設定していない、1: 設定して止めている、2: 効いている）。 */
type AutoState = 0 | 1 | 2;
interface VoiceFlow {
  /** 話者 → ありうる状態（無い話者は {0}）。 */
  auto: Map<string, Set<AutoState>>;
  /** 次の台詞で鳴らす @voice があるか（ありうるもの）。 */
  pending: Set<boolean>;
}

const cloneFlow = (f: VoiceFlow): VoiceFlow => ({ auto: new Map([...f.auto].map(([k, v]) => [k, new Set(v)])), pending: new Set(f.pending) });
function mergeFlow(a: VoiceFlow, b: VoiceFlow): VoiceFlow {
  const out = cloneFlow(a);
  for (const [k, v] of b.auto) {
    const now = out.auto.get(k) ?? new Set<AutoState>([0]);
    for (const x of v) now.add(x);
    out.auto.set(k, now);
  }
  for (const k of out.auto.keys()) if (!b.auto.has(k)) out.auto.get(k)!.add(0);
  for (const x of b.pending) out.pending.add(x);
  return out;
}
const sameFlow = (a: VoiceFlow, b: VoiceFlow) =>
  a.pending.size === b.pending.size && [...a.pending].every((x) => b.pending.has(x)) && a.auto.size === b.auto.size && [...a.auto].every(([k, v]) => b.auto.get(k)?.size === v.size && [...v].every((x) => b.auto.get(k)!.has(x)));

/**
 * 連番のボイス（@voice-auto）が鳴る台詞（"ファイル:行"）。実行器と同じく、その話者の @voice-auto が効いていて、すぐ前に @voice の無い台詞だけ。
 * 台本を上から読み、話者ごとの状態（設定していない・止めている・効いている）と、次の台詞で鳴らす @voice を追う。
 * - ファイルの始まりの状態は、そのファイルへ飛ぶ所（@jump・@call・選択肢）の状態を合わせたもの。「はじめから」のファイル（entry）は何も効いていない状態も
 * - どこからも飛ばれないファイル（式の飛び先・プラグインの行き先だけで着く所）は、設定のある話者が効いているかもしれないとみなす
 * - @if の枝はそれぞれ読んで合わせ、マクロの呼び出しはマクロの中身を読む
 * 分からない所は鳴るかもしれないほう（番号を振るほう）に倒す。
 */
export function autoVoicedLines(scripts: ReadonlyMap<string, Script>, o: { entry?: string | undefined } = {}): Set<string> {
  const macros = new Map<string, Statement[]>();
  for (const script of scripts.values()) for (const s of script.body) if (s.kind === "define" && s.name !== "") macros.set(s.name, s.body);
  const configured = new Set(voiceAutoSettings(scripts).keys());
  const entries = new Map<string, VoiceFlow>();
  const entryFile = o.entry ? (parseTargetText(o.entry)?.file ?? o.entry.split("#")[0]!) : undefined;
  const fresh = (): VoiceFlow => ({ auto: new Map(), pending: new Set([false]) });
  if (entryFile !== undefined && scripts.has(entryFile)) entries.set(entryFile, fresh());
  const voiced = new Set<string>();

  const argOf = (args: readonly Argument[], key: string, position: number): Argument | undefined => args.find((a) => a.key === key) ?? args.filter((a) => a.key === null)[position];
  const stringOf = (a: Argument | undefined): string | undefined => (a?.value.kind === "string" ? a.value.value : undefined);

  /** 一つのファイルを entry の状態から読む。飛び先のファイルの始まりの状態を足し、台詞を voiced に入れる。 */
  const walkFile = (file: string, start: VoiceFlow, reach: (file: string, flow: VoiceFlow) => void) => {
    const toTarget = (target: Target, flow: VoiceFlow) => {
      const texts = target.expr ? (target.candidates ?? []) : [target.file ?? ""];
      for (const t of texts) {
        const f = target.expr ? parseTargetText(t)?.file : target.file;
        if (f && f !== file && scripts.has(f)) reach(f, flow);
      }
    };
    const block = (body: readonly Statement[], flow: VoiceFlow, stack: readonly string[]): VoiceFlow => {
      let now = flow;
      for (const s of body) {
        switch (s.kind) {
          case "say":
            if ([...(now.auto.get(s.speaker) ?? [0])].includes(2) && now.pending.has(false)) voiced.add(`${file}:${s.line}`);
            now = { ...now, pending: new Set([false]) };
            break;
          case "prose":
            now = { ...now, pending: new Set([false]) };
            break;
          case "command":
            now = command(s.name, s.args, now, stack);
            break;
          case "if": {
            if (s.with) {
              const macro = macros.get(s.with.name);
              if (macro && !stack.includes(s.with.name)) now = block(macro, now, [...stack, s.with.name]);
              now = block(s.branches[0]?.body ?? [], now, stack);
              break;
            }
            if (s.loop) {
              now = mergeFlow(now, block(s.branches[0]?.body ?? [], cloneFlow(now), stack));
              break;
            }
            let merged: VoiceFlow | null = null;
            for (const b of s.branches) {
              const out = block(b.body, cloneFlow(now), stack);
              merged = merged ? mergeFlow(merged, out) : out;
            }
            if (!s.branches.some((b) => b.condition === null)) merged = merged ? mergeFlow(merged, now) : now;
            now = merged ?? now;
            break;
          }
          case "jump":
          case "call":
            toTarget(s.target, now);
            break;
          case "choice":
            for (const opt of s.options) toTarget(opt.target, now);
            break;
          default:
            break;
        }
      }
      return now;
    };
    const command = (name: string, args: readonly Argument[], flow: VoiceFlow, stack: readonly string[]): VoiceFlow => {
      const macro = macros.get(name);
      if (macro) return stack.includes(name) ? flow : block(macro, flow, [...stack, name]);
      if (name === "voice") return { ...flow, pending: new Set([true]) };
      if (name !== "voice-auto" && name !== "voice-auto-off") return flow;
      const who = stringOf(argOf(args, "who", 0));
      const next = cloneFlow(flow);
      const targets = who !== undefined ? [who] : [...next.auto.keys()];
      for (const t of targets) {
        const now = next.auto.get(t) ?? new Set<AutoState>([0]);
        let to: Set<AutoState>;
        if (name === "voice-auto-off") to = new Set([...now].map((x) => (x === 2 ? 1 : x)));
        else if (argOf(args, "pattern", -1)) {
          // 設定する（start=false なら止めたまま）
          const start = argOf(args, "start", -1)?.value;
          to = new Set([start?.kind === "bool" && !start.value ? 1 : 2]);
        } else to = new Set([...now].map((x) => (x === 1 ? 2 : x)));
        next.auto.set(t, to);
      }
      return next;
    };
    block(scripts.get(file)!.body, start, []);
  };

  // ファイルの始まりの状態を、飛ぶ所から合わせて広げる（変わらなくなるまで）
  for (let round = 0; round < scripts.size * 4 + 4; round++) {
    let changed = false;
    for (const [file, flow] of [...entries]) {
      walkFile(file, flow, (to, f) => {
        const before = entries.get(to);
        const after = before ? mergeFlow(before, f) : cloneFlow(f);
        if (!before || !sameFlow(before, after)) {
          entries.set(to, after);
          changed = true;
        }
      });
    }
    if (!changed) break;
  }
  // どこからも飛ばれないファイルは、設定のある話者が効いているかもしれない
  const unknown = (): VoiceFlow => ({ auto: new Map([...configured].map((k) => [k, new Set<AutoState>([0, 1, 2])])), pending: new Set([false]) });
  for (const file of scripts.keys()) if (!entries.has(file)) walkFile(file, unknown(), () => undefined);
  return voiced;
}

/** これ以上近ければ、書き換える前の台詞とみなして番号を引き継ぐ。 */
const NEAR = 0.6;

export interface VoiceLockUpdate {
  lock: VoiceLock;
  /** 今の固定のまま。 */
  kept: number;
  /** 流して見た番号を写した（初めて作るとき）。 */
  captured: number;
  /** 書き換える前の台詞の番号を引き継いだ。 */
  carried: number;
  /** 書き換える前の台詞から番号を引き継いだ台詞（収録したボイスと原文が違うので、録り直す）。 */
  rerecord: VoiceLine[];
  /** 新しい番号を振った。 */
  added: number;
  /** 通り方によって番号が変わった・ほかの台詞と同じ番号が鳴った台詞（初めて作るとき。空いている一番小さい番号か、新しい番号を振った）。 */
  varied: VoiceLine[];
  /** 読まなかったパックの組み合わせの数（台本のあるパックが PACK_COMBINATION_LIMIT を超えたとき。skippedPlaySets）。 */
  skippedSets: number;
}

/**
 * パック（packs/<id>/scenario）の台本（台本の名前 → 構文木。パックごと）。遊ぶ側は本体の voice-lock.json をパックの台詞にも使う。
 */
export type PackScripts = ReadonlyMap<string, Script>;

/**
 * すべての組み合わせを並べる、台本のあるパックの数の上限。組み合わせは 2 の（パックの数）乗に増えるので、これを超えたら playSets は
 * 本体だけ、本体に一つずつ、本体にすべての組だけを並べ、並べなかった組の数（skippedPlaySets）を lim voice-lock と制作画面が知らせる。
 */
export const PACK_COMBINATION_LIMIT = 8;

/**
 * 一緒に遊ばれる台本の組（流れを読んで決める所が使う。連番が鳴る台詞と、初めて番号を固定するときの流し）。
 * 遊ぶ人はパックのどの組み合わせでも入れうるので、本体だけ、パックを一つずつ、二つずつ…と、すべての組み合わせを小さい順に並べる
 * （組の中は遊ぶ側の並び。パックの同じ名前の台本は、前の台本を差し替える。packs は遊ぶ側の並び（pack.json の order、id の順）で渡す）。
 * 台本の無いパックは組を変えないので数えない。台本のあるパックが PACK_COMBINATION_LIMIT を超えたら、本体だけ、本体に一つずつ、本体にすべての組だけ。
 */
export function playSets(scripts: ReadonlyMap<string, Script>, packs: readonly PackScripts[] = []): ReadonlyMap<string, Script>[] {
  const used = packs.filter((p) => p.size > 0);
  return packCombinations(used.length).map((chosen) => (chosen.length === 0 ? scripts : new Map([...scripts, ...chosen.flatMap((i) => [...used[i]!])])));
}

/**
 * n 個のパックの組み合わせ（パックの番号の並び。playSets と初めての写し取りが使う）。本体だけ（空）、一つずつ、二つずつ…の小さい順で、
 * 同じ大きさの中は前のパックを含むものから、組の中は並びの順（パックが一つか二つなら前の版と同じ順）。
 * n が PACK_COMBINATION_LIMIT を超えたら、本体だけ、一つずつ、すべての組だけ。
 */
export function packCombinations(n: number): number[][] {
  const all = Array.from({ length: n }, (_, i) => i);
  if (n > PACK_COMBINATION_LIMIT) return [[], ...all.map((i) => [i]), all];
  const combos = Array.from({ length: 2 ** n }, (_, m) => all.filter((i) => (m >> i) & 1));
  const order = (c: readonly number[]) => all.map((i) => (c.includes(i) ? "0" : "1")).join("");
  return combos.sort((a, b) => a.length - b.length || (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/** playSets が並べなかったパックの組み合わせの数（台本のあるパックが PACK_COMBINATION_LIMIT 以下なら 0）。 */
export function skippedPlaySets(packs: readonly PackScripts[]): number {
  const n = packs.filter((p) => p.size > 0).length;
  return n > PACK_COMBINATION_LIMIT ? 2 ** n - (n + 2) : 0;
}

/**
 * 固定を今のシナリオに合わせる（lim voice-lock）。speakers は連番のボイスを使う話者。
 * observed は初めて作るときに流して見た番号（台詞の鍵 → 鳴った番号）。固定があるときは使わない。
 * packs はパックの台本。パックを入れて遊ぶときに鳴る台詞（本体に重ねて読む。パックのどの組み合わせも。playSets）にも番号を振り、
 * パックの台詞の番号を retired に移さない。packDirs（packs と同じ並びのパックのフォルダ）を渡すと、返す台詞のうちパックのものに pack を付ける。
 */
export function updateVoiceLock(
  existing: VoiceLock | null,
  scripts: ReadonlyMap<string, Script>,
  speakers: ReadonlySet<string>,
  observed?: ReadonlyMap<string, ReadonlySet<number>>,
  o: { entry?: string | undefined; packs?: readonly PackScripts[]; packDirs?: readonly string[] } = {},
): VoiceLockUpdate {
  // 番号を振るのは、連番のボイスが鳴る台詞だけ（@voice-auto が効いていて、@voice の無い台詞。autoVoicedLines）。
  // 本体だけで遊ぶとき、パックを一つずつ、二つずつ…重ねて遊ぶときの順に読み、同じ鍵は一度だけ（パックの台詞は本体の台詞のあとに番号を振る）
  const lines: VoiceLine[] = [];
  const live = new Set<string>();
  const packOf = (name: string, script: Script): string | undefined => {
    if (!o.packDirs || scripts.get(name) === script) return undefined;
    const i = (o.packs ?? []).findIndex((p) => p.get(name) === script);
    return i >= 0 ? o.packDirs[i] : undefined;
  };
  for (const set of playSets(scripts, o.packs)) {
    const voiced = autoVoicedLines(set, o);
    for (const name of [...set.keys()].sort()) {
      const script = set.get(name)!;
      const pack = packOf(name, script);
      for (const l of voiceLines(script)) {
        if (!speakers.has(l.speaker) || !voiced.has(`${l.file}:${l.line}`) || live.has(l.key)) continue;
        live.add(l.key);
        lines.push(pack === undefined ? l : { ...l, pack });
      }
    }
  }
  const old = existing?.lines ?? {};
  const retired = new Map(Object.entries({ ...(existing?.retired ?? {}), ...old }).filter(([k]) => !live.has(k)));
  // 話者ごとの使った番号（使われなくなった台詞の番号も、別の台詞に振らない）
  const used = new Map<string, Set<number>>();
  const use = (speaker: string, n: number) => (used.get(speaker) ?? used.set(speaker, new Set()).get(speaker)!).add(n);
  for (const e of [...Object.values(old), ...retired.values()]) use(e.speaker, e.n);

  const out: Record<string, VoiceLockEntry> = {};
  const r: VoiceLockUpdate = { lock: { lines: out }, kept: 0, captured: 0, carried: 0, added: 0, varied: [], rerecord: [], skippedSets: skippedPlaySets(o.packs ?? []) };
  const pending: VoiceLine[] = [];
  for (const l of lines) {
    const entry = old[l.key] ?? existing?.retired?.[l.key];
    if (entry) {
      // 固定の行 ID の台詞は、鍵が同じでも原文が変わっていることがある（収録したボイスと違うので録り直す）
      const rerecord = entry.rerecord === true || (typeof entry.source === "string" && entry.source !== l.source);
      out[l.key] = { speaker: l.speaker, n: entry.n, source: l.source, ...(rerecord ? { rerecord: true as const } : {}) };
      if (rerecord) r.rerecord.push(l);
      retired.delete(l.key);
      r.kept++;
      continue;
    }
    const seen = existing ? undefined : observed?.get(l.key);
    const free = [...(seen ?? [])].sort((a, b) => a - b).filter((n) => !used.get(l.speaker)?.has(n));
    // 通り方で番号が変わった・ほかの台詞と同じ番号が鳴った台詞は、確かめてもらう
    if (seen && (seen.size > 1 || free.length === 0)) r.varied.push(l);
    if (free.length > 0) {
      out[l.key] = { speaker: l.speaker, n: free[0]!, source: l.source };
      use(l.speaker, free[0]!);
      r.captured++;
      continue;
    }
    pending.push(l);
  }
  for (const l of pending) {
    let best: [string, number] | null = null;
    for (const [k, e] of retired) {
      if (e.speaker !== l.speaker || k.slice(0, k.lastIndexOf(":")) !== l.file) continue;
      const score = similarity(l.source, e.source);
      if (score >= NEAR && (!best || score > best[1])) best = [k, score];
    }
    if (best) {
      // 原文が変わったので、収録したボイスは録り直す（録り直すまで印を残す）。原文が同じ（行 ID を振って鍵だけ変わった）なら録り直さない
      const was = retired.get(best[0])!;
      const rerecord = was.rerecord === true || was.source !== l.source;
      out[l.key] = { speaker: l.speaker, n: was.n, source: l.source, ...(rerecord ? { rerecord: true as const } : {}) };
      retired.delete(best[0]);
      r.carried++;
      if (rerecord) r.rerecord.push(l);
      continue;
    }
    const n = Math.max(0, ...(used.get(l.speaker) ?? [])) + 1;
    out[l.key] = { speaker: l.speaker, n, source: l.source };
    use(l.speaker, n);
    r.added++;
  }
  if (retired.size > 0) r.lock.retired = Object.fromEntries(retired);
  return r;
}

/**
 * 固定の検査。固定に無い台詞（鳴らない）・同じ話者の同じ番号・無いボイスのファイルを知らせる。
 * 同じ番号は、パックのどれかの組み合わせ（本体だけも）で一緒に遊ばれる台本どうしの台詞だけを見る（組み合わせを並べずに、二つの台詞の持ち主だけを入れた組で決める。
 * パックの数によらずすべての組み合わせと同じ結果）。今のシナリオに無い台詞の番号は鳴らないので重ならず（voice-lock-outdated で知らせる）、
 * パックが差し替える本体の台本の台詞とパックの台詞も重ならない（lim migrate が写した鍵など）。
 * packs はパックの台本（パックだけが使う番号を「今のシナリオに無い」にしない）。固定に無い台詞（voice-unlocked）は本体の台本だけを見る。
 * exists は voice（または sound）フォルダからのパスがあるか。
 */
export function checkVoiceLock(lock: VoiceLock, scripts: ReadonlyMap<string, Script>, exists: (folder: string, path: string) => boolean, o: { entry?: string | undefined; packs?: readonly PackScripts[] } = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const settings = voiceAutoSettings(scripts);
  const lockFile = "voice-lock.json";
  // 連番のボイスが鳴らない台詞（@voice-auto が効いていない・@voice がある）は、番号が無くても知らせない
  const voiced = autoVoicedLines(scripts, o);
  for (const [file, script] of scripts) {
    for (const l of voiceLines(script)) {
      if (settings.has(l.speaker) && voiced.has(`${file}:${l.line}`) && !lock.lines[l.key]) out.push({ severity: "warning", code: "voice-unlocked", message: `${l.speaker} のこの台詞はボイスの番号が決まっていないため再生されません`, file, line: l.line, hint: "収録したら lim voice-lock で番号を振ります" });
    }
  }
  // 台詞の鍵 → 書いてある所（版: 0 は本体、i + 1 はパック i。台本の名前）
  const versions = [scripts, ...(o.packs ?? [])];
  const where = new Map<string, { version: number; name: string }[]>();
  versions.forEach((set, version) => {
    for (const [name, script] of set) for (const l of voiceLines(script)) (where.get(l.key) ?? where.set(l.key, []).get(l.key)!).push({ version, name });
  });
  const live = new Set(where.keys());
  // 二つの台詞が一緒に鳴る組があるか。本体と、二つの持ち主のパックだけを入れた組で見れば足りる（ほかのパックを足しても、台本を差し替えて隠すだけ）。
  // その組では、後ろの版がもう一つの台本と同じ名前の台本を持つときだけ、前の台本が隠れる
  const together = (a: { version: number; name: string }, b: { version: number; name: string }) => {
    if (a.version === b.version) return true;
    const [first, later] = a.version < b.version ? [a, b] : [b, a];
    return !versions[later.version]!.has(first.name);
  };
  const playedTogether = (k1: string, k2: string) => (where.get(k1) ?? []).some((a) => (where.get(k2) ?? []).some((b) => together(a, b)));
  const bySpeaker = new Map<string, Map<number, string[]>>();
  for (const [key, e] of Object.entries(lock.lines)) {
    const m = bySpeaker.get(e.speaker) ?? bySpeaker.set(e.speaker, new Map()).get(e.speaker)!;
    m.set(e.n, [...(m.get(e.n) ?? []), key]);
  }
  for (const [speaker, m] of bySpeaker) {
    // 同じ番号は、パックのどれかの組み合わせで一緒に鳴る台詞どうしで重なるときだけ（パックが差し替える本体の台本の台詞とは重ならない）
    const dup = [...m].filter(([, keys]) => keys.some((k1, i) => keys.slice(i + 1).some((k2) => playedTogether(k1, k2))));
    if (dup.length > 0) out.push({ severity: "error", code: "voice-lock-duplicate", message: `${speaker} の番号 ${dup.map(([n]) => n).join("、")} が複数の台詞に振られています`, file: lockFile, line: 1 });
    const set = settings.get(speaker);
    // 型が一つに決まる話者だけ、ファイルがあるかを見る
    const patterns = new Set(set?.map((s) => `${s.folder}\u0000${s.pattern}`));
    if (patterns.size !== 1) continue;
    const { pattern, folder } = set![0]!;
    const missing = [...m.keys()].sort((a, b) => a - b).map((n) => voiceFile(pattern, n)).filter((p) => !exists(folder, p));
    if (missing.length > 0) out.push({ severity: "warning", code: "missing-voice", message: `${speaker} のボイスが ${missing.length} 件ありません: ${missing.slice(0, 5).join("、")}${missing.length > 5 ? " ほか" : ""}`, file: lockFile, line: 1 });
  }
  const orphan = Object.keys(lock.lines).filter((k) => !live.has(k)).length;
  if (orphan > 0) out.push({ severity: "warning", code: "voice-lock-outdated", message: `今のシナリオにない台詞の番号が ${orphan} 件あります（台詞を書き換えたか削除した）`, file: lockFile, line: 1, hint: "lim voice-lock で合わせます（書き換えた台詞は前の番号を引き継ぎます）" });
  return out;
}
