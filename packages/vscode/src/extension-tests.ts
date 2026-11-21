import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import * as vscode from "vscode";
import type { LaunchContext } from "./studio-launch.ts";
import { limTestLaunch, parseLimTestJson, projectRootOf, testItemsOf } from "./testing.ts";

/**
 * 台本のテスト（tests/*.limtest）を VS Code の Testing の口（テストの画面と、エディタの行の頭の実行ボタン）に載せる。
 * ワークスペースの .limtest をファイルごとに並べ、中の `# 名前` の行をテストにする（開いて書き換えると並べ直す）。
 * 流すと、作品ごとに lim test --json を動かし（testing.ts。lim の探し方は「ここからテストプレイ」の lim studio と同じ）、
 * 通ったか、期待と違った行と理由を、そのテストに付ける。
 */
export function registerScenarioTests(context: vscode.ExtensionContext, tr: (ja: string, en: string) => string): void {
  const controller = vscode.tests.createTestController("liminaliaScenarioTests", tr("Liminalia のシナリオテスト", "Liminalia script tests"));
  context.subscriptions.push(controller);

  const fileItem = (uri: vscode.Uri): vscode.TestItem => {
    const id = uri.toString();
    let item = controller.items.get(id);
    if (!item) {
      item = controller.createTestItem(id, vscode.workspace.asRelativePath(uri), uri);
      item.canResolveChildren = true;
      controller.items.add(item);
    }
    return item;
  };
  const textOf = async (uri: vscode.Uri): Promise<string> => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  };
  /** ファイルの中のテストを並べ直す（読めない行はファイルの誤りに出す）。 */
  const fill = (item: vscode.TestItem, text: string) => {
    const { tests, problems } = testItemsOf(text, item.uri!.fsPath);
    item.children.replace(
      tests.map((t) => {
        const child = controller.createTestItem(`${item.id}#${t.line}`, t.name, item.uri);
        child.range = new vscode.Range(t.line - 1, 0, t.line - 1, 0);
        return child;
      }),
    );
    item.error = problems.length > 0 ? problems.map((p) => `${p.line}: ${p.message}`).join("\n") : undefined;
  };
  const refresh = (uri: vscode.Uri) => void textOf(uri).then((text) => fill(fileItem(uri), text), () => undefined);

  controller.resolveHandler = async (item) => {
    if (!item) {
      for (const uri of await vscode.workspace.findFiles("**/*.limtest", "**/node_modules/**")) fileItem(uri);
      return;
    }
    if (item.uri) fill(item, await textOf(item.uri));
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.limtest");
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refresh),
    watcher.onDidDelete((uri) => controller.items.delete(uri.toString())),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.path.endsWith(".limtest")) fill(fileItem(e.document.uri), e.document.getText());
    }),
  );

  const launchContext = (root: string): LaunchContext => {
    const settings = vscode.workspace.getConfiguration("liminalia");
    return {
      root,
      limSetting: settings.get<string>("lim") ?? "",
      appSetting: settings.get<string>("studioApp") ?? "",
      node: settings.get<string>("node") ?? "",
      execPath: process.execPath,
      platform: process.platform,
      home: homedir(),
      env: process.env,
      exists: existsSync,
      trusted: vscode.workspace.isTrusted,
    };
  };

  const run = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    const testRun = controller.createTestRun(request);
    // 書きかけの台本とテストを保存してから流す（lim はファイルを読む）
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty && (doc.languageId === "liminalia" || doc.uri.path.endsWith(".limtest"))) await doc.save();
    // 流すテスト（ファイルを選べば、その中のすべて）
    const picked: vscode.TestItem[] = [];
    const excluded = new Set((request.exclude ?? []).map((t) => t.id));
    const roots = request.include ?? [...collect(controller.items)];
    for (const item of roots) {
      if (excluded.has(item.id)) continue;
      if (item.children.size === 0 && item.uri && !item.id.includes("#")) fill(item, await textOf(item.uri));
      if (item.id.includes("#")) picked.push(item);
      else for (const child of collect(item.children)) if (!excluded.has(child.id)) picked.push(child);
    }
    // 作品ごとにまとめて lim test を一度動かす
    const byProject = new Map<string, vscode.TestItem[]>();
    for (const t of picked) {
      const root = t.uri ? projectRootOf(t.uri.fsPath, existsSync) : null;
      if (!root) {
        testRun.errored(t, new vscode.TestMessage(tr("liminalia.json のあるプロジェクトのテストではありません", "This test isn't inside a project with liminalia.json")));
        continue;
      }
      (byProject.get(root) ?? byProject.set(root, []).get(root)!).push(t);
    }
    for (const [root, tests] of byProject) {
      if (token.isCancellationRequested) break;
      const files = [...new Set(tests.map((t) => t.uri!.fsPath))];
      const launch = limTestLaunch(launchContext(root), files);
      if (!launch) {
        const why = tr(
          "lim が見つかりません。設定の liminalia.lim に lim の場所（lim.mjs か lim）を設定するか、プロジェクトに @liminalia/cli をインストールしてください（信頼していないワークスペースではプロジェクト内の lim を実行しません）",
          "lim wasn't found. Set the location of lim (lim.mjs or lim) in the liminalia.lim setting, or install @liminalia/cli in the project (in an untrusted workspace, the lim inside the project doesn't run)",
        );
        for (const t of tests) testRun.errored(t, new vscode.TestMessage(why));
        continue;
      }
      for (const t of tests) testRun.started(t);
      const out = await new Promise<string>((done) => {
        const child = spawn(launch.command, launch.args, { cwd: root, env: { ...process.env, ...(launch.env ?? {}), NO_COLOR: "1" } });
        let text = "";
        child.stdout.on("data", (b: Buffer) => (text += b.toString()));
        child.stderr.on("data", (b: Buffer) => {
          text += b.toString();
          testRun.appendOutput(b.toString().replace(/\r?\n/g, "\r\n"));
        });
        const stop = token.onCancellationRequested(() => child.kill());
        child.on("error", (e) => {
          stop.dispose();
          done(`${text}\n${e.message}`);
        });
        child.on("close", () => {
          stop.dispose();
          done(text);
        });
      });
      const results = parseLimTestJson(out);
      if (!results) {
        const message = new vscode.TestMessage(out.trim() || tr("lim test の結果を読めませんでした", "Couldn't read the result of lim test"));
        for (const t of tests) testRun.errored(t, message);
        continue;
      }
      for (const t of tests) {
        const file = relative(root, t.uri!.fsPath).split(sep).join("/");
        const line = Number(t.id.slice(t.id.lastIndexOf("#") + 1));
        const outcome = results.files.get(file)?.tests.get(line);
        if (!outcome) {
          testRun.skipped(t);
          continue;
        }
        if (outcome.ok) {
          testRun.passed(t);
          continue;
        }
        const messages = outcome.failures.map((f) => {
          const m = new vscode.TestMessage(f.message);
          m.location = new vscode.Location(t.uri!, new vscode.Position(Math.max(0, f.line - 1), 0));
          return m;
        });
        testRun.failed(t, messages.length > 0 ? messages : [new vscode.TestMessage(tr("失敗しました", "Failed"))]);
      }
    }
    testRun.end();
  };
  controller.createRunProfile(tr("実行", "Run"), vscode.TestRunProfileKind.Run, (request, token) => void run(request, token), true);
}

/** テストの集まりの中身。 */
function* collect(items: vscode.TestItemCollection): Generator<vscode.TestItem> {
  const all: vscode.TestItem[] = [];
  items.forEach((item) => all.push(item));
  yield* all;
}
