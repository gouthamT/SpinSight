import { predictFromHistory } from "@/engine/history/historyPredictor";
import { formatHistory, parseHistory } from "@/engine/history/parseHistory";
import {
  DEFAULT_PHYSICS,
  releaseKernel,
} from "@/engine/history/physicsRelease";
import { chiSquareUniform, gammaQ } from "@/engine/history/stats";
import { mulberry32 } from "@/engine/math/random";
import {
  DOUBLE_ZERO,
  EUROPEAN_ORDER,
  TRIPLE_ZERO,
} from "@/engine/wheel/layout";
import type { HistorySettings } from "@/types/history";
import { describe, expect, it } from "vitest";

const settings = (over: Partial<HistorySettings> = {}): HistorySettings => ({
  wheelType: "european",
  simulations: 40000,
  startingPointIndex: null,
  wheelDirection: 1,
  physics: DEFAULT_PHYSICS,
  engineRuns: { kinematic: 50, rapier: 10, matter: 10 },
  ...over,
});

describe("parseHistory", () => {
  it("keeps chronological order and validates per wheel type", () => {
    const p = parseHistory("17 4 22 0 31", "european");
    expect(p.values).toEqual([17, 4, 22, 0, 31]);
    expect(p.errors).toHaveLength(0);
  });
  it("rejects 00 on European, accepts it on American, 000 only on triple zero", () => {
    expect(parseHistory("00", "european").errors).toHaveLength(1);
    expect(parseHistory("00 5", "american").values).toEqual([DOUBLE_ZERO, 5]);
    expect(parseHistory("000", "american").errors).toHaveLength(1);
    expect(parseHistory("000 00 0", "triple-zero").values).toEqual([
      TRIPLE_ZERO,
      DOUBLE_ZERO,
      0,
    ]);
  });
  it("explains invalid tokens with positions", () => {
    const p = parseHistory("5, 37 abc 07", "european");
    expect(p.values).toEqual([5]);
    expect(p.errors.map((e) => e.raw)).toEqual(["37", "abc", "07"]);
    expect(p.errors[0]!.start).toBe(3);
    expect(p.errors[2]!.error).toContain("leading zero");
  });
  it("round-trips through formatHistory", () => {
    expect(formatHistory(parseHistory("000 00 7", "triple-zero").values)).toBe(
      "000 00 7",
    );
  });
});

describe("statistics", () => {
  it("gammaQ matches known χ² tail values", () => {
    expect(gammaQ(18, 50.998 / 2)).toBeCloseTo(0.05, 3); // χ²(36) critical 5 % ≈ 50.998
    expect(gammaQ(1, 1)).toBeCloseTo(Math.exp(-1), 10);
  });
  it("χ² of perfectly even counts is 0 with p = 1", () => {
    const r = chiSquareUniform(new Array(37).fill(10));
    expect(r.statistic).toBe(0);
    expect(r.pValue).toBeCloseTo(1, 10);
  });
});

describe("physics release kernel", () => {
  it("is close to uniform with realistic launch-speed spread", () => {
    const k = releaseKernel(37, DEFAULT_PHYSICS, 100000, 1);
    expect(k.meanTravelPockets).toBeGreaterThan(200); // ~100 rad of relative travel
    expect(Math.max(...k.kernel) / (1 / 37)).toBeLessThan(1.15);
  });
  it("concentrates only for an implausibly consistent dealer", () => {
    const p = {
      ...DEFAULT_PHYSICS,
      ballOmegaSd: 0.001,
      rotorOmegaSd: 0.001,
      dropOmegaSd: 0.001,
      releaseJitterPockets: 0.3,
      deflectorHitProb: 0,
      bounceSd: 0.5,
    };
    const k = releaseKernel(37, p, 20000, 2);
    expect(Math.max(...k.kernel)).toBeGreaterThan(0.3);
  });
  it("is deterministic for a seed", () => {
    expect(releaseKernel(37, DEFAULT_PHYSICS, 5000, 9).kernel).toEqual(
      releaseKernel(37, DEFAULT_PHYSICS, 5000, 9).kernel,
    );
  });
});

