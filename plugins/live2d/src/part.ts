import type { CastVariant } from "@liminalia/sdk";
import { loadScript, type SpritePart, type SpritePartContext, type SpritePartVariant } from "@liminalia/sdk/web";
import { globalCore, type CoreModel, type CoreMoc, type CubismCore } from "./core.ts";
import type { Exp3Json, Model3Json, Motion3Json, Physics3Json, Pose3Json } from "./files.ts";
import { fitRect, pickIdle, pickState, readOptions, resolvePath, type Live2dOptions } from "./model.ts";
import { Puppet } from "./puppet.ts";
import { drawModel, mapping, sharedGl, uploadTexture, type Shared } from "./renderer.ts";

/**
 * Live2D の立ち絵（cast.json の model.type が "live2d"）。立ち絵の要素の中にキャンバスを置き、毎フレーム動かして描く。
 * 立ち絵の位置と大きさ、出し入れ、話者の強調と色調（要素の CSS の filter）、反転はエンジンの立ち絵のまま効く。
 * モデルを読み終えて最初の一枚を描くまでは、差分の image（静止画）を見せ、撮影（lim shot）を待たせる。
 * Core が無い、モデルが読めないときは、静止画のまま知らせる（開発者ツール）。
 */

/** 動いた分が枠からはみ出しても切れないよう、枠より上下左右にこの割合だけ大きく描く。 */
const PAD = 0.15;
/** 描く解像度の上限（一辺の画素）。 */
const MAX_SIZE = 2048;

/** 同じモデル（.model3.json）の読み込みを、出している立ち絵どうしで分ける。 */
interface Loaded {
  core: CubismCore;
  moc: CoreMoc;
  model3: Model3Json;
  images: HTMLImageElement[];
  textures: (WebGLTexture | null)[];
  expressions: Map<string, Exp3Json>;
  physics: Physics3Json | undefined;
  pose: Pose3Json | undefined;
  motions: Map<string, Promise<Motion3Json | null>>;
  users: number;
  restore: () => void;
}

const loaded = new Map<string, Promise<Loaded>>();

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} を読み込めません（${r.status}）`);
  return r;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${url} を読み込めません`));
    img.src = url;
  });
}

/** Core を読み込む（作者が素材の others に置いたもの）。 */
async function loadCore(url: string): Promise<CubismCore> {
  const ready = globalCore();
  if (ready) return ready;
  try {
    await loadScript(url);
  } catch {
    throw new Error(`Live2D の Cubism Core（${url}）がありません。Cubism SDK for Web の Core/live2dcubismcore.min.js を assets/others/live2d/ に置いてください（docs/live2d-spine.md）`);
  }
  const core = globalCore();
  if (!core) throw new Error(`${url} を読み込みましたが、Live2D の Cubism Core（Live2DCubismCore）が見つかりません`);
  return core;
}

async function load(s: Shared, src: string, o: Live2dOptions, asset: SpritePartContext["asset"]): Promise<Loaded> {
  const core = await loadCore(asset("others", o.core));
  const url = (rel: string) => asset("fgimage", resolvePath(src, rel));
  const model3 = (await (await fetchOk(asset("fgimage", src))).json()) as Model3Json;
  const refs = model3.FileReferences;
  if (!refs?.Moc) throw new Error(`${src} に FileReferences.Moc がありません`);
  const json = async <T>(rel: string | undefined): Promise<T | undefined> => (rel ? ((await (await fetchOk(url(rel))).json()) as T) : undefined);
  const [mocBytes, images, physics, pose, expressionList] = await Promise.all([
    fetchOk(url(refs.Moc)).then((r) => r.arrayBuffer()),
    Promise.all((refs.Textures ?? []).map((t) => loadImage(url(t)))),
    json<Physics3Json>(refs.Physics),
    json<Pose3Json>(refs.Pose),
    Promise.all((refs.Expressions ?? []).map(async (e) => [e.Name, (await json<Exp3Json>(e.File))!] as const)),
  ]);
  const moc = core.Moc.fromArrayBuffer(mocBytes);
  if (!moc) throw new Error(`${src} の .moc3 を読めません（Core の版より新しいモデルかもしれません）`);
  const item: Loaded = {
    core,
    moc,
    model3,
    images,
    textures: [],
    expressions: new Map(expressionList),
    physics,
    pose,
    motions: new Map(),
    users: 0,
    restore: () => (item.textures = images.map((img) => uploadTexture(s, img))),
  };
  item.restore();
  s.restored.add(item.restore);
  return item;
}

function acquire(s: Shared, src: string, o: Live2dOptions, asset: SpritePartContext["asset"]): Promise<Loaded> {
  let p = loaded.get(src);
  if (!p) {
    p = load(s, src, o, asset);
    loaded.set(src, p);
    p.catch(() => loaded.delete(src));
  }
  return p.then((item) => {
    item.users++;
    return item;
  });
}

function releaseLoaded(s: Shared, src: string, item: Loaded): void {
  item.users--;
  if (item.users > 0) return;
  loaded.delete(src);
  s.restored.delete(item.restore);
  for (const t of item.textures) if (t) s.gl.deleteTexture(t);
  item.moc._release?.();
}

