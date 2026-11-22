import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameCenterEntitlements, gameCenterSwift } from "./achievements.ts";
import { iosIconPng, parseColor, readIcon } from "./icon.ts";

/**
 * iOS 版の書き出し。外部のライブラリを使わず、WKWebView 一枚のアプリの Xcode プロジェクトを作る。
 * - 書き出した Web 版をアプリの中の web/ に入れ、app://game/ から読む（独自のスキームで返す。動画の範囲指定の読み込みにも応える）
 * - 全画面（ステータスバーとホームインジケータを隠し、画面の端のなぞりはまずゲームへ渡す）・作品の向きで固定・裏へ回ったら音を止める
 * - セーブはアプリの Application Support に鍵ごとのファイルで置く（WKWebView の IndexedDB は消されることがあるため。前の版の IndexedDB のものは、ページが一度だけ移す）
 * - 起動の画面は作品の起動の演出の最初の色（無ければ黒）。音の扱いは build.ios.audioSession（既定は消音スイッチに従う ambient）
 * - 描画のプロセスが落ちたら読み直し、裏へ回したときのオートセーブから続ける
 * - スクリーンショットとセーブデータのエクスポートは、ページから中身を受け取り（liminaliaFiles）、共有のシートで渡す（写真に保存、ファイルに保存など）
 * - Mac なら xcodebuild でシミュレータ用にビルドして確かめる
 * - 実機（lim build ios --device）: チームで署名してビルドし、つないだ iPhone・iPad に入れて起動する（devicectl。Xcode 15 以降）
 * - App Store へ（lim build ios --archive）: チームで署名して Archive を作り、ExportOptions.plist で .ipa に書き出す
 *   （API キーがあれば --upload で App Store Connect へ上げる）。Xcode で開いて Product → Archive してもよい
 */

export interface IosOptions {
  web: string;
  /** Xcode プロジェクトを作るフォルダ（中身は作り直す）。 */
  dir: string;
  appId: string;
  title: string;
  version: string;
  build: number;
  landscape: boolean;
  /** アイコン（PNG）。1024×1024 の透明の無い PNG にして入れる（正方形でなければ引き伸ばさずに収める）。 */
  icon: string | null;
  /** アイコンの余白と透明な所を埋める色（"#rrggbb"。build.iconBackground。省くとアイコンの縁の色、透明なら白）。 */
  iconBackground?: string;
  /** 起動の画面の地の色（"#rrggbb"。省くと黒。ゲームの起動の演出の最初の色に合わせる）。 */
  launchBackground?: string;
  /**
   * 音の扱い（AVAudioSession と navigator.audioSession）。"ambient"（既定）: 消音スイッチに従い、ほかのアプリの音と重ねて鳴らす。
   * "playback": 消音スイッチを入れていても鳴らし、ほかのアプリの音を止める。
   */
  audioSession?: "ambient" | "playback";
  /** Apple の開発チームの ID（署名に使う）。 */
  team?: string;
  /** アプリ内課金の商品（App Store の Product ID）。あれば StoreKit 2 の口を入れる。 */
  products?: string[];
  /** プライバシーマニフェスト（PrivacyInfo.xcprivacy の中身。mobile/privacy.ts）。あればアプリに入れる。 */
  privacy?: string;
  /**
   * 実績（Game Center。achievements.ts）。あれば GameKit の口と Game Center の entitlements を入れる。
   * achievements はゲームの実績の名前 → Game Center の実績の ID（書かなければ同じ名前）。
   */
  gameCenter?: { achievements: Record<string, string> };
}

/** プロジェクトを作り、Xcode のプロジェクトのパスを返す。 */
export function createIosProject(o: IosOptions): string {
  rmSync(o.dir, { recursive: true, force: true });
  const app = join(o.dir, "App");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "App.swift"), swift(o));
  writeFileSync(join(app, "Info.plist"), infoPlist(o));
  if (o.gameCenter) writeFileSync(join(app, "App.entitlements"), gameCenterEntitlements());
  if (o.privacy) writeFileSync(join(app, "PrivacyInfo.xcprivacy"), o.privacy);
  cpSync(o.web, join(app, "web"), { recursive: true });
  const hasIcon = !!o.icon;
  // 素材のカタログ（起動の画面の地の色と、アイコン）
  const assets = join(app, "Assets.xcassets");
  mkdirSync(join(assets, "LaunchBackground.colorset"), { recursive: true });
  writeFileSync(join(assets, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2));
  const [r, g, b] = parseColor(o.launchBackground) ?? [0, 0, 0];
  const component = (v: number) => (v / 255).toFixed(3);
  writeFileSync(join(assets, "LaunchBackground.colorset", "Contents.json"), JSON.stringify({ colors: [{ color: { "color-space": "srgb", components: { red: component(r), green: component(g), blue: component(b), alpha: "1.000" } }, idiom: "universal" }], info: { author: "xcode", version: 1 } }, null, 2));
  if (o.icon) {
    const set = join(assets, "AppIcon.appiconset");
    mkdirSync(set, { recursive: true });
    writeFileSync(join(set, "Contents.json"), JSON.stringify({ images: [{ filename: "icon.png", idiom: "universal", platform: "ios", size: "1024x1024" }], info: { author: "xcode", version: 1 } }, null, 2));
    const icon = join(set, "icon.png");
    // App Store のアイコンは 1024×1024 で透明を持たない（透明があると審査で止められる）。引き伸ばさずに収め、余白と透明な所は地の色で埋める
    const img = readIcon(o.icon);
    if (img) writeFileSync(icon, iosIconPng(img, o.iconBackground));
    else {
      console.warn(`  警告: アイコン ${o.icon} を開けないため、iOS 版はそのまま入れます（App Store には、透明の無い 1024×1024 の PNG が要ります）`);
      copyFileSync(o.icon, icon);
    }
  }
  const proj = join(o.dir, "App.xcodeproj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "project.pbxproj"), pbxproj(o, hasIcon));
  return proj;
}

