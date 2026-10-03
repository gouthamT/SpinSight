export default function HistoryPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Spin history</h1>
      <div className="panel p-6 text-sm text-ink-300">
        Arrives in Phase 6: every tracked spin is stored locally (IndexedDB) and synced to Supabase, with CSV/JSON import/export and
        distributions of ball/rotor speed, deceleration, spin duration and landing pockets compared against a uniform baseline.
        For now, use <b>Export raw JSON</b> on the Live analysis page to keep session data.
      </div>
    </div>
  );
}
