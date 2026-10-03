"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { WheelCalibration } from "@/types/roulette";
import { loadCalibration } from "@/lib/storage/calibrationStore";
import { assessCalibration } from "@/engine/vision/wheelDetector";

export function CalibrationStatus() {
  const [cal, setCal] = useState<WheelCalibration | null | undefined>(undefined);
  useEffect(() => void loadCalibration().then(setCal), []);
  const q = cal ? assessCalibration(cal) : null;
  return (
    <Link href="/calibration" className="panel block p-4 hover:border-ink-600">
      <div className="panel-title">Calibration</div>
      {cal === undefined ? (
        <div className="mt-2 text-sm text-ink-400">Loading…</div>
      ) : cal === null ? (
        <div className="mt-2 text-sm text-warn">Not calibrated, start here</div>
      ) : (
        <div className="num mt-2 space-y-0.5 text-xs text-ink-300">
          <div>{cal.wheelType} · {cal.frameWidth}×{cal.frameHeight}</div>
          <div>fit residual {(q!.fitRmsResidual * 100).toFixed(2)}% · perspective {cal.rectification.projective ? "corrected" : "affine"}</div>
          <div>{new Date(cal.createdAt).toLocaleString()}</div>
          {q!.warnings.length > 0 && <div className="text-warn">{q!.warnings.length} warning(s)</div>}
        </div>
      )}
    </Link>
  );
}
