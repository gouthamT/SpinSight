import { describe, expect, it } from "vitest";
import { runKinematic } from "@/engine/physics/trajectoryModel";
import { DEFAULT_SIM_PARAMS, criticalOmega, rotorState, applyRimConstraint } from "@/engine/physics/rouletteScene";
import { omegaAt } from "@/engine/physics/decelerationModel";
import { batchParams } from "@/engine/physics/simulationAdapter";

const p = DEFAULT_SIM_PARAMS;

describe("shared roulette scene", () => {
  it("rim constraint keeps speed (no artificial deceleration)", () => {
    const c = applyRimConstraint({ x: 0.5, y: 0 }, { x: 0.3, y: 4 });
    expect(Math.hypot(c.vel.x, c.vel.y)).toBeCloseTo(Math.hypot(0.3, 4), 9);
    expect(c.vel.x).toBeCloseTo(0, 9);
  });
  it("rotor decelerates to rest and never reverses", () => {
    expect(rotorState(p, 1e4).omega).toBe(0);
    expect(Math.sign(rotorState(p, 1).omega)).toBe(1); // ball clockwise → rotor counter-clockwise
  });
});

describe("kinematic reference simulation", () => {
  const r = runKinematic({ ...p, seed: 3 });
  it("ball follows the deceleration law on the track (±2 % at dt = 1/480 s; error is first-order in dt)", () => {
    for (const t of [1, 3, 6]) {
      const s = r.samples.find((x) => x.t >= t)!;
      const law = omegaAt({ a: p.frictionA, b: p.dragB }, -p.ballOmega0, s.t);
      expect(Math.abs((s.ballOmega - law) / law)).toBeLessThan(0.02);
    }
  });
  it("leaves the track near ω_c² = g·tanδ / r (emergent, not imposed)", () => {
    const s = r.samples.find((x) => x.r < 0.3895 - 1e-3)!;
    expect(Math.abs(Math.abs(s.ballOmega) - criticalOmega(p)) / criticalOmega(p)).toBeLessThan(0.1);
  });
  it("drops, reaches the rotor, settles in a pocket", () => {
    expect(r.ok).toBe(true);
    expect(r.rotorContactTimeS!).toBeGreaterThan(r.dropTimeS!);
    expect(r.settleTimeS!).toBeGreaterThan(r.rotorContactTimeS!);
    expect(r.finalPocket).not.toBe(null);
  });
  it("is deterministic and batch runs vary launch conditions", () => {
    expect(runKinematic({ ...p, seed: 3 }).finalIndex).toBe(r.finalIndex);
    const a = batchParams(p, 1, 0), b = batchParams(p, 1, 1);
    expect(a.launchAngle).not.toBe(b.launchAngle);
  });
});
