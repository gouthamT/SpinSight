import { CalibrationWizard } from "@/components/WheelCalibration/CalibrationWizard";

export default function CalibrationPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Wheel calibration</h1>
        <p className="text-sm text-ink-400">Maps the camera image to a top-down wheel coordinate system. Redo it whenever the camera moves.</p>
      </div>
      <CalibrationWizard />
    </div>
  );
}