export function createLive2d(ctx: SpritePartContext): SpritePart {
  const s = sharedGl();
  const canvas = document.createElement("canvas");
  const out = canvas.getContext("2d");
  if (!s || !out) {
    console.warn(`Live2D の立ち絵を描けません（WebGL が使えません）。静止画で表示します: ${ctx.who}`);
    return {
      update() {
        // 描けないので静止画のまま（差分の image をエンジンが替える）
      },
      dispose() {
        // 足したものは無い
      },
    };
  }
  canvas.className = "sprite-live2d";
  Object.assign(canvas.style, { position: "absolute", left: `${-PAD * 100}%`, top: `${-PAD * 100}%`, width: `${(1 + 2 * PAD) * 100}%`, height: `${(1 + 2 * PAD) * 100}%`, pointerEvents: "none" });
  ctx.el.append(canvas);

  let options = readOptions(ctx.variant.model);
  let at: SpritePartVariant = { name: ctx.name ?? "", appearance: ctx.appearance ?? "" };
  let current: { src: string; item: Loaded; model: CoreModel; puppet: Puppet } | null = null;
  let disposed = false;
  let last = 0;
  let drawn = false;
  /** 読み込みの番号（読んでいる間に別のモデルに替わったら、前のものを捨てる）。 */
  let serial = 0;
  let releaseShot: (() => void) | null = null;
  const holdShot = () => {
    if (!releaseShot) releaseShot = ctx.holdShot?.() ?? (() => undefined);
  };
  const letShot = () => {
    releaseShot?.();
    releaseShot = null;
  };

  const stateOf = (puppet: Puppet) => pickState(at.name, options, puppet.expressionNames, puppet.motionGroups);

  function drop(): void {
    if (!current) return;
    current.model.release();
    releaseLoaded(s!, current.src, current.item);
    current = null;
    drawn = false;
    ctx.el.classList.remove("sprite-covered");
  }

  async function start(): Promise<void> {
    const mine = ++serial;
    drop();
    if (!options.src) {
      console.warn(`Live2D の立ち絵に src（.model3.json）がありません。静止画で表示します: ${ctx.who}`);
      return;
    }
    holdShot();
    const src = options.src;
    try {
      const item = await acquire(s!, src, options, ctx.asset);
      if (disposed || mine !== serial) {
        releaseLoaded(s!, src, item);
        return;
      }
      const model = item.core.Model.fromMoc(item.moc);
      if (!model) throw new Error(`${src} のモデルを作れません`);
      const puppet = new Puppet(
        model,
        {
          model3: item.model3,
          expressions: item.expressions,
          physics: item.physics,
          pose: item.pose,
          loadMotion: (group, index) => {
            const key = `${group}\n${index}`;
            let m = item.motions.get(key);
            if (!m) {
              const ref = item.model3.FileReferences.Motions?.[group]?.[index];
              m = ref
                ? fetchOk(ctx.asset("fgimage", resolvePath(src, ref.File)))
                    .then((r) => r.json() as Promise<Motion3Json>)
                    .catch((e: unknown) => {
                      console.warn(`Live2D のモーションを読み込めません: ${e instanceof Error ? e.message : String(e)}`);
                      return null;
                    })
                : Promise.resolve(null);
              item.motions.set(key, m);
            }
            return m;
          },
        },
        { idle: pickIdle(options.idle, Object.keys(item.model3.FileReferences.Motions ?? {})), breath: options.breath, blink: options.blink, lipSync: options.lipSync, eyeBlink: options.eyeBlink, lipGain: options.lipGain },
      );
      current = { src, item, model, puppet };
      puppet.setState(stateOf(puppet), true);
      // 物理演算を落ち着かせてから出す（出した瞬間に髪が跳ねないように）
      for (let i = 0; i < 30; i++) puppet.update(1 / 30, 0);
      draw();
    } catch (e) {
      if (mine === serial) {
        console.warn(`Live2D の立ち絵を読み込めません。静止画で表示します（${ctx.who}）: ${e instanceof Error ? e.message : String(e)}`);
        letShot();
      }
    }
  }

  function draw(): void {
    if (!current) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = Math.min(1, MAX_SIZE / (rect.width * dpr), MAX_SIZE / (rect.height * dpr));
    const w = Math.max(1, Math.round(rect.width * dpr * fit));
    const h = Math.max(1, Math.round(rect.height * dpr * fit));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const gl = s!.canvas;
    if (gl.width < w || gl.height < h) {
      gl.width = Math.max(gl.width, w);
      gl.height = Math.max(gl.height, h);
    }
    // 枠（キャンバスの中で、はみ出し分を除いた範囲）にモデルのキャンバスを収める
    const box = { x: (w * PAD) / (1 + 2 * PAD), y: (h * PAD) / (1 + 2 * PAD), width: w / (1 + 2 * PAD), height: h / (1 + 2 * PAD) };
    const info = current.model.canvasinfo;
    const rectIn = fitRect({ width: info.CanvasWidth, height: info.CanvasHeight }, box, options);
    // 共有の描画先の左下 w×h に描き、その範囲を写す
    drawModel(s!, current.model, current.item.textures, mapping(current.model, w, h, rectIn), w, h, current.puppet.opacity);
    out!.clearRect(0, 0, w, h);
    out!.drawImage(gl, 0, gl.height - h, w, h, 0, 0, w, h);
    if (!drawn) {
      drawn = true;
      ctx.el.classList.add("sprite-covered");
      letShot();
    }
  }

  void start();

  return {
    update(variant: CastVariant, next?: SpritePartVariant) {
      const before = options.src;
      options = readOptions(variant.model);
      if (next) at = next;
      if (options.src !== before) {
        void start();
        return;
      }
      if (current) current.puppet.setState(stateOf(current.puppet), ctx.skipping?.() === true);
    },
    tick(now, mouth) {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      if (!current) return;
      current.puppet.update(dt, mouth);
      draw();
    },
    dispose() {
      disposed = true;
      serial++;
      letShot();
      drop();
      canvas.remove();
    },
  };
}
