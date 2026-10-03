/**
 * Common entry point for all simulation adapters. Engines run SEPARATELY on
 * identical parameters and are compared, never blended into one simulation.
 */
import type { BatchSummary, EngineId, SimParams, SimResult } from "@/types/simulation";
import { pocketCount } from "@/engine/wheel/layout";
import { mulberry32 } from "@/engine/math/random";
import { jensenShannon } from "@/engine/prediction/uncertaintyModel";
import { runKinematic } from "./trajectoryModel";

export const ENGINE_LABEL: Record<EngineId, string> = {
  kinematic: "Kinematic reference",
  rapier: "Rapier.js",
  matter: "Matter.js",
};

export async function runEngine(engine: EngineId, p: SimParams): Promise<SimResult> {
  try {
    switch (engine) {
      case "kinematic":
        return runKinematic(p);
      case "rapier":
        return await (await import("./rapierEngine")).runRapier(p);
      case "matter":
        return await (await import("./matterEngine")).runMatter(p);
    }
  } catch (err) {
    return {
      engine, params: p, ok: false,
      error: err instanceof Error ? err.message : String(err),
      samples: [], dropTimeS: null, rotorContactTimeS: null, settleTimeS: null,
      finalIndex: null, finalPocket: null, collisions: 0, wallMs: 0,
    };
  }
}

/** Parameters for run i of a batch: random launch/rotor phase and launch-speed noise (seeded). */
export function batchParams(base: SimParams, seed: number, i: number): SimParams {
  const r = mulberry32((seed * 0x9e3779b1 + i * 0x85ebca6b) >>> 0);
  return {
    ...base,
    seed: (seed + i * 7919) >>> 0,
    launchAngle: 2 * Math.PI * r(),
    rotorPhase: 2 * Math.PI * r(),
    launchNoise: Math.max(base.launchNoise, 0.03),
  };
}

export async function runBatch(
  engine: EngineId,
  base: SimParams,
  runs: number,
  seed: number,
  onProgress?: (done: number) => void,
): Promise<BatchSummary> {
  const t0 = performance.now();
  const n = pocketCount(base.wheelType);
  const counts = new Array<number>(n).fill(0);
  const drops: number[] = [];
  let settled = 0;
  for (let i = 0; i < runs; i++) {
    const res = await runEngine(engine, batchParams(base, seed, i));
    if (res.finalIndex !== null) {
      counts[res.finalIndex]! += 1;
      settled++;
    }
    if (res.dropTimeS !== null) drops.push(res.dropTimeS);
    onProgress?.(i + 1);
  }
  const mean = drops.length ? drops.reduce((a, b) => a + b, 0) / drops.length : null;
  const sd = drops.length > 1 && mean !== null ? Math.sqrt(drops.reduce((a, b) => a + (b - mean) ** 2, 0) / (drops.length - 1)) : null;
  return {
    engine,
    runs,
    settled,
    probs: counts.map((c) => (settled ? c / settled : 1 / n)),
    meanDropTimeS: mean,
    sdDropTimeS: sd,
    wallMs: performance.now() - t0,
  };
}

/** Jensen–Shannon divergence (bits) between engines' landing distributions. */
export function engineDisagreement(summaries: BatchSummary[]): number | null {
  const ok = summaries.filter((s) => s.settled > 0);
  if (ok.length < 2) return null;
  return jensenShannon(ok.map((s) => s.probs), ok.map(() => 1));
}
