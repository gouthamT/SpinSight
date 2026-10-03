export default function SimulationPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Simulation lab</h1>
      <div className="panel p-6 text-sm text-ink-300">
        Arrives in Phase 5 & 8: side-by-side kinematic model, Rapier.js (3D rigid body) and Matter.js (2D) runs with adjustable speeds,
        friction, geometry and deflector parameters, all seeded for reproducibility. The synthetic wheel used for testing today already
        lives in <code className="num">src/engine/synthetic</code>.
      </div>
    </div>
  );
}
