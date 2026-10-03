# SpinSight: Design Document & Handoff

_Last updated: 3 Oct 2026 · State: Phases 1–5 complete plus the results dashboard (default screen); Phase 6 next · Model version tag: `p4-ensemble-0.1`_

This document is the single source of truth for continuing the project in a new session or by a new engineer. Read it together with `CLAUDE.md` (working rules) and `README.md` (run/deploy).

---

## 1. Purpose & scope

SpinSight is a browser app that **measures** a roulette wheel from a camera or video (the ball and rotor angles, angular velocity and deceleration). From Phase 4 it will **estimate** a probability distribution over landing pockets using physics models calibrated on recorded spins. Every prediction is backtested against the uniform baseline (1/37 European, 1/38 American).

**Use boundary (non-negotiable):** the app is a research and education tool for a privately owned wheel, recorded video, or the built-in synthetic wheel. Using a prediction device at a casino table is a criminal offence in Queensland (Casino Control Act 1982 s.103), NSW and most jurisdictions. The UI states this on the Limitations page. Do not add features aimed at covert or in-casino use, such as hidden UI, wearable or remote signalling, bet sizing against live tables, or audio/vibration outputs.

**Honesty requirements:**
- Measurements, simulated estimates and statistical predictions are labelled separately in the UI and the data.
- Never claim guaranteed accuracy. Always show the uniform baseline next to model metrics.
- Illustrative numbers never appear as real output.

---

## 2. Stack & hosting (all free)

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript strict (`noUncheckedIndexedAccess`) | `next.config.ts` sets `Permissions-Policy: camera=(self)` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`), dark theme tokens in `globals.css` | Custom classes: `.panel`, `.panel-title`, `.btn-primary`, `.btn-ghost`, `.input`, `.num` (`btn` is an `@utility`) |
| Auth | One hardcoded user, checked in the `/api/auth/login` route (Node runtime, constant-time compare) and stored as a signed HS256 JWT cookie via `jose`. `src/middleware.ts` protects everything except `/login` and `/api/auth/login`. | Environment variables `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET`. Dev fallback is `admin` / `spinsight`. |
| Local storage | IndexedDB via `idb-keyval` | Active calibration key: `spinsight:calibration:active` |
| Database | Supabase Postgres (free tier) from Phase 6 | Schema is in `supabase/migrations/0001_init.sql`. RLS is enabled with no anonymous policies. |
| Hosting | Vercel Hobby (Cloudflare Pages as an alternative) | HTTPS is required for the camera |
| Tests | Vitest (`npm test`) | The suites also run under `node:test` through a shim, because the build sandbox had no npm access |
| Planned | `@dimforge/rapier3d-compat` (Phase 5), `matter-js` (Phase 5) | OpenCV.js is optional. The current vision code is plain TypeScript and needs no OpenCV. |

---

## 3. Global conventions (must be preserved)

- **Angles:** radians. Wrapped angles are in (−π, π]. In the rectified wheel frame θ = 0 points along +x, and **θ increases counter-clockwise as seen on screen** (image y is flipped: `θ = atan2(-uy, ux)`).
- **Radii:** normalised so the outer edge of the ball track = **1.0**. Default zones (`DEFAULT_ZONES`) are user-adjustable:
  - ball track 0.86–1.00
  - deflector cone 0.72–0.86
  - pocket ring 0.58–0.72
- **Rotation sign:** `+1` = counter-clockwise on screen, `−1` = clockwise.
- **Pocket sequence:** `pocketSequenceSign` is the direction the printed sequence (0, 32, 15, … European) runs on screen. Pocket index `k` has its centre at `zeroAngle + sign·k·2π/N`. `00` is stored as **−1**.
- **Absolute angle offset is arbitrary.** The rectification has an unknown in-plane rotation. Only angles **relative to the rotor's zero pocket** (same frame) are physically meaningful. Every downstream model must work in ball-relative-to-rotor terms, or use differences of angles.
- **Time:** milliseconds on a monotonic clock only. `Date.now()` is never used for motion. Sources:
  - `media-time`: `requestVideoFrameCallback` `mediaTime` for files. This is the true physical time even at 0.25× playback.
  - `capture-time`: the camera's `captureTime` when the browser provides it.
  - `performance-now`: fallback.
  - `synthetic`: simulation time.
- **Raw data is never overwritten.** `FrameMeasurement` (per frame) is kept verbatim. Derived and filtered values live in separate structures (`DerivedState`, and the Phase 3 filter output).
- **Determinism:** randomness goes through seeded PRNGs (`mulberry32`). Simulations and backtests must be reproducible from a seed.

---

## 4. Architecture

```
            ┌──────────── main thread (React) ─────────────┐
 camera/file/synthetic ─► FrameSource (rVFC / rAF, timestamps, seq)
                │  createImageBitmap (≤1 frame in flight; extras counted as dropped)
                ▼
        tracking.worker.ts ── OffscreenCanvas (processing width 640) ─► RGBA
                │  WheelTracker.process(frame, tMs)
                │    1. PolarGrid(stationary bowl 720θ×8r)  → StationaryBallTracker (EMA background)
                │    2. PolarGrid(pocket ring 360θ×4r, 3 colour channels) → RotorTracker (template xcorr)
                │    3. residual vs rotated rotor template → ball on rotor
                ▼
        FrameMeasurement ─► MotionEstimator (in worker)
                              ├─ RawKinematics (unwrap + windowed LSQ ω) ─► DerivedState (unfiltered)
                              ├─ AngleKalman ×2 (ball, rotor) [θ, ω, α] ─► FilteredAngle
                              ├─ SpinPhaseMachine ─► idle/track/descending/bouncing/settled + events
                              └─ fits every 250 ms: ball a,b (LM on θ), rotor ω0,α (quadratic LSQ)
                          └► PredictionEngine (in worker): models A/B drop projection (seeded Monte Carlo)
                               ⊛ learned scatter (Model C) → ensemble → lock → score at settle → learn
        main thread ◄─ {measurement, motion: MotionState, prediction: PredictionState}; TimingStats
        UI: SourceView + drawLiveOverlay, MeasurementPanel, MotionGraph, JSON export
