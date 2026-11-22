import type { NormRange, Physics3Json } from "./files.ts";

/**
 * 物理演算（.physics3.json）。髪や服の揺れ。入力のパラメーター（頭の向きなど）から振り子の先を動かし、その位置や角度を出力のパラメーターに書く。
 * 書き出しの形と、振り子の計算（重さ・遅れ・空気の抵抗）は Cubism の物理演算の決まりに合わせてある。
 */

interface Vec {
  x: number;
  y: number;
}

interface Particle {
  position: Vec;
  lastPosition: Vec;
  lastGravity: Vec;
  velocity: Vec;
  force: Vec;
  mobility: number;
  delay: number;
  acceleration: number;
  radius: number;
}

interface Setting {
  inputs: { index: number; weight: number; type: "X" | "Y" | "Angle"; reflect: boolean }[];
  outputs: { index: number; vertex: number; scale: number; weight: number; type: "X" | "Y" | "Angle"; reflect: boolean }[];
  particles: Particle[];
  position: NormRange;
  angle: NormRange;
}

/** パラメーターの値の並び（Core の parameters と同じ形）。 */
export interface ParamTable {
  ids: string[];
  values: Float32Array;
  minimumValues: Float32Array;
  maximumValues: Float32Array;
  defaultValues: Float32Array;
}

