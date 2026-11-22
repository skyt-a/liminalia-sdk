import type { CastVariant } from "@liminalia/sdk";
import { loadScript, type SpritePart, type SpritePartContext, type SpritePartVariant } from "@liminalia/sdk/web";
import { fitRect, folderOf, pickRole, pickState, readOptions, type SpineOptions } from "./model.ts";
import { globalSpine, type SpineAnimationState, type SpineAtlas, type SpineContext, type SpineRuntime, type SpineShader, type SpineSkeleton, type SpineSkeletonData, type SpineTrackEntry } from "./runtime.ts";

/**
 * Spine の立ち絵（cast.json の model.type が "spine"）。立ち絵の要素の中にキャンバスを置き、毎フレーム動かして描く。
 * 動きの段（track）: 0 待機、1 差分の動き、2 まばたき、3 口パク（口の開きで時間を決める）。
 * 位置と大きさ、出し入れ、話者の強調と色調、反転はエンジンの立ち絵のまま効く。読み終えて最初の一枚を描くまで静止画を見せ、撮影を待たせる。
 */

const PAD = 0.15;
const MAX_SIZE = 2048;
const TRACK = { idle: 0, variant: 1, blink: 2, mouth: 3 } as const;
const BLINK_GAP: [number, number] = [2.2, 6];

/** すべての Spine の立ち絵で共有する描画先。 */
interface Shared {
  spine: SpineRuntime;
  canvas: HTMLCanvasElement;
  context: SpineContext;
  shader: SpineShader;
  batcher: InstanceType<SpineRuntime["PolygonBatcher"]>;
  renderer: InstanceType<SpineRuntime["SkeletonRenderer"]>;
  matrix: InstanceType<SpineRuntime["Matrix4"]>;
}

let shared: Promise<Shared> | null = null;

function sharedSpine(url: string): Promise<Shared> {
  shared ??= (async () => {
    let spine = globalSpine();
    if (!spine) {
      try {
        await loadScript(url);
      } catch {
        throw new Error(`Spine のランタイム（${url}）がありません。骨格を書き出した Spine の版に合う spine-webgl の dist/iife/spine-webgl.min.js を assets/others/spine/ に置いてください（docs/live2d-spine.md）`);
      }
      spine = globalSpine();
      if (!spine) throw new Error(`${url} を読み込みましたが、Spine のランタイム（spine）が見つかりません。spine-webgl の IIFE の版（dist/iife）を置いてください`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const context = new spine.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: true, antialias: true });
    return {
      spine,
      canvas,
      context,
      shader: spine.Shader.newTwoColoredTextured(context),
      batcher: new spine.PolygonBatcher(context, true),
      renderer: new spine.SkeletonRenderer(context, true),
      matrix: new spine.Matrix4(),
    };
  })();
  shared.catch(() => (shared = null));
  return shared;
}

