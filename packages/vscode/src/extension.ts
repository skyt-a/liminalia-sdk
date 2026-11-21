import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { findRunningStudio, type RunningStudio } from "@liminalia/editor/running";
import * as vscode from "vscode";
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type { PlayFromResult } from "./play-from.ts";
import { playUrl, type PlayAt } from "./play-launch.ts";
import { appLaunch, limLaunch, type LaunchContext } from "./studio-launch.ts";
import { registerScenarioTests } from "./extension-tests.ts";

/**
 * 拡張機能の入口。言語サーバー（dist/server.mjs）を別のプロセスで動かし、.lim のファイルをつなぐ。
 * 言語（liminalia）・色分け・括弧の設定は package.json の contributes にある。
 * 台本のテスト（tests/*.limtest）は Testing の口に並べ、lim test で流す（extension-tests.ts）。
 * 「ここからテストプレイ」は、カーソルの行を実行する直前の状態から始めるセーブを言語サーバーで組み立て（play-from.ts）、作品を開いている制作画面
 * （制作アプリか lim studio。作品の .liminalia/studio-server.json）に預けて、そのプレイヤーをブラウザで開く（play-launch.ts）。
 */

let client: LanguageClient | undefined;

const ja = vscode.env.language.startsWith("ja");
const tr = (j: string, e: string) => (ja ? j : e);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 台本のテストは言語サーバーを待たずに並べる
  registerScenarioTests(context, tr);
  const module = context.asAbsolutePath("dist/server.mjs");
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6029"] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "liminalia" }],
    synchronize: {
      // シナリオ・設定・キャスト・プラグイン・素材の変化を知らせる
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*"),
      configurationSection: "liminalia",
    },
    initializationOptions: { trusted: vscode.workspace.isTrusted },
    outputChannelName: "Liminalia",
  };
  client = new LanguageClient("liminalia", "Liminalia", serverOptions, clientOptions);
  await client.start();
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => void client?.sendNotification("liminalia/trusted")),
    vscode.commands.registerCommand("liminalia.restartServer", async () => {
      await client?.restart();
    }),
    vscode.commands.registerCommand("liminalia.playFromHere", () => playFromHere()),
  );
}

async function playFromHere(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "liminalia" || !client) return;
  const lsp = client;
  await editor.document.save();
  const uri = editor.document.uri.toString();
  const line = editor.selection.active.line;
  const at = (await lsp.sendRequest("liminalia/playTarget", { uri, line })) as PlayAt | null;
  if (!at) {
    void vscode.window.showWarningMessage(tr("liminalia.json のあるプロジェクトのシナリオで使います", "Use this in a script inside a project with liminalia.json"));
    return;
  }
  let studio = await findRunningStudio(at.root);
  let starting: Promise<RunningStudio | null> | null = null;
  if (!studio) {
    if (!(await startStudio(at.root))) return;
    starting = (async () => {
      for (let i = 0; i < 120; i++) {
        const found = await findRunningStudio(at.root);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    })();
  }
  // その行を実行する直前の状態（前のシーンやほかのファイルで決めた背景・立ち絵・BGM・変数）を組み立てる。
  // 制作画面が開いていればその現在地を使い、無ければ（起動を待つ間に）言語サーバーの中で作る
  const built = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr("その行の直前の状態を組み立てています", "Building the state just before this line") }, async () => {
    try {
      return (await lsp.sendRequest("liminalia/playFrom", { uri, line, ...(studio ? { studio: studio.url } : {}) })) as PlayFromResult | null;
    } catch (e) {
      lsp.outputChannel.appendLine(`ここからテストプレイ: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
  if (starting) studio = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tr("Studio の起動を待っています", "Waiting for Studio to start") }, () => starting);
  if (!studio) return;
  const { url, handedOver } = await playUrl(studio, at, built);
  if (built?.noRoute !== undefined && handedOver) {
    void vscode.window.showInformationMessage(tr(`${built.noRoute} 行目へ到達するルートが見つからないため、手前の行の状態からテストプレイします`, `No route reaches line ${built.noRoute}, so playing with the state of the line before it`));
  } else if (!handedOver) {
    const scene = at.start.includes("#") ? `#${at.start.split("#")[1]}` : `${at.file}.lim`;
    void vscode.window.showInformationMessage(tr(`この行の直前の状態を作れないため、${scene} から変数を初期値にしてテストプレイします`, `Couldn't build the state just before this line, so playing from ${scene} with initial variable values`));
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * 作品を開いている制作画面が無いとき、制作アプリで開くか lim studio を立ち上げる（studio-launch.ts。npm から取りに行かない）。
 * どちらも見つからなければ、設定の liminalia.lim に lim の場所を書くよう知らせる。立ち上げたら true。
 */
async function startStudio(root: string): Promise<boolean> {
  const settings = vscode.workspace.getConfiguration("liminalia");
  const context: LaunchContext = {
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
  const app = appLaunch(context);
  const lim = limLaunch(context);
  const openApp = tr("Liminalia Studio で開く", "Open in the Studio app");
  const startLim = tr("lim studio を起動", "Start lim studio");
  const settingsButton = tr("設定を開く", "Open Settings");
  if (!app && !lim) {
    const picked = await vscode.window.showWarningMessage(
      tr(
        "このプロジェクトを開いている Studio がありません。Liminalia Studio が見つからず、lim の場所も設定されていません。設定の liminalia.lim に lim の場所（lim.mjs か lim）を設定するか、Liminalia Studio でプロジェクトを開いてください。",
        "No Studio has this project open. The Studio app wasn't found and the location of lim isn't set. Set the location of lim (lim.mjs or lim) in the liminalia.lim setting, or open the project in the Studio app.",
      ),
      settingsButton,
    );
    if (picked === settingsButton) await vscode.commands.executeCommand("workbench.action.openSettings", "liminalia.lim");
    return false;
  }
  const picked = await vscode.window.showInformationMessage(
    tr("このプロジェクトを開いている Studio がありません。Liminalia Studio で開くか、lim studio を起動してください。", "No Studio has this project open. Open it in the Studio app or start lim studio to play."),
    ...(app ? [openApp] : []),
    ...(lim ? [startLim] : []),
  );
  if (picked === openApp && app) {
    spawn(app.command, app.args, { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (picked === startLim && lim) {
    // シェルを通さずに動かす（パスの空白や記号をシェルの決まりで囲まなくてよい）
    const terminal = vscode.window.createTerminal({ name: "lim studio", cwd: root, shellPath: lim.command, shellArgs: lim.args, ...(lim.env ? { env: lim.env } : {}) });
    terminal.show(true);
    return true;
  }
  return false;
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