/** シミュレータ用にビルドし、できた .app のパスを返す（Mac だけ）。 */
export function buildIosSimulator(project: string, out: string): string {
  execFileSync("xcodebuild", ["-project", project, "-target", "App", "-sdk", "iphonesimulator", "-configuration", "Debug", `SYMROOT=${out}`, "CODE_SIGNING_ALLOWED=NO", "build"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const app = join(out, "Debug-iphonesimulator", "App.app");
  if (!existsSync(app)) throw new Error(`シミュレータ用のアプリが作成されていません: ${app}`);
  return app;
}

/**
 * 署名に使う Apple の開発チームの ID。書いたもの（build.ios.team）→ 環境変数 LIMINALIA_IOS_TEAM →
 * キーチェーンの「Apple Development」の証明書のチーム（一つに決まるときだけ）。
 */
export function iosTeam(configured?: string): string {
  const given = configured ?? process.env.LIMINALIA_IOS_TEAM;
  if (given) return given;
  let pem = "";
  try {
    pem = execFileSync("security", ["find-certificate", "-a", "-c", "Apple Development", "-p"], { encoding: "utf8" });
  } catch {
    // 証明書が無い
  }
  const teams = new Set<string>();
  for (const cert of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    const subject = execFileSync("openssl", ["x509", "-noout", "-subject"], { input: cert, encoding: "utf8" });
    const ou = /OU\s*=\s*([A-Z0-9]{10})/.exec(subject)?.[1];
    if (ou) teams.add(ou);
  }
  if (teams.size === 1) return [...teams][0]!;
  throw new Error(
    teams.size === 0
      ? "署名に使う開発チームが見つかりません。Xcode の Settings → Accounts で Apple ID を追加し、証明書（Apple Development）を作成してください"
      : `開発チームが複数あります（${[...teams].join("、")}）。liminalia.json の build.ios.team に指定してください`,
  );
}

/** 実機用に署名してビルドし、できた .app のパスを返す（Mac だけ。証明書と書き出し用の設定は Xcode が作る）。 */
export function buildIosDevice(project: string, out: string, team: string): string {
  execFileSync(
    "xcodebuild",
    ["-project", project, "-target", "App", "-sdk", "iphoneos", "-configuration", "Release", `SYMROOT=${out}`, `DEVELOPMENT_TEAM=${team}`, "CODE_SIGN_STYLE=Automatic", "-allowProvisioningUpdates", "build"],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  const app = join(out, "Release-iphoneos", "App.app");
  if (!existsSync(app)) throw new Error(`実機用のアプリが作成されていません: ${app}`);
  return app;
}

/** App Store などへ出すときの書き出し方（ExportOptions.plist の method）。 */
export type IosExportMethod = "app-store" | "ad-hoc" | "development";

/** App Store Connect の API キー（.p8 のパス・キー ID・発行者 ID）。上げるときに使う。 */
export interface AppStoreConnectKey {
  path: string;
  id: string;
  issuer: string;
}

/**
 * App Store Connect の API キー。LIMINALIA_ASC_KEY（.p8 のパス）・LIMINALIA_ASC_KEY_ID・LIMINALIA_ASC_ISSUER、
 * 無ければ公証と同じ LIMINALIA_NOTARY_KEY・_KEY_ID・_ISSUER（どちらも App Store Connect の「キー」で作るもの）。三つ揃わなければ null。
 */
export function appStoreConnectKey(env: Record<string, string | undefined> = process.env): AppStoreConnectKey | null {
  const path = env.LIMINALIA_ASC_KEY ?? env.LIMINALIA_NOTARY_KEY;
  const id = env.LIMINALIA_ASC_KEY_ID ?? env.LIMINALIA_NOTARY_KEY_ID;
  const issuer = env.LIMINALIA_ASC_ISSUER ?? env.LIMINALIA_NOTARY_ISSUER;
  return path && id && issuer ? { path, id, issuer } : null;
}

/** Xcode の版（xcodebuild -version の 1 行目。読めなければ null）。 */
export function xcodeVersion(): [number, number] | null {
  try {
    const m = /Xcode (\d+)\.(\d+)/.exec(execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }));
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    // Xcode が無ければ null（呼ぶ側が入れ方を出す）
    return null;
  }
}

/**
 * ExportOptions.plist。method は Xcode 15.3 から名前が変わった（app-store → app-store-connect、ad-hoc → release-testing、
 * development → debugging）ので、Xcode の版で書き分ける。upload なら書き出さずに App Store Connect へ上げる（destination: upload）。
 */
export function exportOptionsPlist(o: { method: IosExportMethod; team: string; upload?: boolean; xcode?: [number, number] | null }): string {
  const modern = !o.xcode || o.xcode[0] > 15 || (o.xcode[0] === 15 && o.xcode[1] >= 3);
  const method = modern ? { "app-store": "app-store-connect", "ad-hoc": "release-testing", development: "debugging" }[o.method] : o.method;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${method}</string>
  <key>teamID</key>
  <string>${xml(o.team)}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>destination</key>
  <string>${o.upload ? "upload" : "export"}</string>${o.method === "app-store" ? `
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>` : ""}
</dict>
</plist>
`;
}

/** Archive を作る（xcodebuild archive。チームで署名し、署名の設定は Xcode のアカウントで作る）。.xcarchive のパスを返す。 */
export function archiveIos(project: string, archivePath: string, team: string): string {
  rmSync(archivePath, { recursive: true, force: true });
  execFileSync(
    "xcodebuild",
    ["archive", "-project", project, "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", archivePath, `DEVELOPMENT_TEAM=${team}`, "CODE_SIGN_STYLE=Automatic", "-allowProvisioningUpdates"],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  if (!existsSync(join(archivePath, "Products", "Applications", "App.app"))) throw new Error(`Archive にアプリが入っていません: ${archivePath}`);
  return archivePath;
}

/**
 * Archive から書き出す（xcodebuild -exportArchive）。upload の API キーがあれば App Store Connect へ上げる（destination: upload）。
 * 書き出したときは .ipa のパスを、上げたときは null を返す。
 */
export function exportIos(archive: string, exportDir: string, options: string, key: AppStoreConnectKey | null): string | null {
  rmSync(exportDir, { recursive: true, force: true });
  mkdirSync(exportDir, { recursive: true });
  const plist = join(exportDir, "ExportOptions.plist");
  writeFileSync(plist, options);
  execFileSync(
    "xcodebuild",
    ["-exportArchive", "-archivePath", archive, "-exportPath", exportDir, "-exportOptionsPlist", plist, "-allowProvisioningUpdates", ...(key ? ["-authenticationKeyPath", key.path, "-authenticationKeyID", key.id, "-authenticationKeyIssuerID", key.issuer] : [])],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  if (options.includes("<string>upload</string>")) return null;
  const ipa = join(exportDir, "App.ipa");
  if (!existsSync(ipa)) throw new Error(`書き出した .ipa が見つかりません: ${exportDir}`);
  return ipa;
}


export interface IosDevice {
  id: string;
  name: string;
  /** つながっていて入れられるか。 */
  available: boolean;
}

/** つないだ（ペアリングした）iPhone・iPad（devicectl）。 */
export function iosDevices(): IosDevice[] {
  const file = join(mkdtempSync(join(tmpdir(), "liminalia-devices-")), "devices.json");
  execFileSync("xcrun", ["devicectl", "list", "devices", "--json-output", file], { stdio: "ignore" });
  const json = JSON.parse(readFileSync(file, "utf8")) as {
    result?: { devices?: { identifier: string; deviceProperties?: { name?: string }; connectionProperties?: { pairingState?: string; tunnelState?: string }; hardwareProperties?: { platform?: string } }[] };
  };
  return (json.result?.devices ?? [])
    .filter((d) => d.hardwareProperties?.platform === "iOS")
    .map((d) => ({ id: d.identifier, name: d.deviceProperties?.name ?? d.identifier, available: d.connectionProperties?.pairingState === "paired" && d.connectionProperties?.tunnelState !== "unavailable" }));
}

/** 名前か ID で選ぶ（省くと、入れられるものが一台だけならそれ）。 */
export function pickIosDevice(want: string | null): IosDevice {
  const all = iosDevices();
  const list = (ds: IosDevice[]) => ds.map((d) => `${d.name}（${d.id}${d.available ? "" : "、未接続"}）`).join("、") || "なし";
  if (want) {
    const d = all.find((x) => x.id === want || x.name === want);
    if (!d) throw new Error(`${want} という端末が見つかりません。接続中の端末: ${list(all)}`);
    return d;
  }
  const ready = all.filter((d) => d.available);
  if (ready.length === 1) return ready[0]!;
  throw new Error(ready.length === 0 ? `インストールできる端末がありません（USB か同じネットワークで接続し、ペアリングしてください）。検出された端末: ${list(all)}` : `端末が複数あります。--device に名前か ID を指定してください: ${list(ready)}`);
}

/** 端末にアプリを入れる（失敗したら投げる）。 */
export function installIos(app: string, device: IosDevice): void {
  execFileSync("xcrun", ["devicectl", "device", "install", "app", "--device", device.id, app], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 入れたアプリを起動する。起動できなければ理由を返す（入れるのは済んでいるので、書き出しは失敗にしない）。
 * locked は端末にロックがかかっていて開けなかった（FBSOpenApplicationErrorDomain の 7）。
 */
export function launchIos(device: IosDevice, bundleId: string): { ok: true } | { ok: false; locked: boolean; message: string } {
  try {
    execFileSync("xcrun", ["devicectl", "device", "process", "launch", "--device", device.id, bundleId], { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const message = (err.stderr?.toString() || err.message).trim();
    return { ok: false, locked: launchLocked(message), message };
  }
}

/** 起動の失敗が、端末のロックによるものか。 */
export function launchLocked(message: string): boolean {
  return /could not, be unlocked|was not, or could not, be unlocked|FBSOpenApplicationErrorDomain error 7|device is locked/i.test(message);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function infoPlist(o: IosOptions): string {
  const orientations = o.landscape ? ["UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"] : ["UIInterfaceOrientationPortrait"];
  const list = orientations.map((x) => `\t\t<string>${x}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>ja</string>
	<key>CFBundleDisplayName</key>
	<string>${xml(o.title)}</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
		<key>UISceneConfigurations</key>
		<dict>
			<key>UIWindowSceneSessionRoleApplication</key>
			<array>
				<dict>
					<key>UISceneConfigurationName</key>
					<string>Default</string>
					<key>UISceneDelegateClassName</key>
					<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
				</dict>
			</array>
		</dict>
	</dict>
	<key>UILaunchScreen</key>
	<dict>
		<key>UIColorName</key>
		<string>LaunchBackground</string>
	</dict>
	<key>UIRequiresFullScreen</key>
	<true/>
	<key>UIStatusBarHidden</key>
	<true/>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>
	<key>UISupportedInterfaceOrientations</key>
	<array>
${list}
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
${list}
	</array>
</dict>
</plist>
`;
}

/**
 * アプリ内課金（StoreKit 2）。ゲームの画面（packages/web の store.ts）から頼まれ、持っているもの（currentEntitlements）、
 * 購入（署名を確かめた取引だけを買ったものとする）、復元（AppStore.sync）を行う。ほかの端末での購入や承認待ちの購入は Transaction.updates で受ける。
 */
function iosStoreSwift(): string {
  return `// アプリ内課金（StoreKit 2）。ゲームの画面から {"id", "method", "product"} を受け、
// window.__liminaliaStoreReply(id, 結果) で答える
final class StoreBridge: NSObject, WKScriptMessageHandler {
  weak var web: WKWebView?
  private var updates: Task<Void, Never>?

  override init() {
    super.init()
    // ほかの端末での購入や、承認待ちだった購入が済んだとき
    updates = Task.detached {
      for await result in Transaction.updates {
        if case .verified(let transaction) = result { await transaction.finish() }
      }
    }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String, let data = text.data(using: .utf8),
          let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = body["id"] as? Int, let method = body["method"] as? String else { return }
    let product = body["product"] as? String ?? ""
    Task { @MainActor in
      let result: Any
      switch method {
      case "owned":
        result = await StoreBridge.owned()
      case "buy":
        result = await StoreBridge.buy(product)
      case "restore":
        try? await AppStore.sync()
        result = await StoreBridge.owned()
      default:
        result = NSNull()
      }
      self.reply(id, result)
    }
  }

  /** 持っている商品（返金されたものは除く）。 */
  static func owned() async -> [String] {
    var out: [String] = []
    for await result in Transaction.currentEntitlements {
      if case .verified(let transaction) = result, transaction.revocationDate == nil { out.append(transaction.productID) }
    }
    return out
  }

  static func buy(_ id: String) async -> String {
    do {
      guard let product = try await Product.products(for: [id]).first else { return "failed" }
      switch try await product.purchase() {
      case .success(let verification):
        guard case .verified(let transaction) = verification else { return "failed" }
        await transaction.finish()
        return "purchased"
      case .pending:
        return "pending"
      case .userCancelled:
        return "cancelled"
      @unknown default:
        return "failed"
      }
    } catch {
      return "failed"
    }
  }

  @MainActor private func reply(_ id: Int, _ result: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: ["result": result]), let json = String(data: data, encoding: .utf8) else { return }
    web?.evaluateJavaScript("window.__liminaliaStoreReply(\\(id), (\\(json)).result)", completionHandler: nil)
  }
}

`;
}

function swift(o: IosOptions): string {
  const store = (o.products?.length ?? 0) > 0;
  const games = !!o.gameCenter;
  return `import AVFoundation
import CoreHaptics
import UIKit
import UniformTypeIdentifiers
import WebKit${store ? "\nimport StoreKit" : ""}${games ? "\nimport GameKit" : ""}

// Liminalia の書き出し（lim build ios）が作るアプリ。アプリの中の web/ の Web 版を全画面の WKWebView で遊ぶ。

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  // 音の扱い（build.ios.audioSession）。${o.audioSession === "playback" ? "playback: 消音スイッチを入れていても鳴らし、ほかのアプリの音を止める" : "ambient: 消音スイッチに従い、ほかのアプリの音と重ねて鳴らす"}
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    try? AVAudioSession.sharedInstance().setCategory(${o.audioSession === "playback" ? ".playback" : ".ambient"})
    return true
  }

  func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private let game = GameViewController()

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = game
    window.makeKeyAndVisible()
    self.window = window
  }

  // 裏へ回ったらオートセーブして音を止め、戻ったら鳴らす
  func sceneWillResignActive(_ scene: UIScene) { game.leave() }
  func sceneDidBecomeActive(_ scene: UIScene) { game.run("window.__liminalia && window.__liminalia.host.audio.context.resume()") }
}

