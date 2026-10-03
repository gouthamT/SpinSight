import type {
  EllipseRectification,
  Point2,
  RotationSign,
  WheelCalibration,
  WheelType,
  WheelZones,
} from "@/types/roulette";
import { fitEllipse, fitWheelRectification, imageToWheel, scaleRectification } from "@/engine/geometry/ellipse";
import { PolarGrid, type RGBAFrame } from "./polarSampler";
import { buildRotorReference } from "./rotorTracker";

/**
 * Typical proportions of a casino wheel, normalised to the outer ball-track
 * edge. Every value is user-adjustable in the calibration UI.
 */
export const DEFAULT_ZONES: WheelZones = {
  ballTrack: { inner: 0.86, outer: 1.0 },
  pocketRing: { inner: 0.58, outer: 0.72 },
};

/** Polar resolutions used by the trackers. */
export const GRID = {
  rotorBins: 360,
  rotorRadialBins: 4,
  trackBins: 720,
  trackRadialBins: 8,
} as const;

export function buildPocketGrid(
  rect: EllipseRectification,
  zones: WheelZones,
  width: number,
  height: number,
): PolarGrid {
  return new PolarGrid(rect, zones.pocketRing, GRID.rotorBins, GRID.rotorRadialBins, width, height);
}

/** Stationary zone = outer ball track + deflector cone (everything between rim and rotor). */
export function buildStationaryGrid(
  rect: EllipseRectification,
  zones: WheelZones,
  width: number,
  height: number,
): PolarGrid {
  const annulus = { inner: zones.pocketRing.outer + 0.01, outer: zones.ballTrack.outer - 0.005 };
  return new PolarGrid(rect, annulus, GRID.trackBins, GRID.trackRadialBins, width, height);
}

export interface CalibrationInput {
  wheelType: WheelType;
  frame: RGBAFrame;
  userCentre: Point2 | null;
  rimPoints: Point2[];
  zeroPocketPoint: Point2;
  zones: WheelZones;
  pocketSequenceSign: RotationSign;
  notes?: string[];
}

/** Turn user clicks + a still frame into a complete calibration. */
export function createCalibration(input: CalibrationInput): WheelCalibration {
  const rect = fitWheelRectification(input.rimPoints, input.userCentre);
  const zeroAngle = imageToWheel(rect, input.zeroPocketPoint).theta;
  const grid = buildPocketGrid(rect, input.zones, input.frame.width, input.frame.height);
  return {
    id: `cal_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    wheelType: input.wheelType,
    frameWidth: input.frame.width,
    frameHeight: input.frame.height,
    userCentre: input.userCentre,
    rimPoints: input.rimPoints,
    zeroPocketPoint: input.zeroPocketPoint,
    rectification: rect,
    zones: input.zones,
    pocketSequenceSign: input.pocketSequenceSign,
    zeroAngleAtReference: zeroAngle,
    rotorReference: buildRotorReference(grid, input.frame),
    notes: input.notes ?? [],
  };
}

export interface CalibrationQuality {
  fitRmsResidual: number;
  /** Axis ratio minor/major: 1 = overhead, lower = more oblique. */
  axisRatio: number;
  centreOffset: number | null;
  frameCoverage: number;
  warnings: string[];
}

export function assessCalibration(cal: WheelCalibration): CalibrationQuality {
  const rect = cal.rectification;
  const warnings: string[] = [];
  const axisRatio = rect.semiMinorPx / rect.semiMajorPx;
  // With projective correction the hub IS the centre by construction, so measure
  // the hub against an affine-only fit: a large offset means strong perspective.
  let centreOffset: number | null = null;
  if (cal.userCentre) {
    try {
      centreOffset = imageToWheel(fitEllipse(cal.rimPoints), cal.userCentre).r;
    } catch {
      centreOffset = null;
    }
  }
  const grid = buildStationaryGrid(rect, cal.zones, cal.frameWidth, cal.frameHeight);
  const frameCoverage = grid.coverage();
  if (rect.fitRmsResidual > 0.02) warnings.push("Rim fit is loose (>2%). Re-click rim points more carefully.");
  if (axisRatio < 0.55) warnings.push("Camera is very oblique; affine rectification will be inaccurate. Move the camera more overhead.");
  if (!rect.projective) warnings.push(cal.userCentre ? "Hub click was implausible; perspective correction disabled (affine only)." : "No hub click: perspective is not corrected (affine only).");
  if (centreOffset !== null && centreOffset > 0.08) warnings.push("Strong perspective (hub >8% off the rim-ellipse centre). Prefer a more overhead camera.");
  if (frameCoverage < 0.98) warnings.push("Part of the wheel is outside the frame.");
  if (rect.semiMinorPx < 120) warnings.push("Wheel is small in frame; tracking precision will suffer. Zoom in or move closer.");
  return { fitRmsResidual: rect.fitRmsResidual, axisRatio, centreOffset, frameCoverage, warnings };
}

/** Calibration rescaled to a processing resolution. */
export function scaleCalibrationRect(cal: WheelCalibration, width: number, height: number) {
  return scaleRectification(cal.rectification, width / cal.frameWidth, height / cal.frameHeight);
}
