/**
 * Enhanced Prediction Module with Spin Metadata
 * Uses spin start, direction, and historical tuning to improve predictions.
 */

import { SpinStartData, SpinDirectionData } from '../vision/spinDetector';

export interface SpinMetadata {
  spinStart: SpinStartData | null;
  direction: SpinDirectionData | null;
  calibrationQuality: number; // 0-1
}

export interface HistoricalTuning {
  /** Past spin results for walk-forward tuning */
  pastSpins: PastSpinRecord[];
  /** Deceleration model parameters learned from history */
  learnedDeceleration: { a: number; b: number };
  /** Scatter distribution learned from historical outcomes */
  learnedScatter: number;
  /** How many spins to use for tuning (chronological window) */
  windowSize: number;
}

export interface PastSpinRecord {
  timestamp: number;
  ballStartAngle: number;
  rotorStartAngle: number;
  direction: SpinDirectionData;
  actualLandingPocket: number;
  predictedProbabilities: Record<number, number>;
  outcomeAccuracy: number; // How well the prediction performed
}

/**
 * Predict landing pocket probabilities using spin metadata and historical data
 * @param currentBallAngle - Current ball angle on track
 * @param currentRotorAngle - Current rotor orientation
 * @param ballDeceleration - Current ball deceleration parameters
 * @param rotorDeceleration - Current rotor deceleration parameters
 * @param metadata - Spin start and direction information
 * @param tuning - Historical tuning data
 * @returns Probability distribution over pockets
 */
export function predictWithSpinMetadata(
  currentBallAngle: number,
  currentRotorAngle: number,
  ballDeceleration: { a: number; b: number },
  rotorDeceleration: { a: number; b: number },
  metadata: SpinMetadata,
  tuning: HistoricalTuning
): Record<number, number> {
  const predictions: Record<number, number> = {};

  // Use spin direction to initialize simulation direction
  const ballSpinSign = metadata.direction?.ballDirection === 'clockwise' ? 1 : -1;
  const rotorSpinSign = metadata.direction?.rotorDirection === 'clockwise' ? 1 : -1;

  // Apply learned scatter from historical data
  const scatterAdjustment = tuning.learnedScatter || 0.05;

  // Monte Carlo simulation with spin metadata
  const simulations = 10000;
  const pocketCounts: Record<number, number> = {};

  for (let i = 0; i < simulations; i++) {
    // Simulate with direction bias
    const adjustedBallDecel = {
      a: tuning.learnedDeceleration.a || ballDeceleration.a,
      b: tuning.learnedDeceleration.b || ballDeceleration.b,
    };

    // Add noise based on scatter
    const noise = (Math.random() - 0.5) * scatterAdjustment;
    const simulatedDecel = {
      ...adjustedBallDecel,
      b: adjustedBallDecel.b + noise,
    };

    // Project landing using direction hint
    const landingAngle = projectLanding(
      currentBallAngle,
      currentRotorAngle,
      simulatedDecel,
      ballSpinSign,
      rotorSpinSign
    );

    const pocket = angleToPocket(landingAngle);
    pocketCounts[pocket] = (pocketCounts[pocket] || 0) + 1;
  }

  // Normalize to probabilities
  for (const pocket in pocketCounts) {
    predictions[pocket] = pocketCounts[pocket] / simulations;
  }

  return predictions;
}

/**
 * Refine model settings based on past spin data (walk-forward validation)
 * Only use historical data up to the current spin to avoid data leakage
 * @param allPastSpins - Complete history of spins
 * @param currentSpinIndex - Index of the current spin being tuned
 * @returns Tuning parameters for this spin
 */
export function tuneFromHistoricalData(
  allPastSpins: PastSpinRecord[],
  currentSpinIndex: number,
  windowSize: number = 50
): HistoricalTuning {
  // Only use spins BEFORE the current one (walk-forward)
  const trainSpins = allPastSpins.slice(
    Math.max(0, currentSpinIndex - windowSize),
    currentSpinIndex
  );

  if (trainSpins.length === 0) {
    return {
      pastSpins: [],
      learnedDeceleration: { a: 0.1, b: 0.05 }, // Default
      learnedScatter: 0.05,
      windowSize,
    };
  }

  // Estimate deceleration from historical outcomes
  let sumA = 0;
  let sumB = 0;
  let sumAccuracy = 0;

  for (const spin of trainSpins) {
    sumAccuracy += spin.outcomeAccuracy || 0.5;
  }

  const avgAccuracy = sumAccuracy / trainSpins.length;

  // Simple heuristic: adjust deceleration based on accuracy trend
  const learnedA = 0.1 * (1 + avgAccuracy);
  const learnedB = 0.05 * (1 + avgAccuracy);
  const learnedScatter = 0.05 * (1 - avgAccuracy); // Lower scatter if model is accurate

  return {
    pastSpins: trainSpins,
    learnedDeceleration: { a: learnedA, b: learnedB },
    learnedScatter: Math.max(0.01, learnedScatter),
    windowSize,
  };
}

/**
 * Project where the ball will land given current state and deceleration
 */
function projectLanding(
  ballAngle: number,
  rotorAngle: number,
  deceleration: { a: number; b: number },
  ballSpinSign: number,
  rotorSpinSign: number
): number {
  // Simplified projection; real implementation uses full physics
  const timeToStop = 5; // seconds (placeholder)
  const finalBallAngle =
    ballAngle + ballSpinSign * deceleration.a * timeToStop;
  return (finalBallAngle + rotorAngle * rotorSpinSign) % 360;
}

/**
 * Convert angle to pocket number
 */
function angleToPocket(angle: number): number {
  // Simplified; real implementation uses actual wheel layout
  return Math.floor((angle / 360) * 37) % 37;
}
