/**
 * スマホ版の実績。ゲームの画面（packages/web の achievements.ts）は、@achieve と @achieve-progress のたびに
 * iOS では window.webkit.messageHandlers.liminaliaAchievements、Android では window.LiminaliaAchievements.call に
 * {"method": "unlock" | "progress", "id", "value", "goal"} の JSON を送る（答えは返さない）。
 * アプリ（Swift、Java）はゲームの実績の名前を店の実績の ID に読み替えて送る。
 *
 * - iOS（Game Center。build.gameCenter）: 解除は percentComplete 100、数を数える実績は value / goal の割合。
 *   ID は achievements の対応（書かなければゲームの実績の名前のまま）。起動したときにサインインし、済むまでは控えておいて送る
 * - Android（Google Play Games Services v2。build.playGames）: 解除は unlock、数を数える実績は setSteps(value)（Play Console で
 *   段階的な実績にし、段階の数を goal と同じにする）。ID は achievements の対応（Play Console の ID。書いていない実績は送らない）。
 *   起動したときの自動のサインインを待ち、済むまでは控えておいて送る
 */

/** Game Center の設定（liminalia.json の build.gameCenter）。 */
export interface GameCenterConfig {
  /** ゲームの実績の名前 → Game Center の実績の ID（App Store Connect で作る。書かなければ同じ名前）。 */
  achievements?: Record<string, string>;
}

/** Google Play Games の設定（liminalia.json の build.playGames）。 */
export interface PlayGamesConfig {
  /** Play Console の「Play Games サービス」のプロジェクトの ID（数字の並び）。 */
  appId: string;
  /** ゲームの実績の名前 → Play Console の実績の ID（CgkI… の形）。 */
  achievements: Record<string, string>;
  /** play-services-games-v2 の AAR と、その依存の AAR・JAR（プロジェクトからのパス）。 */
  libraries: string[];
}

/** 文字列を Swift と Java の文字列の字面にする（JSON の書き方。両方で読めない制御文字と行区切りは外す）。 */
const quote = (s: string) => JSON.stringify(s.replace(/[\u0000-\u001f\u2028\u2029]/g, ""));

/** Game Center の口（Swift）。ids はゲームの実績の名前 → Game Center の ID（無い名前はそのまま送る）。 */
export function gameCenterSwift(ids: Record<string, string>): string {
  const table = Object.entries(ids).map(([k, v]) => `${quote(k)}: ${quote(v)}`);
  return `// 実績（Game Center）。ゲームの画面から {"method", "id", "value", "goal"} を受け、Game Center の実績へ送る。
// サインインが済むまでは控えておき、済んだら送る
final class AchievementsBridge: NSObject, WKScriptMessageHandler {
  weak var controller: UIViewController?
  /** ゲームの実績の名前 → Game Center の実績の ID（無い名前はそのまま）。 */
  private let ids: [String: String] = [${table.length > 0 ? table.join(", ") : ":"}]
  /** 送る前の実績（ID → 割合）。 */
  private var pending: [String: Double] = [:]
  private var ready = false

  /** サインインする（未サインインなら Game Center の画面を出す）。 */
  func authenticate() {
    GKLocalPlayer.local.authenticateHandler = { [weak self] view, _ in
      guard let self = self else { return }
      if let view = view {
        self.controller?.present(view, animated: true)
        return
      }
      self.ready = GKLocalPlayer.local.isAuthenticated
      self.flush()
    }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String, let data = text.data(using: .utf8),
          let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let method = body["method"] as? String, let id = body["id"] as? String, !id.isEmpty else { return }
    let key = ids[id] ?? id
    var percent: Double
    switch method {
    case "unlock":
      percent = 100
    case "progress":
      let value = (body["value"] as? NSNumber)?.doubleValue ?? 0
      let goal = (body["goal"] as? NSNumber)?.doubleValue ?? 0
      guard goal > 0 else { return }
      percent = min(100, max(0, value / goal * 100))
    default:
      return
    }
    // 割合は下げない（同じ実績を続けて送ったときは大きい方）
    pending[key] = max(pending[key] ?? 0, percent)
    flush()
  }

  private func flush() {
    guard ready, !pending.isEmpty else { return }
    let list = pending.map { (key, percent) -> GKAchievement in
      let a = GKAchievement(identifier: key)
      a.percentComplete = percent
      a.showsCompletionBanner = true
      return a
    }
    pending = [:]
    GKAchievement.report(list) { error in
      if let error = error { NSLog("Game Center の実績を送れませんでした: \\(error.localizedDescription)") }
    }
  }
}

`;
}

