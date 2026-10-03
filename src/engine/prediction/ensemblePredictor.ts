/**
 * PredictionEngine: per-frame orchestration of Phase 4.
 *
 *  track phase   → every `cadenceMs`: models A (kinematic) and B (deceleration)
 *                  project the drop; Model C convolves with the learned scatter;
 *                  ensemble mixture → landing probabilities over all pockets.
 *  lock          → when predicted time-to-drop ≤ lead (or at the observed drop,
 *                  per LockRule) the prediction is FROZEN for this spin.
 *  settled 1.5 s → the locked prediction is scored against the measured pocket
 *                  and the spin is added to the wheel profile. Because the
 *                  profile only ever contains earlier spins, live scoring is a
 *                  strictly chronological (walk-forward) evaluation.
 */
import type {
  DropModelOutput,
  FrameMeasurement,
  LockRule,
  MotionState,
  PredictionOutcome,
  PredictionState,
  SessionScore,
  SpinObservation,
  WheelCalibration,
  WheelProfile,
} from "@/types/roulette";
import { angleDiff } from "@/engine/geometry/angles";
import { omegaAt } from "@/engine/physics/decelerationModel";
import { pocketCount, pocketOrder } from "@/engine/wheel/layout";
import { projectDeceleration, projectKinematic, type DropProjectionInput } from "./dropProjector";
import { observedDropOutput, toModelOutput } from "./landingEstimator";
import { addObservation, kernelForIndex, newProfile, omegaCritical, scatterKernel, summarise } from "./wheelProfile";
import { entropyBits, jensenShannon, mixture, normalise, ringDiff, wrapIndex } from "./uncertaintyModel";

export const MODEL_VERSION = "p4-ensemble-0.1";

export interface PredictionEngineOptions {
  lockRule: LockRule;
  samples: number;
  cadenceMs: number;
  /** Time a spin must stay settled before it is scored and learned from. */
  resolveAfterMs: number;
}

const DEFAULTS: PredictionEngineOptions = {
  lockRule: { kind: "lead-time", leadMs: 2000 },
  samples: 800,
  cadenceMs: 100,
  resolveAfterMs: 1500,
};

const emptySession = (n: number): SessionScore => ({
  n: 0, hits: 0, within1: 0, within3: 0, meanLogLoss: 0, baselineLogLoss: Math.log(n), meanBrier: 0, baselineBrier: 1 - 1 / n,
});

interface SpinScratch {
  spinId: number;
  frames: number;
  lastPredT: number;
  live: PredictionState | null;
  locked: PredictionState | null;
  lastTrack: { ballOmega: number; rotorOmega: number; rel: number; fit: MotionState["ballFit"] } | null;
  drop: { omegaAtDrop: number; dropIndex: number; travelIndexSign: 1 | -1 } | null;
  resolved: boolean;
  outcome: PredictionOutcome | null;
}

export class PredictionEngine {
  private opts: PredictionEngineOptions;
  private profile: WheelProfile;
  private readonly n: number;
  private spin: SpinScratch;
  private session: SessionScore;
  /** Set when the profile changed during the last push (caller should persist it). */
  profileChanged = false;

  constructor(
    private readonly calibration: WheelCalibration,
    profile: WheelProfile | null,
    profileKey: string,
    opts: Partial<PredictionEngineOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.n = pocketCount(calibration.wheelType);
    this.profile = profile ?? newProfile(profileKey);
    this.spin = this.freshSpin(0);
    this.session = emptySession(this.n);
  }

  get currentProfile(): WheelProfile {
    return this.profile;
  }

  setLockRule(rule: LockRule): void {
    this.opts = { ...this.opts, lockRule: rule };
  }

  loadProfile(p: WheelProfile | null, key: string): void {
    this.profile = p ?? newProfile(key);
  }

  resetProfile(): void {
    this.profile = newProfile(this.profile.key);
    this.session = emptySession(this.n);
    this.profileChanged = true;
  }

  private freshSpin(id: number): SpinScratch {
    return { spinId: id, frames: 0, lastPredT: -Infinity, live: null, locked: null, lastTrack: null, drop: null, resolved: false, outcome: null };
  }

  private base(status: PredictionState["status"], note: string | null): PredictionState {
    return {
      modelVersion: MODEL_VERSION,
      spinId: this.spin.spinId,
      status,
      note,
      lockRule: this.opts.lockRule,
      generatedAt: null,
      lockedAt: null,
      framesAnalysed: this.spin.frames,
      tDropMs: null,
      timeToDropMs: null,
      sdDropMs: null,
      probs: null,
      dropProbs: null,
      models: [],
      disagreement: null,
      entropyBits: null,
      profile: summarise(this.profile, this.n),
      outcome: this.spin.outcome,
      session: { ...this.session },
    };
  }

