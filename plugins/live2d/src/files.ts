/**
 * Cubism のモデルのファイル（Cubism Editor が書き出す .model3.json・.motion3.json・.exp3.json・.physics3.json・.pose3.json）の形。
 * 公開されている書き出しの形を読むだけで、Cubism の Framework のコードは使わない。
 */

export interface Model3Json {
  Version?: number;
  FileReferences: {
    Moc: string;
    Textures: string[];
    Physics?: string;
    Pose?: string;
    Expressions?: { Name: string; File: string }[];
    Motions?: Record<string, MotionRef[]>;
  };
  Groups?: { Target?: string; Name: string; Ids: string[] }[];
}

export interface MotionRef {
  File: string;
  FadeInTime?: number;
  FadeOutTime?: number;
}

export interface Motion3Json {
  Meta: { Duration: number; Fps?: number; Loop?: boolean; AreBeziersRestricted?: boolean; FadeInTime?: number; FadeOutTime?: number };
  Curves: { Target: string; Id: string; FadeInTime?: number; FadeOutTime?: number; Segments: number[] }[];
}

export interface Exp3Json {
  FadeInTime?: number;
  FadeOutTime?: number;
  Parameters?: { Id: string; Value: number; Blend?: "Add" | "Multiply" | "Overwrite" }[];
}

export interface Physics3Json {
  Meta?: { EffectiveForces?: { Gravity?: { X: number; Y: number }; Wind?: { X: number; Y: number } } };
  PhysicsSettings: PhysicsSettingJson[];
}

export interface PhysicsSettingJson {
  Input: { Source: { Id: string }; Weight: number; Type: "X" | "Y" | "Angle"; Reflect?: boolean }[];
  Output: { Destination: { Id: string }; VertexIndex: number; Scale: number; Weight: number; Type: "X" | "Y" | "Angle"; Reflect?: boolean }[];
  Vertices: { Position?: { X: number; Y: number }; Mobility: number; Delay: number; Acceleration: number; Radius: number }[];
  Normalization: { Position: NormRange; Angle: NormRange };
}

export interface NormRange {
  Minimum: number;
  Default: number;
  Maximum: number;
}

export interface Pose3Json {
  FadeInTime?: number;
  Groups: { Id: string; Link?: string[] }[][];
}

// ---- モーションの曲線 ----

/** 曲線の一区間。点は [時間, 値]。 */
export type Segment =
  | { kind: "linear"; p0: [number, number]; p1: [number, number] }
  | { kind: "bezier"; p0: [number, number]; c0: [number, number]; c1: [number, number]; p1: [number, number] }
  | { kind: "stepped"; p0: [number, number]; p1: [number, number] }
  | { kind: "inverse-stepped"; p0: [number, number]; p1: [number, number] };

/** Segments（最初の点のあとに、区間の種類と点を並べたもの）を区間の並びにする。0 直線、1 ベジェ、2 階段、3 逆の階段。 */
export function parseSegments(s: readonly number[]): Segment[] {
  const out: Segment[] = [];
  if (s.length < 2) return out;
  let last: [number, number] = [s[0]!, s[1]!];
  let i = 2;
  while (i < s.length) {
    const type = s[i];
    if (type === 1) {
      if (i + 6 >= s.length) break;
      const seg: Segment = { kind: "bezier", p0: last, c0: [s[i + 1]!, s[i + 2]!], c1: [s[i + 3]!, s[i + 4]!], p1: [s[i + 5]!, s[i + 6]!] };
      out.push(seg);
      last = seg.p1;
      i += 7;
    } else {
      if (i + 2 >= s.length) break;
      const p1: [number, number] = [s[i + 1]!, s[i + 2]!];
      out.push({ kind: type === 2 ? "stepped" : type === 3 ? "inverse-stepped" : "linear", p0: last, p1 });
      last = p1;
      i += 3;
    }
  }
  if (out.length === 0) out.push({ kind: "stepped", p0: last, p1: last });
  return out;
}

const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/**
 * 曲線の時間 time の値。最初の点より前は最初の値、最後の点より後は最後の値。
 * ベジェは、restricted（制御点の時間が区間の中にある）なら時間の割合をそのまま媒介にし、そうでなければ時間の式を解いて媒介を求める。
 */
export function evaluateCurve(segments: readonly Segment[], time: number, restricted = false): number {
  const first = segments[0];
  if (!first) return 0;
  if (time <= first.p0[0]) return first.p0[1];
  for (const seg of segments) {
    if (time > seg.p1[0]) continue;
    const span = seg.p1[0] - seg.p0[0];
    switch (seg.kind) {
      case "linear":
        return span <= 0 ? seg.p1[1] : seg.p0[1] + ((seg.p1[1] - seg.p0[1]) * (time - seg.p0[0])) / span;
      case "stepped":
        return time < seg.p1[0] ? seg.p0[1] : seg.p1[1];
      case "inverse-stepped":
        return seg.p1[1];
      case "bezier": {
        if (span <= 0) return seg.p1[1];
        let t = (time - seg.p0[0]) / span;
        if (!restricted) {
          // 時間の三次式は単調なので、二分法で媒介を求める
          let lo = 0;
          let hi = 1;
          for (let k = 0; k < 30; k++) {
            const mid = (lo + hi) / 2;
            if (cubic(seg.p0[0], seg.c0[0], seg.c1[0], seg.p1[0], mid) < time) lo = mid;
            else hi = mid;
          }
          t = (lo + hi) / 2;
        }
        return cubic(seg.p0[1], seg.c0[1], seg.c1[1], seg.p1[1], t);
      }
    }
  }
  return segments.at(-1)!.p1[1];
}

/** 0〜1 をなめらかに（Cubism のフェードと同じ形）。 */
export function easeSine(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 0.5 - 0.5 * Math.cos(t * Math.PI);
}
