import type { CoreModel } from "./core.ts";
import { easeSine, evaluateCurve, parseSegments, type Exp3Json, type Model3Json, type Motion3Json, type Pose3Json, type Physics3Json, type Segment } from "./files.ts";
import { Physics } from "./physics.ts";

/**
 * Cubism のモデルを動かす（描くのは renderer.ts）。毎フレーム、パラメーターを既定の値に戻してから、
 * モーション（待機と差分の動き）→ 表情 → まばたき → 呼吸 → 口パク → 物理演算 → ポーズ の順に重ね、Core の update を呼ぶ。
 * 差分の名前で表情（.exp3.json の Name）とモーション（model3.json の Motions のグループ）を選ぶ（web.ts）。
 */

export interface PuppetFiles {
  model3: Model3Json;
  /** 表情の名前 → 中身。 */
  expressions: ReadonlyMap<string, Exp3Json>;
  physics?: Physics3Json | undefined;
  pose?: Pose3Json | undefined;
  /** モーションを読む（グループと番号。無ければ null）。 */
  loadMotion(group: string, index: number): Promise<Motion3Json | null>;
}

export interface PuppetOptions {
  /** 待機のモーションのグループ（null なら待機の動きなし）。 */
  idle: string | null;
  /** 呼吸と体のわずかな揺れ。 */
  breath: boolean;
  /** 口パクのパラメーター（省くと model3.json の Groups の LipSync、無ければ ParamMouthOpenY）。 */
  lipSync?: readonly string[] | undefined;
  /** まばたきのパラメーター（省くと Groups の EyeBlink、無ければ ParamEyeLOpen と ParamEyeROpen）。 */
  eyeBlink?: readonly string[] | undefined;
  /** まばたきするか。 */
  blink: boolean;
  /** 口の開きに掛ける大きさ（既定 1）。 */
  lipGain?: number | undefined;
  /** 乱数（テストで決まった値にする）。 */
  random?: () => number;
}

/** 差分が選んだ表情とモーション。 */
export interface PuppetState {
  expression: string | null;
  motion: string | null;
}

interface Curve {
  target: "parameter" | "part" | "eye-blink" | "lip-sync" | "opacity";
  index: number;
  segments: Segment[];
}

interface Playing {
  curves: Curve[];
  restricted: boolean;
  duration: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  /** 始めた時刻（秒）。 */
  start: number;
  /** 消し始めた時刻（null はまだ）。 */
  ending: number | null;
  idle: boolean;
}

interface ActiveExpression {
  params: { index: number; value: number; blend: "Add" | "Multiply" | "Overwrite" }[];
  fadeIn: number;
  fadeOut: number;
  start: number;
  ending: number | null;
  name: string;
}

/** Cubism の既定の呼吸（パラメーター、中心、振れ幅、周期（秒）、重み）。 */
const BREATH: [string, number, number, number, number][] = [
  ["ParamAngleX", 0, 15, 6.5345, 0.5],
  ["ParamAngleY", 0, 8, 3.5345, 0.5],
  ["ParamAngleZ", 0, 10, 5.5345, 0.5],
  ["ParamBodyAngleX", 0, 4, 15.5345, 0.5],
  ["ParamBreath", 0.5, 0.5, 3.2345, 0.5],
];

/** まばたきの、閉じる・閉じている・開く 長さ（秒）と、間の幅。 */
const BLINK = { closing: 0.1, closed: 0.05, opening: 0.15, gap: [2.2, 6] as const };

export class Puppet {
  private time = 0;
  private playing: Playing[] = [];
  private expressions: ActiveExpression[] = [];
  private readonly physics: Physics | null;
  private readonly lipIds: number[];
  private readonly eyeIds: number[];
  private readonly breathIds: [number, number, number, number, number][];
  private nextBlink: number;
  private blinkStart = -1;
  private readonly poseGroups: { parts: { part: number; param: number; links: number[] }[]; fade: number; opacity: number[] }[] = [];
  private readonly random: () => number;
  /** 待機のモーションを読み込み中か（重ねて読まない）。 */
  private idleLoading = false;
  /** 今の差分の状態（同じ状態を当て直しても動きを始め直さない）。 */
  private state: PuppetState = { expression: null, motion: null };
  /** モデル全体の不透明度（モーションの Opacity）。 */
  opacity = 1;
  /** 差分の動きを読み込んでいる数（撮影を待たせる）。 */
  pending = 0;

