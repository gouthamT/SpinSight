"use client";
import { useRef } from "react";
import type { ParsedHistory } from "@/types/history";

/**
 * Textarea with a mirrored backdrop that highlights invalid tokens in place.
 * The backdrop and the textarea share font, padding and wrapping so marks line
 * up with the typed text.
 */
export function HistoryInput({
  text,
  parsed,
  onChange,
}: {
  text: string;
  parsed: ParsedHistory;
  onChange: (t: string) => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const shared = "num w-full whitespace-pre-wrap break-words px-3 py-2.5 text-base leading-7 sm:px-4 sm:py-3";

  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  parsed.errors.forEach((t, i) => {
    if (t.start > cursor) pieces.push(text.slice(cursor, t.start));
    pieces.push(
      <mark key={i} className="rounded bg-bad/35 text-transparent">
        {text.slice(t.start, t.end)}
      </mark>,
    );
    cursor = t.end;
  });
  pieces.push(text.slice(cursor) + "\n");

  return (
    <div className="space-y-2">
      <div className="relative rounded-xl border border-ink-600 bg-ink-850 focus-within:border-accent">
        <div ref={backdrop} aria-hidden className={`${shared} pointer-events-none absolute inset-0 overflow-hidden text-transparent`}>
          {pieces}
        </div>
        <textarea
          id="history"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={4}
          placeholder="e.g. 17 4 22 0 31 9 14 28 6 35 12 19"
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
          }}
          className={`${shared} relative block min-h-28 sm:min-h-36 resize-y bg-transparent text-ink-100 caret-accent outline-none`}
        />
      </div>
      {parsed.errors.length > 0 && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          <div className="font-medium">
            {parsed.errors.length} invalid {parsed.errors.length === 1 ? "entry" : "entries"} (highlighted). Fix them to save.
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {parsed.errors.slice(0, 6).map((e, i) => (
              <li key={i}>{e.error}</li>
            ))}
            {parsed.errors.length > 6 && <li>…and {parsed.errors.length - 6} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
