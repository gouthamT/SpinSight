/**
 * Spin Detection Module
 * Detects and tracks the spin start point and rotation direction of the wheel.
 * Used to initialize tracking and improve prediction accuracy.
 */

export interface SpinStartData {
  /** Reference angle for where the spin started (0-360 degrees) */
  referenceAngle: number;
  /** User-provided or inferred description of spin start */
  reference: string;
  /** Timestamp when spin was detected to start */
  startTime: number;
  /** Confidence in the detection (0-1) */
  confidence: number;
}

export interface SpinDirectionData {
  /** Is the rotor spinning clockwise or counter-clockwise? */
  rotorDirection: 'clockwise' | 'counterclockwise';
  /** Is the ball spinning clockwise or counter-clockwise? */
  ballDirection: 'clockwise' | 'counterclockwise';
  /** Inferred or user-selected direction */
  source: 'inferred' | 'manual';
  /** Confidence in direction detection (0-1) */
  confidence: number;
}

export interface SpinDetectionSettings {
  /** Enable automatic spin start detection */
  autoDetectStart: boolean;
  /** Enable automatic direction detection */
  autoDetectDirection: boolean;
  /** Allow manual override of detected values */
  allowManualOverride: boolean;
  /** Minimum confidence threshold to accept auto-detection */
  confidenceThreshold: number;
}

/**
 * Detect the start of a spin from motion history
 * @param ballAngles - Historical ball angle measurements
 * @param timestamps - Corresponding timestamps
 * @param settings - Detection configuration
 * @returns Detected spin start data
 */
export function detectSpinStart(
  ballAngles: number[],
  timestamps: number[],
  settings: SpinDetectionSettings
): SpinStartData | null {
  if (!settings.autoDetectStart || ballAngles.length < 3) {
    return null;
  }

  // Find the point where motion starts (velocity threshold)
  // Typically when angular velocity exceeds a minimum
  let motionStartIndex = 0;
  const velocityThreshold = 5; // degrees per frame

  for (let i = 1; i < ballAngles.length; i++) {
    const angleChange = Math.abs(ballAngles[i] - ballAngles[i - 1]);
    const timeGap = timestamps[i] - timestamps[i - 1];
    const velocity = angleGap > 0 ? angleChange / timeGap : 0;

    if (velocity > velocityThreshold) {
      motionStartIndex = i;
      break;
    }
  }

  return {
    referenceAngle: ballAngles[motionStartIndex],
    reference: `Spin detected at ${ballAngles[motionStartIndex].toFixed(1)}°`,
    startTime: timestamps[motionStartIndex],
    confidence: 0.8, // Placeholder; refine based on velocity profile
  };
}

/**
 * Infer rotation direction from angular velocity history
 * @param ballAngles - Historical ball angles
 * @param rotorAngles - Historical rotor angles
 * @param timestamps - Corresponding timestamps
 * @param settings - Detection configuration
 * @returns Detected direction data
 */
export function detectSpinDirection(
  ballAngles: number[],
  rotorAngles: number[],
  timestamps: number[],
  settings: SpinDetectionSettings
): SpinDirectionData | null {
  if (!settings.autoDetectDirection || ballAngles.length < 3) {
    return null;
  }

  // Calculate average angular velocities
  let ballVelocitySum = 0;
  let rotorVelocitySum = 0;
  let samples = 0;

  for (let i = 1; i < ballAngles.length && i < rotorAngles.length; i++) {
    const timeGap = timestamps[i] - timestamps[i - 1];
    if (timeGap <= 0) continue;

    const ballDelta = ballAngles[i] - ballAngles[i - 1];
    const rotorDelta = rotorAngles[i] - rotorAngles[i - 1];

    ballVelocitySum += ballDelta / timeGap;
    rotorVelocitySum += rotorDelta / timeGap;
    samples++;
  }

  const avgBallVelocity = samples > 0 ? ballVelocitySum / samples : 0;
  const avgRotorVelocity = samples > 0 ? rotorVelocitySum / samples : 0;

  return {
    ballDirection: avgBallVelocity > 0 ? 'clockwise' : 'counterclockwise',
    rotorDirection: avgRotorVelocity > 0 ? 'clockwise' : 'counterclockwise',
    source: 'inferred',
    confidence: 0.85, // Placeholder; refine based on consistency
  };
}