  private travelSign(ballOmega: number, rotorOmega: number): 1 | -1 {
    // Sequence index increases along sign·θ; the ball moves along sgn(ωb − ωr) relative to the rotor.
    return (Math.sign(ballOmega - rotorOmega) * this.calibration.pocketSequenceSign >= 0 ? 1 : -1) as 1 | -1;
  }

  private scatterFor(travel: 1 | -1): number[] {
    return kernelForIndex(scatterKernel(this.profile, this.n).kernel, travel);
  }

  private ensemble(models: DropModelOutput[], nowMs: number, frames: number): PredictionState {
    const st = this.base("live", null);
    const w = models.map((m) => m.weight);
    st.models = models;
    st.probs = normalise(mixture(models.map((m) => m.probs), w));
    st.dropProbs = normalise(mixture(models.map((m) => m.dropProbs), w));
    const wsum = w.reduce((a, b) => a + b, 0);
    st.tDropMs = models.reduce((s, m) => s + m.weight * m.tDropMs, 0) / wsum;
    st.sdDropMs = Math.sqrt(models.reduce((s, m) => s + m.weight * (m.sdDropMs ** 2 + (m.tDropMs - st.tDropMs!) ** 2), 0) / wsum);
    st.timeToDropMs = Math.max(0, st.tDropMs - nowMs);
    // Disagreement is measured on the physics (drop) distributions: the shared
    // scatter kernel would otherwise hide model differences.
    st.disagreement = jensenShannon(models.map((m) => m.dropProbs), w);
    st.entropyBits = entropyBits(st.probs);
    st.generatedAt = nowMs;
    st.framesAnalysed = frames;
    return st;
  }

  private predict(m: FrameMeasurement, motion: MotionState): PredictionState | null {
    const ball = motion.ball;
    const rotor = motion.rotor;
    if (!ball || !rotor || ball.status === "lost" || rotor.status === "lost") return null;
    const wc = omegaCritical(this.profile);
    const inp: DropProjectionInput = {
      nowMs: m.t,
      ball,
      rotor,
      rotorFit: motion.rotorFit,
      ballFit: motion.ballFit,
      omegaCritical: wc.mean,
      omegaCriticalSd: wc.sd,
      wheelType: this.calibration.wheelType,
      pocketSequenceSign: this.calibration.pocketSequenceSign,
      samples: this.opts.samples,
      seed: (this.spin.spinId * 7919 + m.seq) >>> 0,
    };
    const scatter = this.scatterFor(this.travelSign(ball.omega, rotor.omega));
    const fit = motion.ballFit;
    const wB = fit ? (fit.valid ? 0.8 : 0.5) : 0;
    const outs: DropModelOutput[] = [];
    const a = toModelOutput(projectKinematic(inp), m.t, this.n, scatter, 1 - wB);
    if (a && 1 - wB > 0) outs.push(a);
    if (fit) {
      const pb = projectDeceleration(inp);
      const b = pb ? toModelOutput(pb, m.t, this.n, scatter, wB) : null;
      if (b) outs.push(b);
    }
    if (!outs.length) return null;
    return this.ensemble(outs, m.t, this.spin.frames);
  }

  private score(pred: PredictionState, actualIndex: number, actualPocket: number): PredictionOutcome {
    const p = pred.probs!;
    let top = 0;
    for (let j = 1; j < this.n; j++) if (p[j]! > p[top]!) top = j;
    const err = ringDiff(actualIndex, top, this.n);
    let brier = 0;
    for (let j = 0; j < this.n; j++) brier += (p[j]! - (j === actualIndex ? 1 : 0)) ** 2;
    return {
      actualPocket,
      actualIndex,
      errorPockets: err,
      hit: err === 0,
      within1: Math.abs(err) <= 1,
      within3: Math.abs(err) <= 3,
      logLoss: -Math.log(Math.max(p[actualIndex]!, 1e-12)),
      baselineLogLoss: Math.log(this.n),
      brier,
      baselineBrier: 1 - 1 / this.n,
    };
  }

  private addToSession(o: PredictionOutcome): void {
    const s = this.session;
    const k = s.n + 1;
    s.meanLogLoss += (o.logLoss - s.meanLogLoss) / k;
    s.meanBrier += (o.brier - s.meanBrier) / k;
    s.n = k;
    if (o.hit) s.hits++;
    if (o.within1) s.within1++;
    if (o.within3) s.within3++;
  }

