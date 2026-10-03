import type { EllipseRectification, RotationSign, WheelType, WheelZones } from "@/types/roulette";
import { TWO_PI, wrapAngle } from "@/engine/geometry/angles";
import { wheelToImage } from "@/engine/geometry/ellipse";
import { pocketColour, pocketCount, pocketOrder, pocketPitch } from "@/engine/wheel/layout";
import type { RGBAFrame } from "./polarSampler";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function sampleWheel(
  frame: RGBAFrame,
  rect: EllipseRectification,
  r: number,
  theta: number,
  halfWidthRad: number,
  radialHalf: number,
): Rgb {
  let sr = 0,
    sg = 0,
    sb = 0,
    n = 0;
  for (let a = -2; a <= 2; a++) {
    for (let k = -2; k <= 2; k++) {
      const p = wheelToImage(rect, r + (k / 2) * radialHalf, theta + (a / 2) * halfWidthRad);
      const x = Math.round(p.x),
        y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      const o = (y * frame.width + x) * 4;
      sr += frame.data[o]!;
      sg += frame.data[o + 1]!;
      sb += frame.data[o + 2]!;
      n++;
    }
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n } : { r: 0, g: 0, b: 0 };
}

export interface ZeroSuggestion {
  theta: number;
  /** Greenness margin over the median pocket, 0..1. */
  confidence: number;
}

/** Suggest the zero pocket as the greenest pocket-sized sector of the pocket ring. */
export function suggestZeroPocket(
  frame: RGBAFrame,
  rect: EllipseRectification,
  zones: WheelZones,
  type: WheelType,
): ZeroSuggestion {
  const steps = 360;
  const rMid = (zones.pocketRing.inner + zones.pocketRing.outer) / 2;
  const radialHalf = (zones.pocketRing.outer - zones.pocketRing.inner) * 0.35;
  const half = pocketPitch(type) * 0.35;
  const g: number[] = [];
  for (let i = 0; i < steps; i++) {
    const c = sampleWheel(frame, rect, rMid, (i * TWO_PI) / steps, half, radialHalf);
    g.push(c.g - Math.max(c.r, c.b));
  }
  let best = 0;
  for (let i = 1; i < steps; i++) if (g[i]! > g[best]!) best = i;
  const sorted = [...g].sort((a, b) => a - b);
  const med = sorted[steps >> 1]!;
  const confidence = Math.max(0, Math.min(1, (g[best]! - med) / 60));
  return { theta: wrapAngle((best * TWO_PI) / steps), confidence };
}

export interface SequenceSuggestion {
  sign: RotationSign;
  /** Fraction of non-green pockets whose red/black colour matched, for the chosen sign. */
  matchRate: number;
  /** Separation between the two hypotheses, 0..1. */
  confidence: number;
}

/**
 * Decide which way the printed pocket sequence runs by checking the red/black
 * pattern against both directions from the zero pocket.
 */
export function suggestSequenceSign(
  frame: RGBAFrame,
  rect: EllipseRectification,
  zones: WheelZones,
  type: WheelType,
  zeroAngle: number,
): SequenceSuggestion {
  const order = pocketOrder(type);
  const n = pocketCount(type);
  const pitch = pocketPitch(type);
  const rMid = (zones.pocketRing.inner + zones.pocketRing.outer) / 2;
  const radialHalf = (zones.pocketRing.outer - zones.pocketRing.inner) * 0.35;
  const evaluate = (sign: RotationSign) => {
    const red: number[] = [];
    for (let k = 1; k < n; k++) {
      const c = sampleWheel(frame, rect, rMid, zeroAngle + sign * k * pitch, pitch * 0.3, radialHalf);
      red.push(c.r - (c.g + c.b) / 2);
    }
    const thr = [...red].sort((a, b) => a - b)[red.length >> 1]!;
    let matches = 0,
      counted = 0;
    for (let k = 1; k < n; k++) {
      const col = pocketColour(order[k]!);
      if (col === "green") continue;
      counted++;
      const isRed = red[k - 1]! > thr;
      if (isRed === (col === "red")) matches++;
    }
    return matches / Math.max(1, counted);
  };
  const ccw = evaluate(1);
  const cw = evaluate(-1);
  const sign: RotationSign = ccw >= cw ? 1 : -1;
  return { sign, matchRate: Math.max(ccw, cw), confidence: Math.min(1, Math.abs(ccw - cw) * 2) };
}
