/**
 * Spine のランタイム（spine-webgl。作者が自分で入手して素材の others に置く。同梱しない。docs/live2d-spine.md）の、このプラグインが使う形。
 * IIFE の版（dist/iife/spine-webgl.min.js）をページに読み込むと window.spine を置く。Spine 4.x の spine-ts の口のうち、
 * 骨格を読んで動かし、描くのに要るものだけを書いた。骨格のデータの版（エディタで書き出した版）とランタイムの版はそろえる。
 */

export interface SpineAnimation {
  name: string;
  duration: number;
}

export interface SpineSkeletonData {
  animations: SpineAnimation[];
  skins: { name: string }[];
  x: number;
  y: number;
  width: number;
  height: number;
  findAnimation(name: string): SpineAnimation | null;
  findSkin(name: string): object | null;
}

export interface SpineTrackEntry {
  mixDuration: number;
  trackTime: number;
  timeScale: number;
  animation: SpineAnimation | null;
}

export interface SpineAnimationState {
  setAnimation(track: number, name: string, loop: boolean): SpineTrackEntry;
  addEmptyAnimation(track: number, mixDuration: number, delay: number): SpineTrackEntry;
  setEmptyAnimation(track: number, mixDuration: number): SpineTrackEntry;
  update(delta: number): void;
  apply(skeleton: SpineSkeleton): boolean;
}

export interface SpineSkeleton {
  data: SpineSkeletonData;
  setToSetupPose(): void;
  setSlotsToSetupPose(): void;
  setSkinByName(name: string): void;
  updateWorldTransform(physics?: unknown): void;
  update?(delta: number): void;
  getBounds(offset: { x: number; y: number }, size: { x: number; y: number }, temp?: number[]): void;
}

export interface SpineAtlasPage {
  name: string;
  pma?: boolean;
  setTexture(texture: unknown): void;
}

export interface SpineAtlas {
  pages: SpineAtlasPage[];
  dispose?(): void;
}

export interface SpineContext {
  gl: WebGLRenderingContext;
}

export interface SpineShader {
  bind(): void;
  unbind(): void;
  setUniformi(name: string, value: number): void;
  setUniform4x4f(name: string, values: ArrayLike<number>): void;
  dispose?(): void;
}

export interface SpineRuntime {
  ManagedWebGLRenderingContext: new (canvas: HTMLCanvasElement, config?: object) => SpineContext;
  GLTexture: new (context: SpineContext, image: HTMLImageElement, useMipMaps?: boolean) => { dispose?(): void };
  TextureAtlas: new (text: string) => SpineAtlas;
  AtlasAttachmentLoader: new (atlas: SpineAtlas) => object;
  SkeletonJson: new (loader: object) => { scale: number; readSkeletonData(json: string | object): SpineSkeletonData };
  SkeletonBinary: new (loader: object) => { scale: number; readSkeletonData(binary: Uint8Array): SpineSkeletonData };
  Skeleton: new (data: SpineSkeletonData) => SpineSkeleton;
  AnimationStateData: new (data: SpineSkeletonData) => { defaultMix: number };
  AnimationState: new (data: { defaultMix: number }) => SpineAnimationState;
  Shader: { newTwoColoredTextured(context: SpineContext): SpineShader; MVP_MATRIX: string; SAMPLER: string };
  PolygonBatcher: new (context: SpineContext, twoColorTint?: boolean) => { begin(shader: SpineShader): void; end(): void };
  SkeletonRenderer: new (context: SpineContext, twoColorTint?: boolean) => { premultipliedAlpha: boolean; draw(batcher: unknown, skeleton: SpineSkeleton): void };
  Matrix4: new () => { values: ArrayLike<number>; ortho2d(x: number, y: number, width: number, height: number): unknown };
  Vector2: new (x?: number, y?: number) => { x: number; y: number };
  /** 4.2 から（物理の制約）。 */
  Physics?: { update: unknown };
}

/** ページに読み込んだ Spine のランタイム（無ければ null）。 */
export function globalSpine(): SpineRuntime | null {
  const spine = (globalThis as { spine?: SpineRuntime }).spine;
  return spine && typeof spine.Skeleton === "function" && typeof spine.SkeletonRenderer === "function" && typeof spine.TextureAtlas === "function" ? spine : null;
}
