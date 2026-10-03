/**
 * Shared 2-D top-down roulette scene used by every simulation adapter
 * (kinematic reference, Rapier.js, Matter.js), so their outputs are
 * comparable. Units: metres, seconds, radians; origin = wheel centre, y up,
 * angles counter-clockwise positive.
 *
 * What a 2-D top-down model can and cannot represent:
 *  - The bowl's slopes are not geometry here: they are an inward "slope pull"
 *    g·tanδ applied to the ball. The ball rides the rim wall while
 *    v²/r > g·tanδ_track and leaves the track by itself when it slows down,
 *    which reproduces ω_c² = g·tanδ / r.
 *  - Rolling resistance and air drag are the fitted law dω/dt = −(a + bω²),
 *    applied as a tangential deceleration r·(a + bω²).
 *  - Deflectors (diamonds) and pocket frets ARE colliders, so impacts are
 *    resolved by each engine's contact solver; this is where engines differ.
 *  - Vertical bouncing, spin, and the 3-D shape of pockets are not modelled.
 */
import type { SimParams, SimSample } from "@/types/simulation";
import { pocketCount, pocketOrder } from "@/engine/wheel/layout";
import { mulberry32 } from "@/engine/math/random";

export const G = 9.80665;

export const GEOM = {
  rimR: 0.4, // outer wall of the ball track
  ballR: 0.0105, // 21 mm ball
  trackInner: 0.34, // inner edge of the ball track
  deflectorR: 0.29, // radius of the deflector ring
  deflectorHalfLen: 0.016,
  deflectorHalfWidth: 0.005,
  pocketOuter: 0.23, // outer edge of the pocket ring (rotor)
  turretR: 0.18, // inner wall of the pockets
  fretOuter: 0.226,
  fretHalfWidth: 0.0015,
} as const;

export const DEFAULT_SIM_PARAMS: SimParams = {
  wheelType: "european",
  ballOmega0: 15,
  ballDirection: "clockwise",
  rotorOmega0: 2.2,
  rotorDecel: 0.035,
  frictionA: 0.3,
  dragB: 0.011,
  trackInclineDeg: 30,
  coneInclineDeg: 45,
  restitution: 0.45,
  contactFriction: 0.2,
  surfaceDrag: 2.5,
  deflectors: 8,
  launchAngle: 0,
  rotorPhase: 0,
  seed: 1,
  launchNoise: 0,
  dt: 1 / 480,
  maxTimeS: 45,
};

export function ballDir(p: SimParams): 1 | -1 {
  return p.ballDirection === "clockwise" ? -1 : 1;
}

/** Rotor angle and angular velocity at time t (decelerates to rest, never reverses). */
export function rotorState(p: SimParams, t: number): { angle: number; omega: number } {
  const s = -ballDir(p); // opposite to the ball
  const w0 = Math.abs(p.rotorOmega0);
  const d = Math.max(p.rotorDecel, 0);
  const tStop = d > 0 ? w0 / d : Infinity;
  const tt = Math.min(t, tStop);
  return { angle: p.rotorPhase + s * (w0 * tt - 0.5 * d * tt * tt), omega: t < tStop ? s * (w0 - d * t) : 0 };
}

/** Theoretical drop speed implied by the track inclination (rad/s). */
export function criticalOmega(p: SimParams): number {
  const r = GEOM.rimR - GEOM.ballR;
  return Math.sqrt((G * Math.tan((p.trackInclineDeg * Math.PI) / 180)) / r);
}

export interface Vec {
  x: number;
  y: number;
}

/**
 * Non-contact acceleration on the ball (m/s²): slope pull, rolling friction +
 * air drag, and drag by the rotor surface once on the rotor.
 */
export function ballAcceleration(p: SimParams, pos: Vec, vel: Vec, rotorOmega: number): Vec {
  const r = Math.hypot(pos.x, pos.y) || 1e-9;
  const rx = pos.x / r, ry = pos.y / r;
  const speed = Math.hypot(vel.x, vel.y);
  const omega = (pos.x * vel.y - pos.y * vel.x) / (r * r); // angular rate about the centre
  let ax = 0, ay = 0;
  const onTrack = r >= GEOM.trackInner;
  const pull = G * Math.tan(((onTrack ? p.trackInclineDeg : p.coneInclineDeg) * Math.PI) / 180);
  ax -= pull * rx;
  ay -= pull * ry;
  if (r >= GEOM.pocketOuter) {
    // Rolling resistance + air drag on the stationary bowl.
    const decel = r * (p.frictionA + p.dragB * omega * omega);
    if (speed > 1e-6) {
      const lim = Math.min(decel, speed / Math.max(p.dt, 1e-4)); // never reverse in one step
      ax -= (lim * vel.x) / speed;
      ay -= (lim * vel.y) / speed;
    }
  } else {
    // On the rotor: friction drags the ball toward the surface velocity.
    const sx = -rotorOmega * pos.y, sy = rotorOmega * pos.x;
    ax -= p.surfaceDrag * (vel.x - sx);
    ay -= p.surfaceDrag * (vel.y - sy);
  }
  return { x: ax, y: ay };
}

/**
 * Rim wall constraint, applied identically by every adapter: a polygonal rim
 * collider makes a fast ball "ghost-bounce" off segment joints (observed in
 * both engines), so the smooth circular wall is enforced directly instead:
 * position projected onto the wall and the outward radial velocity removed
 * (inelastic, frictionless).
 */
