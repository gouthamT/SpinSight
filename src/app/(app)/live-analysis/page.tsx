import { LiveAnalysis } from "@/components/CameraFeed/LiveAnalysis";

export default function LiveAnalysisPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Live analysis</h1>
      <LiveAnalysis />
    </div>
  );
}
