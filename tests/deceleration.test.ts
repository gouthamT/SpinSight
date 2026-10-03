import { describe, expect, it } from "vitest";
import { fitDeceleration, fitRotor, type AngleSample } from "@/engine/tracking/accelerationEstimator";
import { omegaAt, thetaAt, timeToOmega, stopTime } from "@/engine/physics/decelerationModel";
import { DEFAULT_SPIN, SyntheticSpin, mulberry32 } from "@/engine/synthetic/syntheticWheel";

const g = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());

describe("deceleration model closed form", () => {
  const p = { a: 0.3, b: 0.011 };
  it("θ and ω are consistent (dθ/dt = ω) and ω̇ = −(a + bω²)", () => {
    const w0 = -15, t = 2;
    const h = 1e-4;
    const dth = (thetaAt(p, 0, w0, t + h) - thetaAt(p, 0, w0, t - h)) / (2 * h);
    expect(dth).toBeCloseTo(omegaAt(p, w0, t), 5);
    const w = omegaAt(p, w0, t);
    const dw = (omegaAt(p, w0, t + h) - omegaAt(p, w0, t - h)) / (2 * h);
    expect(dw).toBeCloseTo(-(p.a + p.b * w * w) * Math.sign(w), 4);
  });
  it("time-to-ω inverts ω(t)", () => {
    const t = timeToOmega(p, 15, 5.2);
    expect(omegaAt(p, 15, t)).toBeCloseTo(5.2, 6);
    expect(stopTime(p, 15)).toBeGreaterThan(t);
  });
});

describe("fitDeceleration on synthetic track-phase measurements", () => {
  const spin = new SyntheticSpin(DEFAULT_SPIN);
  function samples(fps: number, sigma: number, untilMs: number, seed = 3): AngleSample[] {
    const rnd = mulberry32(seed);
    const out: AngleSample[] = [];
    for (let k = 0; (k * 1000) / fps < untilMs; k++) {
      const ms = (k * 1000) / fps;
      out.push({ t: ms / 1000, theta: spin.ballThetaUnwrapped(ms) + sigma * g(rnd) });
    }
    return out;
  }

  it("recovers a and b within 10 % from the full track phase (60 fps, σ = 0.3°)", () => {
    const f = fitDeceleration(samples(60, 0.005, spin.dropTimeMs - 20))!;
    expect(f.valid).toBe(true);
    expect(Math.abs(f.a - DEFAULT_SPIN.frictionA) / DEFAULT_SPIN.frictionA).toBeLessThan(0.1);
    expect(Math.abs(f.b - DEFAULT_SPIN.dragB) / DEFAULT_SPIN.dragB).toBeLessThan(0.1);
    expect(Math.abs(f.omega0 - DEFAULT_SPIN.ballOmega0)).toBeLessThan(0.1);
    expect(f.rmsResidual).toBeLessThan(0.008);
  });

  it("predicts the drop time from the first 4 s within 3 %", () => {
    const f = fitDeceleration(samples(30, 0.005, 4000))!;
    const tDrop = f.t0 + timeToOmega(f, f.omega0, DEFAULT_SPIN.criticalOmega);
    expect(Math.abs(tDrop * 1000 - spin.dropTimeMs) / spin.dropTimeMs).toBeLessThan(0.03);
  });

  it("refuses to fit too little data", () => {
    expect(fitDeceleration(samples(60, 0.005, 100))).toBe(null);
  });
});

describe("fitRotor", () => {
  it("recovers rotor ω0 and α", () => {
    const spin = new SyntheticSpin(DEFAULT_SPIN);
    const rnd = mulberry32(8);
    const s: AngleSample[] = [];
    for (let k = 0; k < 300; k++) s.push({ t: k / 60, theta: spin.rotorAngle((k * 1000) / 60) + 0.003 * g(rnd) });
    const f = fitRotor(s)!;
    expect(Math.abs(f.omega0 - DEFAULT_SPIN.rotorOmega0)).toBeLessThan(0.005);
    expect(Math.abs(f.alpha - DEFAULT_SPIN.rotorAlpha)).toBeLessThan(0.005);
  });
});
