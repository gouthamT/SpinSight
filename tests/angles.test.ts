import { describe, expect, it } from "vitest";
import { AngleUnwrapper, angleDiff, unwrapSeries, wrapAngle, TWO_PI } from "@/engine/geometry/angles";

describe("angles", () => {
  it("wraps into (−π, π]", () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(TWO_PI + 0.1)).toBeCloseTo(0.1, 9);
  });

  it("signed shortest difference", () => {
    expect(angleDiff(0.1, TWO_PI - 0.1)).toBeCloseTo(0.2, 9);
    expect(angleDiff(-3.1, 3.1)).toBeCloseTo(TWO_PI - 6.2, 9);
  });

  it("unwraps a fast monotonic rotation", () => {
    const truth = Array.from({ length: 200 }, (_, i) => -0.3 * i);
    const out = unwrapSeries(truth.map(wrapAngle));
    out.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 9));
  });

  it("uses predicted step to avoid aliasing when |ωΔt| > π", () => {
    const step = 4.0; // > π per frame
    const u = new AngleUnwrapper();
    const truth = Array.from({ length: 20 }, (_, i) => step * i);
    const out = truth.map((t, i) => u.push(wrapAngle(t), i === 0 ? 0 : step));
    out.forEach((v, i) => expect(v).toBeCloseTo(truth[i]!, 9));
  });
});