interface Loaded {
  data: SpineSkeletonData;
  atlas: SpineAtlas;
  pma: boolean;
  users: number;
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
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${url} を読み込めません`));
    img.src = url;
  });
}

async function load(s: Shared, o: SpineOptions, asset: SpritePartContext["asset"]): Promise<Loaded> {
  const { spine } = s;
  const atlas = new spine.TextureAtlas(await (await fetchOk(asset("fgimage", o.atlas))).text());
  const dir = folderOf(o.atlas);
  for (const page of atlas.pages) page.setTexture(new spine.GLTexture(s.context, await loadImage(asset("fgimage", dir + page.name))));
  const loader = new spine.AtlasAttachmentLoader(atlas);
  const res = await fetchOk(asset("fgimage", o.src));
  const data = /\.skel$/i.test(o.src) ? new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(await res.arrayBuffer())) : new spine.SkeletonJson(loader).readSkeletonData(await res.text());
  return { data, atlas, pma: atlas.pages.some((p) => p.pma === true), users: 0 };
}

function acquire(s: Shared, o: SpineOptions, asset: SpritePartContext["asset"]): Promise<Loaded> {
  const key = `${o.src}\n${o.atlas}`;
  let p = loaded.get(key);
  if (!p) {
    p = load(s, o, asset);
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
  }
  return p.then((item) => {
    item.users++;
    return item;
  });
}

function releaseLoaded(o: { src: string; atlas: string }, item: Loaded): void {
  item.users--;
  if (item.users > 0) return;
  loaded.delete(`${o.src}\n${o.atlas}`);
  item.atlas.dispose?.();
}

export function createSpine(ctx: SpritePartContext): SpritePart {
  const canvas = document.createElement("canvas");
  const out = canvas.getContext("2d");
  if (!out) {
    return {
      update() {
        // 描けないので静止画のまま（差分の image をエンジンが替える）
      },
      dispose() {
        // 足したものは無い
      },
    };
  }
  canvas.className = "sprite-spine";
  Object.assign(canvas.style, { position: "absolute", left: `${-PAD * 100}%`, top: `${-PAD * 100}%`, width: `${(1 + 2 * PAD) * 100}%`, height: `${(1 + 2 * PAD) * 100}%`, pointerEvents: "none" });
  ctx.el.append(canvas);

  let options = readOptions(ctx.variant.model);
  let at: SpritePartVariant = { name: ctx.name ?? "", appearance: ctx.appearance ?? "" };
  let current: {
    s: Shared;
    key: { src: string; atlas: string };
    item: Loaded;
    skeleton: SpineSkeleton;
    state: SpineAnimationState;
    bounds: { x: number; y: number; width: number; height: number };
    roles: { idle: string | null; mouth: string | null; blink: string | null };
    shown: { animation: string | null; skin: string | null };
    /** 口パクの段（時間を口の開きで決める）。 */
    mouth: SpineTrackEntry | null;
  } | null = null;
  let disposed = false;
  let serial = 0;
  let last = 0;
  let drawn = false;
  let nextBlink = 0;
  let releaseShot: (() => void) | null = null;
  const holdShot = () => {
    if (!releaseShot) releaseShot = ctx.holdShot?.() ?? (() => undefined);
  };
  const letShot = () => {
    releaseShot?.();
    releaseShot = null;
  };
  const gap = () => (BLINK_GAP[0] + Math.random() * (BLINK_GAP[1] - BLINK_GAP[0])) * 1000;

  function drop(): void {
    if (!current) return;
    releaseLoaded(current.key, current.item);
    current = null;
    drawn = false;
    ctx.el.classList.remove("sprite-covered");
  }

  /** 差分の動きとスキンを当てる。instant なら混ぜずに替える。 */
  function apply(instant: boolean): void {
    if (!current) return;
    const { skeleton, state, item } = current;
    const pick = pickState(at.name, options, item.data.animations.map((a) => a.name), item.data.skins.map((x) => x.name));
    if (pick.skin !== current.shown.skin) {
      if (pick.skin) skeleton.setSkinByName(pick.skin);
      else if (item.data.findSkin("default")) skeleton.setSkinByName("default");
      skeleton.setSlotsToSetupPose();
      current.shown.skin = pick.skin;
    }
    if (pick.animation !== current.shown.animation) {
      const entry = pick.animation ? state.setAnimation(TRACK.variant, pick.animation, options.loop) : state.setEmptyAnimation(TRACK.variant, options.mix);
      if (instant) entry.mixDuration = 0;
      current.shown.animation = pick.animation;
    }
  }

  async function start(): Promise<void> {
    const mine = ++serial;
    drop();
    if (!options.src) {
      console.warn(`Spine の立ち絵に src（骨格の .skel か .json）がありません。静止画で表示します: ${ctx.who}`);
      return;
    }
    holdShot();
    const key = { src: options.src, atlas: options.atlas };
    try {
      const s = await sharedSpine(ctx.asset("others", options.runtime));
      const item = await acquire(s, options, ctx.asset);
      if (disposed || mine !== serial) {
        releaseLoaded(key, item);
        return;
      }
      const { spine } = s;
      const skeleton = new spine.Skeleton(item.data);
      const mix = new spine.AnimationStateData(item.data);
      mix.defaultMix = options.mix;
      const state = new spine.AnimationState(mix);
      const names = item.data.animations.map((a) => a.name);
      const roles = { idle: pickRole(options.idle, "idle", names), mouth: pickRole(options.mouth, "mouth", names), blink: pickRole(options.blink, "blink", names) };
      skeleton.setToSetupPose();
      skeleton.updateWorldTransform(spine.Physics?.update);
      let bounds = { x: item.data.x, y: item.data.y, width: item.data.width, height: item.data.height };
      if (!(bounds.width > 0 && bounds.height > 0)) {
        const offset = new spine.Vector2();
        const size = new spine.Vector2();
        skeleton.getBounds(offset, size, []);
        bounds = { x: offset.x, y: offset.y, width: size.x, height: size.y };
      }
      if (!(bounds.width > 0 && bounds.height > 0)) throw new Error(`${options.src} の大きさが分かりません`);
      let mouth: SpineTrackEntry | null = null;
      if (roles.idle) state.setAnimation(TRACK.idle, roles.idle, true);
      if (roles.mouth) {
        mouth = state.setAnimation(TRACK.mouth, roles.mouth, false);
        mouth.timeScale = 0;
        mouth.mixDuration = 0;
      }
      current = { s, key, item, skeleton, state, bounds, roles, shown: { animation: null, skin: null }, mouth };
      apply(true);
      nextBlink = performance.now() + gap();
      advance(0, 0);
      draw();
    } catch (e) {
      if (mine === serial) {
        console.warn(`Spine の立ち絵を読み込めません。静止画で表示します（${ctx.who}）: ${e instanceof Error ? e.message : String(e)}`);
        letShot();
      }
    }
  }

  function advance(dt: number, mouth: number): void {
    if (!current) return;
    const { state, skeleton, s } = current;
    // 口: 開きで時間を決める（動きの始めが閉じた口、終わりが大きく開いた口）
    if (current.mouth) current.mouth.trackTime = Math.max(0, Math.min(1, mouth)) * (current.mouth.animation?.duration ?? 0);
    state.update(dt);
    state.apply(skeleton);
    skeleton.update?.(dt);
    skeleton.updateWorldTransform(s.spine.Physics?.update);
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
    const { s, bounds, skeleton, item } = current;
    if (s.canvas.width < w || s.canvas.height < h) {
      s.canvas.width = Math.max(s.canvas.width, w);
      s.canvas.height = Math.max(s.canvas.height, h);
    }
    const box = { x: (w * PAD) / (1 + 2 * PAD), y: (h * PAD) / (1 + 2 * PAD), width: w / (1 + 2 * PAD), height: h / (1 + 2 * PAD) };
    const r = fitRect(bounds, box, options);
    // 骨格の座標（上が正）で、描く先の全体に当たる範囲
    const k = r.width / bounds.width;
    const worldX = bounds.x - r.x / k;
    const worldY = bounds.y - (h - (r.y + r.height)) / k;
    const gl = s.context.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    s.matrix.ortho2d(worldX, worldY, w / k, h / k);
    s.shader.bind();
    s.shader.setUniformi(s.spine.Shader.SAMPLER, 0);
    s.shader.setUniform4x4f(s.spine.Shader.MVP_MATRIX, s.matrix.values);
    s.renderer.premultipliedAlpha = item.pma;
    s.batcher.begin(s.shader);
    s.renderer.draw(s.batcher, skeleton);
    s.batcher.end();
    s.shader.unbind();
    out!.clearRect(0, 0, w, h);
    out!.drawImage(s.canvas, 0, s.canvas.height - h, w, h, 0, 0, w, h);
    if (!drawn) {
      drawn = true;
      ctx.el.classList.add("sprite-covered");
      letShot();
    }
  }

  void start();

  return {
    update(variant: CastVariant, next?: SpritePartVariant) {
      const before = options;
      options = readOptions(variant.model);
      if (next) at = next;
      if (options.src !== before.src || options.atlas !== before.atlas || options.runtime !== before.runtime) {
        void start();
        return;
      }
      apply(ctx.skipping?.() === true);
    },
    tick(now, mouth) {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!current) return;
      const { state, roles } = current;
      // まばたき（ときどき一度流して戻す）
      if (roles.blink && now >= nextBlink) {
        state.setAnimation(TRACK.blink, roles.blink, false);
        state.addEmptyAnimation(TRACK.blink, 0.05, 0);
        nextBlink = now + gap();
      }
      advance(dt, mouth);
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