  constructor(
    readonly model: CoreModel,
    private readonly files: PuppetFiles,
    private readonly options: PuppetOptions,
  ) {
    this.random = options.random ?? Math.random;
    const ids = model.parameters.ids;
    const group = (name: string) => files.model3.Groups?.find((g) => g.Name === name)?.Ids;
    const indexes = (list: readonly string[]) => list.map((id) => ids.indexOf(id)).filter((i) => i >= 0);
    this.lipIds = indexes(options.lipSync ?? group("LipSync") ?? ["ParamMouthOpenY"]);
    this.eyeIds = indexes(options.eyeBlink ?? group("EyeBlink") ?? ["ParamEyeLOpen", "ParamEyeROpen"]);
    this.breathIds = BREATH.map(([id, ...rest]) => [ids.indexOf(id), ...rest] as [number, number, number, number, number]).filter(([i]) => i >= 0);
    this.physics = files.physics ? new Physics(files.physics, model.parameters) : null;
    this.nextBlink = this.blinkGap();
    for (const g of files.pose?.Groups ?? []) {
      const parts = g.map((p) => ({ part: model.parts.ids.indexOf(p.Id), param: ids.indexOf(p.Id), links: (p.Link ?? []).map((l) => model.parts.ids.indexOf(l)).filter((i) => i >= 0) })).filter((p) => p.part >= 0);
      if (parts.length > 0) this.poseGroups.push({ parts, fade: files.pose?.FadeInTime ?? 0.5, opacity: parts.map((_, i) => (i === 0 ? 1 : 0)) });
    }
  }

  private blinkGap(): number {
    return this.time + BLINK.gap[0] + this.random() * (BLINK.gap[1] - BLINK.gap[0]);
  }

  /** 表情の名前の一覧。 */
  get expressionNames(): string[] {
    return [...this.files.expressions.keys()];
  }

  /** モーションのグループの一覧。 */
  get motionGroups(): string[] {
    return Object.keys(this.files.model3.FileReferences.Motions ?? {});
  }

  /** 今の表情（消えていくものは除く）。 */
  get expression(): string | null {
    return this.expressions.find((e) => e.ending === null)?.name ?? null;
  }

  /**
   * 差分の表情とモーションにする。替わったものだけを替え、前の差分の動きは消していく。
   * instant（スキップ中、出したとき）なら、表情と動きをなめらかにつながず一気に替える。
   */
  setState(next: PuppetState, instant: boolean): void {
    const prev = this.state;
    this.state = next;
    if (next.expression !== prev.expression) this.setExpression(next.expression, instant);
    if (next.motion === prev.motion) return;
    for (const p of this.playing) if (!p.idle && p.ending === null) p.ending = instant ? this.time - p.fadeOut : this.time;
    if (next.motion) void this.startMotion(next.motion, false, instant);
  }

  private setExpression(name: string | null, instant: boolean): void {
    for (const e of this.expressions) if (e.ending === null) e.ending = instant ? this.time - e.fadeOut : this.time;
    const json = name ? this.files.expressions.get(name) : undefined;
    if (json) {
      const ids = this.model.parameters.ids;
      this.expressions.push({
        name: name!,
        params: (json.Parameters ?? []).map((p) => ({ index: ids.indexOf(p.Id), value: p.Value, blend: p.Blend ?? "Add" })).filter((p) => p.index >= 0),
        fadeIn: instant ? 0 : (json.FadeInTime ?? 1),
        fadeOut: json.FadeOutTime ?? 1,
        start: this.time,
        ending: null,
      });
    }
    if (instant) this.expressions = this.expressions.filter((e) => e.ending === null);
  }

