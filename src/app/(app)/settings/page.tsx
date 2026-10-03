import { SettingsPanel } from "@/components/ResultsDashboard/SettingsPanel";

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="mx-auto max-w-3xl text-xl font-semibold">Settings</h1>
      <SettingsPanel />
    </div>
  );
}
