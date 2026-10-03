/**
 * Rapier.js and Matter.js adapters (need `npm install matter-js @dimforge/rapier2d-compat`).
 * Each engine must reproduce the shared track physics and settle the ball.
 */
import { describe, expect, it } from "vitest";
import { runEngine } from "@/engine/physics/simulationAdapter";
import { DEFAULT_SIM_PARAMS, criticalOmega } from "@/engine/physics/rouletteScene";
import { omegaAt } from "@/engine/physics/decelerationModel";

const p = { ...DEFAULT_SIM_PARAMS, seed: 3 };

for (const engine of ["rapier", "matter"] as const) {
  describe(`${engine} adapter`, async () => {
    const r = await runEngine(engine, p);
    it("runs without error and settles in a pocket", () => {
      expect(r.error).toBe(null);
      expect(r.ok).toBe(true);
      expect(r.finalPocket).not.toBe(null);
    });
    it("follows the deceleration law on the track (±2 %)", () => {
      for (const t of [1, 3, 6]) {
        const s = r.samples.find((x) => x.t >= t)!;
        const law = omegaAt({ a: p.frictionA, b: p.dragB }, -p.ballOmega0, s.t);
        expect(Math.abs((s.ballOmega - law) / law)).toBeLessThan(0.02);
      }
    });
    it("leaves the track near ω_c (±10 %)", () => {
      const s = r.samples.find((x) => x.r < 0.3895 - 1e-3)!;
      expect(Math.abs(Math.abs(s.ballOmega) - criticalOmega(p)) / criticalOmega(p)).toBeLessThan(0.1);
    });
  });
}
