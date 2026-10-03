/**
 * Spin life-cycle detector:
 *
 *   idle ──(ball circling on track ≥ 150 ms, |ω| > 3 rad/s)──► track
 *   track ──(ball leaves track: cone / pocket-ring / r < track inner, 2 frames)──► descending
 *   descending ──(ball on pocket ring, 2 frames)──► bouncing
 *   bouncing ──(ball-relative-to-rotor angle stable within ±½ pocket for 600 ms)──► settled
 *   track/descending/bouncing ──(ball unseen 1.5 s)──► idle  (aborted spin)
 *   settled ──(ball moves > ½ pocket from its settled position, 2 frames)──► bouncing
 *   settled ──(new launch)──► track (next spinId)
 *
 * Purely measurement-driven; the drop time recorded here is the OBSERVED
 * drop, which Phase 4 uses as ground truth for ω_c calibration.
 */
import type { FrameMeasurement, SpinEvents, SpinPhase, SpinPhaseState, WheelCalibration } from "@/types/roulette";
import { angleDiff } from "@/engine/geometry/angles";
import { pocketPitch } from "@/engine/wheel/layout";

export interface SpinPhaseOptions {
  launchOmega: number; // rad/s
  launchHoldMs: number;
  dropFrames: number;
  rotorFrames: number;
  settleHoldMs: number;
  lostMs: number;
}

const DEFAULTS: SpinPhaseOptions = {
  launchOmega: 3,
  launchHoldMs: 150,
  dropFrames: 2,
  rotorFrames: 2,
  settleHoldMs: 600,
  lostMs: 1500,
};

const emptyEvents = (spinId: number): SpinEvents => ({
  spinId,
  launchT: null,
  dropT: null,
  rotorContactT: null,
  settleT: null,
  settledPocket: null,
});

export class SpinPhaseMachine {
  private phase: SpinPhase = "idle";
  private since = 0;
  private events: SpinEvents = emptyEvents(0);
  private launchStart: number | null = null;
  private dropCount = 0;
  private dropFirstT: number | null = null;
  private rotorCount = 0;
  private rotorFirstT: number | null = null;
  private lastSeen: number | null = null;
  private relWindow: { t: number; rel: number; pocket: number | null }[] = [];
  private settledRel: number | null = null;
  private unsettleCount = 0;
  private readonly opts: SpinPhaseOptions;
  /** Set for exactly one update after a new spin starts (consumers reset per-spin state). */
  newSpin = false;

