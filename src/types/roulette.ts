/**
 * SpinSight core data model.
 *
 * Conventions (used everywhere in the engine):
 * - Angles are radians. In the rectified ("wheel") frame, θ = 0 points along +x
 *   and θ increases counter-clockwise AS SEEN ON SCREEN (image y is flipped).
 * - Radii in the wheel frame are normalised so the outer edge of the ball
 *   track (the rim the user clicks) is r = 1.
 * - Timestamps are milliseconds on a monotonic clock (performance.now or the
 *   video's media clock). Date.now() is never used for motion maths.
 */

export type WheelType = "european" | "american";

/** +1 = counter-clockwise on screen, -1 = clockwise on screen. */
export type RotationSign = 1 | -1;

export interface Point2 {
  x: number;
  y: number;
}

/** Ellipse x(p) = centre + Q^{-1/2} u  ⇔  u = Q^{1/2} (p − centre), |u| = 1 on the rim. */
export interface EllipseRectification {
  centre: Point2;
  /** Symmetric 2×2 matrix Q^{1/2} as [a, b, b, d] (image px → normalised wheel units). */
  forward: [number, number, number, number];
  /** Inverse of forward (normalised wheel units → image px). */
  inverse: [number, number, number, number];
  semiMajorPx: number;
  semiMinorPx: number;
  /** Ellipse rotation in image (radians). */
  tiltRad: number;
  /** RMS radial residual of the rim fit, in normalised units (0.01 ≈ 1%). */
  fitRmsResidual: number;
  /**
   * Optional projective pre-correction derived from the rim ellipse + the
   * clicked hub (the hub's polar line is the image of the line at infinity).
   * p̃ = p − origin;  p' = p̃ / (1 + l1·p̃x + l2·p̃y);  then the affine part
   * (centre/forward/inverse) applies to p'.
   */
  projective: { ox: number; oy: number; l1: number; l2: number } | null;
}

/** Annulus in normalised wheel units (rim = 1). */
export interface Annulus {
  inner: number;
  outer: number;
}

export interface WheelZones {
  /** Stationary track the ball circles on before it drops. */
  ballTrack: Annulus;
  /** Rotating ring of numbered pockets. */
  pocketRing: Annulus;
}

export interface WheelCalibration {
  id: string;
  createdAt: string; // ISO, metadata only
  wheelType: WheelType;
  /** Native size of the frames the calibration was made on. */
  frameWidth: number;
  frameHeight: number;
  /** Raw user clicks, preserved for audit / re-fit. */
  userCentre: Point2 | null;
  rimPoints: Point2[];
  zeroPocketPoint: Point2;
  rectification: EllipseRectification;
  zones: WheelZones;
  /**
   * Direction in which the standard pocket sequence (0, 32, 15, … for European)
   * runs around the wheel, as seen on screen.
   */
  pocketSequenceSign: RotationSign;
  /** Rotor reference: θ of the zero pocket centre at the reference frame. */
  zeroAngleAtReference: number;
  /** Colour template of the pocket ring at the reference frame (see rotorTracker). */
  rotorReference: RotorReference;
  /** How the user confirmed/overrode automatic suggestions. */
  notes: string[];
}

/**
 * Multi-channel polar template of the rotating pocket ring.
 * Each channel has length bins × radialBins, laid out [thetaBin * radialBins + rBin].
 * Bin i is centred at θ = (i + 0.5) · 2π / bins.
 */
export interface RotorReference {
  bins: number;
  radialBins: number;
  luma: number[];
  redness: number[];
  greenness: number[];
}

/**
 * track       – on the stationary outer ball track
 * cone        – stationary lower track / deflector zone (ball descending)
 * pocket-ring – on the rotating pocket ring (bouncing or settled)
 */
export type BallPhase = "track" | "cone" | "pocket-ring" | "lost";

/** One processed frame. Everything here is a MEASUREMENT (no prediction). */
export interface FrameMeasurement {
  seq: number;
  /** Monotonic timestamp in ms used for kinematics. */
  t: number;
  timeSource: TimeSource;
  /** Wall clock at which the main thread received the frame (performance.now). */
  receivedAt: number;
  processingMs: number;
  ball: BallObservation | null;
  rotor: RotorObservation | null;
}

