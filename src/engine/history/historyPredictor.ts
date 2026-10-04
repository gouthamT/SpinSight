/**
 * "Next results" estimator from a list of past results.
 *
 * Four candidate models, each producing P(next pocket):
 *   uniform          – every pocket 1/N (true for a fair wheel)
 *   frequency        – Dirichlet(1) posterior of pocket frequencies (wheel bias)
 *   sequence-offset  – Dirichlet(1) posterior of the wheel-distance between
 *                      consecutive results (dealer/release signature)
 *   physics-release  – Monte Carlo physics kernel: ball released from the
 *                      previous result's pocket with the configured speeds,
 *                      deceleration, deflector and bounce assumptions
 *
 * Models are combined by Bayesian model averaging using their walk-forward
 * (prequential) likelihood on the user's own history: each result is scored
 * only by what the model would have predicted from EARLIER results. With no
 * real structure in the history the weight flows to "uniform" and the output
 * stays at the baseline: by design, not a bug.
 */
import { pocketCount, pocketOrder } from "@/engine/wheel/layout";
import type {
  HistoryModelId,
  HistoryModelReport,
  HistoryPrediction,
  HistorySettings,
  RankedPocket,
} from "@/types/history";
import type { WheelType } from "@/types/roulette";
import { releaseKernel, type ReleaseKernel } from "./physicsRelease";
import { chiSquareUniform } from "./stats";

/** Fixed seed for physics kernels: same settings → same kernel → cacheable. */
export const KERNEL_SEED = 20261004;
const kernelCache = new Map<string, ReleaseKernel>();

/** Quick-physics kernel, memoised per (wheel size, physics settings, sample count). */
export function cachedReleaseKernel(
  n: number,
  settings: HistorySettings,
): ReleaseKernel {
  const key = JSON.stringify([
    n,
    settings.physics,
    settings.simulations,
    settings.wheelDirection,
  ]);
  let k = kernelCache.get(key);
  if (!k) {
    k = releaseKernel(
      n,
      settings.physics,
      settings.simulations,
      KERNEL_SEED,
      null,
      settings.wheelDirection ??
        (settings.physics.ballDirection === "clockwise" ? 1 : -1),
    );
    if (kernelCache.size > 8) kernelCache.clear();
    kernelCache.set(key, k);
  }
  return k;
}

export const MIN_HISTORY_FOR_EVIDENCE = 20;

/**
 * Dirichlet prior strengths averaged over for the frequency and offset models.
 * α = 1 expects wild biases; larger α expects the mild ones real wheels have
 * (and learns them with far fewer spins). The history decides the mix.
 */
export const DIRICHLET_ALPHAS = [1, 5, 20, 80] as const;

/** Posterior weights over α from each α's running log-likelihood. */
function alphaWeights(ll: readonly number[]): number[] {
  const m = Math.max(...ll);
  const r = ll.map((l) => Math.exp(l - m));
  const z = r.reduce((a, b) => a + b, 0);
  return r.map((x) => x / z);
}

/** Predictive P(j) mixed over α: Σ_α w_α (c_j + α) / (total + Nα). */
function dirichletMix(c: readonly number[], total: number, ll: readonly number[]): number[] {
  const N = c.length;
  const w = alphaWeights(ll);
  return Array.from({ length: N }, (_, j) =>
    DIRICHLET_ALPHAS.reduce((acc, a, k) => acc + w[k]! * ((c[j]! + a) / (total + N * a)), 0),
  );
}

const LABELS: Record<HistoryModelId, string> = {
  uniform: "Uniform (fair wheel)",
  frequency: "Pocket frequency (wheel bias)",
  "sequence-offset": "Consecutive-result offset (release signature)",
  "physics-release": "Physics simulation (release from previous pocket)",
};

function topK(p: readonly number[], k: number): number[] {
  return p
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, k)
    .map((x) => x.i);
}

function verdictFor(
  n: number,
  e: number,
): { verdict: HistoryPrediction["verdict"]; text: string } {
  if (n < MIN_HISTORY_FOR_EVIDENCE)
    return {
      verdict: "insufficient-data",
      text: `Only ${n} result(s). At least ${MIN_HISTORY_FOR_EVIDENCE} are needed before any model can be compared with chance, and hundreds before a real bias could show. The ranking below is effectively random.`,
    };
  if (e < 2)
    return {
      verdict: "no-evidence",
      text: "No evidence that your history is anything other than random. The ranking below is indistinguishable from chance; every pocket remains ≈ equally likely.",
    };
  if (e < 6)
    return {
      verdict: "weak",
      text: "Weak evidence of structure, the kind that random history often shows by luck. Treat the ranking as noise unless it holds up over many more spins.",
    };
  if (e < 10)
    return {
      verdict: "moderate",
      text: "Moderate evidence of structure in this history. Check whether it persists on NEW results before trusting it; a wheel can also be re-levelled or changed.",
    };
  return {
    verdict: "strong",
    text: "Strong evidence of non-random structure in this history (e.g. a biased wheel). Verify on new results; past structure is not a guarantee of future results.",
  };
}

