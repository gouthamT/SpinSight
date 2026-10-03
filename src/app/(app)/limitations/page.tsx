export default function LimitationsPage() {
  const items: [string, string][] = [
    ["Legal use only", "Using a device to predict outcomes at a casino table is an offence in Queensland, NSW and most other jurisdictions. This is a research and education tool for your own wheel, recorded video, or the synthetic wheel."],
    ["Measurements vs predictions", "Everything shown today is a measurement (angles, raw angular velocity, pocket currently under the ball). Predictions start in Phase 4 and are labelled as such."],
    ["The bounce is chaotic", "After the ball leaves the track it hits deflectors and frets. That scatter is the dominant source of uncertainty and is modelled statistically from your own spins, never assumed away."],
    ["Camera geometry", "Rectification assumes a flat wheel. Real wheels are shallow cones, so the ball track and pocket ring sit at different heights; an overhead camera keeps the resulting error small. Perspective is corrected using the clicked hub."],
    ["Frame rate", "At 30 fps an early-spin ball moves ~30–40° per frame. 60 fps or more is strongly recommended. The app shows the true effective FPS and frame gaps."],
    ["Lighting & motion blur", "Specular highlights on the track can look like the ball; strong motion blur lowers detection SNR. Diffuse, steady light works best."],
    ["No guaranteed edge", "Physics-based prediction on a well-maintained wheel may not beat the uniform 1/37 baseline at all. Backtesting (Phase 7) will report this honestly, including when the model is worse than chance."],
  ];
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Model limitations</h1>
      {items.map(([t, d]) => (
        <div key={t} className="panel p-4">
          <div className="font-medium">{t}</div>
          <p className="mt-1 text-sm text-ink-300">{d}</p>
        </div>
      ))}
    </div>
  );
}