  /** グループの中から一つ（"グループ:番号" なら決めたもの）を読んで流す。 */
  private async startMotion(spec: string, idle: boolean, instant = false): Promise<void> {
    const m = /^(.*):(\d+)$/.exec(spec);
    const group = m ? m[1]! : spec;
    const list = this.files.model3.FileReferences.Motions?.[group] ?? [];
    if (list.length === 0) return;
    const index = m ? Math.min(list.length - 1, Number(m[2])) : Math.floor(this.random() * list.length);
    const ref = list[index]!;
    if (!idle) this.pending++;
    let json: Motion3Json | null = null;
    try {
      json = await this.files.loadMotion(group, index);
    } finally {
      if (!idle) this.pending--;
    }
    if (!json) return;
    // 読んでいる間に差分が替わっていたら流さない
    if (!idle && this.state.motion !== spec) return;
    const params = this.model.parameters.ids;
    const parts = this.model.parts.ids;
    const curves: Curve[] = [];
    for (const c of json.Curves ?? []) {
      const segments = parseSegments(c.Segments);
      if (c.Target === "Parameter") {
        const index = params.indexOf(c.Id);
        if (index >= 0) curves.push({ target: "parameter", index, segments });
      } else if (c.Target === "PartOpacity") {
        const index = parts.indexOf(c.Id);
        if (index >= 0) curves.push({ target: "part", index, segments });
      } else if (c.Target === "Model") {
        const target = c.Id === "EyeBlink" ? "eye-blink" : c.Id === "LipSync" ? "lip-sync" : c.Id === "Opacity" ? "opacity" : null;
        if (target) curves.push({ target, index: -1, segments });
      }
    }
    const fade = (v: number | undefined, fallback: number) => (typeof v === "number" && v >= 0 ? v : fallback);
    this.playing.push({
      curves,
      restricted: json.Meta.AreBeziersRestricted === true,
      duration: Math.max(0.001, json.Meta.Duration),
      loop: json.Meta.Loop === true,
      fadeIn: instant ? 0 : fade(ref.FadeInTime, fade(json.Meta.FadeInTime, idle ? 0.5 : 1)),
      fadeOut: fade(ref.FadeOutTime, fade(json.Meta.FadeOutTime, 1)),
      start: this.time,
      ending: null,
      idle,
    });
  }

