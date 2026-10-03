import { describe, expect, it } from "vitest";
import { fitEllipse, imageToWheel, wheelToImage } from "@/engine/geometry/ellipse";
import { angleDiff } from "@/engine/geometry/angles";
import { DEFAULT_CAMERA, projectToImage } from "@/engine/synthetic/syntheticWheel";

describe("ellipse rectification", () => {
  const cam = DEFAULT_CAMERA;
  const rim = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * 2 * Math.PI;
    return projectToImage(cam, Math.cos(a), Math.sin(a));
  });

  it("fits the projected rim exactly (affine camera)", () => {
    const rect = fitEllipse(rim);
    expect(rect.fitRmsResidual).toBeLessThan(1e-6);
    expect(rect.centre.x).toBeCloseTo(cam.cx, 4);
    expect(rect.centre.y).toBeCloseTo(cam.cy, 4);
    expect(rect.semiMajorPx).toBeCloseTo(cam.scale, 3);
    expect(rect.semiMinorPx).toBeCloseTo(cam.scale * cam.foreshorten, 3);
  });

  it("preserves relative angles and radii of interior points", () => {
    const rect = fitEllipse(rim);
    const A = imageToWheel(rect, projectToImage(cam, 0.6 * Math.cos(1), 0.6 * Math.sin(1)));
    const B = imageToWheel(rect, projectToImage(cam, 0.9 * Math.cos(2.5), 0.9 * Math.sin(2.5)));
    expect(A.r).toBeCloseTo(0.6, 6);
    expect(B.r).toBeCloseTo(0.9, 6);
    expect(angleDiff(B.theta, A.theta)).toBeCloseTo(1.5, 6);
  });

  it("round-trips wheel ↔ image", () => {
    const rect = fitEllipse(rim);
    const p = wheelToImage(rect, 0.75, -2.2);
    const q = imageToWheel(rect, p);
    expect(q.r).toBeCloseTo(0.75, 9);
    expect(angleDiff(q.theta, -2.2)).toBeCloseTo(0, 9);
  });

  it("rejects degenerate input", () => {
    expect(() => fitEllipse(rim.slice(0, 4))).toThrow();
    expect(() => fitEllipse([0, 1, 2, 3, 4, 5].map((i) => ({ x: i, y: 2 * i })))).toThrow();
  });

  it("tolerates mild perspective (residual < 1%)", () => {
    const pcam = { ...cam, perspective: 0.05 };
    const prim = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * 2 * Math.PI;
      return projectToImage(pcam, Math.cos(a), Math.sin(a));
    });
    expect(fitEllipse(prim).fitRmsResidual).toBeLessThan(0.01);
  });
});

describe("projective rectification (rim + hub)", () => {
  it("removes perspective distortion of interior angles", async () => {
    const { fitWheelRectification } = await import("@/engine/geometry/ellipse");
    const pcam = { ...DEFAULT_CAMERA, perspective: 0.15, foreshorten: 0.7 };
    const rim = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * 2 * Math.PI;
      return projectToImage(pcam, Math.cos(a), Math.sin(a));
    });
    const hub = projectToImage(pcam, 0, 0);
    const affineOnly = fitEllipse(rim);
    const proj = fitWheelRectification(rim, hub);
    expect(proj.projective).not.toBe(null);
    let worstAffine = 0, worstProj = 0;
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * 2 * Math.PI, b = a + 1.3;
      const P = projectToImage(pcam, 0.65 * Math.cos(a), 0.65 * Math.sin(a));
      const Q = projectToImage(pcam, 0.65 * Math.cos(b), 0.65 * Math.sin(b));
      const errA = Math.abs(angleDiff(angleDiff(imageToWheel(affineOnly, Q).theta, imageToWheel(affineOnly, P).theta), 1.3));
      const errP = Math.abs(angleDiff(angleDiff(imageToWheel(proj, Q).theta, imageToWheel(proj, P).theta), 1.3));
      worstAffine = Math.max(worstAffine, errA);
      worstProj = Math.max(worstProj, errP);
    }
    expect(worstProj).toBeLessThan(1e-6);
    expect(worstAffine).toBeGreaterThan(0.02);
  });
});