  push(m: FrameMeasurement, motion: MotionState): PredictionState {
    this.profileChanged = false;
    const sp = motion.spin;
    if (sp.events.spinId !== this.spin.spinId) this.spin = this.freshSpin(sp.events.spinId);
    const S = this.spin;
    S.frames++;

    // Remember the last on-track state: it defines the observed drop.
    if (sp.phase === "track" && m.ball && m.rotor && motion.ball && motion.rotor) {
      S.lastTrack = {
        ballOmega: motion.ball.omega,
        rotorOmega: motion.rotor.omega,
        rel: angleDiff(m.ball.theta, m.rotor.zeroAngle),
        fit: motion.ballFit,
      };
    }
    if (!S.drop && sp.events.dropT !== null && S.lastTrack) {
      const lt = S.lastTrack;
      // Effective ω_c: the deceleration LAW's |ω| at the observed drop time. Using
      // it makes Model B reproduce the observed drop time exactly, absorbing
      // the gap between "law stops applying" and "ball visibly leaves the track".
      const f = lt.fit?.valid ? lt.fit : null;
      const wLaw = f ? Math.abs(omegaAt(f, f.omega0, (sp.events.dropT - f.t0) / 1000)) : 0;
      S.drop = {
        omegaAtDrop: wLaw > 0 ? wLaw : Math.abs(lt.ballOmega),
        dropIndex: wrapIndex((this.calibration.pocketSequenceSign * lt.rel * this.n) / (2 * Math.PI), this.n),
        travelIndexSign: this.travelSign(lt.ballOmega, lt.rotorOmega),
      };
      // Lock at the observed drop (rule "drop", or a late lock if the lead lock never fired).
      if (!S.locked) {
        const out = observedDropOutput(S.drop.dropIndex, 0.3, m.t, this.n, this.scatterFor(S.drop.travelIndexSign));
        const st = this.ensemble([out], m.t, S.frames);
        st.status = "locked";
        st.lockedAt = m.t;
        st.note =
          this.opts.lockRule.kind === "drop"
            ? "Locked at the observed drop: scatter-only prediction."
            : "Lead-time lock was not reached before the drop; locked at the observed drop instead.";
        S.locked = st;
      }
    }

    // Resolve: score the locked prediction and learn from the spin.
    if (!S.resolved && sp.phase === "settled" && m.t - sp.since >= this.opts.resolveAfterMs && sp.events.settledPocket !== null) {
      const order = pocketOrder(this.calibration.wheelType);
      const actualIndex = order.indexOf(sp.events.settledPocket);
      if (S.locked?.probs && actualIndex >= 0) {
        S.outcome = this.score(S.locked, actualIndex, sp.events.settledPocket);
        this.addToSession(S.outcome);
      }
      if (S.drop && actualIndex >= 0) {
        const obs: SpinObservation = {
          spinId: S.spinId,
          omegaAtDrop: S.drop.omegaAtDrop,
          dropIndex: S.drop.dropIndex,
          finalIndex: actualIndex,
          offsetAlongTravel: S.drop.travelIndexSign * ringDiff(actualIndex, S.drop.dropIndex, this.n),
          travelIndexSign: S.drop.travelIndexSign,
        };
        this.profile = addObservation(this.profile, obs);
        this.profileChanged = true;
      }
      S.resolved = true;
    }

    if (S.locked) {
      return { ...S.locked, status: S.resolved ? "resolved" : "locked", outcome: S.outcome, session: { ...this.session }, profile: summarise(this.profile, this.n), framesAnalysed: S.frames };
    }

    if (sp.phase !== "track") return S.live ?? this.base("waiting", sp.phase === "idle" ? "Waiting for a launch." : null);

    if (m.t - S.lastPredT >= this.opts.cadenceMs) {
      S.lastPredT = m.t;
      const p = this.predict(m, motion);
      if (p) S.live = p;
    }
    const live = S.live;
    if (!live) return this.base("waiting", "Collecting track measurements…");
    const rule = this.opts.lockRule;
    if (rule.kind === "lead-time" && live.timeToDropMs !== null && live.tDropMs !== null && live.tDropMs - m.t <= rule.leadMs) {
      S.locked = { ...live, status: "locked", lockedAt: m.t, note: null };
      return S.locked;
    }
    return { ...live, timeToDropMs: live.tDropMs !== null ? Math.max(0, live.tDropMs - m.t) : null, framesAnalysed: S.frames };
  }
}