${store ? iosStoreSwift() : ""}${games ? gameCenterSwift(o.gameCenter!.achievements) : ""}// アプリへの頼み。ゲームの画面から {"method", ...} の JSON を受ける（packages/web の native.ts）
final class AppBridge: NSObject, WKScriptMessageHandler {
  private var haptics: CHHapticEngine?
  private var player: CHHapticPatternPlayer?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String, let data = text.data(using: .utf8),
          let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let method = body["method"] as? String else { return }
    switch method {
    case "open-url":
      // 外のブラウザで開く（@open-url）
      if let s = body["url"] as? String, let url = URL(string: s) { AppBridge.openExternal(url) }
    case "keep-awake":
      // オート中と動画の再生中は画面を消さない
      UIApplication.shared.isIdleTimerDisabled = body["on"] as? Bool ?? false
    case "haptic":
      // @vibrate。振動と休みのミリ秒の並び（空なら止める）
      vibrate((body["pattern"] as? [NSNumber])?.map { $0.doubleValue } ?? [])
    default:
      break
    }
  }

  // 触覚（Core Haptics。触覚の無い端末では何もしない）。振動の長さだけ続けて鳴らす
  private func vibrate(_ pattern: [Double]) {
    try? player?.stop(atTime: CHHapticTimeImmediate)
    player = nil
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics, !pattern.isEmpty else { return }
    var events: [CHHapticEvent] = []
    var at = 0.0
    for (i, ms) in pattern.enumerated() {
      if i % 2 == 0 && ms > 0 {
        let strong = [CHHapticEventParameter(parameterID: .hapticIntensity, value: 1), CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5)]
        events.append(CHHapticEvent(eventType: .hapticContinuous, parameters: strong, relativeTime: at / 1000, duration: ms / 1000))
      }
      at += max(0, ms)
    }
    do {
      if haptics == nil {
        let engine = try CHHapticEngine()
        engine.isAutoShutdownEnabled = true
        haptics = engine
      }
      try haptics?.start()
      player = try haptics?.makePlayer(with: CHHapticPattern(events: events, parameters: []))
      try player?.start(atTime: CHHapticTimeImmediate)
    } catch {
      player = nil
    }
  }

  // 端末のブラウザ（ほかのアプリ）で開く。http・https・mailto だけ
  static func openExternal(_ url: URL) {
    guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
    UIApplication.shared.open(url)
  }
}

