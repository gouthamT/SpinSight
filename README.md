# SpinSight: roulette wheel motion measurement (research tool)

SpinSight measures a roulette wheel from a camera or video and works out the ball and rotor angles, angular velocity and (in later phases) a probability distribution over landing pockets. **It is for your own wheel, recorded video or the built-in synthetic wheel. Using a prediction device at a casino is a criminal offence in Queensland (Casino Control Act 1982 s.103), NSW and most other places.**

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Next.js app, hardcoded server-side login, dashboard, camera/file/synthetic sources, calibration wizard | ✅ |
| 2 | Wheel rectification (affine + perspective), ball tracking, rotor tracking, worker pipeline, raw ω | ✅ |
| 3 | Kalman filter (ball and rotor), deceleration fit dω/dt = −(a+bω²), rotor fit, spin-phase detection | ✅ |
| 4 | Drop-time projection (2 models, Monte Carlo), learned scatter, pocket probabilities, lock point, walk-forward scoring vs uniform | ✅ |
| — | Results dashboard (default screen): history input, "Guess next 10" via physics Monte Carlo + model averaging vs uniform, heat grid, settings from the table guide | ✅ |
| 5 | Rapier/Matter simulation adapters | next |
| 6–9 | Supabase history, backtesting, sim lab, hardening | planned |

## Run locally

```bash
npm install
cp .env.example .env.local   # set AUTH_USERNAME / AUTH_PASSWORD / AUTH_SECRET
npm run dev                  # http://localhost:3000  (camera works on localhost or https only)
npm test                     # unit + end-to-end synthetic tracking tests
npm run typecheck
```

Default dev login if env vars are unset: `admin` / `spinsight`.

## Deploy for free

1. **GitHub**: push this folder to a new repo.
2. **Vercel (Hobby, free)**: go to *Add New → Project*, import the repo (framework auto-detected), and add the environment variables `AUTH_USERNAME`, `AUTH_PASSWORD` and `AUTH_SECRET` (a 64-char random hex string), then deploy. You get HTTPS automatically, which the camera needs.
3. **Supabase (free tier, used from Phase 6)**: create a project, then go to *SQL editor* and run `supabase/migrations/0001_init.sql`. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to Vercel.

Cloudflare Pages (via `@cloudflare/next-on-pages`) also works as a free alternative.

## Using it

1. **Calibration**:
   - Choose a source and capture a still.
   - Pick the wheel type.
   - Click the hub using the loupe; this is what drives perspective correction.
   - Click 8–12 points around the outer edge of the ball track.
   - Adjust the rings to fit.
   - Auto-detect the zero pocket and the number direction, check the labels line up, then save.
2. **Live analysis**: use the same source and camera position, then press *Start tracking*. Overlays show the fitted rim, the pocket labels following the rotor, the ball marker and its trail. The side panel lists measured values, effective FPS and frame gaps. *Export raw JSON* keeps the full per-frame record.
3. **Synthetic wheel**: a deterministic, software-rendered wheel with known ground truth. Calibration has an *Auto-fill from synthetic ground truth* button.

## How it works

```
frame ─► createImageBitmap ─► tracking.worker (OffscreenCanvas → RGBA)
          │                    ├─ PolarGrid(stationary bowl)  → background subtraction → ball on track/cone
          │                    ├─ PolarGrid(pocket ring)      → colour template xcorr  → rotor zero angle
          │                    └─ residual vs rotated template                         → ball on rotor
          └─ timestamps: rVFC mediaTime (files) / captureTime or performance.now (camera)
main thread: RawKinematics (unwrap with predicted step, windowed LSQ ω), TimingStats, overlay
```

- **Rectification**: least-squares conic fit to the rim. If a hub is clicked, the hub's polar line with respect to the rim conic is the image of the line at infinity. Mapping that line back to infinity removes perspective; an ellipse-to-circle affine map then finishes the rectification (`src/engine/geometry/ellipse.ts`).
- **Rotor**: circular cross-correlation of luma, redness and greenness profiles against the calibration template. The green zero breaks the 2-pocket red/black periodicity. Once the rotor rate is established, the search is confined to ±0.9 pocket around the predicted position. A clearly better global peak forces re-acquisition. This stays alias-safe even when the rotor moves more than one pocket per frame.
- **Ball**: the stationary track uses a per-cell exponential background with the ball excluded from updates. On the rotor, the ball is the positive residual against the rotated template. Phases are `track`, `cone`, `pocket-ring` and `lost`.
- **Timing**: monotonic clocks only. The worker never queues frames (one in flight at a time; extras are counted as dropped), so latency stays bounded.

## Verified accuracy (synthetic ground truth)

These figures come from the automated tests and the error shown is ball angle relative to the rotor:

| Scenario | Rotor err p95 | Ball err median / p95 | Detection |
|---|---|---|---|
| Overhead-ish, 60 fps | < 1° | 0.14° / 0.3° (track) | 99.7% |
| Strong perspective + oblique, 30 fps | < 1° | 0.2° / 0.35° (track) | 97.7% |
| 10 fps (rotor > 1 pocket/frame) | < 1° | passes < 2° p95 | > 95% |

Real cameras add motion blur, glare, compression and a cone-shaped (non-planar) wheel, so expect worse numbers. That is why later phases calibrate everything from recorded spins.

## Layout

```
src/app/(app)/{dashboard,live-analysis,calibration,history,simulation,limitations}
src/app/api/auth/{login,logout}     server-only credential check, signed JWT cookie
src/middleware.ts                   route protection
src/engine/geometry                 angles, ellipse/projective rectification
src/engine/vision                   polarSampler, ballTracker, rotorTracker, pocketDetector, wheelDetector, frameProcessor
src/engine/tracking                 raw kinematics, Kalman filter, deceleration fits, spin phases, MotionEstimator
src/engine/physics                  deceleration model closed form (Phase 4 adds prediction models)
src/engine/synthetic                deterministic spin generator + renderer
src/engine/wheel                    pocket orders, colours, angle↔pocket
src/workers/tracking.worker.ts
supabase/migrations/0001_init.sql
tests/                              vitest suites
```
