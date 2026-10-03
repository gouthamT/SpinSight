/**
 * Model C (stochastic landing): turn a cloud of drop positions into landing
 * probabilities by circular convolution with the learned scatter kernel.
 */
import type { DropModelOutput } from "@/types/roulette";
import type { DropProjection } from "./dropProjector";
import { circularConvolve, meanSd, normalise, ringHistogram, ringMeanSd } from "./uncertaintyModel";

export function toModelOutput(
  proj: DropProjection,
  nowMs: number,
  n: number,
  scatterIndexKernel: readonly number[],
  weight: number,
): DropModelOutput | null {
  if (proj.dropIndex.length < 20) return null;
  const dropProbs = ringHistogram(proj.dropIndex, n);
  const probs = normalise(circularConvolve(dropProbs, scatterIndexKernel));
  const t = meanSd(proj.tDrop);
  const ring = ringMeanSd(proj.dropIndex, n);
  return {
    id: proj.id,
    weight,
    tDropMs: nowMs + t.mean * 1000,
    sdDropMs: t.sd * 1000,
    dropIndexMean: ring.mean,
    dropIndexSd: ring.sd,
    dropProbs,
    probs,
  };
}

/** Landing distribution when the drop position is OBSERVED (lock rule "drop"). */
export function observedDropOutput(
  dropIndex: number,
  sdPockets: number,
  nowMs: number,
  n: number,
  scatterIndexKernel: readonly number[],
): DropModelOutput {
  const samples: number[] = [];
  for (let k = -40; k <= 40; k++) samples.push(dropIndex + (k / 40) * 3 * sdPockets);
  const w = samples.map((x) => Math.exp(-0.5 * ((x - dropIndex) / sdPockets) ** 2));
  const dropProbs = ringHistogram(samples, n, w);
  return {
    id: "deceleration",
    weight: 1,
    tDropMs: nowMs,
    sdDropMs: 0,
    dropIndexMean: dropIndex,
    dropIndexSd: sdPockets,
    dropProbs,
    probs: normalise(circularConvolve(dropProbs, scatterIndexKernel)),
  };
}
