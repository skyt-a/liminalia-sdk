import type { Diagnostic, LexOptions, Params, RawCommand } from "./types.ts";

export interface LexResult {
  commands: RawCommand[];
  diagnostics: Diagnostic[];
}

/**
 * .ks を命令列に分解する。
 *
 * 規則は TyranoScript の挙動に合わせてある（行単位で前後の空白を切る、`;` 行と `/* … *\/`
 * ブロックはコメント、`*` はラベル、`@` は一行タグ、`#` は話者名、
 * それ以外は地の文と `[tag]` の混在）。TyranoScript が黙って受け入れる崩れた書き方は、
 * 同じように受け入れたうえで診断として報告する。
 */
export function lex(source: string, file: string, options: LexOptions = {}): LexResult {
  const keepSpace = options.keepSpaceInParameterValue ?? "2";
  const commands: RawCommand[] = [];
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Diagnostic["severity"], code: string, line: number, message: string) => {
    diagnostics.push({ severity, code, message, file, line });
  };

  // [iscript] 〜 [endscript] の間は、`[` を含めて行をそのまま地の文として拾う。
  let scriptMode = false;
  let inBlockComment = false;
  const rows = source.split("\n");

  const makeTag = (body: string, line: number): RawCommand => {
    const cmd = parseTag(body, line, keepSpace);
    if (cmd.name === "iscript") scriptMode = true;
    if (cmd.name === "endscript") scriptMode = false;
    return cmd;
  };

  for (let i = 0; i < rows.length; i++) {
    const lineNo = i + 1;
    let row = (rows[i] ?? "").trim();
    const first = row.charAt(0);

    if (row.includes("endscript")) scriptMode = false;

    if (inBlockComment && row === "*/") {
      inBlockComment = false;
      continue;
    }
    if (row === "/*") {
      inBlockComment = true;
      continue;
    }
    if (inBlockComment || first === ";") continue;

    if (first === "#") {
      if (scriptMode) report("warning", "ptext-in-iscript", lineNo, "[iscript] 内の `#` で始まる行が話者名として解釈されます");
      const rest = row.replace("#", "").trim();
      const parts = rest.split(":");
      const pm: Params = parts.length > 1 ? { name: parts[0] ?? "", face: parts[1] ?? "" } : { name: rest, face: "" };
      commands.push({ name: "chara_ptext", pm, val: "", line: lineNo });
      continue;
    }

    if (first === "*") {
      if (scriptMode) report("warning", "label-in-iscript", lineNo, "[iscript] 内の `*` で始まる行がラベルとして解釈されます");
      const parts = row.slice(1).split("|");
      const labelName = (parts[0] ?? "").trim();
      const title = parts.length > 1 ? (parts[1] ?? "").trim() : "";
      commands.push({ name: "label", pm: { label_name: labelName, val: title }, val: title, line: lineNo });
      continue;
    }

    if (first === "@") {
      commands.push(makeTag(row.slice(1), lineNo));
      continue;
    }

    if (first === "_") row = row.slice(1);

    let text = "";
    let tagBody = "";
    let scanningTag = false;
    let depth = 0;
    let quote = "";
    let escaped = false;

    const flushText = () => {
      if (text !== "") {
        commands.push({ name: "text", pm: { val: text }, val: text, line: lineNo, entityDisabled: true });
        text = "";
      }
    };

    for (const c of row) {
      if (scriptMode) {
        text += c;
      } else if (scanningTag) {
        if (c === "]") {
          if (quote !== "") {
            tagBody += c;
          } else {
            depth--;
            if (depth === 0) {
              scanningTag = false;
              commands.push(makeTag(tagBody, lineNo));
              tagBody = "";
              quote = "";
            } else {
              tagBody += c;
            }
          }
        } else if (c === "[") {
          if (quote === "") depth++;
          tagBody += c;
        } else if (c === '"' || c === "'" || c === "`") {
          if (quote === c) quote = "";
          else if (quote === "") quote = c;
          tagBody += c;
        } else {
          tagBody += c;
        }
      } else if (escaped) {
        text += c;
        escaped = false;
      } else if (c === "[") {
        scanningTag = true;
        depth++;
        flushText();
      } else if (c === "\\") {
        escaped = true;
      } else {
        text += c;
      }
    }

    if (tagBody !== "") {
      if (tagBody.endsWith("]")) {
        report("warning", "unbalanced-quote", lineNo, `引用符が閉じていないタグを補正しました: [${tagBody}`);
        tagBody = tagBody.slice(0, -1);
      } else {
        report("warning", "unclosed-tag", lineNo, `\`]\` で閉じていないタグがあります: [${tagBody}`);
      }
      commands.push(makeTag(tagBody, lineNo));
    }
    flushText();
  }

  return { commands, diagnostics };
}

/** `[` と `]` の内側（タグ名と引数）を解析する。 */
export function parseTag(body: string, line: number, keepSpace: "1" | "2" | "3" = "2"): RawCommand {
  const pm: Params = {};
  let state: 1 | 2 | 3 | 4 | 5 = 1;
  let name = "";
  let key = "";
  let value = "";
  let terminator = "";
  let escaped = false;

  // TyranoScript は値 "undefined" を空文字にしたあと、前後を切った値で上書きしてしまう。
  // そのため空文字になるのは KeepSpaceInParameterValue=3 のときだけ。
  const commit = () => {
    const trimmed = value.trim();
    if (keepSpace !== "3") pm[key] = trimmed;
    else pm[key] = trimmed === "undefined" ? "" : value;
  };

  for (let c of body) {
    switch (state) {
      case 1: // タグ名
        if (c === " ") {
          if (name !== "") state = 2;
        } else {
          name += c;
        }
        break;
      case 2: // 引数名
        if (c === " ") {
          if (key !== "") state = 3;
        } else if (c === "=") {
          state = 4;
        } else {
          key += c;
        }
        break;
      case 3: // 引数名のあとの空白（= が来なければ値なしの引数）
        if (c === "=") {
          state = 4;
        } else if (c !== " ") {
          pm[key] = "";
          key = c;
          state = 2;
        }
        break;
      case 4: // = のあと、値の開始待ち
        if (c === '"' || c === "'" || c === "`") {
          terminator = c;
          state = 5;
        } else if (c !== " ") {
          terminator = " ";
          value = c;
          state = 5;
        }
        break;
      case 5: // 値
        if (c === terminator) {
          if (escaped) {
            escaped = false;
            value += c;
          } else {
            commit();
            key = "";
            value = "";
            terminator = "";
            state = 2;
          }
        } else {
          if (terminator !== "`" && c === " " && keepSpace === "1") c = "";
          // TyranoScript ではエスケープ状態が次の終端文字まで続く（`\` の直後だけではない）。
          if (escaped) {
            value += c;
          } else if (c === "\\") {
            escaped = true;
          } else {
            value += c;
          }
        }
        break;
    }
  }
  if (key !== "") commit();

  return { name, pm, val: "", line };
}