/** Game Center を使う entitlements（Xcode の Signing & Capabilities の Game Center と同じ）。 */
export function gameCenterEntitlements(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.game-center</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * Google Play Games Services v2 の口（Java。ラムダを使わない）。ids はゲームの実績の名前 → Play Console の実績の ID
 * （無い名前は送らない）。
 */
export function playGamesBridgeJava(pkg: string, ids: Record<string, string>): string {
  const puts = Object.entries(ids)
    .map(([k, v]) => `    IDS.put(${quote(k)}, ${quote(v)});`)
    .join("\n");
  return `package ${pkg};

import android.app.Activity;
import android.util.Log;
import android.webkit.JavascriptInterface;
import com.google.android.gms.games.AuthenticationResult;
import com.google.android.gms.games.PlayGames;
import com.google.android.gms.games.PlayGamesSdk;
import com.google.android.gms.tasks.OnCompleteListener;
import com.google.android.gms.tasks.Task;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/**
 * 実績（Google Play Games Services v2）。Liminalia の書き出し（lim build android）が作る。ゲームの画面の LiminaliaAchievements.call から
 * {"method", "id", "value", "goal"} を受け、解除は unlock、数を数える実績は setSteps で送る。サインインが済むまでは控えておく。
 */
public final class AchievementsBridge {
  /** ゲームの実績の名前 → Play Console の実績の ID。 */
  private static final Map<String, String> IDS = new HashMap<>();
  static {
${puts}
  }

  private final Activity activity;
  /** 送る前の実績（[ID, 段階の数]。段階の数が -1 なら解除）。 */
  private final List<Object[]> pending = new ArrayList<>();
  private boolean ready = false;

  AchievementsBridge(Activity activity) {
    this.activity = activity;
    PlayGamesSdk.initialize(activity);
    // 起動したときの自動のサインイン（済んでいなければ、サインインの画面は出さずに控えたままにする）
    PlayGames.getGamesSignInClient(activity).isAuthenticated().addOnCompleteListener(new OnCompleteListener<AuthenticationResult>() {
      @Override
      public void onComplete(Task<AuthenticationResult> task) {
        ready = task.isSuccessful() && task.getResult().isAuthenticated();
        flush();
      }
    });
  }

  @JavascriptInterface
  public void call(String json) {
    final String method;
    final String key;
    final int value;
    try {
      JSONObject body = new JSONObject(json);
      method = body.optString("method");
      key = IDS.get(body.optString("id"));
      value = body.optInt("value", 0);
    } catch (Exception e) {
      return;
    }
    if (key == null) return;
    activity.runOnUiThread(new Runnable() {
      @Override
      public void run() {
        if ("unlock".equals(method)) pending.add(new Object[] { key, -1 });
        else if ("progress".equals(method) && value > 0) pending.add(new Object[] { key, value });
        flush();
      }
    });
  }

  private void flush() {
    if (!ready || pending.isEmpty()) return;
    for (Object[] p : pending) {
      try {
        String key = (String) p[0];
        int steps = (Integer) p[1];
        if (steps < 0) PlayGames.getAchievementsClient(activity).unlock(key);
        else PlayGames.getAchievementsClient(activity).setSteps(key, steps);
      } catch (Exception e) {
        Log.w("Liminalia", "Google Play Games の実績を送れませんでした: " + e);
      }
    }
    pending.clear();
  }
}
`;
}

/** Play Games のプロジェクトの ID を置く資源（AndroidManifest.xml の meta-data が @string で読む。数字を直に書くと数として読まれるため）。 */
export function playGamesValuesXml(appId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="game_services_project_id" translatable="false">${appId.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>
</resources>
`;
}

/** 設定の形の誤り（書き出しの前に知らせる）。 */
export function playGamesProblems(c: PlayGamesConfig | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (typeof c.appId !== "string" || !/^\d+$/.test(c.appId)) out.push("build.playGames.appId は Play Console の Play Games サービスのプロジェクトの ID（数字の文字列）で書きます");
  if (!c.achievements || typeof c.achievements !== "object") out.push("build.playGames.achievements にゲームの実績の名前 → Play Console の実績の ID を書きます");
  if (!Array.isArray(c.libraries) || c.libraries.length === 0) out.push("build.playGames.libraries に play-services-games-v2 の AAR と、その依存の AAR・JAR を書きます");
  return out;
}
