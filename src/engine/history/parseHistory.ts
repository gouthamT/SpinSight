import type { WheelType } from "@/types/roulette";
import type { ParsedHistory, ParsedToken } from "@/types/history";
import { DOUBLE_ZERO, TRIPLE_ZERO, pocketLabel } from "@/engine/wheel/layout";

const ALLOWED: Record<WheelType, string> = {
  european: "0–36",
  american: "0–36 and 00",
  "triple-zero": "0–36, 00 and 000",
};

/** Parse a whitespace/comma separated list of results (oldest → newest) and validate it. */
export function parseHistory(text: string, wheelType: WheelType): ParsedHistory {
  const tokens: ParsedToken[] = [];
  const re = /[^\s,;]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    let value: number | null = null;
    let error: string | null = null;
    if (raw === "00") {
      if (wheelType === "european") error = `"00" does not exist on a European wheel (allowed: ${ALLOWED[wheelType]}).`;
      else value = DOUBLE_ZERO;
    } else if (raw === "000") {
      if (wheelType !== "triple-zero") error = `"000" only exists on a triple-zero wheel (allowed: ${ALLOWED[wheelType]}).`;
      else value = TRIPLE_ZERO;
    } else if (/^\d+$/.test(raw)) {
      if (raw.length > 1 && raw.startsWith("0")) error = `"${raw}": write numbers without a leading zero (e.g. ${Number(raw)}).`;
      else {
        const n = Number(raw);
        if (n > 36) error = `"${raw}" is not a pocket (allowed: ${ALLOWED[wheelType]}).`;
        else value = n;
      }
    } else {
      error = `"${raw}" is not a number (allowed: ${ALLOWED[wheelType]}).`;
    }
    tokens.push({ raw, value, error, start, end });
  }
  return {
    tokens,
    values: tokens.filter((t) => t.value !== null).map((t) => t.value!),
    errors: tokens.filter((t) => t.error !== null),
  };
}

export function formatHistory(values: readonly number[]): string {
  return values.map(pocketLabel).join(" ");
}
