/**
 * Per-wheel learned parameters, built ONLY from completed spins observed
 * earlier (chronological by construction):
 *   ω_c      – |ω| of the ball when it leaves the track
 *   scatter  – how far (in pockets, along the ball's travel relative to the
 *              rotor) the ball ends up from the pocket it dropped over
 *
 * Before any spins are observed, ω_c comes from track geometry
 * (ω_c² = g·tanδ / R, the speed at which the centripetal requirement falls
 * below the inward pull of the inclined track) and the scatter is uniform,
 * i.e. the landing prediction equals the 1/N baseline. Real and synthetic
 * spins are kept in separate profiles.
 */
import type { SpinObservation, WheelProfile, WheelProfileSummary } from "@/types/roulette";
import { meanSd, ringMeanSd, uniform, wrapIndex } from "./uncertaintyModel";

export const G = 9.80665;
/** Pseudo-count of the uniform prior in the scatter model. */
export const SCATTER_PRIOR_SPINS = 8;

export function newProfile(key: string): WheelProfile {
  return { key, version: 1, trackRadiusM: 0.4, trackInclineDeg: 30, observations: [] };
}

export function geometryOmegaCritical(p: WheelProfile): number {
  return Math.sqrt((G * Math.tan((p.trackInclineDeg * Math.PI) / 180)) / p.trackRadiusM);
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

export function omegaCritical(p: WheelProfile): { mean: number; sd: number; source: "geometry-default" | "learned" } {
  const obs = p.observations.map((o) => o.omegaAtDrop).filter((w) => Number.isFinite(w) && w > 0);
  if (!obs.length) {
    const w = geometryOmegaCritical(p);
    return { mean: w, sd: 0.25 * w, source: "geometry-default" };
  }
  const med = median(obs);
  const { sd } = meanSd(obs);
  // Small samples: keep a 10 % floor on the spread.
  const s = obs.length >= 5 ? Math.max(sd, 0.03 * med) : Math.max(sd || 0, 0.1 * med);
  return { mean: med, sd: s, source: "learned" };
}

/**
 * Scatter kernel over integer offsets d = 0..n−1 (pockets ALONG travel):
 * a mixture of the uniform prior (weight k/(k+m)) and a von Mises kernel
 * density of the observed offsets.
 */
export function scatterKernel(p: WheelProfile, n: number): { kernel: number[]; priorWeight: number } {
  const offs = p.observations.map((o) => o.offsetAlongTravel);
  const m = offs.length;
  const priorWeight = SCATTER_PRIOR_SPINS / (SCATTER_PRIOR_SPINS + m);
  if (!m) return { kernel: uniform(n), priorWeight: 1 };
  const { sd } = ringMeanSd(offs, n);
  const spread = Number.isFinite(sd) ? sd : n / 4;
  const h = Math.max(0.8, 1.06 * spread * Math.pow(m, -0.2));
  const sigmaRad = (2 * Math.PI * h) / n;
  const kappa = 1 / (sigmaRad * sigmaRad);
  const kde = new Array<number>(n).fill(0);
  for (let d = 0; d < n; d++) {
    let s = 0;
    for (const o of offs) s += Math.exp(kappa * (Math.cos((2 * Math.PI * (d - o)) / n) - 1));
    kde[d] = s;
  }
  const z = kde.reduce((a, b) => a + b, 0);
  const kernel = kde.map((v) => priorWeight / n + (1 - priorWeight) * (v / z));
  return { kernel, priorWeight };
}

/** Re-express an along-travel kernel in sequence-index offsets for a given travel sign. */
export function kernelForIndex(kernelAlongTravel: readonly number[], travelIndexSign: 1 | -1): number[] {
  const n = kernelAlongTravel.length;
  return kernelAlongTravel.map((_, d) => kernelAlongTravel[wrapIndex(travelIndexSign * d, n)]!);
}

export function summarise(p: WheelProfile, n: number): WheelProfileSummary {
  const w = omegaCritical(p);
  const { priorWeight } = scatterKernel(p, n);
  return {
    key: p.key,
    spins: p.observations.length,
    omegaCritical: w.mean,
    omegaCriticalSd: w.sd,
    omegaCriticalSource: w.source,
    scatterPriorWeight: priorWeight,
    scatterSource: p.observations.length ? "learned" : "uniform-prior",
  };
}

export function addObservation(p: WheelProfile, o: SpinObservation, maxKeep = 2000): WheelProfile {
  const observations = [...p.observations, o].slice(-maxKeep);
  return { ...p, observations };
}
