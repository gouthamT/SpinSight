/**
 * Synthetic roulette wheel: deterministic spin physics + a software renderer
 * that produces RGBA frames through a configurable camera. Used for
 * (a) automated tests with exact ground truth and
 * (b) an in-app "synthetic source" so the whole pipeline can be exercised
 *     without a physical wheel.
 *
 * The physics here is a plausible GENERATOR, not the prediction model.
 */
import type { RotationSign, WheelType } from "@/types/roulette";
import { TWO_PI, wrapAngle } from "@/engine/geometry/angles";
import { pocketColour, pocketCount, pocketIndexAtAngle, pocketOrder } from "@/engine/wheel/layout";
import type { RGBAFrame } from "@/engine/vision/polarSampler";

export { mulberry32 } from "@/engine/math/random";
import { mulberry32 } from "@/engine/math/random";

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface SyntheticCamera {
  width: number;
  height: number;
  /** Image position of the wheel centre. */
  cx: number;
  cy: number;
  /** Pixels per rim radius. */
  scale: number;
  /** In-plane rotation (rad). */
  rotation: number;
  /** cos(tilt): 1 = overhead, 0.7 ≈ 45° tilt. */
  foreshorten: number;
  /** Small projective term (0 = pure affine). */
  perspective: number;
}

export const DEFAULT_CAMERA: SyntheticCamera = {
  width: 640,
  height: 480,
  cx: 320,
  cy: 240,
  scale: 215,
  rotation: 0.35,
  foreshorten: 0.82,
  perspective: 0,
};

/** Wheel plane (u right, v up, rim = 1) → image px. */
export function projectToImage(cam: SyntheticCamera, u: number, v: number): { x: number; y: number } {
  const a = u;
  const b = -v * cam.foreshorten;
  const c = Math.cos(cam.rotation),
    s = Math.sin(cam.rotation);
  const xp = a * c - b * s;
  const yp = a * s + b * c;
  const w = 1 + cam.perspective * v;
  return { x: cam.cx + (cam.scale * xp) / w, y: cam.cy + (cam.scale * yp) / w };
}

/** Image px → wheel plane (inverse of projectToImage). */
export function unprojectFromImage(cam: SyntheticCamera, x: number, y: number): { u: number; v: number } {
  const X = (x - cam.cx) / cam.scale;
  const Y = (y - cam.cy) / cam.scale;
  const c = Math.cos(cam.rotation),
    s = Math.sin(cam.rotation),
    k = cam.foreshorten,
    p = cam.perspective;
  // u·c + v·(k·s − X·p) = X ;  u·s + v·(−k·c − Y·p) = Y
  const a11 = c,
    a12 = k * s - X * p,
    a21 = s,
    a22 = -k * c - Y * p;
  const det = a11 * a22 - a12 * a21;
  return { u: (X * a22 - a12 * Y) / det, v: (a11 * Y - a21 * X) / det };
}

// ---------------------------------------------------------------------------
// Spin physics (generator)
// ---------------------------------------------------------------------------

export interface SpinParams {
  wheelType: WheelType;
  /** Direction the printed pocket sequence runs (on screen). */
  sequenceSign: RotationSign;
  rotorOmega0: number; // rad/s, signed
  rotorAlpha: number; // rad/s², opposes rotation
  ballOmega0: number; // rad/s, signed (opposite to rotor in casinos)
  ballTheta0: number;
  rotorTheta0: number;
  /** Constant (rolling) deceleration on the track, rad/s². */
  frictionA: number;
  /** Quadratic (air drag) coefficient, 1/rad. */
  dragB: number;
  /** |ω| at which the ball leaves the track, rad/s. */
  criticalOmega: number;
  seed: number;
}

export const DEFAULT_SPIN: SpinParams = {
  wheelType: "european",
  sequenceSign: -1,
  rotorOmega0: 2.2,
  rotorAlpha: -0.035,
  ballOmega0: -15,
  ballTheta0: 0.4,
  rotorTheta0: 1.1,
  frictionA: 0.3,
  dragB: 0.011,
  criticalOmega: 5.2,
  seed: 42,
};

export interface SpinState {
  ballTheta: number; // wrapped
  ballR: number;
  rotorZero: number; // wrapped angle of zero-pocket centre
  phase: "track" | "descent" | "bouncing" | "settled";
}

const TRACK_R = 0.93;
const POCKET_R = 0.62;

export class SyntheticSpin {
  readonly dtMs = 1;
  private readonly theta: Float64Array;
  private readonly radius: Float64Array;
  private readonly phaseIdx: Uint8Array;
  readonly dropTimeMs: number;
  readonly settleTimeMs: number;
  readonly durationMs: number;
  readonly finalPocket: number;