export type TimeSource = "media-time" | "capture-time" | "performance-now" | "synthetic";

export interface BallObservation {
  phase: BallPhase;
  /** Image pixel coordinates (native frame size). */
  x: number;
  y: number;
  /** Normalised radius (rim = 1). */
  r: number;
  /** Wrapped angle in (−π, π]. */
  theta: number;
  /** Detection signal-to-noise ratio. */
  snr: number;
  /** 0..1 heuristic from SNR and blob shape. */
  confidence: number;
}

export interface RotorObservation {
  /** Wrapped angle of the zero pocket centre. */
  zeroAngle: number;
  /** Normalised cross-correlation peak, 0..1. */
  correlation: number;
  /** Peak-to-second-peak ratio; low ⇒ ambiguous (e.g. red/black aliasing). */
  peakRatio: number;
  confidence: number;
}

/** Derived per-frame quantities (Phase 3 replaces the raw estimates with a Kalman filter). */
export interface DerivedState {
  t: number;
  ballThetaUnwrapped: number | null;
  rotorThetaUnwrapped: number | null;
  ballOmegaRaw: number | null; // rad/s
  rotorOmegaRaw: number | null; // rad/s
  /** Pocket currently under the ball (measurement, not prediction). */
  pocketUnderBall: number | null;
}

export interface TrackingStats {
  framesProcessed: number;
  framesDropped: number;
  effectiveFps: number;
  meanGapMs: number;
  maxGapMs: number;
  meanProcessingMs: number;
  ballDetectionRate: number;
}

/** Persisted spin record (Phase 6). Defined now so storage/schema are stable. */
export interface SpinRecord {
  id: string;
  timestamp: string;
  wheelType: WheelType;
  wheelDirection: RotationSign;
  ballDirection: RotationSign;
  initialBallAngle: number;
  initialRotorAngle: number;
  initialBallVelocity: number;
  initialRotorVelocity: number;
  estimatedBallAcceleration: number;
  estimatedRotorAcceleration: number;
  predictedPocket: number | null;
  actualPocket: number | null;
  predictionTimestamp: number | null;
  trackingQuality: number;
  modelVersion: string;
  calibrationId: string;
}

// ---------------------------------------------------------------------------
// Phase 3: filtered motion, deceleration fits, spin phases (all ESTIMATES from
// measurements – not predictions).
// ---------------------------------------------------------------------------

export type FilterStatus = "init" | "tracking" | "coasting" | "lost";

export interface FilteredAngle {
  /** Unwrapped filtered angle (rad); offset is arbitrary, see conventions. */
  theta: number;
  omega: number; // rad/s
  alpha: number; // rad/s²
  sdTheta: number;
  sdOmega: number;
  sdAlpha: number;
  status: FilterStatus;
  /** Measurement rejected by the innovation gate this frame. */
  rejected: boolean;
  rejectedTotal: number;
}

export type SpinPhase = "idle" | "track" | "descending" | "bouncing" | "settled";

export interface SpinEvents {
  spinId: number;
  /** Times in ms on the measurement clock. */
  launchT: number | null;
  dropT: number | null;
  rotorContactT: number | null;
  settleT: number | null;
  settledPocket: number | null;
}

export interface SpinPhaseState {
  phase: SpinPhase;
  since: number; // ms
  events: SpinEvents;
}

/** ω̇ = −(a + bω²)·sgn ω fitted to measured ball angles in the track phase. */
export interface BallDecelerationFit {
  t0: number; // ms
  omega0: number;
  a: number;
  b: number;
  seA: number;
  seB: number;
  /** Correlation of the (ln a, ln b) estimates; typically ≈ −0.99. */
  corrAB: number;
  rmsResidual: number;
  n: number;
  spanMs: number;
  valid: boolean;
}

export interface RotorMotionFit {
  t0: number; // ms
  omega0: number;
  alpha: number;
  seOmega: number;
  seAlpha: number;
  n: number;
}

export interface MotionState {
  t: number;
  raw: DerivedState;
  ball: FilteredAngle | null;
  rotor: FilteredAngle | null;
  spin: SpinPhaseState;
  ballFit: BallDecelerationFit | null;
  rotorFit: RotorMotionFit | null;
}

