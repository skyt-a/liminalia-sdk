import { parseArgs } from "@liminalia/lang";

/** ゲームの進行には使わない、台本中のコメントの目印。 */
export interface SceneMarker {
  line: number;
  title: string;
  date?: string;
  event?: string;
}

/** // @scene に自由な見出し、または date= と event= を書く。行番号は 1 始まり。 */
export function sceneMarkers(text: string): SceneMarker[] {
  const out: SceneMarker[] = [];
  let script = false;
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (/^\s*@script(?:\s|$)/.test(line)) { script = true; return; }
    if (script) { if (/^\s*@end\s*$/.test(line)) script = false; return; }
    const m = /^\s*\/\/\s*@scene(?:\s+(.+?))?\s*$/.exec(line);
    const source = m?.[1]?.trim();
    if (!source) return;
    if (!/^(?:date|event)=/.test(source)) {
      out.push({ line: index + 1, title: source });
      return;
    }
    const parsed = parseArgs(source, 1);
    if (parsed.errors.length || parsed.args.some((a) => (a.key !== "date" && a.key !== "event") || a.value.kind === "expr") || new Set(parsed.args.map((a) => a.key)).size !== parsed.args.length) return;
    const get = (key: string) => parsed.args.find((a) => a.key === key)?.value;
    const d = get("date"), e = get("event");
    const asText = (v: typeof d) => !v ? "" : v.kind === "duration" ? v.source : "value" in v ? String(v.value) : "";
    const date = asText(d);
    const event = asText(e);
    if (!date && !event) return;
    out.push({ line: index + 1, title: [date, event].filter(Boolean).join(" · "), ...(date ? { date } : {}), ...(event ? { event } : {}) });
  });
  return out;
}
