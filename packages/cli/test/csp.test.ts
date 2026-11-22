import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cspDirectives, injectCsp, inlineScripts, originOf } from "../src/csp.ts";
import { injectServiceWorkerLoader } from "../src/encrypt.ts";

const HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>t</title>
    <script type="module" crossorigin src="./engine/index-abc.js"></script>
  </head>
  <body>
    <div id="viewport"></div>
  </body>
</html>`;

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

describe("書き出したゲームの CSP", () => {
  it("<meta charset> のすぐ後に入れ、index.html の中のスクリプトだけを中身のハッシュで許す", () => {
    const html = injectServiceWorkerLoader(HTML);
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(1);
    const out = injectCsp(html, undefined);
    const meta = /<meta charset="utf-8" \/>\n {4}<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(out);
    expect(meta).not.toBeNull();
    const policy = meta![1]!;
    expect(policy).toContain(`script-src 'self' ${sha(scripts[0]!)};`);
    expect(policy).toContain("default-src 'self';");
    expect(policy).toContain("img-src 'self' data: blob:;");
    expect(policy).toContain("object-src 'self';");
    expect(policy).not.toContain("unsafe-eval");
    // 二度入れても一つ
    expect(injectCsp(out, undefined).match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it("build.csp で指示ごとに足し、false でその指示を外し、全体を false なら入れない", () => {
    const d = cspDirectives({ "connect-src": ["https://api.example.com"], "frame-src": false, "script-src": ["'wasm-unsafe-eval'"] }, { connect: ["https://crash.example.com"] })!;
    expect(d["connect-src"]).toEqual(["'self'", "data:", "blob:", "https://crash.example.com", "https://api.example.com"]);
    expect(d["frame-src"]).toBeUndefined();
    expect(d["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(cspDirectives(false)).toBeNull();
    expect(injectCsp(HTML, false)).toBe(HTML);
    expect(originOf("https://crash.example.com/api/report?x=1")).toBe("https://crash.example.com");
    expect(originOf("not a url")).toBeNull();
  });
});
