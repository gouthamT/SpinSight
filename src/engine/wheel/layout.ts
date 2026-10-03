import type { RotationSign, WheelType } from "@/types/roulette";
import { TWO_PI, wrapAngle } from "@/engine/geometry/angles";

/** "00" on American wheels is represented by -1. */
export const DOUBLE_ZERO = -1;

/** Clockwise order as printed on a standard single-zero wheel, starting at 0. */
export const EUROPEAN_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

/** Standard double-zero wheel order starting at 0. */
export const AMERICAN_ORDER: readonly number[] = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, DOUBLE_ZERO, 27, 10, 25, 29,
  12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
];

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type PocketColour = "red" | "black" | "green";

export function pocketOrder(type: WheelType): readonly number[] {
  return type === "european" ? EUROPEAN_ORDER : AMERICAN_ORDER;
}

export function pocketCount(type: WheelType): number {
  return pocketOrder(type).length;
}

export function pocketColour(n: number): PocketColour {
  if (n === 0 || n === DOUBLE_ZERO) return "green";
  return RED.has(n) ? "red" : "black";
}

export function pocketLabel(n: number): string {
  return n === DOUBLE_ZERO ? "00" : String(n);
}

/** Angular width of one pocket. */
export function pocketPitch(type: WheelType): number {
  return TWO_PI / pocketCount(type);
}

/** Index (into pocketOrder) of the pocket whose centre is nearest to `theta`. */
export function pocketIndexAtAngle(
  type: WheelType,
  theta: number,
  zeroAngle: number,
  sequenceSign: RotationSign,
): number {
  const n = pocketCount(type);
  const rel = wrapAngle((theta - zeroAngle) * sequenceSign);
  const idx = Math.round(rel / (TWO_PI / n));
  return ((idx % n) + n) % n;
}

export function pocketAtAngle(
  type: WheelType,
  theta: number,
  zeroAngle: number,
  sequenceSign: RotationSign,
): number {
  const order = pocketOrder(type);
  return order[pocketIndexAtAngle(type, theta, zeroAngle, sequenceSign)] ?? 0;
}

/** Centre angle (wheel frame) of the pocket at `index` in the sequence. */
export function pocketCentreAngle(
  type: WheelType,
  index: number,
  zeroAngle: number,
  sequenceSign: RotationSign,
): number {
  return wrapAngle(zeroAngle + sequenceSign * index * pocketPitch(type));
}

/** Neighbours of a pocket along the wheel (not numerically). */
export function neighbours(type: WheelType, pocket: number, span: number): number[] {
  const order = pocketOrder(type);
  const n = order.length;
  const i = order.indexOf(pocket);
  if (i < 0) return [];
  const out: number[] = [];
  for (let k = -span; k <= span; k++) out.push(order[(((i + k) % n) + n) % n] ?? 0);
  return out;
}
