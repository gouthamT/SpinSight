import { SimulationLab } from "@/components/PhysicsVisualization/SimulationLab";

export default function SimulationPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Simulation lab</h1>
      <SimulationLab />
    </div>
  );
}
