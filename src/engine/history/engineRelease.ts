/**
 * Physics-engine views for the next spin: the ball is launched from where the
 * previous result landed and each engine (kinematic reference, Rapier.js,
 * Matter.js) simulates the whole spin (track, drop, deflectors, frets, long
 * rolls) until the ball settles in a number. Launch speeds, wheel speed and
 * drop speed are sampled from the settings, so each view is a landing
 * distribution from SIMULATION ONLY (not validated against the history).
 */
import type { EngineKernel, EngineView, HistorySettings } from "@/types/history";
import type { SimParams } from "@/types/simulation";
import { mulberry32 } from "@/engine/math/random";
import { pocketCount, pocketOrder } from "@/engine/wheel/layout";
import { DEFAULT_SIM_PARAMS, G, GEOM } from "@/engine/physics/rouletteScene";
import { runEngine } from "@/engine/physics/simulationAdapter";
import { gaussian } from "@/engine/prediction/uncertaintyModel";

/** Track incline that makes the ball leave the track at |ω| = ωc. */
export function inclineForDropSpeed(omegaC: number): number {
  const r = GEOM.rimR - GEOM.ballR;
  return (Math.atan((omegaC * omegaC * r) / G) * 180) / Math.PI;
}

export const LONG_ROLL_S = 2.5;

export function engineRunParams(settings: HistorySettings, lastIndex: number | null, seed: number, i: number): SimParams {
  const ph = settings.physics;
  const rnd = mulberry32((seed * 0x9e3779b1 + i * 0x85ebca6b) >>> 0);
  const n = pocketCount(settings.wheelType);
  const pitch = (2 * Math.PI) / n;
  // Rotor zero at angle 0 at launch; pocket k sits at −k·pitch. The ball is
  // released where the previous result is (± jitter), or anywhere if unknown.
  const base = lastIndex === null ? 2 * Math.PI * rnd() : -lastIndex * pitch;
  const launchAngle = base + ph.releaseJitterPockets * pitch * gaussian(rnd);
  const omegaC = Math.max(1, ph.dropOmegaMean + ph.dropOmegaSd * gaussian(rnd));
  return {
    ...DEFAULT_SIM_PARAMS,
    wheelType: settings.wheelType,
    ballDirection: ph.ballDirection,
    ballOmega0: Math.max(omegaC + 1, ph.ballOmegaMean + ph.ballOmegaSd * gaussian(rnd)),
    rotorOmega0: Math.max(0, ph.rotorOmegaMean + ph.rotorOmegaSd * gaussian(rnd)),
    rotorDecel: ph.rotorDecel,
    frictionA: ph.frictionA,
    dragB: ph.dragB,
    trackInclineDeg: inclineForDropSpeed(omegaC),
    // The cone below the track must be steeper than the track, or the ball circles it.
    coneInclineDeg: Math.min(70, Math.max(DEFAULT_SIM_PARAMS.coneInclineDeg, inclineForDropSpeed(omegaC) + 15)),
    launchAngle,
    rotorPhase: 0,
    launchNoise: 0,
    seed: (seed + i * 7919) >>> 0,
    dt: 1 / 360,
    maxTimeS: 60,
  };
}

/**
 * Rotation-invariant engine kernel: K[d] = P(next = previous + d pockets).
 * Each run launches from a random start pocket s (seeded) and records the
 * landing offset (final − s). Because only the offset is kept, one kernel
 * serves every "last result", so it is computed ONCE per settings (and can be
 * cached) and each guess is then instant: P(j | last L) = K[(j − L) mod N].
 * The fixed deflector positions break the symmetry only slightly; random start
 * pockets average that out.
 */

/** Cache key: everything that changes an engine's kernel. */
export function kernelKey(engine: EngineView["engine"], settings: HistorySettings, seed: number): string {
  return JSON.stringify({ v: 2, engine, w: settings.wheelType, p: settings.physics, n: settings.engineRuns[engine], seed });
}

export async function engineKernel(
  engine: EngineView["engine"],
  settings: HistorySettings,
  seed: number,
  onProgress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<EngineKernel> {
  const t0 = performance.now();
  const n = pocketCount(settings.wheelType);
  const runs = Math.max(1, settings.engineRuns[engine]);
  const offsetCounts = new Array<number>(n).fill(0);
  const pick = mulberry32((seed ^ 0x27d4eb2d) >>> 0);
  let settled = 0, longRolls = 0, sumDrop = 0, nDrop = 0, sumSettle = 0;
  let error: string | null = null;
  for (let i = 0; i < runs; i++) {
    if (i % 5 === 4) {
      await new Promise((res) => setTimeout(res, 0));
      if (cancelled?.()) break;
    }
    const start = Math.floor(pick() * n);
    const r = await runEngine(engine, engineRunParams(settings, start, seed, i));
    if (r.error && !r.ok && r.samples.length === 0) {
      error = r.error; // engine unavailable (e.g. package not installed)
      break;
    }
    if (r.finalIndex !== null) {
      offsetCounts[(((r.finalIndex - start) % n) + n) % n]! += 1;
      settled++;
      sumSettle += r.settleTimeS ?? 0;
    }
    if (r.dropTimeS !== null) {
      sumDrop += r.dropTimeS;
      nDrop++;
    }
    if (r.settleTimeS !== null && r.dropTimeS !== null && r.settleTimeS - r.dropTimeS >= LONG_ROLL_S) longRolls++;
    onProgress?.(i + 1, runs);
  }
  return {
    engine,
    key: kernelKey(engine, settings, seed),
    runs,
    settled,
    offsetCounts,
    longRollShare: runs ? longRolls / runs : 0,
    meanDropS: nDrop ? sumDrop / nDrop : null,
    meanSettleS: settled ? sumSettle / settled : null,
    elapsedMs: performance.now() - t0,
    error,
  };
}

/** Instant view for the next spin given the last result (pure arithmetic, no simulation). */
export function viewFromKernel(k: EngineKernel, values: readonly number[], wheelType: HistorySettings["wheelType"]): EngineView {
  const order = pocketOrder(wheelType);
  const n = order.length;
  const last = values.length ? values[values.length - 1]! : null;
  const L = last === null ? null : order.indexOf(last);
  const total = k.offsetCounts.reduce((a, b) => a + b, 0);
  // Unknown last result: average over all start pockets → uniform.
  const probs = Array.from({ length: n }, (_, j) =>
    L === null || L < 0 || !total ? 1 / n : k.offsetCounts[(((j - L) % n) + n) % n]! / total,
  );
  const ranked = probs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x, r) => ({
      rank: r + 1,
      pocket: order[x.i]!,
      probability: x.p,
      stdError: total ? Math.sqrt((x.p * (1 - x.p)) / total) : 0,
    }));
  return {
    engine: k.engine,
    runs: k.runs,
    settled: k.settled,
    probs,
    ranked,
    meanDropS: k.meanDropS,
    meanSettleS: k.meanSettleS,
    longRollShare: k.longRollShare,
    lastResult: last,
    elapsedMs: k.elapsedMs,
    error: k.error,
  };
}

export async function engineView(
  engine: EngineView["engine"],
  values: readonly number[],
  settings: HistorySettings,
  seed: number,
  onProgress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
): Promise<EngineView> {
  return viewFromKernel(await engineKernel(engine, settings, seed, onProgress, cancelled), values, settings.wheelType);
}
