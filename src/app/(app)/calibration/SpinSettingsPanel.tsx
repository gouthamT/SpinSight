'use client';

import React, { useState } from 'react';
import { SpinStartData, SpinDirectionData, SpinDetectionSettings } from '@/engine/vision/spinDetector';

interface SpinSettingsPanelProps {
  onSpinStartChange?: (data: SpinStartData) => void;
  onDirectionChange?: (data: SpinDirectionData) => void;
  onSettingsChange?: (settings: SpinDetectionSettings) => void;
  initialSettings?: Partial<SpinDetectionSettings>;
}

export const SpinSettingsPanel: React.FC<SpinSettingsPanelProps> = ({
  onSpinStartChange,
  onDirectionChange,
  onSettingsChange,
  initialSettings = {},
}) => {
  const [spinReference, setSpinReference] = useState<string>('');
  const [referenceAngle, setReferenceAngle] = useState<number>(0);
  const [ballDirection, setBallDirection] = useState<'clockwise' | 'counterclockwise'>('clockwise');
  const [rotorDirection, setRotorDirection] = useState<'clockwise' | 'counterclockwise'>('clockwise');
  const [autoDetectStart, setAutoDetectStart] = useState(
    initialSettings.autoDetectStart ?? true
  );
  const [autoDetectDirection, setAutoDetectDirection] = useState(
    initialSettings.autoDetectDirection ?? true
  );
  const [allowManualOverride, setAllowManualOverride] = useState(
    initialSettings.allowManualOverride ?? true
  );

  const handleSpinStartSubmit = () => {
    const data: SpinStartData = {
      referenceAngle,
      reference: spinReference || `${referenceAngle.toFixed(1)}°`,
      startTime: Date.now(),
      confidence: 0.9,
    };
    onSpinStartChange?.(data);
  };

  const handleDirectionSubmit = () => {
    const data: SpinDirectionData = {
      ballDirection,
      rotorDirection,
      source: 'manual',
      confidence: 0.95,
    };
    onDirectionChange?.(data);
  };

  const handleSettingsChange = () => {
    const settings: SpinDetectionSettings = {
      autoDetectStart,
      autoDetectDirection,
      allowManualOverride,
      confidenceThreshold: 0.8,
    };
    onSettingsChange?.(settings);
  };

  return (
    <div className="space-y-6 rounded-lg border border-gray-300 p-4 bg-white shadow-sm">
      <h2 className="text-lg font-semibold text-gray-800">Spin Detection Settings</h2>

      {/* Spin Start Reference */}
      <div className="space-y-3">
        <h3 className="font-medium text-gray-700">Spin Start Reference</h3>
        <p className="text-sm text-gray-600">
          Enter where the ball starts spinning (angle or descriptive label)
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={spinReference}
            onChange={(e) => setSpinReference(e.target.value)}
            placeholder="e.g., '17 red' or 'top of wheel'"
            className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
          />
          <input
            type="number"
            value={referenceAngle}
            onChange={(e) => setReferenceAngle(Number(e.target.value) % 360)}
            min="0"
            max="359"
            placeholder="0-359°"
            className="w-24 px-3 py-2 border border-gray-300 rounded text-sm"
          />
        </div>
        <button
          onClick={handleSpinStartSubmit}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition"
        >
          Save Spin Start
        </button>
      </div>

      {/* Rotation Direction */}
      <div className="space-y-3">
        <h3 className="font-medium text-gray-700">Rotation Direction</h3>
        <p className="text-sm text-gray-600">
          Specify which direction the ball and rotor are spinning
        </p>
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <span className="text-sm text-gray-700">Ball direction:</span>
            <select
              value={ballDirection}
              onChange={(e) => setBallDirection(e.target.value as typeof ballDirection)}
              className="px-2 py-1 border border-gray-300 rounded text-sm"
            >
              <option value="clockwise">Clockwise</option>
              <option value="counterclockwise">Counter-clockwise</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-sm text-gray-700">Rotor direction:</span>
            <select
              value={rotorDirection}
              onChange={(e) => setRotorDirection(e.target.value as typeof rotorDirection)}
              className="px-2 py-1 border border-gray-300 rounded text-sm"
            >
              <option value="clockwise">Clockwise</option>
              <option value="counterclockwise">Counter-clockwise</option>
            </select>
          </label>
        </div>
        <button
          onClick={handleDirectionSubmit}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition"
        >
          Save Direction
        </button>
      </div>

      {/* Auto-Detection Settings */}
      <div className="space-y-3 border-t border-gray-200 pt-4">
        <h3 className="font-medium text-gray-700">Auto-Detection</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoDetectStart}
            onChange={(e) => setAutoDetectStart(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-gray-700">Auto-detect spin start</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoDetectDirection}
            onChange={(e) => setAutoDetectDirection(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-gray-700">Auto-detect rotation direction</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allowManualOverride}
            onChange={(e) => setAllowManualOverride(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-gray-700">Allow manual override</span>
        </label>
        <button
          onClick={handleSettingsChange}
          className="px-4 py-2 bg-gray-600 text-white text-sm font-medium rounded hover:bg-gray-700 transition"
        >
          Save Settings
        </button>
      </div>
    </div>
  );
};
