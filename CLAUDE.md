# CLAUDE.md: working rules for SpinSight

Read `docs/DESIGN.md` first; it has the full design, status and roadmap. This file holds the short rules.

## What this is
A Next.js 15 + TypeScript app that measures a roulette wheel (ball and rotor angles and speeds) from a camera or video. From Phase 4 it estimates landing-pocket probabilities and backtests them against the uniform baseline. **Phases 1–4 are done (vision tracking, Kalman filter, deceleration fit, spin phases, drop projection plus learned scatter giving pocket probabilities with walk-forward scoring). Phase 5 (Rapier/Matter adapters + Simulation lab) is done; Phase 6 (spin history, stored locally only, with no Supabase) is next. The default post-login screen is the results dashboard (`/dashboard`); the old overview is at `/overview`; settings (guide defaults) are at `/settings`.**

## Hard rules
- It is a research and education tool for a privately owned wheel, recorded video, or the synthetic wheel. Do not build features for covert or in-casino use. Using a prediction device at a casino is illegal (e.g. Qld Casino Control Act s.103).
- No live ball-position or spin-direction entry for use at a casino table (declined by design, see DESIGN.md D18).
- Never present illegitimate certainty. Always show the 1/37 (or 1/38) baseline next to model output, and label measurement, simulation and prediction separately.
- **Angles:** radians. θ increases counter-clockwise on screen. The rim (outer edge of the ball track) is r = 1.
- **Physics** works on ball-relative-to-rotor-zero angles only, because the absolute rectified angle has an arbitrary offset.
- **Time:** monotonic ms only (`performance.now`, video `mediaTime`, `captureTime`). Never use `Date.now()` for motion.
- **Raw `FrameMeasurement`s are immutable.** Filtered and derived data goes in separate structures.
- **Randomness:** seeded only (`mulberry32`). Simulations and backtests must be reproducible.
- **Backtests:** chronological splits. Never tune and evaluate on the same spins, and never use frames after the lock point.
- **Structure:** the engine (`src/engine/**`) stays pure TypeScript with no DOM or React, so it runs in workers and in Node tests. Heavy work goes in `src/workers/*`.
- **TypeScript:** strict mode with `noUncheckedIndexedAccess`.

## Commands
```bash
npm install
npm run dev          # http://localhost:3000, login admin/spinsight unless env set
npm test             # vitest: unit + end-to-end synthetic tracking
npm run typecheck
npm run build
```

## Testing approach
Use `src/engine/synthetic/syntheticWheel.ts` as the ground-truth oracle: render frames, run `WheelTracker`, and compare against `SyntheticSpin.state(t)`. Every new estimator needs a synthetic test with explicit error bounds. Existing bounds:
- rotor p95 < 1°
- ball-relative-to-rotor p95 < 2°
- track detection > 95%
- these hold at 60, 30 and 10 fps and under perspective
- Kalman ball ω < 0.8% RMS
- deceleration a and b within 10% (clean measurements) and 15% (rendered frames)
- settled pocket correct
- prediction: uniform with no history; drop projection < 3 pockets mean error 2 s ahead; walk-forward log loss below ln 37 on the synthetic wheel

## Known gaps (fix early)
- The React and Next layer has never been built against the real packages; run `npm run build` and fix it first.
- The synthetic renderer runs on the main thread. Spin-phase thresholds are tuned on synthetic data only.
- There is no `package-lock.json` committed yet.

## Where things are
- `src/types/roulette.ts`: all shared types
- `src/engine/{geometry,vision,tracking,synthetic,wheel}`: core logic
- `src/workers/tracking.worker.ts`, `src/hooks/useTracking.ts`: the frame pipeline (the worker runs vision plus `MotionEstimator`)
- `src/engine/tracking/{kalmanFilter,accelerationEstimator,spinPhase,motionEstimator}.ts`, `src/engine/physics/decelerationModel.ts`: Phase 3
- `src/engine/prediction/*`, `src/components/PredictionPanel/PredictionPanel.tsx`: Phase 4
- `src/engine/physics/{rouletteScene,trajectoryModel,rapierEngine,matterEngine,simulationAdapter}.ts`, `src/workers/simulation.worker.ts`, `src/components/PhysicsVisualization/*`: Phase 5
- `src/engine/history/*`, `src/workers/historySim.worker.ts`, `src/components/ResultsDashboard/*`, `src/lib/storage/resultsStore.ts`: results dashboard and settings
- `src/components/WheelCalibration/CalibrationWizard.tsx`, `src/components/CameraFeed/LiveAnalysis.tsx`: the main UI
- `supabase/migrations/0001_init.sql`: unused (decision D21: history stays local)