// セーブの置き場所（window.LiminaliaSaves。packages/web の system/storage.ts）。WKWebView の IndexedDB は端末の空きが足りないときなどに
// 消されることがあるので、アプリの Application Support の liminalia-saves/ に鍵ごとのファイルで置く（端末のバックアップにも入る）。
// 起動したときに全部を読んでページの頭のスクリプトで渡し、書いたものは届いた順にファイルにする。
// 前の版が IndexedDB に書いたものは、ページが一度だけ移す（previous: "indexeddb"）
final class SavesBridge: NSObject, WKScriptMessageHandler {
  private let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("liminalia-saves", isDirectory: true)
  private static let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")

  private func file(_ key: String) -> URL {
    dir.appendingPathComponent(key.addingPercentEncoding(withAllowedCharacters: SavesBridge.safe) ?? key)
  }

  // 今の中身（鍵 → 値）
  func load() -> [String: String] {
    var out: [String: String] = [:]
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    for name in names {
      guard let key = name.removingPercentEncoding, let data = FileManager.default.contents(atPath: dir.appendingPathComponent(name).path),
            let value = String(data: data, encoding: .utf8) else { continue }
      out[key] = value
    }
    return out
  }

  // ページの頭で動かすスクリプト（window.LiminaliaSaves を置く）。読み直すときは作り直す（そのときの中身を渡す）
  func script() -> WKUserScript {
    let json = (try? JSONSerialization.data(withJSONObject: load())).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    let source = "(function () { var saves = " + json + "; var post = function (m) { window.webkit.messageHandlers.liminaliaSaves.postMessage(JSON.stringify(m)); };" +
      " window.LiminaliaSaves = { previous: 'indexeddb', load: function () { return JSON.stringify(saves); }," +
      " set: function (k, v) { saves[k] = v; post({ method: 'set', key: k, value: v }); }," +
      " remove: function (k) { delete saves[k]; post({ method: 'remove', key: k }); } }; })();"
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String, let data = text.data(using: .utf8),
          let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let method = body["method"] as? String, let key = body["key"] as? String else { return }
    if method == "set", let value = body["value"] as? String {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try? Data(value.utf8).write(to: file(key), options: .atomic)
    } else if method == "remove" {
      try? FileManager.default.removeItem(at: file(key))
    }
  }
}

