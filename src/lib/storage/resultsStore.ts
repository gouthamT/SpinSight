"use client";
import guide from "@/config/roulette-defaults.json";
import { DEFAULT_PHYSICS } from "@/engine/history/physicsRelease";
import type {
  EngineKernel,
  EngineView,
  HistoryPrediction,
  HistorySettings,
  PhysicsSettings,
  PredictionLogEntry,
} from "@/types/history";
import type { WheelType } from "@/types/roulette";

/** localStorage persistence for the results dashboard (per browser). Every access is guarded. */
const K = {
  text: "spinsight:results:text",
  wheel: "spinsight:results:wheelType",
  settings: "spinsight:results:settings",
  last: "spinsight:results:lastPrediction",
  log: "spinsight:results:log",
  engines: "spinsight:results:engineViews",
  kernels: "spinsight:results:engineKernels",
  order: "spinsight:results:rowOrder",
  showStats: "spinsight:results:showStatsRows",
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
  startingPointIndex: null,
  wheelDirection: guide.ballDirection === "clockwise" ? 1 : -1,
  physics: {
    ...DEFAULT_PHYSICS,
    ballDirection: guide.ballDirection as PhysicsSettings["ballDirection"],
  },
  engineRuns: { kinematic: 400, rapier: 60, matter: 120 },
  autoCalibrate: true,
};

export const resultsStore = {
  loadText: () => read<string>(K.text, ""),
  saveText: (t: string) => write(K.text, t),
  loadWheel: () => read<WheelType>(K.wheel, DEFAULT_SETTINGS.wheelType),
  saveWheel: (w: WheelType) => write(K.wheel, w),
  loadSettings: (): HistorySettings => {
    const s = read<Partial<HistorySettings>>(K.settings, {});
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      startingPointIndex:
        s.startingPointIndex ?? DEFAULT_SETTINGS.startingPointIndex,
      wheelDirection: s.wheelDirection ?? DEFAULT_SETTINGS.wheelDirection,
      physics: { ...DEFAULT_SETTINGS.physics, ...(s.physics ?? {}) },
      engineRuns: { ...DEFAULT_SETTINGS.engineRuns, ...(s.engineRuns ?? {}) },
    };
  },
  saveSettings: (s: HistorySettings) => write(K.settings, s),
  loadLast: () => read<HistoryPrediction | null>(K.last, null),
  saveLast: (p: HistoryPrediction | null) => write(K.last, p),
  loadEngines: () => read<EngineView[]>(K.engines, []),
  saveEngines: (v: EngineView[]) => write(K.engines, v),
  /** Engine kernels keyed by kernelKey(); small (N numbers each). */
  loadKernels: () => read<Record<string, EngineKernel>>(K.kernels, {}),
  saveKernel: (k: EngineKernel) => {
    const all = read<Record<string, EngineKernel>>(K.kernels, {});
    all[k.key] = k;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - 12)))
      delete all[old]; // keep the latest 12
    write(K.kernels, all);
  },
  loadRowOrder: () => read<string[]>(K.order, []),
  saveRowOrder: (o: string[]) => write(K.order, o),
  loadShowStats: () => read<boolean>(K.showStats, false),
  saveShowStats: (v: boolean) => write(K.showStats, v),
  loadLog: () => read<PredictionLogEntry[]>(K.log, []),
  saveLog: (l: PredictionLogEntry[]) => write(K.log, l.slice(-500)),
  resetSettings: (): HistorySettings => {
    write(K.settings, DEFAULT_SETTINGS);
    write(K.wheel, DEFAULT_SETTINGS.wheelType);
    return DEFAULT_SETTINGS;
  },
  clearAll: () => {
    for (const k of [K.text, K.last, K.log, K.engines]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  },
};