  constructor(readonly params: SpinParams = DEFAULT_SPIN) {
    const rnd = mulberry32(params.seed);
    const p = params;
    const dt = this.dtMs / 1000;
    const maxSteps = 60_000;
    const th: number[] = [];
    const rr: number[] = [];
    const ph: number[] = [];
    let θ = p.ballTheta0;
    let ω = p.ballOmega0;
    const dir = Math.sign(ω) || 1;
    let step = 0;

    // Phase A: on the track, ω̇ = −(a + bω²)·sgn ω
    while (Math.abs(ω) > p.criticalOmega && step < maxSteps) {
      th.push(θ);
      rr.push(TRACK_R);
      ph.push(0);
      const dω = -(p.frictionA + p.dragB * ω * ω) * dir * dt;
      ω += dω;
      θ += ω * dt;
      step++;
    }
    this.dropTimeMs = step * this.dtMs;

    // Phase B: descent across the cone with a possible deflector hit.
    const descentSteps = 900;
    const hitAt = Math.floor(descentSteps * (0.3 + 0.4 * rnd()));
    const hitFactor = rnd() < 0.7 ? 0.55 + 0.5 * rnd() : 1;
    for (let k = 0; k < descentSteps; k++) {
      const s = k / descentSteps;
      const r = TRACK_R + (POCKET_R + 0.02 - TRACK_R) * (s * s * (3 - 2 * s));
      th.push(θ);
      rr.push(r);
      ph.push(1);
      if (k === hitAt) ω *= hitFactor;
      ω -= 1.2 * dir * dt;
      θ += ω * dt;
      step++;
    }

    // Phase C: bouncing on the rotor. Work in the rotor frame.
    const rotorAt = (ms: number) => this.rotorAngle(ms);
    let rel = θ - rotorAt(step * this.dtMs);
    let ωrel = ω - this.rotorOmega(step * this.dtMs);
    const bounceSteps = 1200 + Math.floor(800 * rnd());
    const n = pocketCount(p.wheelType);
    const pitch = TWO_PI / n;
    for (let k = 0; k < bounceSteps; k++) {
      const t = step * this.dtMs;
      th.push(rel + rotorAt(t));
      rr.push(POCKET_R + 0.015 * Math.abs(Math.sin(k * 0.02)) * (1 - k / bounceSteps));
      ph.push(2);
      if (rnd() < 0.004) ωrel = -0.5 * ωrel + (rnd() - 0.5) * 3; // bounce off a fret
      ωrel *= 0.996;
      rel += ωrel * dt;
      step++;
    }
    // Snap into the nearest pocket in the rotor frame (relative to zero pocket at rotorAngle).
    const idx = Math.round(wrapAngle(rel) / pitch) * pitch;
    const settleSteps = 3000;
    const rel0 = rel;
    for (let k = 0; k < settleSteps; k++) {
      const t = step * this.dtMs;
      const s = Math.min(1, k / 250);
      const relNow = rel0 + (idx - wrapAngle(rel0)) * s;
      th.push(relNow + rotorAt(t));
      rr.push(POCKET_R);
      ph.push(3);
      step++;
    }
    this.settleTimeMs = (step - settleSteps) * this.dtMs;
    this.durationMs = step * this.dtMs;
    this.theta = Float64Array.from(th);
    this.radius = Float64Array.from(rr);
    this.phaseIdx = Uint8Array.from(ph);
    const lastT = (step - 1) * this.dtMs;
    this.finalPocket =
      pocketOrder(p.wheelType)[
        pocketIndexAtAngle(p.wheelType, this.theta[step - 1]!, this.rotorAngle(lastT), p.sequenceSign)
      ] ?? 0;
  }

  rotorOmega(ms: number): number {
    const t = ms / 1000;
    const { rotorOmega0: w0, rotorAlpha: a } = this.params;
    const tStop = Math.abs(w0 / a);
    return t < tStop ? w0 + a * t : 0;
  }

  /** Unwrapped rotor (zero pocket) angle. */
  rotorAngle(ms: number): number {
    const { rotorOmega0: w0, rotorAlpha: a, rotorTheta0 } = this.params;
    const tStop = Math.abs(w0 / a);
    const t = Math.min(ms / 1000, tStop);
    return rotorTheta0 + w0 * t + 0.5 * a * t * t;
  }

  state(ms: number): SpinState {
    const i = Math.max(0, Math.min(this.theta.length - 1, Math.round(ms / this.dtMs)));
    const phases = ["track", "descent", "bouncing", "settled"] as const;
    return {
      ballTheta: wrapAngle(this.theta[i]!),
      ballR: this.radius[i]!,
      rotorZero: wrapAngle(this.rotorAngle(ms)),
      phase: phases[this.phaseIdx[i]!] ?? "settled",
    };
  }