// スクリーンショットとセーブデータのエクスポート。ゲームの画面から {"name", "mime", "data"（base64）} を受け、
// 一時フォルダに置いて共有のシートを開く（packages/web の system/download.ts）
final class FilesBridge: NSObject, WKScriptMessageHandler {
  weak var controller: UIViewController?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String, let json = text.data(using: .utf8),
          let body = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
          let name = body["name"] as? String, let base64 = body["data"] as? String,
          let data = Data(base64Encoded: base64) else { return }
    let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent(safe.isEmpty ? "file" : safe)
    guard (try? data.write(to: file, options: .atomic)) != nil, let host = self.controller else { return }
    let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    // iPad は吹き出しで出すので、画面の真ん中を指す
    if let pop = sheet.popoverPresentationController {
      pop.sourceView = host.view
      pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
      pop.permittedArrowDirections = []
    }
    host.present(sheet, animated: true)
  }
}

final class GameViewController: UIViewController, WKURLSchemeHandler, WKNavigationDelegate, WKUIDelegate {
  private var web: WKWebView!
  private let root = Bundle.main.resourceURL!.appendingPathComponent("web").standardizedFileURL
  private let files = FilesBridge()
  private let app = AppBridge()
  private let saves = SavesBridge()
  // 描画のプロセスが落ちた時刻（続けて落ちるなら読み直すのをやめる）
  private var crashes: [Date] = []${store ? "\n  private let store = StoreBridge()" : ""}${games ? "\n  private let achievements = AchievementsBridge()" : ""}

