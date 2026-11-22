import { describe, expect, it } from "vitest";
import { launchLocked } from "../src/mobile/ios.ts";

describe("iOS の実機への書き出し", () => {
  it("端末のロックで起動できなかったことを見分ける（入れるのは済んでいるので失敗にしない）", () => {
    expect(launchLocked("Unable to launch local.liminalia.gung0007hd because the device was not, or could not, be unlocked (FBSOpenApplicationErrorDomain error 7)")).toBe(true);
    expect(launchLocked("ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002)")).toBe(false);
  });
});
