"use client";
import { get, set, del } from "idb-keyval";
import type { WheelCalibration } from "@/types/roulette";

const KEY = "spinsight:calibration:active";

export async function loadCalibration(): Promise<WheelCalibration | null> {
  try {
    return ((await get(KEY)) as WheelCalibration | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveCalibration(cal: WheelCalibration): Promise<void> {
  await set(KEY, cal);
}

export async function clearCalibration(): Promise<void> {
  await del(KEY);
}