  override func loadView() {
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(self, forURLScheme: "app")
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    // ファイルを渡す口（window.webkit.messageHandlers.liminaliaFiles）
    files.controller = self
    config.userContentController.add(files, name: "liminaliaFiles")
    // アプリへの頼み（window.webkit.messageHandlers.liminaliaApp）
    config.userContentController.add(app, name: "liminaliaApp")
    // セーブの置き場所（window.LiminaliaSaves と window.webkit.messageHandlers.liminaliaSaves）
    config.userContentController.add(saves, name: "liminaliaSaves")
    installScripts(config.userContentController)${
      store
        ? `
    // アプリ内課金（StoreKit 2）の口をゲームの画面に置く（window.webkit.messageHandlers.liminaliaStore）
    config.userContentController.add(store, name: "liminaliaStore")`
        : ""
    }${
      games
        ? `
    // 実績（Game Center）の口をゲームの画面に置く（window.webkit.messageHandlers.liminaliaAchievements）
    achievements.controller = self
    config.userContentController.add(achievements, name: "liminaliaAchievements")`
        : ""
    }
    web = WKWebView(frame: .zero, configuration: config)${store ? "\n    store.web = web" : ""}
    web.isOpaque = false
    web.backgroundColor = .black
    web.scrollView.backgroundColor = .black
    web.scrollView.isScrollEnabled = false
    web.scrollView.bounces = false
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.navigationDelegate = self
    web.uiDelegate = self
    #if DEBUG
    if #available(iOS 16.4, *) { web.isInspectable = true }
    #endif
    view = web
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    web.load(URLRequest(url: URL(string: "app://game/index.html")!))
  }

