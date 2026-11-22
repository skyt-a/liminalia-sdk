import { lex } from "./lexer.ts";
import type { Command, Diagnostic, LexOptions, ScenarioIR } from "./types.ts";

/**
 * .ks を実行用の中間表現にする。
 *
 * TyranoScript は if の分岐先や macro の終端を実行時に前方探索で探すが、ここでは
 * 変換時に対応関係を解決して位置を埋め込む。対応の取れない構造は実行前に
 * エラーとして報告できる。
 */
export function compile(source: string, file: string, options: LexOptions = {}): ScenarioIR {
  const { commands: raw, diagnostics } = lex(source, file, options);
  const commands: Command[] = raw.map((c) => ({ ...c }));
  const labels: Record<string, number> = {};
  const report = (severity: Diagnostic["severity"], code: string, line: number, message: string) => {
    diagnostics.push({ severity, code, message, file, line });
  };

  const ifStack: number[][] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    switch (cmd.name) {
      case "label": {
        const name = cmd.pm.label_name ?? "";
        if (name in labels) {
          report("warning", "duplicate-label", cmd.line, `ラベル *${name} が重複しています（${commands[labels[name]!]!.line} 行目が有効）`);
        } else {
          labels[name] = i;
        }
        break;
      }
      case "if":
        ifStack.push([i]);
        break;
      case "elsif":
      case "else": {
        const chain = ifStack.at(-1);
        if (!chain) {
          report("error", "orphan-branch", cmd.line, `対応する [if] のない [${cmd.name}] です`);
          break;
        }
        const prev = commands[chain.at(-1)!]!;
        if (prev.name === "else") {
          report("error", "branch-after-else", cmd.line, `[else] のあとに [${cmd.name}] があります`);
        }
        chain.push(i);
        break;
      }
      case "endif": {
        const chain = ifStack.pop();
        if (!chain) {
          report("error", "orphan-endif", cmd.line, "対応する [if] のない [endif] です");
          break;
        }
        for (let k = 0; k < chain.length; k++) {
          const branch = commands[chain[k]!]!;
          branch.next = chain[k + 1] ?? i;
          branch.end = i;
        }
        break;
      }
      case "macro":
        resolveTerminator(commands, i, "endmacro", report);
        break;
      case "ignore":
        resolveTerminator(commands, i, "endignore", report);
        break;
      case "iscript":
        resolveScript(commands, i, report);
        break;
    }
  }

  for (const chain of ifStack) {
    report("error", "unclosed-if", commands[chain[0]!]!.line, "[if] に対応する [endif] がありません");
  }

  return { file, commands, labels, diagnostics };
}

type Report = (severity: Diagnostic["severity"], code: string, line: number, message: string) => void;

/** TyranoScript と同じく入れ子を数えず、次に現れる終端タグと対応させる。 */
function resolveTerminator(commands: Command[], start: number, terminator: string, report: Report): void {
  const opener = commands[start]!;
  for (let j = start + 1; j < commands.length; j++) {
    if (commands[j]!.name === terminator) {
      opener.next = j;
      return;
    }
  }
  report("error", `missing-${terminator}`, opener.line, `[${opener.name}] に対応する [${terminator}] がありません`);
}

/** [iscript] から [endscript] までの地の文を本文としてまとめる。 */
function resolveScript(commands: Command[], start: number, report: Report): void {
  const opener = commands[start]!;
  const lines: string[] = [];
  for (let j = start + 1; j < commands.length; j++) {
    const cmd = commands[j]!;
    if (cmd.name === "endscript") {
      opener.next = j;
      opener.body = lines.length > 0 ? lines.join("\n") + "\n" : "";
      return;
    }
    if (cmd.name === "text") {
      lines.push(cmd.val);
    } else {
      report("warning", "tag-in-iscript", cmd.line, `[iscript] 内の [${cmd.name}] は実行されません`);
    }
  }
  report("error", "missing-endscript", opener.line, "[iscript] に対応する [endscript] がありません");
}
