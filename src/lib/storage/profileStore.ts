import { del, get, set } from "idb-keyval";
import type { WheelProfile } from "@/types/roulette";

/**
 * Learned wheel profiles (ω_c + scatter observations), one per calibration and
 * per data source (real vs synthetic, never mixed). Works in the main thread
 * and in workers (IndexedDB is available in both).
 */
const prefix = "spinsight:profile:";

export function profileKey(calibrationId: string, synthetic: boolean): string {
  return `${calibrationId}:${synthetic ? "synthetic" : "real"}`;
}

export async function loadProfile(key: string): Promise<WheelProfile | null> {
  try {
    return ((await get(prefix + key)) as WheelProfile | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveProfile(p: WheelProfile): Promise<void> {
  try {
    await set(prefix + p.key, p);
  } catch {
    /* storage unavailable (private mode): keep in memory only */
  }
}

export async function deleteProfile(key: string): Promise<void> {
  try {
    await del(prefix + key);
  } catch {
    /* ignore */
  }
}