  /** dt 秒進めて、パラメーターを決め、Core のモデルを更新する。mouth は口の開き（0〜1）。 */
  update(dt: number, mouth: number): void {
    this.time += Math.max(0, Math.min(dt, 0.1));
    const t = this.time;
    const p = this.model.parameters;
    p.values.set(p.defaultValues);
    const parts = this.model.parts.opacities;
    parts.fill(1);
    this.opacity = 1;
    let blinkScale = 1;
    let lipScale = 1;

    // 待機の動き: 流れていなければ始める（読み込みは一度に一つ）
    if (this.options.idle && !this.idleLoading && !this.playing.some((m) => m.idle && m.ending === null)) {
      this.idleLoading = true;
      void this.startMotion(this.options.idle, true).finally(() => (this.idleLoading = false));
    }

    // モーション（始めた順に重ねる）
    const keep: Playing[] = [];
    for (const m of this.playing) {
      const age = t - m.start;
      if (!m.loop && m.ending === null && age >= m.duration - m.fadeOut) m.ending = Math.max(m.start, m.start + m.duration - m.fadeOut);
      const local = m.loop ? age % m.duration : Math.min(age, m.duration);
      const fadeIn = m.fadeIn > 0 ? easeSine(age / m.fadeIn) : 1;
      const fadeOut = m.ending === null ? 1 : m.fadeOut > 0 ? 1 - easeSine((t - m.ending) / m.fadeOut) : 0;
      const w = fadeIn * fadeOut;
      if (m.ending !== null && fadeOut <= 0) {
        // 待機の動きが終われば、次の待機の動きを始める（上の始め方で）
        continue;
      }
      keep.push(m);
      for (const c of m.curves) {
        const v = evaluateCurve(c.segments, local, m.restricted);
        if (c.target === "parameter") p.values[c.index] = p.values[c.index]! + (v - p.values[c.index]!) * w;
        else if (c.target === "part") parts[c.index] = parts[c.index]! + (v - parts[c.index]!) * w;
        else if (c.target === "eye-blink") blinkScale *= 1 + (v - 1) * w;
        else if (c.target === "lip-sync") lipScale *= 1 + (v - 1) * w;
        else this.opacity *= 1 + (v - 1) * w;
      }
    }
    this.playing = keep;

    // 表情
    const exprKeep: ActiveExpression[] = [];
    for (const e of this.expressions) {
      const fadeIn = e.fadeIn > 0 ? easeSine((t - e.start) / e.fadeIn) : 1;
      const fadeOut = e.ending === null ? 1 : e.fadeOut > 0 ? 1 - easeSine((t - e.ending) / e.fadeOut) : 0;
      if (e.ending !== null && fadeOut <= 0) continue;
      exprKeep.push(e);
      const w = fadeIn * fadeOut;
      for (const x of e.params) {
        const cur = p.values[x.index]!;
        if (x.blend === "Add") p.values[x.index] = cur + x.value * w;
        else if (x.blend === "Multiply") p.values[x.index] = cur * (1 + (x.value - 1) * w);
        else p.values[x.index] = cur + (x.value - cur) * w;
      }
    }
    this.expressions = exprKeep;

    // まばたき（目の開きに掛ける）
    if (this.options.blink && this.eyeIds.length > 0) {
      if (this.blinkStart < 0 && t >= this.nextBlink) this.blinkStart = t;
      let open = 1;
      if (this.blinkStart >= 0) {
        const s = t - this.blinkStart;
        if (s < BLINK.closing) open = 1 - s / BLINK.closing;
        else if (s < BLINK.closing + BLINK.closed) open = 0;
        else if (s < BLINK.closing + BLINK.closed + BLINK.opening) open = (s - BLINK.closing - BLINK.closed) / BLINK.opening;
        else {
          this.blinkStart = -1;
          this.nextBlink = this.blinkGap();
        }
      }
      const k = 1 - (1 - open) * blinkScale;
      for (const i of this.eyeIds) p.values[i] = p.values[i]! * k;
    }

    // 呼吸
    if (this.options.breath) {
      for (const [i, offset, peak, cycle, weight] of this.breathIds) p.values[i] = p.values[i]! + (offset + peak * Math.sin((t * 2 * Math.PI) / cycle)) * weight;
    }

    // 口パク
    const lip = Math.max(0, Math.min(1, mouth)) * (this.options.lipGain ?? 1) * lipScale;
    if (lip > 0) for (const i of this.lipIds) p.values[i] = p.values[i]! + lip;

    // 物理演算（呼吸と動きで決まった頭の向きから）
    this.physics?.evaluate(p, dt);

    // ポーズ: グループの中でパラメーターが立っている部品だけを出す
    for (const g of this.poseGroups) {
      let shown = g.parts.findIndex((x) => x.param >= 0 && p.values[x.param]! > 0.001);
      if (shown < 0) shown = Math.max(0, g.opacity.indexOf(Math.max(...g.opacity)));
      const step = g.fade > 0 ? dt / g.fade : 1;
      g.opacity[shown] = Math.min(1, g.opacity[shown]! + step);
      g.parts.forEach((x, i) => {
        if (i !== shown) g.opacity[i] = Math.min(g.opacity[i]!, 1 - g.opacity[shown]!);
        parts[x.part] = g.opacity[i]!;
        for (const l of x.links) parts[l] = g.opacity[i]!;
      });
    }

    for (let i = 0; i < p.values.length; i++) p.values[i] = Math.min(p.maximumValues[i]!, Math.max(p.minimumValues[i]!, p.values[i]!));
    this.model.update();
  }

  /** 動きを読み込み中か（撮影を待たせる）。 */
  get busy(): boolean {
    return this.pending > 0;
  }
}
