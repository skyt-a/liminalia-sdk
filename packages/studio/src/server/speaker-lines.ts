import { plainText } from "@liminalia/lang";
import type { SpeakerLine } from "../protocol.ts";
import { visitStatements } from "./manage.ts";
import type { StudioWorkspace } from "./workspace.ts";

/**
 * 話者ごとの台詞（キャラクターの画面の「台詞」）。文はルビの親文字だけの字面で、ファイルの名前順（数字は数として比べる）・行の順に返す。
 * 数え方は GET /cast/usage の話者ごとの数と同じ（@if と @define の中も含む）。
 */
export function speakerLines(ws: StudioWorkspace, speakers: ReadonlySet<string>): SpeakerLine[] {
  const out: SpeakerLine[] = [];
  const files = [...ws.files()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const file of files) {
    visitStatements(ws.script(file).script.body, (s) => {
      if (s.kind === "say" && speakers.has(s.speaker)) out.push({ file, line: s.line, speaker: s.speaker, text: plainText(s.content) });
    });
  }
  return out;
}
