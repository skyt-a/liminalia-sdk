/**
 * ストアへの申告に使う、書き出したゲームが集める情報（docs/distribution.md の「ストアへの申告」）。
 * エンジンが送るのは作者が送り先を書いたものだけ（止まったときの記録 build.crashReport、遊ばれ方の統計 build.analytics、テスト版の指摘 build.feedback）。
 * どれも遊ぶ人に尋ねるか遊ぶ人が書いて送るもので、端末や人を見分ける番号を付けず、追跡（トラッキング）に使わない。
 * iOS 版にはこれから PrivacyInfo.xcprivacy を作って入れる（build.ios.privacyManifest で自分のものに替えられる）。
 */

/** 書き出したゲームが送るもの（作品の設定から決まる）。 */
export interface CollectedData {
  /** 止まったときの記録（build.crashReport.url）。 */
  crashReport: boolean;
  /** 遊ばれ方の統計（build.analytics.url）。 */
  analytics: boolean;
  /** テスト版の指摘（テスト版の書き出しで、build.feedback.url があるとき）。 */
  feedback: boolean;
}

/** Apple の収集データの種類と目的（NSPrivacyCollectedDataType…）。 */
const APPLE_TYPES: Record<keyof CollectedData, { type: string; purpose: string }> = {
  crashReport: { type: "NSPrivacyCollectedDataTypeCrashData", purpose: "NSPrivacyCollectedDataTypePurposeAppFunctionality" },
  analytics: { type: "NSPrivacyCollectedDataTypeProductInteraction", purpose: "NSPrivacyCollectedDataTypePurposeAnalytics" },
  feedback: { type: "NSPrivacyCollectedDataTypeOtherUserContent", purpose: "NSPrivacyCollectedDataTypePurposeAppFunctionality" },
};

/**
 * iOS のプライバシーマニフェスト（PrivacyInfo.xcprivacy）。追跡はせず、追跡の送り先も無い。集める情報は送り先を書いたものだけで、
 * 遊ぶ人に結び付けない（Linked: false）。理由の申告が要る API（UserDefaults、ファイルの日時など）は、書き出す iOS 版のアプリの部分（mobile/ios.ts）が使わない。
 */
export function privacyManifest(d: CollectedData): string {
  const kinds = (Object.keys(APPLE_TYPES) as (keyof CollectedData)[]).filter((k) => d[k]);
  const collected = kinds
    .map((k) =>
      [
        "\t\t<dict>",
        "\t\t\t<key>NSPrivacyCollectedDataType</key>",
        `\t\t\t<string>${APPLE_TYPES[k].type}</string>`,
        "\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>",
        "\t\t\t<false/>",
        "\t\t\t<key>NSPrivacyCollectedDataTypeTracking</key>",
        "\t\t\t<false/>",
        "\t\t\t<key>NSPrivacyCollectedDataTypePurposes</key>",
        "\t\t\t<array>",
        `\t\t\t\t<string>${APPLE_TYPES[k].purpose}</string>`,
        "\t\t\t</array>",
        "\t\t</dict>",
      ].join("\n"),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
	<key>NSPrivacyTrackingDomains</key>
	<array/>
	<key>NSPrivacyCollectedDataTypes</key>
	${collected ? `<array>\n${collected}\n\t</array>` : "<array/>"}
	<key>NSPrivacyAccessedAPITypes</key>
	<array/>
</dict>
</plist>
`;
}

/** 書き出しの経過に出す一行（ストアに申告するもの。設定の名前で並べる）。 */
export function collectedSummary(d: CollectedData): string {
  const keys = [d.crashReport ? "build.crashReport" : "", d.analytics ? "build.analytics" : "", d.feedback ? "build.feedback" : ""].filter(Boolean);
  return keys.length === 0 ? "ストアへの申告: 集める情報なし" : `ストアへの申告: 集める情報 ${keys.join("、")}`;
}