// ---------------------------------------------------------------------------
// Phase 4: predictions. Everything below is a STATISTICAL PREDICTION and must
// be displayed next to the uniform baseline.
// ---------------------------------------------------------------------------

export type DropModelId = "kinematic" | "deceleration";

export interface DropModelOutput {
  id: DropModelId;
  weight: number;
  /** Predicted absolute drop time (ms, measurement clock). */
  tDropMs: number;
  sdDropMs: number;
  /** Continuous pocket-sequence index under the ball at drop (0 = zero pocket). */
  dropIndexMean: number;
  /** Circular SD of the drop index, in pockets. */
  dropIndexSd: number;
  /** Probability per pocket-sequence index of the DROP pocket (before scatter). */
  dropProbs: number[];
  /** Landing probabilities per pocket-sequence index (after scatter). */
  probs: number[];
}

export type LockRule = { kind: "lead-time"; leadMs: number } | { kind: "drop" };

export interface WheelProfileSummary {
  key: string;
  spins: number;
  omegaCritical: number;
  omegaCriticalSd: number;
  omegaCriticalSource: "geometry-default" | "learned";
  /** Weight of the uniform prior in the scatter model (1 = no information). */
  scatterPriorWeight: number;
  scatterSource: "uniform-prior" | "learned";
}

export interface PredictionOutcome {
  actualPocket: number;
  actualIndex: number;
  /** Signed ring distance (pockets) from the top prediction to the actual pocket. */
  errorPockets: number;
  hit: boolean;
  within1: boolean;
  within3: boolean;
  logLoss: number; // natural log
  baselineLogLoss: number; // ln N
  brier: number;
  baselineBrier: number;
}

export interface SessionScore {
  n: number;
  hits: number;
  within1: number;
  within3: number;
  meanLogLoss: number;
  baselineLogLoss: number;
  meanBrier: number;
  baselineBrier: number;
}

export interface PredictionState {
  modelVersion: string;
  spinId: number;
  status: "waiting" | "live" | "locked" | "resolved";
  note: string | null;
  lockRule: LockRule;
  generatedAt: number | null; // ms
  lockedAt: number | null; // ms
  framesAnalysed: number;
  tDropMs: number | null;
  timeToDropMs: number | null;
  sdDropMs: number | null;
  /** Ensemble landing probabilities per pocket-sequence index. */
  probs: number[] | null;
  /** Ensemble DROP-pocket probabilities (physics only, before scatter). */
  dropProbs: number[] | null;
  models: DropModelOutput[];
  /** Jensen–Shannon divergence between model landing distributions (bits, 0..1). */
  disagreement: number | null;
  /** Shannon entropy of the landing distribution (bits); uniform = log2 N. */
  entropyBits: number | null;
  profile: WheelProfileSummary;
  outcome: PredictionOutcome | null;
  session: SessionScore;
}

/** One completed, observed spin used to learn the wheel profile. */
export interface SpinObservation {
  spinId: number;
  /** |ω| of the ball at the observed drop (rad/s). */
  omegaAtDrop: number;
  /** Continuous sequence index under the ball at the observed drop. */
  dropIndex: number;
  finalIndex: number;
  /** Final − drop, in pockets ALONG the ball's travel relative to the rotor. */
  offsetAlongTravel: number;
  /** +1 if ball moves toward increasing sequence index relative to the rotor. */
  travelIndexSign: 1 | -1;
}

export interface WheelProfile {
  key: string;
  version: 1;
  /** Physical defaults used until spins are observed. */
  trackRadiusM: number;
  trackInclineDeg: number;
  observations: SpinObservation[];
}

/** Messages between UI and the tracking worker. */
export type TrackingWorkerRequest =
  | { type: "configure"; calibration: WheelCalibration; processingWidth: number }
  | {
      type: "frame";
      seq: number;
      t: number;
      timeSource: TimeSource;
      receivedAt: number;
      bitmap: ImageBitmap;
    }
  | { type: "reset-background" }
  | { type: "set-lock-rule"; rule: LockRule }
  | { type: "reset-profile" };

export type TrackingWorkerResponse =
  | { type: "ready" }
  | {
      type: "measurement";
      measurement: FrameMeasurement;
      motion: MotionState;
      prediction: PredictionState;
    }
  | { type: "profile-status"; key: string; spins: number }
  | { type: "error"; message: string };
