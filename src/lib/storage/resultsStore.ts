"use client";
import type { WheelType } from "@/types/roulette";
import type { HistoryPrediction, HistorySettings, PhysicsSettings, PredictionLogEntry } from "@/types/history";
import { DEFAULT_PHYSICS } from "@/engine/history/physicsRelease";
import guide from "@/config/roulette-defaults.json";

/** localStorage persistence for the results dashboard (per browser). Every access is guarded. */
const K = {
  text: "spinsight:results:text",
  wheel: "spinsight:results:wheelType",
  settings: "spinsight:results:settings",
  last: "spinsight:results:lastPrediction",
  log: "spinsight:results:log",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}

/**
 * Defaults come from src/config/roulette-defaults.json (taken from the table
 * guide). Edit that file to change the defaults for everyone; a user's own
 * changes in Settings are stored in their browser and override it until they
 * press "Reset to guide defaults".
 */
export const GUIDE_FACTS = {
  source: guide.source,
  wheels: guide.wheels,
  ballOppositeToWheel: guide.ballOppositeToWheel,
} as const;

export const DEFAULT_SETTINGS: HistorySettings = {
  wheelType: guide.defaultWheel as WheelType,
  simulations: guide.simulations,
  physics: { ...DEFAULT_PHYSICS, ballDirection: guide.ballDirection as PhysicsSettings["ballDirection"] },
};

export const resultsStore = {
  loadText: () => read<string>(K.text, ""),
  saveText: (t: string) => write(K.text, t),
  loadWheel: () => read<WheelType>(K.wheel, DEFAULT_SETTINGS.wheelType),
  saveWheel: (w: WheelType) => write(K.wheel, w),
  loadSettings: (): HistorySettings => {
    const s = read<Partial<HistorySettings>>(K.settings, {});
    return { ...DEFAULT_SETTINGS, ...s, physics: { ...DEFAULT_PHYSICS, ...(s.physics ?? {}) } };
  },
  saveSettings: (s: HistorySettings) => write(K.settings, s),
  loadLast: () => read<HistoryPrediction | null>(K.last, null),
  saveLast: (p: HistoryPrediction | null) => write(K.last, p),
  loadLog: () => read<PredictionLogEntry[]>(K.log, []),
  saveLog: (l: PredictionLogEntry[]) => write(K.log, l.slice(-500)),
  resetSettings: (): HistorySettings => {
    write(K.settings, DEFAULT_SETTINGS);
    write(K.wheel, DEFAULT_SETTINGS.wheelType);
    return DEFAULT_SETTINGS;
  },
  clearAll: () => {
    for (const k of [K.text, K.last, K.log]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  },
};
