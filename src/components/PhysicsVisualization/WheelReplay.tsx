"use client";
import { useEffect, useRef } from "react";
import type { SimParams, SimResult, SimSample } from "@/types/simulation";
import { GEOM, deflectorPoses } from "@/engine/physics/rouletteScene";
import { pocketColour, pocketLabel, pocketOrder } from "@/engine/wheel/layout";

const POCKET_FILL = { red: "#a81a20", black: "#16181c", green: "#127a3a" } as const;

export function sampleAt(samples: SimSample[], t: number): SimSample | null {
  if (!samples.length) return null;
  let lo = 0, hi = samples.length - 1;
  if (t <= samples[0]!.t) return samples[0]!;
  if (t >= samples[hi]!.t) return samples[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  return samples[lo]!;
}

/** Top-down replay of one simulation at time t (canvas, theme-independent wheel colours). */
export function WheelReplay({ result, params, t, size = 320 }: { result: SimResult; params: SimParams; t: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const k = (size / 2 - 6) / GEOM.rimR;
    const cx = size / 2, cy = size / 2;
    const X = (x: number) => cx + x * k;
    const Y = (y: number) => cy - y * k; // y up
    const s = sampleAt(result.samples, t);
    const rotorAngle = s?.rotorAngle ?? params.rotorPhase;

    // Bowl.
    g.fillStyle = "#3a2414";
    g.beginPath(); g.arc(cx, cy, GEOM.rimR * k + 4, 0, 2 * Math.PI); g.fill();
    g.fillStyle = "#8a5a33";
    g.beginPath(); g.arc(cx, cy, GEOM.rimR * k, 0, 2 * Math.PI); g.fill();
    g.fillStyle = "#5e3a1f";
    g.beginPath(); g.arc(cx, cy, GEOM.trackInner * k, 0, 2 * Math.PI); g.fill();

    // Pockets (rotor frame: pocket i centred at rotorAngle − i·pitch).
    const order = pocketOrder(params.wheelType);
    const n = order.length;
    const pitch = (2 * Math.PI) / n;
    order.forEach((num, i) => {
      const a = rotorAngle - i * pitch;
      g.fillStyle = POCKET_FILL[pocketColour(num)];
      g.beginPath();
      g.arc(cx, cy, GEOM.pocketOuter * k, -(a + pitch / 2), -(a - pitch / 2));
      g.arc(cx, cy, GEOM.turretR * k, -(a - pitch / 2), -(a + pitch / 2), true);
      g.closePath();
      g.fill();
      if (size >= 260) {
        const rm = ((GEOM.pocketOuter + GEOM.turretR) / 2) * k;
        g.save();
        g.translate(cx + rm * Math.cos(a), cy - rm * Math.sin(a));
        g.rotate(-a + Math.PI / 2);
        g.fillStyle = "#fff";
        g.font = `${Math.max(7, size / 48)}px ui-monospace, monospace`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(pocketLabel(num), 0, 0);
        g.restore();
      }
    });
    // Frets.
    g.strokeStyle = "#c9c9cf";
    g.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const a = rotorAngle - (i + 0.5) * pitch;
      g.beginPath();
      g.moveTo(X(GEOM.turretR * Math.cos(a)), Y(GEOM.turretR * Math.sin(a)));
      g.lineTo(X(GEOM.fretOuter * Math.cos(a)), Y(GEOM.fretOuter * Math.sin(a)));
      g.stroke();
    }
    // Turret.
    g.fillStyle = "#9aa0a8";
    g.beginPath(); g.arc(cx, cy, GEOM.turretR * k, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = "#34d6a0";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(X(GEOM.turretR * Math.cos(rotorAngle)), Y(GEOM.turretR * Math.sin(rotorAngle))); g.stroke();

    // Deflectors.
    g.fillStyle = "#d4b25a";
    for (const d of deflectorPoses(params)) {
      g.save();
      g.translate(X(d.x), Y(d.y));
      g.rotate(-d.angle);
      g.fillRect(-GEOM.deflectorHalfLen * k, -GEOM.deflectorHalfWidth * k, 2 * GEOM.deflectorHalfLen * k, 2 * GEOM.deflectorHalfWidth * k);
      g.restore();
    }

    // Ball trail (last second) and ball.
    if (s) {
      const trail = result.samples.filter((q) => q.t <= t && q.t > t - 1);
      g.strokeStyle = "rgba(255,255,255,0.45)";
      g.lineWidth = 1.5;
      g.beginPath();
      trail.forEach((q, i) => (i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y))));
      g.stroke();
      g.fillStyle = "#f5f5f5";
      g.beginPath();
      g.arc(X(s.x), Y(s.y), Math.max(3, GEOM.ballR * k), 0, 2 * Math.PI);
      g.fill();
    }
  }, [result, params, t, size]);

  return <canvas ref={ref} style={{ width: size, height: size }} className="mx-auto block max-w-full" />;
}