function fairHistory(n: number, seed: number): number[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => EUROPEAN_ORDER[Math.floor(r() * 37)]!);
}

describe("predictFromHistory", () => {
  it("empty / short history: insufficient data, essentially uniform", () => {
    const p = predictFromHistory([17, 4, 22], settings(), 1);
    expect(p.verdict).toBe("insufficient-data");
    expect(p.top10).toHaveLength(10);
    expect(p.top10[0]!.probability).toBeLessThan(1.3 / 37);
  });

  it("fair random history (1000 spins): no evidence, stays near uniform", () => {
    let flagged = 0;
    for (let s = 1; s <= 5; s++) {
      const p = predictFromHistory(fairHistory(1000, s), settings(), s);
      if (p.verdict !== "no-evidence" && p.verdict !== "weak") flagged++;
      expect(Math.max(...p.probs)).toBeLessThan(1.25 / 37);
      expect(p.models[0]!.weight).toBeGreaterThan(0.3);
    }
    expect(flagged).toBe(0);
  });

  it("finds a mild, realistic bias (pocket 17 ≈ 1.7× as likely, 3000 spins)", () => {
    // 2 % extra on pocket 17: the old flat Dirichlet(1) prior never found this.
    for (let s = 1; s <= 5; s++) {
      const r = mulberry32(s * 13);
      const hist = Array.from({ length: 3000 }, () =>
        r() < 0.02 ? 17 : EUROPEAN_ORDER[Math.floor(r() * 37)]!,
      );
      const p = predictFromHistory(hist, settings(), s);
      expect(p.top10.map((x) => x.pocket)).toContain(17);
    }
  });

  it("detects a biased wheel (pocket 17 three times as likely, 2000 spins)", () => {
    const r = mulberry32(5);
    const w = EUROPEAN_ORDER.map((x) => (x === 17 ? 3 : 1));
    const tot = w.reduce((a, b) => a + b, 0);
    const hist = Array.from({ length: 2000 }, () => {
      let u = r() * tot;
      for (let i = 0; i < 37; i++)
        if ((u -= w[i]!) < 0) return EUROPEAN_ORDER[i]!;
      return 0;
    });
    const p = predictFromHistory(hist, settings(), 3);
    expect(p.verdict).toBe("strong");
    expect(p.top10[0]!.pocket).toBe(17);
    expect(p.chiSquare!.pValue).toBeLessThan(1e-6);
    expect(p.models.find((m) => m.id === "frequency")!.weight).toBeGreaterThan(
      0.9,
    );
  });

  it("detects a release signature (next ≈ previous + 10 pockets ± 1)", () => {
    const r = mulberry32(8);
    const idx = [0];
    for (let t = 1; t < 400; t++)
      idx.push((idx[t - 1]! + 10 + Math.round((r() - 0.5) * 3) + 37) % 37);
    const hist = idx.map((i) => EUROPEAN_ORDER[i]!);
    const p = predictFromHistory(hist, settings(), 4);
    expect(
      p.models.find((m) => m.id === "sequence-offset")!.weight,
    ).toBeGreaterThan(0.9);
    const expected = EUROPEAN_ORDER[(idx.at(-1)! + 10) % 37]!;
    expect(p.top10.slice(0, 3).map((x) => x.pocket)).toContain(expected);
  });

  it("probabilities sum to 1 and ranks are descending", () => {
    const p = predictFromHistory(
      fairHistory(200, 3),
      settings({ wheelType: "european" }),
      7,
    );
    expect(p.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (let i = 1; i < p.ranked.length; i++)
      expect(p.ranked[i - 1]!.probability).toBeGreaterThan(
        p.ranked[i]!.probability - 1e-15,
      );
  });

  it("supports American and triple-zero wheels", () => {
    expect(
      predictFromHistory(
        [DOUBLE_ZERO, 5, 0],
        settings({ wheelType: "american" }),
        1,
      ).probs,
    ).toHaveLength(38);
    expect(
      predictFromHistory(
        [TRIPLE_ZERO, 5, 0],
        settings({ wheelType: "triple-zero" }),
        1,
      ).probs,
    ).toHaveLength(39);
  });

  it("uses a custom start pocket as the distribution anchor", () => {
    const p = predictFromHistory(
      [17, 4, 22],
      settings({ startingPointIndex: 10 }),
      1,
    );
    expect(p.settings.startingPointIndex).toBe(10);
    expect(p.probs).toHaveLength(37);
    expect(p.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe("engine kernels (instant guesses)", async () => {
  const { engineKernel, viewFromKernel, kernelKey } =
    await import("@/engine/history/engineRelease");
  const s = settings({ engineRuns: { kinematic: 60, rapier: 10, matter: 10 } });
  const k = await engineKernel("kinematic", s, 7);
  it("records one offset per settled run", () => {
    expect(k.offsetCounts.reduce((a, b) => a + b, 0)).toBe(k.settled);
    expect(k.settled).toBeGreaterThan(50);
  });
  it("a view is the kernel rotated to the last result and sums to 1", () => {
    const a = viewFromKernel(k, [0], "european");
    const b = viewFromKernel(k, [32], "european"); // 32 is one pocket after 0 on the wheel
    expect(a.probs.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    for (let j = 0; j < 37; j++)
      expect(b.probs[(j + 1) % 37]).toBeCloseTo(a.probs[j]!, 12);
  });
  it("is deterministic and keyed by settings", () => {
    expect(kernelKey("kinematic", s, 7)).toBe(k.key);
    expect(kernelKey("kinematic", { ...s, simulations: 1 }, 7)).toBe(k.key); // quick-physics samples don't affect engines
    expect(
      kernelKey(
        "kinematic",
        { ...s, physics: { ...s.physics, ballOmegaMean: 16 } },
        7,
      ),
    ).not.toBe(k.key);
  });
});

describe("calibrateFromHistory (physics learned from results)", async () => {
  const { calibrateFromHistory } = await import("@/engine/history/calibrate");
  const { releaseKernel: rk } = await import("@/engine/history/physicsRelease");
  const signatureHistory = (n: number, seed: number, q = 0.5, mu = 12) => {
    const r = mulberry32(seed);
    let k = Math.floor(r() * 37);
    const out = [EUROPEAN_ORDER[k]!];
    for (let i = 1; i < n; i++) {
      k = r() < q ? (k + mu + Math.round((r() - 0.5) * 4) + 37) % 37 : Math.floor(r() * 37);
      out.push(EUROPEAN_ORDER[k]!);
    }
    return out;
  };

  it("keeps the base settings on fair random history", () => {
    for (let s = 1; s <= 5; s++) {
      const c = calibrateFromHistory(fairHistory(300, s), settings()).calibration;
      expect(c.applied).toBe(false);
      expect(c.physics).toBeNull();
    }
  });

  it("learns a repeatable travel and the physics kernel reproduces it", () => {
    const run = calibrateFromHistory(signatureHistory(150, 7), settings());
    const c = run.calibration;
    expect(c.applied).toBe(true);
    expect(Math.abs(c.mu - 12)).toBeLessThanOrEqual(1);
    const k = rk(37, c.physics!, 40000, 3, null, 1).kernel;
    const peak = k.indexOf(Math.max(...k));
    expect(Math.abs(peak - 12)).toBeLessThanOrEqual(2);
    // Scored walk-forward, the calibrated physics model wins the averaging.
    const p = predictFromHistory(signatureHistory(150, 7), { ...settings(), physics: c.physics! }, 1, run);
    expect(p.models.find((m) => m.id === "physics-release")!.weight).toBeGreaterThan(0.5);
  });
});
