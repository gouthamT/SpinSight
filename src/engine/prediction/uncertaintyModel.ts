/** Probability helpers shared by the prediction models (all pure, deterministic). */

/** Standard normal via Box–Muller from a seeded uniform source. */
export function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Pair of correlated standard normals with correlation ρ. */
export function correlatedPair(rnd: () => number, rho: number): [number, number] {
  const z1 = gaussian(rnd);
  const z2 = gaussian(rnd);
  const r = Math.max(-0.999, Math.min(0.999, Number.isFinite(rho) ? rho : 0));
  return [z1, r * z1 + Math.sqrt(1 - r * r) * z2];
}

/** Wrap a continuous ring index into [0, n). */
export function wrapIndex(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/** Signed shortest ring distance a − b in (−n/2, n/2]. */
export function ringDiff(a: number, b: number, n: number): number {
  let d = wrapIndex(a - b, n);
  if (d > n / 2) d -= n;
  return d;
}

/** Histogram continuous ring positions into n bins with linear interpolation. */
export function ringHistogram(samples: ArrayLike<number>, n: number, weights?: ArrayLike<number>): number[] {
  const h = new Array<number>(n).fill(0);
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const w = weights ? weights[i]! : 1;
    const x = wrapIndex(samples[i]!, n);
    const lo = Math.floor(x);
    const f = x - lo;
    h[lo % n]! += w * (1 - f);
    h[(lo + 1) % n]! += w * f;
    total += w;
  }
  return total > 0 ? h.map((v) => v / total) : uniform(n);
}

export function uniform(n: number): number[] {
  return new Array<number>(n).fill(1 / n);
}

export function normalise(p: number[]): number[] {
  const s = p.reduce((a, b) => a + b, 0);
  return s > 0 ? p.map((v) => v / s) : uniform(p.length);
}

/** Circular convolution: out[j] = Σ_d p[j − d] · k[d]. */
export function circularConvolve(p: readonly number[], k: readonly number[]): number[] {
  const n = p.length;
  const out = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let d = 0; d < n; d++) s += p[(j - d + n) % n]! * k[d]!;
    out[j] = s;
  }
  return out;
}

/** Mix distributions with weights (weights normalised). */
export function mixture(dists: readonly number[][], weights: readonly number[]): number[] {
  const n = dists[0]?.length ?? 0;
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = new Array<number>(n).fill(0);
  dists.forEach((d, i) => {
    const w = weights[i]! / wsum;
    for (let j = 0; j < n; j++) out[j]! += w * d[j]!;
  });
  return out;
}

export function entropyBits(p: readonly number[]): number {
  let h = 0;
  for (const v of p) if (v > 0) h -= v * Math.log2(v);
  return h;
}

/** Generalised Jensen–Shannon divergence (bits) of weighted distributions. */
export function jensenShannon(dists: readonly number[][], weights: readonly number[]): number {
  if (dists.length < 2) return 0;
  const m = mixture(dists, weights);
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  let h = 0;
  dists.forEach((d, i) => (h += (weights[i]! / wsum) * entropyBits(d)));
  return Math.max(0, entropyBits(m) - h);
}

/** Circular mean and SD of ring positions (in index units). */
export function ringMeanSd(samples: ArrayLike<number>, n: number): { mean: number; sd: number } {
  let c = 0,
    s = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = (2 * Math.PI * samples[i]!) / n;
    c += Math.cos(a);
    s += Math.sin(a);
  }
  c /= samples.length || 1;
  s /= samples.length || 1;
  const R = Math.min(1, Math.hypot(c, s));
  const mean = wrapIndex((Math.atan2(s, c) * n) / (2 * Math.PI), n);
  const sdRad = R > 1e-9 ? Math.sqrt(-2 * Math.log(R)) : Infinity;
  return { mean, sd: (sdRad * n) / (2 * Math.PI) };
}

export function meanSd(xs: ArrayLike<number>): { mean: number; sd: number } {
  let m = 0;
  for (let i = 0; i < xs.length; i++) m += xs[i]!;
  m /= xs.length || 1;
  let v = 0;
  for (let i = 0; i < xs.length; i++) v += (xs[i]! - m) ** 2;
  return { mean: m, sd: Math.sqrt(v / Math.max(1, xs.length - 1)) };
}