  override var prefersStatusBarHidden: Bool { true }
  override var prefersHomeIndicatorAutoHidden: Bool { true }
  // 画面の上端・下端のなぞりは、まずゲームへ渡す（下端のボタンを押してもホームへ戻らない。二度なぞればホームへ戻る）
  override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { [.top, .bottom] }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)${games ? "\n    // Game Center にサインインする（済んだら控えておいた実績を送る）\n    achievements.authenticate()" : ""}
    setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
    setNeedsUpdateOfHomeIndicatorAutoHidden()
  }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { ${o.landscape ? ".landscape" : ".portrait"} }

  func run(_ script: String) {
    web?.evaluateJavaScript(script, completionHandler: nil)
  }

  // ページの頭で動かすスクリプト（セーブの中身と、音の扱い）。読み直すたびに今の中身で置き直す
  private func installScripts(_ controller: WKUserContentController) {
    controller.removeAllUserScripts()
    controller.addUserScript(saves.script())
    // WebKit が音を鳴らすときの扱いも、アプリと同じにする（Audio Session API。iOS 16.4 から）
    controller.addUserScript(WKUserScript(source: "try { if (navigator.audioSession) navigator.audioSession.type = '${o.audioSession === "playback" ? "playback" : "ambient"}'; } catch (e) {}", injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  // ゲームの外へ移ろうとしたら（作品の HTML の <a>）、ゲームの中では開かず端末のブラウザに渡す
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, action.targetFrame?.isMainFrame == true, !["app", "about", "blob", "data"].contains(url.scheme?.lowercased() ?? "") else {
      decisionHandler(.allow)
      return
    }
    AppBridge.openExternal(url)
    decisionHandler(.cancel)
  }

  // 描画のプロセスが落ちた（裏にいる間にメモリを空けるため止められたなど）。黒い画面のまま残さず読み直し、
  // 裏へ回したときのオートセーブから続ける（?resume=1。packages/web の resumeLeft）。1 分のうちに 3 回落ちたら読み直さない
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    crashes = crashes.filter { $0.timeIntervalSinceNow > -60 } + [Date()]
    guard crashes.count < 3 else { return }
    installScripts(webView.configuration.userContentController)
    webView.load(URLRequest(url: URL(string: "app://game/index.html?resume=1")!))
  }

  // window.open（新しいウィンドウ）も端末のブラウザで開く
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { AppBridge.openExternal(url) }
    return nil
  }

  // オートセーブして、セーブが保存先（アプリのファイル）に入るまで裏で少し動かしてもらう（Android 版が書き終えるまで待つのと同じ）。最大 2 秒
  func leave() {
    guard let web = web else { return }
    let app = UIApplication.shared
    var task = UIBackgroundTaskIdentifier.invalid
    let finish = {
      if task != .invalid {
        app.endBackgroundTask(task)
        task = .invalid
      }
    }
    task = app.beginBackgroundTask(withName: "liminalia-save", expirationHandler: finish)
    let script = "const g = window.__liminalia; if (g && g.leave) await Promise.race([g.leave(), new Promise((r) => setTimeout(r, 2000))]); if (g) g.host.audio.context.suspend();"
    web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { _ in finish() }
  }

  // ---- app://game/ からアプリの中の web/ を返す ----

  private static let types: [String: String] = ["js": "text/javascript", "mjs": "text/javascript", "lim": "text/plain; charset=utf-8", "json": "application/json", "webmanifest": "application/manifest+json", "html": "text/html; charset=utf-8", "css": "text/css", "vtt": "text/vtt"]

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    var path = url.path
    if path.isEmpty || path == "/" { path = "/index.html" }
    let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
      task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
      task.didFinish()
      return
    }
    let ext = file.pathExtension.lowercased()
    let type = Self.types[ext] ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    var headers = ["Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache"]
    // 動画・音は範囲を指定して読まれる
    if let range = task.request.value(forHTTPHeaderField: "Range"), let (start, end) = Self.parseRange(range, count: data.count) {
      let part = data.subdata(in: start..<(end + 1))
      headers["Content-Range"] = "bytes \\(start)-\\(end)/\\(data.count)"
      headers["Content-Length"] = String(part.count)
      task.didReceive(HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: headers)!)
      task.didReceive(part)
    } else {
      headers["Content-Length"] = String(data.count)
      task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
      task.didReceive(data)
    }
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  private static func parseRange(_ header: String, count: Int) -> (Int, Int)? {
    guard header.hasPrefix("bytes="), count > 0 else { return nil }
    let parts = header.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    if parts[0].isEmpty, let suffix = Int(parts[1]) { return (max(0, count - suffix), count - 1) }
    guard let start = Int(parts[0]), start < count else { return nil }
    let end = Int(parts[1]).map { min($0, count - 1) } ?? count - 1
    return start <= end ? (start, end) : nil
  }
}
`;
}

/** Xcode のプロジェクト（ターゲット一つ）。番号は固定（作り直しても同じ中身になる）。 */
function pbxproj(o: IosOptions, hasIcon: boolean): string {
  const id = (n: number) => `4C1A0000000000000000${n.toString(16).toUpperCase().padStart(4, "0")}`;
  const I = {
    project: id(1),
    mainGroup: id(2),
    productsGroup: id(3),
    appGroup: id(4),
    swiftRef: id(5),
    plistRef: id(6),
    webRef: id(7),
    assetsRef: id(8),
    productRef: id(9),
    target: id(10),
    sources: id(11),
    resources: id(12),
    frameworks: id(13),
    swiftBuild: id(14),
    webBuild: id(15),
    assetsBuild: id(16),
    projectConfigs: id(17),
    targetConfigs: id(18),
    projectDebug: id(19),
    projectRelease: id(20),
    targetDebug: id(21),
    targetRelease: id(22),
    privacyRef: id(23),
    privacyBuild: id(24),
  };
  // プライバシーマニフェスト（あれば Resources に入れる）
  const privacy = !!o.privacy;
  const targetSettings = (debug: boolean) => `{
				${hasIcon ? "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n				" : ""}CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = ${o.build};
				${o.gameCenter ? "CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n				" : ""}${o.team ? `DEVELOPMENT_TEAM = ${o.team};\n				` : ""}ENABLE_PREVIEWS = NO;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = App/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 15.4;
				LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks");
				MARKETING_VERSION = ${q(o.version)};
				PRODUCT_BUNDLE_IDENTIFIER = ${q(o.appId)};
				PRODUCT_NAME = App;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";${debug ? "\n				SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;" : ""}
			}`;
  const projectSettings = (debug: boolean) => `{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				GCC_C_LANGUAGE_STANDARD = gnu11;
				IPHONEOS_DEPLOYMENT_TARGET = 15.4;
				SDKROOT = iphoneos;
				${debug ? "DEBUG_INFORMATION_FORMAT = dwarf;\n				ONLY_ACTIVE_ARCH = YES;\n				SWIFT_OPTIMIZATION_LEVEL = \"-Onone\";\n				ENABLE_TESTABILITY = YES;" : "DEBUG_INFORMATION_FORMAT = \"dwarf-with-dsym\";\n				SWIFT_COMPILATION_MODE = wholemodule;\n				VALIDATE_PRODUCT = YES;"}
			}`;
  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
		${I.swiftBuild} /* App.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${I.swiftRef} /* App.swift */; };
		${I.webBuild} /* web in Resources */ = {isa = PBXBuildFile; fileRef = ${I.webRef} /* web */; };
		${I.assetsBuild} /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = ${I.assetsRef} /* Assets.xcassets */; };${privacy ? `\n		${I.privacyBuild} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${I.privacyRef} /* PrivacyInfo.xcprivacy */; };` : ""}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		${I.swiftRef} /* App.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = App.swift; sourceTree = "<group>"; };
		${I.plistRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
		${I.webRef} /* web */ = {isa = PBXFileReference; lastKnownFileType = folder; path = web; sourceTree = "<group>"; };
		${I.assetsRef} /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };
		${I.productRef} /* App.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = App.app; sourceTree = BUILT_PRODUCTS_DIR; };${privacy ? `\n		${I.privacyRef} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };` : ""}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		${I.frameworks} /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		${I.mainGroup} = {
			isa = PBXGroup;
			children = (
				${I.appGroup} /* App */,
				${I.productsGroup} /* Products */,
			);
			sourceTree = "<group>";
		};
		${I.productsGroup} /* Products */ = {
			isa = PBXGroup;
			children = (
				${I.productRef} /* App.app */,
			);
			name = Products;
			sourceTree = "<group>";
		};
		${I.appGroup} /* App */ = {
			isa = PBXGroup;
			children = (
				${I.swiftRef} /* App.swift */,
				${I.plistRef} /* Info.plist */,
				${I.webRef} /* web */,
				${I.assetsRef} /* Assets.xcassets */,${privacy ? `\n				${I.privacyRef} /* PrivacyInfo.xcprivacy */,` : ""}
			);
			path = App;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		${I.target} /* App */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${I.targetConfigs};
			buildPhases = (
				${I.sources} /* Sources */,
				${I.frameworks} /* Frameworks */,
				${I.resources} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = App;
			productName = App;
			productReference = ${I.productRef} /* App.app */;
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		${I.project} /* Project object */ = {
			isa = PBXProject;
			attributes = {
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1500;
				LastUpgradeCheck = 1500;
			};
			buildConfigurationList = ${I.projectConfigs};
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = ja;
			hasScannedForEncodings = 0;
			knownRegions = (
				ja,
				en,
				Base,
			);
			mainGroup = ${I.mainGroup};
			productRefGroup = ${I.productsGroup} /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				${I.target} /* App */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		${I.resources} /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				${I.webBuild} /* web in Resources */,
				${I.assetsBuild} /* Assets.xcassets in Resources */,${privacy ? `\n				${I.privacyBuild} /* PrivacyInfo.xcprivacy in Resources */,` : ""}
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		${I.sources} /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				${I.swiftBuild} /* App.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		${I.projectDebug} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = ${projectSettings(true)};
			name = Debug;
		};
		${I.projectRelease} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = ${projectSettings(false)};
			name = Release;
		};
		${I.targetDebug} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = ${targetSettings(true)};
			name = Debug;
		};
		${I.targetRelease} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = ${targetSettings(false)};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		${I.projectConfigs} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${I.projectDebug} /* Debug */,
				${I.projectRelease} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		${I.targetConfigs} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${I.targetDebug} /* Debug */,
				${I.targetRelease} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
	rootObject = ${I.project} /* Project object */;
}
`;
}