export function predictFromHistory(
  values: readonly number[],
  settings: HistorySettings,
  seed: number,
): HistoryPrediction {
  const t0 = performance.now();
  const type: WheelType = settings.wheelType;
  const order = pocketOrder(type);
  const N = pocketCount(type);
  const idxOf = new Map(order.map((p, i) => [p, i]));
  const idx = values
    .map((v) => idxOf.get(v))
    .filter((i): i is number => i !== undefined);
  const n = idx.length;

  const phys = cachedReleaseKernel(N, settings);
  const kPhys = phys.kernel.map((v) =>
    Math.max(v, 0.5 / Math.max(phys.simulations, 1)),
  ); // avoid log(0)
  const zPhys = kPhys.reduce((a, b) => a + b, 0);
  const kernel = kPhys.map((v) => v / zPhys);
  const anchorIndex = settings.startingPointIndex ?? (n ? idx[n - 1]! : null);

  // ---- walk-forward evaluation over the history ---------------------------
  const counts = new Array<number>(N).fill(0);
  const offCounts = new Array<number>(N).fill(0);
  let offN = 0;
  // Running log-likelihood of each α (prior over α is uniform).
  const freqLL = DIRICHLET_ALPHAS.map(() => 0);
  const offLL = DIRICHLET_ALPHAS.map(() => 0);
  const ids: HistoryModelId[] = [
    "uniform",
    "frequency",
    "sequence-offset",
    "physics-release",
  ];
  const L: Record<HistoryModelId, number> = {
    uniform: 0,
    frequency: 0,
    "sequence-offset": 0,
    "physics-release": 0,
  };
  const hits: Record<HistoryModelId, number> = {
    uniform: 0,
    frequency: 0,
    "sequence-offset": 0,
    "physics-release": 0,
  };
  let scored = 0;

  const predictAt = (
    id: HistoryModelId,
    prev: number | null,
    total: number,
  ): number[] => {
    switch (id) {
      case "uniform":
        return new Array<number>(N).fill(1 / N);
      case "frequency":
        return dirichletMix(counts, total, freqLL);
      case "sequence-offset":
        if (prev === null) return new Array<number>(N).fill(1 / N);
        {
          const mix = dirichletMix(offCounts, offN, offLL);
          return Array.from({ length: N }, (_, j) => mix[(j - prev + N) % N]!);
        }
      case "physics-release":
        if (prev === null && settings.startingPointIndex === null)
          return new Array<number>(N).fill(1 / N);
        const base = settings.startingPointIndex ?? prev;
        if (base === null) return new Array<number>(N).fill(1 / N);
        return Array.from({ length: N }, (_, j) => kernel[(j - base + N) % N]!);
    }
  };

  for (let t = 0; t < n; t++) {
    const cur = idx[t]!;
    const prev = t > 0 ? idx[t - 1]! : null;
    if (prev !== null) {
      // Score every model on result t using only results < t.
      for (const id of ids) {
        const p = predictAt(id, prev, t);
        L[id] += Math.log(p[cur]!);
        if (topK(p, Math.min(10, N)).includes(cur)) hits[id]++;
      }
      scored++;
      const d = (cur - prev + N) % N;
      DIRICHLET_ALPHAS.forEach((a, k) => (offLL[k]! += Math.log((offCounts[d]! + a) / (offN + N * a))));
      offCounts[d]! += 1;
      offN++;
    }
    DIRICHLET_ALPHAS.forEach((a, k) => (freqLL[k]! += Math.log((counts[cur]! + a) / (t + N * a))));
    counts[cur]! += 1;
  }

  // ---- model averaging -----------------------------------------------------
  const maxL = Math.max(...ids.map((id) => L[id]));
  const raw = ids.map((id) => Math.exp(L[id] - maxL));
  const z = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((r) => r / z);
  const last = n ? idx[n - 1]! : null;
  const nextDists = ids.map((id) => predictAt(id, anchorIndex, n));
  const probs = new Array<number>(N).fill(0);
  nextDists.forEach((d, k) =>
    d.forEach((v, j) => (probs[j]! += weights[k]! * v)),
  );

  // Standard error: physics MC error and frequency/offset posterior spread, weighted.
  const se = probs.map((_, j) => {
    const fP = nextDists[1]![j]!;
    const oP = nextDists[2]![j]!;
    const seF = Math.sqrt((fP * (1 - fP)) / (n + N + 1));
    const seO = Math.sqrt((oP * (1 - oP)) / (offN + N + 1));
    const seP =
      anchorIndex === null ? 0 : phys.stdError[(j - anchorIndex + N) % N]!;
    return Math.sqrt(
      (weights[1]! * seF) ** 2 +
        (weights[2]! * seO) ** 2 +
        (weights[3]! * seP) ** 2,
    );
  });

  const ranked: RankedPocket[] = topK(probs, N).map((i, r) => ({
    rank: r + 1,
    pocket: order[i]!,
    probability: probs[i]!,
    stdError: se[i]!,
  }));
  const top10 = ranked.slice(0, Math.min(10, N));
  const evidence =
    2 *
    (Math.max(L.frequency, L["sequence-offset"], L["physics-release"]) -
      L.uniform);
  const v = verdictFor(n, n >= MIN_HISTORY_FOR_EVIDENCE ? evidence : 0);

  const models: HistoryModelReport[] = ids.map((id, k) => ({
    id,
    label: LABELS[id],
    weight: weights[k]!,
    logLoss: scored ? -L[id] / scored : null,
    top10Rate: scored ? hits[id] / scored : null,
    probs: nextDists[k]!,
  }));

  return {
    createdAt: new Date().toISOString(),
    seed,
    wheelType: type,
    historyLength: n,
    lastResult: last === null ? null : order[last]!,
    simulations: phys.simulations,
    probs,
    ranked,
    top10,
    top10Mass: top10.reduce((a, r) => a + r.probability, 0),
    baseline: 1 / N,
    models,
    chiSquare: n >= N ? chiSquareUniform(counts) : null,
    evidence2LnBF: evidence,
    verdict: v.verdict,
    verdictText: v.text,
    settings,
    elapsedMs: performance.now() - t0,
  };
}
