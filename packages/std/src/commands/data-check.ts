import { DEFAULT_SCREEN, isPortrait, jsonLines, uiScale, type Argument, type ScreenSize, type Script, type Statement } from "@liminalia/lang";
import type { PluginCheckProject, PluginDiagnostic } from "@liminalia/sdk";
import { CODEX_FILE, readCodex } from "./codex.ts";
import { INVESTIGATION_FILE, readInvestigation, type InvestigationRect } from "./investigate.ts";
import { parseMask } from "./image.ts";
import { readMap } from "./map-choice.ts";

/**
 * 台本の @investigate・@investigate-reset・@codex・@codex-unlock が指す名前が、作品のデータにあるか（std の check）。
 * データの形そのものは、宣言（INVESTIGATION_DATA・CODEX_DATA）から sdk が確かめる。
 */

/** 命令の位置引数か名前付きの引数の文字（式なら null）。 */
function argText(args: readonly Argument[], name: string, position: number): string | null {
  let pos = 0;
  for (const a of args) {
    const key = a.key ?? (pos++ === position ? name : null);
    if (key !== name) continue;
    return a.value.kind === "string" ? a.value.value : a.value.kind === "number" ? String(a.value.value) : null;
  }
  return null;
}

function* commandsIn(body: readonly Statement[]): Generator<{ name: string; args: readonly Argument[]; line: number }> {
  for (const s of body) {
    if (s.kind === "command") yield { name: s.name, args: s.args, line: s.line };
    else if (s.kind === "if") for (const b of s.branches) yield* commandsIn(b.body);
    else if (s.kind === "define") yield* commandsIn(s.body);
  }
}

/** 作品の画面の大きさ（liminalia.json の screen。無ければ 1280×720）。 */
function screenOf(config: Readonly<Record<string, unknown>>): ScreenSize {
  const s = config.screen as Partial<ScreenSize> | undefined;
  return s && typeof s.width === "number" && typeof s.height === "number" && s.width > 0 && s.height > 0 ? { width: s.width, height: s.height } : DEFAULT_SCREEN;
}

/**
 * @map-choice の説明の欄が覆う範囲（舞台の px）。map-choice.css と同じ形: 端から 24px、中の余白 20px と線 0.5px（文字と枠の px なので画面の大きさで拡大する）。
 * 右と左は中身の幅 30% で上下いっぱい、下は左右いっぱいで中身の高さは多くて 36%。
 * 縦長の作品は panel によらず下に左右いっぱいで、中身の高さは多くて 40%（map-choice.css の .stage.lm-portrait）。
 */
export function mapPanelRect(panel: string | undefined, screen: ScreenSize): InvestigationRect {
  const s = uiScale(screen);
  const gap = 24 * s;
  const frame = (20 + 0.5) * 2 * s;
  if (panel === "bottom" || isPortrait(screen)) {
    const height = screen.height * (isPortrait(screen) ? 0.4 : 0.36) + frame;
    return { x: gap, y: screen.height - gap - height, width: screen.width - gap * 2, height };
  }
  const width = screen.width * 0.3 + frame;
  return { x: panel === "left" ? gap : screen.width - gap - width, y: gap, width, height: screen.height - gap * 2 };
}

