import { describe, expect, it } from "vitest";
import {
  AMERICAN_ORDER, EUROPEAN_ORDER, DOUBLE_ZERO, pocketAtAngle, pocketCentreAngle, pocketColour, neighbours,
} from "@/engine/wheel/layout";

describe("wheel layout", () => {
  it("European wheel has 37 unique pockets 0–36", () => {
    expect(EUROPEAN_ORDER).toHaveLength(37);
    expect(new Set(EUROPEAN_ORDER).size).toBe(37);
    expect([...EUROPEAN_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
  });

  it("American wheel has 38 unique pockets incl. 00", () => {
    expect(AMERICAN_ORDER).toHaveLength(38);
    expect(new Set(AMERICAN_ORDER).size).toBe(38);
    expect(AMERICAN_ORDER.includes(DOUBLE_ZERO)).toBe(true);
  });

  it("18 red, 18 black, alternating around a European wheel", () => {
    const cols = EUROPEAN_ORDER.map(pocketColour);
    expect(cols.filter((c) => c === "red")).toHaveLength(18);
    for (let i = 1; i < 36; i++) expect(cols[i] === cols[i + 1]).toBe(false);
  });

  it("pocketAtAngle inverts pocketCentreAngle for both directions", () => {
    for (const sign of [1, -1] as const) {
      EUROPEAN_ORDER.forEach((p, i) => {
        const a = pocketCentreAngle("european", i, 0.7, sign);
        expect(pocketAtAngle("european", a + 0.01, 0.7, sign)).toBe(p);
      });
    }
  });

  it("neighbours follow wheel order", () => {
    expect(neighbours("european", 0, 1)).toEqual([26, 0, 32]);
  });
});
