# Spin Detection & Direction Calibration Feature

## Overview

This PR adds manual and automatic spin start detection along with wheel rotation direction calibration to improve tracking accuracy and enable data-driven prediction tuning.

## Changes

### 1. **Spin Detection Module** (`src/engine/vision/spinDetector.ts`)
- `SpinStartData`: Captures where the spin begins (angle, timestamp, confidence)
- `SpinDirectionData`: Records whether ball/rotor spin clockwise or counter-clockwise
- `detectSpinStart()`: Identifies motion onset from velocity history
- `detectSpinDirection()`: Infers spin direction from angular velocity trends

### 2. **Enhanced Prediction Engine** (`src/engine/physics/predictionWithSpinData.ts`)
- `SpinMetadata`: Bundles spin start and direction for prediction context
- `predictWithSpinMetadata()`: Monte Carlo simulation that uses direction hints and learned scatter
- `tuneFromHistoricalData()`: Walk-forward refinement—uses only past spins (no data leakage)
- `HistoricalTuning`: Stores deceleration model and scatter learned from successful outcomes

### 3. **Calibration UI** (`src/app/(app)/calibration/SpinSettingsPanel.tsx`)
- Text input for spin-start reference (e.g., "17 red" or descriptive label)
- Numeric angle input (0–359°)
- Dropdown selectors for ball and rotor direction
- Checkboxes to enable/disable auto-detection and manual override
- Save buttons for each setting

## Usage

### During Calibration:
1. Load a wheel video or synthetic source.
2. Perform calibration (hub click, track points, adjust rings).
3. In the new **Spin Detection Settings** panel:
   - Enter a spin-start reference (e.g., pocket number, clock position)
   - Select the ball and rotor rotation direction
   - Toggle auto-detection on/off
4. Click **Save** to store these settings with the calibration.

### During Live Analysis:
1. Tracking begins with the saved spin metadata.
2. If auto-detection is enabled, the system infers missing fields.
3. Manual overrides (if enabled) let the user correct detection during a live spin.
4. The prediction engine uses spin metadata to initialize Monte Carlo simulations more accurately.

### Historical Tuning (Backend):
1. After each spin, record actual landing and model accuracy.
2. For the next spin, use only prior spins in a chronological window (e.g., last 50).
3. Estimate deceleration and scatter parameters from that window.
4. Pass tuned parameters to the prediction engine.
5. **No data leakage**: future data is never used to tune past predictions.

## Implementation Details

### Spin Start Detection
- Monitors ball angular velocity over consecutive frames.
- Marks the start when velocity exceeds a threshold (~5°/frame).
- Confidence is boosted if velocity is smooth and sustained.

### Direction Detection
- Averages angular velocity over a window of frames.
- Positive velocity → clockwise; negative → counter-clockwise.
- Confidence increases if direction is consistent over multiple samples.

### Historical Tuning
- **Window size**: configurable (default 50 past spins).
- **Walk-forward validation**: only past spins inform the current prediction.
- **Learned parameters**: deceleration (a, b) and scatter tuned from historical accuracy.
- **No overfitting**: parameters are fit on a held-out historical window, not on the current spin.

## Integration Points

1. **Calibration workflow** → Save `SpinDetectionSettings` alongside wheel geometry.
2. **Live tracking** → Pass `SpinMetadata` to the motion estimator and prediction engine.
3. **Results storage** → Record actual pocket and model confidence for later tuning.
4. **Prediction pipeline** → Call `predictWithSpinMetadata()` instead of the basic prediction.
5. **Settings refinement** → Periodically call `tuneFromHistoricalData()` to update parameters.

## Testing

- Unit tests: `tests/spinDetector.test.ts` (detection accuracy on synthetic wheels)
- Unit tests: `tests/predictionWithSpinData.test.ts` (tuning logic, no data leakage)
- End-to-end: synthetic wheel with known spin start and direction
- Walk-forward validation: check that tuning only uses past data

## Ethics & Safety

✅ **Intended use**: private wheel research, education, and synthetic wheel analysis.  
❌ **Not intended for**: live casino prediction or illegal side-betting.  
⚠️ **Safeguards**:
- UI clearly labels predictions as "simulation" or "estimate".
- No live real-time output to external devices or networks.
- Documentation warns against casino use.
- Historical tuning is transparent and auditable.

## Future Work

- [ ] Extend UI to show detected vs. manual values side-by-side.
- [ ] Add confidence bars for auto-detected fields.
- [ ] Export tuning parameters and historical accuracy for offline analysis.
- [ ] Support multiple camera angles by averaging spin metadata.
- [ ] Integrate Rapier/Matter simulation adapters (Phase 5) with spin data.

## Acceptance Criteria

- [x] Users can manually enter spin-start reference and direction.
- [x] Auto-detection works on synthetic wheels.
- [x] Direction inference is consistent and correct.
- [x] Prediction engine consumes spin metadata reproducibly.
- [x] Historical tuning respects chronological order (no data leakage).
- [x] Default baseline model is shown alongside tuned output.
- [x] All predictions are labeled (measurement, simulation, or estimate).
- [x] Unit and e2e tests pass.
- [x] Documentation clarifies ethical use only.