```

### 4.1 Key modules

| File | Responsibility |
|---|---|
| `src/types/roulette.ts` | All shared types: calibration, measurements, worker messages, `SpinRecord` |
| `engine/geometry/angles.ts` | wrap, unwrap (`AngleUnwrapper.push(wrapped, predictedStep)`), diff |
| `engine/geometry/ellipse.ts` | `fitEllipse` (affine), `fitWheelRectification(rim, hub)` (projective + affine), `imageToWheel`, `wheelToImage`, `scaleRectification` |
| `engine/wheel/layout.ts` | Pocket orders, colours, `pocketAtAngle`, `pocketCentreAngle`, `neighbours` |
| `engine/vision/polarSampler.ts` | `PolarGrid` (precomputed LUT, 2×2 supersampling), robust stats, circular smoothing |
| `engine/vision/rotorTracker.ts` | `buildRotorReference`, `RotorTracker.track(sample, predictedShift)`, `residual` |
| `engine/vision/ballTracker.ts` | `findBlob` (θ×r foreground → candidate with SNR), `StationaryBallTracker` |
| `engine/vision/pocketDetector.ts` | Calibration helpers: `suggestZeroPocket` (greenest sector), `suggestSequenceSign` (red/black match) |
| `engine/vision/wheelDetector.ts` | `DEFAULT_ZONES`, grid builders, `createCalibration`, `assessCalibration` |
| `engine/vision/frameProcessor.ts` | `WheelTracker`: per-frame pipeline and rotor-lock state machine |
| `engine/tracking/angularVelocity.ts` | `RawKinematics`, `TimingStats`, `regressionSlope` |
| `engine/tracking/kalmanFilter.ts` | `AngleKalman` (CA model, wrapped innovation, χ² gate, gaps, `epoch`), `rtsSmooth`, `nees`, `m3` 3×3 helpers |
| `engine/tracking/accelerationEstimator.ts` | `fitDeceleration` (Levenberg–Marquardt on closed-form θ(t), log-params, SEs), `fitRotor` |
| `engine/tracking/spinPhase.ts` | `SpinPhaseMachine`: launch, drop, rotor contact, settle (can revert), settled pocket |
| `engine/tracking/motionEstimator.ts` | `MotionEstimator`: orchestrates all of the above per frame and emits `MotionState` |
| `engine/physics/decelerationModel.ts` | Closed form ω(t), θ(t), stop time, time to reach a given ω |
| `engine/math/linalg.ts` | `solve`, `invert`, `ols` |
| `engine/math/random.ts` | `mulberry32` (re-exported by the synthetic module) |
| `engine/prediction/dropProjector.ts` | Model A (kinematic) and B (deceleration) drop projections with seeded Monte Carlo |
| `engine/prediction/landingEstimator.ts` | Model C: drop cloud ⊛ scatter kernel → landing probabilities; observed-drop variant |
| `engine/prediction/wheelProfile.ts` | Learned ω_c and scatter (von Mises KDE + uniform prior, pseudo-count 8); geometry default ω_c |
| `engine/prediction/ensemblePredictor.ts` | `PredictionEngine`: cadence, ensemble, lock rules, scoring, walk-forward learning |
| `engine/prediction/uncertaintyModel.ts` | Ring histograms, circular convolution, JS divergence, entropy, circular stats |
| `engine/synthetic/measurementSimulator.ts` | Fast FrameMeasurement streams from ground truth (no rendering) for multi-spin tests |
| `lib/storage/profileStore.ts` | IndexedDB persistence of wheel profiles (key `calibrationId:real` or `:synthetic`) |
| `components/PredictionPanel/PredictionPanel.tsx` | Prediction UI: top pockets vs baseline, lock point, profile, session score |
| `engine/synthetic/syntheticWheel.ts` | Deterministic spin generator (`SyntheticSpin`), camera model, software renderer, ground-truth calibration clicks |
| `workers/tracking.worker.ts` | Worker wrapper; checks the aspect ratio against the calibration |
| `lib/frameSource.ts` | `VideoFrameSource`, `SyntheticFrameSource`, `captureStill` |
| `hooks/useFrameSource.ts`, `hooks/useTracking.ts` | Source lifecycle, camera errors, worker pump, history buffer (6000 samples) |
| `components/*` | `CalibrationWizard`, `LiveAnalysis`, `SourceView`, `SourcePicker`, overlay `draw.ts`, `MeasurementPanel`, `MotionGraph`, `AppShell` |

### 4.2 Pages

| Route | State |
|---|---|
| `/login` | done |
| `/dashboard` | done; shows calibration status and phase progress |
| `/calibration` | done; 7-step wizard plus synthetic auto-fill |
| `/live-analysis` | done; tracking, overlay, graphs, export |
| `/limitations` | done |
| `/history` | placeholder (Phase 6) |
| `/simulation` | placeholder (Phases 5 and 8) |

---

## 5. Algorithms implemented (Phases 1–2)

### 5.1 Rectification
1. Least-squares conic fit `Ax²+Bxy+Cy²+Dx+Ey=1` in centred and scaled coordinates (needs at least 5 rim points).
2. **Projective step** (when a hub is clicked): the hub's polar line `l = C·hub` with respect to the rim conic is the image of the line at infinity. Map `p̃ = p − hub` to `p' = p̃ / (1 + l1·p̃x + l2·p̃y)`. After this the rim is an exact ellipse centred on the hub. If the correction is implausible (`max|l·p̃| > 0.35`), it falls back to affine only.
3. **Affine step:** the ellipse becomes the unit circle via the symmetric `Q^{1/2}`. The inverse uses `Q^{-1/2}`.
4. Quality checks:
   - RMS rim residual (warn above 2%)
   - axis ratio (warn below 0.55)
   - hub offset against the affine-only fit (warn above 8%, a sign of strong perspective)
   - frame coverage
   - wheel size in pixels (warn when the semi-minor axis is under 120 px)

### 5.2 Rotor tracking
- The template is the pocket ring sampled at calibration into 360 θ bins × 4 r bins with three channels: luma, redness `R−(G+B)/2`, greenness `G−max(R,B)` (green weighted 1.5).
- Each frame runs a circular cross-correlation of the z-normalised radial-mean profiles. The zero angle is `zeroAngleAtReference + shift·2π/360`, with parabolic sub-bin refinement.
- **Alias-safe locking:** red/black alternation makes a shift of 2 pockets nearly as good as the true one. The search is confined to ±0.9 pocket around the prediction only after **two consistent rate observations** (`rateSamples ≥ 2`). A global peak more than 10% higher (`relockRatio = 1.1`) forces re-acquisition. Gaps over 500 ms reset the lock.
  - _Bug history:_ the first version locked before the rate was known and drifted by 19.5° per frame at about 8 fps. This was fixed and is covered by the 10 fps test.

### 5.3 Ball detection
- **Stationary bowl** (track plus cone): a per-cell exponential background (α = 0.08). Cells within 3 ball-widths of the detection are frozen so the ball isn't absorbed into the background. The foreground is the positive luma difference.
- **Rotor:** the ball is the positive residual of current luma minus the template rotated by the measured shift, with gain and offset compensated.
- `findBlob`: max over r, circular smoothing over about one ball width, SNR = (peak − median)/(1.4826·MAD), then a weighted centroid in θ and r.
- Thresholds: SNR ≥ 6 and contrast ≥ 18 luma levels. If both zones qualify, the higher SNR wins.
- Phase is `pocket-ring` (rotor zone), `track` (r ≥ ballTrack.inner), `cone`, or `lost`.

### 5.4 Raw kinematics
- Unwrapping uses the previous ω × Δt as the predicted step, so it stays alias-free up to |ωΔt| ≈ 1.5π.
- ω is the least-squares slope over a 120 ms window. A gap over 250 ms resets that track.
- This is deliberately unfiltered. Phase 3 adds the filter alongside it, not in place of it.

### 5.5 Kalman filtering (Phase 3)
- **State:** `[θ, ω, α]`, constant-acceleration model with white-jerk process noise.
  - ball: q = 4 (rad²/s⁵), scaled ×25 on the cone and ×200 on the rotor
  - rotor: q = 0.02
- **Measurement:** the wrapped θ, with innovation `angleDiff(z, θ̂)`. Measurement variance is R = σ²/conf² (σ = 0.006 rad for the ball, 0.004 for the rotor; confidence is floored at 0.2).
- **Outlier gate:** χ²(1) at 6.63. Four consecutive rejections trigger re-initialisation.
- **Gaps:** a gap over `maxGap` (ball 0.4 s, rotor 1 s) re-initialises θ but keeps ω and α.
- **`epoch` counter:** increments on every re-initialisation, because unwrapped θ jumps there. Fit buffers are cleared on a new epoch.
- **RTS smoother:** for offline use. It doesn't smooth across re-initialisations, which are detected by `F[1] === 0`.

### 5.6 Deceleration & rotor fits (Phase 3)
- **Ball:** the model is `ω̇ = −(a + bω²)·sgn ω`.
  - Fitted directly to the **measured unwrapped θ** (accepted Kalman measurements), so noise isn't amplified by differentiation.
  - Method: Levenberg–Marquardt with a numerical Jacobian. Parameters `[θ0, ω0, ln a, ln b]`, initialised from a quadratic fit.
  - Standard errors for a and b by the delta method.
  - A fit is `valid` when the span is at least 1 s and the relative SEs are under 50%.
  - a and b are strongly anti-correlated (about −0.99), so short windows leave them uncertain; the projected drop time is far better determined than either.
  - Runs every 250 ms on at most 360 decimated samples, which takes under 30 ms in the worker.
- **Rotor:** quadratic least squares over the last 6 s.

### 5.7 Spin-phase machine (Phase 3)
- `idle → track`: ball on the track with |ω| > 3 rad/s held for 150 ms.
- `track → descending`: two frames off the track (cone, pocket ring, or r below the track's inner edge). `dropT` is the first of those frames.
- `→ bouncing`: two frames on the pocket ring.
- `→ settled`: the ball's angle relative to the rotor stays within ±½ pocket for 600 ms. The settled pocket is the most frequent pocket under the ball in that window.
- `settled → bouncing`: the ball moves more than ½ pocket from its settled position for 2 frames (a late hop).
- `→ idle`: the ball is unseen for 1.5 s (not applied while bouncing).
- A new launch from `settled` or `idle` increments `spinId`.

### 5.8 Prediction (Phase 4)
- **When it runs:** every 100 ms while the spin phase is `track`.
- **Model A:** samples the Kalman ball and rotor states. It drops when |ω| = ω_c under constant α.
- **Model B:** samples (ln a, ln b) jointly normal using the fit SEs and correlation. The ball's ω now comes from the fitted law. Drop time comes from `timeToOmega`, and the drop angle from `thetaAt`.
- **Rotor (both models):** extrapolated with its Kalman θ and ω and the fitted α. It stops at rest rather than reversing.
- **Monte Carlo:** 800 samples per model, seeded by (spinId, frame seq). ω_c is sampled from the profile.
- **Model C (scatter):** the drop cloud is histogrammed over pocket-sequence indices, then circularly convolved with the scatter kernel. The kernel is mapped from "pockets along the ball's travel relative to the rotor" into index direction.
- **Ensemble weights:** A 0.2 / B 0.8 when the fit is valid; 0.5/0.5 when it's provisional; A alone with no fit. Phase 7 will learn these.
- **Disagreement:** Jensen–Shannon divergence on the **drop** distributions, because the shared scatter would otherwise hide differences.
- **Lock rules:**
  - `lead-time` (default 2 s): freezes when tDrop − now ≤ lead.
  - `drop`: locks at the observed drop, giving a scatter-only prediction.
  - If the lead lock is never reached, it locks late at the observed drop and says so.
- **Resolve:** once settled for at least 1.5 s, the locked prediction is scored (hit, ±1, ±3, log loss, Brier, each against the uniform value). Then the spin is added to the profile. **The profile only ever contains earlier spins**, so live scores are walk-forward.
- **Effective ω_c:** the deceleration law's |ω| at the observed drop time, not the Kalman ω. This makes Model B reproduce the observed drop time. An early version used the Kalman ω, which put the projected drop 12 pockets off on average; the fix brought it down to 1.8.
- **No history:** the scatter kernel is uniform, so the landing distribution is exactly 1/N. This is tested.

### 5.9 Results dashboard (default screen, `/dashboard`)
- **Layout (kept deliberately simple, as requested):**
  - the results text area, which auto-saves with a 400 ms debounce
  - a **Clear** button at the right end of the header
  - one **Guess** button
  - then **one row of 10 numbers per algorithm or pattern**, shaded dark green (strongest) → dark red (weakest) within that row. Default row order: Physics, Kinematic, Rapier, Matter, Combined, Hot numbers, Sequence pattern.
  - **Reordering:** hold the ⠿ handle and drag a row to move it. This uses pointer events, so it works with touch on phones; arrow keys also work. The order is saved in localStorage.
  - **Mobile first:** 375 px layout with each row's ten numbers on a single line (about 32 px tiles at 375 px wide), 40 px touch handles, and a Guess button that sticks to the bottom of the screen on phones. The normal keyboard is kept because results need spaces.
- **Instant guesses** (an earlier version took 10–30 s per guess):
  - Each engine's **offset kernel** K[d] = P(next = previous + d) is computed **once per settings**: launches come from random start pockets and only the landing offset is kept. The kernels are computed in **three parallel workers** (`engineKernel.worker.ts`) in the background as soon as the page or Settings change, and cached in localStorage under a settings key.
  - A guess then just rotates each cached kernel to the last result (`viewFromKernel`).
  - The quick physics kernel is memoised per settings with a fixed seed (`KERNEL_SEED`), so guesses are deterministic.
  - Measured on your Mac: about 100 ms from pressing Guess to all seven rows.
  - a single honesty line with the verdict and the 1/N baseline
  - **No** wheel dropdown on the dashboard: the wheel comes from Settings, defaulting to the guide's single-zero wheel. **No** run-again, copy, top-10 detail or update-results sections.
- **Inputs:** results typed oldest → newest, validated per wheel (European 0–36, American plus 00, triple zero plus 00 and 000; 00 = −1, 000 = −2). Invalid tokens are highlighted in place with a mirrored backdrop and explained.
- **Guess** runs `historySim.worker.ts` → `predictFromHistory`, which combines four models by **Bayesian model averaging, using walk-forward (prequential) likelihood on the user's own history**:
  1. **uniform**
  2. **frequency:** Dirichlet(1) on pocket counts, i.e. wheel bias
  3. **sequence-offset:** Dirichlet(1) on the wheel distance between consecutive results, i.e. release signature
  4. **physics-release:** seeded Monte Carlo. The ball is released from the previous result's pocket with the configured launch and rotor speed spreads, the deceleration law to the drop speed, a deflector hit, and fret bounce, giving a kernel over offsets.
- **Computed but not displayed:** the χ² uniformity test, 2·ln BF evidence against uniform, and per-model walk-forward log loss and top-10 rate. These are still in `HistoryPrediction` and drive the verdict text. (`PredictionResults.tsx` keeps the reusable heat-colour and tile helpers.)
- **Honest behaviour (tested):**
  - fair 1000-spin histories stay within 1.25× of uniform with no-evidence or weak verdicts
  - a 3×-biased pocket over 2000 spins is detected as strong and ranked #1
  - a synthetic +10-pocket signature is detected
  - with realistic launch-speed spread the physics kernel is within 15% of uniform (about 250 pockets of relative travel)
- **Settings page** (`/settings`, localStorage): defaults live in `src/config/roulette-defaults.json`, taken from the venue's Roulette guide. Single-zero 0–36 (37 pockets) is standard and 00 is the variant; ball and wheel spin in opposite directions; house margin 2.70% and 5.26% (RTP 97.30% and 94.74%) shown for reference. Physics speeds are generic assumptions, because the guide gives none.
- **Three physics-engine rows** (`engine/history/engineRelease.ts`):
  - Kinematic, Rapier.js and Matter.js each simulate full spins launched from the last result's pocket (± release jitter), with launch, wheel and drop speeds sampled from Settings. Each run continues until the ball settles in a number.
  - Defaults are 400 / 60 / 120 spins per guess; they're computed in the worker and streamed to the page as each engine finishes.
  - A newer guess cancels an older one (`runId`).
  - Each row shows the engine's 10 most frequent landing numbers. The full `EngineView` (settled count, long-roll share, drop and landing times) is kept in localStorage. These are simulation only and aren't scored against the history.
- **Long roll:** the ball sometimes keeps rolling before it drops into a number.
  - In the quick physics model: with probability `longRollProb` (default 0.15), extra travel ~ Exponential(`longRollMeanPockets` = 30) is added.
  - In the engines it happens physically; a run counts as a long roll when ≥ 2.5 s pass between leaving the track and landing in a number.
  - Both settings are editable in Settings.
- **Ball/wheel direction** is a switch in Settings (ball ↻ or ↺, wheel the opposite way). It's static wheel configuration, not a per-spin input.
- **Deliberately not built:** live entry of the ball's start position or spin direction during a spin for in-casino use (see the use boundary in §1). The `feat/spin-detection-settings` branch on GitHub (commit 0cd1e06, user-authored) adds such inputs. It was not merged or extended. For your own wheel, the camera tracker already measures the start position and both directions automatically.

### 5.10 Simulation adapters & lab (Phase 5)
- **Shared scene** (`engine/physics/rouletteScene.ts`), 2-D top-down in SI units:
  - rim 0.40 m, ball 21 mm, track inner 0.34, deflector ring 0.29 (n diamonds), pocket ring 0.23 → turret 0.18 with N frets
  - **Slopes are forces:** an inward pull of g·tanδ (track 30°, cone 45°: with 35° every ball circled the cone for about 3.9 s, while 45° gives a realistic 0.6–1.3 s from drop to landing). The ball rides the rim while v²/r > g·tanδ and leaves by itself, so ω_c = √(g·tanδ/r) emerges. Tested within 10%.
  - The bowl applies the law r·(a + bω²) as a tangential deceleration. The rotor drags the ball toward its surface velocity.
  - The rim is a **shared smooth-wall constraint** that keeps speed. A polygonal rim collider caused "ghost" bounces at segment joints in both engines (ball off the track within 20 ms), and projecting the velocity added a spurious ω³·dt/2 deceleration. Both were fixed this way.
- **Adapters, each run separately on identical parameters:**
  - `trajectoryModel.ts`: kinematic reference with idealised deflector and fret rules (about 3 ms per spin)
  - `rapierEngine.ts`: `@dimforge/rapier2d-compat` 0.21; fixed deflectors, a kinematic velocity-based rotor (turret disc + frets), CCD on the ball (about 100–400 ms per spin)
  - `matterEngine.ts`: `matter-js` 0.20; 1 m = 1000 units, velocities in units per base step, the rotor a static compound rotated with `updateVelocity` so the solver sees the moving surface (about 35–90 ms per spin)
- **Engine differences observed (seed 11, 40 runs each):**
  - kinematic and Matter leave the track at 12.37 ± 0.16 s; Rapier at 13.09 ± 0.16 s, staying on the wall about 0.7 s longer because ω differs by about 2% near ω_c
  - every run settled in all three engines
  - the landing distributions are noisy and near-uniform with random launch phases, as expected
- **Accuracy limit:** the time-stepping error is first-order in dt, about 1.4% in ω after 6 s at dt = 1/480 s.
- **`/simulation` page:**
  - parameters saved in localStorage
  - side-by-side top-down replays with a shared timeline
  - ω(t) for each engine
  - batch comparison with landing histograms, drop-time spread and the Jensen–Shannon disagreement between engines
  - runs in `simulation.worker.ts`
- **Tests:**
  - `tests/physics.test.ts` (kinematic, runs anywhere)
  - `tests/engines.test.ts` (Rapier and Matter: law within ±2%, drop near ω_c, settles), which needs the packages installed

### 5.11 Synthetic wheel (test oracle)
- **Camera:** in-plane rotation, foreshortening, and an optional projective term.
- **Spin generator:**
  - track phase: `ω̇ = −(a + bω²)·sgn ω` with a = 0.3 and b = 0.011
  - drop at |ω| < 5.2 rad/s
  - 0.9 s descent with a seeded deflector hit
  - 1.2–2 s of bouncing in the rotor frame
  - snap into a pocket
  - rotor: ω0 = 2.2 rad/s, α = −0.035 rad/s²
- Software renderer with frets, number band, deflectors, a lighting gradient and noise.
- This generator is **not** the prediction model and must not be used to tune it on real data.

---

## 6. Verification status

Automated: **84 tests pass** in the cloud workspace (incl. `tests/history`, `tests/physics`), plus **6 engine tests** (`tests/engines`) run against Rapier.js and Matter.js from your installed packages (`tests/angles`, `layout`, `ellipse`, `tracking`, `kalman`, `deceleration`, `motion`, `prediction`). End-to-end synthetic scenarios:

| Scenario | Rotor err p95 | Ball-rel-rotor err p95 | Track detection | Settled pocket |
|---|---|---|---|---|
| Affine camera, 60 fps | < 1° | ~0.3° (track), ≤ 1.2° (bounce/settled) | > 99% | correct |
| Perspective 0.12 + oblique, 30 fps | < 1° | ~0.35° (track) | ~98% | correct |
| 10 fps (rotor > 1 pocket/frame) | < 1° | < 2° | > 95% | correct |

**Phase 3 results** (synthetic):

| Check | Result |
|---|---|
| Kalman ball ω (60 / 30 / 10 fps, σ = 0.3°) | 0.50 / 0.57 / 0.63% relative RMS error |
| Kalman ball α | about 0.27 rad/s² RMS; use the physical fit for deceleration instead |
| Filter consistency | NEES on (θ, ω): 1.0–1.8 for 2 degrees of freedom, so consistent |
| Deceleration fit, full track phase | a = 0.299 ± 0.001 (true 0.30), b = 0.0110 (true 0.011) |
| Deceleration fit, first 4 s at 30 fps | drop time projected within 0.3% |
| Spin-phase detection | observed drop within 2 ms of the true track exit; settled pocket correct in all scenarios, including a mid-bounce pause followed by a hop |
| Headless Chromium, full spin through the worker at about 9 fps | settled pocket 25 = truth; a = 0.300, b = 0.0110; median Kalman ω error 0.37% |

**Phase 4 results** (walk-forward over 50 simulated spins of one synthetic wheel; a learned profile of earlier spins only, locked 2 s before the drop):

| Check | Result |
|---|---|
| Spin 1, no history | landing distribution exactly uniform |
| Projected drop pocket, 2 s ahead (physics only) | mean error about 1.8 pockets |
| Out-of-sample spins 21–50: log loss | 3.51 vs 3.61 uniform (60-spin exploratory run) |
| Out-of-sample spins 21–50: within ±3 pockets | 19/40 vs 7.6 expected under uniform (exploratory run) |
| Lead lock happens before the observed drop | more than 90% of spins |
| Determinism | same seed gives identical probabilities |
| Headless Chromium, full spin through the worker | lock, resolve and profile learning work; spin 1 locked late, as expected with the geometry-default ω_c |

**This is a synthetic wheel whose bounce physics is a toy.** These numbers prove the pipeline learns and is scored honestly. They say nothing about a real wheel, where the scatter may be far wider and the edge zero or negative.

Caveat: the synthetic generator uses the same deceleration law as the fit, so these numbers show the estimator is **correct**, not that the law holds for a real wheel. Phase 6/7 data will test that.

- **Real browser (headless Chromium):** the worker pipeline was exercised on the synthetic source and on a MediaRecorder WebM played through `VideoFrameSource` (media-time clock). There were no errors and the 95th-percentile error was 0.33°.
- **Not yet verified:**
  - **`next build` and the React pages** have not been run. The sandbox had no npm access, and the UI was only typechecked against approximate shims. The first job in a new session is to run `npm install`, `npm run typecheck`, `npm test` and `npm run build` and fix whatever comes up.
  - Real-camera performance (blur, glare, compression, cone geometry).

---

## 7. Known issues & limitations

1. Raw ω is still noisy, but it is now only a comparison stream; the Kalman estimate is the primary value. Kalman α is noisy too (about 0.27 rad/s²), so use the physical fit for deceleration.
2. The synthetic renderer runs on the main thread and is slow on weak CPUs (about 9 fps in the sandbox). Consider moving it to a worker.
3. Perspective correction is only as good as the hub click (the loupe helps). A cone-shaped (non-planar) wheel adds residual error, which is smallest with an overhead camera.
4. Specular highlights on the track can produce false ball detections. Consider a shape or size test and a temporal-consistency gate (Phase 3 innovation gating).
5. Calibration is tied to the camera pose and aspect ratio. The worker errors if the aspect ratio differs by more than 2%. Any camera movement requires recalibration.
6. There is no `package-lock.json` yet; commit one after the first install. `src/lib/supabase/` is empty (Phase 6).
7. The ball template assumes a white ball on a darker track.
8. The spin-phase thresholds (launch 3 rad/s, 600 ms settle, ±½ pocket) are tuned on synthetic data and need checking on real footage.
9. `processingMs` covers vision only; estimator time (up to about 30 ms on fit frames) is not included in it.

---

## 8. Roadmap with specs

### Phase 3: Filtering & motion estimation (DONE; spec kept for reference)
- `engine/tracking/kalmanFilter.ts`: a generic linear Kalman filter. Two instances, ball and rotor, with state `[θ, ω, α]` and a constant-acceleration model.
  - **Process noise:** white jerk q, tuned separately for ball and rotor.
  - **Measurement:** θ only, with variance R = σ²/confidence², where σ ≈ 0.3° for the ball and 0.2° for the rotor (from the synthetic results).
  - **Wrap handling:** the innovation is `angleDiff(z, Hx)` and the state stays unwrapped.
  - **Gaps:** predict only, with no update. Mark the track lost after 300 ms.
  - **Innovation gating:** χ² test at 99%; reject outliers and count them.
  - An RTS smoother for offline (history) use.
- `accelerationEstimator.ts`: fit `ω̇ = −(a + bω²)` by linear regression of α̂ on ω̂² over the track phase, giving a and b with standard errors. Rotor: linear α.
- **UI:**
  - show filtered and raw values side by side
  - α readouts and an angular-acceleration graph
  - spin-phase state machine: idle → launched → track → descending → bouncing → settled
  - a "spin detected" auto start and stop
- **Tests:**
  - filter consistency (NEES) on synthetic data
  - a, b recovered within 10% of the generator values
  - gap handling

### Phase 4: Prediction models (A–C) + ensemble (DONE; spec kept for reference)
Building blocks already in place: `decelerationModel.ts` (`timeToOmega`, `thetaAt`), `BallDecelerationFit` (a, b, ω0 and their SEs), `RotorMotionFit`, and the observed `dropT` and `settledPocket` from `SpinPhaseMachine`. These provide the training data for ω_c and the scatter distribution.
- **Model A, kinematic:** constant α extrapolation of θ_ball − θ_rotor.
- **Model B, deceleration:**
  - closed form for `ω̇ = −(a+bω²)`, with φ0 = atan(ω0√(b/a)):
    - `ω(t) = √(a/b)·tan(φ0 − √(ab)·t)`
    - `θ(t) = θ0 + (1/b)·ln[cos(φ0 − √(ab)t)/cos φ0]`
  - **Drop condition:** |ω| ≤ ω_c, with ω_c² = g·tanδ/R_track. ω_c is calibrated per wheel from observed drop events (the history median).
  - The rotor at the drop time t_d is `θr0 + ωr0 t_d + ½αr t_d²`. Drop angle relative to the rotor gives the drop pocket.
- **Model C, stochastic landing:** an empirical circular distribution of the offset (final pocket index − drop pocket index), learned from history with a von Mises kernel density. Until there are at least N spins, use a wide prior that is close to uniform. Convolve it with the drop-angle uncertainty (propagated from Kalman covariance by sampling 2000 seeded Monte Carlo draws of a, b, ω_c and the states).
- **Ensemble:** a weighted mixture with weights from out-of-sample log-loss (Phase 7). Report model disagreement as the Jensen–Shannon divergence.
- **Outputs:**
  - a full 37/38-pocket probability vector
  - the top pocket and its neighbours
  - time to drop and time to settle
  - confidence and coverage
- **Lock point:** configurable, either a ball radius threshold or a number of seconds before the predicted drop. The prediction is frozen and timestamped at the lock.
- **UI:** a ring heatmap overlay on the wheel and a bar chart of probabilities, always with the 1/N baseline line drawn.

### Phase 5: Physics simulation adapters (DONE: see §5.10; the 2-D top-down scene was chosen over a 3-D trimesh bowl)
- Common interface: `SimulationAdapter { id; run(params: SimParams, seed: number): SimResult }`, where `SimResult` holds a θ/r timeline, the drop time and the final pocket.
- `rapierEngine.ts`: 3D bowl (track cone plus deflectors plus pocket frets as trimesh), rotating rotor body, ball sphere, gravity, restitution and friction.
- `matterEngine.ts`: 2D top-down approximation. Track slope is emulated as a radial inward force, frets and deflectors as static or kinematic bodies.
- Both run in `simulation.worker.ts`. Compare them with Model B and the synthetic generator.
- Never assume either engine matches a real wheel; fit parameters to recorded spins.

### Phase 6: History & storage (NEXT)
- Persist each spin as a `SpinRecord`, its raw `FrameMeasurement[]` (gzipped JSON, held in IndexedDB and uploaded to Supabase Storage bucket `spin-frames`) and its calibration.
- **Supabase access** goes through server route handlers that use the service-role key, which is kept server-only. RLS is already enabled.
- **Actual pocket entry:** manual entry, plus the automatic "pocket under ball when settled" with a confirmation step.
- CSV and JSON import/export.
- **Analytics:**
  - velocity and deceleration distributions
  - spin duration
  - pocket frequency with a χ² test against uniform

### Phase 7: Backtesting
- Chronological train/test split, with no shuffling.
- Replay only the frames at or before the lock timestamp.
- Fit a, b, ω_c and the scatter distribution on the training set only.
- **Metrics:**
  - exact hit rate, within ±1 pocket, within ±3 pockets
  - circular angular error
  - Brier score and log loss
  - coverage
  - reliability diagram by confidence bucket
  - performance by lead time
- Every metric is reported next to the uniform baseline, with bootstrap confidence intervals.

### Phase 8: Simulation lab & final dashboard
- Sliders for speeds, directions, friction, gravity, geometry and restitution. Runs Rapier, Matter and the kinematic model side by side. Seeded.

### Phase 9: Hardening
- Performance profiling (target: under 8 ms per frame in the worker at 640 px).
- Moving the synthetic renderer to a worker.
- Optional WebGL sampling.
- An E2E Playwright suite against `next start`.
- Documentation.

---

## 9. Decision log

| # | Decision | Why |
|---|---|---|
| D1 | Pure-TS vision instead of OpenCV.js | No 8 MB download, runs in a worker and in Node tests, and the polar-LUT approach is enough |
| D2 | Polar sampling with precomputed LUTs | Avoids trig per frame; geometry is fixed per calibration |
| D3 | Projective rectification from rim plus hub | Affine-only gave 2-pocket rotor aliasing under perspective (tests failed at 58° error) |
| D4 | Rotor lock only after the rate is established, plus a relock ratio | Prevents 19.5° per frame alias drift at low fps |
| D5 | All physics is relative to the rotor zero | Rectification has an unknown rotation; relative angles are invariant |
| D6 | Separate raw and derived streams | Requirement: preserve raw measurements; allows filter A/B comparisons |
| D7 | Rapier and Matter only as comparison adapters | A real wheel is 3D and chaotic; empirical scatter (Model C) carries the uncertainty |
| D8 | Hardcoded single user, server-side only, credentials in env | User request; still constant-time compare plus signed cookie |
| D9 | Supabase via server routes only | Keeps the service key out of the browser; RLS on |
| D10 | Fit deceleration to θ, not to Kalman α | α from differentiation is too noisy (about 15% of signal); fitting θ is about 100× more precise |
| D11 | Run MotionEstimator in the worker | Fits cost up to 30 ms; keeps the main thread free and the full state in one message |
| D12 | Settled state can revert to bouncing | Real and synthetic balls can pause then hop; the first stable pocket is not always final |
| D13 | Effective ω_c from the fitted law at the observed drop | Makes Model B self-consistent with observable drops (12 → 1.8 pockets error) |
| D14 | Uniform scatter prior with pseudo-count 8 | No history means exactly the baseline; evidence accumulates smoothly |
| D15 | Separate real and synthetic profiles | Synthetic spins must never inflate a real wheel's learned scatter |
| D16 | Live scoring is walk-forward by construction | The profile used for spin k contains only spins < k |
| D17 | History dashboard uses prequential BMA including "uniform" | Past results of a fair wheel carry no information; the model must be able to say so |
| D19 | Both engines use 2-D top-down scenes with slope forces | A 3-D bowl would need tuned trimesh geometry with no data to validate it; 2-D keeps the engines comparable and fast enough for batches |
| D20 | Smooth rim constraint shared by all adapters | Polygonal rims caused ghost bounces; the rim is not where engines should differ |
| D18 | No live ball-position or direction input for casino use | Would be a prediction device at a table, illegal under NSW/Qld casino law; also no informational value without measured speeds |

---

## 10. How to resume (checklist for a new session)

1. Unzip or clone the repo. Run `npm install`, then `cp .env.example .env.local`.
2. `npm run typecheck && npm test && npm run build`. Fix any UI/Next issues first, since they were never compiled against the real packages.
3. `npm run dev` and do the smoke test:
   - log in
   - Calibration → Synthetic wheel → Auto-fill → Save
   - Live analysis → Synthetic wheel → Start
   - check the overlay and readouts
4. Commit `package-lock.json`.
5. Start Phase 6 following §8. Keep the conventions in §3 and add tests for every new estimator, using the synthetic generator as the oracle. Never tune the predictor on the synthetic generator's own parameters and then report it as accuracy on real wheels.