export function applyRimConstraint(pos: Vec, vel: Vec): { pos: Vec; vel: Vec; clamped: boolean } {
  const rMax = GEOM.rimR - GEOM.ballR;
  const r = Math.hypot(pos.x, pos.y);
  if (r <= rMax) return { pos, vel, clamped: false };
  const ux = pos.x / r, uy = pos.y / r;
  const vr = vel.x * ux + vel.y * uy;
  if (vr <= 0) return { pos: { x: ux * rMax, y: uy * rMax }, vel, clamped: true };
  // The outward component is a discretisation artefact of moving straight for
  // one step on a curved wall: turn the velocity along the wall keeping its
  // speed (projecting it away would add a spurious ω³·dt/2 deceleration).
  const tx = -uy, ty = ux;
  const vt = vel.x * tx + vel.y * ty;
  const speed = Math.hypot(vel.x, vel.y) * Math.sign(vt || 1);
  return { pos: { x: ux * rMax, y: uy * rMax }, vel: { x: speed * tx, y: speed * ty }, clamped: true };
}

/** Rim wall as a closed polyline (inner face at rimR). */
export function rimPolyline(segments = 240): Vec[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * 2 * Math.PI;
    return { x: GEOM.rimR * Math.cos(a), y: GEOM.rimR * Math.sin(a) };
  });
}

/** Deflector centres and orientations (stationary). */
export function deflectorPoses(p: SimParams): { x: number; y: number; angle: number }[] {
  const rnd = mulberry32((p.seed ^ 0x5bd1e995) >>> 0);
  return Array.from({ length: p.deflectors }, (_, k) => {
    const a = ((k + 0.5) / p.deflectors) * 2 * Math.PI + (rnd() - 0.5) * 0.01;
    // Alternate vertical/horizontal-ish diamonds as on real wheels.
    const tilt = k % 2 === 0 ? a : a + Math.PI / 2;
    return { x: GEOM.deflectorR * Math.cos(a), y: GEOM.deflectorR * Math.sin(a), angle: tilt };
  });
}

/**
 * Fret centres in the ROTOR frame. Pocket k is centred at angle −k·pitch
 * (the printed sequence runs clockwise); frets sit between pockets.
 */
export function fretPosesLocal(p: SimParams): { x: number; y: number; angle: number; halfLen: number }[] {
  const n = pocketCount(p.wheelType);
  const pitch = (2 * Math.PI) / n;
  const rMid = (GEOM.turretR + GEOM.fretOuter) / 2;
  const halfLen = (GEOM.fretOuter - GEOM.turretR) / 2;
  return Array.from({ length: n }, (_, k) => {
    const a = -(k + 0.5) * pitch;
    return { x: rMid * Math.cos(a), y: rMid * Math.sin(a), angle: a, halfLen };
  });
}

/** Pocket-sequence index under a ball at angle θ for a rotor at angle φ. */
export function pocketIndexAt(p: SimParams, theta: number, rotorAngle: number): number {
  const n = pocketCount(p.wheelType);
  const pitch = (2 * Math.PI) / n;
  const k = Math.round((rotorAngle - theta) / pitch);
  return ((k % n) + n) % n;
}

export function pocketAt(p: SimParams, index: number): number {
  return pocketOrder(p.wheelType)[index] ?? 0;
}

/** Initial ball state on the track (with seeded launch-speed noise). */
export function initialBall(p: SimParams): { pos: Vec; vel: Vec } {
  const rnd = mulberry32((p.seed * 2654435761) >>> 0);
  const g = Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  const w = Math.abs(p.ballOmega0) * (1 + p.launchNoise * g) * ballDir(p);
  const r = GEOM.rimR - GEOM.ballR - 1e-4;
  const a = p.launchAngle;
  return {
    pos: { x: r * Math.cos(a), y: r * Math.sin(a) },
    vel: { x: -w * r * Math.sin(a), y: w * r * Math.cos(a) },
  };
}

/** Tracks drop / rotor contact / settle events identically for every engine. */
export class EventTracker {
  dropTimeS: number | null = null;
  rotorContactTimeS: number | null = null;
  settleTimeS: number | null = null;
  finalIndex: number | null = null;
  private calmSince: number | null = null;
  readonly samples: SimSample[] = [];
  private nextSampleT = 0;

  constructor(
    private readonly p: SimParams,
    private readonly sampleEvery = 1 / 60,
  ) {}

  /** Returns true once the ball has settled. */
  observe(t: number, pos: Vec, vel: Vec): boolean {
    const r = Math.hypot(pos.x, pos.y);
    const omega = (pos.x * vel.y - pos.y * vel.x) / (r * r);
    const rot = rotorState(this.p, t);
    if (t >= this.nextSampleT) {
      this.samples.push({ t, x: pos.x, y: pos.y, r, ballOmega: omega, rotorAngle: rot.angle, rotorOmega: rot.omega });
      this.nextSampleT += this.sampleEvery;
    }
    if (this.dropTimeS === null && r < GEOM.trackInner) this.dropTimeS = t;
    if (this.rotorContactTimeS === null && r < GEOM.pocketOuter) this.rotorContactTimeS = t;
    if (this.rotorContactTimeS !== null && r < GEOM.pocketOuter && Math.abs(omega - rot.omega) < 0.15) {
      this.calmSince ??= t;
      if (t - this.calmSince >= 0.6) {
        this.settleTimeS = this.calmSince;
        this.finalIndex = pocketIndexAt(this.p, Math.atan2(pos.y, pos.x), rot.angle);
        this.samples.push({ t, x: pos.x, y: pos.y, r, ballOmega: omega, rotorAngle: rot.angle, rotorOmega: rot.omega });
        return true;
      }
    } else {
      this.calmSince = null;
    }
    return false;
  }
}
