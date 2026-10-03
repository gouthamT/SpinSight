/**
 * Physics Monte Carlo for a spin whose ball is released from where the
 * PREVIOUS result landed (the only physical link between consecutive spins
 * when no speeds are measured). Each run samples launch speeds, the drop
 * speed, deflector strikes and fret bounces from the configured assumptions,
 * integrates the ball's deceleration law dω/dt = −(a + bω²) and the rotor's
 * slow-down in closed form, and records how many pockets the result moved
 * relative to the previous one.
 *
 * Output: a kernel K[d] = P(next index = previous index + d). With realistic
 * spreads in launch speed (a few percent over ~100 rad of relative travel)
 * this kernel is close to uniform; it only concentrates if a dealer is
 * implausibly consistent. That is the honest physics.
 */
import type { PhysicsSettings } from "@/types/history";
import { mulberry32 } from "@/engine/math/random";
import { thetaAt, timeToOmega } from "@/engine/physics/decelerationModel";
import { gaussian } from "@/engine/prediction/uncertaintyModel";

export const DEFAULT_PHYSICS: PhysicsSettings = {
  ballOmegaMean: 15,
  ballOmegaSd: 0.6,
  rotorOmegaMean: 2.2,
  rotorOmegaSd: 0.25,
  rotorDecel: 0.035,
  frictionA: 0.3,
  dragB: 0.011,
  dropOmegaMean: 5.0,
  dropOmegaSd: 0.2,
  releaseJitterPockets: 3,
  deflectorHitProb: 0.7,
  deflectorKickMean: 2,
  deflectorKickSd: 4,
  bounceMean: 6,
  bounceSd: 5,
  ballDirection: "clockwise",
};

export interface ReleaseKernel {
  kernel: number[];
  /** Monte Carlo standard error per bin. */
  stdError: number[];
  simulations: number;
  /** Mean ball-relative-to-rotor travel before the drop (pockets). */
  meanTravelPockets: number;
  sdTravelPockets: number;
  meanDropTimeS: number;
}

export function releaseKernel(n: number, p: PhysicsSettings, simulations: number, seed: number): ReleaseKernel {
  const rnd = mulberry32(seed);
  const counts = new Float64Array(n);
  const sign = p.ballDirection === "clockwise" ? 1 : -1; // printed sequence runs clockwise
  const law = { a: Math.max(p.frictionA, 1e-4), b: Math.max(p.dragB, 1e-6) };
  let st = 0, st2 = 0, sT = 0, used = 0;
  for (let s = 0; s < simulations; s++) {
    const wc = Math.max(0.5, p.dropOmegaMean + p.dropOmegaSd * gaussian(rnd));
    const wb = p.ballOmegaMean + p.ballOmegaSd * gaussian(rnd);
    if (wb <= wc + 0.1) continue;
    const T = timeToOmega(law, wb, wc);
    if (!Number.isFinite(T) || T > 120) continue;
    const ballTravel = thetaAt(law, 0, wb, T); // rad, positive
    const wr = Math.max(0, p.rotorOmegaMean + p.rotorOmegaSd * gaussian(rnd));
    const tStop = p.rotorDecel > 0 ? wr / p.rotorDecel : Infinity;
    const tr = Math.min(T, tStop);
    const rotorTravel = wr * tr - 0.5 * p.rotorDecel * tr * tr;
    // Ball and rotor turn in opposite directions: relative travel adds.
    const travelPockets = ((ballTravel + rotorTravel) * n) / (2 * Math.PI);
    let offset = travelPockets + p.releaseJitterPockets * gaussian(rnd);
    if (rnd() < p.deflectorHitProb) offset += p.deflectorKickMean + p.deflectorKickSd * gaussian(rnd);
    offset += Math.max(0, p.bounceMean + p.bounceSd * gaussian(rnd));
    const d = ((Math.round(sign * offset) % n) + n) % n;
    counts[d]! += 1;
    st += travelPockets;
    st2 += travelPockets * travelPockets;
    sT += T;
    used++;
  }
  const kernel = Array.from(counts, (c) => (used ? c / used : 1 / n));
  const mean = used ? st / used : 0;
  return {
    kernel,
    stdError: kernel.map((q) => (used ? Math.sqrt((q * (1 - q)) / used) : 0)),
    simulations: used,
    meanTravelPockets: mean,
    sdTravelPockets: used ? Math.sqrt(Math.max(0, st2 / used - mean * mean)) : 0,
    meanDropTimeS: used ? sT / used : 0,
  };
}
