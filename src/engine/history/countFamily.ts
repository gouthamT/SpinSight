/**
 * A family of Dirichlet count models over the N pockets in WHEEL ORDER, mixed
 * by their own walk-forward likelihood (Bayesian model averaging inside the
 * family). Each member differs in three ways:
 *
 *   α (prior strength)   1 … 80   how big a deviation from uniform it expects
 *   h (sector width)     0 … 2    pools counts with up to h neighbours on each
 *                                 side, since physical bias (a tilted wheel, a
 *                                 loose fret) favours a SECTOR, not one pocket
 *   λ (memory)           1, .995, .98   1 = all spins count equally; < 1 lets
 *                                 old spins fade so a dealer or wheel change is
 *                                 followed
 *
 * Members that do not fit the history lose weight automatically, so on a fair
 * wheel the family stays close to uniform.
 */
export const FAMILY_ALPHAS = [1, 5, 20, 80] as const;
export const FAMILY_WIDTHS = [0, 1, 2] as const;
export const FAMILY_MEMORY = [1, 0.995, 0.98] as const;
/**
 * Prior weight of each width / memory value. Plain whole-history counting is
 * favoured; sectors and fading memory must earn their weight from the data,
 * which stops them winning on lucky streaks.
 */
const WIDTH_PRIOR = [0.6, 0.25, 0.15] as const;
const MEMORY_PRIOR = [0.8, 0.12, 0.08] as const;

interface Member {
  alpha: number;
  width: number;
  memory: number;
}

export class CountFamily {
  readonly n: number;
  private readonly members: Member[] = [];
  /** Decayed counts and totals, one per memory value. */
  private readonly counts: Float64Array[];
  private readonly totals: number[];
  private readonly ll: Float64Array;

  constructor(n: number) {
    this.n = n;
    for (const memory of FAMILY_MEMORY)
      for (const width of FAMILY_WIDTHS)
        for (const alpha of FAMILY_ALPHAS) this.members.push({ alpha, width, memory });
    this.counts = FAMILY_MEMORY.map(() => new Float64Array(n));
    this.totals = FAMILY_MEMORY.map(() => 0);
    this.ll = Float64Array.from(this.members, (m) =>
      Math.log(
        WIDTH_PRIOR[FAMILY_WIDTHS.indexOf(m.width as (typeof FAMILY_WIDTHS)[number])]! *
          MEMORY_PRIOR[FAMILY_MEMORY.indexOf(m.memory as (typeof FAMILY_MEMORY)[number])]!,
      ),
    );
  }

  /** Predictive distribution of each member (rows) for the next observation. */
  private memberPredictions(): Float64Array[] {
    const n = this.n;
    // Smoothed counts per (memory, width), shared by all α.
    const smoothed = new Map<string, Float64Array>();
    const out: Float64Array[] = [];
    for (const m of this.members) {
      const mi = FAMILY_MEMORY.indexOf(m.memory as (typeof FAMILY_MEMORY)[number]);
      const key = `${mi}:${m.width}`;
      let s = smoothed.get(key);
      if (!s) {
        const c = this.counts[mi]!;
        s = new Float64Array(n);
        if (m.width === 0) s.set(c);
        else {
          let wsum = 0;
          for (let k = -m.width; k <= m.width; k++) wsum += m.width + 1 - Math.abs(k);
          for (let j = 0; j < n; j++) {
            let v = 0;
            for (let k = -m.width; k <= m.width; k++) v += (m.width + 1 - Math.abs(k)) * c[(j + k + n) % n]!;
            s[j] = v / wsum;
          }
        }
        smoothed.set(key, s);
      }
      const total = this.totals[mi]!;
      const p = new Float64Array(n);
      for (let j = 0; j < n; j++) p[j] = (s[j]! + m.alpha) / (total + n * m.alpha);
      out.push(p);
    }
    return out;
  }

  private weights(): number[] {
    let mx = -Infinity;
    for (const v of this.ll) mx = Math.max(mx, v);
    const w = Array.from(this.ll, (v) => Math.exp(v - mx));
    const z = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / z);
  }

  /** Family predictive distribution (members weighted by their walk-forward fit). */
  predict(): number[] {
    const preds = this.memberPredictions();
    const w = this.weights();
    const out = new Array<number>(this.n).fill(0);
    preds.forEach((p, i) => {
      const wi = w[i]!;
      for (let j = 0; j < this.n; j++) out[j]! += wi * p[j]!;
    });
    return out;
  }

  /** Score x against every member (before learning it), then learn it. */
  observe(x: number): void {
    const preds = this.memberPredictions();
    preds.forEach((p, i) => (this.ll[i]! += Math.log(p[x]!)));
    FAMILY_MEMORY.forEach((lam, mi) => {
      const c = this.counts[mi]!;
      if (lam < 1) for (let j = 0; j < this.n; j++) c[j]! *= lam;
      c[x]! += 1;
      this.totals[mi] = this.totals[mi]! * lam + 1;
    });
  }

  /** Effective number of observations behind the dominant member (for error bars). */
  effectiveCount(): number {
    const w = this.weights();
    let best = 0;
    for (let i = 1; i < w.length; i++) if (w[i]! > w[best]!) best = i;
    const mi = FAMILY_MEMORY.indexOf(this.members[best]!.memory as (typeof FAMILY_MEMORY)[number]);
    return this.totals[mi]!;
  }

  /** The member carrying the most weight (for display/debugging). */
  dominant(): Member & { weight: number } {
    const w = this.weights();
    let best = 0;
    for (let i = 1; i < w.length; i++) if (w[i]! > w[best]!) best = i;
    return { ...this.members[best]!, weight: w[best]! };
  }
}