  /** Unwrapped ball angle (ground truth for velocity tests). */
  ballThetaUnwrapped(ms: number): number {
    const i = Math.max(0, Math.min(this.theta.length - 1, Math.round(ms / this.dtMs)));
    return this.theta[i]!;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  noise: number; // ± luma noise amplitude
  lightingGradient: number; // 0..0.3
  showBall: boolean;
  frameSeed: number;
}

const POCKET_RGB = {
  red: [168, 26, 32],
  black: [24, 24, 28],
  green: [18, 128, 58],
} as const;

/**
 * Render a frame. Geometry (rim = 1): rim wood 1.0–1.06, ball track 0.86–1.0,
 * deflector cone 0.72–0.86 (8 diamonds), pocket ring 0.58–0.72 (rotating),
 * rotor cone 0.25–0.58, turret < 0.25.
 */
export function renderWheel(
  cam: SyntheticCamera,
  spin: { wheelType: WheelType; sequenceSign: RotationSign },
  state: SpinState,
  out: RGBAFrame,
  opts: Partial<RenderOptions> = {},
): void {
  const o: RenderOptions = { noise: 3, lightingGradient: 0.08, showBall: true, frameSeed: 1, ...opts };
  const { width, height, data } = out;
  const order = pocketOrder(spin.wheelType);
  const n = order.length;
  const pitch = TWO_PI / n;
  const ballU = state.ballR * Math.cos(state.ballTheta);
  const ballV = state.ballR * Math.sin(state.ballTheta);
  const ballRad = 0.026;
  let seed = (o.frameSeed * 2654435761) >>> 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { u, v } = unprojectFromImage(cam, x + 0.5, y + 0.5);
      const r = Math.hypot(u, v);
      const θ = Math.atan2(v, u);
      let R: number, G: number, B: number;

      if (r > 1.06) {
        R = 14; G = 58; B = 42; // felt
      } else if (r > 1.0) {
        R = 70; G = 42; B = 22; // rim
      } else if (r > 0.86) {
        const g = 0.9 + 0.1 * Math.cos((r - 0.93) * 40);
        R = 140 * g; G = 92 * g; B = 52 * g; // ball track
      } else if (r > 0.72) {
        R = 92; G = 58; B = 32; // cone
        const dk = wrapAngle(θ - Math.PI / 8 - Math.round((θ - Math.PI / 8) / (Math.PI / 4)) * (Math.PI / 4));
        if (Math.abs(r - 0.79) < 0.02 && Math.abs(dk) < 0.04) { R = 200; G = 175; B = 90; } // brass deflector
      } else if (r > 0.58) {
        const rel = wrapAngle((θ - state.rotorZero) * spin.sequenceSign);
        const f = rel / pitch;
        const k = Math.round(f);
        const frac = Math.abs(f - k);
        const num = order[((k % n) + n) % n]!;
        const c = POCKET_RGB[pocketColour(num)];
        if (frac > 0.44) { R = 185; G = 185; B = 190; } // fret
        else if (r > 0.665) { R = c[0] * 1.15; G = c[1] * 1.15; B = c[2] * 1.15; }
        else { R = c[0]; G = c[1]; B = c[2]; }
        if (r > 0.665 && r < 0.705 && frac < 0.12) { R = 230; G = 225; B = 210; } // number print
      } else if (r > 0.25) {
        const a = wrapAngle(θ - state.rotorZero);
        const stripe = Math.abs(wrapAngle(a * 4) ) < 0.18;
        R = stripe ? 160 : 118; G = stripe ? 110 : 76; B = stripe ? 64 : 42;
      } else {
        const a = wrapAngle(θ - state.rotorZero);
        const arm = Math.abs(wrapAngle(a * 4)) < 0.25 && r > 0.08;
        const sv = arm ? 215 : 150 + 60 * (1 - r / 0.25);
        R = sv; G = sv; B = sv + 5;
      }

      if (o.showBall) {
        const d2 = (u - ballU) ** 2 + (v - ballV) ** 2;
        if (d2 < ballRad * ballRad) {
          const s = 245 - 70 * (d2 / (ballRad * ballRad));
          R = s; G = s; B = s;
        }
      }

      const light = 1 - o.lightingGradient + o.lightingGradient * Math.cos(Math.atan2(y - cam.cy, x - cam.cx) - 0.8);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const nz = ((seed >>> 8) / 16777216 - 0.5) * 2 * o.noise;
      const idx = (y * width + x) * 4;
      data[idx] = R * light + nz;
      data[idx + 1] = G * light + nz;
      data[idx + 2] = B * light + nz;
      data[idx + 3] = 255;
    }
  }
}

/** Ground-truth calibration clicks for a synthetic camera. */
export function syntheticCalibrationClicks(cam: SyntheticCamera, rotorZero: number, rimPoints = 12) {
  const rim = Array.from({ length: rimPoints }, (_, i) => {
    const a = (i / rimPoints) * TWO_PI + 0.1;
    return projectToImage(cam, Math.cos(a), Math.sin(a));
  });
  const zr = 0.62;
  return {
    centre: projectToImage(cam, 0, 0),
    rim,
    zeroPocket: projectToImage(cam, zr * Math.cos(rotorZero), zr * Math.sin(rotorZero)),
  };
}

export function allocFrame(width: number, height: number): RGBAFrame {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}