/** 説明の欄の下に入って押せない地点（押す範囲のまん中が欄の中にあるもの）を知らせる。 */
function checkMapPanels(project: PluginCheckProject, data: unknown): PluginDiagnostic[] {
  const maps = data && typeof data === "object" && !Array.isArray(data) ? (data as { maps?: unknown }).maps : undefined;
  if (!maps || typeof maps !== "object" || Array.isArray(maps)) return [];
  const screen = screenOf(project.config);
  const text = project.dataText?.(INVESTIGATION_FILE);
  const lines = text !== undefined ? jsonLines(text) : null;
  const file = `${project.dataFolder ?? "data"}/${INVESTIGATION_FILE}`;
  const out: PluginDiagnostic[] = [];
  for (const id of Object.keys(maps)) {
    const map = readMap(data, id);
    if (!map) continue;
    const panel = mapPanelRect(map.panel, screen);
    map.spots.forEach((spot, i) => {
      const r = spot && typeof spot === "object" ? spot.rect : undefined;
      if (!r || ![r.x, r.y, r.width, r.height].every((v) => typeof v === "number")) return;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < panel.x || cx > panel.x + panel.width || cy < panel.y || cy > panel.y + panel.height) return;
      const name = `${spot.id}${spot.label ? `（${spot.label}）` : ""}`;
      out.push({
        severity: "warning",
        code: "map-spot-hidden",
        message: `地図 ${id} の地点 ${name}が説明の欄の下に入り、押せません`,
        messageEn: `Spot ${spot.id} of map ${id} is under the details panel and can't be pressed`,
        hint: "地点を説明の欄の外へ動かすか、地図の panel を right、left、bottom のうち地点と重ならない側にします",
        hintEn: "Move the spot out from under the panel, or set the map's panel to a side (right, left, or bottom) that doesn't cover it",
        file,
        line: lines?.get(`/maps/${id.replace(/~/g, "~0").replace(/\//g, "~1")}/spots/${i}`) ?? 1,
      });
    });
  }
  return out;
}

export function checkStdData(project: PluginCheckProject): PluginDiagnostic[] {
  const out: PluginDiagnostic[] = [];
  out.push(...checkMapPanels(project, project.data(INVESTIGATION_FILE)));
  let investigation: unknown;
  let codex: ReturnType<typeof readCodex> | undefined;
  const scripts: ReadonlyMap<string, Script> = project.scripts;
  for (const [file, script] of scripts) {
    for (const c of commandsIn(script.body)) {
      // 効果をかける範囲（@filter と @effect の mask=）の書き方
      if (c.name === "filter" || c.name === "effect") {
        const mask = argText(c.args, "mask", -1);
        if (mask !== null && !parseMask(mask))
          out.push({
            severity: "error",
            code: "bad-effect-mask",
            message: `@${c.name} の mask=${mask} を読めません（"radial x y 幅 高さ" か "radial-out x y 幅 高さ ぼかし"。どれも px）`,
            messageEn: `Can't read mask=${mask} of @${c.name} (write "radial x y width height" or "radial-out x y width height soft", all in px)`,
            file,
            line: c.line,
          });
      }
      if (c.name === "investigate" || c.name === "investigate-reset") {
        const id = argText(c.args, "id", 0);
        if (id === null) continue;
        investigation ??= project.data(INVESTIGATION_FILE) ?? null;
        // データが無いこと、場所の名前が places に無いことは、引数の型（t.dataKey）の検査が知らせる
        if (investigation === null) continue;
        const view = argText(c.args, "view", -1);
        const place = readInvestigation(investigation, id);
        if (place && view !== null && !place.views.some((v) => v.id === view)) out.push({ severity: "error", code: "unknown-investigation", message: `調べる場所 ${id} に視点 ${view} がありません`, messageEn: `The investigation ${id} has no view ${view}`, file, line: c.line });
      }
      if (c.name === "codex" || c.name === "codex-unlock") {
        const id = argText(c.args, "id", 0);
        if (id === null) continue;
        if (codex === undefined) codex = readCodex(project.data(CODEX_FILE));
        const entry = codex?.entries.find((e) => e.id === id);
        if (!entry) {
          out.push({ severity: "error", code: "unknown-codex-entry", message: `図鑑の項目 ${id} が data/${CODEX_FILE} にありません`, messageEn: `The codex entry ${id} isn't in data/${CODEX_FILE}`, file, line: c.line });
          continue;
        }
        const section = argText(c.args, "section", -1);
        if (section !== null && !(entry.sections ?? []).some((s, i) => (s.id ?? String(i)) === section))
          out.push({ severity: "error", code: "unknown-codex-entry", message: `図鑑の項目 ${id} に段 ${section} がありません`, messageEn: `The codex entry ${id} has no section ${section}`, file, line: c.line });
      }
    }
  }
  return out;
}