  constructor(
    private readonly calibration: WheelCalibration,
    opts: Partial<SpinPhaseOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get state(): SpinPhaseState {
    return { phase: this.phase, since: this.since, events: { ...this.events } };
  }

  reset(): void {
    this.phase = "idle";
    this.since = 0;
    this.events = emptyEvents(this.events.spinId);
    this.clearCounters();
  }

  private clearCounters() {
    this.launchStart = null;
    this.dropCount = 0;
    this.dropFirstT = null;
    this.rotorCount = 0;
    this.rotorFirstT = null;
    this.relWindow = [];
    this.settledRel = null;
    this.unsettleCount = 0;
  }

  private go(p: SpinPhase, t: number) {
    this.phase = p;
    this.since = t;
  }

  /**
   * @param ballOmega filtered ball ω (rad/s) or null
   * @param pocketUnderBall pocket currently under the ball (measurement)
   */
  update(m: FrameMeasurement, ballOmega: number | null, pocketUnderBall: number | null): SpinPhaseState {
    this.newSpin = false;
    const t = m.t;
    const o = this.opts;
    const ball = m.ball;
    if (ball) this.lastSeen = t;
    const onTrack = ball !== null && ball.phase === "track";
    const fastOnTrack = onTrack && ballOmega !== null && Math.abs(ballOmega) > o.launchOmega;

    // A "settled" ball can still hop out of its pocket: revert to bouncing.
    if (this.phase === "settled" && ball?.phase === "pocket-ring" && m.rotor && this.settledRel !== null) {
      const rel = angleDiff(ball.theta, m.rotor.zeroAngle);
      if (Math.abs(angleDiff(rel, this.settledRel)) > 0.5 * pocketPitch(this.calibration.wheelType)) {
        if (++this.unsettleCount >= 2) {
          this.events.settleT = null;
          this.events.settledPocket = null;
          this.relWindow = [];
          this.settledRel = null;
          this.unsettleCount = 0;
          this.go("bouncing", t);
          return this.state;
        }
      } else {
        this.unsettleCount = 0;
      }
    }

    // Launch detection (from idle or after a settled spin).
    if (this.phase === "idle" || this.phase === "settled") {
      if (fastOnTrack) {
        this.launchStart ??= t;
        if (t - this.launchStart >= o.launchHoldMs) {
          const id = this.events.spinId + 1;
          this.events = emptyEvents(id);
          this.events.launchT = this.launchStart;
          this.clearCounters();
          this.go("track", t);
          this.newSpin = true;
        }
      } else {
        this.launchStart = null;
      }
      return this.state;
    }

    // Abort if the ball has vanished.
    if (this.lastSeen !== null && t - this.lastSeen > o.lostMs && this.phase !== "bouncing") {
      this.events = emptyEvents(this.events.spinId);
      this.clearCounters();
      this.go("idle", t);
      return this.state;
    }
    if (!ball) return this.state;

    const leftTrack =
      ball.phase === "cone" ||
      ball.phase === "pocket-ring" ||
      ball.r < this.calibration.zones.ballTrack.inner;

    if (this.phase === "track") {
      if (leftTrack) {
        this.dropFirstT ??= t;
        if (++this.dropCount >= o.dropFrames) {
          this.events.dropT = this.dropFirstT;
          this.go("descending", t);
        }
      } else {
        this.dropCount = 0;
        this.dropFirstT = null;
      }
    }

    if (this.phase === "descending" || this.phase === "track") {
      if (ball.phase === "pocket-ring") {
        this.rotorFirstT ??= t;
        if (++this.rotorCount >= o.rotorFrames) {
          if (this.events.dropT === null) this.events.dropT = this.dropFirstT ?? this.rotorFirstT;
          this.events.rotorContactT = this.rotorFirstT;
          this.go("bouncing", t);
        }
      } else {
        this.rotorCount = 0;
        this.rotorFirstT = null;
      }
    }

    if (this.phase === "bouncing") {
      if (ball.phase === "pocket-ring" && m.rotor) {
        const rel = angleDiff(ball.theta, m.rotor.zeroAngle);
        this.relWindow.push({ t, rel, pocket: pocketUnderBall });
        while (this.relWindow.length && t - this.relWindow[0]!.t > o.settleHoldMs) this.relWindow.shift();
        const span = this.relWindow.length ? t - this.relWindow[0]!.t : 0;
        if (span >= o.settleHoldMs * 0.9 && this.relWindow.length >= 4) {
          const ref = this.relWindow[this.relWindow.length - 1]!.rel;
          const maxDev = Math.max(...this.relWindow.map((w) => Math.abs(angleDiff(w.rel, ref))));
          if (maxDev < pocketPitch(this.calibration.wheelType) / 2) {
            this.events.settleT = this.relWindow[0]!.t;
            this.events.settledPocket = mode(this.relWindow.map((w) => w.pocket));
            this.settledRel = ref;
            this.unsettleCount = 0;
            this.go("settled", t);
          }
        }
      } else {
        this.relWindow = [];
      }
    }
    return this.state;
  }
}

function mode(xs: (number | null)[]): number | null {
  const c = new Map<number, number>();
  for (const x of xs) if (x !== null) c.set(x, (c.get(x) ?? 0) + 1);
  let best: number | null = null;
  let bc = 0;
  for (const [k, v] of c) if (v > bc) { best = k; bc = v; }
  return best;
}
