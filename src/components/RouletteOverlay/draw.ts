import type { EllipseRectification, Point2, RotationSign, WheelCalibration, WheelType, WheelZones } from "@/types/roulette";
import { wheelToImage } from "@/engine/geometry/ellipse";
import { pocketCentreAngle, pocketColour, pocketLabel, pocketOrder } from "@/engine/wheel/layout";

export const COLORS = {
  rim: "rgba(52,214,160,0.9)",
  zone: "rgba(152,163,181,0.55)",
  pocketZone: "rgba(90,169,255,0.6)",
  ball: "#ffffff",
  rotor: "#5aa9ff",
  click: "#f2b84b",
  zero: "#34d6a0",
};

export function strokeCircle(
  g: CanvasRenderingContext2D,
  rect: EllipseRectification,
  r: number,
  color: string,
  width: number,
  dash: number[] = [],
) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.setLineDash(dash);
  g.beginPath();
  for (let i = 0; i <= 180; i++) {
    const p = wheelToImage(rect, r, (i / 180) * Math.PI * 2);
    if (i === 0) g.moveTo(p.x, p.y);
    else g.lineTo(p.x, p.y);
  }
  g.stroke();
  g.restore();
}

export function drawZones(g: CanvasRenderingContext2D, rect: EllipseRectification, zones: WheelZones, lw: number) {
  strokeCircle(g, rect, zones.ballTrack.outer, COLORS.rim, lw * 1.5);
  strokeCircle(g, rect, zones.ballTrack.inner, COLORS.zone, lw, [6 * lw, 4 * lw]);
  strokeCircle(g, rect, zones.pocketRing.outer, COLORS.pocketZone, lw, [3 * lw, 3 * lw]);
  strokeCircle(g, rect, zones.pocketRing.inner, COLORS.pocketZone, lw, [3 * lw, 3 * lw]);
}

export function drawPocketLabels(
  g: CanvasRenderingContext2D,
  rect: EllipseRectification,
  zones: WheelZones,
  type: WheelType,
  zeroAngle: number,
  sign: RotationSign,
  scale: number,
) {
  const order = pocketOrder(type);
  const r = (zones.pocketRing.inner + zones.pocketRing.outer) / 2;
  g.save();
  g.font = `${Math.round(10 * scale)}px ui-monospace, monospace`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  order.forEach((n, i) => {
    const a = pocketCentreAngle(type, i, zeroAngle, sign);
    const p = wheelToImage(rect, r, a);
    const col = pocketColour(n);
    g.fillStyle = col === "green" ? "rgba(20,120,60,0.9)" : col === "red" ? "rgba(170,30,40,0.85)" : "rgba(0,0,0,0.8)";
    g.beginPath();
    g.arc(p.x, p.y, 8 * scale, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.fillText(pocketLabel(n), p.x, p.y + 0.5);
  });
  g.restore();
}

export function drawCross(g: CanvasRenderingContext2D, p: Point2, size: number, color: string, lw: number) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.beginPath();
  g.moveTo(p.x - size, p.y);
  g.lineTo(p.x + size, p.y);
  g.moveTo(p.x, p.y - size);
  g.lineTo(p.x, p.y + size);
  g.stroke();
  g.restore();
}

export function drawLine(g: CanvasRenderingContext2D, a: Point2, b: Point2, color: string, lw: number, dash: number[] = []) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.setLineDash(dash);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
  g.restore();
}

/** Overlay for the live view (coordinates in native frame pixels). */
export function drawLiveOverlay(
  g: CanvasRenderingContext2D,
  cal: WheelCalibration,
  state: {
    rotorZero: number | null;
    ball: { x: number; y: number; theta: number; r: number; phase: string } | null;
    trail: Point2[];
    pocketUnderBall: number | null;
    /** Landing probabilities per pocket-sequence index (prediction). */
    probs?: number[] | null;
  },
) {
  const rect = cal.rectification;
  const scale = Math.max(1, cal.frameWidth / 900);
  const lw = 1.5 * scale;
  drawZones(g, rect, cal.zones, lw);
  const hub = wheelToImage(rect, 0, 0);
  drawCross(g, hub, 8 * scale, COLORS.rim, lw);

  if (state.rotorZero !== null && state.probs) {
    drawProbabilityRing(g, cal, state.rotorZero, state.probs, lw);
  }
  if (state.rotorZero !== null) {
    drawPocketLabels(g, rect, cal.zones, cal.wheelType, state.rotorZero, cal.pocketSequenceSign, scale);
    drawLine(g, hub, wheelToImage(rect, cal.zones.pocketRing.inner, state.rotorZero), COLORS.rotor, lw * 1.5);
  }

  if (state.trail.length > 1) {
    g.save();
    for (let i = 1; i < state.trail.length; i++) {
      const a = state.trail[i - 1]!;
      const b = state.trail[i]!;
      g.strokeStyle = `rgba(255,255,255,${(0.6 * i) / state.trail.length})`;
      g.lineWidth = lw * 1.5;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    g.restore();
  }

  if (state.ball) {
    const b = state.ball;
    drawLine(g, hub, wheelToImage(rect, 1.0, b.theta), "rgba(255,255,255,0.45)", lw, [4 * scale, 4 * scale]);
    g.save();
    g.strokeStyle = COLORS.ball;
    g.lineWidth = lw * 1.5;
    g.beginPath();
    g.arc(b.x, b.y, 12 * scale, 0, Math.PI * 2);
    g.stroke();
    if (state.pocketUnderBall !== null && b.phase === "pocket-ring") {
      g.font = `bold ${Math.round(14 * scale)}px ui-monospace, monospace`;
      g.fillStyle = "#fff";
      g.fillText(String(state.pocketUnderBall), b.x + 16 * scale, b.y - 12 * scale);
    }
    g.restore();
  }
}

/** Heat ring just outside the pocket ring: opacity ∝ probability relative to the max. */
export function drawProbabilityRing(
  g: CanvasRenderingContext2D,
  cal: WheelCalibration,
  rotorZero: number,
  probs: number[],
  lw: number,
) {
  const rect = cal.rectification;
  const n = probs.length;
  const max = Math.max(...probs);
  const base = 1 / n;
  if (max <= base * 1.02) return; // uniform: nothing to show
  const r0 = cal.zones.pocketRing.outer + 0.005;
  const r1 = cal.zones.pocketRing.outer + 0.06;
  const half = Math.PI / n;
  g.save();
  probs.forEach((p, i) => {
    const a = pocketCentreAngle(cal.wheelType, i, rotorZero, cal.pocketSequenceSign);
    const alpha = Math.max(0, (p - base) / (max - base));
    if (alpha < 0.03) return;
    g.fillStyle = `rgba(52,214,160,${(0.85 * alpha).toFixed(3)})`;
    g.beginPath();
    const steps = 6;
    for (let k = 0; k <= steps; k++) {
      const q = wheelToImage(rect, r1, a - half + (2 * half * k) / steps);
      if (k === 0) g.moveTo(q.x, q.y);
      else g.lineTo(q.x, q.y);
    }
    for (let k = steps; k >= 0; k--) {
      const q = wheelToImage(rect, r0, a - half + (2 * half * k) / steps);
      g.lineTo(q.x, q.y);
    }
    g.closePath();
    g.fill();
  });
  g.lineWidth = lw;
  g.restore();
}
