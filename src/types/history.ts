import type { WheelType } from "./roulette";

/**
 * History-based "next number" estimation. Everything here is an EXPERIMENTAL
 * MODEL OUTPUT. On a fair wheel past results carry no information about the
 * next spin; the engine therefore always includes the uniform model and lets
 * the evidence in the user's own history decide how far to move away from it.
 */

export interface ParsedToken {
  raw: string;
  /** Pocket code (00 = −1, 000 = −2) when valid. */
  value: number | null;
  error: string | null;
  start: number;
  end: number;
}

export interface ParsedHistory {
  tokens: ParsedToken[];
  /** Valid pocket codes in chronological order (oldest first). */
  values: number[];
  errors: ParsedToken[];
}

export interface PhysicsSettings {
  /** Ball launch speed (rad/s), mean and SD. */
  ballOmegaMean: number;
  ballOmegaSd: number;
  /** Rotor speed (rad/s), mean and SD. */
  rotorOmegaMean: number;
  rotorOmegaSd: number;
  /** Rotor deceleration (rad/s², positive number). */
  rotorDecel: number;
  /** Ball deceleration law dω/dt = −(a + bω²). */
  frictionA: number;
  dragB: number;
  /** |ω| at which the ball leaves the track (rad/s), mean and SD. */
  dropOmegaMean: number;
  dropOmegaSd: number;
  /** Ball released from where the previous result landed, ± jitter (pockets SD). */
  releaseJitterPockets: number;
  /** Probability of striking a deflector (diamond) on the way down. */
  deflectorHitProb: number;
  /** Extra travel caused by a deflector hit (pockets): mean and SD. */
  deflectorKickMean: number;
  deflectorKickSd: number;
  /** Travel while bouncing over the frets before settling (pockets): mean and SD. */
  bounceMean: number;
  bounceSd: number;
  /**
   * Long roll: sometimes the ball keeps rolling around the cone / pocket ring
   * before it finally drops into a number. With this probability an extra
   * travel ~ Exponential(mean) is added.
   */
  longRollProb: number;
  longRollMeanPockets: number;
  /** Ball direction on the wheel as printed (clockwise is usual when the rotor turns counter-clockwise). */
  ballDirection: "clockwise" | "counter-clockwise";
}

export interface HistorySettings {
  wheelType: WheelType;
  simulations: number;
  physics: PhysicsSettings;
  /** Spins simulated per guess by each physics engine view. */
  engineRuns: { kinematic: number; rapier: number; matter: number };
}

/** Landing distribution for the next spin from one physics engine (simulation only). */
export interface EngineView {
  engine: "kinematic" | "rapier" | "matter";
  runs: number;
  settled: number;
  probs: number[];
  ranked: RankedPocket[];
  meanDropS: number | null;
  meanSettleS: number | null;
  /** Share of runs with a long roll: ≥ 2.5 s between leaving the track and landing in a number. */
  longRollShare: number;
  lastResult: number | null;
  elapsedMs: number;
  error: string | null;
}

export type HistoryModelId = "uniform" | "frequency" | "sequence-offset" | "physics-release";

export interface HistoryModelReport {
  id: HistoryModelId;
  label: string;
  /** Posterior weight from walk-forward (prequential) evidence. */
  weight: number;
  /** Mean walk-forward log loss on the history (nats); uniform = ln N. */
  logLoss: number | null;
  /** Walk-forward top-10 hit rate on the history (uniform expectation 10/N). */
  top10Rate: number | null;
  /** Next-spin distribution per pocket-sequence index. */
  probs: number[];
}

export interface RankedPocket {
  rank: number;
  pocket: number;
  probability: number;
  /** Monte Carlo / estimation standard error of the probability. */
  stdError: number;
}

export interface HistoryPrediction {
  createdAt: string;
  seed: number;
  wheelType: WheelType;
  historyLength: number;
  lastResult: number | null;
  simulations: number;
  /** Final (model-averaged) distribution per pocket-sequence index. */
  probs: number[];
  ranked: RankedPocket[];
  top10: RankedPocket[];
  top10Mass: number;
  baseline: number;
  models: HistoryModelReport[];
  /** Chi-square test of uniform pocket frequencies on the history. */
  chiSquare: { statistic: number; df: number; pValue: number } | null;
  /** 2·ln Bayes factor of the best non-uniform model against uniform. */
  evidence2LnBF: number;
  verdict: "insufficient-data" | "no-evidence" | "weak" | "moderate" | "strong";
  verdictText: string;
  settings: HistorySettings;
  elapsedMs: number;
}

export interface PredictionLogEntry {
  createdAt: string;
  historyLength: number;
  top10: number[];
  actual: number | null;
  inTop10: boolean | null;
  probOfActual: number | null;
}

export type HistoryWorkerRequest = { type: "run"; values: number[]; settings: HistorySettings; seed: number; runId: number };
export type HistoryWorkerResponse =
  | { type: "result"; prediction: HistoryPrediction; runId: number }
  | { type: "engine-progress"; engine: EngineView["engine"]; done: number; total: number; runId: number }
  | { type: "engine"; view: EngineView; runId: number }
  | { type: "error"; message: string; runId: number };
