import type { WheelType } from "./roulette";

/**
 * Simulation Lab types. Simulations are SIMULATED ESTIMATES: simplified 2-D
 * top-down models of a 3-D wheel. They are never presented as measurements or
 * as calibrated predictions of a real wheel.
 */

export type EngineId = "kinematic" | "rapier" | "matter";

export interface SimParams {
  wheelType: WheelType;
  /** Ball angular speed at launch (rad/s, positive number). */
  ballOmega0: number;
  ballDirection: "clockwise" | "counter-clockwise";
  /** Rotor angular speed (rad/s, positive number); turns opposite to the ball. */
  rotorOmega0: number;
  rotorDecel: number; // rad/s²
  /** Ball-on-track law dω/dt = −(a + bω²). */
  frictionA: number;
  dragB: number;
  /** Ball-track inclination (deg). Sets the drop speed: ω_c² = g·tanδ / r. */
  trackInclineDeg: number;
  /** Inclination of the cone/rotor toward the pockets (deg). */
  coneInclineDeg: number;
  /** Coefficient of restitution for deflectors and frets. */
  restitution: number;
  /** Coulomb friction coefficient for contacts. */
  contactFriction: number;
  /** How quickly the rotor surface drags the ball along (1/s). */
  surfaceDrag: number;
  /** Number of deflectors (diamonds) on the cone. */
  deflectors: number;
  /** Ball launch angle (rad, wheel frame) and rotor zero angle at t = 0. */
  launchAngle: number;
  rotorPhase: number;
  /** Random perturbation seed (deflector jitter, launch noise). */
  seed: number;
  /** Small random launch-speed noise (fraction of ω0, SD). */
  launchNoise: number;
  dt: number; // s
  maxTimeS: number;
}

export interface SimSample {
  t: number;
  /** Ball position in metres (wheel centre = origin, y up). */
  x: number;
  y: number;
  r: number;
  ballOmega: number; // rad/s about the centre
  rotorAngle: number; // rad
  rotorOmega: number;
}

export interface SimResult {
  engine: EngineId;
  params: SimParams;
  ok: boolean;
  error: string | null;
  /** Decimated trajectory for replay/plots. */
  samples: SimSample[];
  dropTimeS: number | null;
  rotorContactTimeS: number | null;
  settleTimeS: number | null;
  finalIndex: number | null;
  finalPocket: number | null;
  collisions: number;
  wallMs: number;
}

export interface BatchSummary {
  engine: EngineId;
  runs: number;
  settled: number;
  /** Landing distribution per pocket-sequence index. */
  probs: number[];
  meanDropTimeS: number | null;
  sdDropTimeS: number | null;
  wallMs: number;
}

export type SimWorkerRequest =
  | { type: "single"; engines: EngineId[]; params: SimParams }
  | { type: "batch"; engines: EngineId[]; params: SimParams; runs: number; seed: number };

export type SimWorkerResponse =
  | { type: "single"; results: SimResult[] }
  | { type: "progress"; engine: EngineId; done: number; total: number }
  | { type: "batch"; summaries: BatchSummary[]; disagreement: number | null }
  | { type: "error"; message: string };