const MAX_WEIGHT = 100;
const AIR_RESISTANCE = 5;
const MOVEMENT_THRESHOLD = 0.001;

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
function normalize(a: Vec): Vec {
  const len = Math.hypot(a.x, a.y);
  return len > 0 ? { x: a.x / len, y: a.y / len } : { x: 0, y: 0 };
}
function directionToRadian(from: Vec, to: Vec): number {
  let r = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x);
  while (r < -Math.PI) r += Math.PI * 2;
  while (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/** パラメーターの値を、物理演算の正規化の幅（norm）に移す。reflect でなければ向きを逆にする。 */
export function normalizeParameter(value: number, min: number, max: number, norm: NormRange, reflect: boolean): number {
  const hi = Math.max(min, max);
  const lo = Math.min(min, max);
  const v = Math.min(hi, Math.max(lo, value));
  const nLo = Math.min(norm.Minimum, norm.Maximum);
  const nHi = Math.max(norm.Minimum, norm.Maximum);
  const middle = lo + (hi - lo) / 2;
  const d = v - middle;
  let result = norm.Default;
  if (d > 0 && hi - middle !== 0) result = d * ((nHi - norm.Default) / (hi - middle)) + norm.Default;
  else if (d < 0 && lo - middle !== 0) result = d * ((nLo - norm.Default) / (lo - middle)) + norm.Default;
  return reflect ? result : -result;
}

export class Physics {
  private readonly settings: Setting[] = [];
  private readonly gravity: Vec;
  private readonly wind: Vec;

  constructor(json: Physics3Json, params: ParamTable) {
    const forces = json.Meta?.EffectiveForces;
    this.gravity = { x: forces?.Gravity?.X ?? 0, y: forces?.Gravity?.Y ?? -1 };
    this.wind = { x: forces?.Wind?.X ?? 0, y: forces?.Wind?.Y ?? 0 };
    const indexOf = (id: string) => params.ids.indexOf(id);
    for (const s of json.PhysicsSettings ?? []) {
      const particles: Particle[] = s.Vertices.map((v) => ({
        position: { x: 0, y: 0 },
        lastPosition: { x: 0, y: 0 },
        lastGravity: { x: 0, y: 1 },
        velocity: { x: 0, y: 0 },
        force: { x: 0, y: 0 },
        mobility: v.Mobility,
        delay: v.Delay,
        acceleration: v.Acceleration,
        radius: v.Radius,
      }));
      // 振り子は根元から真下へ、半径の分ずつ並べて始める
      for (let i = 1; i < particles.length; i++) {
        const p = particles[i]!;
        p.position = { x: particles[i - 1]!.position.x, y: particles[i - 1]!.position.y + p.radius };
        p.lastPosition = { ...p.position };
      }
      this.settings.push({
        inputs: s.Input.map((i) => ({ index: indexOf(i.Source.Id), weight: i.Weight, type: i.Type, reflect: i.Reflect === true })).filter((i) => i.index >= 0),
        outputs: s.Output.map((o) => ({ index: indexOf(o.Destination.Id), vertex: o.VertexIndex, scale: o.Scale, weight: o.Weight, type: o.Type, reflect: o.Reflect === true })).filter((o) => o.index >= 0),
        particles,
        position: s.Normalization.Position,
        angle: s.Normalization.Angle,
      });
    }
  }

  /** dt 秒進めて、出力のパラメーターに書く。 */
  evaluate(params: ParamTable, dt: number): void {
    for (const s of this.settings) {
      let tx = 0;
      let ty = 0;
      let angle = 0;
      for (const input of s.inputs) {
        const value = params.values[input.index]!;
        const min = params.minimumValues[input.index]!;
        const max = params.maximumValues[input.index]!;
        const w = input.weight / MAX_WEIGHT;
        if (input.type === "X") tx += normalizeParameter(value, min, max, s.position, input.reflect) * w;
        else if (input.type === "Y") ty += normalizeParameter(value, min, max, s.position, input.reflect) * w;
        else angle += normalizeParameter(value, min, max, s.angle, input.reflect) * w;
      }
      const r = (-angle * Math.PI) / 180;
      const rx = tx * Math.cos(r) - ty * Math.sin(r);
      const ry = rx * Math.sin(r) + ty * Math.cos(r);
      this.step(s.particles, { x: rx, y: ry }, angle, MOVEMENT_THRESHOLD * s.position.Maximum, dt);
      for (const out of s.outputs) {
        const i = out.vertex;
        if (i < 1 || i >= s.particles.length) continue;
        const translation = sub(s.particles[i]!.position, s.particles[i - 1]!.position);
        let value: number;
        if (out.type === "X") value = translation.x;
        else if (out.type === "Y") value = translation.y;
        else {
          const parent = i >= 2 ? sub(s.particles[i - 1]!.position, s.particles[i - 2]!.position) : mul(this.gravity, -1);
          value = directionToRadian(parent, translation);
        }
        if (out.reflect) value = -value;
        value *= out.scale;
        const min = params.minimumValues[out.index]!;
        const max = params.maximumValues[out.index]!;
        value = Math.min(max, Math.max(min, value));
        const w = out.weight / MAX_WEIGHT;
        params.values[out.index] = w >= 1 ? value : params.values[out.index]! * (1 - w) + value * w;
      }
    }
  }

  private step(strand: Particle[], translation: Vec, angle: number, threshold: number, dt: number): void {
    const root = strand[0];
    if (!root) return;
    root.position = { ...translation };
    const radian = (angle * Math.PI) / 180;
    const gravity = normalize({ x: Math.sin(radian), y: Math.cos(radian) });
    for (let i = 1; i < strand.length; i++) {
      const p = strand[i]!;
      const prev = strand[i - 1]!;
      p.force = add(mul(gravity, p.acceleration), this.wind);
      p.lastPosition = { ...p.position };
      const delay = p.delay * dt * 30;
      const direction = sub(p.position, prev.position);
      const turn = directionToRadian(p.lastGravity, gravity) / AIR_RESISTANCE;
      const dx = Math.cos(turn) * direction.x - direction.y * Math.sin(turn);
      const dy = Math.sin(turn) * dx + direction.y * Math.cos(turn);
      p.position = add(prev.position, { x: dx, y: dy });
      p.position = add(add(p.position, mul(p.velocity, delay)), mul(p.force, delay * delay));
      const dir = normalize(sub(p.position, prev.position));
      p.position = add(prev.position, mul(dir, p.radius));
      if (Math.abs(p.position.x) < threshold) p.position.x = 0;
      if (delay !== 0) p.velocity = mul(sub(p.position, p.lastPosition), p.mobility / delay);
      p.force = { x: 0, y: 0 };
      p.lastGravity = { ...gravity };
    }
  }
}
