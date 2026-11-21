import type { SaveData } from "./state.ts";

/**
 * セーブデータの版。セーブの形（SaveData や舞台の状態）を、古いセーブがそのまま読めない形に変えたら一つ上げ、
 * MIGRATIONS の末尾に「一つ前の版 → この版」の変換を足す。変換は消さない（どれだけ古いセーブも順にたどって今の版にする）。
 * 項目を足すだけで、無ければ既定で補える変更（読み込み時に補う）は版を上げない。
 */
export const SAVE_VERSION = 1;

type Raw = Record<string, unknown>;

/** MIGRATIONS[i] は版 i + 1 のセーブを版 i + 2 にする。 */
const MIGRATIONS: readonly ((save: Raw) => Raw)[] = [];

/** 読めないセーブの理由。newer: この版のゲームより新しいゲームで作られた。broken: セーブの形をしていない・変換の途中で壊れた。 */
export type SaveProblem = "newer" | "broken";

export class SaveVersionError extends Error {
  constructor(
    readonly problem: SaveProblem,
    message: string,
  ) {
    super(message);
  }
}

/** セーブを今の版にする。読めなければ SaveVersionError。元の値は変えない。 */
export function migrateSave(raw: unknown): SaveData {
  return migrateWith(raw, MIGRATIONS, SAVE_VERSION) as unknown as SaveData;
}

/** 読めないセーブなら理由、読めるなら null（ロードの前に知らせるため）。 */
export function saveProblem(raw: unknown): SaveProblem | null {
  try {
    migrateSave(raw);
    return null;
  } catch (e) {
    return e instanceof SaveVersionError ? e.problem : "broken";
  }
}

/** 変換の連なりをたどる（テストのため変換と今の版を渡せる）。 */
export function migrateWith(raw: unknown, migrations: readonly ((save: Raw) => Raw)[], current: number): Raw {
  if (!isRaw(raw) || !isRaw(raw.position) || typeof raw.position.unit !== "string") throw new SaveVersionError("broken", "セーブデータの形をしていません");
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new SaveVersionError("broken", `セーブデータのバージョン（${String(version)}）を読み込めません`);
  if (version > current) throw new SaveVersionError("newer", `新しいバージョンのゲームで作られたセーブデータです（セーブデータのバージョン ${version}、このゲームは ${current} まで対応）`);
  let save: Raw = structuredClone(raw);
  for (let v = version; v < current; v++) {
    const step = migrations[v - 1];
    if (!step) throw new SaveVersionError("broken", `バージョン ${v} のセーブデータを ${v + 1} に変換する処理がありません`);
    save = step(save);
    save.version = v + 1;
  }
  return save;
}

function isRaw(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
